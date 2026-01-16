const randomKey = (productId, variantId) => {
  const p = String(productId || "p").slice(-4);
  const v = String(variantId || "v").slice(-4);
  return `cki_${p}_${v}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
};

/* Reuse an existing key when possible, otherwise generate a new one (if allowed). */
export function ensureCartItemKey({ providedKey, items, productId, variantId, allowGenerate = true }) {
  const key = String(providedKey || "").trim();
  if (key) return key;

  const match = (Array.isArray(items) ? items : []).find((it) => {
    const vid = String(it?.selected_variant_snapshot?.variant_id || "");
    const pid =
      String(it?.product_snapshot?.product?.unique_id || "") ||
      String(it?.product_snapshot?.docId || "") ||
      String(it?.product_snapshot?.product?.product_id || "");

    return (
      (!!variantId && vid === String(variantId)) ||
      (!!productId && pid && pid === String(productId))
    );
  });

  if (match?.cart_item_key) return match.cart_item_key;

  return allowGenerate ? randomKey(productId, variantId) : null;
}
