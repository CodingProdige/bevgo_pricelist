export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

export async function GET() {
  const apiKey = process.env.PRINTNODE_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "PRINTNODE_API_KEY not set" }, { status: 500 });

  const r = await fetch("https://api.printnode.com/printers", {
    headers: { Authorization: "Basic " + Buffer.from(apiKey + ":").toString("base64") }
  });
  const data = await r.json();
  if (!r.ok) return NextResponse.json({ error: "PrintNode error", details: data }, { status: 502 });

  // trim to useful fields
  const simplified = data.map(p => ({
    id: p.id,
    name: p.name,
    computer: p.computer && p.computer.name,
    state: p.state
  }));
  return NextResponse.json({ printers: simplified });
}
