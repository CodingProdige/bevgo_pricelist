/**
 * calcCartTotals()
 *
 * Runs AFTER mutateCart() has updated line_totals
 * Produces final totals structure:
 *   - subtotal_excl
 *   - sale_savings_excl
 *   - deposit_total_excl
 *   - vat_total
 *   - final_excl
 *   - final_incl
 */

export function calcCartTotals(updatedItems = []) {

    let subtotal_excl = 0;
    let sale_savings_excl = 0;
    let deposit_total_excl = 0;
    let vat_total = 0;
  
    for (const item of updatedItems) {
      const lt = item.line_totals || {};
  
      subtotal_excl += Number(lt.line_subtotal_excl || 0);
      sale_savings_excl += Number(lt.sale_savings_excl || 0);
      deposit_total_excl += Number(lt.returnable_excl || 0);
      vat_total += Number(lt.total_vat || 0);
    }
  
    const final_excl = subtotal_excl + deposit_total_excl;
    const final_incl = final_excl + vat_total;
  
    return {
      subtotal_excl: Number(subtotal_excl.toFixed(2)),
      sale_savings_excl: Number(sale_savings_excl.toFixed(2)),
      deposit_total_excl: Number(deposit_total_excl.toFixed(2)),
      vat_total: Number(vat_total.toFixed(2)),
      final_excl: Number(final_excl.toFixed(2)),
      final_incl: Number(final_incl.toFixed(2)),
    };
  }
  