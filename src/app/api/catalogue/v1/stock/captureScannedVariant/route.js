import { NextResponse } from "next/server";

/* ---------- helpers ---------- */
const ok  = (p = {}, s = 200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e = {}) => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });
const toStr = (v, f = "") => (v == null ? f : String(v)).trim();

/* ---------- main route ---------- */
export async function POST(req) {
  try {
    const { current, scanned, received_qty } = await req.json();

    if (!scanned || typeof scanned !== "object")
      return err(400, "Invalid Input", "Provide a valid 'scanned' product object.");

    const productId = toStr(scanned?.product?.unique_id || scanned?.product_id);
    const variantId = toStr(scanned?.variants?.[0]?.variant_id);
    const qty = Number(received_qty) || 0;

    if (!productId || !variantId || qty <= 0)
      return err(400, "Missing Fields", "Provide valid product unique_id, variant_id, and received_qty > 0.");

    const currentArr = Array.isArray(current) ? [...current] : [];

    /* ---------- Find existing product ---------- */
    const productIndex = currentArr.findIndex(p => toStr(p?.product?.unique_id) === productId);

    // ✅ Case 1: Product not found — add entire product document
    if (productIndex < 0) {
      const newProduct = JSON.parse(JSON.stringify(scanned)); // deep clone to avoid mutation
      const scannedVariant = newProduct.variants?.[0];
      if (scannedVariant) scannedVariant.received_qty = qty;
      newProduct.variants = [scannedVariant];
      const updated = [...currentArr, newProduct];
      return ok({
        message: `New product '${newProduct?.product?.title || "Untitled"}' added with variant '${scannedVariant?.label || ""}'.`,
        data: { updated }
      });
    }

    /* ---------- Product exists ---------- */
    const existingProduct = { ...currentArr[productIndex] };
    const existingVariants = Array.isArray(existingProduct.variants)
      ? [...existingProduct.variants]
      : [];

    const existingVariantIndex = existingVariants.findIndex(
      v => toStr(v?.variant_id) === variantId
    );

    // ✅ Case 2: Variant not found — append full scanned variant object
    if (existingVariantIndex < 0) {
      const scannedVariant = JSON.parse(JSON.stringify(scanned.variants?.[0]));
      if (scannedVariant) scannedVariant.received_qty = qty;
      existingVariants.push(scannedVariant);
      existingProduct.variants = existingVariants;
      currentArr[productIndex] = existingProduct;
      return ok({
        message: `New variant '${scannedVariant?.label || ""}' added to product '${existingProduct?.product?.title || ""}'.`,
        data: { updated: currentArr }
      });
    }

    // ✅ Case 3: Variant exists — increment received quantity
    const existingVariant = { ...existingVariants[existingVariantIndex] };
    existingVariant.received_qty = Number(existingVariant.received_qty || 0) + qty;
    existingVariants[existingVariantIndex] = existingVariant;
    existingProduct.variants = existingVariants;
    currentArr[productIndex] = existingProduct;

    return ok({
      message: `Variant '${existingVariant?.label || ""}' updated — quantity increased by ${qty}.`,
      data: { updated: currentArr }
    });

  } catch (e) {
    console.error("mergeScannedVariant failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while merging scanned variant.");
  }
}
