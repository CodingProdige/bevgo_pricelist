import { NextResponse } from "next/server";

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

// --- Normalizer for reliable comparisons ---
const normalize = (v) => String(v ?? "").trim();

/**
 * Expected body:
 * {
 *   "current": [ ...currentCaptureList ],
 *   "product_id": "14170475",
 *   "variant_id": "27261228"
 * }
 */
export async function POST(req) {
  try {
    const { current = [], product_id, variant_id } = await req.json();

    if (!Array.isArray(current)) {
      return err(400, "Invalid Payload", "'current' must be an array.");
    }

    const pid = normalize(product_id);
    const vid = normalize(variant_id);

    if (!pid || !vid) {
      return err(400, "Missing Fields", "Both 'product_id' and 'variant_id' are required.");
    }

    // 1️⃣ Find the product by product.product.unique_id
    const foundProductIndex = current.findIndex(p =>
      normalize(p?.product?.unique_id) === pid
    );

    if (foundProductIndex === -1) {
      return err(404, "Product Not Found", `No product found with ID '${pid}'.`);
    }

    const foundProduct = current[foundProductIndex];

    // 2️⃣ Find variant inside that product
    const foundVariantIndex = foundProduct?.variants?.findIndex(v =>
      normalize(v?.variant_id) === vid
    );

    if (foundVariantIndex === -1) {
      return err(404, "Variant Not Found", `No variant found with ID '${vid}' in product '${pid}'.`);
    }

    // 3️⃣ Remove that variant from product.variants
    const updatedVariants = foundProduct.variants.filter(
      v => normalize(v.variant_id) !== vid
    );

    // 4️⃣ Update the product
    const updatedProduct = { ...foundProduct, variants: updatedVariants };

    // 5️⃣ If product now has no variants, remove the product entirely
    const updatedList = updatedVariants.length > 0
      ? [
          ...current.slice(0, foundProductIndex),
          updatedProduct,
          ...current.slice(foundProductIndex + 1)
        ]
      : current.filter((_, i) => i !== foundProductIndex);

    // ✅ 6️⃣ Return updated array
    return ok({
      message: updatedVariants.length > 0
        ? `Variant '${vid}' removed from product '${pid}'.`
        : `Product '${pid}' removed since it no longer has variants.`,
      data: updatedList
    });

  } catch (e) {
    console.error("removeCapturedVariant failed:", e);
    return err(500, "Unexpected Error", "Failed to remove variant.", { error: e.message });
  }
}
