/**
 * NAME: Set Default Variant
 * PATH: /api/products_v2/variants/set-default
 * METHOD: POST
 *
 * PURPOSE:
 *   - Flip a single variant's `is_default` to true and unset it for all others.
 *
 * INPUTS (Body JSON):
 *   - unique_id (string, required): 8-digit product id (Firestore doc id)
 *   - where (object, required): one of
 *       - { variant_id: number } OR
 *       - { variant_unique_id: string(8-digit) }
 *
 * RESPONSE:
 *   - 200: { ok: true, unique_id, variant_id, message: "Default variant updated." }
 *   - 4xx/5xx: { ok: false, title, message }
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";

const ok  = (payload = {}, status = 200) => NextResponse.json({ ok: true, ...payload }, { status });
const err = (status, title, message, extra = {}) => NextResponse.json({ ok: false, title, message, ...extra }, { status });
const is8 = (s) => /^\d{8}$/.test(String(s ?? "").trim());

export async function POST(req) {
  try {
    const { unique_id, where } = await req.json();

    const pid = String(unique_id ?? "").trim();
    if (!is8(pid)) return err(400, "Invalid Product ID", "unique_id must be an 8-digit string.");

    if (!where || typeof where !== "object") {
      return err(400, "Invalid Locator", "Provide 'where' with variant_id or variant_unique_id.");
    }

    const byId   = Number.isFinite(+where.variant_id);
    const byCode = is8(where.variant_unique_id);
    if (!byId && !byCode) {
      return err(400, "Variant Not Specified", "Provide either 'where.variant_id' or 'where.variant_unique_id'.");
    }

    const ref = doc(db, "products_v2", pid);
    const snap = await getDoc(ref);
    if (!snap.exists()) return err(404, "Product Not Found", `No product exists with unique_id ${pid}.`);

    const data = snap.data() || {};
    const variants = Array.isArray(data.variants) ? [...data.variants] : [];
    if (!variants.length) return err(409, "No Variants", "This product has no variants to update.");

    let idx = -1;
    if (byId) {
      const vid = +where.variant_id;
      idx = variants.findIndex(v => Number.isFinite(+v?.variant_id) && +v.variant_id === vid);
    } else {
      const vuid = String(where.variant_unique_id).trim();
      idx = variants.findIndex(v => String(v?.unique_id ?? "").trim() === vuid);
    }
    if (idx < 0) return err(404, "Variant Not Found", "Could not locate the specified variant on this product.");

    // Flip defaults
    for (let i = 0; i < variants.length; i++) variants[i].is_default = (i === idx);

    await updateDoc(ref, {
      variants,
      "timestamps.updatedAt": serverTimestamp()
    });

    return ok({ unique_id: pid, variant_id: variants[idx]?.variant_id ?? null, message: "Default variant updated." });
  } catch (e) {
    console.error("variants/set-default failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while setting the default variant.");
  }
}
