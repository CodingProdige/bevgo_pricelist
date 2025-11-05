/**
 * NAME: Soft Delete Product
 * PATH: /api/products_v2/delete
 * METHOD: POST
 *
 * PURPOSE:
 *   - Soft-delete a product by disabling it instead of removing the document.
 *
 * INPUTS (Body JSON):
 *   - unique_id (string, required): 8-digit product id (Firestore doc id)
 *
 * SIDE EFFECTS:
 *   - Updates the document at products_v2/{unique_id}:
 *       placement.isActive = false
 *       placement.isFeatured = false
 *       deletedAt = serverTimestamp()
 *       timestamps.updatedAt = serverTimestamp()
 *
 * RESPONSE:
 *   - 200: { ok: true, unique_id, message: "Product soft-deleted." }
 *   - 404: { ok: false, title: "Product Not Found", message: "..." }
 *   - 400/500: { ok: false, title, message }
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";

/* helpers */
const ok  = (payload = {}, status = 200) => NextResponse.json({ ok: true, ...payload }, { status });
const err = (status, title, message, extra = {}) => NextResponse.json({ ok: false, title, message, ...extra }, { status });
const is8 = (s) => /^\d{8}$/.test(String(s ?? "").trim());

export async function POST(req) {
  try {
    const { unique_id } = await req.json();
    const pid = String(unique_id ?? "").trim();

    if (!is8(pid)) {
      return err(400, "Invalid Product ID", "unique_id must be an 8-digit string.");
    }

    const ref = doc(db, "products_v2", pid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      return err(404, "Product Not Found", `No product exists with unique_id ${pid}.`);
    }

    await updateDoc(ref, {
      "placement.isActive": false,
      "placement.isFeatured": false,
      deletedAt: serverTimestamp(),
      "timestamps.updatedAt": serverTimestamp(),
    });

    return ok({ unique_id: pid, message: "Product soft-deleted." });
  } catch (e) {
    console.error("products_v2/delete (soft) failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while soft-deleting the product.");
  }
}
