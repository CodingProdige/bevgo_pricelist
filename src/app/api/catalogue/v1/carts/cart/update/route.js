export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false,title:t,message:m,...e },{ status:s });

const nowISO = ()=>new Date().toISOString();
const VAT = 0.15;
const r2 = v=>Number(v.toFixed(2));

function resolveUnitPriceExcl(v){
  if(v.rental?.is_rental===true) return Number(v.rental.rental_price_excl || 0);
  if(v.sale?.is_on_sale===true)  return Number(v.sale.sale_price_excl || 0);
  return Number(v.pricing.selling_price_excl || 0);
}

function calcLineTotals(qty,v){
  const unit = resolveUnitPriceExcl(v);
  const subtotal = r2(unit * qty);
  const retExcl = r2((v.returnable?.full_returnable_price_excl||0) * qty);
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
  let subtotal_excl=0, sale_savings_excl=0, deposit_total_excl=0, vat_total=0;
  let final_excl=0, final_incl=0;

  for(const it of items){
    const lt = it.line_totals;
    subtotal_excl += lt.line_subtotal_excl;
    deposit_total_excl += lt.returnable_excl;
    vat_total += lt.total_vat;
    final_excl += lt.final_excl;
    final_incl += lt.final_incl;

    if(it.selected_variant_snapshot.sale?.is_on_sale===true){
      const full = Number(it.selected_variant_snapshot.pricing.selling_price_excl||0);
      const sale = Number(it.selected_variant_snapshot.sale.sale_price_excl||0);
      const diff = r2(full - sale);
      sale_savings_excl += r2(diff * it.quantity);
    }
  }

  return {
    subtotal_excl:r2(subtotal_excl),
    sale_savings_excl:r2(sale_savings_excl),
    deposit_total_excl:r2(deposit_total_excl),
    vat_total:r2(vat_total),
    final_excl:r2(final_excl),
    final_incl:r2(final_incl)
  };
}


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

    if(!customerId)      return err(400,"Missing","customerId required");
    if(!mode)            return err(400,"Missing","mode required");
    if(!variantSnapshot) return err(400,"Missing","variantSnapshot required");
    if(!productSnapshot) return err(400,"Missing","productSnapshot required");

    const incomingVariant = variantSnapshot;
    const incomingProduct = productSnapshot;

    const variantId = incomingVariant.variant_id;
    const productDocId = incomingProduct.product.unique_id;

    /* ---------------- Load Cart ---------------- */
    const cartRef = doc(db,"carts",customerId);
    const snap = await getDoc(cartRef);

    let cart = snap.exists() ? snap.data() : {
      docId: customerId,
      cart: {
        cartId: customerId,
        customerId,
        channel
      },
      items: [],
      totals:{},
      meta:{ notes:null,lastAction:"",source:"api" },
      timestamps:{ createdAt:nowISO(),updatedAt:nowISO() }
    };

    let items = cart.items || [];
    let oldQty = 0;
    let newQty = quantity;

    /* =====================================================
       MODIFY EXISTING
    ===================================================== */
    if(cart_item_key){
      const idx = items.findIndex(i=>i.cart_item_key===cart_item_key);
      if(idx<0) return err(404,"Not Found","Cart item not found");
      const current = items[idx];
      oldQty = current.quantity;

      if(mode==="increment") newQty = oldQty + quantity;
      if(mode==="decrement") newQty = oldQty - quantity;
      if(mode==="set")       newQty = quantity;
      if(mode==="remove")    newQty = 0;

      if(newQty <= 0){
        items.splice(idx,1);
      } else {
        current.quantity = newQty;
        current.product_snapshot = incomingProduct;
        current.selected_variant_snapshot = incomingVariant;
        current.line_totals = calcLineTotals(newQty,incomingVariant);
      }
    }

    /* =====================================================
       ADD (insert OR increment)
    ===================================================== */
    else if(mode==="add"){
      const incomingVarId = incomingVariant.variant_id;
      const incomingIsSale = incomingVariant.sale?.is_on_sale===true;
      const incomingRental = incomingVariant.rental?.is_rental===true;

      let matchIdx = -1;

      for(let i=0;i<items.length;i++){
        const ex = items[i];
        const exVarId = ex.selected_variant_snapshot.variant_id;
        const exIsSale = ex.selected_variant_snapshot.sale?.is_on_sale===true;
        const exRental = ex.selected_variant_snapshot.rental?.is_rental===true;

        if(
          String(exVarId)===String(incomingVarId) &&
          exIsSale === incomingIsSale &&
          exRental === incomingRental
        ){
          matchIdx = i;
          break;
        }
      }

      if(matchIdx>=0){
        const ex = items[matchIdx];
        oldQty = ex.quantity;
        newQty = ex.quantity + quantity;
        ex.quantity = newQty;
        ex.product_snapshot = incomingProduct;
        ex.selected_variant_snapshot = incomingVariant;
        ex.line_totals = calcLineTotals(newQty,incomingVariant);
      }
      else{
        const key = crypto.randomUUID();
        items.push({
          cart_item_key:key,
          quantity,
          product_snapshot: incomingProduct,
          selected_variant_snapshot: incomingVariant,
          line_totals: calcLineTotals(quantity,incomingVariant)
        });
        oldQty = 0;
        newQty = quantity;
      }
    }

    else{
      return err(400,"Bad Request",`mode '${mode}' invalid`);
    }

    /* =====================================================
       RESERVATION LOGIC (delta-based)
    ===================================================== */
    const delta = newQty - oldQty;

    if(delta !== 0){
      const variantRef = doc(db,"products_v2",productDocId,"variants",variantId);

      const vSnap = await getDoc(variantRef);
      if(vSnap.exists()){
        const vData = vSnap.data();

        /* ----- SALE reservation ----- */
        if(vData.sale?.is_on_sale===true){
          const updatedQty = (vData.sale.qty_available || 0) - delta;

          await updateDoc(variantRef,{
            "sale.qty_available": updatedQty,
            ...(updatedQty <= 0 ? {"sale.is_on_sale": false} : {})
          });
        }

        /* ----- RENTAL reservation ----- */
        if(vData.rental?.is_rental===true && vData.rental.limited_stock===true){
          const updatedQty = (vData.rental.qty_available || 0) - delta;

          await updateDoc(variantRef,{
            "rental.qty_available": updatedQty
          });
        }
      }
    }

    /* =====================================================
       SAVE CART
    ===================================================== */

    if(!cart.meta){
      cart.meta = {notes:null,lastAction:"",source:"api"};
    }

    cart.meta.lastAction = mode;
    cart.items = items;
    cart.totals = calcCartTotals(items);
    cart.timestamps.updatedAt = nowISO();

    await setDoc(cartRef,cart,{ merge:true });

    return ok({
      data:cart,
      count:items.length
    });

  } catch(error){
    console.error("Cart Update ERROR", error);
    return err(500,"Cart Update Failed", error.message);
  }
}
