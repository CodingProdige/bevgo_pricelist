export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  collection,
  getDocs,
  updateDoc,
  query,
  orderBy,
  limit as qLimit,
  startAfter,
  doc,
  getDoc,
  setDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

/* HELPERS */

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, title, message, extra = {}) =>
  NextResponse.json({ ok: false, title, message, ...extra }, { status: s });

const now = () => new Date().toISOString();

/* CONFIG */

const CATEGORIES_COLLECTION = "categories";
const SUBCATEGORIES_COLLECTION = "sub_categories";
const BRANDS_COLLECTION = "brands";
const PRODUCTS_COLLECTION = "products_v2";

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";
const SHOPIFY_SYNC_SECRET = process.env.SHOPIFY_SYNC_SECRET;

const SYNC_STATUS_COLLECTION = "sync_status";

/* ───────── CANONICAL + FUZZY HELPERS ───────── */

function canonicalVendor(v = "") {
  return v
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function resolveMajorityVendor(vendor) {
  const canon = canonicalVendor(vendor);

  const res = await shopifyFetch(`products.json?limit=250`);
  const counts = {};

  for (const p of res.products || []) {
    if (canonicalVendor(p.vendor) === canon) {
      counts[p.vendor] = (counts[p.vendor] || 0) + 1;
    }
  }

  let best = vendor;
  let max = 0;

  for (const [v, c] of Object.entries(counts)) {
    if (c > max) {
      best = v;
      max = c;
    }
  }

  return best;
}

/* ---- STATE STORAGE ---- */

async function readState(key) {
  const ref = doc(db, SYNC_STATUS_COLLECTION, key);
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : { cursor: null };
}

async function writeState(key, data) {
  const ref = doc(db, SYNC_STATUS_COLLECTION, key);
  await setDoc(ref, { ...data, lastRun: now() }, { merge: true });
}

/* ---- IMAGE NORMALIZATION (convert + host-safe) ---- */

async function normalizeImages(media) {
  if (!Array.isArray(media?.images)) return [];

  const sorted = media.images.sort(
    (a, b) => (a.position || 0) - (b.position || 0)
  );

  const normalized = [];

  for (const img of sorted) {
    const url = img?.imageUrl;
    if (!url) continue;

    const clean = url.split("?")[0].toLowerCase();
    const allowed =
      clean.endsWith(".jpg") ||
      clean.endsWith(".jpeg") ||
      clean.endsWith(".png") ||
      clean.endsWith(".gif");

    // Already in a Google/Shopify-safe format → use as-is
    if (allowed) {
      normalized.push({ src: url });
      continue;
    }

    // Fallback: fetch + base64 embed so Shopify hosts it
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn("Image fetch failed", url, res.status);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const base64 = buf.toString("base64");

      // Shopify will treat `attachment` as an uploaded image
      normalized.push({ attachment: base64 });
    } catch (e) {
      console.warn("Image conversion failed", url, e);
    }
  }

  return normalized;
}

/* ---- SHOPIFY CLIENT ---- */

async function shopifyFetch(path, { method = "GET", body } = {}) {
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN)
    throw new Error("Shopify env vars missing");

  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Shopify ${method} ${path} failed: ${res.status} ${res.statusText} - ${text}`
    );
  }

  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

async function shopifyDeleteProduct(productId) {
  if (!productId) return;
  await shopifyFetch(`products/${productId}.json`, { method: "DELETE" });
}

/* ============= CRON-SAFE + FULL SYNC SUPPORT ============= */

async function pagedSync({
  key,
  col,
  buildPayload,
  processResult,
  limit = 3,
  full = false,
}) {
  /* 🔥 FULL MODE — SYNC EVERYTHING (no cursor, no paging) */
  if (full) {
    const snap = await getDocs(
      query(collection(db, col), orderBy("__name__"))
    );

    let synced = 0;
    const errors = [];

    for (const docSnap of snap.docs) {
      try {
        const ctx = await buildPayload(docSnap);
        await processResult(docSnap, ctx);
        synced++;
      } catch (e) {
        console.error(`Sync failed`, docSnap.id, e);
        errors.push({ docId: docSnap.id, error: String(e) });
      }
    }

    return { synced, errors, continuing: false };
  }

  /* 🐢 NORMAL PAGING MODE (cron safe) */

  const state = await readState(key);
  let cursor = state.cursor || null;

  let synced = 0;
  const errors = [];

  let qRef = query(collection(db, col), orderBy("__name__"), qLimit(limit));

  if (cursor) {
    const cursorSnap = await getDoc(doc(db, col, cursor));
    if (cursorSnap.exists()) qRef = query(qRef, startAfter(cursorSnap));
  }

  const snap = await getDocs(qRef);
  let lastDocId = null;

  for (const docSnap of snap.docs) {
    lastDocId = docSnap.id;

    try {
      const ctx = await buildPayload(docSnap);
      await processResult(docSnap, ctx);
      synced++;
    } catch (e) {
      console.error(`Sync failed`, docSnap.id, e);
      errors.push({ docId: docSnap.id, error: String(e) });
    }
  }

  const nextCursor = snap.docs.length === limit ? lastDocId : null;

  await writeState(key, { cursor: nextCursor });

  return { synced, errors, continuing: Boolean(nextCursor) };
}

/* ============= SMART COLLECTION HELPERS ============= */

async function ensureSmartCollection(id, payload, recreateLabel) {
  if (id) {
    try {
      return await shopifyFetch(`smart_collections/${id}.json`, {
        method: "PUT",
        body: payload,
      });
    } catch (err) {
      if (String(err).includes("404")) {
        return await shopifyFetch("smart_collections.json", {
          method: "POST",
          body: payload,
        });
      }
      throw err;
    }
  }

  return await shopifyFetch("smart_collections.json", {
    method: "POST",
    body: payload,
  });
}

/* ============= DUPLICATE PRODUCT HANDLING ============= */

async function findAndDeduplicateShopifyProducts({
  fid,
  preferredId = null,
  title,
  vendor,
}) {
  const tag = `bevgo_fid:${fid}`;

  const tagged = await shopifyFetch(
    `products.json?limit=250&tag=${encodeURIComponent(tag)}`
  );
  let products = tagged?.products || [];

  if (!products.length && title) {
    const byTitle = await shopifyFetch(
      `products.json?limit=250&title=${encodeURIComponent(title)}`
    );

    products = (byTitle?.products || []).filter(
      (p) => p.vendor?.toLowerCase() === vendor?.toLowerCase()
    );
  }

  if (!products.length) return null;

  let survivor = null;

  if (preferredId) {
    survivor =
      products.find((p) => String(p.id) === String(preferredId)) || null;
  }

  if (!survivor) {
    survivor = products
      .slice()
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      )[0];
  }

  const survivorId = survivor.id;

  for (const p of products) {
    if (String(p.id) === String(survivorId)) continue;
    try {
      await shopifyDeleteProduct(p.id);
    } catch {}
  }

  try {
    const tags = new Set(
      (survivor.tags || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    );
    tags.add(tag);

    await shopifyFetch(`products/${survivorId}.json`, {
      method: "PUT",
      body: { product: { id: survivorId, tags: Array.from(tags).join(", ") } },
    });
  } catch {}

  return survivor;
}

/* ============= SYNC CATEGORY TYPES ============= */

async function syncCategories({ full }) {
  return pagedSync({
    key: "shopify_categories",
    col: CATEGORIES_COLLECTION,
    full,
    buildPayload: async (docSnap) => {
      const data = docSnap.data();
      const { category, placement, media } = data;
      if (!category?.slug || !category?.title) return null;
      if (placement && placement.isActive === false) return null;

      const payload = {
        smart_collection: {
          title: category.title,
          body_html: category.description || "",
          rules: [
            {
              column: "tag",
              relation: "equals",
              condition: `category:${category.slug}`,
            },
          ],
        },
      };

      if (media?.images?.[0]?.imageUrl)
        payload.smart_collection.image = { src: media.images[0].imageUrl };

      return { data, payload };
    },
    processResult: async (docSnap, ctx) => {
      if (!ctx) return;
      const { data, payload } = ctx;

      const shopifyMeta = data.shopify || {};

      const res = await ensureSmartCollection(
        shopifyMeta.collectionId,
        payload,
        "Shopify category collection missing"
      );

      await updateDoc(docSnap.ref, {
        shopify: {
          ...(shopifyMeta || {}),
          collectionId: res.smart_collection.id,
          handle: res.smart_collection.handle,
          lastSyncedAt: now(),
        },
      });
    },
  });
}

async function syncSubCategories({ full }) {
  return pagedSync({
    key: "shopify_subCategories",
    col: SUBCATEGORIES_COLLECTION,
    full,
    buildPayload: async (docSnap) => {
      const data = docSnap.data();
      const { grouping, subCategory, placement, media } = data;

      if (!subCategory?.slug || !subCategory?.title) return null;
      if (!grouping?.category) return null;
      if (placement && placement.isActive === false) return null;

      const payload = {
        smart_collection: {
          title: subCategory.title,
          body_html: subCategory.description || "",
          rules: [
            {
              column: "tag",
              relation: "equals",
              condition: `category:${grouping.category}`,
            },
            {
              column: "tag",
              relation: "equals",
              condition: `subcategory:${subCategory.slug}`,
            },
          ],
        },
      };

      if (media?.images?.[0]?.imageUrl)
        payload.smart_collection.image = { src: media.images[0].imageUrl };

      return { data, payload };
    },
    processResult: async (docSnap, ctx) => {
      if (!ctx) return;
      const { data, payload } = ctx;

      const shopifyMeta = data.shopify || {};

      const res = await ensureSmartCollection(
        shopifyMeta.collectionId,
        payload,
        "Shopify subCategory collection missing"
      );

      await updateDoc(docSnap.ref, {
        shopify: {
          ...(shopifyMeta || {}),
          collectionId: res.smart_collection.id,
          handle: res.smart_collection.handle,
          lastSyncedAt: now(),
        },
      });
    },
  });
}

async function syncBrands({ full }) {
  return pagedSync({
    key: "shopify_brands",
    col: BRANDS_COLLECTION,
    full,
    buildPayload: async (docSnap) => {
      const data = docSnap.data();
      const { brand, placement, media } = data;

      if (!brand?.title || !brand?.slug) return null;
      if (placement && placement.isActive === false) return null;

      const resolvedVendor = await resolveMajorityVendor(brand.title);

      const payload = {
        smart_collection: {
          title: brand.title,
          body_html: brand.description || "",
          rules: [
            {
              column: "vendor",
              relation: "equals",
              condition: resolvedVendor,
            },
          ],
        },
      };

      if (media?.images?.[0]?.imageUrl)
        payload.smart_collection.image = { src: media.images[0].imageUrl };

      return { data, payload, resolvedVendor };
    },
    processResult: async (docSnap, ctx) => {
      if (!ctx) return;
      const { data, payload, resolvedVendor } = ctx;

      const shopifyMeta = data.shopify || {};

      const res = await ensureSmartCollection(
        shopifyMeta.collectionId,
        payload,
        "Shopify brand collection missing"
      );

      await updateDoc(docSnap.ref, {
        shopify: {
          ...(shopifyMeta || {}),
          collectionId: res.smart_collection.id,
          handle: res.smart_collection.handle,
          vendorName: resolvedVendor,
          lastSyncedAt: now(),
        },
      });
    },
  });
}

async function syncProducts({ full }) {
  return pagedSync({
    key: "shopify_products",
    col: PRODUCTS_COLLECTION,
    full,

    buildPayload: async (docSnap) => {
      const data = docSnap.data();
      const { grouping, product, media, placement, variants } = data;

      if (!product?.title) return null;
      if (!grouping?.category || !grouping?.subCategory || !grouping?.brand)
        return null;
      if (!Array.isArray(variants) || !variants.length) return null;

      const isRental =
        variants.every((v) => v?.rental?.is_rental === true);

      if (isRental) return { data, skip: "rental" };

      // 🔍 Does *any* variant have a valid selling price?
      const hasPrice = variants.some(
        (v) =>
          typeof v?.pricing?.selling_price_excl === "number" &&
          v.pricing.selling_price_excl > 0
      );

      // If no price → auto-draft product instead of failing
      const forceDraft = !hasPrice;

      const vendor = await resolveMajorityVendor(grouping.brand);

      const desc =
        product.description ||
        `${product.title} — available from Bevgo. Fast delivery, competitive pricing, loyalty rebates and bulk options.`;

      const tagSet = new Set(product.keywords || []);
      tagSet.add(`category:${grouping.category}`);
      tagSet.add(`subcategory:${grouping.subCategory}`);
      tagSet.add(`brand:${grouping.brand}`);
      if (placement?.isFeatured) tagSet.add("featured");
      if (placement?.supplier_out_of_stock)
        tagSet.add("supplier_out_of_stock");
      if (!placement?.in_stock) tagSet.add("out_of_stock");
      tagSet.add(`bevgo_fid:${docSnap.id}`);

      const images = await normalizeImages(media);

      const shopifyVariants = variants.map((v, index) => {
        const basePrice = v?.pricing?.selling_price_excl;
        const salePrice =
          v?.sale?.is_on_sale && v?.sale?.sale_price_excl
            ? v.sale.sale_price_excl
            : null;

        let price = forceDraft ? 0.01 : (salePrice ?? basePrice);

        if (price == null || Number.isNaN(price)) {
          // Safety fallback for any weird variant with no price
          price = 0.01;
        }

        const outOfStock =
          placement?.supplier_out_of_stock || !placement?.in_stock;

        return {
          option1: v.label || `Variant ${index + 1}`,
          price: Number(price).toFixed(2),
          compare_at_price:
            !forceDraft && salePrice && basePrice
              ? Number(basePrice).toFixed(2)
              : undefined,
          sku: v.sku || `FIRESTORE-${docSnap.id}-${index + 1}`,
          barcode: v.barcode || undefined,
          inventory_policy: outOfStock ? "deny" : "continue",
          inventory_management: "shopify",
          inventory_quantity: outOfStock ? 0 : undefined,
          requires_shipping: true,
        };
      });

      return {
        data,
        payload: {
          product: {
            title: product.title,
            body_html: desc,
            vendor,
            tags: Array.from(tagSet).join(", "),
            images,
            options: [
              {
                name: "Option",
                values: variants.map((v) => v.label || "Default"),
              },
            ],
            variants: shopifyVariants,
            status:
              forceDraft || placement?.isActive === false
                ? "draft"
                : "active",
            metafields: [
              {
                namespace: "global",
                key: "condition",
                type: "single_line_text_field",
                value: "new",
              },
            ],
            published_scope: "global",
          },
        },
      };
    },

    processResult: async (docSnap, ctx) => {
      if (!ctx) return;

      const { data, payload, skip } = ctx;
      const shopifyMeta = data.shopify || {};
      let productId = shopifyMeta.productId;
      let res;

      if (skip === "rental") {
        if (productId) await shopifyDeleteProduct(productId);
        return;
      }

      const deduped = await findAndDeduplicateShopifyProducts({
        fid: docSnap.id,
        preferredId: productId,
        title: data?.product?.title,
        vendor: payload?.product?.vendor,
      });

      if (deduped) productId = deduped.id;

      if (productId) {
        try {
          res = await shopifyFetch(`products/${productId}.json`, {
            method: "PUT",
            body: payload,
          });
        } catch (e) {
          if (String(e).includes("404")) {
            res = await shopifyFetch("products.json", {
              method: "POST",
              body: payload,
            });
            productId = res.product.id;
          } else throw e;
        }
      } else {
        res = await shopifyFetch("products.json", {
          method: "POST",
          body: payload,
        });
        productId = res.product.id;
      }

      const variantIds = res.product.variants?.map((v) => v.id) || [];

      await updateDoc(docSnap.ref, {
        shopify: {
          ...(shopifyMeta || {}),
          productId,
          handle: res.product.handle,
          variantIds,
          lastSyncedAt: now(),
        },
      });
    },
  });
}

/* ============= ROUTE ============= */

export async function POST(req) {
  try {
    if (SHOPIFY_SYNC_SECRET) {
      const headerSecret = req.headers.get("x-sync-secret");
      const url = new URL(req.url);
      const qsSecret = url.searchParams.get("secret");

      if (
        headerSecret !== SHOPIFY_SYNC_SECRET &&
        qsSecret !== SHOPIFY_SYNC_SECRET
      )
        return err(401, "Unauthorized", "Invalid sync secret.");
    }

    const url = new URL(req.url);
    const scope = url.searchParams.get("scope") || "full";
    const full = scope === "full";

    const results = {
      categories: null,
      subCategories: null,
      brands: null,
      products: null,
    };

    if (scope === "full" || scope === "categories")
      results.categories = await syncCategories({ full });

    if (scope === "full" || scope === "subCategories")
      results.subCategories = await syncSubCategories({ full });

    if (scope === "full" || scope === "brands")
      results.brands = await syncBrands({ full });

    // if (scope === "full" || scope === "products")
    //   results.products = await syncProducts({ full });

    return ok({ data: results });
  } catch (e) {
    console.error("Shopify sync failed", e);
    return err(500, "Shopify Sync Failed", String(e));
  }
}

export async function GET(req) {
  return POST(req);
}
