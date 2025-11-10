import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, doc, getDoc, getDocs, updateDoc, serverTimestamp } from "firebase/firestore";

const ok  = (p={}, s=200) => NextResponse.json({ ok:true, ...p }, { status:s });
const err = (s, t, m, e={}) => NextResponse.json({ ok:false, title:t, message:m, ...e }, { status:s });
const is8 = (s) => /^\d{8}$/.test(String(s ?? "").trim());

export async function POST(req){
  try{
    const { returnable_id, variant_id, unique_id } = await req.json();

    const rid = String(returnable_id ?? "").trim();
    const vid = String(variant_id ?? "").trim();
    const pid = String(unique_id ?? "").trim();

    if (!is8(rid)) return err(400,"Invalid Returnable ID","'returnable_id' must be an 8-digit string.");
    if (!is8(vid)) return err(400,"Invalid Variant ID","'variant_id' must be an 8-digit string.");
    if (unique_id != null && !is8(pid)) return err(400,"Invalid Product ID","'unique_id' must be an 8-digit string when provided.");

    // Load returnable document from new collection
    const rRef = doc(db, "returnables_v2", rid);
    const rSnap = await getDoc(rRef);
    if (!rSnap.exists()) return err(404,"Returnable Not Found",`No returnable exists with id ${rid}.`);
    const returnableDoc = rSnap.data() || {};

    // Locate the product/variant
    let pDocRef = null;
    let variants = [];
    let vIndex = -1;

    if (is8(pid)) {
      pDocRef = doc(db, "products_v2", pid);
      const pSnap = await getDoc(pDocRef);
      if (!pSnap.exists()) return err(404,"Product Not Found",`No product exists with unique_id ${pid}.`);

      const data = pSnap.data() || {};
      variants = Array.isArray(data.variants) ? [...data.variants] : [];
      vIndex = variants.findIndex(v => String(v?.variant_id ?? "").trim() === vid);
      if (vIndex < 0) return err(404,"Variant Not Found",`No variant with variant_id ${vid} on product ${pid}.`);
    } else {
      const rs = await getDocs(collection(db, "products_v2"));
      let found = null;
      for (const d of rs.docs) {
        const data = d.data() || {};
        const vs = Array.isArray(data.variants) ? data.variants : [];
        const idx = vs.findIndex(v => String(v?.variant_id ?? "").trim() === vid);
        if (idx >= 0) {
          if (found) return err(409,"Variant ID Not Unique","Multiple products contain this variant_id.");
          found = { id: d.id, data, idx };
        }
      }
      if (!found) return err(404,"Variant Not Found",`No variant with variant_id ${vid} found on any product.`);
      pDocRef = doc(db, "products_v2", found.id);
      variants = [...(found.data.variants || [])];
      vIndex = found.idx;
    }

    // Assign returnable to variant
    variants[vIndex] = {
      ...variants[vIndex],
      returnable: returnableDoc
    };

    await updateDoc(pDocRef, {
      variants,
      "timestamps.updatedAt": serverTimestamp()
    });

    return ok({
      message: "Returnable assigned to variant.",
      unique_id: pDocRef.id,
      variant_id: vid,
      returnable_id: rid,
      variant: variants[vIndex]
    });

  } catch (e) {
    console.error("returnables_v2/assign-to-variant failed:", e);
    return err(500,"Unexpected Error","Something went wrong while assigning the returnable to the variant.");
  }
}
