export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, setDoc } from "firebase/firestore";

/* ------------------ HELPERS ------------------- */

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, data:p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false,title:t,message:m,...e },{ status:s });

const now = () => new Date().toISOString();
const VAT = 0.15;
const r2 = v => Number((+v).toFixed(2));

function computeLineTotals(v, qty){
  qty = Number(qty);

  let price;
  if (v?.rental?.is_rental){
    price = r2(v.rental.rental_price_excl || 0);
  }
  else if (v?.sale?.is_on_sale){
    price = r2(v.sale.sale_price_excl || 0);
  }
  else {
    price = r2(v.pricing?.selling_price_excl || 0);
  }

  const base = r2(price * qty);
  const baseVat = r2(base * VAT);

  const rtnUnit = r2(
    v?.returnable?.pricing?.full_returnable_price_excl ??
    v?.returnable?.data?.pricing?.full_returnable_price_excl ??
    0
  );
  const rtn = r2(rtnUnit * qty);
  const rtnVat = r2(rtn * VAT);

  return {
    unit_price_excl: price,
    line_subtotal_excl: base,
    returnable_excl: rtn,
    total_vat: r2(baseVat + rtnVat),
    final_excl: r2(base + rtn),
    final_incl: r2(base + rtn + baseVat + rtnVat),
    sale_savings_excl: 0
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

    // track possible sale saving
    if (v?.sale?.is_on_sale){
      const normal = r2(v?.pricing?.selling_price_excl || 0);
      const sale   = r2(v?.sale?.sale_price_excl || 0);
      if (normal > sale){
        savings += (normal - sale) * qty;
      }
    }
  }

  const final_excl = r2(subtotal + deposit);
  const final_incl = r2(final_excl + vat_total);

  return {
    subtotal_excl: r2(subtotal),
    deposit_total_excl: r2(deposit),
    sale_savings_excl: r2(savings),
    vat_total,
    final_excl,
    final_incl
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

    /* ------------------------------------------
       🎯 CART DOES NOT EXIST → NEW EMPTY
    ------------------------------------------- */
    if (!cartSnap.exists()){
      const emptyCart = {
        docId: customerId,
        cart: {
          cartId: customerId,
          customerId,
          channel: "unknown"
        },
        items: [],
        totals: computeCartTotals([]),
        item_count: 0,
        cart_corrected: false,
        meta: {
          lastAction: "",
          notes: null,
          source: "api"
        },
        timestamps: {
          createdAt: now(),
          updatedAt: now()
        }
      };

      await setDoc(cartRef, emptyCart);

      return ok({
        cart: emptyCart,
        warnings: { global: [], items: [] }
      });
    }

    /* ------------------------------------------
       🎯 CART EXISTS
    ------------------------------------------- */
    const cart = cartSnap.data();
    const items = Array.isArray(cart.items) ? cart.items : [];

    // Track warnings and removals
    const warnings = { global: [], items: [] };
    const productCache = new Map();
    const kept = [];

    /* ------------------------------------------
       🔥 VALIDATE AGAINST ADMIN DISABLED SALES
       (preserve stored snapshots otherwise)
    ------------------------------------------- */
    for (const it of items){
      const vSnap = it?.selected_variant_snapshot;
      const pSnap = it?.product_snapshot;
      if (!vSnap || !pSnap) {
        kept.push(it);
        continue;
      }

      const productId = pSnap.product?.unique_id;
      if (!productId) {
        kept.push(it);
        continue;
      }

      let liveProd = productCache.get(productId);
      if (!liveProd) {
        const productRef = doc(db,"products_v2", String(productId));
        const prodSnap = await getDoc(productRef);
        liveProd = prodSnap.exists() ? prodSnap.data() : null;
        productCache.set(productId, liveProd);
      }
      if (!liveProd) {
        kept.push(it);
        continue;
      }

      const liveVar = (Array.isArray(liveProd.variants) ? liveProd.variants : []).find(v =>
        String(v?.variant_id) === String(vSnap.variant_id)
      );

      // If sale disabled by admin and item was on sale in cart, drop it with warning
      if (liveVar?.sale?.disabled_by_admin && vSnap?.sale?.is_on_sale){
        warnings.items.push({
          cart_item_key: it.cart_item_key || null,
          variant_id: vSnap.variant_id || null,
          message: "Removed sale item; sale has ended (disabled by admin)."
        });
        continue;
      }

      const clean = { ...it };

      // If item was on sale in cart, preserve its snapshot/pricing
      if (vSnap?.sale?.is_on_sale) {
        clean.line_totals = computeLineTotals(clean.selected_variant_snapshot, clean.quantity);
        kept.push(clean);
        continue;
      }

      // For non-sale items, refresh variant pricing/sale/rental from live data to avoid hoarding stale prices
      if (liveVar) {
        const mergedVariant = {
          ...vSnap,
          ...liveVar,
          pricing: liveVar.pricing ?? vSnap.pricing,
          sale: {
            ...(vSnap.sale || {}),
            ...(liveVar.sale || {}),
            is_on_sale: false
          },
          rental: liveVar.rental ?? vSnap.rental,
          returnable: liveVar.returnable ?? vSnap.returnable,
          pack: liveVar.pack ?? vSnap.pack
        };

        // Detect price change
        const prevPrice = Number(vSnap?.pricing?.selling_price_excl) || 0;
        const newPrice = Number(mergedVariant?.pricing?.selling_price_excl) || 0;
        if (newPrice !== prevPrice) {
          warnings.items.push({
            cart_item_key: it.cart_item_key || null,
            variant_id: vSnap.variant_id || null,
            message: `Price updated from ${prevPrice} to ${newPrice}.`
          });
        }

        clean.selected_variant_snapshot = mergedVariant;
        clean.line_totals = computeLineTotals(mergedVariant, clean.quantity);
        kept.push(clean);
        continue;
      }

      // Fallback: keep as-is
      clean.line_totals = computeLineTotals(clean.selected_variant_snapshot, clean.quantity);
      kept.push(clean);
    }

    /* ------------------------------------------
       🔄 RECOMPUTE CART TOTALS
    ------------------------------------------- */
    const totals = computeCartTotals(kept);

    const finalCart = {
      ...cart,
      items: kept,
      totals,
      item_count: kept.reduce((a,it)=>a+(Number(it.quantity)||0),0),
      cart_corrected: warnings.items.length>0,
      warnings,
      timestamps: {
        ...cart.timestamps,
        updatedAt: now()
      }
    };

    await setDoc(cartRef, finalCart);

    return ok({
      cart: finalCart,
      warnings
    });

  } catch (e){
    console.error("FETCH CART ERROR:", e);
    return err(500,"Fetch Cart Failed","Unexpected server error.",{
      error: String(e)
    });
  }
}
