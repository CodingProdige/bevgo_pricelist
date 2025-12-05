export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, updateDoc } from "firebase/firestore";

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false,title:t,message:m,...e },{ status:s });

export async function POST(req){
  try{
    const body = await req.json();
    const {
      unique_id,       // product docId
      variant_id,      // variant identifier
      quantity,        // integer
      action           // "increment" or "decrement"
    } = body;

    if(!unique_id) return err(400,"Missing","unique_id required");
    if(!variant_id) return err(400,"Missing","variant_id required");
    if(!quantity && quantity !== 0) return err(400,"Missing","quantity required");
    if(!action) return err(400,"Missing","action required");

    const variantRef = doc(db,"products_v2",unique_id,"variants",variant_id);
    const snap = await getDoc(variantRef);

    if(!snap.exists()){
      return err(404,"Not Found","Variant not found");
    }

    const data = snap.data();
    const rental = data.rental || {};
    const sale = data.sale || {};

    // =========================
    // Quantity delta
    // =========================
    let delta = action === "increment" ? quantity : -quantity;

    // ===================================================================
    // RENTAL UPDATE LOGIC
    // ===================================================================
    if(rental?.is_rental === true){
      let updatedQty = (rental.qty_available || 0) + delta;

      // Ensure not negative
      if(updatedQty < 0) updatedQty = 0;

      let rentalUpdates = {
        "rental.qty_available": updatedQty
      };

      // Toggle rental status if qty hits 0
      if(updatedQty === 0 && rental.limited_stock === true){
        rentalUpdates["rental.is_rental"] = false;
      }

      // Toggle back ON if qty > 0 (only if limited_stock)
      if(rental.limited_stock === true && updatedQty > 0){
        rentalUpdates["rental.is_rental"] = true;
      }

      await updateDoc(variantRef,rentalUpdates);
    }


    // ===================================================================
    // SALE UPDATE LOGIC
    // ===================================================================
    if(sale?.is_on_sale === true || sale?.qty_available >= 0){
      let updatedQty = (sale.qty_available || 0) + delta;
      if(updatedQty < 0) updatedQty = 0;

      let saleUpdates = {
        "sale.qty_available": updatedQty
      };

      // If qty hits 0, disable sale
      if(updatedQty === 0){
        saleUpdates["sale.is_on_sale"] = false;
      }

      // If qty goes > 0, restore sale BUT ONLY IF admin did NOT disable
      if(updatedQty > 0 && sale.disabled_by_admin !== true){
        saleUpdates["sale.is_on_sale"] = true;
      }

      // IMPORTANT:
      // If disabled_by_admin === true, DO NOT restore sale
      if(sale.disabled_by_admin === true){
        delete saleUpdates["sale.is_on_sale"];
      }

      await updateDoc(variantRef, saleUpdates);
    }

    return ok({ updated:true });

  } catch(error){
    console.error("Variant Update Error",error);
    return err(500,"Variant Update Failed",error.message);
  }
}
