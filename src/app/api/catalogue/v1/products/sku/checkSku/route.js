// app/api/catalogue/v1/products/utils/checkSkuUnique/route.js
/**
 * Check if an SKU is unique across products_v2 (product.sku + variants[].sku),
 * optionally excluding the current product/variant when editing.
 *
 * METHOD: POST
 * BODY:
 *   - sku         (string, required)
 *   - productId   (string, optional)
 *   - variantId   (string, optional)
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";

/* ---------- helpers ---------- */
const ok  = (p = {}, s = 200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e = {}) => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });
const up  = (s) => String(s ?? "").trim().toUpperCase();

/* ---------- route ---------- */
export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const src  = typeof body?.data === "object" ? body.data : body;

    const sku       = up(src?.sku);
    const productId = String(src?.productId ?? "").trim();
    const variantId = String(src?.variantId ?? "").trim();

    if (!sku) return err(400, "Invalid SKU", "Provide a non-empty 'sku' string.");

    const snap = await getDocs(collection(db, "products_v2"));

    for (const d of snap.docs) {
      const pid  = d.id;
      const data = d.data() || {};

      /* ---------- product-level SKU ---------- */
      const pSku = up(data?.product?.sku);
      if (pSku && pSku === sku && pid !== productId) {
        return ok({
          unique: false,
          conflict: { productId: pid, type: "product" }
        });
      }

      /* ---------- variant-level SKU ---------- */
      const variants = Array.isArray(data?.variants) ? data.variants : [];
      for (const v of variants) {
        const vSku = up(v?.sku);
        const vId  = String(v?.variant_id ?? "").trim();
        const isSelf = pid === productId && String(vId) === String(variantId);

        if (vSku && vSku === sku && !isSelf) {
          return ok({
            unique: false,
            conflict: { productId: pid, variantId: vId, type: "variant" }
          });
        }
      }
    }

    return ok({ unique: true });
  } catch (e) {
    console.error("checkSkuUnique failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while checking SKU uniqueness.");
  }
}
