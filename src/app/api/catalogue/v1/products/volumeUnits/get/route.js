// app/api/catalogue/v1/volumeUnits/get/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";

const ok  = (p={}, s=200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e={}) => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const rawLimit = (searchParams.get("limit") || "all").toLowerCase();
    const noLimit  = rawLimit === "all";
    let limitVal   = noLimit ? null : parseInt(rawLimit, 10);
    if (!noLimit && (!Number.isFinite(limitVal) || limitVal <= 0)) limitVal = null;

    const rs = await getDocs(collection(db, "volume_units"));
    // Map to plain array of symbols
    let items = rs.docs
      .map(d => (d.data()?.symbol ?? ""))
      .filter(s => typeof s === "string" && s.trim().length > 0)
      // sort alphabetically by display (case-insensitive)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    if (limitVal != null) items = items.slice(0, limitVal);

    return ok({ count: items.length, items });
  } catch (e) {
    console.error("volumeUnits/get failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while fetching volume units.");
  }
}
