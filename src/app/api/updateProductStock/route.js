// app/api/updateProductStock/route.js

import { db } from "@/lib/firebase";
import { collection, query, where, getDocs, writeBatch } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { items } = await req.json();

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: "Missing or invalid items array" }, { status: 400 });
    }

    const batch = writeBatch(db);
    const results = [];

    for (const item of items) {
      if (!item.unique_code || !item.quantity) continue;

      const productQuery = query(
        collection(db, "products"),
        where("unique_code", "==", item.unique_code)
      );
      const productDocs = await getDocs(productQuery);

      if (productDocs.empty) {
        results.push({ unique_code: item.unique_code, error: "Not found" });
        continue;
      }

      const productRef = productDocs.docs[0].ref;
      const productData = productDocs.docs[0].data();

      const oldStock = productData.units_in_stock ?? 0;
      const oldInStock = productData.in_stock ?? true;
      const qty = item.quantity;

      // 🛑 Skip if product already has no stock and marked out of stock
      if (oldStock === 0 && oldInStock === false) {
        results.push({
          unique_code: item.unique_code,
          skipped: true,
          reason: "Already out of stock",
        });
        continue;
      }

      // 🛑 Skip if deduction would make stock < 0
      if (qty > oldStock) {
        results.push({
          unique_code: item.unique_code,
          skipped: true,
          reason: "Ordered quantity exceeds available stock",
        });
        continue;
      }

      const newStock = Math.max(oldStock - qty, 0);
      const updateData = { units_in_stock: newStock };

      // ⚡ Flip in_stock if needed
      if (newStock === 0 && oldInStock === true) {
        updateData.in_stock = false; // went out of stock
      } else if (newStock > 0 && oldInStock === false) {
        updateData.in_stock = true; // restocked
      }

      batch.update(productRef, updateData);

      results.push({
        unique_code: item.unique_code,
        oldStock,
        deducted: qty,
        newStock,
        in_stock_updated: updateData.in_stock ?? oldInStock,
      });
    }

    await batch.commit();

    return NextResponse.json(
      {
        message: "Batch stock update successful",
        results,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("❌ Error in batch stock update:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
