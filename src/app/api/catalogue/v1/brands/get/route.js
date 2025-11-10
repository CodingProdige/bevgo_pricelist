// app/api/brands/get/route.js
/**
 * NAME: Get Brand(s)
 * PATH: /api/brands/get
 * METHOD: GET
 *
 * QUERY (all optional; empty/"null"/"undefined" are treated as omitted):
 *   - id (string): fetch by document id
 *   - slug (string): fetch by slug (must match exactly one)
 *   - category (string)
 *   - subCategory (string)
 *   - brand (string)   // matches brand.slug OR brand.title (case-insensitive)
 *   - isActive (bool-ish)
 *   - isFeatured (bool-ish)
 *   - limit (number | "all")   // default 24; "all" = no cap
 *   - group_by ("category" | "subcategory")
 *
 * RESPONSES:
 *   - Single: { ok:true, id, data }
 *   - List:   { ok:true, count, items:[{ id, data }...] }
 *   - Grouped:{ ok:true, count, groups:[{ key, items:[...] }...] }
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, doc, getDoc, getDocs
} from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

const toBool=(v)=>{
  if (typeof v==="boolean") return v;
  if (v==null) return null;
  const s=String(v).toLowerCase();
  if (["true","1","yes"].includes(s))  return true;
  if (["false","0","no"].includes(s))  return false;
  return null;
};

// Treat "", "null", "undefined" as omitted
const clean = (v) => {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const low = s.toLowerCase();
  if (low === "null" || low === "undefined") return "";
  return s;
};

/**
 * Inclusive grouping matcher for brands (mirrors products/sub-categories logic):
 * - Hard conflicts exclude: when a doc explicitly declares a grouping that contradicts a provided filter.
 * - Otherwise, require at least one positive match among provided filters.
 */
function matchesGrouping(brandData, { category, subCategory, brandName }) {
  const g = brandData?.grouping || {};
  const b = brandData?.brand || {};

  const docCategory   = g.category || null;
  const docSubs       = Array.isArray(g.subCategories) ? g.subCategories : [];
  const docBrandSlug  = (b.slug  ?? "").trim();
  const docBrandTitle = (b.title ?? "").trim();

  // --- hard conflicts ---
  if (category && docCategory && docCategory !== category) return false;
  if (subCategory && docSubs.length > 0 && !docSubs.includes(subCategory)) return false;
  if (brandName) {
    const bn = brandName.toLowerCase();
    const slugMatch  = docBrandSlug.toLowerCase()  === bn;
    const titleMatch = docBrandTitle.toLowerCase() === bn;
    if ((docBrandSlug || docBrandTitle) && !(slugMatch || titleMatch)) return false;
  }

  const anyFilterProvided = !!(category || subCategory || brandName);

  const catMatch =
    category && docCategory === category;

  const subMatch =
    subCategory && (
      docSubs.includes(subCategory) ||
      (docSubs.length === 0) // tolerant when brand didn’t declare subs
    );

  const bn = brandName?.toLowerCase() || "";
  const brandMatch =
    brandName && (
      docBrandSlug.toLowerCase() === bn ||
      docBrandTitle.toLowerCase() === bn
    );

  const anyPositiveMatch = !!(catMatch || subMatch || brandMatch);

  return anyFilterProvided ? anyPositiveMatch : true;
}

export async function GET(req){
  try{
    const { searchParams } = new URL(req.url);

    // --- Direct lookups first (omit empty/"null"/"undefined") ---
    const byId   = clean(searchParams.get("id"));
    const bySlug = clean(searchParams.get("slug"));

    if (byId){
      const ref = doc(db,"brands", byId);
      const snap = await getDoc(ref);
      if (!snap.exists()) return err(404,"Not Found",`No brand id '${byId}'.`);
      return ok({ id: byId, data: snap.data()||{} });
    }

    if (bySlug){
      // in-memory slug lookup
      const allSnap = await getDocs(collection(db,"brands"));
      const rows = allSnap.docs.map(d=>({ id:d.id, data:d.data()||{} }));
      const hits = rows.filter(row =>
        String(row.data?.brand?.slug ?? "").trim().toLowerCase() === bySlug.toLowerCase()
      );
      if (hits.length === 0)  return err(404,"Not Found",`No brand with slug '${bySlug}'.`);
      if (hits.length > 1)    return err(409,"Slug Not Unique",`Multiple brands share slug '${bySlug}'.`);
      return ok({ id: hits[0].id, data: hits[0].data });
    }

    // --- List mode ---
    const category    = clean(searchParams.get("category"));
    const subCategory = clean(searchParams.get("subCategory"));
    const brandName   = clean(searchParams.get("brand"));
    const isActive    = toBool(clean(searchParams.get("isActive")));
    const isFeatured  = toBool(clean(searchParams.get("isFeatured")));
    const groupBy     = clean(searchParams.get("group_by")).toLowerCase(); // "category"|"subcategory"|""
    const rawLimit    = clean(searchParams.get("limit")).toLowerCase() || "24";

    const unlimited = rawLimit === "all";
    let lim = null;
    if (!unlimited){
      const n = parseInt(rawLimit,10);
      lim = (Number.isFinite(n) && n>0) ? n : 24;
    }

    // 1) load whole collection (no indexes/orderBy)
    const snapAll = await getDocs(collection(db,"brands"));
    let items = snapAll.docs.map(d=>({ id:d.id, data:d.data()||{} }));

    // 2) in-memory filters with inclusive matcher
    items = items.filter(row => {
      const b = row.data;
      if (!matchesGrouping(b, { category, subCategory, brandName })) return false;

      if (isActive !== null && !!b?.placement?.isActive   !== isActive)   return false;
      if (isFeatured !== null && !!b?.placement?.isFeatured !== isFeatured) return false;

      return true;
    });

    // 3) sort by placement.position asc, missing -> Infinity
    items.sort((a,b)=>{
      const ap = Number.isFinite(+a.data?.placement?.position) ? +a.data.placement.position : Number.POSITIVE_INFINITY;
      const bp = Number.isFinite(+b.data?.placement?.position) ? +b.data.placement.position : Number.POSITIVE_INFINITY;
      return ap - bp;
    });

    // 4) apply limit if not unlimited
    if (!unlimited && lim != null){
      items = items.slice(0, lim);
    }

    const count = items.length;

    // 5) optional grouping
    if (groupBy === "category"){
      const map = new Map();
      for (const it of items){
        const key = String(it.data?.grouping?.category ?? "unknown");
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(it);
      }
      const groups = Array.from(map.entries())
        .sort(([a],[b])=>a.localeCompare(b))
        .map(([key, items])=>({ key, items }));
      return ok({ count, groups });
    }

    if (groupBy === "subcategory"){
      const map = new Map();
      for (const it of items){
        const subs = Array.isArray(it.data?.grouping?.subCategories) ? it.data.grouping.subCategories : ["(none)"];
        for (const sc of subs){
          const key = String(sc || "(none)");
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(it);
        }
      }
      const groups = Array.from(map.entries())
        .sort(([a],[b])=>a.localeCompare(b))
        .map(([key, items])=>({ key, items }));
      return ok({ count, groups });
    }

    // default: flat list
    return ok({ count, items });
  }catch(e){
    console.error("brands/get failed:", e);
    return err(
      500,
      "Unexpected Error",
      "Something went wrong while fetching brands.",
      { details: String(e?.message||"").slice(0,300) }
    );
  }
}
