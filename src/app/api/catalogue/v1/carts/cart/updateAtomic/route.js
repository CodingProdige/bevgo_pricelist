export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  doc,
  getDoc,
  writeBatch
} from "firebase/firestore";

const ok = (p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false,title:t,message:m,...e },{ status:s });

const VAT = 0.15;
const r2 = v => Number(v.toFixed(2));

/* ================================================================
   PRICING HELPERS
================================================================ */
const resolveUnitPrice = v => {
  if(v.rental?.is_rental) return Number(v.rental.rental_price_excl || 0);
  if(v.sale?.is_on_sale)  return Number(v.sale.sale_price_excl || 0);
  return Number(v.pricing.selling_price_excl || 0);
};

function calcLineTotals(qty, v){
  const unit = resolveUnitPrice(v);
  const subtotal = r2(unit * qty);

  const retExcl = r2((v.returnable?.pricing?.full_returnable_price_excl || 0) * qty);
  const retVat  = r2(retExcl * VAT);
  const itemVat = r2(subtotal * VAT);
  const totalVat = r2(itemVat + retVat);

  const finalExcl = r2(subtotal + retExcl);
  const finalIncl = r2(finalExcl + totalVat);

  return {
    unit_price_excl: unit,
    line_subtotal_excl: subtotal,
    returnable_excl: retExcl,
    returnable_vat: retVat,
    item_vat: itemVat,
    total_vat: totalVat,
    final_excl: finalExcl,
    final_incl: finalIncl
  };
}

function calcCartTotals(items){
  let subtotal=0, saleSavings=0, deposit=0, vat=0, finalExcl=0, finalIncl=0;
  for(const it of items){
    const lt = it.line_totals;

    subtotal += lt.line_subtotal_excl;
    deposit  += lt.returnable_excl;
    vat      += lt.total_vat;
    finalExcl+= lt.final_excl;
    finalIncl+= lt.final_incl;

    if(it.selected_variant_snapshot.sale?.is_on_sale){
      const full = it.selected_variant_snapshot.pricing.selling_price_excl;
      const sale = it.selected_variant_snapshot.sale.sale_price_excl;
      saleSavings += r2((full - sale) * it.quantity);
    }
  }
  return {
    subtotal_excl: r2(subtotal),
    sale_savings_excl: r2(saleSavings),
    deposit_total_excl: r2(deposit),
    vat_total: r2(vat),
    final_excl: r2(finalExcl),
    final_incl: r2(finalIncl)
  };
}

/* ================================================================
   ENDPOINT
================================================================ */
export async function POST(req){
  try{
    const body = await req.json();

    const {
      customerId,
      cart_item_key,
      mode,
      quantity,
      variantSnapshot,
      productSnapshot,
      channel
    } = body;

    if(!customerId) return err(400,"Missing","customerId required");
    if(!mode) return err(400,"Missing","mode required");
    if(!variantSnapshot) return err(400,"Missing","variantSnapshot required");
    if(!productSnapshot) return err(400,"Missing","productSnapshot required");

    const productDocId = productSnapshot.product.unique_id;
    const variantId = variantSnapshot.variant_id;

    const productRef = doc(db,"products_v2",productDocId);
    const prodSnap = await getDoc(productRef);
    if(!prodSnap.exists()) return err(404,"Not Found","Product not found");

    const batch = writeBatch(db);
    let productData = prodSnap.data();
    let variants = productData.variants || [];
    const vIndex = variants.findIndex(v => String(v.variant_id) === String(variantId));
    if(vIndex < 0) return err(404,"Not Found","Variant not found in variants[]");

    const cartRef = doc(db,"carts",customerId);
    const cartSnap = await getDoc(cartRef);

    let cart = cartSnap.exists()
      ? cartSnap.data()
      : {
          docId: customerId,
          cart: { cartId: customerId, customerId, channel },
          items: [],
          totals: {},
          meta: { notes:null,lastAction:"",source:"api" },
          timestamps: {
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        };

    let items = cart.items || [];
    let oldQty = 0;
    let newQty = quantity;


    /* ================================================================
       CART LOGIC
    ================================================================ */
    if(cart_item_key){
        const idx = items.findIndex(i => i.cart_item_key === cart_item_key);
        if(idx < 0) return err(404,"Not Found","cart_item_key invalid");
        
        const ex = items[idx];
        oldQty = ex.quantity;
        
        if(mode === "increment") newQty = oldQty + quantity;
        if(mode === "decrement") newQty = oldQty - quantity;
        if(mode === "set")       newQty = quantity;
        if(mode === "remove")    newQty = 0;
        
        if(newQty <= 0){
            items = items.filter(i => i.cart_item_key !== cart_item_key);
        } else {
            const updated = {
              ...ex,
              quantity: newQty,
              selected_variant_snapshot: variantSnapshot,
              product_snapshot: productSnapshot,
              line_totals: calcLineTotals(newQty,variantSnapshot)
            };
            items = items.map(i =>
              i.cart_item_key === cart_item_key ? updated : i
            );
        }
    }
      
    else if(mode === "add"){
      const incomingSale = variantSnapshot.sale?.is_on_sale === true;
      const incomingRental = variantSnapshot.rental?.is_rental === true;

      let matchIdx = -1;
      for(let i=0;i<items.length;i++){
        const ex = items[i];
        const sameSale = (ex.selected_variant_snapshot.sale?.is_on_sale === true) === incomingSale;
        const sameRent = (ex.selected_variant_snapshot.rental?.is_rental === true) === incomingRental;

        if(
          String(ex.selected_variant_snapshot.variant_id) === String(variantId) &&
          sameSale &&
          sameRent
        ){
          matchIdx = i;
          break;
        }
      }

      if(matchIdx >= 0){
        const ex = items[matchIdx];
        oldQty = ex.quantity;
        newQty = oldQty + quantity;

        ex.quantity = newQty;
        ex.selected_variant_snapshot = variantSnapshot;
        ex.product_snapshot = productSnapshot;
        ex.line_totals = calcLineTotals(newQty,variantSnapshot);

      } else {
        const newKey = crypto.randomUUID();
        items.push({
          cart_item_key: newKey,
          quantity,
          product_snapshot: productSnapshot,
          selected_variant_snapshot: variantSnapshot,
          line_totals: calcLineTotals(quantity,variantSnapshot)
        });

        oldQty = 0;
        newQty = quantity;
      }
    }

    const delta = newQty - oldQty;


    /* ================================================================
       LIVE VALIDATION (BEFORE MUTATION)
    ================================================================ */
    if(delta > 0){
      const liveSnap = await getDoc(productRef);
      const liveData = liveSnap.data();
      const liveVariants = liveData.variants || [];
      const liveIdx = liveVariants.findIndex(v => String(v.variant_id) === String(variantId));
      if(liveIdx < 0) return err(500,"Inconsistent","Live variant missing");

      const liveVar = liveVariants[liveIdx];

      const liveSaleQty = liveVar.sale?.qty_available ?? 0;
      const liveRentalQty = liveVar.rental?.qty_available ?? 0;
      const liveLimited   = liveVar.rental?.limited_stock === true;

      // 🔥 **NEW FIX**: Sale validation only if incoming wants sale pricing
      const incomingIsSale = liveVar.sale?.is_on_sale === true;

      if(
        incomingIsSale &&
        liveVar.sale?.is_on_sale === true &&
        liveSaleQty < delta
      ){
        return err(400,
          "Sale Stock Too Low",
          `Only ${liveSaleQty} sale units available`
        );
      }

      // RENTAL VALIDATION
      if(liveLimited && liveRentalQty < delta){
        return err(400,
          "Rental Stock Too Low",
          `Only ${liveRentalQty} rental units available`
        );
      }
    }


    /* ================================================================
       MUTATE VARIANT STOCK (SAFE NOW)
    ================================================================ */
    const v = { ...variants[vIndex] };

    if(delta !== 0){
      if(v.rental?.is_rental){
        let nr = (v.rental.qty_available || 0) - delta;
        if(nr < 0) nr = 0;
        v.rental.qty_available = nr;
        if(v.rental.limited_stock === true){
          v.rental.is_rental = nr > 0;
        }
      }

      if(v.sale){
        let ns = (v.sale.qty_available || 0) - delta;
        if(ns < 0) ns = 0;
        v.sale.qty_available = ns;
        if(v.sale.disabled_by_admin !== true){
          v.sale.is_on_sale = ns > 0;
        }
      }
    }

    variants[vIndex] = v;
    productData.variants = variants;
    batch.update(productRef,{ variants });

    /* ================================================================
       SAVE CART
    ================================================================ */
    cart.items = items;
    cart.totals = calcCartTotals(items);
    cart.meta.lastAction = mode;
    cart.timestamps.updatedAt = new Date().toISOString();

    batch.set(cartRef,cart,{ merge:true });

    await batch.commit();

    /* ================================================================
       HYDRATE CART SNAPSHOT WITH LIVE VARIANT VALUES
    ================================================================ */
    for(const it of cart.items){
      if(String(it.selected_variant_snapshot.variant_id) === String(variantId)){
        it.selected_variant_snapshot = {
          ...it.selected_variant_snapshot,
          sale: {
            ...it.selected_variant_snapshot.sale,
            qty_available: v.sale.qty_available,
            is_on_sale: v.sale.is_on_sale
          },
          rental: {
            ...it.selected_variant_snapshot.rental,
            qty_available: v.rental.qty_available,
            is_rental: v.rental.is_rental
          }
        };
      }
    }

    return ok({
      data: cart,
      updatedVariant: v,
      variantId
    });

  } catch(error){
    console.error("ATOMIC CART ERROR:",error);
    return err(500,"Atomic Update Failed",error.message);
  }
}
