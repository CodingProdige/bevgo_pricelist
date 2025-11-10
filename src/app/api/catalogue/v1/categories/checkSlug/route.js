// app/api/catalogue/v1/categories/slug-available/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";

const ok  = (p={}, s=200) => NextResponse.json({ ok:true, ...p }, { status:s });
const err = (s,t,m,e={}) => NextResponse.json({ ok:false, title:t, message:m, ...e }, { status:s });
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();

async function slugTaken(targetSlug, excludeSlug = "", excludeId = "") {
  const snap = await getDocs(collection(db, "categories"));
  for (const d of snap.docs) {
    const cid = d.id;
    if (cid === excludeId) continue;
    const catSlug = norm(d.data()?.category?.slug);
    if (!catSlug) continue;
    if (excludeSlug && catSlug === excludeSlug) continue;
    if (catSlug === targetSlug) return { taken: true, conflict: { id: cid } };
  }
  return { taken: false };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const slugRaw = searchParams.get("slug");
    const excludeSlugRaw = searchParams.get("exclude_slug") || "";
    const excludeId = searchParams.get("exclude_id") || "";
    const s = norm(slugRaw);
    const ex = norm(excludeSlugRaw);

    if (!s) return err(400, "Missing Slug", "Provide 'slug' as a query parameter.");

    const { taken, conflict } = await slugTaken(s, ex, excludeId);
    return ok({ slug: slugRaw ?? "", available: !taken, conflict: conflict ?? null });
  } catch (e) {
    console.error("categories/slug-available GET failed:", e);
    return err(500, "Unexpected Error", "Failed to check slug availability.");
  }
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const s = norm(body.slug);
    const ex = norm(body.exclude_slug);
    const excludeId = body.exclude_id || "";

    if (!s) return err(400, "Missing Slug", "Provide 'slug' in the JSON body.");

    const { taken, conflict } = await slugTaken(s, ex, excludeId);
    return ok({ slug: body.slug ?? "", available: !taken, conflict: conflict ?? null });
  } catch (e) {
    console.error("categories/slug-available POST failed:", e);
    return err(500, "Unexpected Error", "Failed to check slug availability.");
  }
}
