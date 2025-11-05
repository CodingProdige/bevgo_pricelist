// app/api/catalogue/v1/products/product/get/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, doc, getDoc, getDocs } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });
const is8 =(s)=>/^\d{8}$/.test(String(s||"").trim());

/** Treat "", "null", "undefined" (any case) as absent */
function normStr(v){
  const s = String(v ?? "").trim();
  if (!s) return "";
  const low = s.toLowerCase();
  if (low === "null" || low === "undefined") return "";
  return s;
}

/** Parse tri-state booleans; "", "null", "undefined" => null (omit) */
function toBool(v){
  if (typeof v === "boolean") return v;
  const s = normStr(v).toLowerCase();
  if (!s) return null;
  if (["true","1","yes"].includes(s)) return true;
  if (["false","0","no"].includes(s)) return false;
  return null;
}

function tsToIso(v){ return v && typeof v?.toDate==="function" ? v.toDate().toISOString() : v ?? null; }
function normalizeTimestamps(doc){
  if (!doc || typeof doc!=="object") return doc;
  const ts = doc.timestamps;
  return {
    ...doc,
    ...(ts ? { timestamps: { createdAt: tsToIso(ts.createdAt), updatedAt: tsToIso(ts.updatedAt) } } : {})
  };
}

/**
 * Inclusive grouping matcher:
 * - If a product declares a grouping level and it conflicts with a provided filter, exclude it.
 * - If any of the provided filters match a declared level, include it.
 * - Requires at least one positive match when any filter is provided (prevents unrelated items).
 */
function matchesGrouping(data, { category, subCategory, brand }) {
  const g = data?.grouping || {};
  // Hard conflicts (product declares a level that doesn't match filter)
  if (brand && g.brand && g.brand !== brand) return false;
  if (subCategory && g.subCategory && g.subCategory !== subCategory) return false;
  if (category && g.category && g.category !== category) return false;

  const anyFilterProvided = !!(brand || subCategory || category);
  const anyPositiveMatch =
    (brand && g.brand === brand) ||
    (subCategory && g.subCategory === subCategory) ||
    (category && g.category === category);

  return anyFilterProvided ? anyPositiveMatch : true;
}

export async function GET(req){
  try{
    const { searchParams } = new URL(req.url);

    // --- Single by id (docId == unique_id) ---
    const byId = normStr(searchParams.get("id"));
    if (byId){
      if (!is8(byId)) return err(400,"Invalid Id","'id' must be an 8-digit string.");
      const ref = doc(db,"products_v2", byId);
      const snap = await getDoc(ref);
      if (!snap.exists()) return err(404,"Not Found",`No product with id '${byId}'.`);
      const data = normalizeTimestamps(snap.data()||{});
      return ok({ id: snap.id, data });
    }

    // --- List mode (ALL in memory, then filter/sort/limit) ---
    const category     = normStr(searchParams.get("category"));
    const subCategory  = normStr(searchParams.get("subCategory"));
    const brand        = normStr(searchParams.get("brand"));
    const kind         = normStr(searchParams.get("kind"));
    const isActive     = toBool(searchParams.get("isActive"));
    const isFeatured   = toBool(searchParams.get("isFeatured"));
    const groupByBrand = toBool(searchParams.get("group_by_brand")) === true;

    // limit handling: default 24; support 'all'
    const rawLimitNorm = normStr(searchParams.get("limit"));
    const rawLimit = (rawLimitNorm || "24").toLowerCase();
    const noTopLimit = rawLimit === "all";
    let lim = noTopLimit ? null : Number.parseInt(rawLimit,10);
    if (!noTopLimit && (!Number.isFinite(lim) || lim<=0)) lim = 24;

    // 1) Load entire collection
    const col = collection(db,"products_v2");
    const rs  = await getDocs(col);

    // 2) Map + timestamp normalize
    let items = rs.docs.map(d=>({ id:d.id, data: normalizeTimestamps(d.data()||{}) }));

    // 3) In-memory filters (inclusive grouping logic + others)
    items = items.filter(({ data })=>{
      if (!matchesGrouping(data, { category, subCategory, brand })) return false;
      if (kind        && data?.grouping?.kind !== kind) return false;
      if (isActive    !== null && !!data?.placement?.isActive   !== isActive)   return false;
      if (isFeatured  !== null && !!data?.placement?.isFeatured !== isFeatured) return false;
      return true;
    });

    // 4) Sort by placement.position asc (missing -> 0)
    items.sort((a,b)=>{
      const pa = +a.data?.placement?.position || 0;
      const pb = +b.data?.placement?.position || 0;
      return pa - pb;
    });

    // 5) Apply limit if any
    if (!noTopLimit && lim != null) items = items.slice(0, lim);

    const count = items.length;

    if (!groupByBrand) return ok({ count, items });

    // 6) Optional group by brand
    const map = new Map();
    for (const it of items){
      const b = String(it?.data?.grouping?.brand ?? "unknown");
      if (!map.has(b)) map.set(b, []);
      map.get(b).push(it);
    }
    const groups = Array.from(map.entries())
      .sort(([a],[b])=>a.localeCompare(b))
      .map(([brand, items])=>({ brand, items }));

    return ok({ count, groups });
  }catch(e){
    console.error("products_v2/get (in-memory) failed:", e);
    return err(500,"Unexpected Error","Something went wrong while fetching products.");
  }
}
