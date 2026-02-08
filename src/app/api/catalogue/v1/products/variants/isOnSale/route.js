import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc } from "firebase/firestore";

const ok  = (p={}, s=200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e={}) => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

export async function GET(req){
  try{
    const { searchParams } = new URL(req.url);
    const uniqueId = (searchParams.get("unique_id") || "").trim();

    if (!uniqueId) {
      return err(400, "Missing unique_id", "Provide 'unique_id' as a query parameter.");
    }

    const snap = await getDoc(doc(db, "products_v2", uniqueId));
    if (!snap.exists()) {
      return err(404, "Product Not Found", "No product with this unique_id.");
    }

    const data = snap.data() || {};
    const variants = Array.isArray(data?.variants) ? data.variants : [];
    const onSale = variants.filter(v => v?.sale?.is_on_sale === true);

    return ok({
      unique_id: uniqueId,
      is_on_sale: onSale.length > 0,
      count: onSale.length,
      variant_ids: onSale.map(v => v?.variant_id ?? null)
    });
  } catch (e){
    console.error("variants/isOnSale GET failed:", e);
    return err(500, "Unexpected Error", "Failed to check sale status.");
  }
}
