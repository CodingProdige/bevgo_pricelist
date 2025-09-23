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

// (Light) ZPL-safe text — escape ^ and backslash. Keep it simple.
function esc(s = "") {
  return String(s).replace(/\\/g, "\\\\").replace(/\^/g, " ");
}

/** Recall resident format and inject values. QR encodes ONLY the serial. */
function buildRecallZpl({ issuingCompany, prodTitle, cylinderSerial }) {
  const qrData = `QA,${cylinderSerial}`; // ZPL QR flag + serial; scanner reads only the serial part
  const serialLine = `Serial: ${cylinderSerial}`;
  return [
    "^XA",
    "^XFR:SUREMIX.FMT^FS",         // recall the stored format
    `^FN1^FD${esc(qrData)}^FS`,    // QR data
    `^FN2^FD${esc(issuingCompany)}^FS`,
    `^FN3^FD^FS`,                  // intentionally blank to clear legacy companyName field if present
    `^FN4^FD${esc(prodTitle)}^FS`,
    `^FN5^FD${esc(serialLine)}^FS`,
    "^XZ"
  ].join("\n");
}

export async function POST(req) {
  try {
    const body = await req.json();

    const {
      printerId,
      printerName,
      copies = 1,
      issuingCompany,
      prodTitle,
      cylinderSerial,
      dryRun = false
    } = body || {};

    for (const k of ["issuingCompany", "prodTitle", "cylinderSerial"]) {
      if (!body?.[k]) return NextResponse.json({ error: `Missing ${k}` }, { status: 400 });
    }

    const id = await resolvePrinterId({ printerId, printerName });
    const zpl = buildRecallZpl({ issuingCompany, prodTitle, cylinderSerial });

    if (dryRun) return NextResponse.json({ zpl, printerId: id });

    const r = await fetch("https://api.printnode.com/printjobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader()
      },
      body: JSON.stringify({
        printerId: id,
        title: `Suremix ${cylinderSerial}`,
        contentType: "raw_base64",
        content: Buffer.from(zpl, "utf8").toString("base64"),
        source: "Suremix",
        qty: copies,
        options: { copies }
      })
    });

    const data = await r.json();
    if (!r.ok)
      return NextResponse.json({ error: "PrintNode error", details: data }, { status: 502 });

    return NextResponse.json({ ok: true, job: data, usedPrinterId: id });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
