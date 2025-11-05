// app/api/products_v2/variants/delete/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";

const ok  = (p = {}, s = 200) => NextResponse.json({ ok: true,  ...p }, { status: s });
const err = (s, t, m, e = {}) => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });
const is8 = (s) => /^\d{8}$/.test(String(s ?? "").trim());

export async function POST(req) {
  try {
    const { unique_id, variant_id } = await req.json();

    // Validate product id (8-digit)
    const pid = String(unique_id ?? "").trim();
    if (!is8(pid)) return err(400, "Invalid Product ID", "'unique_id' must be an 8-digit string.");

    // Validate variant_id (accepts string "10000023" or number 10000023)
    const vidRaw = variant_id;
    const vidStr = String(vidRaw ?? "").trim();
    if (!is8(vidStr)) return err(400, "Invalid Variant ID", "'variant_id' must be an 8-digit string or number.");

    // Load product
    const ref = doc(db, "products_v2", pid);
    const snap = await getDoc(ref);
    if (!snap.exists()) return err(404, "Product Not Found", `No product exists with unique_id ${pid}.`);

    const data = snap.data() || {};
    const list = Array.isArray(data.variants) ? [...data.variants] : [];
    if (!list.length) return err(409, "No Variants", "This product has no variants to delete.");

    // Find by variant_id (exact 8-digit match after stringifying)
    const idx = list.findIndex(v => String(v?.variant_id ?? "").trim() === vidStr);
    if (idx < 0) return err(404, "Variant Not Found", `No variant with variant_id ${vidStr} on this product.`);

    const deleted = list[idx];
    // Remove it — and DO NOT reassign default automatically
    list.splice(idx, 1);

    await updateDoc(ref, {
      variants: list,
      "timestamps.updatedAt": serverTimestamp()
    });

    return ok({
      unique_id: pid,
      deleted_variant_id: deleted?.variant_id ?? null,
      remaining: list.length,
      message: "Variant deleted."
    });
  } catch (e) {
    console.error("variants/delete (simple) failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while deleting the variant.");
  }
}
