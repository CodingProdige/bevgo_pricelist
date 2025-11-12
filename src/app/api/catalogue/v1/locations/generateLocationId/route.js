import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ok:true,...p},{status:s});
const err =(s,t,m,e={})=>NextResponse.json({ok:false,title:t,message:m,...e},{status:s});

export async function GET(){
  try{
    const col = collection(db,"bevgo_locations");
    const rs  = await getDocs(col);
    const ids = rs.docs
      .map(d=>String(d.data()?.location_id || ""))
      .filter(v=>/^LOC\d+$/.test(v))
      .map(v=>parseInt(v.replace("LOC",""),10))
      .filter(n=>Number.isFinite(n));

    const nextNum = (ids.length ? Math.max(...ids) : 0) + 1;
    const nextId  = `LOC${String(nextNum).padStart(6,"0")}`;

    return ok({ message:"Next location_id generated.", location_id: nextId });
  }catch(e){
    console.error("generateLocationId failed:",e);
    return err(500,"Unexpected Error","Failed to generate location_id.");
  }
}
