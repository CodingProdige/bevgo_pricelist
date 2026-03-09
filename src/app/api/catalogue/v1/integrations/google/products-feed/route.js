export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";

const VAT = 0.15;
const FEED_TITLE = "Bevgo Product Feed";
const FEED_DESC = "Google Merchant product feed for Bevgo marketplace";
const FEED_LINK = "https://marketplace.bevgo.co.za";

const PRODUCTS_COLLECTION = "products_v2";
const GOOGLE_FEED_SECRET = process.env.GOOGLE_FEED_SECRET || "";

const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const moneyIncl = (excl) => {
  const n = Number(excl);
  if (!Number.isFinite(n) || n <= 0) return null;
  return (n * (1 + VAT)).toFixed(2);
};

const toNum = (v) => (Number.isFinite(+v) ? +v : 0);
const isEligibleProduct = (p) =>
  p?.placement?.isActive === true &&
  p?.placement?.supplier_out_of_stock !== true;

function buildActiveSlugSet(rows, slugReader) {
  return new Set(
    rows
      .filter((r) => r?.placement?.isActive === true)
      .map(slugReader)
      .map((s) => String(s || "").trim())
      .filter(Boolean)
  );
}

const sumInventory = (variant) =>
  Array.isArray(variant?.inventory)
    ? variant.inventory.reduce((sum, row) => {
        if (!row || typeof row !== "object") return sum;
        if (row?.in_stock === false) return sum;
        if (row?.supplier_out_of_stock === true) return sum;
        const qty = toNum(
          row?.in_stock_qty ??
            row?.unit_stock_qty ??
            row?.qty_available ??
            row?.quantity ??
            row?.qty
        );
        return qty > 0 ? sum + qty : sum;
      }, 0)
    : 0;

const isSaleLive = (variant) =>
  variant?.sale?.is_on_sale === true &&
  variant?.sale?.disabled_by_admin !== true &&
  toNum(variant?.sale?.qty_available) > 0;

function availabilityForVariant(variant) {
  const continueSelling = variant?.placement?.continue_selling_out_of_stock === true;
  const invQty = sumInventory(variant);
  const saleQty = isSaleLive(variant) ? toNum(variant?.sale?.qty_available) : 0;

  if (variant?.rental?.is_rental === true) {
    const limited = variant?.rental?.limited_stock === true;
    if (!limited) return "in_stock";
    return toNum(variant?.rental?.qty_available) > 0 ? "in_stock" : "out_of_stock";
  }

  if (invQty + saleQty > 0) return "in_stock";
  if (continueSelling) return "in_stock";
  return "out_of_stock";
}

function buildGoogleCategory(grouping) {
  const category = String(grouping?.category || "").toLowerCase();
  const subCategory = String(grouping?.subCategory || "").toLowerCase();
  const has = (s) => subCategory.includes(s);

  if (category === "water" || has("water")) return "Food, Beverages & Tobacco > Beverages > Water";
  if (category === "liquor") return "Food, Beverages & Tobacco > Beverages > Alcoholic Beverages";
  if (has("beer") || has("cider")) return "Food, Beverages & Tobacco > Beverages > Beer";
  if (has("wine")) return "Food, Beverages & Tobacco > Beverages > Wine";
  if (has("spirits") || has("liqueur")) return "Food, Beverages & Tobacco > Beverages > Spirits";
  if (has("energy")) return "Food, Beverages & Tobacco > Beverages > Energy Drinks";
  if (has("sports")) return "Food, Beverages & Tobacco > Beverages > Sports Drinks";
  return "Food, Beverages & Tobacco > Beverages";
}

function productLink(uniqueId) {
  return `https://marketplace.bevgo.co.za/product?uniqueId=${encodeURIComponent(String(uniqueId || ""))}`;
}

function variantPriceFields(variant) {
  const baseIncl = moneyIncl(variant?.pricing?.selling_price_excl);
  if (!baseIncl) return null;

  if (isSaleLive(variant)) {
    const saleIncl = moneyIncl(variant?.sale?.sale_price_excl);
    if (saleIncl) {
      return {
        price: `${baseIncl} ZAR`,
        salePrice: `${saleIncl} ZAR`,
      };
    }
  }

  return {
    price: `${baseIncl} ZAR`,
    salePrice: null,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);

    if (GOOGLE_FEED_SECRET) {
      const secret = String(searchParams.get("secret") || "");
      if (secret !== GOOGLE_FEED_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const rawLimit = Number.parseInt(String(searchParams.get("limit") || "").trim(), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : null;

    const [productsSnap, categoriesSnap, subCategoriesSnap, brandsSnap] = await Promise.all([
      getDocs(collection(db, PRODUCTS_COLLECTION)),
      getDocs(collection(db, "categories")),
      getDocs(collection(db, "sub_categories")),
      getDocs(collection(db, "brands")),
    ]);

    const activeCategorySlugs = buildActiveSlugSet(
      categoriesSnap.docs.map((d) => d.data() || {}),
      (x) => x?.category?.slug
    );
    const activeSubCategorySlugs = buildActiveSlugSet(
      subCategoriesSnap.docs.map((d) => d.data() || {}),
      (x) => x?.subCategory?.slug
    );
    const activeBrandSlugs = buildActiveSlugSet(
      brandsSnap.docs.map((d) => d.data() || {}),
      (x) => x?.brand?.slug
    );

    const hasActiveParents = (p) => {
      const c = String(p?.grouping?.category || "").trim();
      const s = String(p?.grouping?.subCategory || "").trim();
      const b = String(p?.grouping?.brand || "").trim();
      return (
        Boolean(c) &&
        Boolean(s) &&
        Boolean(b) &&
        activeCategorySlugs.has(c) &&
        activeSubCategorySlugs.has(s) &&
        activeBrandSlugs.has(b)
      );
    };

    let products = productsSnap.docs
      .map((d) => ({ id: d.id, ...(d.data() || {}) }))
      .filter((p) => isEligibleProduct(p) && hasActiveParents(p));
    if (limit != null) products = products.slice(0, limit);

    const now = new Date().toUTCString();
    const items = [];

    for (const p of products) {
      const uniqueId = String(p?.product?.unique_id || "").trim();
      const title = String(p?.product?.title || "").trim();
      if (!uniqueId || !title) continue;

      const desc =
        String(p?.product?.description || "").trim() ||
        `${title} available on Bevgo Marketplace`;
      const image = Array.isArray(p?.media?.images) ? p.media.images[0]?.imageUrl : null;
      const brand = String(p?.grouping?.brand || "").trim() || "Bevgo";
      const category = String(p?.grouping?.category || "").trim();
      const subCategory = String(p?.grouping?.subCategory || "").trim();
      const googleCategory = buildGoogleCategory(p?.grouping);
      const link = productLink(uniqueId);

      const variants = Array.isArray(p?.variants) ? p.variants : [];
      for (const v of variants) {
        const variantId = String(v?.variant_id || "").trim();
        if (!variantId) continue;

        const priceFields = variantPriceFields(v);
        if (!priceFields) continue;

        const vLabel = String(v?.label || "").trim();
        const itemTitle = vLabel ? `${title} - ${vLabel}` : title;
        const sku = String(v?.sku || "").trim();
        const gtin = String(v?.barcode || "").trim();
        const availability = availabilityForVariant(v);

        const xml = [
          "<item>",
          `<g:id>${esc(`${uniqueId}-${variantId}`)}</g:id>`,
          `<g:item_group_id>${esc(uniqueId)}</g:item_group_id>`,
          `<title>${esc(itemTitle)}</title>`,
          `<description>${esc(desc)}</description>`,
          `<link>${esc(link)}</link>`,
          image ? `<g:image_link>${esc(image)}</g:image_link>` : "",
          `<g:brand>${esc(brand)}</g:brand>`,
          `<g:condition>new</g:condition>`,
          `<g:availability>${esc(availability)}</g:availability>`,
          `<g:price>${esc(priceFields.price)}</g:price>`,
          priceFields.salePrice ? `<g:sale_price>${esc(priceFields.salePrice)}</g:sale_price>` : "",
          gtin ? `<g:gtin>${esc(gtin)}</g:gtin>` : "",
          sku ? `<g:mpn>${esc(sku)}</g:mpn>` : "",
          `<g:google_product_category>${esc(googleCategory)}</g:google_product_category>`,
          `<g:product_type>${esc([category, subCategory].filter(Boolean).join(" > "))}</g:product_type>`,
          "</item>",
        ]
          .filter(Boolean)
          .join("");

        items.push(xml);
      }
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
  <channel>
    <title>${esc(FEED_TITLE)}</title>
    <link>${esc(FEED_LINK)}</link>
    <description>${esc(FEED_DESC)}</description>
    <lastBuildDate>${esc(now)}</lastBuildDate>
    ${items.join("\n")}
  </channel>
</rss>`;

    return new Response(xml, {
      status: 200,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (e) {
    console.error("google/products-feed failed:", e);
    return new Response(
      JSON.stringify({
        ok: false,
        title: "Unexpected Error",
        message: "Failed to generate Google products feed.",
        details: String(e?.message ?? "").slice(0, 300),
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
