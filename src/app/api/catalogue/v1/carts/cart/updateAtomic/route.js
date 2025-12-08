/* eslint-disable import/namespace */
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { runTransaction } from "firebase/firestore";
import { updateCartAtomic } from "./functions";

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

/* ------------------ POST ------------------ */
export async function POST(request) {
  let body;

  try {
    body = await request.json();
  } catch {
    return err(400, "Bad Request", "Request JSON body required");
  }

  if (!body?.customerId) {
    return err(400, "Missing Input", "customerId required");
  }

  try {
    const result = await runTransaction(db, (tx) => updateCartAtomic(tx, body));

    const { _ui, _generatedKey, ...clean } = result ?? {};

    return ok(
      { ...clean, generatedKey: _generatedKey ?? null },
      _ui ?? null,
      200
    );
  } catch (e) {
    console.error("[updateAtomic]", e);

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
