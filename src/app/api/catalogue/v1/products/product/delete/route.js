/**
 * NAME: Delete Product (hard delete)
 * PATH: /api/products_v2/delete
 * METHOD: POST
 *
 * PURPOSE:
 *   - Permanently delete a product document from Firestore.
 *   - No cascading deletes/updates are performed here.
 *
 * INPUTS (Body JSON):
 *   - unique_id (string, required): 8-digit product id (Firestore doc id)
 *
 * RESPONSE:
 *   - 200: { ok: true, unique_id, message: "Product permanently deleted." }
 *   - 404: { ok: false, title: "Product Not Found", message: "..." }
 *   - 400/500: { ok: false, title, message }
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, deleteDoc } from "firebase/firestore";

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

    await deleteDoc(ref);

    return ok({ unique_id: pid, message: "Product permanently deleted." });
  } catch (e) {
    console.error("products_v2/delete (hard) failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while deleting the product.");
  }
}
