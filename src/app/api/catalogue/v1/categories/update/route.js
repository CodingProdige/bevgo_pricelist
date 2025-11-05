// app/api/catalogue/v1/categories/update/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, doc, getDoc, getDocs, setDoc, deleteDoc, serverTimestamp } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

const titleKey = (s)=>String(s??"").toLowerCase().replace(/\s+/g," ").trim();

async function titleExists(normalizedTitle, excludeId){
  if (!normalizedTitle) return false;
  const snap = await getDocs(collection(db,"categories"));
  for (const d of snap.docs){
    if (d.id === excludeId) continue;
    const t = titleKey(d.data()?.category?.title);
    if (t && t === normalizedTitle) return true;
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
  let max=0;
  for (const im of mapped){ const p=+im.position; if (Number.isFinite(p)&&p>0&&p>max) max=p; }
  if (max===0) return mapped.map((im,i)=>({ ...im, position:i+1 }));
  let cur=max;
  return mapped.map(im=> (Number.isFinite(+im.position)&&+im.position>0)? im : ({...im, position:++cur}));
}
function deepMerge(target, patch){
  if (patch==null || typeof patch!=="object") return target;
  const out = Array.isArray(target)? [...target] : { ...target };
  for (const [k,v] of Object.entries(patch)){
    if (v && typeof v==="object" && !Array.isArray(v) && typeof out[k]==="object" && !Array.isArray(out[k])){
      out[k]=deepMerge(out[k], v);
    }else{
      out[k]=v;
    }
  }
  return out;
}
const tsToIso = v => v && typeof v?.toDate==="function" ? v.toDate().toISOString() : v ?? null;
const normalizeTimestamps = doc => !doc||typeof doc!=="object"? doc : ({
  ...doc,
  ...(doc.timestamps? { timestamps:{ createdAt:tsToIso(doc.timestamps.createdAt), updatedAt:tsToIso(doc.timestamps.updatedAt) } } : {})
});

export async function POST(req){
  try{
    const { id, data, allow_slug_regen = false } = await req.json();

    const currId = String(id ?? "").trim();
    if (!currId) return err(400,"Invalid Id","Provide current 'id' (existing category slug).");
    if (!data || typeof data!=="object") return err(400,"Invalid Data","Provide a 'data' object with fields to update.");

    // Load current
    const currRef = doc(db,"categories", currId);
    const currSnap = await getDoc(currRef);
    if (!currSnap.exists()) return err(404,"Not Found",`No category with id '${currId}'.`);
    const current = currSnap.data()||{};

    // Pre-sanitize parts
    if (data?.category && Object.prototype.hasOwnProperty.call(data.category,"keywords")){
      data.category.keywords = parseKeywords(data.category.keywords);
    }
    if (data?.media && Object.prototype.hasOwnProperty.call(data.media,"images")){
      data.media.images = parseImages(data.media.images);
    }

    // Merge (arrays replace)
    const { timestamps:_t1, docId:_t2, ...rest } = data;
    let next = deepMerge(current, rest);
    if (rest?.category){
      next.category = deepMerge(current.category||{}, rest.category);
    }

    // Enforce unique title (excluding current)
    const newTitle = String(next?.category?.title ?? "").trim();
    if (await titleExists(titleKey(newTitle), currId)) {
      return err(409,"Duplicate Title","A category with the same title already exists.");
    }

    // Slug handling
    let targetSlug = currId;
    const requestedSlug = String(data?.category?.slug ?? "").trim();
    if (allow_slug_regen && requestedSlug){
      if (requestedSlug !== currId){
        // ensure requested slug unused
        const targetRef = doc(db,"categories", requestedSlug);
        const targetSnap = await getDoc(targetRef);
        if (targetSnap.exists()) return err(409,"Category Exists",`A category with slug '${requestedSlug}' already exists.`);
        targetSlug = requestedSlug;
      }
    } else if (requestedSlug && requestedSlug !== currId){
      return err(409,"Slug Immutable","Slug cannot be changed unless 'allow_slug_regen' is true.");
    }

    // Normalize placement.position
    const pos = Number.isFinite(+next?.placement?.position) && +next.placement.position>0
      ? Math.trunc(+next.placement.position)
      : (Number.isFinite(+current?.placement?.position) ? Math.trunc(+current.placement.position) : 1);

    next.docId = targetSlug;
    next.category = { ...(next.category||{}), slug: targetSlug };
    next.placement = { ...(next.placement||{}), position: pos };
    next.timestamps = {
      ...(current.timestamps||{}),
      updatedAt: serverTimestamp(),
      createdAt: current?.timestamps?.createdAt ?? serverTimestamp()
    };

    if (targetSlug === currId){
      await setDoc(currRef, next, { merge:false });
      const saved = await getDoc(currRef);
      return ok({ message:"Category updated.", id:saved.id, data: normalizeTimestamps(saved.data()||{}) });
    }

    const newRef = doc(db,"categories", targetSlug);
    await setDoc(newRef, next, { merge:false });
    await deleteDoc(currRef);
    const moved = await getDoc(newRef);
    return ok({
      message:"Category updated (slug changed).",
      id: moved.id,
      previous_id: currId,
      data: normalizeTimestamps(moved.data()||{})
    });
  }catch(e){
    console.error("categories/update failed:", e);
    return err(500,"Unexpected Error","Something went wrong while updating the category.");
  }
}
