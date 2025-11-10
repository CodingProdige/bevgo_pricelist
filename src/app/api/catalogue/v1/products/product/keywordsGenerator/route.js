// app/api/ai/keywords/generate/route.js
import { NextResponse } from "next/server";

/* ---------- helpers ---------- */
const ok  = (p = {}, s = 200) => NextResponse.json({ ok: true,  ...p }, { status: s });
const err = (s, t, m, e = {}) => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

// quick sanitizer → lower, trim internal spaces, de-dupe, keep words/numbers/&-/+
function cleanList(raw, max = 12) {
  const items = String(raw || "")
    .replace(/\s*,\s*/g, ",")
    .split(",")
    .map(s => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map(s => s.replace(/[^a-z0-9 \-+&/]/gi, "")) // keep basic useful chars
    .map(s => s.toLowerCase());

  const seen = new Set();
  const out = [];
  for (const k of items) {
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
      if (out.length >= max) break;
    }
  }
  return out;
}

function localFallback(title, max = 12) {
  // naive keyword guess from the title
  const base = String(title || "")
    .toLowerCase()
    .replace(/[^\w\s+&/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const stop = new Set([
    "the","a","an","and","or","of","for","with","to","in","on","by","from","at",
    "sparkling","still","bottled","drink","drinks","water","beverage","beverages",
    "ml","l","lt","liter","litre","pack","case","bottle","cans","can","single"
  ]);

  const tokens = base.split(" ").filter(w => w && !stop.has(w) && w.length > 2);
  const dedup  = [];
  const seen   = new Set();
  for (const t of tokens) {
    if (!seen.has(t)) { seen.add(t); dedup.push(t); }
    if (dedup.length >= max) break;
  }
  return dedup;
}

/* ---------- route ---------- */
export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const title = String(body?.title ?? "").trim();
    const max   = Number.isFinite(+body?.max) && +body.max > 0 ? Math.min(24, Math.trunc(+body.max)) : 12;

    if (!title) {
      return err(400, "Missing Title", "Provide a non-empty 'title' in the JSON body.");
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      // no key → local fallback
      const list = localFallback(title, max);
      return ok({ title, keywords: list.join(", "), keywords_array: list, source: "fallback" }, 200);
    }

    // Prompt: keep it tight; return ONLY comma-separated keywords (no quotes, no labels)
    const sys = [
      "You are a product SEO assistant.",
      "Given a product title, output ONLY concise, search-friendly keywords separated by commas.",
      `Maximum ${max} keywords. No duplicates. No quotes. No extra text.`
    ].join(" ");

    const user = [
      `Title: "${title}"`,
      "Return only: keyword1, keyword2, keyword3"
    ].join("\n");

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ]
      })
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      // Rate-limit or quota issues → graceful fallback
      const list = localFallback(title, max);
      return err(502, "AI Request Failed", "Falling back to local keyword generation.", {
        details: text?.slice(0, 1200) || "Upstream error",
        fallback: list.join(", "),
        keywords_array: list
      });
    }

    const json = await resp.json().catch(() => ({}));
    const raw  = json?.choices?.[0]?.message?.content ?? "";
    if (!raw) {
      const list = localFallback(title, max);
      return err(502, "AI Request Failed", "Upstream returned an empty response. Using fallback.", {
        fallback: list.join(", "),
        keywords_array: list
      });
    }

    const cleaned = cleanList(raw, max);
    // if model returned junk, still ensure we have something usable
    const finalList = cleaned.length ? cleaned : localFallback(title, max);

    return ok({
      title,
      keywords: finalList.join(", "),
      keywords_array: finalList,
      source: "openai"
    }, 200);

  } catch (e) {
    // hard failure → local fallback
    const list = localFallback("", 10);
    return err(500, "Unexpected Error", "Failed to generate keywords. Returning a minimal fallback.", {
      details: String(e?.message || e || "").slice(0, 1200),
      fallback: list.join(", "),
      keywords_array: list
    });
  }
}
