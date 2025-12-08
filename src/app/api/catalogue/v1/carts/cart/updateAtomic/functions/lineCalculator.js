const VAT_RATE = 0.15;
const r2 = (v) => Number((Number(v) || 0).toFixed(2));

/* Resolve the unit price using rental > sale > standard selling price */
export function resolveUnitPrice(variant) {
  if (variant?.rental?.is_rental) {
    return r2(variant?.rental?.rental_price_excl || 0);
  }
  if (variant?.sale?.is_on_sale) {
    return r2(variant?.sale?.sale_price_excl || 0);
  }
  return r2(variant?.pricing?.selling_price_excl || 0);
}

export function computeLineTotals(variant, qty) {
  const quantity = Math.max(0, Number(qty) || 0);
  const unit = resolveUnitPrice(variant);
  const line_subtotal_excl = r2(unit * quantity);
  const item_vat = r2(line_subtotal_excl * VAT_RATE);

  const returnable_unit = r2(variant?.returnable?.pricing?.full_returnable_price_excl || 0);
  const returnable_excl = r2(returnable_unit * quantity);
  const returnable_vat = r2(returnable_excl * VAT_RATE);

  const total_vat = r2(item_vat + returnable_vat);
  const final_excl = r2(line_subtotal_excl + returnable_excl);
  const final_incl = r2(final_excl + total_vat);

  return {
    unit_price_excl: unit,
    line_subtotal_excl,
    returnable_excl,
    returnable_vat,
    item_vat,
    total_vat,
    final_excl,
    final_incl
  };
}

export function computeCartTotals(items) {
  let subtotal = 0;
  let deposit = 0;
  let vat_total = 0;
  let sale_savings_excl = 0;

  for (const it of Array.isArray(items) ? items : []) {
    const qty = Number(it?.quantity) || 0;
    const variant = it?.selected_variant_snapshot || null;
    const lt = it?.line_totals || computeLineTotals(variant, qty);

    subtotal += lt?.line_subtotal_excl || 0;
    deposit += lt?.returnable_excl || 0;
    vat_total += lt?.total_vat || 0;

    const normal = Number(variant?.pricing?.selling_price_excl) || 0;
    const sale = Number(variant?.sale?.sale_price_excl) || 0;
    if (variant?.sale?.is_on_sale && normal > sale) {
      sale_savings_excl += (normal - sale) * qty;
    }
  }

  const final_excl = r2(subtotal + deposit);

  return {
    subtotal_excl: r2(subtotal),
    sale_savings_excl: r2(sale_savings_excl),
    deposit_total_excl: r2(deposit),
    vat_total: r2(vat_total),
    final_excl,
    final_incl: r2(final_excl + vat_total)
  };
}

export { VAT_RATE };
