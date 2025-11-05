/**
 * Generate a unique 8-digit code for products_v2 (for products and/or variants).
 *
 * METHOD: GET
 * PURPOSE:
 *   - Returns a numeric 8-digit string (10,000,000–99,999,999) not used anywhere in products_v2.
 *   - Used for product.product.unique_id and variants[].variant_id.
 *   - No writes; purely returns a free code for the caller to use.
 *
 * UNIQUENESS:
 *   - Scans products_v2 and collects all existing codes from:
 *       - product.unique_id
 *       - variants[].variant_id
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";

/* ---------------- helpers ---------------- */
const gen8 = () =>
  Math.floor(10_000_000 + Math.random() * 90_000_000).toString();

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

/* gather all existing product.unique_id and variants[*].variant_id */
async function collectExistingCodes() {
  try {
    const snap = await getDocs(collection(db, "products_v2"));
    const seen = new Set();
    for (const d of snap.docs) {
      const data = d.data() || {};
      const pCode = data?.product?.unique_id;
      if (typeof pCode === "string" && pCode.length) seen.add(pCode);

      const variants = Array.isArray(data?.variants) ? data.variants : [];
      for (const v of variants) {
        const vCode = v?.variant_id; // <-- updated to variant_id
        if (typeof vCode === "string" && vCode.length) seen.add(vCode);
      }
    }
    return seen;
  } catch {
    throw new Error("FIRESTORE_LIST_FAILED");
  }
}

/* ---------------- route ---------------- */
export async function GET() {
  try {
    const seen = await collectExistingCodes();

    const MAX_ATTEMPTS = 100000; // safety guard
    let attempts = 0;
    let code;
    do {
      if (attempts++ > MAX_ATTEMPTS) {
        return err(
          503,
          "Couldn’t Generate Unique Code",
          "We tried many times and couldn’t find an unused code. Please try again."
        );
      }
      code = gen8();
    } while (seen.has(code));

    return ok({ code }, 200);
  } catch (e) {
    if (e?.message === "FIRESTORE_LIST_FAILED") {
      return err(
        502,
        "Fetch Failed",
        "We couldn’t read existing codes from products_v2. Check your network/Firestore rules."
      );
    }
    return err(500, "Unexpected Error", "Something went wrong while generating a unique code.");
  }
}
