// app/api/catalogue/v1/categories/create/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, doc, getDoc, getDocs, setDoc,
  serverTimestamp, getCountFromServer
} from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

const titleKey = (s)=>String(s??"").toLowerCase().replace(/\s+/g," ").trim();

async function nextPosition(){
  const snap = await getCountFromServer(collection(db,"categories"));
  return (snap.data().count || 0) + 1;
}

async function titleExists(normalizedTitle){
  if (!normalizedTitle) return false;
  const snap = await getDocs(collection(db,"categories"));
  for (const d of snap.docs){
    const t = titleKey(d.data()?.category?.title);
    if (t && t === normalizedTitle) return true;
  }
  return false;
}

async function slugExists(slug){
  const want = String(slug||"").trim().toLowerCase();
  if (!want) return false;
  const snap = await getDocs(collection(db,"categories"));
  for (const d of snap.docs){
    const s = String(d.data()?.category?.slug ?? "").trim().toLowerCase();
    if (s && s === want) return true;
  }
  return false;
}

function parseKeywords(v){
  const raw = Array.isArray(v)? v.join(",") : (v ?? "");
  return String(raw).split(",")
    .map(s=>s.replace(/\s+/g," ").trim())
    .filter(Boolean)
    .map(s=>s.toLowerCase())
    .filter((v,i,a)=>a.indexOf(v)===i)
    .slice(0,100);
}

function parseImage(input, fallbackPos){
  const base = { imageUrl:null, blurHashUrl:null, position:null };
  if (!input) return { ...base, position:fallbackPos };
  if (typeof input==="string") return { imageUrl:input.trim()||null, blurHashUrl:null, position:fallbackPos };
  const imageUrl=(input.imageUrl??input.url??"").trim()||null;
  const blurHashUrl=(input.blurHashUrl??input.blurhash??input.blurHash??"").trim()||null;
  const p = Number.isFinite(+input.position)&&+input.position>0 ? Math.trunc(+input.position) : fallbackPos;
  return { imageUrl, blurHashUrl, position:p };
}

function parseImages(v){
  if (!v) return [];
  const arr = Array.isArray(v)? v : [v];
  const mapped = arr.map(x=>parseImage(x,null)).filter(o=>o.imageUrl||o.blurHashUrl);
  // ensure positions contiguous
  let max=0;
  for (const im of mapped){ const p=+im.position; if (Number.isFinite(p)&&p>0&&p>max) max=p; }
  if (max===0) return mapped.map((im,i)=>({ ...im, position:i+1 }));
  let cur=max;
  return mapped.map(im=> (Number.isFinite(+im.position)&&+im.position>0)? im : ({...im, position:++cur}));
}

const tsToIso = v => v && typeof v?.toDate==="function" ? v.toDate().toISOString() : v ?? null;
const normalizeTimestamps = doc => !doc||typeof doc!=="object"? doc : ({
  ...doc,
  ...(doc.timestamps? { timestamps:{ createdAt:tsToIso(doc.timestamps.createdAt), updatedAt:tsToIso(doc.timestamps.updatedAt) } } : {})
});

export async function POST(req){
  try{
    const { data } = await req.json();
    if (!data || typeof data!=="object") return err(400,"Invalid Data","Provide a 'data' object.");

    const slug  = String(data?.category?.slug ?? "").trim();
    const title = String(data?.category?.title ?? "").trim();
    if (!slug)  return err(400,"Missing Slug","Provide 'category.slug'.");
    if (!title) return err(400,"Missing Title","Provide 'category.title'.");

    // Uniqueness checks (in-memory, case-insensitive)
    if (await slugExists(slug)) {
      return err(409,"Category Exists",`A category with slug '${slug}' already exists.`);
    }
    if (await titleExists(titleKey(title))) {
      return err(409,"Duplicate Title","A category with the same title already exists.");
    }

    const position =
      Number.isFinite(+data?.placement?.position) && +data.placement.position>0
        ? Math.trunc(+data.placement.position)
        : await nextPosition();

    // Pre-generate a doc ref so we can write docId in one go
    const newRef = doc(collection(db,"categories"));

    const body = {
      docId: newRef.id,           // 👈 now guaranteed
      category: {
        slug,
        title,
        description: data?.category?.description ?? null,
        keywords: parseKeywords(data?.category?.keywords),
      },
      placement: {
        position,
        isActive:   data?.placement?.isActive   ?? true,
        isFeatured: data?.placement?.isFeatured ?? false,
      },
      media: {
        color:  data?.media?.color ?? null,
        images: parseImages(data?.media?.images),
        video:  data?.media?.video ?? null,
        icon:   data?.media?.icon ?? null,
      },
      timestamps: { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
    };

    // Single write with docId embedded
    await setDoc(newRef, body);

    // Re-read for normalized timestamps + echo back
    const snap = await getDoc(newRef);
    const saved = normalizeTimestamps(snap.data()||{});

    return ok({ message:"Category created.", id:newRef.id, data:saved }, 201);
  }catch(e){
    console.error("categories/create failed:", e);
    return err(500,"Unexpected Error","Something went wrong while creating the category.");
  }
}
