import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, doc, getDoc, getDocs, updateDoc, setDoc, deleteDoc, serverTimestamp
} from "firebase/firestore";

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
    const { id, data } = await req.json();

    const currId = String(id ?? "").trim(); // Firestore doc ID (auto id in your setup)
    if (!currId) return err(400,"Invalid Id","Provide current 'id' (existing category doc id).");
    if (!data || typeof data!=="object") return err(400,"Invalid Data","Provide a 'data' object with fields to update.");

    // Load current doc
    const currRef = doc(db,"categories", currId);
    const currSnap = await getDoc(currRef);
    if (!currSnap.exists()) return err(404,"Not Found",`No category with id '${currId}'.`);
    const current = currSnap.data()||{};

    // Normalize parts
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

    // Enforce unique title (excluding current doc)
    const newTitle = String(next?.category?.title ?? "").trim();
    if (await titleExists(titleKey(newTitle), currId)) {
      return err(409,"Duplicate Title","A category with the same title already exists.");
    }

    // Normalize placement.position
    const pos = Number.isFinite(+next?.placement?.position) && +next.placement.position>0
      ? Math.trunc(+next.placement.position)
      : (Number.isFinite(+current?.placement?.position) ? Math.trunc(+current.placement.position) : 1);

    next.docId = currId; // keep actual Firestore document id here
    next.placement = { ...(next.placement||{}), position: pos };
    next.timestamps = {
      ...(current.timestamps||{}),
      updatedAt: serverTimestamp(),
      createdAt: current?.timestamps?.createdAt ?? serverTimestamp()
    };

    // Detect slug change and keep old/new around for propagation
    const oldSlug = String(current?.category?.slug ?? "").trim();
    const newSlug = String(next?.category?.slug ?? oldSlug).trim();
    const slugChanged = !!(oldSlug && newSlug && oldSlug !== newSlug);

    // Save category first
    await setDoc(currRef, next, { merge:false });

    // If slug changed → propagate to dependent collections (ALL IN MEMORY, no indexes)
    let touched = null;
    if (slugChanged){
      touched = { sub_categories:0, brands:0, products_v2:0, returnables:0 };

      const batches = [
        { col: "sub_categories", path: "grouping.category" },
        { col: "brands",         path: "grouping.category" },
        { col: "products_v2",    path: "grouping.category" },
        { col: "returnables",    path: "grouping.category" },
      ];

      for (const { col, path } of batches){
        const snap = await getDocs(collection(db, col));
        const rows = snap.docs.map(d => ({ id: d.id, data: d.data() || {} }));
        const toUpdate = rows.filter(r => String(r.data?.grouping?.category || "") === oldSlug);

        // update sequentially to keep it simple (still all in-memory)
        for (const r of toUpdate){
          await updateDoc(doc(db, col, r.id), { [path]: newSlug });
          touched[col] += 1;
        }
      }
    }

    // Return updated, normalized doc + propagation summary
    const saved = await getDoc(currRef);
    return ok({
      message: slugChanged ? "Category updated (slug propagated)." : "Category updated.",
      id: saved.id,
      data: normalizeTimestamps(saved.data()||{}),
      ...(slugChanged ? { propagation: { from: oldSlug, to: newSlug, touched } } : {})
    });
  }catch(e){
    console.error("categories/update failed:", e);
    return err(500,"Unexpected Error","Something went wrong while updating the category.");
  }
}
