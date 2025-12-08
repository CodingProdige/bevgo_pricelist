export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, runTransaction, serverTimestamp } from "firebase/firestore";

const ok = (p = {}, s = 200) => NextResponse.json({ ok: true, data: p }, { status: s });
const err = (s, t, m, e = {}) => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

const now = () => new Date().toISOString();

export async function POST(req) {
  try {
    const { customerId, channel = "unknown" } = await req.json();
    if (!customerId) {
      return err(400, "Invalid Request", "customerId is required.");
    }

    const cartRef = doc(db, "carts", customerId);
    const txResult = await runTransaction(db, async (tx) => {
      const snap = await tx.get(cartRef);

      const emptyCart = {
        docId: customerId,
        cart: {
          cartId: customerId,
          customerId,
          channel
        },
        items: [],
        totals: {
          subtotal_excl: 0,
          sale_savings_excl: 0,
          deposit_total_excl: 0,
          vat_total: 0,
          final_excl: 0,
          final_incl: 0
        },
        item_count: 0,
        cart_corrected: false,
        meta: {
          lastAction: "clear",
          notes: null,
          source: channel
        },
        timestamps: {
          createdAt: now(),
          updatedAt: now()
        },
        warnings: { global: [], items: [] }
      };

      if (!snap.exists()) {
        tx.set(cartRef, emptyCart);
        return { cart: emptyCart, warnings: emptyCart.warnings };
      }

      const cart = snap.data();
      const items = Array.isArray(cart.items) ? cart.items : [];
      const warnings = { global: [], items: [] };

      // Collect all product snapshots first (reads before writes)
      const productCache = new Map();
      for (const it of items) {
        const pSnap = it?.product_snapshot;
        if (!pSnap) continue;
        const productId =
          String(pSnap.product?.unique_id || pSnap.docId || "") ||
          String(pSnap.product?.product_id || "");
        if (!productId || productCache.has(productId)) continue;
        const pref = doc(db, "products_v2", productId);
        const psnap = await tx.get(pref);
        productCache.set(productId, psnap.exists() ? { ref: pref, data: psnap.data() || {} } : null);
      }

      // Apply stock returns using cached products
      for (const it of items) {
        const vSnap = it?.selected_variant_snapshot;
        const pSnap = it?.product_snapshot;
        const qty = Number(it?.quantity) || 0;
        if (!vSnap || !pSnap || qty <= 0) continue;

        const productId =
          String(pSnap.product?.unique_id || pSnap.docId || "") ||
          String(pSnap.product?.product_id || "");
        const variantId = String(vSnap.variant_id || "");
        if (!productId || !variantId) continue;

        const cacheEntry = productCache.get(productId);
        if (!cacheEntry) {
          warnings.items.push({
            cart_item_key: it.cart_item_key || null,
            variant_id: variantId,
            message: "Product not found while clearing cart; stock not restored."
          });
          continue;
        }

        const pdata = cacheEntry.data;
        const variantsArr = Array.isArray(pdata.variants) ? pdata.variants : [];
        const vidx = variantsArr.findIndex((v) => String(v?.variant_id) === variantId);
        if (vidx === -1) {
          warnings.items.push({
            cart_item_key: it.cart_item_key || null,
            variant_id: variantId,
            message: "Variant not found while clearing cart; stock not restored."
          });
          continue;
        }

        const pv = { ...variantsArr[vidx] };

        // Restore sale stock if this line was a sale item and admin hasn't disabled sale
        if (vSnap.sale?.is_on_sale && pv.sale && !pv.sale.disabled_by_admin) {
          const startSale = Math.max(0, Number(pv.sale.qty_available) || 0);
          pv.sale.qty_available = startSale + qty;
          pv.sale.is_on_sale = true;
        }

        // Restore rental stock if limited
        if (vSnap.rental?.is_rental && vSnap.rental?.limited_stock && pv.rental?.is_rental && pv.rental?.limited_stock) {
          const startRent = Math.max(0, Number(pv.rental.qty_available) || 0);
          pv.rental.qty_available = startRent + qty;
        }

        variantsArr[vidx] = pv;
        cacheEntry.data.variants = variantsArr;
      }

      // Write updated products
      for (const [_, entry] of productCache.entries()) {
        if (!entry) continue;
        tx.update(entry.ref, {
          variants: entry.data.variants || [],
          "timestamps.updatedAt": serverTimestamp()
        });
      }

      tx.set(cartRef, emptyCart);
      return { cart: emptyCart, warnings };
    });

    return ok({
      cart: txResult.cart,
      warnings: txResult.warnings
    });
  } catch (e) {
    console.error("CLEAR CART ERROR:", e);
    return err(500, "Clear Cart Failed", "Unexpected server error.", {
      error: String(e)
    });
  }
}
