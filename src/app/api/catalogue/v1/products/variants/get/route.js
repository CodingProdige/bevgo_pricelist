// app/api/products_v2/variants/list/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, doc, getDoc, getDocs } from "firebase/firestore";

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

const is8 = (s)=>/^\d{8}$/.test(String(s ?? "").trim());

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);

    // Query params:
    // - unique_id (8-digit product id, optional if doing global variant lookup)
    // - variant_id (8-digit variant id, optional)
    const pidRaw  = searchParams.get("unique_id");         // product id
    const vidRaw  = searchParams.get("variant_id");        // variant id

    const hasPid  = typeof pidRaw === "string" && pidRaw.trim().length > 0;
    const hasVid  = typeof vidRaw === "string" && vidRaw.trim().length > 0;

    const pid = hasPid ? pidRaw.trim() : "";
    const vid = hasVid ? vidRaw.trim() : "";

    // -------- MODE A: Global lookup by variant_id (no product id) --------
    if (hasVid && !hasPid) {
      if (!is8(vid)) return err(400, "Invalid Variant ID", "Query param 'variant_id' must be an 8-digit string.");

      // Scan all products_v2 for a matching variants[].variant_id
      const rs = await getDocs(collection(db, "products_v2"));

      const matches = [];
      for (const d of rs.docs) {
        const pdata = d.data() || {};
        const variants = Array.isArray(pdata.variants) ? pdata.variants : [];
        for (let i = 0; i < variants.length; i++) {
          const v = variants[i] || {};
          if (String(v?.variant_id ?? "") === vid) {
            matches.push({ unique_id: d.id, variant_index: i, variant: v });
          }
        }
      }

      if (matches.length === 0) {
        return err(404, "Variant Not Found", `No variant found with variant_id '${vid}'.`);
      }
      if (matches.length > 1) {
        // Should never happen if you enforce global uniqueness on variant.variant_id
        return err(409, "Variant ID Not Unique", `Multiple variants share variant_id '${vid}'.`);
      }

      return ok(matches[0]);
    }

    // From here on, anything else requires a valid product id
    if (!hasPid || !is8(pid)) {
      return err(400, "Invalid Product ID", "Query param 'unique_id' must be an 8-digit string.");
    }

    // Load product
    const ref = doc(db, "products_v2", pid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      return err(404, "Product Not Found", `No product exists with unique_id ${pid}.`);
    }

    const data = snap.data() || {};
    const variants = Array.isArray(data.variants) ? data.variants : [];

    // -------- MODE B: Variant lookup within product by variant_id --------
    if (hasVid) {
      if (!is8(vid)) return err(400, "Invalid Variant ID", "Query param 'variant_id' must be an 8-digit string.");

      const index = variants.findIndex(v => String(v?.variant_id ?? "") === vid);
      if (index < 0) {
        return err(404, "Variant Not Found", `No variant with variant_id '${vid}' on this product.`);
      }

      return ok({
        unique_id: pid,
        variant_index: index,
        variant: variants[index]
      });
    }

    // -------- MODE C: List all variants for product --------
    return ok({
      unique_id: pid,
      count: variants.length,
      variants
    });

  } catch (e) {
    console.error("products_v2/variants/list failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while fetching variants.");
  }
}
