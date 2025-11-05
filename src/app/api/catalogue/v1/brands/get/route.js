// app/api/brands/get/route.js
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
  if (["true","1","yes"].includes(s)) return true;
  if (["false","0","no"].includes(s)) return false;
  return null;
};

// normalize timestamps if you ever add them later, but brands schema
// didn't include timestamps so we leave that out for now

// Inclusive grouping matcher for brands, similar to products:
// - Filters: category, subCategory, brandName
// - A brand doc can look like:
//    data.grouping.category            (string)
//    data.grouping.subCategories       (array of strings)
//    data.brand.slug / data.brand.title (brand identity)
// Matching rules:
// 1. If a filter is provided and the doc explicitly conflicts, exclude.
//    e.g. you ask for category "water" and doc.category is "soft-drinks" -> drop.
// 2. If any of the provided filters positively matches one of the doc's groupings/identity, include.
// 3. If you provided at least one filter but none matched, exclude.
// 4. If you provided no filters, include everything.
function matchesGrouping(brandData, { category, subCategory, brandName }) {
  const g = brandData?.grouping || {};
  const bInfo = brandData?.brand || {};

  const docCategory = g.category || null;
  const docSubs = Array.isArray(g.subCategories) ? g.subCategories : [];
  const docBrandSlug = (bInfo.slug ?? "").trim();
  const docBrandTitle = (bInfo.title ?? "").trim();

  // --- hard conflicts ---
  if (category && docCategory && docCategory !== category) {
    return false;
  }
  if (subCategory && docSubs.length > 0 && !docSubs.includes(subCategory)) {
    // if subCategory filter is provided and brand *does* declare subCategories,
    // and the filter is NOT in that list, it's a conflict
    return false;
  }
  if (brandName) {
    // brandName can match slug or title; conflict if both exist and neither matches
    if (
      (docBrandSlug || docBrandTitle) &&
      docBrandSlug.toLowerCase() !== brandName.toLowerCase() &&
      docBrandTitle.toLowerCase() !== brandName.toLowerCase()
    ) {
      return false;
    }
  }

  // Did caller provide any grouping-ish filters?
  const anyFilterProvided = !!(category || subCategory || brandName);

  // Any positive match?
  const catMatch =
    category && docCategory === category;

  const subMatch =
    subCategory && (
      docSubs.includes(subCategory) ||
      // tolerant fallback: if brand didn't declare subs at all, treat that as "not blocking"
      (docSubs.length === 0)
    );

  const brandMatch =
    brandName &&
    (
      docBrandSlug.toLowerCase() === brandName.toLowerCase() ||
      docBrandTitle.toLowerCase() === brandName.toLowerCase()
    );

  const anyPositiveMatch = !!(catMatch || subMatch || brandMatch);

  // If filters were sent, require at least one positive match
  return anyFilterProvided ? anyPositiveMatch : true;
}

export async function GET(req){
  try{
    const { searchParams } = new URL(req.url);

    // --- Direct lookups first ---
    const byIdRaw   = (searchParams.get("id")||"").trim();
    const bySlugRaw = (searchParams.get("slug")||"").trim();

    const byId   = byIdRaw && byIdRaw.toLowerCase()!=="null" ? byIdRaw : "";
    const bySlug = bySlugRaw && bySlugRaw.toLowerCase()!=="null" ? bySlugRaw : "";

    if (byId){
      const ref = doc(db,"brands", byId);
      const snap = await getDoc(ref);
      if (!snap.exists()) return err(404,"Not Found",`No brand id '${byId}'.`);
      return ok({ id: byId, data: snap.data()||{} });
    }

    if (bySlug){
      // in-memory slug lookup: load all, then find exact slug match
      const allSnap = await getDocs(collection(db,"brands"));
      const allRows = allSnap.docs.map(d=>({ id:d.id, data:d.data()||{} }));
      const hits = allRows.filter(row => {
        const slug = String(row.data?.brand?.slug ?? "").trim().toLowerCase();
        return slug && slug === bySlug.toLowerCase();
      });

      if (hits.length === 0){
        return err(404,"Not Found",`No brand with slug '${bySlug}'.`);
      }
      if (hits.length > 1){
        return err(409,"Slug Not Unique",`Multiple brands share slug '${bySlug}'.`);
      }
      return ok({ id: hits[0].id, data: hits[0].data });
    }

    // --- List mode ---
    // pull raw params
    const rawCategory    = (searchParams.get("category")||"").trim();
    const rawSubCategory = (searchParams.get("subCategory")||"").trim();
    const rawBrandName   = (searchParams.get("brand")||"").trim();
    const rawIsActive    = searchParams.get("isActive");
    const rawIsFeatured  = searchParams.get("isFeatured");
    const rawGroupBy     = (searchParams.get("group_by")||"").trim().toLowerCase(); // "category"|"subcategory"|""
    const rawLimit       = (searchParams.get("limit")||"24").trim().toLowerCase();

    // normalize "null" / "" to nothing
    const category    = rawCategory && rawCategory.toLowerCase()!=="null" ? rawCategory : "";
    const subCategory = rawSubCategory && rawSubCategory.toLowerCase()!=="null" ? rawSubCategory : "";
    const brandName   = rawBrandName && rawBrandName.toLowerCase()!=="null" ? rawBrandName : "";

    const isActive   = toBool(rawIsActive);
    const isFeatured = toBool(rawIsFeatured);

    // limit handling like products
    const unlimited = rawLimit === "all";
    let lim = null;
    if (!unlimited){
      const n = parseInt(rawLimit,10);
      lim = (Number.isFinite(n) && n>0) ? n : 24;
    }

    // 1) load whole collection in memory
    const snapAll = await getDocs(collection(db,"brands"));
    let items = snapAll.docs.map(d=>({ id:d.id, data:d.data()||{} }));

    // 2) in-memory filters
    items = items.filter(row => {
      const b = row.data;

      // inclusive category/subCategory/brandName logic
      if (!matchesGrouping(b, { category, subCategory, brandName })) return false;

      if (isActive !== null) {
        if (!!b?.placement?.isActive !== isActive) return false;
      }
      if (isFeatured !== null) {
        if (!!b?.placement?.isFeatured !== isFeatured) return false;
      }

      return true;
    });

    // 3) sort by placement.position asc, missing -> Infinity (goes last)
    items.sort((a,b)=>{
      const ap = Number.isFinite(+a.data?.placement?.position)
        ? +a.data.placement.position
        : Number.POSITIVE_INFINITY;
      const bp = Number.isFinite(+b.data?.placement?.position)
        ? +b.data.placement.position
        : Number.POSITIVE_INFINITY;
      return ap - bp;
    });

    // 4) apply limit if not unlimited
    if (!unlimited && lim != null){
      items = items.slice(0, lim);
    }

    const count = items.length;

    // 5) optional grouping
    if (rawGroupBy === "category"){
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

    if (rawGroupBy === "subcategory"){
      const map = new Map();
      for (const it of items){
        const subs = Array.isArray(it.data?.grouping?.subCategories)
          ? it.data.grouping.subCategories
          : ["(none)"];
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
