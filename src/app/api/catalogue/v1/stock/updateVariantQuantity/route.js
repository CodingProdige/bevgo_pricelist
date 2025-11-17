import { NextResponse } from "next/server";

const ok  = (p = {}, s = 200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e = {}) => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });
const toStr = (v, f = "") => (v == null ? f : String(v)).trim();

/**
 * Expected body:
 * {
 *   "current": [ ... ],
 *   "product_id": "14170475",
 *   "variant_id": "27261228",
 *   "new_qty": 0
 * }
 */
export async function POST(req) {
  try {
    const { current, product_id, variant_id, new_qty } = await req.json();

    // --- Basic validation ---
    if (!Array.isArray(current))
      return err(400, "Invalid Data", "'current' must be an array.");

    const pid = toStr(product_id);
    const vid = toStr(variant_id);
    const qty = Number(new_qty);

    if (!pid) return err(400, "Missing Field", "'product_id' is required.");
    if (!vid) return err(400, "Missing Field", "'variant_id' is required.");
    if (!Number.isFinite(qty) || qty < 0)
      return err(400, "Invalid Quantity", "'new_qty' must be a number ≥ 0.");

    let updated = [...current];

    // --- Find product by canonical field (product.unique_id) ---
    const productIndex = updated.findIndex(
      p => toStr(p?.product?.unique_id) === pid
    );
    if (productIndex < 0)
      return err(404, "Product Not Found", `No product found with ID '${pid}'.`);

    const product = { ...updated[productIndex] };
    const variants = Array.isArray(product.variants) ? [...product.variants] : [];

    // --- Find variant ---
    const variantIndex = variants.findIndex(
      v => toStr(v?.variant_id) === vid
    );
    if (variantIndex < 0)
      return err(404, "Variant Not Found", `No variant found with ID '${vid}'.`);

    // --- If new_qty is 0, remove the variant ---
    if (qty === 0) {
      const remainingVariants = variants.filter(v => toStr(v.variant_id) !== vid);

      if (remainingVariants.length === 0) {
        // Remove entire product if no variants left
        updated = updated.filter((_, i) => i !== productIndex);
        return ok({
          message: `Variant '${vid}' removed and product '${pid}' deleted since no variants remain.`,
          data: { updated }
        });
      } else {
        product.variants = remainingVariants;
        updated[productIndex] = product;
        return ok({
          message: `Variant '${vid}' removed from product '${pid}'.`,
          data: { updated }
        });
      }
    }

    // --- Otherwise, update received_qty ---
    const targetVariant = { ...variants[variantIndex], received_qty: qty };
    variants[variantIndex] = targetVariant;
    product.variants = variants;
    updated[productIndex] = product;

    return ok({
      message: `Quantity for variant '${targetVariant?.label || vid}' successfully updated to ${qty}.`,
      data: { updated }
    });

  } catch (e) {
    console.error("updateVariantQuantity failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while updating variant quantity.", { error: e.message });
  }
}
