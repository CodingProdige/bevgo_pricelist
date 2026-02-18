// app/api/catalogue/v1/products/product/get/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { clientDb } from "@/lib/clientFirebase";
import { collection, doc, getDoc, getDocs, or, query, where } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });
const is8 =(s)=>/^\d{8}$/.test(String(s||"").trim());
const toNumOrNull = (v)=>{
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

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

function normText(v){
  return String(v ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fuzzyScore(hay, needle){
  if (!needle) return 0;
  if (!hay) return 0;
  if (hay === needle) return 100;
  if (hay.includes(needle)) return 90;

  const hTokens = hay.split(" ");
  const nTokens = needle.split(" ");
  let tokenHits = 0;
  for (const nt of nTokens){
    if (!nt) continue;
    if (hTokens.some(ht => ht.startsWith(nt) || ht.includes(nt))) tokenHits++;
  }
  let score = tokenHits > 0 ? 60 + Math.min(30, tokenHits * 10) : 0;

  // Subsequence match as a fallback
  let i = 0;
  for (const ch of needle){
    i = hay.indexOf(ch, i);
    if (i === -1) return score;
    i++;
  }
  score = Math.max(score, 40);
  return score;
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

function variantHasReturnable(v){
  const r = v?.returnable;
  if (r && typeof r === "object" && Object.keys(r).length > 0) return true;
  if (r?.returnable && typeof r.returnable === "object" && Object.keys(r.returnable).length > 0)
    return true;
  if (r?.returnable_id || r?.docId || r?.id || r?.returnable?.returnable_id) return true;
  return false;
}

function variantEffectivePriceExcl(v){
  if (v?.rental?.is_rental) return Number(v?.rental?.rental_price_excl ?? 0);
  if (v?.sale?.is_on_sale) return Number(v?.sale?.sale_price_excl ?? 0);
  return Number(v?.pricing?.selling_price_excl ?? 0);
}

function variantMatchesPack(v, { packUnitCount, packUnitVolume, packUnit }){
  const pack = v?.pack || {};
  if (packUnitCount != null && Number(pack?.unit_count ?? 0) !== packUnitCount) return false;
  if (packUnitVolume != null && Number(pack?.volume ?? 0) !== packUnitVolume) return false;
  if (packUnit){
    const unit = String(pack?.volume_unit ?? "").toLowerCase();
    if (unit !== packUnit) return false;
  }
  return true;
}

function variantInventoryHasStock(variant){
  const rows = Array.isArray(variant?.inventory) ? variant.inventory : [];
  if (!rows.length) return false;

  return rows.some((row) => {
    if (!row || typeof row !== "object") return false;
    if (row?.in_stock === false) return false;
    if (row?.supplier_out_of_stock === true) return false;

    const qty = Number(
      row?.in_stock_qty ??
      row?.unit_stock_qty ??
      row?.qty_available ??
      row?.quantity ??
      row?.qty ??
      0
    );
    return Number.isFinite(qty) && qty > 0;
  });
}

function hasInStockVariants(data){
  const variants = Array.isArray(data?.variants) ? data.variants : [];
  return variants.some((variant) => {
    if (variantTotalInStockItemsAvailable(variant) > 0) return true;
    return variantRentalIsAvailable(variant);
  });
}

function variantInventoryQtyTotal(variant){
  const rows = Array.isArray(variant?.inventory) ? variant.inventory : [];
  if (!rows.length) return 0;

  return rows.reduce((sum, row) => {
    if (!row || typeof row !== "object") return sum;
    if (row?.in_stock === false) return sum;
    if (row?.supplier_out_of_stock === true) return sum;

    const qty = Number(
      row?.in_stock_qty ??
      row?.unit_stock_qty ??
      row?.qty_available ??
      row?.quantity ??
      row?.qty ??
      0
    );
    return Number.isFinite(qty) && qty > 0 ? sum + qty : sum;
  }, 0);
}

function variantSaleQtyAvailable(variant){
  const isSaleEnabled = variant?.sale?.is_on_sale === true && variant?.sale?.disabled_by_admin !== true;
  if (!isSaleEnabled) return 0;
  const qty = Number(variant?.sale?.qty_available ?? 0);
  return Number.isFinite(qty) && qty > 0 ? qty : 0;
}

function variantTotalInStockItemsAvailable(variant){
  if (variant?.rental?.is_rental === true) return 0;
  return variantInventoryQtyTotal(variant) + variantSaleQtyAvailable(variant);
}

function variantRentalIsAvailable(variant){
  if (variant?.rental?.is_rental !== true) return false;

  const limitedStock = variant?.rental?.limited_stock === true;
  if (!limitedStock) return true;

  const qty = Number(variant?.rental?.qty_available ?? 0);
  return Number.isFinite(qty) && qty > 0;
}

function enrichVariantsWithAvailability(variants){
  const list = Array.isArray(variants) ? variants : [];
  return list.map((variant) => ({
    ...variant,
    total_in_stock_items_available: variantTotalInStockItemsAvailable(variant)
  }));
}

function productInStock(data){
  const placement = data?.placement || {};
  if (placement?.in_stock === false) return false;
  if (placement?.supplier_out_of_stock === true) return false;

  const inv = Array.isArray(data?.inventory) ? data.inventory : [];
  if (inv.length > 0){
    return inv.some(r =>
      (r?.in_stock ?? true) === true &&
      Number(r?.unit_stock_qty ?? r?.in_stock_qty ?? 0) > 0 &&
      r?.supplier_out_of_stock !== true
    );
  }

  const vars = Array.isArray(data?.variants) ? data.variants : [];
  const vInvRows = vars.flatMap(v => (Array.isArray(v?.inventory) ? v.inventory : []));
  if (vInvRows.length > 0){
    return vInvRows.some(r => Number(r?.in_stock_qty ?? r?.unit_stock_qty ?? 0) > 0);
  }

  return placement?.in_stock !== false;
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
      const dataWithVariantAvailability = {
        ...data,
        variants: enrichVariantsWithAvailability(data?.variants)
      };
      const userId = normStr(searchParams.get("userId"));
      let isFavorite = false;
      if (userId){
        const userSnap = await getDoc(doc(clientDb, "users", userId));
        const userData = userSnap.exists() ? userSnap.data() : null;
        const favorites = Array.isArray(userData?.preferences?.favoriteProducts)
          ? userData.preferences.favoriteProducts.map(v=>String(v).trim()).filter(Boolean)
          : [];
        const uid = String(dataWithVariantAvailability?.product?.unique_id ?? "");
        isFavorite = favorites.length > 0 && uid ? favorites.includes(uid) : false;
      }
      return ok({
        id: snap.id,
        data: {
          ...dataWithVariantAvailability,
          is_favorite: isFavorite,
          has_in_stock_variants: hasInStockVariants(dataWithVariantAvailability)
        }
      });
    }

    // --- List mode (ALL in memory, then filter/sort/limit) ---
    const category     = normStr(searchParams.get("category"));
    const subCategory  = normStr(searchParams.get("subCategory"));
    const brand        = normStr(searchParams.get("brand"));
    const kind         = normStr(searchParams.get("kind"));
    const keywordsRaw  = normStr(searchParams.get("keywords"));
    const searchRaw    = normStr(searchParams.get("search"));
    const userId       = normStr(searchParams.get("userId"));
    const isActive     = toBool(searchParams.get("isActive"));
    const isFeatured   = toBool(searchParams.get("isFeatured"));
    const groupByBrand = toBool(searchParams.get("group_by_brand")) === true;
    const favoritesOnly = toBool(searchParams.get("favoritesOnly")) !== false;
    const onSale       = toBool(searchParams.get("onSale"));
    const hasReturnable= toBool(searchParams.get("hasReturnable"));
    const inStock      = toBool(searchParams.get("inStock"));
    const numParam = (k)=>{
      const raw = normStr(searchParams.get(k));
      return raw === "" ? null : toNumOrNull(raw);
    };
    const priceMin     = numParam("priceMin");
    const priceMax     = numParam("priceMax");
    const packUnitCount= numParam("packUnitCount");
    const packUnitVolume= numParam("packUnitVolume");
    const packUnit     = normStr(searchParams.get("packUnit")).toLowerCase() || "";

    const keywords = keywordsRaw
      ? keywordsRaw.split(/[,\s]+/).map(s=>s.trim().toLowerCase()).filter(Boolean)
      : [];
    let favorites = [];
    if (userId){
      const userSnap = await getDoc(doc(clientDb, "users", userId));
      const userData = userSnap.exists() ? userSnap.data() : null;
      favorites = Array.isArray(userData?.preferences?.favoriteProducts)
        ? userData.preferences.favoriteProducts.map(v=>String(v).trim()).filter(Boolean)
        : [];
      if (favoritesOnly && favorites.length === 0){
        if (groupByBrand) return ok({ total: 0, count: 0, groups: [] });
        return ok({ total: 0, count: 0, items: [] });
      }
    }

    // limit handling: default 24; support 'all'
    const rawLimitNorm = normStr(searchParams.get("limit"));
    const rawLimit = (rawLimitNorm || "24").toLowerCase();
    const noTopLimit = rawLimit === "all";
    let lim = noTopLimit ? null : Number.parseInt(rawLimit,10);
    if (!noTopLimit && (!Number.isFinite(lim) || lim<=0)) lim = 24;

    // 1) Load collection with optional query constraints to reduce scan
    const col = collection(db,"products_v2");
    const constraints = [];

    // AND filters that must match (keep to fields that are reliably typed)
    if (kind) constraints.push(where("grouping.kind","==",kind));

    // OR grouping filters to reduce scan while preserving inclusive grouping logic
    const groupWheres = [];
    if (brand) groupWheres.push(where("grouping.brand","==",brand));
    if (subCategory) groupWheres.push(where("grouping.subCategory","==",subCategory));
    if (category) groupWheres.push(where("grouping.category","==",category));
    if (groupWheres.length === 1) constraints.push(groupWheres[0]);
    if (groupWheres.length > 1) constraints.push(or(...groupWheres));

    const q = constraints.length > 0 ? query(col, ...constraints) : col;
    let rs  = await getDocs(q);
    // Fallback: if constrained query returns nothing but grouping filters were provided,
    // re-scan full collection to preserve legacy behavior.
    if (rs.empty && (brand || subCategory || category)) {
      rs = await getDocs(col);
    }

    // 2) Map + timestamp normalize
    let items = rs.docs.map(d=>({ id:d.id, data: normalizeTimestamps(d.data()||{}) }));

    // 3) In-memory filters (inclusive grouping logic + others)
    items = items.filter(({ data })=>{
      if (!matchesGrouping(data, { category, subCategory, brand })) return false;
      if (kind        && data?.grouping?.kind !== kind) return false;
      if (keywords.length > 0){
        const list = Array.isArray(data?.product?.keywords) ? data.product.keywords : [];
        const lower = list.map(k=>String(k).toLowerCase());
        if (!keywords.some(k=>lower.includes(k))) return false;
      }
      if (favoritesOnly && favorites.length > 0){
        const uid = String(data?.product?.unique_id ?? "");
        if (!favorites.includes(uid)) return false;
      }
      if (isActive    !== null && !!data?.placement?.isActive   !== isActive)   return false;
      if (isFeatured  !== null && !!data?.placement?.isFeatured !== isFeatured) return false;
      if (inStock     !== null){
        const isInStock = productInStock(data);
        if (isInStock !== inStock) return false;
      }

      const vars = Array.isArray(data?.variants) ? data.variants : [];

      if (onSale !== null){
        const hasSale = vars.some(v => v?.sale?.is_on_sale === true);
        if (hasSale !== onSale) return false;
      }

      if (hasReturnable !== null){
        const hasR = vars.some(variantHasReturnable);
        if (hasR !== hasReturnable) return false;
      }

      if (packUnitCount != null || packUnitVolume != null || packUnit){
        const matchesPack = vars.some(v => variantMatchesPack(v, {
          packUnitCount,
          packUnitVolume,
          packUnit
        }));
        if (!matchesPack) return false;
      }

      if (priceMin != null || priceMax != null){
        const matchesPrice = vars.some(v => {
          const price = variantEffectivePriceExcl(v);
          if (priceMin != null && price < priceMin) return false;
          if (priceMax != null && price > priceMax) return false;
          return true;
        });
        if (!matchesPrice) return false;
      }

      return true;
    });

    items = items.map(({ id, data })=>{
      const enrichedVariants = enrichVariantsWithAvailability(data?.variants);
      const dataWithVariantAvailability = {
        ...data,
        variants: enrichedVariants
      };
      const vars = Array.isArray(data?.variants) ? data.variants : [];
      const hasSaleVariant = vars.some(v => v?.sale?.is_on_sale === true);
      const uid = String(dataWithVariantAvailability?.product?.unique_id ?? "");
      const isFavorite = favorites.length > 0 && uid ? favorites.includes(uid) : false;
      return {
        id,
        data: {
          ...dataWithVariantAvailability,
          has_sale_variant: hasSaleVariant,
          is_favorite: isFavorite,
          has_in_stock_variants: hasInStockVariants(dataWithVariantAvailability)
        }
      };
    });

    // 4) Optional fuzzy search on product.title (after filters)
    const search = normText(searchRaw);
    if (search){
      items = items
        .map(it=>{
          const title = normText(it?.data?.product?.title);
          const score = fuzzyScore(title, search);
          return score > 0 ? { ...it, _score: score } : null;
        })
        .filter(Boolean);

      items.sort((a,b)=>{
        const fa = a.data?.placement?.isFeatured ? 1 : 0;
        const fb = b.data?.placement?.isFeatured ? 1 : 0;
        if (fb !== fa) return fb - fa;
        const sa = a._score || 0;
        const sb = b._score || 0;
        if (sb !== sa) return sb - sa;
        const pa = +a.data?.placement?.position || 0;
        const pb = +b.data?.placement?.position || 0;
        return pa - pb;
      });
    }else{
      // 4) Sort by placement.position asc (missing -> 0)
      items.sort((a,b)=>{
        const fa = a.data?.placement?.isFeatured ? 1 : 0;
        const fb = b.data?.placement?.isFeatured ? 1 : 0;
        if (fb !== fa) return fb - fa;
        const pa = +a.data?.placement?.position || 0;
        const pb = +b.data?.placement?.position || 0;
        return pa - pb;
      });
    }

    // 4.5) Count total BEFORE applying limit
    const total = items.length; 

    // 4.6) Build filter options for drawer (from filtered set, pre-limit)
    const optionSets = {
      brands: new Set(),
      categories: new Set(),
      subCategories: new Set(),
      kinds: new Set(),
      packUnits: new Set(),
      packUnitCounts: new Set(),
      packUnitVolumes: new Set()
    };
    let hasOnSale = false;
    let hasRental = false;
    let hasFeatured = false;
    let hasInStock = false;
    let hasReturnableOpt = false;
    let priceMinOpt = null;
    let priceMaxOpt = null;

    for (const it of items){
      const g = it?.data?.grouping || {};
      if (g.brand) optionSets.brands.add(String(g.brand));
      if (g.category) optionSets.categories.add(String(g.category));
      if (g.subCategory) optionSets.subCategories.add(String(g.subCategory));
      if (g.kind) optionSets.kinds.add(String(g.kind));
      if (it?.data?.placement?.isFeatured === true) hasFeatured = true;
      if (!hasInStock && productInStock(it?.data)) hasInStock = true;

      const vars = Array.isArray(it?.data?.variants) ? it.data.variants : [];
      for (const v of vars){
        if (v?.sale?.is_on_sale === true) hasOnSale = true;
        if (v?.rental?.is_rental === true) hasRental = true;
        if (!hasReturnableOpt && variantHasReturnable(v)) hasReturnableOpt = true;
        if (v?.pack?.volume_unit) optionSets.packUnits.add(String(v.pack.volume_unit));
        if (Number.isFinite(+v?.pack?.unit_count)) optionSets.packUnitCounts.add(Number(v.pack.unit_count));
        if (Number.isFinite(+v?.pack?.volume)) optionSets.packUnitVolumes.add(Number(v.pack.volume));

        const price = variantEffectivePriceExcl(v);
        if (Number.isFinite(price)){
          if (priceMinOpt == null || price < priceMinOpt) priceMinOpt = price;
          if (priceMaxOpt == null || price > priceMaxOpt) priceMaxOpt = price;
        }
      }
    }

    const options = {
      brands: Array.from(optionSets.brands).sort((a,b)=>a.localeCompare(b)),
      categories: Array.from(optionSets.categories).sort((a,b)=>a.localeCompare(b)),
      subCategories: Array.from(optionSets.subCategories).sort((a,b)=>a.localeCompare(b)),
      kinds: Array.from(optionSets.kinds).sort((a,b)=>a.localeCompare(b)),
      onSale: hasOnSale,
      isRental: hasRental,
      isFeatured: hasFeatured,
      inStock: hasInStock,
      hasReturnable: hasReturnableOpt,
      packUnits: Array.from(optionSets.packUnits).sort((a,b)=>a.localeCompare(b)),
      packUnitCounts: Array.from(optionSets.packUnitCounts).sort((a,b)=>a-b),
      packUnitVolumes: Array.from(optionSets.packUnitVolumes).sort((a,b)=>a-b),
      priceRange: {
        min: priceMinOpt ?? 0,
        max: priceMaxOpt ?? 0
      }
    };

    // 5) Apply limit if any
    if (!noTopLimit && lim != null) items = items.slice(0, lim);

    const count = items.length;

    if (!groupByBrand) return ok({ total, count, items, options });

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

    return ok({ total, count, groups, options });
  }catch(e){
    console.error("products_v2/get (in-memory) failed:", e);
    return err(500,"Unexpected Error","Something went wrong while fetching products.");
  }
}
