import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";

/* ---------------- response helpers ---------------- */
const ok  = (p = {}, s = 200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e = {}) => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

/* ---------------- normalizers ---------------- */
const normStr = (v) => {
  const s = String(v ?? "").trim();
  if (!s || ["null", "undefined"].includes(s.toLowerCase())) return "";
  return s;
};

function tsToIso(v) {
  return v && typeof v?.toDate === "function" ? v.toDate().toISOString() : v ?? null;
}

function normalizeTimestamps(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  if (out.timestamps && typeof out.timestamps === "object") {
    out.timestamps = {
      createdAt: tsToIso(out.timestamps.createdAt),
      updatedAt: tsToIso(out.timestamps.updatedAt),
    };
  }
  return out;
}

/* ---------------- main route ---------------- */
export async function POST(req) {
  try {
    const { barcode } = await req.json();
    const code = normStr(barcode);
    if (!code) return err(400, "Invalid Barcode", "Please provide a valid 'barcode' value.");

    const col = collection(db, "products_v2");
    const rs = await getDocs(col);

    let matchedDoc = null;
    let matchedVariants = [];

    for (const docSnap of rs.docs) {
      const data = docSnap.data() || {};
      const variants = Array.isArray(data.variants) ? data.variants : [];
      const found = variants.filter(
        (v) => String(v?.barcode ?? "").trim().toLowerCase() === code.toLowerCase()
      );

      if (found.length > 0) {
        matchedDoc = { id: docSnap.id, data };
        matchedVariants = found;
        break; // stop after first match
      }
    }

    if (!matchedDoc) {
      return err(404, "Barcode Not Found", "No variant assigned to this barcode yet.");
    }

    const fullDoc = normalizeTimestamps(matchedDoc.data);
    fullDoc.docId = matchedDoc.id;

    // Only include matching variants
    fullDoc.variants = matchedVariants.map((v) => normalizeTimestamps(v));

    return ok({
      message: "Product and variant fetched successfully.",
      data: fullDoc,
    });
  } catch (e) {
    console.error("fetchProductByBarcode failed:", e);
    return err(500, "Unexpected Error", "Failed to fetch product by barcode.");
  }
}
