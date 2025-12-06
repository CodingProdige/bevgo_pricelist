export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { doc, getDoc, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";

// ---------- LOGIC HELPERS ----------
import { getProductAndVariant } from "./logic/getProduct";
import { validateDesiredQuantity } from "./logic/validateDesiredQuantity";
import { mutateCart } from "./logic/mutateCart";
import { calcCartTotals } from "./logic/calcCartTotals";
import { decisionMessage } from "./logic/decisionMessage";
import { updateStockLevels } from "./logic/updateStockLevels";
import { applyCartMutation } from "./mutation/applyCartMutation";


/* ================================================================
   POST: Atomic mutation entrypoint
================================================================ */
export async function POST(req) {
  try {
    const body = await req.json();

    const {
      customerId,
      mode,
      quantity,
      productId,
      variantId,
      channel
    } = body;

    if (!customerId) return fail(400, "Missing", "customerId required");
    if (!mode) return fail(400, "Missing", "mode required");
    if (!quantity) return fail(400, "Missing", "quantity required");
    if (!productId) return fail(400, "Missing", "productId required");
    if (!variantId) return fail(400, "Missing", "variantId required");

    // ====================================================
    // 1) Fetch fresh product + variant snapshot (live)
    // ====================================================
    const { product, liveVariant } = await getProductAndVariant({
      productId,
      variantId
    });

    if (!product || !liveVariant) {
      return fail(404, "Not Found", `Live variant ${variantId} not found`);
    }

    // ====================================================
    // 2) Fetch existing cart
    // ====================================================
    const cartRef = doc(db, "carts", customerId);
    const cartSnap = await getDoc(cartRef);
    let cart = cartSnap.exists()
      ? cartSnap.data()
      : {
          docId: customerId,
          cart: { cartId: customerId, customerId, channel },
          items: [],
          totals: {},
          meta: { notes: null, lastAction: "", source: "api" },
          timestamps: {
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        };

    // ====================================================
    // 3) DETERMINE DESIRED DELTA
    // (How many units would be added)
    // ====================================================
    let desiredDelta = quantity;
    if (mode !== "add") {
      // in future: increment, decrement etc.
      // (not implemented yet, we handle only ADD right now)
      desiredDelta = quantity;
    }
    if (mode === "decrement") {
      desiredDelta = -Math.abs(quantity);
    }

    // ====================================================
    // 4) VALIDATE AGAINST LIVE STOCK
    // ====================================================
    const validation = validateDesiredQuantity({
      liveState: {
        sale: liveVariant.sale || {},
        rental: liveVariant.rental || {}
      },
      snapshotVariant: liveVariant, // FE may pass snapshot later
      desiredDelta
    });

    // ====================================================
    // 5) Build UI feedback for the client
    // ====================================================
    const ui = decisionMessage({
      allowed: validation.allowed,
      resolution: validation.resolution,
      reason: validation.reason,
      suggested_quantity: validation.suggested_quantity,
      desiredDelta
    });


    

    // If declined (blocked)
    if (!validation.allowed) {
      return ok({
        phase: "validation",
        blocked: true,
        validation,
        ui
      });
    }

    // ====================================================
    // 6) Mutate cart items in memory (no DB yet)
    // ====================================================
    const mutated = mutateCart({
      existingItems: cart.items,
      liveVariant,
      decision: validation,
      desiredDelta
    });
    
    
    

    // ====================================================
    // 7) Compute new totals
    // ====================================================
    cart.items = mutated.updatedItems;
    cart.totals = calcCartTotals(cart.items);
    cart.meta.lastAction = mode;
    cart.timestamps.updatedAt = new Date().toISOString();

    // ====================================================
    // 8) Batch mutation: cart + product stock
    // ====================================================
    const batch = writeBatch(db);
    updateStockLevels({
      liveVariant,
      desiredDelta: validation.suggested_quantity ?? desiredDelta,
      product,
      variantId,
      batch,
      decision: validation
    });
    

    // Save cart
    batch.set(cartRef, cart, { merge: true });
    console.log("cartRef:", cartRef._key?.path || cartRef);
console.log("productId:", productId);
console.log("variantId:", variantId);
console.log("liveVariant:", liveVariant);

    await batch.commit();

    // ====================================================
    // 9) Return final result
    // ====================================================
    console.log("🧨 UI Selected:", ui);

    return ok({
      phase: "mutated",
      blocked: false,
      cart,
      ui
    });
  } catch (error) {
    console.error("ATOMIC UPDATE ERROR:", error);
    return fail(500, "Atomic Update Failed", error.message);
  }
}


/* ================================================================
   RESPONSE HELPERS
================================================================ */
function ok(payload = {}, status = 200) {
  return NextResponse.json({ ok: true, ...payload }, { status });
}

function fail(status, title, message, extra = {}) {
  return NextResponse.json(
    { ok: false, title, message, ...extra },
    { status }
  );
}
