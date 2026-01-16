/* eslint-disable import/namespace */
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs, query, runTransaction, where } from "firebase/firestore";
import { updateOrderAtomic } from "./functions";

/* ------------------ HELPERS ------------------ */
const ok = (data = {}, ui = null, status = 200) =>
  NextResponse.json({ ok: true, data, ui }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error", ui = null) => {
  status = Number(status);
  if (!status || status < 200 || status > 599) status = 500;

  return NextResponse.json(
    { ok: false, title, message, ui },
    { status }
  );
};

async function resolveOrderId(orderId, orderNumber) {
  if (orderId) return orderId;
  if (!orderNumber) return null;

  const matchSnap = await getDocs(
    query(
      collection(db, "orders_v2"),
      where("order.orderNumber", "==", orderNumber)
    )
  );

  if (matchSnap.size > 1) {
    throw { code: 409, title: "Multiple Orders Found", message: "Multiple orders match this orderNumber." };
  }

  if (matchSnap.empty) return null;
  return matchSnap.docs[0].id;
}

/* ------------------ POST ------------------ */
export async function POST(request) {
  let body;

  try {
    body = await request.json();
  } catch {
    return err(400, "Bad Request", "Request JSON body required");
  }

  if (!body?.orderId && !body?.orderNumber) {
    return err(400, "Missing Input", "orderId or orderNumber required");
  }

  try {
    const resolvedOrderId = await resolveOrderId(body?.orderId, body?.orderNumber);
    if (!resolvedOrderId) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    const result = await runTransaction(db, (tx) =>
      updateOrderAtomic(tx, { ...body, orderId: resolvedOrderId })
    );

    const { _ui, _generatedKey, ...clean } = result ?? {};

    return ok(
      { ...clean, generatedKey: _generatedKey ?? null },
      _ui ?? null,
      200
    );
  } catch (e) {
    console.error("[updateOrderAtomic]", e);

    return err(
      e.code ?? 500,
      e.title ?? "Transaction Failed",
      e.message ?? "Unexpected error occurred",
      e.ui ?? null
    );
  }
}

/* ------------------ NEXT CONFIG ------------------ */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
