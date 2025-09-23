export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

function authHeader() {
  const apiKey = process.env.PRINTNODE_API_KEY;
  if (!apiKey) throw new Error("PRINTNODE_API_KEY not set");
  return "Basic " + Buffer.from(apiKey + ":").toString("base64");
}

async function resolvePrinterId({ printerId, printerName }) {
  if (printerId) return Number(printerId);
  if (!printerName) throw new Error("Missing printerId or printerName");
  const r = await fetch("https://api.printnode.com/printers", {
    headers: { Authorization: authHeader() }
  });
  const list = await r.json();
  if (!r.ok) throw new Error("PrintNode /printers failed");
  const nameLC = printerName.toLowerCase();
  const hit =
    list.find(p => (p.name || "").toLowerCase() === nameLC) ||
    list.find(p => (p.name || "").toLowerCase().includes(nameLC));
  if (!hit) throw new Error(`Printer "${printerName}" not found`);
  return hit.id;
}

/**
 * Resident format R:SUREMIX.FMT for 45×25 mm (PW≈532, LL≈300), landscape
 * - Rounded border
 * - QR left  (FN1)
 * - Right column:
 *   line 1: issuingCompany (bigger)              (FN2)
 *   line 2: prodTitle                            (FN4)
 *   line 3: Serial: <value> (slightly smaller)   (FN5)
 *
 * Note: companyName removed; FN3 omitted.
 */
function buildInstallZpl() {
  return [
    "^XA",
    "^DFR:SUREMIX.FMT^FS",      // store format in RAM as SUREMIX.FMT
    "^CI28",
    "^PW532","^LL300",
    // border
    "^FO8,8^GB516,284,3,B,24^FS",
    // QR placeholder (field 1) — we’ll feed ^FDQA,<serial> at print time
    "^FO40,30^BQN,2,8^FN1^FS",
    // Right column (bigger first line)
    "^FO260,60^A0N,30,30^FN2^FS",   // issuingCompany (e.g., BEVGO)
    "^FO260,90^A0N,22,22^FN4^FS",   // prodTitle (moved up to fill removed line)
    "^FO260,116^A0N,20,20^FN5^FS",  // Serial: <...> (moved up)
    "^XZ"
  ].join("\n");
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { printerId, printerName } = body || {};
    const id = await resolvePrinterId({ printerId, printerName });

    const zpl = buildInstallZpl();
    const r = await fetch("https://api.printnode.com/printjobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader()
      },
      body: JSON.stringify({
        printerId: id,
        title: "Install SUREMIX.FMT",
        contentType: "raw_base64",
        content: Buffer.from(zpl, "utf8").toString("base64"),
        source: "Suremix"
      })
    });
    const data = await r.json();
    if (!r.ok) return NextResponse.json({ error: "PrintNode error", details: data }, { status: 502 });
    return NextResponse.json({ ok: true, job: data, template: "E:SUREMIX.FMT" });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
