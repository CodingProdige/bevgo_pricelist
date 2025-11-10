// app/api/catalogue/v1/products/utils/checkSkuUnique/route.js
/**
 * Check if an SKU is unique across products_v2 (product.sku + variants[].sku),
 * optionally excluding the current product/variant when editing.
 *
 * METHOD: POST
 * BODY:
 *   - sku         (string, required)
 *   - productId   (string, optional)  // current product being edited
 *   - variantId   (string, optional)  // current variant being edited
 *   - (optionally supports { data: { ... } } wrapper)
 *
 * RESPONSE:
 *   - 200: { ok: true, unique: true }            // not found anywhere
 *   - 200: { ok: true, unique: false, conflict } // already exists
 *   - 4xx/5xx: { ok: false, title, message }
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";

const ok  = (p={}, s=200) => NextResponse.json({ ok:true, ...p }, { status:s });
const err = (s,t,m,e={}) => NextResponse.json({ ok:false, title:t, message:m, ...e }, { status:s });
const up  = (s) => String(s ?? "").trim().toUpperCase();

export async function POST(req){
  try {
    const body = await req.json().catch(()=> ({}));
    const src  = typeof body?.data === "object" ? body.data : body;

    const sku        = up(src?.sku);
    const productId  = src?.productId || null;
    const variantId  = src?.variantId || null;

    if (!sku) return err(400, "Invalid SKU", "Provide a non-empty 'sku' string.");

    // Scan all products
    const snap = await getDocs(collection(db, "products_v2"));
    for (const d of snap.docs) {
      const pid = d.id;
      const data = d.data() || {};

      // Skip same product if editing (we'll check variants inside separately)
      const pSku = up(data?.product?.sku);
      if (pSku && pSku === sku && pid !== productId)
        return ok({ unique: false, conflict: { productId: pid, type: "product" } });

      // Check variants
      const variants = Array.isArray(data?.variants) ? data.variants : [];
      for (const v of variants) {
        const vSku = up(v?.sku);
        const vId  = v?.id || v?.variantId || null;
        const isSelf = pid === productId && vId === variantId;

        if (vSku && vSku === sku && !isSelf)
          return ok({ unique: false, conflict: { productId: pid, variantId: vId, type: "variant" } });
      }
    }

    return ok({ unique: true });
  } catch (e) {
    console.error("checkSkuUnique failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while checking SKU uniqueness.");
  }
}
