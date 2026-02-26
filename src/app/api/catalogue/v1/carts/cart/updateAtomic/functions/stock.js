const toNum = (v) => (Number.isFinite(+v) ? +v : 0);
const sumInventory = (variant) =>
  Array.isArray(variant?.inventory)
    ? variant.inventory.reduce((sum, row) => sum + Math.max(0, Number(row?.in_stock_qty) || 0), 0)
    : 0;

/* Cap requested quantity based on available stock signals */
export function capQuantity(variant, desiredQty, { currentQty = 0, ignoreSale = false, supplierOOS = false } = {}) {
  const requested = Math.max(0, Number(desiredQty) || 0);
  const current = Math.max(0, Number(currentQty) || 0);
  const requestedIncrease = Math.max(0, requested - current);
  const continueSellingOOS = Boolean(variant?.placement?.continue_selling_out_of_stock);
  const limitedRental = Boolean(variant?.rental?.is_rental && variant?.rental?.limited_stock);

  let available = null;
  let reason = null;

  const saleActive = variant?.sale?.is_on_sale && !ignoreSale;
  const saleDisabled = Boolean(variant?.sale?.disabled_by_admin);

  // Hard block if supplier is out of stock for any increase
  if (supplierOOS && requestedIncrease > 0) {
    return { quantity: current, capped: requested !== current, available: current, reason: "supplier_out_of_stock" };
  }

  // When enabled, allow overselling even if inventory/sale availability is zero.
  // Keep limited rental stock rules intact.
  if (continueSellingOOS && !limitedRental) {
    return { quantity: requested, capped: false, available: null, reason: null };
  }

  if (limitedRental) {
    available = Math.max(0, toNum(variant?.rental?.qty_available));
    reason = "rental stock";
  } else if (saleActive) {
    const saleQty = Math.max(0, toNum(variant?.sale?.qty_available));
    const invQty = sumInventory(variant);
    available = saleQty + invQty;
    reason = invQty > 0 ? "sale + inventory stock" : "sale stock";

    // If admin disabled, don't cap; treat like regular item.
    if (saleDisabled) {
      available = null;
      reason = null;
    }
  } else if (Array.isArray(variant?.inventory) && variant.inventory.length) {
    available = sumInventory(variant);
    reason = "inventory";
  } else if (!continueSellingOOS) {
    available = 0;
    reason = "stock";
  }

  if (requested <= current) {
    return { quantity: requested, capped: false, available: null, reason: null };
  }

  if (available === null || available === undefined) {
    return { quantity: requested, capped: false, available: null, reason: null };
  }

  const increase = Math.min(requestedIncrease, available);
  const quantity = current + increase;
  const maxPossible = current + available;
  return {
    quantity,
    capped: quantity !== requested,
    available: maxPossible,
    reason
  };
}
