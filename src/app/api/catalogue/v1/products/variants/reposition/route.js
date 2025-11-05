// app/api/products_v2/variants/reposition/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, updateDoc } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });
const is8 =(s)=>/^\d{8}$/.test(String(s||"").trim());

export async function POST(req){
  try{
    const { unique_id, variant_id, position } = await req.json();

    const pid = String(unique_id||"").trim();
    const vid = String(variant_id||"").trim();
    const newPos = Math.max(1, parseInt(position,10)||1);

    if (!is8(pid)) return err(400,"Invalid Product Id","'unique_id' must be an 8-digit string.");
    if (!is8(vid)) return err(400,"Invalid Variant Id","'variant_id' must be an 8-digit string.");

    const ref = doc(db,"products_v2", pid);
    const snap = await getDoc(ref);
    if (!snap.exists()) return err(404,"Not Found","Product not found.");
    const p = snap.data()||{};
    const list = Array.isArray(p?.variants) ? p.variants.slice() : [];
    if (!list.length) return err(404,"Not Found","No variants to reposition.");

    // normalize by placement.position; if missing, assign 1..N
    list.sort((a,b)=>(+a?.placement?.position||0)-(+b?.placement?.position||0))
        .forEach((v,i)=>{ if(!v.placement) v.placement={}; v.placement.position = i+1; v.order = i+1; });

    const fromIdx = list.findIndex(v => String(v?.variant_id||"").trim() === vid);
    if (fromIdx < 0) return err(404,"Variant Not Found","Variant not found on this product.");

    const item = list.splice(fromIdx,1)[0];
    const targetIdx = Math.min(Math.max(newPos,1), list.length+1)-1;
    list.splice(targetIdx,0,item);

    // rewrite positions 1..N and keep 'order' in sync
    list.forEach((v,i)=>{ v.placement.position = i+1; v.order = i+1; });

    await updateDoc(ref, { variants: list });
    return ok({ message:"Variant repositioned.", final_position: targetIdx+1, count: list.length });
  }catch(e){
    console.error("products_v2/variants/reposition (new schema) failed:", e);
    return err(500,"Unexpected Error","Failed to reposition variant.");
  }
}
