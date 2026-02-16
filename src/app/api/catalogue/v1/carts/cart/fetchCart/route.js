export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { clientDb } from "@/lib/clientFirebase";
import { doc, getDoc, setDoc } from "firebase/firestore";

/* ------------------ HELPERS ------------------- */

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, data:p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false,title:t,message:m,...e },{ status:s });

const now = () => new Date().toISOString();
const VAT = 0.15;
const DELIVERY_FEE_URL = "https://bevgo-client.vercel.app/api/v1/delivery/fee";
const r2 = v => Number((+v).toFixed(2));
const REBATE_TIER_MAX_CAP = 5;

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

function computeCartTotals(items, deliveryFee = 0){
  let subtotal = 0;
  let deposit  = 0;
  let savings  = 0;
  let vat_total = 0;
  const delivery = Number(deliveryFee) || 0;

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

  const final_excl = r2(subtotal + deposit + delivery);
  const final_incl = r2(final_excl + vat_total);

  return {
    subtotal_excl: r2(subtotal),
    deposit_total_excl: r2(deposit),
    delivery_fee_excl: r2(delivery),
    sale_savings_excl: r2(savings),
    vat_total: r2(vat_total),
    final_excl,
    final_incl
  };
}

const REBATE_TIERS = [
  { min: 0,     percent: 1 },
  { min: 3000,  percent: 2 },
  { min: 10000, percent: 3 },
  { min: 30000, percent: 4 },
  { min: 60000, percent: 5 }
];

function resolveVolumeRebatePercent(subtotalExcl){
  const total = Number(subtotalExcl) || 0;
  let pct = 0;
  for (const t of REBATE_TIERS){
    if (total >= t.min) pct = t.percent;
  }
  return pct;
}

function nextRebateTierInfo(subtotalExcl){
  const total = Number(subtotalExcl) || 0;
  for (const t of REBATE_TIERS){
    if (total < t.min){
      return {
        next_tier_min_excl: r2(t.min),
        next_tier_percent: t.percent,
        remaining_to_next_tier_excl: r2(t.min - total)
      };
    }
  }
  return {
    next_tier_min_excl: null,
    next_tier_percent: null,
    remaining_to_next_tier_excl: r2(0)
  };
}

function computePricingAdjustments(subtotalExcl, pricing){
  const discountPercentage = Number(pricing?.discountPercentage) || 0;
  const rebateEligible = Boolean(pricing?.rebate?.rebateEligible);
  const tierLocked = Boolean(pricing?.rebate?.tierLocked);
  const tierValue = Number(pricing?.rebate?.tier) || 0;

  if (discountPercentage > 0){
    const pct = Math.min(discountPercentage, 100);
    return { type: "discount", percent: pct, amountExcl: r2(subtotalExcl * (pct / 100)) };
  }

  if (!rebateEligible){
    return { type: "none", percent: 0, amountExcl: 0 };
  }

  const tierCap = tierValue > 0 ? Math.min(tierValue, REBATE_TIER_MAX_CAP) : REBATE_TIER_MAX_CAP;
  const volumePercent = resolveVolumeRebatePercent(subtotalExcl);
  const pct = tierLocked ? tierCap : Math.min(volumePercent, tierCap);

  return { type: "rebate", percent: pct, amountExcl: r2(subtotalExcl * (pct / 100)) };
}

function hasDeliveryAddress(address){
  if (!address || typeof address !== "object") return false;
  return Object.values(address).some((v) => {
    if (typeof v === "string") return v.trim().length > 0;
    return v != null;
  });
}

async function fetchDeliveryFee(address, userId){
  if (!hasDeliveryAddress(address)) {
    return { amount: 0, meta: null };
  }

  try {
    const payload = JSON.stringify({
      address,
      userId: userId || null
    });
    const urls = DELIVERY_FEE_URL.endsWith("/")
      ? [DELIVERY_FEE_URL.slice(0, -1), DELIVERY_FEE_URL]
      : [DELIVERY_FEE_URL, `${DELIVERY_FEE_URL}/`];

    let res = null;
    let lastBody = null;
    let tried = [];

    for (const url of urls) {
      tried.push(url);
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        cache: "no-store",
        redirect: "manual",
        body: payload
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (location) {
          tried.push(location);
          res = await fetch(location, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json"
            },
            cache: "no-store",
            body: payload
          });
        }
      }

      const text = await res.text();
      lastBody = text;
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      if (!res.ok) {
        if (res.status === 405) {
          continue;
        }
        return {
          amount: 0,
          meta: {
            ok: false,
            status: res.status,
            body: json ?? text ?? null,
            tried
          }
        };
      }

      if (json && json.ok === false) {
        return { amount: 0, meta: json };
      }

      const amount = r2(Number(json?.fee?.amount || 0));
      return { amount, meta: json };
    }

    return {
      amount: 0,
      meta: {
        ok: false,
        status: res?.status || 405,
        body: lastBody ?? null,
        tried
      }
    };
  } catch (e) {
    return {
      amount: 0,
      meta: {
        ok: false,
        error: String(e)
      }
    };
  }
}

/* ------------------ MAIN ENDPOINT ------------------- */

export async function POST(req){
  try {
    const { customerId, deliveryAddress, useCredit } = await req.json();
    if (!customerId)
      return err(400,"Invalid Request","customerId is required.");

    const { amount: deliveryFee, meta: deliveryMeta } = await fetchDeliveryFee(
      deliveryAddress,
      customerId
    );

    const userRef = doc(clientDb, "users", customerId);
    const userSnap = await getDoc(userRef);
    const userData = userSnap.exists() ? userSnap.data() : null;
    const useCreditFlag = useCredit === true || useCredit === "true";

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

      const emptyTotals = computeCartTotals([], deliveryFee);
      const adjust = computePricingAdjustments(emptyTotals.subtotal_excl, userData?.pricing);
      const rebateNextTier = (
        adjust.type === "rebate" && !userData?.pricing?.rebate?.tierLocked
      ) ? nextRebateTierInfo(emptyTotals.subtotal_excl) : {
        next_tier_min_excl: null,
        next_tier_percent: null,
        remaining_to_next_tier_excl: r2(0)
      };
      const discountedProductsExcl = r2(emptyTotals.subtotal_excl - adjust.amountExcl);
      const discountedExcl = r2(
        discountedProductsExcl + emptyTotals.deposit_total_excl + emptyTotals.delivery_fee_excl
      );
      const discountedIncl = r2(discountedExcl + emptyTotals.vat_total);
      const creditAvailable = r2(Number(userData?.credit?.availableCredit) || 0);
      const creditApplied = useCreditFlag && creditAvailable > 0 ? r2(creditAvailable) : 0;

      const emptyCartWithPricing = {
        ...emptyCart,
        totals: {
          ...emptyTotals,
          base_final_excl: emptyTotals.final_excl,
          base_final_incl: emptyTotals.final_incl,
          pricing_adjustment: {
            type: adjust.type,
            percent: adjust.percent,
            amount_excl: adjust.amountExcl,
            tier_locked: Boolean(userData?.pricing?.rebate?.tierLocked),
            next_tier_min_excl: rebateNextTier.next_tier_min_excl,
            next_tier_percent: rebateNextTier.next_tier_percent,
            remaining_to_next_tier_excl: rebateNextTier.remaining_to_next_tier_excl
          },
          pricing_savings_excl: adjust.amountExcl,
          final_excl_after_discount: discountedExcl,
          final_incl_after_discount: discountedIncl,
          credit: {
            available: creditAvailable,
            applied: creditApplied,
            final_payable_incl: r2(discountedIncl - creditApplied)
          },
          final_excl: discountedExcl,
          final_incl: r2(discountedIncl - creditApplied)
        }
      };

      await setDoc(cartRef, emptyCartWithPricing);

      return ok({
        cart: emptyCartWithPricing,
        has_rental_items: false,
        delivery_fee: { amount: r2(deliveryFee), meta: deliveryMeta },
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
    const totals = computeCartTotals(kept, deliveryFee);
    const adjust = computePricingAdjustments(totals.subtotal_excl, userData?.pricing);
    const rebateNextTier = (
      adjust.type === "rebate" && !userData?.pricing?.rebate?.tierLocked
    ) ? nextRebateTierInfo(totals.subtotal_excl) : {
      next_tier_min_excl: null,
      next_tier_percent: null,
      remaining_to_next_tier_excl: r2(0)
    };
    const discountedProductsExcl = r2(totals.subtotal_excl - adjust.amountExcl);
    const discountedExcl = r2(
      discountedProductsExcl + totals.deposit_total_excl + totals.delivery_fee_excl
    );
    const discountedIncl = r2(discountedExcl + totals.vat_total);
    const creditAvailable = r2(Number(userData?.credit?.availableCredit) || 0);
    const creditApplied = useCreditFlag && creditAvailable > 0 ? r2(creditAvailable) : 0;
    const hasRentalItems = kept.some(
      (it) => it?.selected_variant_snapshot?.rental?.is_rental
    );

    const finalCart = {
      ...cart,
      items: kept,
      totals: {
        ...totals,
        base_final_excl: totals.final_excl,
        base_final_incl: totals.final_incl,
        pricing_adjustment: {
          type: adjust.type,
          percent: adjust.percent,
          amount_excl: adjust.amountExcl,
          tier_locked: Boolean(userData?.pricing?.rebate?.tierLocked),
          next_tier_min_excl: rebateNextTier.next_tier_min_excl,
          next_tier_percent: rebateNextTier.next_tier_percent,
          remaining_to_next_tier_excl: rebateNextTier.remaining_to_next_tier_excl
        },
        pricing_savings_excl: adjust.amountExcl,
        final_excl_after_discount: discountedExcl,
        final_incl_after_discount: discountedIncl,
        credit: {
          available: creditAvailable,
          applied: creditApplied,
          final_payable_incl: r2(discountedIncl - creditApplied)
        },
        final_excl: discountedExcl,
        final_incl: r2(discountedIncl - creditApplied)
      },
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
      has_rental_items: hasRentalItems,
      delivery_fee: { amount: r2(deliveryFee), meta: deliveryMeta },
      warnings
    });

  } catch (e){
    console.error("FETCH CART ERROR:", e);
    return err(500,"Fetch Cart Failed","Unexpected server error.",{
      error: String(e)
    });
  }
}
