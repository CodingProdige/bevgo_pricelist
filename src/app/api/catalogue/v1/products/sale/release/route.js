export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, updateDoc } from "firebase/firestore";

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

export async function POST(req){
  try{
    const body = await req.json();
    const { unique_id, variant_id, qty } = body || {};

    if (!unique_id || !variant_id || !qty || qty <= 0) {
      return err(400,"Invalid Request","unique_id, variant_id and positive qty required.");
    }

    const productRef = doc(db,"products_v2", String(unique_id));
    const snap = await getDoc(productRef);

    if (!snap.exists()) {
      return err(404,"Product Not Found","No product with provided unique_id.");
    }

    let data = snap.data();
    const variant = data.variants?.find(v => v.variant_id == variant_id);

    if (!variant) {
      return err(404,"Variant Not Found","Variant does not exist for this product.");
    }

    if (!variant.sale?.is_on_sale) {
      return err(400,"Not On Sale","Variant is not currently on sale.");
    }

    const current = variant.sale.qty_available || 0;

    // Restore stock (never exceeding initial availability logic — if needed)
    variant.sale.qty_available = current + qty;

    await updateDoc(productRef, {
      variants: data.variants,
      "timestamps.updatedAt": new Date().toISOString()
    });

    return ok({
      message: "Sale stock released.",
      unique_id,
      variant_id,
      qty_released: qty,
      qty_available: variant.sale.qty_available
    });

  }catch(e){
    console.error(e);
    return err(500,"Release Failed","Unexpected server error",{ error:e.toString() });
  }
}
