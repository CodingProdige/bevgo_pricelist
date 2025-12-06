/**
 * calcLineTotals()
 *
 * Given variant + quantity, produce detailed pricing.
 * Never returns null fields.
 */

export function calcLineTotals({ variant, quantity }) {
    quantity = Number(quantity || 0);
  
    const saleActive = variant?.sale?.is_on_sale === true;
    const salePrice = Number(variant?.sale?.sale_price_excl || 0);
    const normalPrice = Number(variant?.pricing?.selling_price_excl || 0);
  
    // Unit price applied
    const unit_price_excl = saleActive ? salePrice : normalPrice;
  
    // Line subtotal (excluding returnable)
    const line_subtotal_excl = unit_price_excl * quantity;
  
    // Returnable cost
    const returnablePrice = Number(variant?.returnable?.data?.pricing?.full_returnable_price_excl || 0);
    const returnable_excl = returnablePrice * quantity;
  
    // VAT
    const subtotalVat = line_subtotal_excl * 0.15;
    const returnableVat = returnable_excl * 0.15;
    const total_vat = subtotalVat + returnableVat;
  
    // Sale savings
    const sale_savings_excl = saleActive
      ? (normalPrice - salePrice) * quantity
      : 0;
  
    // Totals
    const final_excl = line_subtotal_excl + returnable_excl;
    const final_incl = final_excl + total_vat;
  
    return {
      unit_price_excl: Number(unit_price_excl.toFixed(2)),
      line_subtotal_excl: Number(line_subtotal_excl.toFixed(2)),
      returnable_excl: Number(returnable_excl.toFixed(2)),
      returnable_vat: Number(returnableVat.toFixed(2)),
      item_vat: Number(subtotalVat.toFixed(2)),
      total_vat: Number(total_vat.toFixed(2)),
      final_excl: Number(final_excl.toFixed(2)),
      final_incl: Number(final_incl.toFixed(2)),
      sale_savings_excl: Number(sale_savings_excl.toFixed(2))
    };
  }
  