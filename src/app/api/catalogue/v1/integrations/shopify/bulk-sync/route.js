export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";

const ok = (p={},s=200)=>NextResponse.json({ok:true,...p},{status:s});
const err=(s,t,m,x={})=>NextResponse.json({ok:false,title:t,message:m,...x},{status:s});

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";
const SHOPIFY_SYNC_SECRET = process.env.SHOPIFY_SYNC_SECRET;

const PRODUCTS_COLLECTION = "products_v2";

/* GRAPHQL helper */
async function shopifyGraphQL(query, variables) {
  const res = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(JSON.stringify(json.errors || json));
  }
  return json.data;
}

const ACCEPTED_IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
const ACCEPTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

async function normalizeImagesForBulk(media, altText) {
  if (!Array.isArray(media?.images)) return [];

  const sorted = media.images
    .slice()
    .sort((a, b) => (a.position || 0) - (b.position || 0));

  const out = [];

  for (const img of sorted) {
    const url = img?.imageUrl;
    if (!url) continue;

    const clean = url.split("?")[0].toLowerCase();
    const extAllowed = ACCEPTED_IMAGE_EXTS.some((ext) => clean.endsWith(ext));
    let typeAllowed = false;

    try {
      const head = await fetch(url, { method: "HEAD" });
      if (head.ok) {
        const ct = head.headers.get("content-type") || "";
        const type = ct.split(";")[0].trim().toLowerCase();
        typeAllowed = ACCEPTED_IMAGE_TYPES.has(type);
      }
    } catch (e) {
      console.warn("Image HEAD failed", url, e);
    }

    if (extAllowed || typeAllowed) {
      out.push({ mediaContentType: "IMAGE", originalSource: url, alt: altText });
      continue;
    }

    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const base64 = buf.toString("base64");
      out.push({ mediaContentType: "IMAGE", attachment: base64, alt: altText });
    } catch (e) {
      console.warn("Image download failed", url, e);
    }
  }

  return out;
}

function buildGoogleCategory(grouping) {
  const category = (grouping?.category || "").toLowerCase();
  const subCategory = (grouping?.subCategory || "").toLowerCase();

  const has = (s) => subCategory.includes(s);

  if (category === "water" || has("water")) {
    return {
      googleProductCategory: "Food, Beverages & Tobacco > Beverages > Water",
      productType: "Beverages > Water",
    };
  }

  if (category === "mixers") {
    if (has("soft")) {
      return {
        googleProductCategory:
          "Food, Beverages & Tobacco > Beverages > Soft Drinks",
        productType: "Beverages > Soft Drinks",
      };
    }
    if (has("juice")) {
      return {
        googleProductCategory:
          "Food, Beverages & Tobacco > Beverages > Juice",
        productType: "Beverages > Juice",
      };
    }
    if (has("tonic")) {
      return {
        googleProductCategory:
          "Food, Beverages & Tobacco > Beverages > Soft Drinks",
        productType: "Beverages > Tonic Water",
      };
    }
    if (has("water")) {
      return {
        googleProductCategory:
          "Food, Beverages & Tobacco > Beverages > Water",
        productType: "Beverages > Water",
      };
    }
    return {
      googleProductCategory: "Food, Beverages & Tobacco > Beverages",
      productType: "Beverages > Mixers",
    };
  }

  if (category === "liquor") {
    return {
      googleProductCategory:
        "Food, Beverages & Tobacco > Beverages > Alcoholic Beverages",
      productType: "Beverages > Alcoholic Beverages",
    };
  }

  if (category === "gas") {
    return {
      googleProductCategory: "Business & Industrial > Industrial Storage",
      productType: "Industrial > Gas",
    };
  }

  return {
    googleProductCategory: "Food, Beverages & Tobacco > Beverages",
    productType: "Beverages",
  };
}

function buildHandle(title) {
  const base = String(title || "product").toLowerCase();
  return base
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 255);
}

function buildProductInput(docId, data, existingVariants = []) {
  const { grouping, product, media, placement, variants } = data || {};

  if (!product?.title) return null;
  if (!grouping?.category || !grouping?.subCategory || !grouping?.brand)
    return null;
  if (!Array.isArray(variants) || !variants.length) return null;

  const isRental = variants.every((v) => v?.rental?.is_rental === true);
  if (isRental) return null;

  const hasPrice = variants.some(
    (v) =>
      typeof v?.pricing?.selling_price_excl === "number" &&
      v.pricing.selling_price_excl > 0
  );

  const forceDraft = !hasPrice;

  const desc =
    product.description ||
    `${product.title} — available from Bevgo. Fast delivery, competitive pricing, loyalty rebates and bulk options.`;

  const tagSet = new Set(product.keywords || []);
  tagSet.add(`category:${grouping.category}`);
  tagSet.add(`subcategory:${grouping.subCategory}`);
  tagSet.add(`brand:${grouping.brand}`);
  tagSet.add("bevgo_source");
  if (placement?.isFeatured) tagSet.add("featured");
  if (placement?.supplier_out_of_stock) tagSet.add("supplier_out_of_stock");
  if (!placement?.in_stock) tagSet.add("out_of_stock");
  tagSet.add(`bevgo_fid:${docId}`);

  const { googleProductCategory, productType } = buildGoogleCategory(grouping);

  const optionName = "Title";
  const optionValueNames = [];
  const seenVariantKeys = new Set();
  const normalizedVariants = [];

  for (const v of variants) {
    const label = (v?.label || "").trim().toLowerCase();
    const sku = (v?.sku || "").trim().toLowerCase();
    const key = sku ? `sku:${sku}` : `label:${label}`;
    if (seenVariantKeys.has(key)) continue;
    seenVariantKeys.add(key);
    normalizedVariants.push(v);
  }

  const bySku = new Map();
  const byLabel = new Map();

  for (const v of existingVariants) {
    const skuKey = v?.sku ? v.sku.trim().toLowerCase() : null;
    const labelKey = v?.title ? v.title.trim().toLowerCase() : null;
    if (skuKey) bySku.set(skuKey, v.id);
    if (labelKey) byLabel.set(labelKey, v.id);
  }

  const shopifyVariants = normalizedVariants.map((v, index) => {
    const baseExcl = v?.pricing?.selling_price_excl;
    const baseIncl =
      typeof baseExcl === "number" ? Number(baseExcl) * 1.15 : null;
    const saleEligible =
      v?.sale?.is_on_sale === true &&
      v?.sale?.disabled_by_admin !== true &&
      Number(v?.sale?.qty_available || 0) > 0 &&
      typeof v?.sale?.sale_price_excl === "number" &&
      v.sale.sale_price_excl > 0;
    const explicitSaleExcl = v?.sale?.sale_price_excl;
    const saleExcl =
      saleEligible && typeof baseExcl === "number"
        ? Number(explicitSaleExcl)
        : null;
    const saleIncl =
      saleExcl != null ? Number(saleExcl) * 1.15 : null;

    let price = forceDraft ? 0.01 : (saleIncl ?? baseIncl);
    if (price == null || Number.isNaN(price)) price = 0.01;

    const label = v.label || `Variant ${index + 1}`;
    optionValueNames.push(label);

    const skuKey = v?.sku ? v.sku.trim().toLowerCase() : null;
    const labelKey = label.trim().toLowerCase();
    const existingId = (skuKey && bySku.get(skuKey)) || byLabel.get(labelKey);

    return {
      ...(existingId ? { id: existingId } : {}),
      optionValues: [{ optionName, name: label }],
      price: Number(price).toFixed(2),
      compareAtPrice:
        !forceDraft && saleEligible && baseIncl != null
          ? Number(baseIncl).toFixed(2)
          : undefined,
      sku: v.sku || `FIRESTORE-${docId}-${index + 1}`,
      barcode: v.barcode || undefined,
    };
  });

  const productOptions = [
    {
      name: optionName,
      values: Array.from(new Set(optionValueNames)).map((name) => ({ name })),
    },
  ];

  return {
    title: product.title,
    descriptionHtml: desc,
    vendor: grouping.brand,
    handle: buildHandle(product.title),
    tags: Array.from(tagSet),
    productOptions,
    variants: shopifyVariants,
    productType,
    status: forceDraft || placement?.isActive === false ? "DRAFT" : "ACTIVE",
    metafields: [
      {
        namespace: "global",
        key: "condition",
        type: "single_line_text_field",
        value: "new",
      },
      {
        namespace: "google",
        key: "google_product_category",
        type: "single_line_text_field",
        value: googleProductCategory,
      },
    ],
  };
}

async function fetchShopifyProductsByTag(tag) {
  const products = [];
  let cursor = null;

  const query = `
    query Products($cursor: String, $query: String) {
      products(first: 250, after: $cursor, query: $query) {
        pageInfo { hasNextPage }
        edges {
          cursor
          node {
            id
            handle
            tags
            variants(first: 100) {
              edges {
                node {
                  id
                  sku
                  title
                }
              }
            }
          }
        }
      }
    }
  `;

  const queryString = tag ? `tag:${tag}` : "";

  do {
    const data = await shopifyGraphQL(query, {
      cursor,
      query: queryString,
    });

    const edges = data.products?.edges || [];
    for (const edge of edges) products.push(edge.node);

    if (data.products?.pageInfo?.hasNextPage) {
      cursor = edges[edges.length - 1]?.cursor || null;
    } else {
      cursor = null;
    }
  } while (cursor);

  return products;
}

function extractFidFromTags(tags = []) {
  const hit = tags.find((t) => t.startsWith("bevgo_fid:"));
  return hit ? hit.replace("bevgo_fid:", "") : null;
}

function toProductGid(id) {
  if (!id) return null;
  if (String(id).startsWith("gid://shopify/Product/")) return id;
  return `gid://shopify/Product/${id}`;
}

async function runBulkMutation(mutation, jsonl) {
  const bytes = new TextEncoder().encode(jsonl).length;

  const staged = await shopifyGraphQL(`
    mutation {
      stagedUploadsCreate(input: [{
        resource: BULK_MUTATION_VARIABLES
        filename: "bulk.jsonl"
        mimeType: "text/jsonl"
        httpMethod: POST
        fileSize: "${bytes}"
      }]) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { message }
      }
    }
  `);

  if (staged.stagedUploadsCreate.userErrors?.length) {
    throw new Error(JSON.stringify(staged.stagedUploadsCreate.userErrors));
  }

  const target = staged.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([jsonl], { type: "text/jsonl" }));

  const up = await fetch(target.url, { method: "POST", body: form });
  if (!up.ok) throw new Error(await up.text());

  const stagedPathFromUrl = target.resourceUrl
    ? target.resourceUrl.startsWith("http")
      ? new URL(target.resourceUrl).pathname.replace(/^\/+/, "")
      : target.resourceUrl
    : "";
  const stagedKey = target.parameters?.find((p) => p.name === "key")?.value || "";
  const stagedPath = stagedPathFromUrl || stagedKey;

  if (!stagedPath) throw new Error("Missing staged upload path from Shopify.");

  return shopifyGraphQL(`
    mutation {
      bulkOperationRunMutation(
        mutation: "${mutation}",
        stagedUploadPath: "${stagedPath}"
      ) {
        bulkOperation { id status }
        userErrors { message }
      }
    }
  `);
}

async function getCurrentBulkOperation() {
  const data = await shopifyGraphQL(`
    query latestBulk {
      currentBulkOperation {
        id
        status
        errorCode
      }
    }
  `);
  return data.currentBulkOperation;
}

/* ROUTE */
export async function POST(req) {
  try {
    console.log("[bulk-sync] start");
    if (SHOPIFY_SYNC_SECRET) {
      const url = new URL(req.url);
      if (url.searchParams.get("secret") !== SHOPIFY_SYNC_SECRET)
        return err(401, "Unauthorized", "Invalid sync secret.");
    }

    const url = new URL(req.url);
    const phase = url.searchParams.get("phase") || "";

    const snap = await getDocs(collection(db, PRODUCTS_COLLECTION));
    const firestore = new Map();

    for (const doc of snap.docs) {
      firestore.set(doc.id, doc.data());
    }

    console.log(`[bulk-sync] firestore products: ${firestore.size}`);
    if (!firestore.size) return err(400, "No Products", "No products to sync.");

    const shopifyProducts = await fetchShopifyProductsByTag("bevgo_source");
    const shopifyByFid = new Map();
    const shopifyOrphans = [];

    for (const p of shopifyProducts) {
      const fid = extractFidFromTags(p.tags || []);
      if (fid) {
        if (!shopifyByFid.has(fid)) shopifyByFid.set(fid, []);
        shopifyByFid.get(fid).push(p);
      } else {
        shopifyOrphans.push(p);
      }
    }

    console.log(
      `[bulk-sync] shopify products tagged bevgo_source: ${shopifyProducts.length}`
    );

    const createLines = [];
    const updateLines = [];
    const deleteLines = [];
    const mediaLines = [];
    const shouldPrepareMedia = phase === "media";
    const handleOnly = phase === "handles";
    let mediaPlanned = 0;

    for (const [docId, data] of firestore.entries()) {
      const matches = shopifyByFid.get(docId) || [];
      const existingId = toProductGid(matches[0]?.id || null);
      const existingVariants =
        matches[0]?.variants?.edges?.map((e) => e.node) || [];

      const input = buildProductInput(docId, data, existingVariants);
      if (!input) continue;

      let images = [];
      if (shouldPrepareMedia) {
        images = await normalizeImagesForBulk(data.media, input.title);
      } else if (existingId && data?.media?.images?.length) {
        mediaPlanned += data.media.images.length;
      }

      if (existingId) {
        const existingHandle = matches[0]?.handle || "";
        const shouldUpdateHandle = input.handle !== existingHandle;
        if (!handleOnly || shouldUpdateHandle) {
          updateLines.push(
            JSON.stringify({
              input: {
                id: existingId,
                ...input,
              },
            })
          );
        }

        if (!handleOnly) {
          if (images.length) {
            mediaLines.push(
              JSON.stringify({
                productId: existingId,
                media: images,
              })
            );
          }

          if (matches.length > 1) {
            for (const dup of matches.slice(1)) {
              deleteLines.push(JSON.stringify({ id: toProductGid(dup.id) }));
            }
          }
        }
      } else if (!handleOnly) {
        createLines.push(JSON.stringify({ input }));
      }
    }

    if (!handleOnly) {
      for (const p of shopifyOrphans) {
        deleteLines.push(JSON.stringify({ id: toProductGid(p.id) }));
      }

      for (const [fid, products] of shopifyByFid.entries()) {
        if (!firestore.has(fid)) {
          for (const p of products)
            deleteLines.push(JSON.stringify({ id: toProductGid(p.id) }));
        }
      }
    }

    const results = {
      created: createLines.length,
      updated: updateLines.length,
      deleted: deleteLines.length,
      media: mediaLines.length,
      mediaPlanned,
      operations: {},
    };

    console.log(
      `[bulk-sync] plan: create=${results.created} update=${results.updated} delete=${results.deleted}`
    );

    const current = await getCurrentBulkOperation();
    if (current && (current.status === "CREATED" || current.status === "RUNNING")) {
      return ok({
        message: "Bulk operation already running. Try again later.",
        current,
        data: results,
      });
    }

    if (phase === "handles") {
      if (updateLines.length) {
        console.log("[bulk-sync] running bulk handle update");
        const run = await runBulkMutation(
          'mutation call($input: ProductSetInput!) { productSet(input: $input) { product { id } userErrors { message } } }',
          updateLines.join("\n")
        );
        results.operations.update = run;
      }
    } else if (phase === "media") {
      if (mediaLines.length) {
        console.log("[bulk-sync] running bulk media");
        const run = await runBulkMutation(
          'mutation call($productId: ID!, $media: [CreateMediaInput!]!) { productCreateMedia(productId: $productId, media: $media) { media { id } mediaUserErrors { field message } } }',
          mediaLines.join("\n")
        );
        results.operations.media = run;
      }
    } else if (createLines.length) {
      console.log("[bulk-sync] running bulk create");
      const run = await runBulkMutation(
        'mutation call($input: ProductSetInput!) { productSet(input: $input) { product { id } userErrors { message } } }',
        createLines.join("\n")
      );
      results.operations.create = run;
    } else if (updateLines.length) {
      console.log("[bulk-sync] running bulk update");
      const run = await runBulkMutation(
        'mutation call($input: ProductSetInput!) { productSet(input: $input) { product { id } userErrors { message } } }',
        updateLines.join("\n")
      );
      results.operations.update = run;
    } else if (deleteLines.length) {
      console.log("[bulk-sync] running bulk delete");
      const run = await runBulkMutation(
        'mutation call($id: ID!) { productDelete(input: { id: $id }) { deletedProductId userErrors { message } } }',
        deleteLines.join("\n")
      );
      results.operations.delete = run;
    } else if (mediaLines.length) {
      console.log("[bulk-sync] running bulk media");
      const run = await runBulkMutation(
        'mutation call($productId: ID!, $media: [CreateMediaInput!]!) { productCreateMedia(productId: $productId, media: $media) { media { id } mediaUserErrors { field message } } }',
        mediaLines.join("\n")
      );
      results.operations.media = run;
    }

    console.log("[bulk-sync] submitted bulk operations");
    return ok({ data: results });

  } catch (e) {
    console.error("Bulk Sync Failed", e);
    return err(500,"Bulk Sync Failed",String(e));
  }
}

export async function GET(req) {
  return POST(req);
}
