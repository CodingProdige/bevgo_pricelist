// app/api/printnode/clear/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

function authHeader() {
  const apiKey = process.env.PRINTNODE_API_KEY;
  if (!apiKey) throw new Error("PRINTNODE_API_KEY not set");
  return "Basic " + Buffer.from(apiKey + ":").toString("base64");
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { printerId, jobIds, all } = body || {};

    let url = null;

    if (Array.isArray(jobIds) && jobIds.length) {
      // Cancel specific job ids: DELETE /printjobs/{PRINT_JOB_SET}
      url = `https://api.printnode.com/printjobs/${jobIds.join(",")}`;
    } else if (Number.isInteger(printerId)) {
      // Cancel all jobs for a printer: DELETE /printers/{PRINTER_SET}/printjobs
      url = `https://api.printnode.com/printers/${printerId}/printjobs`;
    } else if (all === true) {
      // Cancel ALL jobs on the account: DELETE /printjobs
      url = `https://api.printnode.com/printjobs`;
    } else {
      return NextResponse.json(
        { error: "Provide jobIds[], or printerId, or all:true" },
        { status: 400 }
      );
    }

    const resp = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: authHeader() },
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return NextResponse.json(
        { error: "PrintNode delete failed", details: data },
        { status: 502 }
      );
    }
    // PrintNode returns the list of cancelled ids
    return NextResponse.json({ ok: true, cancelled: data });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
