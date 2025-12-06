import { calcLineTotals } from "../logic/calcLineTotals";


/**
 * applyCartMutation()
 *
 * This works purely in-memory on the JS cart data.
 * It never writes to Firestore directly.
 *
 * @param {{
 *  items: array,
 *  productSnapshot: object,
 *  variantSnapshot: object,
 *  mode: "add"|"increment"|"decrement"|"set"|"remove",
 *  quantity: number,
 *  cart_item_key?: string
 * }} param0
 */
export function applyCartMutation({
  items,
  productSnapshot,
  variantSnapshot,
  mode,
  quantity,
  cart_item_key
}) {
  let newItems = [...items];
  let newQty = Number(quantity || 0);

  // Key for identifying cart row
  let key = cart_item_key || null;

  /** ========================================
   * CASE 1 — UPDATE EXISTING
   * ======================================== **/
  if (key) {
    const idx = newItems.findIndex(i => i.cart_item_key === key);
    if (idx >= 0) {
      const existing = newItems[idx];
      let finalQty = existing.quantity;

      if (mode === "increment") finalQty = existing.quantity + newQty;
      if (mode === "decrement") finalQty = existing.quantity - newQty;
      if (mode === "set") finalQty = newQty;
      if (mode === "remove") finalQty = 0;

      // Remove from cart if now =0
      if (finalQty <= 0) {
        newItems = newItems.filter(i => i.cart_item_key !== key);
      } else {
        newItems[idx] = {
          ...existing,
          quantity: finalQty,
          product_snapshot: productSnapshot,
          selected_variant_snapshot: variantSnapshot,
          line_totals: calcLineTotals(finalQty, variantSnapshot)
        };
      }

      return newItems;
    }
  }

  /** ========================================
   * CASE 2 — ADD NEW CART ROW
   * ======================================== **/
  if (mode === "add" || !key) {
    const newKey = crypto.randomUUID();
    newItems.push({
      cart_item_key: newKey,
      quantity: newQty,
      product_snapshot: productSnapshot,
      selected_variant_snapshot: variantSnapshot,
      line_totals: calcLineTotals(newQty, variantSnapshot)
    });

    return newItems;
  }

  /** Should never hit here */
  return newItems;
}
