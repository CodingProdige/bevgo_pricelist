/**
 * Generate a unique 8-digit code used across products, variants, and returnables.
 *
 * METHOD: GET
 * PURPOSE:
 *   - Returns an 8-digit numeric string (10,000,000–99,999,999) not used anywhere in:
 *       - products_v2.product.unique_id
 *       - products_v2.variants[].variant_id
 *       - returnables (docId)
 *       - returnables.returnable.returnable_id
 *   - No writes; purely returns a free code for the caller to use.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";

/* ---------------- helpers ---------------- */
const gen8 = () =>
  Math.floor(10_000_000 + Math.random() * 90_000_000).toString();

const ok  = (p = {}, s = 200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e = {}) => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

const is8 = (s) => /^\d{8}$/.test(String(s ?? "").trim());

/** Gather all existing 8-digit codes across products, variants, and returnables */
async function collectExistingCodes() {
  try {
    const seen = new Set();

    // products_v2: product.unique_id + variants[].variant_id
    {
      const snap = await getDocs(collection(db, "products_v2"));
      for (const d of snap.docs) {
        const data = d.data() || {};

        const pCode = String(data?.product?.unique_id ?? "").trim();
        if (is8(pCode)) seen.add(pCode);

        const variants = Array.isArray(data?.variants) ? data.variants : [];
        for (const v of variants) {
          const vCode = String(v?.variant_id ?? "").trim();
          if (is8(vCode)) seen.add(vCode);
        }
      }
    }

    // returnables: docId (d.id) + returnable.returnable_id
    {
      const rsnap = await getDocs(collection(db, "returnables"));
      for (const d of rsnap.docs) {
        const data = d.data() || {};
        const docId = String(d.id).trim();
        if (is8(docId)) seen.add(docId);

        const rCode = String(data?.returnable?.returnable_id ?? "").trim();
        if (is8(rCode)) seen.add(rCode);
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
        "We couldn’t read existing codes from Firestore. Check your network/Firestore rules."
      );
    }
    return err(500, "Unexpected Error", "Something went wrong while generating a unique code.");
  }
}
