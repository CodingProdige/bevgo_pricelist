// app/api/catalogue/v1/products/ai-description/route.js
import { NextResponse } from "next/server";

const ok  = (p={}, s=200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e={}) => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

async function fetchWithRetries(url, init, tries = 2){
  let last;
  for (let i = 0; i < tries; i++){
    const res = await fetch(url, init);
    if (res.ok) return res;
    last = res;
    if (res.status === 429 || res.status >= 500) {
      await new Promise(r => setTimeout(r, 600 + 500*i));
      continue;
    }
    break;
  }
  const text = await last.text().catch(()=> "");
  const details = `Upstream ${last.status} ${last.statusText}: ${text.slice(0,800)}`;
  throw new Error(details);
}

function extractText(json){
  // Preferred (Responses API convenience field)
  if (typeof json?.output_text === "string" && json.output_text.trim()) {
    return json.output_text.trim();
  }
  // Generic Responses API structure
  if (Array.isArray(json?.output)) {
    const parts = [];
    for (const item of json.output) {
      const content = item?.content || [];
      for (const c of content) {
        if (typeof c?.text === "string") parts.push(c.text);
      }
    }
    const joined = parts.join("").trim();
    if (joined) return joined;
  }
  // Fallback if the provider returned Chat-style shape
  const choice = json?.choices?.[0]?.message?.content;
  if (typeof choice === "string" && choice.trim()) return choice.trim();
  return "";
}

export async function POST(req){
  try{
    const { title, word_limit = 40 } = await req.json();
    if (!title || !String(title).trim()){
      return err(400, "Missing Title", "Provide a product 'title'.");
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return err(500, "Missing API Key", "OPENAI_API_KEY is not set.");

    const wl = clamp(Number(word_limit)||40, 25, 70);

    const instructions = [
      "You are a product copywriter for a South African B2B beverage distributor.",
      `Write ONE short paragraph of about ${wl} words in a professional, neutral tone.`,
      "No emojis. No exclamation marks. Avoid hype; be concrete.",
      "Infer product type and typical uses from the title alone (do not ask questions).",
      "End with: 'Typical uses: …' followed by 2–4 concise items."
    ].join(" ");

    const input = `Title: ${String(title).trim()}`;

    const res = await fetchWithRetries("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        instructions,
        input
      }),
    });

    const json = await res.json();
    if (json?.error) {
      throw new Error(`${json.error?.type || "error"}: ${json.error?.message || "Unknown error"}`);
    }

    const description = extractText(json);
    if (!description) {
      throw new Error("Empty output_text/content in upstream response");
    }

    return ok({ title, description });

  } catch (e){
    // Helpful fallback + diagnostics
    let fallback = "Professional, reliable product for hospitality and retail service. Typical uses: front-of-house service, events, retail fridges.";
    try {
      const { title } = await req.json();
      if (title) fallback = `${String(title).trim()}. Professional, reliable supply for hospitality operations. Typical uses: front-of-house service, events, retail supply.`;
    } catch {}
    return err(502, "AI Request Failed", "Falling back to a safe local description.", {
      details: String(e?.message||"").slice(0,800),
      fallback
    });
  }
}
