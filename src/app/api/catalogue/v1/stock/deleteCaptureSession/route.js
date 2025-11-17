import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, updateDoc, deleteDoc, collection, addDoc, serverTimestamp } from "firebase/firestore";

/* ---------- helpers ---------- */
const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });
const toStr=(v,f="")=>(v==null?f:String(v)).trim();

/* ---------- main route ---------- */
export async function POST(req){
  try{
    const { capture_id, deleted_by } = await req.json();

    if (!toStr(capture_id))
      return err(400,"Missing Field","'capture_id' is required.");
    if (!toStr(deleted_by))
      return err(400,"Missing Field","'deleted_by' (user_id) is required.");

    /* ---------- 1. Fetch the original capture session ---------- */
    const captureRef = doc(db, "stock_captures", capture_id);
    const captureSnap = await getDoc(captureRef);
    if (!captureSnap.exists())
      return err(404, "Not Found", `No stock capture found with id '${capture_id}'.`);

    const capture = captureSnap.data() || {};
    const location_id = toStr(capture.location_id);

    if (!Array.isArray(capture.captured_data) || capture.captured_data.length === 0)
      return err(400, "Invalid Capture", "Capture record has no captured data to reverse.");

    /* ---------- 2. Authorization check (location) ---------- */
    if (!location_id) return err(400, "Missing Location", "The capture record is missing a valid location_id.");

    const locRef = doc(db, "bevgo_locations", location_id);
    const locSnap = await getDoc(locRef);
    if (!locSnap.exists())
      return err(404, "Location Not Found", `No location found with id '${location_id}'.`);

    const locData = locSnap.data() || {};
    const authorisedUsers = Array.isArray(locData.authorised)
      ? locData.authorised.map(u => toStr(u.user_id))
      : [];

    if (!authorisedUsers.includes(toStr(deleted_by))) {
      return err(
        403,
        "Permission Denied",
        `You are not authorised to delete stock captures for location '${locData.title || location_id}'.`
      );
    }

    /* ---------- 3. Perform reversal before deletion ---------- */
    const reversedProducts = [];
    const failures = [];

    for (const product of capture.captured_data){
      try {
        const productId = toStr(product?.product?.unique_id);
        if (!productId) continue;

        const ref = doc(db,"products_v2", productId);
        const snap = await getDoc(ref);
        if (!snap.exists()) {
          failures.push({ productId, reason: "Product not found in Firestore." });
          continue;
        }

        const currentData = snap.data() || {};
        const variants = Array.isArray(currentData.variants) ? [...currentData.variants] : [];

        for (const v of product.variants || []) {
          const variantId = toStr(v?.variant_id);
          const qty = Number(v?.received_qty) || 0;
          if (!variantId || qty <= 0) continue;

          const idx = variants.findIndex(vr => toStr(vr?.variant_id) === variantId);
          if (idx < 0) {
            failures.push({ productId, variantId, reason: "Variant not found in Firestore." });
            continue;
          }

          const targetVariant = { ...variants[idx] };
          const inv = Array.isArray(targetVariant.inventory) ? [...targetVariant.inventory] : [];
          const invIndex = inv.findIndex(i => toStr(i?.location_id) === location_id);

          if (invIndex >= 0) {
            const currentQty = Number(inv[invIndex].in_stock_qty || 0);
            inv[invIndex].in_stock_qty = Math.max(0, currentQty - qty);
          } else {
            failures.push({
              productId,
              variantId,
              reason: `No inventory record found for location '${location_id}'.`
            });
            continue;
          }

          targetVariant.inventory = inv;
          variants[idx] = targetVariant;
        }

        await updateDoc(ref, {
          variants,
          "timestamps.updatedAt": serverTimestamp()
        });

        reversedProducts.push(productId);

      } catch (e) {
        console.error("Error reversing stock for product", e);
        failures.push({ productId: product?.product?.unique_id || "unknown", reason: e.message });
      }
    }

    /* ---------- 4. Log deletion record ---------- */
    const deletionRecord = {
      capture_id,
      location_id,
      location_title: toStr(locData.title, null),
      deleted_by,
      reversed_products: reversedProducts,
      failed: failures,
      timestamps: {
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }
    };
    const deletionRef = await addDoc(collection(db, "stock_deletions"), deletionRecord);

    /* ---------- 5. Delete the original capture doc ---------- */
    await deleteDoc(captureRef);

    /* ---------- 6. Respond ---------- */
    return ok({
      message: `Stock capture deleted after reversal for ${reversedProducts.length} product(s) at location '${locData.title || location_id}'.`,
      data: {
        deletion_id: deletionRef.id,
        reversed_products: reversedProducts,
        failures
      }
    });

  } catch (e) {
    console.error("deleteCaptureSession failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while deleting the stock capture session.");
  }
}
