import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ok:true,...p},{status:s});
const err =(s,t,m,e={})=>NextResponse.json({ok:false,title:t,message:m,...e},{status:s});

const toStr =(v,f="")=>(v==null?f:String(v)).trim();
const toBool=(v,f=false)=>typeof v==="boolean"?v:
  typeof v==="number"?v!==0:
  typeof v==="string"?["true","1","yes","y"].includes(v.toLowerCase()):f;
const toInt =(v,f=0)=>Number.isFinite(+v)?Math.trunc(+v):f;
const toNum =(v,f=0)=>Number.isFinite(+v)?+v:f;

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

    const current=snap.data()||{};
    const next=deepMerge(current,{
      ...data,
      timestamps:{...current.timestamps,updatedAt:serverTimestamp()}
    });

    await updateDoc(ref,next);
    return ok({message:"Location updated.",docId});
  }catch(e){
    console.error("bevgo_locations/update failed:",e);
    return err(500,"Unexpected Error","Failed to update location.");
  }
}
