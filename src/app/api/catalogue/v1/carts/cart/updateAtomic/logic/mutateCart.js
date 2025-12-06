import { calcLineTotals } from "./calcLineTotals";


/**
 * mutateCart()
 *
 * Applies the validated mutation intent:
 *  - add delta units (sale/rental/normal)
 *  - modify existing or create new item
 *  - applies correct pricing state (sale/rental/normal)
 *
 * Returns: { updatedItems }
 */
export function mutateCart({
  existingItems,
  liveVariant,
  decision,
  desiredDelta
}) {

  let updated = [...(existingItems || [])];
  desiredDelta = Number(desiredDelta || 0);

  // Find if cart already has this variant
  const idx = updated.findIndex(
    i => String(i.selected_variant_snapshot?.variant_id) === String(liveVariant.variant_id)
  );

  const existingItem = idx >= 0 ? updated[idx] : null;

  // Decide which pricing to apply ======================
  let resolvedVariant = structuredClone(liveVariant);

  if (decision.resolution === "sale") {
    resolvedVariant.sale.is_on_sale = true;
  } else {
    resolvedVariant.sale.is_on_sale = false;
  }

  if (decision.resolution === "rent") {
    resolvedVariant.rental.is_rental = true;
  } else {
    resolvedVariant.rental.is_rental = false;
  }

  /* =====================================================
     CASE — NEW LINE ITEM
  ======================================================*/
  if (!existingItem) {

    const newItem = {
      cart_item_key: crypto.randomUUID(),
      quantity: desiredDelta,
      product_snapshot: null,               // route.js injects later
      selected_variant_snapshot: resolvedVariant,
      line_totals: calcLineTotals({
        variant: resolvedVariant,
        quantity: desiredDelta
      })
    };

    updated.push(newItem);
    return { updatedItems: updated };
  }

  /* =====================================================
     CASE — UPDATE EXISTING ITEM
  ======================================================*/
  const newQty = Number(existingItem.quantity + desiredDelta);

  // If user deletes down to zero, remove line
  if (newQty <= 0) {
    updated.splice(idx, 1);
    return { updatedItems: updated };
  }

  // Update line ==============================
  updated[idx] = {
    ...existingItem,
    quantity: newQty,
    selected_variant_snapshot: resolvedVariant,
    line_totals: calcLineTotals({
      variant: resolvedVariant,
      quantity: newQty
    })
  };

  return { updatedItems: updated };
}
