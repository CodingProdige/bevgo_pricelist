import { NextResponse } from "next/server";

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

// --- Utility: Normalize for consistent comparison ---
const normalize = (v) => String(v ?? "").trim();

/**
 * Expected request body:
 * {
 *   "current": [ ...productObjectsInCaptureState ],
 *   "scanned": {
 *      "product_id": "14170475",
 *      "variant_id": "27261228",
 *      "product_title": "string",
 *      "label": "string"
 *   },
 *   "received_qty": 2
 * }
 */
export async function POST(req) {
  try {
    const { current = [], scanned, received_qty = 0 } = await req.json();

    if (!scanned || typeof scanned !== "object") {
      return err(400, "Invalid Payload", "Missing or invalid 'scanned' object.");
    }

    const scannedProductId = normalize(scanned.product_id);
    const scannedVariantId = normalize(scanned.variant_id);

    if (!scannedProductId || !scannedVariantId) {
      return err(400, "Missing Identifiers", "Both 'product_id' and 'variant_id' are required.");
    }

    // --- 1️⃣ Find if product already exists in current array ---
    const foundProduct = current.find(p => 
      normalize(p?.product?.unique_id) === scannedProductId
    );

    if (!foundProduct) {
      return ok({
        exists: false,
        message: "This product has not been added yet."
      });
    }

    // --- 2️⃣ Check if variant already exists inside that product ---
    const foundVariant = Array.isArray(foundProduct.variants)
      ? foundProduct.variants.find(v => normalize(v?.variant_id) === scannedVariantId)
      : null;

    if (foundVariant) {
      return ok({
        exists: true,
        message: `This variant has already been added. Continuing will increment the existing quantity by ${received_qty}.`
      });
    }

    // --- 3️⃣ Variant not yet added, product exists ---
    return ok({
      exists: false,
      message: "This variant has not been added yet (but product exists)."
    });

  } catch (e) {
    console.error("validateScannedVariant failed:", e);
    return err(500, "Unexpected Error", "Failed to validate scanned variant.", { error: e.message });
  }
}
