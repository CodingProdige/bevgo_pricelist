import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";

/* ---------- helpers ---------- */
const ok  = (p = {}, s = 200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e = {}) => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

/** Generate a random 12-digit base and append a valid EAN-13 checksum */
function generateEAN13Base() {
  let base = "";
  for (let i = 0; i < 12; i++) {
    base += Math.floor(Math.random() * 10);
  }
  return base;
}

/** Compute EAN-13 checksum from the first 12 digits */
function computeEAN13Checksum(base12) {
  const digits = base12.split("").map(Number);
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  const check = (10 - (sum % 10)) % 10;
  return check.toString();
}

/** Generate full valid EAN-13 code */
function generateEAN13() {
  const base = generateEAN13Base();
  const check = computeEAN13Checksum(base);
  return base + check;
}

/** Collect all existing barcodes from all variants */
async function collectAllBarcodes() {
  const snap = await getDocs(collection(db, "products_v2"));
  const all = new Set();
  for (const d of snap.docs) {
    const data = d.data() || {};
    const variants = Array.isArray(data.variants) ? data.variants : [];
    for (const v of variants) {
      const bc = String(v?.barcode ?? "").trim();
      if (bc) all.add(bc.toUpperCase());
    }
  }
  return all;
}

/* ---------- route ---------- */
export async function GET() {
  try {
    const barcodes = await collectAllBarcodes();

    // Try up to 50 times to find a unique code (practically always succeeds)
    let ean = "";
    for (let i = 0; i < 50; i++) {
      const candidate = generateEAN13();
      if (!barcodes.has(candidate.toUpperCase())) {
        ean = candidate;
        break;
      }
    }

    if (!ean) {
      return err(500, "Generation Failed", "Could not generate a unique EAN-13 code after multiple attempts.");
    }

    return ok({
      message: "Unique EAN-13 barcode generated successfully.",
      data: { barcode: ean },
    });
  } catch (e) {
    console.error("generateUniqueEAN13 failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while generating barcode.", { error: e.message });
  }
}
