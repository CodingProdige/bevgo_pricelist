export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

const ok = (p = {}, s = 200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, x = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...x }, { status: s });

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";
const SHOPIFY_SYNC_SECRET = process.env.SHOPIFY_SYNC_SECRET;
const SHOPIFY_PUBLICATION_IDS = process.env.SHOPIFY_PUBLICATION_IDS || "";

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

async function fetchTaggedProductIds(tag) {
  const ids = [];
  let cursor = null;

  const query = `
    query Products($cursor: String, $query: String) {
      products(first: 250, after: $cursor, query: $query) {
        pageInfo { hasNextPage }
        edges {
          cursor
          node { id }
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
    for (const edge of edges) ids.push(edge.node.id);

    if (data.products?.pageInfo?.hasNextPage) {
      cursor = edges[edges.length - 1]?.cursor || null;
    } else {
      cursor = null;
    }
  } while (cursor);

  return ids;
}

async function stagedUpload(jsonl) {
  const bytes = new TextEncoder().encode(jsonl).length;

  const staged = await shopifyGraphQL(`
    mutation {
      stagedUploadsCreate(input: [{
        resource: BULK_MUTATION_VARIABLES
        filename: "publish.jsonl"
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

  return stagedPath;
}

export async function POST(req) {
  try {
    if (SHOPIFY_SYNC_SECRET) {
      const url = new URL(req.url);
      if (url.searchParams.get("secret") !== SHOPIFY_SYNC_SECRET) {
        return err(401, "Unauthorized", "Invalid sync secret.");
      }
    }

    const url = new URL(req.url);
    const tag = url.searchParams.get("tag") || "bevgo_source";

    const publicationIds = SHOPIFY_PUBLICATION_IDS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!publicationIds.length) {
      return err(
        400,
        "Missing Publication IDs",
        "Set SHOPIFY_PUBLICATION_IDS to a comma-separated list."
      );
    }

    const productIds = await fetchTaggedProductIds(tag);
    if (!productIds.length) {
      return err(404, "No Products", `No Shopify products found for tag "${tag}".`);
    }

    const lines = [];
    for (const id of productIds) {
      for (const publicationId of publicationIds) {
        lines.push(
          JSON.stringify({
            id,
            input: {
              publicationId,
            },
          })
        );
      }
    }

    const jsonl = lines.join("\n");
    const stagedUploadPath = await stagedUpload(jsonl);

    const run = await shopifyGraphQL(`
      mutation {
        bulkOperationRunMutation(
          mutation: "
            mutation call($id: ID!, $input: PublishablePublishInput!) {
              publishablePublish(id: $id, input: $input) {
                publishable { id }
                userErrors { field message }
              }
            }
          ",
          stagedUploadPath: "${stagedUploadPath}"
        ) {
          bulkOperation { id status }
          userErrors { message }
        }
      }
    `);

    return ok({ data: run, productCount: productIds.length });
  } catch (e) {
    console.error("Bulk Publish Failed", e);
    return err(500, "Bulk Publish Failed", String(e));
  }
}
