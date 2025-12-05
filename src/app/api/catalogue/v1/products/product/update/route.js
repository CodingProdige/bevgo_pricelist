import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  doc, getDoc, updateDoc, serverTimestamp,
  collection, getDocs, where, query
} from "firebase/firestore";

const ok  = (p = {}, s = 200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

/* ------------------ basic helpers ------------------ */
const is8   = (s) => /^\d{8}$/.test(String(s ?? "").trim());
const toStr = (v, f = "") => (v == null ? f : String(v)).trim();
const toBool= (v, f = false) =>
  typeof v === "boolean" ? v :
  typeof v === "number" ? v !== 0 :
  typeof v === "string" ? ["true","1","yes","y"].includes(v.toLowerCase()) :
  f;
const toInt = (v, f = 0) => Number.isFinite(+v) ? Math.trunc(+v) : f;

/* ------------------ title slug normalizer ------------------ */
/* Prevents duplicates even if case/spacing/punctuation differs */
function normalizeTitleSlug(title){
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")  // remove all spaces & punctuation
    .trim();
}

/* ------------------ deep merge ------------------ */
function deepMerge(target, patch) {
  if (patch == null || typeof patch !== "object") return target;
  const out = Array.isArray(target) ? [...target] : { ...target };

  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) &&
        typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/* ------------------ existing sanitizers preserved ------------------ */
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
  if (!input)
    return { imageUrl: null, blurHashUrl: null, ...(fallbackPos ? { position: fallbackPos } : {}) };

  if (typeof input === "string"){
    return { imageUrl: sanitizeUrl(input), blurHashUrl: null, ...(fallbackPos ? { position: fallbackPos } : {}) };
  }

  if (typeof input === "object"){
    const imageUrl    = sanitizeUrl(input.imageUrl ?? input.url);
    const blurHashUrl = sanitizeBlurHash(input.blurHashUrl ?? input.blurhash ?? input.blurHash);
    const pos = Number.isFinite(+input?.position) ? toInt(input.position) : undefined;
    const base = { imageUrl, blurHashUrl };

    return pos != null ? { ...base, position: pos } :
           fallbackPos ? { ...base, position: fallbackPos } :
           base;
  }

  return { imageUrl: null, blurHashUrl: null, ...(fallbackPos?{position:fallbackPos}:{}) };
}

function parseImages(value){
  let arr = [];

  if (Array.isArray(value)){
    arr = value.map((v,i)=>parseImage(v,i+1)).filter(o => o.imageUrl || o.blurHashUrl);
  } else if (value){
    const one = parseImage(value,1);
    if (one.imageUrl || one.blurHashUrl) arr=[one];
  }

  if (arr.length){
    arr = arr
      .map((it,i)=>({ ...it, position: Number.isFinite(+it.position) ? toInt(it.position,i+1) : (i+1) }))
      .sort((a,b)=>a.position - b.position)
      .map((it,i)=>({ ...it, position: i+1 }));
  }
  return arr;
}

function normalizeTimestamps(obj){
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };

  const ts = out.timestamps;
  if (ts){
    const toIso = (v) =>
      v && typeof v?.toDate === "function" ? v.toDate().toISOString() : v;

    out.timestamps = {
      createdAt: toIso(ts.createdAt),
      updatedAt: toIso(ts.updatedAt),
    };
  }
  return out;
}

/* ------------------ sanitize patch ------------------ */
function sanitizePatch(patch){
  const out = {};

  if ("grouping" in patch){
    const g = patch.grouping || {};
    out.grouping = {};
    if ("category" in g)    out.grouping.category    = toStr(g.category);
    if ("subCategory" in g) out.grouping.subCategory = toStr(g.subCategory);
    if ("brand" in g)       out.grouping.brand       = toStr(g.brand);
  }

  if ("placement" in patch){
    const p = patch.placement || {};
    out.placement = {};
    if ("position" in p)             out.placement.position = toInt(p.position);
    if ("isActive" in p)             out.placement.isActive = toBool(p.isActive);
    if ("isFeatured" in p)           out.placement.isFeatured = toBool(p.isFeatured);
    if ("supplier_out_of_stock" in p)out.placement.supplier_out_of_stock = toBool(p.supplier_out_of_stock);
    if ("in_stock" in p)             out.placement.in_stock = toBool(p.in_stock);
  }

  if ("media" in patch){
    const m = patch.media || {};
    out.media = {};
    if ("color" in m)  out.media.color  = toStr(m.color, null) || null;
    if ("images" in m) out.media.images = parseImages(m.images);
    if ("video" in m)  out.media.video  = toStr(m.video, null) || null;
    if ("icon" in m)   out.media.icon   = toStr(m.icon,  null) || null;
  }

  if ("product" in patch){
    const pr = patch.product || {};
    out.product = {};
    if ("unique_id" in pr)   out.product.unique_id = toStr(pr.unique_id);
    if ("title" in pr)       out.product.title     = toStr(pr.title, null) || null;
    if ("description" in pr) out.product.description = toStr(pr.description, null) || null;
    if ("keywords" in pr)    out.product.keywords    = parseKeywords(pr.keywords);
  }

  if ("inventory" in patch){
    out.inventory = Array.isArray(patch.inventory) ? patch.inventory : [];
  }

  return out;
}

/* ============================================================
   =======================  ENDPOINT   =========================
   ============================================================ */

export async function POST(req){
  try{
    const { unique_id, data } = await req.json();

    const pid = toStr(unique_id);
    if (!is8(pid))
      return err(400,"Invalid Product ID","unique_id must be an 8-digit string.");

    if (!data || typeof data !== "object")
      return err(400,"Invalid Data","Provide a 'data' object to update.");

    if ("variants" in data)
      return err(400,"Variants Not Allowed","Use variant endpoints.");

    /* -- Load existing product -- */
    const ref = doc(db,"products_v2", pid);
    const snap = await getDoc(ref);

    if (!snap.exists())
      return err(404,"Product Not Found",`No product with ID ${pid}.`);

    const current = snap.data() || {};

    /* -- Build sanitized patch + merged object -- */
    const patch = sanitizePatch(data);
    const next  = deepMerge(current, patch);

    /* ============================================================
       1. Duplicate title check using titleSlug (case-insensitive,
          space-insensitive, punctuation-insensitive)
       ============================================================ */
    const groupingChanged =
      ("grouping" in patch &&
       (patch.grouping.category ||
        patch.grouping.subCategory ||
        patch.grouping.brand));

    const titleChanged =
      ("product" in patch &&
       "title" in (patch.product || {}));

    if (groupingChanged || titleChanged){

      const nextCategory    = toStr(next?.grouping?.category);
      const nextSubCategory = toStr(next?.grouping?.subCategory);
      const nextBrand       = toStr(next?.grouping?.brand);
      const nextTitleRaw    = toStr(next?.product?.title);
      const nextSlug        = normalizeTitleSlug(nextTitleRaw);

      if (!nextSlug)
        return err(400,"Invalid Title","product.title cannot be empty.");

      // Store slug in patch for update
      next.product.titleSlug = nextSlug;

      const q = query(
        collection(db,"products_v2"),
        where("grouping.category","==", nextCategory),
        where("grouping.subCategory","==", nextSubCategory),
        where("grouping.brand","==", nextBrand),
        where("product.titleSlug","==", nextSlug)
      );

      const rs = await getDocs(q);

      // ensure duplicate is NOT this product:
      const conflict = rs.docs.some(d => d.id !== pid);

      if (conflict){
        return err(
          409,
          "Duplicate Title",
          `Another product in this grouping has a similar title ('${nextTitleRaw}').`
        );
      }
    }

    /* -- Update Firestore -- */
    await updateDoc(ref, {
      ...next,
      "timestamps.updatedAt": serverTimestamp()
    });

    const updatedSnap = await getDoc(ref);
    const updated = normalizeTimestamps(updatedSnap.data());

    return ok({
      unique_id: pid,
      message: "Product updated.",
      product: updated
    });

  } catch (e){
    console.error("products_v2/update failed:", e);
    return err(
      500,
      "Unexpected Error",
      "Failed to update product.",
      { details: String(e?.message ?? "").slice(0,300) }
    );
  }
}
