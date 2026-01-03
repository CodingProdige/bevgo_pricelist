export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";
const SHOPIFY_SYNC_SECRET = process.env.SHOPIFY_SYNC_SECRET;

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, t, m) =>
  NextResponse.json({ ok: false, title: t, message: m }, { status: s });

async function shopifyFetch(path, opts = {}) {
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN)
    throw new Error("Shopify env vars missing");

  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/${path}`;

  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Shopify ${opts.method || "GET"} ${path} failed: ${res.status} - ${text}`
    );
  }

  return res.json();
}

// delete one product
async function deleteProduct(id) {
  await shopifyFetch(`products/${id}.json`, { method: "DELETE" });
}

// list products (paginated)
async function listProducts(limit = 100, pageInfo = null) {
  let path = `products.json?limit=${limit}`;
  if (pageInfo) path += `&page_info=${pageInfo}`;

  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/${path}`;
  const res = await fetch(url, {
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`List products failed: ${res.status} - ${text}`);
  }

  const data = await res.json();
  const linkHeader = res.headers.get("link") || "";
  const nextMatch = linkHeader.match(/<([^>]+)>; rel="next"/);
  const next =
    nextMatch && new URL(nextMatch[1]).searchParams.get("page_info");

  return { products: data.products || [], next };
}

export async function POST(req) {
  try {
    // guard
    if (SHOPIFY_SYNC_SECRET) {
      const headerSecret = req.headers.get("x-sync-secret");
      const url = new URL(req.url);
      const qsSecret = url.searchParams.get("secret");
      if (headerSecret !== SHOPIFY_SYNC_SECRET && qsSecret !== SHOPIFY_SYNC_SECRET)
        return err(401, "Unauthorized", "Invalid sync secret.");
    }

    let deleted = 0;
    let pageInfo = null;

    while (true) {
      const { products, next } = await listProducts(100, pageInfo);
      if (!products.length) break;

      for (const p of products) {
        try {
          await deleteProduct(p.id);
          deleted++;
          // VERY light rate-limit protection
          await new Promise((r) => setTimeout(r, 120));
        } catch (e) {
          console.error("Delete failed", p.id, e);
        }
      }

      if (!next) break;
      pageInfo = next;
    }

    return ok({
      message: "All products removed",
      deleted,
    });
  } catch (e) {
    console.error("Nuke failed", e);
    return err(500, "Delete Failed", String(e));
  }
}

export async function GET(req) {
  return POST(req);
}
