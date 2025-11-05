// app/api/catalogue/v1/returnables/slug-available/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";

const ok  = (p = {}, s = 200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e = {}) => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

const norm = (s) => String(s ?? "")
  .toLowerCase()
  .normalize("NFKC")
  .replace(/\s+/g, " ")
  .trim();

/** Scan returnables and see if any data.returnable.slug equals target (case-insensitive) */
async function slugTaken(targetSlugNorm, excludeSlugNorm = "") {
  const snap = await getDocs(collection(db, "returnables"));
  for (const d of snap.docs) {
    const data = d.data() || {};
    const rSlug = norm(data?.returnable?.slug);
    if (!rSlug) continue;
    if (excludeSlugNorm && rSlug === excludeSlugNorm) continue; // allow current slug during edits
    if (rSlug === targetSlugNorm) return true;
  }
  return false;
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const slugRaw = searchParams.get("slug");
    const excludeSlugRaw = searchParams.get("exclude_slug"); // optional

    const s = norm(slugRaw);
    const ex = norm(excludeSlugRaw);

    if (!s) return err(400, "Missing Slug", "Provide 'slug' as a query parameter.");

    const taken = await slugTaken(s, ex);
    return ok({ slug: slugRaw ?? "", available: !taken });
  } catch (e) {
    console.error("returnables/slug-available GET failed:", e);
    return err(500, "Unexpected Error", "Failed to check slug availability.");
  }
}

export async function POST(req) {
  try {
    const { slug, exclude_slug } = await req.json();
    const s = norm(slug);
    const ex = norm(exclude_slug);

    if (!s) return err(400, "Missing Slug", "Provide 'slug' in the JSON body.");

    const taken = await slugTaken(s, ex);
    return ok({ slug: slug ?? "", available: !taken });
  } catch (e) {
    console.error("returnables/slug-available POST failed:", e);
    return err(500, "Unexpected Error", "Failed to check slug availability.");
  }
}
