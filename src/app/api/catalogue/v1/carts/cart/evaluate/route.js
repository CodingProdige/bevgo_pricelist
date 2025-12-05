export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc } from "firebase/firestore";

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false,title:t,message:m,...e },{ status:s });

export async function POST(req){
  try{
    const body = await req.json();
    const { customerId, variantSnapshot } = body;

    if(!customerId) return err(400,"Missing","customerId required");
    if(!variantSnapshot) return err(400,"Missing","variantSnapshot required");

    const cartRef = doc(db,"carts",customerId);
    const snap = await getDoc(cartRef);

    if(!snap.exists()){
      return ok({
        merge:false
      });
    }

    const cart = snap.data();
    const items = cart.items || [];

    const incomingVarId = String(variantSnapshot.variant_id);
    const incomingIsSale = variantSnapshot.sale?.is_on_sale===true;
    const incomingRental = variantSnapshot.rental?.is_rental===true;

    // find canonical matches
    for(const ex of items){
      const exVarId = String(ex.selected_variant_snapshot.variant_id);
      const exIsSale = ex.selected_variant_snapshot.sale?.is_on_sale===true;
      const exRental = ex.selected_variant_snapshot.rental?.is_rental===true;

      if(
        exVarId === incomingVarId &&
        exIsSale === incomingIsSale &&
        exRental === incomingRental
      ){
        return ok({
          merge:true,
          cart_item_key: ex.cart_item_key
        });
      }
    }

    // no match → new line
    return ok({
      merge:false
    });

  } catch(error){
    console.error("Evaluate Cart Error", error);
    return err(500,"Evaluate Failed",error.message);
  }
}
