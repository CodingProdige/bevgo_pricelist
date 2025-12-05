import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, updateDoc } from "firebase/firestore";

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, data:{...p} },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

const is8 = (s)=>/^\d{8}$/.test(String(s||"").trim());

export async function POST(req){
  try{
    const body = await req.json().catch(()=>({}));

    const unique_id  = String(body?.unique_id ?? "").trim();
    const variant_id = String(body?.variant_id ?? "").trim();
    const direction  = String(body?.direction ?? "").toLowerCase();

    if (!is8(unique_id))
      return err(400,"Invalid Product Id","'unique_id' must be 8 digits.");

    if (!is8(variant_id))
      return err(400,"Invalid Variant Id","'variant_id' must be 8 digits.");

    if (!["up","down"].includes(direction))
      return err(400,"Invalid Direction","Direction must be 'up' or 'down'.");

    // Load product
    const ref  = doc(db,"products_v2", unique_id);
    const snap = await getDoc(ref);

    if (!snap.exists())
      return err(404,"Not Found","Product not found.");

    const product = snap.data() ?? {};
    const list = Array.isArray(product.variants) ? [...product.variants] : [];

    if (!list.length)
      return err(404,"Not Found","Product has no variants.");

    // Normalize existing positions and assign missing ones
    list.sort((a,b)=>(+a?.placement?.position || 0) - (+b?.placement?.position || 0))
        .forEach((v,i)=>{
          if (!v.placement) v.placement = {};
          v.placement.position = i + 1;
          v.order = i + 1;
        });

    // Find the variant to move
    const ids = list.map(v => String(v.variant_id));
    const fromIdx = ids.indexOf(variant_id);

    if (fromIdx === -1)
      return err(404,"Variant Not Found","Variant not found on this product.");

    const len = list.length;

    // wrap-around movement
    const targetIdx = direction === "up"
      ? (fromIdx - 1 + len) % len
      : (fromIdx + 1) % len;

    // reorder
    const arr = [...list];
    const [moved] = arr.splice(fromIdx,1);
    arr.splice(targetIdx,0,moved);

    // build position map
    const posMap = {};
    arr.forEach((v,i)=>{
      posMap[i] = i + 1;
    });

    // apply new positions consistently
    arr.forEach((v,i)=>{
      v.placement.position = i + 1;
      v.order = i + 1;
    });

    // write back
    await updateDoc(ref,{ variants: arr });

    return ok({
      message: "Variant nudged.",
      unique_id,
      variant_id,
      from_index: fromIdx,
      final_index: targetIdx,
      count: arr.length
    });

  } catch (e){
    console.error("variants/nudge failed:", e);
    return err(500,"Unexpected Error","Failed to nudge variant.",{
      details: String(e?.message ?? "").slice(0,300)
    });
  }
}
