// app/api/catalogue/v1/products/utils/updateInventoryStock/route.js
import { NextResponse } from "next/server";

const ok  = (p = {}, s = 200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e = {}) => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });
const toStr = (v, f = "") => (v == null ? f : String(v)).trim();

/**
 * Expected body:
 * {
 *   "inventory": [
 *     { "in_stock_qty": 120, "location_id": "LOC000001" },
 *     { "in_stock_qty": 50,  "location_id": "LOC000002" }
 *   ],
 *   "location_id": "LOC000001",
 *   "new_qty": 30
 * }
 */
export async function POST(req) {
  try {
    const { inventory, location_id, new_qty } = await req.json();

    // --- Basic validation ---
    if (!Array.isArray(inventory))
      return err(400, "Invalid Data", "'inventory' must be an array.");

    const locId = toStr(location_id);
    const qty = Number(new_qty);

    if (!locId)
      return err(400, "Missing Field", "'location_id' is required.");
    if (!Number.isFinite(qty) || qty < 0)
      return err(400, "Invalid Quantity", "'new_qty' must be a number ≥ 0.");

    // --- Clone inventory for immutability ---
    let updated = [...inventory];

    // --- Find matching location entry ---
    const index = updated.findIndex(i => toStr(i?.location_id) === locId);

    if (index >= 0) {
      // --- Existing entry ---
      if (qty === 0) {
        // Remove if qty is zero
        updated = updated.filter(i => toStr(i?.location_id) !== locId);
        return ok({
          message: `Removed inventory entry for location '${locId}'.`,
          data: { updated }
        });
      } else {
        // Replace with updated qty
        const updatedEntry = { ...updated[index], in_stock_qty: qty };
        updated[index] = updatedEntry;
        return ok({
          message: `Stock quantity updated for location '${locId}' to ${qty}.`,
          data: { updated }
        });
      }
    } else {
      // --- New location ---
      if (qty === 0) {
        return ok({
          message: `No update made. Quantity 0 for non-existent location '${locId}'.`,
          data: { updated }
        });
      }
      updated.push({ location_id: locId, in_stock_qty: qty });
      return ok({
        message: `Added new inventory entry for location '${locId}' with quantity ${qty}.`,
        data: { updated }
      });
    }
  } catch (e) {
    console.error("updateInventoryStock failed:", e);
    return err(
      500,
      "Unexpected Error",
      "Something went wrong while updating inventory.",
      { error: e.message }
    );
  }
}
