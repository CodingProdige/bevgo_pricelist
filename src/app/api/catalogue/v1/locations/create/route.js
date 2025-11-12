import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, doc, getDocs, getDoc, setDoc, serverTimestamp, where } from "firebase/firestore";

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
        postal_code:toStr(data?.address?.postal_code,null)||null,
        coordinates:{
          lat:toNum(data?.address?.coordinates?.lat,null),
          lng:toNum(data?.address?.coordinates?.lng,null)
        }
      },
      contact:{
        name:toStr(data?.contact?.name,null)||null,
        phone:toStr(data?.contact?.phone,null)||null,
        email:toStr(data?.contact?.email,null)||null
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
