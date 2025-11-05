// app/api/catalogue/v1/products/utils/checkSkuUnique/route.js
/**
 * Check if an SKU is unique across products_v2 (product.sku + variants[].sku).
 *
 * METHOD: POST
 * BODY:
 *   - sku  (string, required)
 *   - (optionally supports { data: { sku } } wrapper)
 *
 * RESPONSE:
 *   - 200: { ok: true, unique: true }            // not found anywhere
 *   - 200: { ok: true, unique: false }           // already exists
 *   - 4xx/5xx: { ok: false, title, message }
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";

const ok  = (p={}, s=200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s,t,m,e={})  => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });
const up  = (s) => String(s ?? "").trim().toUpperCase();

export async function POST(req){
  try{
    const body = await req.json().catch(()=> ({}));
    const src  = typeof body?.data === "object" ? body.data : body;

    const raw = src?.sku;
    const sku = up(raw);
    if (!sku) return err(400, "Invalid SKU", "Provide a non-empty 'sku' string.");

    // Scan all products_v2 for product.sku and variants[].sku
    const snap = await getDocs(collection(db, "products_v2"));
    for (const d of snap.docs) {
      const data = d.data() || {};
      const pSku = up(data?.product?.sku);
      if (pSku && pSku === sku) return ok({ unique: false });

      const variants = Array.isArray(data?.variants) ? data.variants : [];
      for (const v of variants) {
        const vSku = up(v?.sku);
        if (vSku && vSku === sku) return ok({ unique: false });
      }
    }

    return ok({ unique: true });
  } catch (e) {
    console.error("checkSkuUnique failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while checking SKU uniqueness.");
  }
}
