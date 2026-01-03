export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

const ok = (p={},s=200)=>NextResponse.json({ok:true,...p},{status:s});
const err=(s,t,m,x={})=>NextResponse.json({ok:false,title:t,message:m,...x},{status:s});

async function shopifyGraphQL(query, variables = {}) {
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

async function fetchBulkOperationById(id) {
  const data = await shopifyGraphQL(
    `
      query BulkOp($id: ID!) {
        node(id: $id) {
          ... on BulkOperation {
            id
            status
            errorCode
            createdAt
            completedAt
            objectCount
            url
          }
        }
      }
    `,
    { id }
  );

  return data.node;
}

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const ids = (url.searchParams.get("id") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    let ops = [];

    if (ids.length) {
      for (const id of ids) {
        const op = await fetchBulkOperationById(id);
        if (op) ops.push(op);
      }
    } else {
      const data = await shopifyGraphQL(`
        query latestBulk {
          currentBulkOperation {
            id
            status
            errorCode
            createdAt
            completedAt
            objectCount
            url
          }
        }
      `);

      if (data.currentBulkOperation) ops = [data.currentBulkOperation];
    }

    if (!ops.length) return ok({ message: "No bulk operation found" });

    const results = [];

    for (const op of ops) {
      if (op.status === "CREATED" || op.status === "RUNNING") {
        results.push({
          status: op.status,
          message: "Bulk sync still processing",
          operation: op,
        });
        continue;
      }

      let rows = [];
      if (op.url) {
        const res = await fetch(op.url);
        const text = await res.text();
        rows = text
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      }

      const failures = rows.filter(
        (r) => r?.__typename === "BulkOperationError"
      );

      results.push({
        status: op.status,
        completedAt: op.completedAt,
        totalObjects: op.objectCount,
        errors: failures,
        resultsUrl: op.url,
        operationId: op.id,
      });
    }

    return ok({ operations: results });

  } catch (e) {
    console.error(e);
    return err(500, "Bulk Status Failed", String(e));
  }
}

export async function POST() {
  return GET();
}
