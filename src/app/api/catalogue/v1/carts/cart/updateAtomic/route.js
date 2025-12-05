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

/* --------------------------------------------
   CALC HELPERS
--------------------------------------------- */
const VAT = 0.15;
const r2 = v => Number(v.toFixed(2));

const unitPrice = v =>
  v.rental?.is_rental
    ? Number(v.rental.rental_price_excl || 0)
    : v.sale?.is_on_sale
      ? Number(v.sale.sale_price_excl || 0)
      : Number(v.pricing.selling_price_excl || 0);

function calcLineTotals(qty, v){
  const unit = unitPrice(v);
  const subtotal = r2(unit * qty);

  const retExcl = r2((v.returnable?.full_returnable_price_excl || 0) * qty);
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

/* --------------------------------------------
   ROUTE START
--------------------------------------------- */
export async function POST(req){
  try{
    const body = await req.json();

    const {
      customerId,
      cart_item_key,
      mode,              // add | increment | decrement | set | remove
      quantity,
      variantSnapshot,
      productSnapshot,
      channel
    } = body;

    if(!customerId) return err(400,"Missing","customerId required");
    if(!mode) return err(400,"Missing","mode required");
    if(!variantSnapshot) return err(400,"Missing","variantSnapshot required");
    if(!productSnapshot) return err(400,"Missing","productSnapshot required");

    const batch = writeBatch(db);

    const productDocId = productSnapshot.product.unique_id;
    const variantId = variantSnapshot.variant_id;

    const productRef = doc(db,"products_v2",productDocId);
    const prodSnap = await getDoc(productRef);
    if(!prodSnap.exists()) return err(404,"Not Found","Product not found");

    const productData = prodSnap.data();

    /* --------------------------------------------
       1) FIND & MUTATE VARIANT (ARRAY)
    --------------------------------------------- */
    const variants = productData.variants || [];
    const vIndex = variants.findIndex(v => String(v.variant_id) === String(variantId));

    if(vIndex < 0) return err(404,"Not Found","Variant not found in variants[] array");

    const v = { ...variants[vIndex] };

    /* --------------------------------------------
       2) LOAD CART
    --------------------------------------------- */
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
          timestamps: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        };

    let items = cart.items || [];

    let oldQty = 0;
    let newQty = quantity;

    /* --------------------------------------------
       3) MODIFY CART ITEMS
    --------------------------------------------- */
    if(cart_item_key){
      const idx = items.findIndex(i => i.cart_item_key === cart_item_key);
      if(idx < 0) return err(404,"Not Found","cart_item_key invalid");

      const existing = items[idx];
      oldQty = existing.quantity;

      if(mode === "increment") newQty = oldQty + quantity;
      if(mode === "decrement") newQty = oldQty - quantity;
      if(mode === "set")       newQty = quantity;
      if(mode === "remove")    newQty = 0;

      if(newQty <= 0) items.splice(idx,1);
      else{
        existing.quantity = newQty;
        existing.selected_variant_snapshot = variantSnapshot;
        existing.product_snapshot = productSnapshot;
        existing.line_totals = calcLineTotals(newQty,variantSnapshot);
      }
    }
    else if(mode === "add"){
      const incomingSale = variantSnapshot.sale?.is_on_sale === true;
      const incomingRental = variantSnapshot.rental?.is_rental === true;

      let matchIdx = -1;
      for(let i=0;i<items.length;i++){
        const ex = items[i];
        const isSaleSame = (ex.selected_variant_snapshot.sale?.is_on_sale === true) === incomingSale;
        const isRentSame = (ex.selected_variant_snapshot.rental?.is_rental === true) === incomingRental;

        if(
          String(ex.selected_variant_snapshot.variant_id) === String(variantId) &&
          isSaleSame &&
          isRentSame
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

    /* --------------------------------------------
       4) RESERVATION DELTA
    --------------------------------------------- */
    const delta = newQty - oldQty;

    if(delta !== 0){

      /* RENTAL LOGIC */
      if(v.rental?.is_rental === true){
        let updated = (v.rental.qty_available || 0) - delta;
        if(updated < 0) updated = 0;

        v.rental.qty_available = updated;

        if(v.rental.limited_stock === true){
          v.rental.is_rental = updated > 0;
        }
      }

      /* SALE LOGIC */
      if(v.sale){
        let updated = (v.sale.qty_available || 0) - delta;
        if(updated < 0) updated = 0;

        v.sale.qty_available = updated;

        if(v.sale.disabled_by_admin !== true){
          v.sale.is_on_sale = updated > 0;
        }
      }
    }

    /* SAVE THE MUTATED VARIANT */
    variants[vIndex] = v;
    productData.variants = variants;

    batch.update(productRef,{ variants });

    /* --------------------------------------------
       5) SAVE CART (ATOMIC)
    --------------------------------------------- */
    cart.items = items;
    cart.totals = calcCartTotals(items);
    if(!cart.meta) cart.meta = { notes:null,lastAction:"",source:"api" };
    cart.meta.lastAction = mode;
    cart.timestamps.updatedAt = new Date().toISOString();

    batch.set(cartRef,cart,{ merge:true });

    /* --------------------------------------------
       6) COMMIT EVERYTHING AT ONCE
    --------------------------------------------- */
    await batch.commit();

    return ok({ data: cart, count: items.length });

  } catch(error){
    console.error("ATOMIC ERROR: ", error);
    return err(500,"Atomic Update Failed", error.message);
  }
}
