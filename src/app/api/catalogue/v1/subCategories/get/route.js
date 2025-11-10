// app/api/sub_categories/get/route.js
/**
 * NAME: Get Sub-Category(ies) (auto-ID; id or slug; list)
 * PATH: /api/sub_categories/get
 * METHOD: GET
 *
 * QUERY (all optional):
 *   - id (string): fetch by document id
 *   - slug (string): fetch by slug (must match exactly one)
 *   - category (string), kind (string), isActive (bool-ish), isFeatured (bool-ish)
 *   - limit (number | "all")  // default 24; "all" = no cap
 *   - group_by_category (bool-ish)
 *
 * RESPONSES:
 *   - Single: { ok:true, id, data }
 *   - List:   { ok:true, count, items:[{ id, data }...] }
 *   - Grouped:{ ok:true, count, groups:[{ category, items:[...] }...] }
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  doc, getDoc, collection, getDocs, query, where
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

// Treat "", "null", "undefined" (any case) as omitted
const clean = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s || s === "null" || s === "undefined") return "";
  return s;
};

export async function GET(req){
  try{
    const { searchParams } = new URL(req.url);

    const byId   = (searchParams.get("id")||"").trim();
    const bySlug = (searchParams.get("slug")||"").trim();

    // --- Single by id
    if (byId){
      const ref = doc(db,"sub_categories", byId);
      const snap = await getDoc(ref);
      if (!snap.exists()) return err(404,"Not Found",`No sub-category id '${byId}'.`);
      return ok({ id: byId, data: snap.data()||{} });
    }

    // --- Single by slug
    if (bySlug){
      const rs = await getDocs(query(collection(db,"sub_categories"), where("subCategory.slug","==", bySlug)));
      if (rs.empty)  return err(404,"Not Found",`No sub-category with slug '${bySlug}'.`);
      if (rs.size>1) return err(409,"Slug Not Unique",`Multiple sub-categories share slug '${bySlug}'.`);
      const d = rs.docs[0];
      return ok({ id: d.id, data: d.data()||{} });
    }

    // --- List (fetch with where-only; sort in memory by placement.position)
    const category   = clean(searchParams.get("category"));
    const kind       = clean(searchParams.get("kind"));
    const isActive   = toBool(searchParams.get("isActive"));
    const isFeatured = toBool(searchParams.get("isFeatured"));
    const groupByCat = toBool(searchParams.get("group_by_category")) === true;

    const limRaw = clean(searchParams.get("limit")).toLowerCase();
    const unlimited = limRaw === "all";
    let lim = 24;
    if (!unlimited && limRaw){
      const n = parseInt(limRaw,10);
      if (Number.isFinite(n) && n>0) lim = n;
    }

    const filters = [];
    if (category)        filters.push(where("grouping.category","==",category));
    if (kind)            filters.push(where("subCategory.kind","==",kind));
    if (isActive!==null) filters.push(where("placement.isActive","==",isActive));
    if (isFeatured!==null) filters.push(where("placement.isFeatured","==",isFeatured));

    const col = collection(db,"sub_categories");
    const rs  = await getDocs(query(col, ...filters)); // no orderBy → no index needed

    // sort by placement.position asc in memory
    const unsorted = rs.docs.map(d=>({ id:d.id, data:d.data()||{} }));
    const items = unsorted
      .sort((a,b)=>{
        const apRaw = a.data?.placement?.position;
        const bpRaw = b.data?.placement?.position;
        const ap = Number.isFinite(+apRaw) ? +apRaw : Number.POSITIVE_INFINITY;
        const bp = Number.isFinite(+bpRaw) ? +bpRaw : Number.POSITIVE_INFINITY;
        return ap - bp;
      })
      .slice(0, unlimited ? undefined : lim);

    const count = items.length;

    if (!groupByCat) return ok({ count, items });

    // group by grouping.category
    const map = new Map();
    for (const it of items){
      const key = (it.data?.grouping?.category ?? "unknown").toString();
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(it);
    }
    const groups = Array.from(map.entries())
      .sort(([a],[b])=>a.localeCompare(b))
      .map(([category, items])=>({ category, items }));

    return ok({ count, groups });
  } catch (e) {
    console.error("sub_categories/get failed:", e);
    return err(500,"Unexpected Error","Something went wrong while fetching sub-categories.", {
      details: String(e?.message||"").slice(0,300)
    });
  }
}
