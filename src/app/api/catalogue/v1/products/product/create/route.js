// app/api/catalogue/v1/products/product/create/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, doc, getDoc, setDoc, serverTimestamp, where
} from "firebase/firestore";
import { nextPosition } from "@/app/api/_utils/position";

/* ---------------- response helpers ---------------- */
const ok  = (p = {}, s = 201) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e = {}) => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

/* ---------------- type sanitizers ---------------- */
const is8   = (s) => /^\d{8}$/.test(String(s ?? "").trim());
const toStr = (v, f = "") => (v == null ? f : String(v)).trim();
const toBool= (v, f = false) =>
  typeof v === "boolean" ? v
  : typeof v === "number" ? v !== 0
  : typeof v === "string" ? ["true","1","yes","y"].includes(v.toLowerCase())
  : f;
const toInt = (v, f = 0) => Number.isFinite(+v) ? Math.trunc(+v) : f;

/* ---------------- field sanitizers ---------------- */
function parseKeywords(value){
  const raw = Array.isArray(value) ? value.join(",") : (value ?? "");
  return String(raw)
    .split(",")
    .map(s => s.replace(/\s+/g," ").trim())
    .filter(Boolean)
    .map(s => s.toLowerCase())
    .filter((v,i,a)=>a.indexOf(v)===i)
    .slice(0, 100);
}

function sanitizeUrl(u){
  if (u == null) return null;
  const s = String(u).trim();
  if (!s) return null;
  if (/^(https?:\/\/|data:)/i.test(s)) return s;
  return null;
}

function sanitizeBlurHash(v){
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function parseImage(input, fallbackPos = null){
  if (!input) return { imageUrl: null, blurHashUrl: null, ...(fallbackPos ? { position: fallbackPos } : {}) };
  if (typeof input === "string") {
    return { imageUrl: sanitizeUrl(input), blurHashUrl: null, ...(fallbackPos ? { position: fallbackPos } : {}) };
  }
  if (typeof input === "object"){
    const imageUrl    = sanitizeUrl(input.imageUrl ?? input.url);
    const blurHashUrl = sanitizeBlurHash(input.blurHashUrl ?? input.blurhash ?? input.blurHash);
    const pos = Number.isFinite(+input?.position) ? toInt(input.position, undefined) : undefined;
    const base = { imageUrl, blurHashUrl };
    return pos != null ? { ...base, position: pos } : (fallbackPos ? { ...base, position: fallbackPos } : base);
  }
  return { imageUrl: null, blurHashUrl: null, ...(fallbackPos ? { position: fallbackPos } : {}) };
}

function parseImages(value){
  let arr = [];
  if (Array.isArray(value)) {
    arr = value.map((v, i) => parseImage(v, i + 1)).filter(o => o.imageUrl || o.blurHashUrl);
  } else if (value) {
    const one = parseImage(value, 1);
    if (one.imageUrl || one.blurHashUrl) arr = [one];
  }
  if (arr.length) {
    arr = arr
      .map((it, i) => ({ ...it, position: Number.isFinite(+it.position) ? toInt(it.position, i + 1) : (i + 1) }))
      .sort((a,b) => a.position - b.position)
      .map((it, i) => ({ ...it, position: i + 1 }));
  }
  return arr;
}

function normalizeTimestamps(obj){
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  const ts = out?.timestamps;
  if (ts && typeof ts === "object") {
    const toIso = (v)=>(v && typeof v?.toDate==="function") ? v.toDate().toISOString() : v;
    out.timestamps = {
      createdAt: toIso(ts.createdAt),
      updatedAt: toIso(ts.updatedAt),
    };
  }
  return out;
}

/* ---------------- route ---------------- */
export async function POST(req){
  try{
    const { data } = await req.json();
    if (!data || typeof data !== "object") {
      return err(400,"Invalid Data","Provide a 'data' object.");
    }

    const uniqueId = toStr(data?.product?.unique_id);
    if (!is8(uniqueId)) {
      return err(400,"Invalid Unique Id","'product.unique_id' must be an 8-digit string.");
    }

    const category    = toStr(data?.grouping?.category);
    const subCategory = toStr(data?.grouping?.subCategory);
    const brand       = toStr(data?.grouping?.brand);
    if (!category || !subCategory || !brand) {
      return err(400,"Missing Grouping","category, subCategory and brand are required.");
    }

    const ref = doc(db,"products_v2", uniqueId);
    const existing = await getDoc(ref);
    if (existing.exists()) return err(409,"Already Exists",`Product ${uniqueId} already exists.`);

    const col = collection(db,"products_v2");
    const requestedPos = Number.isFinite(+data?.placement?.position) ? toInt(data.placement.position) : null;
    const position = requestedPos ?? await nextPosition(col, [
      where("grouping.category","==",category),
      where("grouping.subCategory","==",subCategory),
      where("grouping.brand","==",brand),
    ]);

    const body = {
      docId: uniqueId,
      grouping: { category, subCategory, brand },
      placement: {
        position,
        isActive:   toBool(data?.placement?.isActive, true),
        isFeatured: toBool(data?.placement?.isFeatured, false),
        supplier_out_of_stock: toBool(data?.placement?.supplier_out_of_stock, false),
        in_stock:   toBool(data?.placement?.in_stock, true)
      },
      media: {
        color:  toStr(data?.media?.color, null) || null,
        images: parseImages(data?.media?.images),
        video:  toStr(data?.media?.video, null) || null,
        icon:   toStr(data?.media?.icon,  null) || null
      },
      product: {
        unique_id:   uniqueId,
        title:       toStr(data?.product?.title, null) || null,
        description: toStr(data?.product?.description, null) || null,
        keywords:    parseKeywords(data?.product?.keywords)
      },
      variants:  Array.isArray(data?.variants)  ? data.variants  : [],
      inventory: Array.isArray(data?.inventory) ? data.inventory : [],
      timestamps: { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
    };

    await setDoc(ref, body);
    const createdSnap = await getDoc(ref);
    const createdData = normalizeTimestamps(createdSnap.data() || {});
    const product = { id: createdSnap.id, ...createdData };

    return ok({ unique_id: uniqueId, position, message: "Product created.", product }, 201);
  }catch(e){
    console.error("products_v2/create failed:", e);
    return err(500,"Unexpected Error","Something went wrong while creating the product.");
  }
}
