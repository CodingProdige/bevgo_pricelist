export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createSign } from "crypto";
import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";

const PRODUCTS_COLLECTION = "products_v2";
const VAT = 0.15;

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CONTENT_API_BASE = "https://shoppingcontent.googleapis.com/content/v2.1";

const GOOGLE_MERCHANT_ID = process.env.GOOGLE_MERCHANT_ID || "";
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
const GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "";
const GOOGLE_MERCHANT_SYNC_SECRET = process.env.GOOGLE_MERCHANT_SYNC_SECRET || "";
const GOOGLE_FEED_CURRENCY = (process.env.GOOGLE_FEED_CURRENCY || "ZAR").toUpperCase();
const GOOGLE_FEED_TARGET_COUNTRY = (process.env.GOOGLE_FEED_TARGET_COUNTRY || "ZA").toUpperCase();
const GOOGLE_FEED_CONTENT_LANGUAGE = (process.env.GOOGLE_FEED_CONTENT_LANGUAGE || "en").toLowerCase();

const ok = (p = {}, s = 200) => Response.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e = {}) =>
  Response.json({ ok: false, title: t, message: m, ...e }, { status: s });

const toNum = (v) => (Number.isFinite(+v) ? +v : 0);
const escBase64Url = (v) =>
  Buffer.from(v)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const moneyIncl = (excl) => {
  const n = Number(excl);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number((n * (1 + VAT)).toFixed(2));
};

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
    if (!limited) return "in stock";
    return toNum(variant?.rental?.qty_available) > 0 ? "in stock" : "out of stock";
  }

  if (invQty + saleQty > 0) return "in stock";
  if (continueSelling) return "in stock";
  return "out of stock";
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

function marketplaceLink(uniqueId) {
  return `https://marketplace.bevgo.co.za/product?uniqueId=${encodeURIComponent(String(uniqueId || ""))}`;
}

function buildActiveSlugSet(rows, slugReader) {
  return new Set(
    rows
      .filter((r) => r?.placement?.isActive === true)
      .map(slugReader)
      .map((s) => String(s || "").trim())
      .filter(Boolean)
  );
}

function buildContentApiProduct(product, variant) {
  const uniqueId = String(product?.product?.unique_id || "").trim();
  const variantId = String(variant?.variant_id || "").trim();
  const offerId = `${uniqueId}-${variantId}`;
  const priceIncl = moneyIncl(variant?.pricing?.selling_price_excl);
  if (!offerId || !priceIncl) return null;

  const saleIncl = isSaleLive(variant) ? moneyIncl(variant?.sale?.sale_price_excl) : null;

  const baseTitle = String(product?.product?.title || "").trim();
  const variantLabel = String(variant?.label || "").trim();
  const title = variantLabel ? `${baseTitle} - ${variantLabel}` : baseTitle;
  const description =
    String(product?.product?.description || "").trim() || `${title} available on Bevgo Marketplace`;
  const imageLink = Array.isArray(product?.media?.images) ? product.media.images[0]?.imageUrl : null;
  const brand = String(product?.grouping?.brand || "").trim() || "Bevgo";
  const productType = [product?.grouping?.category, product?.grouping?.subCategory]
    .filter(Boolean)
    .join(" > ");

  const payload = {
    offerId,
    title,
    description,
    link: marketplaceLink(uniqueId),
    imageLink: imageLink || undefined,
    contentLanguage: GOOGLE_FEED_CONTENT_LANGUAGE,
    targetCountry: GOOGLE_FEED_TARGET_COUNTRY,
    channel: "online",
    availability: availabilityForVariant(variant),
    condition: "new",
    brand,
    gtin: String(variant?.barcode || "").trim() || undefined,
    mpn: String(variant?.sku || "").trim() || undefined,
    googleProductCategory: buildGoogleCategory(product?.grouping),
    productTypes: productType ? [productType] : undefined,
    price: {
      value: String(priceIncl.toFixed(2)),
      currency: GOOGLE_FEED_CURRENCY,
    },
  };

  if (saleIncl && saleIncl > 0) {
    payload.salePrice = {
      value: String(saleIncl.toFixed(2)),
      currency: GOOGLE_FEED_CURRENCY,
    };
  }

  return payload;
}

function buildJwtAssertion() {
  if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY");
  }

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/content",
    aud: GOOGLE_TOKEN_URL,
    iat,
    exp,
  };

  const encodedHeader = escBase64Url(JSON.stringify(header));
  const encodedClaim = escBase64Url(JSON.stringify(claim));
  const unsigned = `${encodedHeader}.${encodedClaim}`;

  const privateKey = GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, "\n");
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKey, "base64url");

  return `${unsigned}.${signature}`;
}

async function getGoogleAccessToken() {
  const assertion = buildJwtAssertion();
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  const raw = await res.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }

  if (!res.ok || !json?.access_token) {
    throw new Error(
      `OAuth token request failed: ${res.status} ${json ? JSON.stringify(json) : raw.slice(0, 500)}`
    );
  }
  return json.access_token;
}

async function pushBatch(accessToken, entries) {
  const res = await fetch(`${GOOGLE_CONTENT_API_BASE}/products/batch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ entries }),
  });

  const raw = await res.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    throw new Error(
      `Google batch failed: ${res.status} ${json ? JSON.stringify(json) : raw.slice(0, 1200)}`
    );
  }

  if (!json) {
    throw new Error(`Google batch returned non-JSON success response: ${raw.slice(0, 1200)}`);
  }

  return json;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function runSync({ secret = "", dryRun = false, limit = null } = {}) {
  if (GOOGLE_MERCHANT_SYNC_SECRET && String(secret) !== GOOGLE_MERCHANT_SYNC_SECRET) {
    return err(401, "Unauthorized", "Invalid sync secret.");
  }

  if (!GOOGLE_MERCHANT_ID) {
    return err(400, "Missing Merchant ID", "Set GOOGLE_MERCHANT_ID.");
  }

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
    .filter(
      (p) =>
        p?.placement?.isActive === true &&
        p?.placement?.supplier_out_of_stock !== true &&
        hasActiveParents(p)
    );

  if (limit != null) products = products.slice(0, limit);

  const entries = [];
  let batchId = 1;
  for (const p of products) {
    const variants = Array.isArray(p?.variants) ? p.variants : [];
    for (const v of variants) {
      const productPayload = buildContentApiProduct(p, v);
      if (!productPayload) continue;
      entries.push({
        batchId: batchId++,
        merchantId: GOOGLE_MERCHANT_ID,
        method: "insert",
        product: productPayload,
      });
    }
  }

  if (dryRun) {
    return ok({
      mode: "dry_run",
      merchant_id: GOOGLE_MERCHANT_ID,
      products_scanned: products.length,
      entries_prepared: entries.length,
      preview: entries.slice(0, 5),
    });
  }

  const accessToken = await getGoogleAccessToken();
  const parts = chunk(entries, 900);
  const results = [];

  for (const part of parts) {
    const pushed = await pushBatch(accessToken, part);
    results.push(pushed);
  }

  return ok({
    mode: "push",
    merchant_id: GOOGLE_MERCHANT_ID,
    products_scanned: products.length,
    entries_pushed: entries.length,
    batches: results.length,
  });
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const secret = String(searchParams.get("secret") || "");
    const dryRun = String(searchParams.get("dry_run") || "").toLowerCase() === "true";
    const rawLimit = Number.parseInt(String(searchParams.get("limit") || "").trim(), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : null;
    return await runSync({ secret, dryRun, limit });
  } catch (e) {
    console.error("google/merchant-sync failed:", e);
    return err(500, "Merchant Sync Failed", "Failed to sync products to Google Merchant.", {
      details: String(e?.message ?? "").slice(0, 500),
    });
  }
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const secret = String(body?.secret || "");
    const dryRun = body?.dry_run === true;
    const limit = Number.isFinite(+body?.limit) && +body.limit > 0 ? Math.trunc(+body.limit) : null;
    return await runSync({ secret, dryRun, limit });
  } catch (e) {
    console.error("google/merchant-sync failed:", e);
    return err(500, "Merchant Sync Failed", "Failed to sync products to Google Merchant.", {
      details: String(e?.message ?? "").slice(0, 500),
    });
  }
}
