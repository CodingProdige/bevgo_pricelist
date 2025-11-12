import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, deleteDoc } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ok:true,...p},{status:s});
const err =(s,t,m,e={})=>NextResponse.json({ok:false,title:t,message:m,...e},{status:s});

export async function POST(req){
  try{
    const { docId } = await req.json();
    if(!docId) return err(400,"Missing ID","Provide 'docId' to delete.");

    const ref=doc(db,"bevgo_locations",docId);
    const snap=await getDoc(ref);
    if(!snap.exists()) return err(404,"Not Found","Location not found.");

    await deleteDoc(ref);

    return ok({message:"Location permanently deleted.", docId});
  }catch(e){
    console.error("bevgo_locations/delete failed:",e);
    return err(500,"Unexpected Error","Failed to delete location.");
  }
}
