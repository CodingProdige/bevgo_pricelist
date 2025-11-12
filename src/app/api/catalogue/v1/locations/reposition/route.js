import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs, doc, updateDoc, serverTimestamp } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ok:true,...p},{status:s});
const err =(s,t,m,e={})=>NextResponse.json({ok:false,title:t,message:m,...e},{status:s});

export async function POST(req){
  try{
    const { orderedIds } = await req.json();
    const col = collection(db,"bevgo_locations");
    const rs = await getDocs(col);
    const docs = rs.docs;

    if(Array.isArray(orderedIds)&&orderedIds.length){
      for(let i=0;i<orderedIds.length;i++){
        const id=orderedIds[i];
        const ref=doc(db,"bevgo_locations",id);
        await updateDoc(ref,{
          "placement.position":i+1,
          "timestamps.updatedAt":serverTimestamp()
        });
      }
      return ok({message:"Positions updated from provided array.",count:orderedIds.length});
    }

    // auto resequence by current order
    const sorted = docs.sort((a,b)=>(+a.data()?.placement?.position||0)-(+b.data()?.placement?.position||0));
    for(let i=0;i<sorted.length;i++){
      const ref=doc(db,"bevgo_locations",sorted[i].id);
      await updateDoc(ref,{
        "placement.position":i+1,
        "timestamps.updatedAt":serverTimestamp()
      });
    }
    return ok({message:"Positions resequenced automatically.",count:sorted.length});
  }catch(e){
    console.error("bevgo_locations/reposition failed:",e);
    return err(500,"Unexpected Error","Failed to reposition locations.");
  }
}
