import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";


/**
 * getProductAndVariant()
 *
 * Retrieves:
 *  - full product doc
 *  - the live selected variant
 */
export async function getProductAndVariant({ productId, variantId }) {

  if (!productId) {
    throw new Error("getProductAndVariant: productId is required");
  }
  if (!variantId) {
    throw new Error("getProductAndVariant: variantId is required");
  }

  const productRef = doc(db, "products_v2", String(productId));
  const snap = await getDoc(productRef);
  if (!snap.exists()) {
    throw new Error(`Product ${productId} not found in Firestore`);
  }

  const data = snap.data();
  const variants = data?.variants || [];

  const liveVariant = variants.find(v =>
    String(v.variant_id) === String(variantId)
  );

  if (!liveVariant) {
    throw new Error(`Variant ${variantId} not found in product ${productId}`);
  }

  return {
    product: {
      docId: productId,
      grouping: data.grouping || {},
      product: data.product || {},
      placement: data.placement || {},
      variants_count: variants.length,
      variants: variants   // 👈 CRITICAL LINE
    },
    liveVariant
  };
  
}
