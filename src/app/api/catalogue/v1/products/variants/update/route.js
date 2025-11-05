import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";

/* ---------- response helpers ---------- */
const ok  = (p = {}, s = 200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e = {}) => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

/* ---------- type sanitizers ---------- */
const money2 = (v) => Number.isFinite(+v) ? Math.round(+v * 100) / 100 : 0;
const toInt  = (v, f = 0) => Number.isFinite(+v) ? Math.trunc(+v) : f;
const toNum  = (v, f = 0) => Number.isFinite(+v) ? +v : f;
const toStr  = (v, f = "") => (v == null ? f : String(v)).trim();
const toBool = (v, f = false) =>
  typeof v === "boolean" ? v
  : typeof v === "number" ? v !== 0
  : typeof v === "string" ? ["true","1","yes","y"].includes(v.toLowerCase())
  : f;

const is8 = (s) => /^\d{8}$/.test(String(s ?? "").trim());

/** Deep-merge objects; arrays are replaced */
function deepMerge(target, patch) {
  if (patch == null || typeof patch !== "object") return target;
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v; // replace primitives & arrays
    }
  }
  return out;
}

/** Sanitize a partial patch into correct types — only for provided keys. */
function sanitizePatch(patch) {
  const out = {};

  if (Object.prototype.hasOwnProperty.call(patch, "sku"))   out.sku   = toStr(patch.sku);
  if (Object.prototype.hasOwnProperty.call(patch, "label")) out.label = toStr(patch.label);

  if (Object.prototype.hasOwnProperty.call(patch, "placement")) {
    const src = patch.placement || {};
    out.placement = {};
    if (Object.prototype.hasOwnProperty.call(src, "position"))
      out.placement.position = Number.isFinite(+src.position) ? Math.trunc(+src.position) : undefined;
    if (Object.prototype.hasOwnProperty.call(src, "isActive"))
      out.placement.isActive = toBool(src.isActive);
    if (Object.prototype.hasOwnProperty.call(src, "isFeatured"))
      out.placement.isFeatured = toBool(src.isFeatured);
    if (Object.prototype.hasOwnProperty.call(src, "is_default"))
      out.placement.is_default = toBool(src.is_default);
    if (Object.prototype.hasOwnProperty.call(src, "is_loyalty_eligible"))
      out.placement.is_loyalty_eligible = toBool(src.is_loyalty_eligible);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "pricing")) {
    const src = patch.pricing || {};
    out.pricing = {};
    if (Object.prototype.hasOwnProperty.call(src, "supplier_price_excl"))
      out.pricing.supplier_price_excl = money2(src.supplier_price_excl);
    if (Object.prototype.hasOwnProperty.call(src, "selling_price_excl"))
      out.pricing.selling_price_excl = money2(src.selling_price_excl);
    if (Object.prototype.hasOwnProperty.call(src, "cost_price_excl"))
      out.pricing.cost_price_excl = money2(src.cost_price_excl);
    // legacy alias
    if (!Object.prototype.hasOwnProperty.call(out.pricing, "cost_price_excl") &&
        Object.prototype.hasOwnProperty.call(src, "base_price_excl"))
      out.pricing.cost_price_excl = money2(src.base_price_excl);
    if (Object.prototype.hasOwnProperty.call(src, "rebate_eligible"))
      out.pricing.rebate_eligible = toBool(src.rebate_eligible);
    if (Object.prototype.hasOwnProperty.call(src, "deposit_included"))
      out.pricing.deposit_included = toBool(src.deposit_included);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "sale")) {
    const src = patch.sale || {};
    out.sale = {};
    if (Object.prototype.hasOwnProperty.call(src, "is_on_sale"))
      out.sale.is_on_sale = toBool(src.is_on_sale);
    if (Object.prototype.hasOwnProperty.call(src, "sale_price_excl"))
      out.sale.sale_price_excl = money2(src.sale_price_excl);
    if (Object.prototype.hasOwnProperty.call(src, "qty_available"))
      out.sale.qty_available = toInt(src.qty_available, 0);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "pack")) {
    const src = patch.pack || {};
    out.pack = {};
    if (Object.prototype.hasOwnProperty.call(src, "unit_count"))
      out.pack.unit_count = toInt(src.unit_count, 1);
    if (Object.prototype.hasOwnProperty.call(src, "volume"))
      out.pack.volume = toNum(src.volume, 0);
    if (Object.prototype.hasOwnProperty.call(src, "volume_unit"))
      out.pack.volume_unit = toStr(src.volume_unit, "each");
  }

  if (Object.prototype.hasOwnProperty.call(patch, "rental")) {
    const src = patch.rental || {};
    out.rental = {};
    if (Object.prototype.hasOwnProperty.call(src, "is_rental"))
      out.rental.is_rental = toBool(src.is_rental);
    if (Object.prototype.hasOwnProperty.call(src, "rental_price_excl"))
      out.rental.rental_price_excl = money2(src.rental_price_excl);
    if (Object.prototype.hasOwnProperty.call(src, "billing_period"))
      out.rental.billing_period = toStr(src.billing_period, "monthly");
  }

  if (Object.prototype.hasOwnProperty.call(patch, "returnable")) {
    out.returnable = (patch.returnable && typeof patch.returnable === "object") ? patch.returnable : {};
  }

  return out;
}

export async function POST(req) {
  try {
    const { unique_id, variant_id, data } = await req.json();

    const pid = toStr(unique_id);
    if (!is8(pid)) return err(400, "Invalid Product ID", "'unique_id' must be an 8-digit string.");

    const vid = toStr(variant_id);
    if (!is8(vid)) return err(400, "Invalid Variant ID", "'variant_id' must be an 8-digit string.");

    if (!data || typeof data !== "object") {
      return err(400, "Invalid Data", "Provide a 'data' object with fields to update.");
    }

    // Prevent changing variant_id via payload
    if (Object.prototype.hasOwnProperty.call(data, "variant_id") && toStr(data.variant_id) !== vid) {
      return err(409, "Mismatched Variant ID", "data.variant_id must match the target variant_id.");
    }

    // Load product
    const ref = doc(db, "products_v2", pid);
    const snap = await getDoc(ref);
    if (!snap.exists()) return err(404, "Product Not Found", `No product exists with unique_id ${pid}.`);

    const docData = snap.data() || {};
    const list = Array.isArray(docData.variants) ? [...docData.variants] : [];
    if (!list.length) return err(409, "No Variants", "This product has no variants to update.");

    // Locate target variant by 8-digit variant_id
    const idx = list.findIndex(v => toStr(v?.variant_id) === vid);
    if (idx < 0) return err(404, "Variant Not Found", `No variant with variant_id ${vid} on this product.`);

    // Build sanitized patch ONLY for keys provided
    const patch = sanitizePatch(data);

    // Merge (objects deep, arrays replaced) then apply default flip if asked
    let updated = deepMerge(list[idx], patch);

    // ----- default flipping side-effect (placement.is_default) -----
    const askedFlip = Object.prototype.hasOwnProperty.call(patch, "placement") &&
                      Object.prototype.hasOwnProperty.call(patch.placement, "is_default");

    if (askedFlip) {
      const makeDefault = !!patch.placement.is_default;
      if (makeDefault) {
        // Clear default on all others
        for (let i = 0; i < list.length; i++) {
          if (i !== idx && list[i]?.placement) list[i].placement.is_default = false;
        }
        // Ensure this one is true
        updated.placement = updated.placement || {};
        updated.placement.is_default = true;
      } else {
        // Explicitly clear on this one only
        updated.placement = updated.placement || {};
        updated.placement.is_default = false;
      }
    }

    // Save back
    list[idx] = updated;

    await updateDoc(ref, { variants: list, "timestamps.updatedAt": serverTimestamp() });

    // Who's default now?
    const default_variant_id = (list.find(v => v?.placement?.is_default) || {}).variant_id ?? null;

    return ok({
      message: "Variant updated.",
      unique_id: pid,
      variant_id: vid,
      default_variant_id,
      variant: list[idx]
    });
  } catch (e) {
    console.error("products_v2/variants/update (sanitized) failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while updating the variant.");
  }
}
