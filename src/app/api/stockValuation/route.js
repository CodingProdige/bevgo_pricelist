// pages/api/stock-valuation.js
// GET /api/stock-valuation

import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";

export async function GET() {
  try {
    const snap = await getDocs(collection(db, "products"));
    const products = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    let grandTotalExcl = 0;
    let grandTotalIncl = 0;
    let totalUnitsOnFloor = 0;

    const skuBreakdown = products
      .filter(p =>
        p.in_stock === true &&
        (p.units_in_stock || 0) > 0 &&
        p.is_special_pricing !== true
      )
      .map(p => {
        const qty = p.units_in_stock;
        const totalExcl = +(qty * p.price_excl).toFixed(2);
        const totalIncl = +(qty * p.price_incl).toFixed(2);

        grandTotalExcl += totalExcl;
        grandTotalIncl += totalIncl;
        totalUnitsOnFloor += qty;

        return {
          unique_code: p.unique_code,
          product_title: p.product_title,
          product_brand: p.product_brand,
          product_image: p.product_image || null,
          units_in_stock: qty,
          price_excl: p.price_excl,
          price_incl: p.price_incl,
          total_value_excl: totalExcl,
          total_value_incl: totalIncl,
        };
      })
      .sort((a, b) => b.units_in_stock - a.units_in_stock);

    return new Response(
      JSON.stringify({
        summary: {
          totalUniqueSkusInStock: skuBreakdown.length,
          totalUnitsOnFloor,
          grand_total_value_excl: +grandTotalExcl.toFixed(2),
          grand_total_value_incl: +grandTotalIncl.toFixed(2),
        },
        skus: skuBreakdown,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}