import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection,
  doc,
  getDocs,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";

const ok = (p = {}, s = 200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const toNum = (v, fallback = 0) => (Number.isFinite(+v) ? +v : fallback);

function inventoryRowHasStock(row) {
  if (!row || typeof row !== "object") return false;
  if (row.in_stock === false) return false;
  if (row.supplier_out_of_stock === true) return false;

  const qty = toNum(
    row.in_stock_qty ??
      row.unit_stock_qty ??
      row.qty_available ??
      row.quantity ??
      row.qty,
    0
  );
  return qty > 0;
}

function variantHasStock(variant) {
  const inventory = Array.isArray(variant?.inventory) ? variant.inventory : [];
  return inventory.some(inventoryRowHasStock);
}

export async function POST() {
  try {
    const snap = await getDocs(collection(db, "products_v2"));
    const products = snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));

    const toDeactivate = [];
    let alreadyInactive = 0;
    let keptActive = 0;

    for (const p of products) {
      const variants = Array.isArray(p?.data?.variants) ? p.data.variants : [];
      const hasVariantStock = variants.some(variantHasStock);
      const isActive = p?.data?.placement?.isActive !== false;

      if (hasVariantStock) {
        keptActive++;
        continue;
      }

      if (!isActive) {
        alreadyInactive++;
        continue;
      }

      toDeactivate.push(p.id);
    }

    let updated = 0;
    for (const part of chunk(toDeactivate, 450)) {
      const batch = writeBatch(db);
      for (const productId of part) {
        batch.update(doc(db, "products_v2", productId), {
          "placement.isActive": false,
          "timestamps.updatedAt": serverTimestamp(),
        });
        updated++;
      }
      await batch.commit();
    }

    return ok({
      message: "Mass active adjustment completed.",
      totals: {
        total_products: products.length,
        with_variant_inventory: keptActive,
        already_inactive_without_inventory: alreadyInactive,
        deactivated_now: updated,
        unchanged_active_without_inventory: toDeactivate.length - updated,
      },
    });
  } catch (e) {
    console.error("products_v2/massAdjustActive failed:", e);
    return err(500, "Unexpected Error", "Failed to mass-adjust product activity.", {
      details: String(e?.message ?? "").slice(0, 300),
    });
  }
}
