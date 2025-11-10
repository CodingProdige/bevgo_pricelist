// app/api/catalogue/v1/products/variants/skuGenerator/route.js
import { NextResponse } from "next/server";

const ok  = (p={}, s=200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e={}) => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

const toStr = (v, f="") => (v == null ? f : String(v)).trim();

/* ---------- fallback helpers ---------- */
function slugifyPart(s){
  return String(s || "")
    .normalize("NFKC")
    .replace(/&/g, "AND")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toUpperCase() || "NA";
}
function extractVolume(text){
  const t = (text || "").toLowerCase();
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*(ml|l|lt|liter|litre|liters|litres)\b/i);
  if (!m) return { volume: "" };
  let n = m[1].replace(",", ".");
  const unit = m[2].toLowerCase();
  let ml = unit === "ml" ? parseFloat(n) : parseFloat(n) * 1000;
  if (!Number.isFinite(ml) || ml <= 0) return { volume: "" };
  if (ml % 1000 === 0) return { volume: `${ml/1000}L` };
  return { volume: `${Math.round(ml)}ML` };
}
function inferFlavor(title){
  const t = (title || "").toLowerCase();
  const table = [
    ["original","ORIGINAL"],["regular","ORIGINAL"],["classic","ORIGINAL"],
    ["zero","ZERO"],["sugar free","ZERO"],["no sugar","ZERO"],["diet","DIET"],
    ["vanilla","VANILLA"],["cherry","CHERRY"],["lemon-lime","LEMON-LIME"],
    ["lemon","LEMON"],["lime","LIME"],["orange","ORANGE"],["grape","GRAPE"],
    ["ginger","GINGER"],["peach","PEACH"],["apple","APPLE"],["tonic","TONIC"]
  ];
  for (const [n,l] of table){ if (t.includes(n)) return l; }
  return "ORIGINAL";
}
function inferUnits(variantLabel){
  const s = String(variantLabel || "");
  const m = s.match(/(\d+)\s*(?:x|×|-?\s*pack|\s*pk|\s*crate|\s*case)\b/i)
          || s.match(/(?:^|\s)(\d+)(?:\s*pack|\s*pk|\s*crate|\s*case)\b/i);
  if (m) return parseInt(m[1],10);
  if (/single/i.test(s)) return 1;
  const n = s.match(/\b(\d{1,3})\b/);
  if (n) return parseInt(n[1],10);
  return 1;
}
function inferType(title, variantLabel){
  const t = `${title} ${variantLabel}`.toLowerCase();
  if (t.includes("can")) return "CAN";
  if (t.includes("glass")) return "GLASS";
  if (t.includes("bottle")) return "BOTTLE";
  if (t.includes("crate")) return "CRATE";
  if (t.includes("pet")) return "PET";
  return "BOTTLE";
}
function buildSku({ brand, volume, type, flavor, units }){
  const BRAND  = slugifyPart(brand);
  const VOLUME = slugifyPart(volume);
  const TYPE   = slugifyPart(type);
  const FLAVOR = slugifyPart(flavor);
  const UNITS  = String(Number.isFinite(+units) && +units>0 ? Math.trunc(+units) : 1);
  return `${BRAND}-${VOLUME}-${TYPE}-${FLAVOR}-${UNITS}`;
}

/* ---------- route ---------- */
export async function POST(req){
  const body = await req.json().catch(()=> ({}));
  const product_title = toStr(body?.product_title);
  const variant_label = toStr(body?.variant_label);
  const brand_slug    = toStr(body?.brand_slug);

  if (!product_title) return err(400,"Missing Title","Provide 'product_title'.");
  if (!variant_label) return err(400,"Missing Variant","Provide 'variant_label'.");

  // Extract the rest using local inference only
  const { volume } = extractVolume(`${product_title} ${variant_label}`);
  const type = inferType(product_title, variant_label);
  const flavor = inferFlavor(product_title);
  const units = inferUnits(variant_label);

  const parts = {
    brand:  brand_slug || "GENERIC",
    volume,
    type,
    flavor,
    units
  };

  const sku = buildSku(parts);

  return ok({
    product_title,
    variant_label,
    brand_slug,
    sku,
    parts,
    used: brand_slug ? "manual-brand" : "fallback",
    example_format: "BRAND-VOLUME-TYPE-FLAVOR-UNITS"
  });
}
