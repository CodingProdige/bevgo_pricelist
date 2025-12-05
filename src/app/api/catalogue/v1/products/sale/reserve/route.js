export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { 
  collection, query, where, getDocs, 
  updateDoc, doc, getDoc 
} from "firebase/firestore";

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

export async function POST(req){
  try{
    const body = await req.json();
    let { unique_id, variant_id, qty } = body || {};

    // force types
    unique_id = String(unique_id);
    variant_id = String(variant_id);
    qty = Number(qty);

    if (!unique_id || !variant_id || isNaN(qty) || qty <= 0) {
      return err(400, "Invalid Request",
        "unique_id, variant_id and qty > 0 are required."
      );
    }

    // Lookup product
    const qRef = doc(db, "products_v2", unique_id);
    const snap = await getDoc(qRef);

    if (!snap.exists()) {
      return err(404, "Product Not Found", "No product with this unique_id.");
    }

    const data = snap.data();
    const variant = data.variants?.find(v => String(v.variant_id) === variant_id);

    if (!variant) {
      return err(404, "Variant Not Found", "Variant does not exist.");
    }

    if (!variant.sale?.is_on_sale) {
      return err(400, "Not On Sale", "Variant is not currently on sale.");
    }

    const available = Number(variant.sale.qty_available || 0);

    if (qty > available) {
      return err(400, "Insufficient Stock",
        `Only ${available} sale units available.`
      );
    }

    // Deduct sale stock
    variant.sale.qty_available = available - qty;

    await updateDoc(qRef, {
      variants: data.variants,
      "timestamps.updatedAt": new Date().toISOString(),
    });

    return ok({
      message: "Sale stock reserved.",
      unique_id,
      variant_id,
      qty_reserved: qty,
      qty_remaining: variant.sale.qty_available
    });

  } catch (e) {
    console.error("Reserve ERROR:", e);
    return err(500, "Reserve Failed", "Unexpected server error", {
      error: e.toString()
    });
  }
}
