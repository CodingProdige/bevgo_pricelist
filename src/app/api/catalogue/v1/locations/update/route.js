import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs, doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ok:true,...p},{status:s});
const err =(s,t,m,e={})=>NextResponse.json({ok:false,title:t,message:m,...e},{status:s});

const toStr =(v,f="")=>(v==null?f:String(v)).trim();
const toBool=(v,f=false)=>typeof v==="boolean"?v:
  typeof v==="number"?v!==0:
  typeof v==="string"?["true","1","yes","y"].includes(v.toLowerCase()):f;
const toInt =(v,f=0)=>Number.isFinite(+v)?Math.trunc(+v):f;

/* --- media parsing utilities (same as create) --- */
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

/* --- deep merge utility --- */
function deepMerge(target,patch){
  if(patch==null||typeof patch!=="object")return target;
  const out={...target};
  for(const[k,v]of Object.entries(patch)){
    if(v&&typeof v==="object"&&!Array.isArray(v)&&typeof out[k]==="object"&&!Array.isArray(out[k])){
      out[k]=deepMerge(out[k],v);
    }else{
      out[k]=v;
    }
  }
  return out;
}

export async function POST(req){
  try{
    const { docId, data } = await req.json();
    if(!docId) return err(400,"Missing ID","Provide 'docId' of location to update.");
    if(!data||typeof data!=="object") return err(400,"Invalid Data","Provide valid update payload.");

    const ref=doc(db,"bevgo_locations",docId);
    const snap=await getDoc(ref);
    if(!snap.exists()) return err(404,"Not Found","Location not found.");

    // Handle incoming media updates separately (replace array)
    if (data?.media?.images) {
      data.media.images = parseImages(data.media.images);
    }

    const current=snap.data()||{};
    const next=deepMerge(current,{
      ...data,
      timestamps:{...current.timestamps,updatedAt:serverTimestamp()}
    });

    await updateDoc(ref,next);

    /* ---------- Enforce single isPrimary ---------- */
    if (data?.placement?.isPrimary === true) {
      const col = collection(db,"bevgo_locations");
      const rs = await getDocs(col);
      for (const d of rs.docs) {
        if (d.id !== docId) {
          const p = d.data()?.placement;
          if (p?.isPrimary) {
            await updateDoc(doc(db,"bevgo_locations",d.id),{
              "placement.isPrimary": false,
              "timestamps.updatedAt": serverTimestamp()
            });
          }
        }
      }
    }

    return ok({message:"Location updated.",docId});
  }catch(e){
    console.error("bevgo_locations/update failed:",e);
    return err(500,"Unexpected Error","Failed to update location.");
  }
}
