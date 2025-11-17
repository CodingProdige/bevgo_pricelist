import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  setDoc,
  query,
  where,
  limit,
  serverTimestamp,
} from "firebase/firestore";

/* ---------------- helpers ---------------- */
const ok  = (p={},s=200)=>NextResponse.json({ok:true,...p},{status:s});
const err =(s,t,m,e={})=>NextResponse.json({ok:false,title:t,message:m,...e},{status:s});
const toStr=(v,f="")=>(v==null?f:String(v)).trim();

/* ---------------- get location by location_id ---------------- */
async function getLocationByLocationId(location_id){
  const col = collection(db,"bevgo_locations");
  const q = query(col, where("location_id","==",location_id), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const docSnap = snap.docs[0];
  return { docId: docSnap.id, ...docSnap.data() };
}

/* ---------------- main endpoint ---------------- */
export async function POST(req){
  try{
    const { location_id, user_id, captured } = await req.json();

    // Basic validation
    if(!location_id) return err(400,"Missing Field","'location_id' is required.");
    if(!user_id) return err(400,"Missing Field","'user_id' is required.");
    if(!Array.isArray(captured)) return err(400,"Invalid Data","'captured' must be an array.");

    /* ---------- 1️⃣ Fetch location by location_id ---------- */
    const location = await getLocationByLocationId(location_id);
    if(!location) return err(404,"Not Found",`No location found with ID '${location_id}'.`);

    /* ---------- 2️⃣ Authorization check ---------- */
    const authorised = Array.isArray(location.authorised)
      ? location.authorised.map(a=>toStr(a.user_id))
      : [];
    if(!authorised.includes(user_id)){
      return err(403,"Unauthorized",
        `User '${user_id}' is not permitted to capture stock for '${location.title}'.`
      );
    }

    /* ---------- 3️⃣ Process captured stock ---------- */
    let updatedCount = 0;
    for(const product of captured){
      const pid = toStr(product?.product?.unique_id);
      if(!pid) continue;

      const ref = doc(db,"products_v2",pid);
      const snap = await getDoc(ref);
      if(!snap.exists()) continue;

      const data = snap.data() || {};
      const variants = Array.isArray(data.variants) ? [...data.variants] : [];

      for(const variant of product.variants || []){
        const vid = toStr(variant?.variant_id);
        const qty = Number(variant?.received_qty || 0);
        if(!vid || qty <= 0) continue;

        const idx = variants.findIndex(v=>toStr(v?.variant_id)===vid);
        if(idx < 0) continue;

        const vData = { ...variants[idx] };
        const inv = Array.isArray(vData.inventory) ? [...vData.inventory] : [];

        // --- 4️⃣ Inventory update logic ---
        const invIdx = inv.findIndex(i=>toStr(i?.location_id)===toStr(location_id));
        if(invIdx >= 0){
          inv[invIdx].in_stock_qty = Number(inv[invIdx].in_stock_qty || 0) + qty;
        } else {
          inv.push({ in_stock_qty: qty, location_id });
        }

        vData.inventory = inv;
        variants[idx] = vData;
        updatedCount++;
      }

      await updateDoc(ref,{
        variants,
        "timestamps.updatedAt": serverTimestamp(),
      });
    }

    /* ---------- 5️⃣ Save capture session ---------- */
    const sessionRef = doc(collection(db,"stock_captures"));
    const sessionData = {
      docId: sessionRef.id,
      location_id,
      location_title: location.title,
      user_id,
      captured_count: updatedCount,
      captured,
      timestamps:{
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
    };
    await setDoc(sessionRef,sessionData);

    /* ---------- 6️⃣ Return result ---------- */
    return ok({
      message: `Stock successfully committed for location '${location.title}'.`,
      data:{
        location_id,
        captured_count: updatedCount,
        session_id: sessionRef.id,
      },
    });

  }catch(e){
    console.error("commitCapturedStock failed:",e);
    return err(500,"Unexpected Error","Something went wrong while committing stock.",{error:e.message});
  }
}
