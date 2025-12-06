import { doc } from "firebase/firestore";
import { db } from "@/lib/firebase";

/**
 * updateStockLevels()
 * Live sale stock decrement after adding to cart.
 */
export function updateStockLevels({
  product,
  liveVariant,
  desiredDelta,
  variantId,
  batch
}) {
  if (!desiredDelta) return;
  
  const productRef = doc(db, "products_v2", String(product.docId));
  
  const variants = [...(product.variants || [])];
  const idx = variants.findIndex(v =>
    String(v.variant_id) === String(variantId)
  );
  
  if (idx < 0) return; // Safety
  
  const updatedVariant = structuredClone(liveVariant);

  // Decrement ONLY sale qty if sale was applied
  if (liveVariant.sale?.is_on_sale) {
    updatedVariant.sale.qty_available =
      (liveVariant.sale.qty_available ?? 0) - desiredDelta;
    if (updatedVariant.sale.qty_available < 0)
      updatedVariant.sale.qty_available = 0; // Safety clamp
  }

  // Replace back into full list
  variants[idx] = updatedVariant;

  // Commit update to Firestore
  batch.update(productRef, {
    variants
  });
}
