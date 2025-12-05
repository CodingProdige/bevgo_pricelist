export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, setDoc } from "firebase/firestore";

/* ------------------ HELPERS ------------------- */

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, data:p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false,title:t,message:m,...e },{ status:s });

const now = () => new Date().toISOString();
const VAT = 0.15;
const r2 = (v) => Number((+v).toFixed(2));

function computeLineTotals(v, qty){
  qty = Number(qty);

  let price;
  if (v?.rental?.is_rental){
    price = r2(v.rental.rental_price_excl || 0);
  } else if (v?.sale?.is_on_sale){
    price = r2(v.sale.sale_price_excl || 0);
  } else {
    price = r2(v.pricing?.selling_price_excl || 0);
  }

  const base = price * qty;
  const baseVat = base * VAT;

  const returnablePrice = r2(v?.returnable?.pricing?.full_returnable_price_excl || 0);
  const rtn = r2(returnablePrice * qty);
  const rtnVat = r2(rtn * VAT);

  return {
    unit_price_excl: price,
    line_subtotal_excl: r2(base),
    returnable_excl: r2(rtn),
    total_vat: r2(baseVat + rtnVat),
    final_excl: r2(base + rtn),
    final_incl: r2(base + rtn + baseVat + rtnVat)
  };
}

function computeCartTotals(items){
  let subtotal = 0;
  let deposit  = 0;
  let savings  = 0;
  let vat_total = 0;

  for (const it of items){
    const v = it.selected_variant_snapshot;
    const qty = it.quantity;
    const lt = computeLineTotals(v, qty);

    subtotal += lt.line_subtotal_excl;
    deposit  += lt.returnable_excl;
    vat_total+= lt.total_vat;

    if (v?.sale?.is_on_sale){
      const normal = r2(v?.pricing?.selling_price_excl || 0);
      const sale   = r2(v?.sale?.sale_price_excl || 0);
      if (normal > sale){
        savings += (normal - sale) * qty;
      }
    }
  }

  const final_excl = subtotal + deposit;
  const final_incl = final_excl + vat_total;

  return {
    subtotal_excl: r2(subtotal),
    deposit_total_excl: r2(deposit),
    sale_savings_excl: r2(savings),
    vat_total: r2(vat_total),
    final_excl: r2(final_excl),
    final_incl: r2(final_incl)
  };
}

/* ------------------ MAIN ENDPOINT ------------------- */

export async function POST(req){
  try {
    const { customerId } = await req.json();
    if (!customerId)
      return err(400,"Invalid Request","customerId is required.");

    const cartRef = doc(db,"carts", customerId);
    const cartSnap = await getDoc(cartRef);

    /* ---------------- EMPTY CART ---------------- */
    if (!cartSnap.exists()){
      const emptyCart = {
        docId: customerId,
        items: [],
        totals: computeCartTotals([]),
        timestamps: { createdAt: now(), updatedAt: now() },
        cart_corrected: false,
        item_count: 0,
      };

      await setDoc(cartRef, emptyCart);

      return ok({
        cart: emptyCart,
        warnings: { global: [], items: [] }
      });
    }

    /* ---------------- EXISTING CART ---------------- */
    const cart = cartSnap.data();
    let items = Array.isArray(cart.items) ? cart.items : [];

    /* 🔥 LIVE HYDRATION FOR EACH ITEM 🔥 */
    for (const it of items){
      const vSnap = it.selected_variant_snapshot;
      const prodSnap = it.product_snapshot;

      const productRef = doc(db,"products_v2", prodSnap.product.unique_id);
      const dbProd = await getDoc(productRef);
      if(!dbProd.exists()) continue;

      const liveProd = dbProd.data();
      const liveVar = liveProd.variants.find(v =>
        String(v.variant_id) === String(vSnap.variant_id)
      );
      if(!liveVar) continue;

      // Update live snapshot values
      it.selected_variant_snapshot.sale = {
        ...vSnap.sale,
        qty_available: liveVar.sale?.qty_available ?? 0,
        is_on_sale:    liveVar.sale?.is_on_sale ?? false
      };
      it.selected_variant_snapshot.rental = {
        ...vSnap.rental,
        qty_available: liveVar.rental?.qty_available ?? 0,
        is_rental: liveVar.rental?.is_rental ?? false
      };

      // Recalculate line totals using updated values
      it.line_totals = computeLineTotals(
        it.selected_variant_snapshot,
        it.quantity
      );
    }

    /* ---------------- RECOMPUTE CART TOTALS ---------------- */
    const recalculatedTotals = computeCartTotals(items);

    const resultCart = {
      ...cart,
      items,
      totals: recalculatedTotals,
      item_count: items.reduce((a,it)=>a+(it.quantity||0),0),
      cart_corrected: false,
      timestamps: {
        ...cart.timestamps,
        updatedAt: now(),
      }
    };

    await setDoc(cartRef, resultCart);

    return ok({
      cart: resultCart,
      warnings: {
        global: [],
        items: []
      }
    });

  } catch (e){
    console.error("FETCH CART ERROR:", e);
    return err(500,"Fetch Cart Failed","Unexpected server error.",{
      error: String(e)
    });
  }
}
