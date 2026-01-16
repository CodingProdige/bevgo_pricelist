const toNum = (v) => (Number.isFinite(+v) ? +v : 0);

/* Cap requested quantity based on available stock signals */
export function capQuantity(variant, desiredQty, { ignoreSale = false, supplierOOS = false } = {}) {
  const requested = Math.max(0, Number(desiredQty) || 0);

  let available = null;
  let reason = null;

  const saleActive = variant?.sale?.is_on_sale && !ignoreSale;
  const saleDisabled = Boolean(variant?.sale?.disabled_by_admin);

  // Hard block if supplier is out of stock for any increase
  if (supplierOOS && requested > 0) {
    return { quantity: 0, capped: true, available: 0, reason: "supplier_out_of_stock" };
  }

  if (variant?.rental?.is_rental && variant?.rental?.limited_stock) {
    available = Math.max(0, toNum(variant?.rental?.qty_available));
    reason = "rental stock";
  } else if (saleActive) {
    const saleQty = Math.max(0, toNum(variant?.sale?.qty_available));
    available = saleQty;
    reason = "sale stock";

    // If admin disabled, don't cap; treat like regular item.
    if (saleDisabled) {
      available = null;
      reason = null;
    }
  } else if (Array.isArray(variant?.inventory) && variant.inventory.length) {
    available = variant.inventory.reduce((sum, row) => sum + (Number(row?.in_stock_qty) || 0), 0);
    reason = "inventory";
  }

  if (available === null || available === undefined) {
    return { quantity: requested, capped: false, available: null, reason: null };
  }

  const quantity = Math.min(requested, available);
  return {
    quantity,
    capped: quantity !== requested,
    available,
    reason
  };
}
