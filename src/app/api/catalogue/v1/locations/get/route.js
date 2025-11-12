import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs, doc, getDoc } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ok:true,...p},{status:s});
const err =(s,t,m,e={})=>NextResponse.json({ok:false,title:t,message:m,...e},{status:s});

function tsToIso(v){return v && typeof v?.toDate==="function"?v.toDate().toISOString():v??null;}
function normalizeTimestamps(doc){
  if(!doc||typeof doc!=="object")return doc;
  const ts=doc.timestamps;
  return {...doc, ...(ts?{timestamps:{createdAt:tsToIso(ts.createdAt),updatedAt:tsToIso(ts.updatedAt)}}:{})};
}

export async function GET(req){
  try{
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    const col = collection(db,"bevgo_locations");

    if(id){
      const ref = doc(col,id);
      const snap = await getDoc(ref);
      if(!snap.exists()) return err(404,"Not Found","No location found.");
      return ok({data:normalizeTimestamps(snap.data())});
    }

    const rs = await getDocs(col);
    const items = rs.docs.map(d=>normalizeTimestamps(d.data()||{}))
      .sort((a,b)=>(+a?.placement?.position||0)-(+b?.placement?.position||0));
    return ok({count:items.length,items});
  }catch(e){
    console.error("bevgo_locations/get failed:",e);
    return err(500,"Unexpected Error","Failed to fetch locations.");
  }
}
