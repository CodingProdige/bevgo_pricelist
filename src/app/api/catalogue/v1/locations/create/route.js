import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, doc, getDocs, getDoc, setDoc, serverTimestamp } from "firebase/firestore";

/* ---------------- response helpers ---------------- */
const ok  =(p={},s=201)=>NextResponse.json({ok:true,...p},{status:s});
const err =(s,t,m,e={})=>NextResponse.json({ok:false,title:t,message:m,...e},{status:s});

/* ---------------- type helpers ---------------- */
const toStr =(v,f="")=>(v==null?f:String(v)).trim();
const toBool=(v,f=false)=>typeof v==="boolean"?v:
  typeof v==="number"?v!==0:
  typeof v==="string"?["true","1","yes","y"].includes(v.toLowerCase()):f;
const toInt =(v,f=0)=>Number.isFinite(+v)?Math.trunc(+v):f;
const toNum =(v,f=0)=>Number.isFinite(+v)?+v:f;

/* ---------------- util: parse images ---------------- */
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

/* ---------------- util: get next position ---------------- */
async function nextPosition(colRef){
  const snap=await getDocs(colRef);
  const positions=snap.docs.map(d=>+d.data()?.placement?.position||0);
  const max=Math.max(0,...positions);
  return max+1;
}

/* ---------------- util: check unique location_id ---------------- */
async function isLocationIdTaken(colRef, location_id){
  const snap=await getDocs(colRef);
  return snap.docs.some(d=>String(d.data()?.location_id||"").trim()===location_id);
}

export async function POST(req){
  try{
    const { data } = await req.json();
    if(!data || typeof data!=="object") 
      return err(400,"Invalid Data","Provide a valid 'data' object.");

    const location_id=toStr(data.location_id);
    const title=toStr(data.title);
    const type=toStr(data.type,"warehouse");
    if(!location_id || !title) 
      return err(400,"Missing Fields","'location_id' and 'title' are required.");

    const col=collection(db,"bevgo_locations");
    const exists=await isLocationIdTaken(col,location_id);
    if(exists) return err(409,"Duplicate Location ID",`'${location_id}' already exists.`);

    const requestedPos = Number.isFinite(+data?.placement?.position) ? toInt(data.placement.position) : null;
    const position = requestedPos ?? await nextPosition(col);

    const body={
      location_id,
      title,
      type,
      address:{
        line1:toStr(data?.address?.line1,null)||null,
        city:toStr(data?.address?.city,null)||null,
        province:toStr(data?.address?.province,null)||null,
        postal_code:toStr(data?.address?.postal_code,null)||null
      },
      contact:{
        name:toStr(data?.contact?.name,null)||null,
        phone:toStr(data?.contact?.phone,null)||null,
        email:toStr(data?.contact?.email,null)||null
      },
      media:{
        images: parseImages(data?.media?.images)
      },
      placement:{
        isActive:toBool(data?.placement?.isActive,true),
        isPrimary:toBool(data?.placement?.isPrimary,false),
        position
      },
      capacity:{
        max_pallets:toInt(data?.capacity?.max_pallets,0),
        notes:toStr(data?.capacity?.notes,null)||null
      },
      timestamps:{
        createdAt:serverTimestamp(),
        updatedAt:serverTimestamp()
      }
    };

    const ref=doc(col);
    body.docId=ref.id;
    await setDoc(ref,body);

    return ok({message:"Location created.", location_id, position, data:body});
  }catch(e){
    console.error("bevgo_locations/create failed:",e);
    return err(500,"Unexpected Error","Something went wrong while creating location.");
  }
}
