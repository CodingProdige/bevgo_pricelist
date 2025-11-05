import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, doc, getDoc, getDocs, updateDoc, serverTimestamp } from "firebase/firestore";

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

/** Gather ALL 8-digit codes used by products (product.unique_id) & variants (variant.variant_id). */
async function collectAllCodes() {
  const snap = await getDocs(collection(db, "products_v2"));
  const seen = new Set();
  for (const d of snap.docs) {
    const data = d.data() || {};
    const pCode = String(data?.product?.unique_id ?? "").trim();
    if (is8(pCode)) seen.add(pCode);
    const vars = Array.isArray(data?.variants) ? data.variants : [];
    for (const v of vars) {
      const vCode = String(v?.variant_id ?? "").trim();
      if (is8(vCode)) seen.add(vCode);
    }
  }
  return seen;
}

/* ---------- route ---------- */
export async function POST(req) {
  try {
    const { unique_id, data } = await req.json();

    // Validate product id (8-digit; equals doc id)
    const pid = toStr(unique_id);
    if (!is8(pid)) return err(400, "Invalid Product ID", "'unique_id' must be an 8-digit string.");

    // Validate payload
    if (!data || typeof data !== "object") {
      return err(400, "Invalid Variant", "Provide a valid 'data' object.");
    }

    // Validate 8-digit variant_id
    const vId = toStr(data?.variant_id);
    if (!is8(vId)) {
      return err(400, "Invalid Variant ID", "'data.variant_id' must be an 8-digit string (e.g. \"12345678\").");
    }

    // Ensure product exists
    const pref = doc(db, "products_v2", pid);
    const psnap = await getDoc(pref);
    if (!psnap.exists()) return err(404, "Product Not Found", `No product exists with unique_id ${pid}.`);

    // Global uniqueness across products & variants
    const seen = await collectAllCodes();
    if (seen.has(vId)) return err(409, "Duplicate Code", `variant_id ${vId} is already in use. Generate a new one.`);

    const current  = psnap.data() || {};
    const variants = Array.isArray(current.variants) ? [...current.variants] : [];

    // Compute next placement.position (append-to-end)
    const nextPos = (variants.length
      ? Math.max(...variants.map(v => Number.isFinite(+v?.placement?.position) ? +v.placement.position : 0))
      : 0) + 1;

    // ---------- sanitize & build EXACT schema ----------
    const variant = {
      variant_id: vId,                                // string(8)
      sku:        toStr(data?.sku),                   // string
      label:      toStr(data?.label),                 // string
      placement: {
        position:          Number.isFinite(+data?.placement?.position) ? Math.trunc(+data.placement.position) : nextPos,
        isActive:          toBool(data?.placement?.isActive,   true),
        isFeatured:        toBool(data?.placement?.isFeatured, false),
        is_default:        toBool(data?.placement?.is_default, variants.length === 0),
        is_loyalty_eligible: toBool(data?.placement?.is_loyalty_eligible, true),
      },
      pricing: {
        supplier_price_excl: money2(data?.pricing?.supplier_price_excl),
        selling_price_excl:  money2(data?.pricing?.selling_price_excl),
        // accepts legacy base_price_excl but stores as cost_price_excl
        cost_price_excl:     Number.isFinite(+data?.pricing?.cost_price_excl)
                              ? money2(data.pricing.cost_price_excl)
                              : money2(data?.pricing?.base_price_excl),
        rebate_eligible:     toBool(data?.pricing?.rebate_eligible, true),
        deposit_included:    toBool(data?.pricing?.deposit_included, false),
      },
      sale: {
        is_on_sale:      toBool(data?.sale?.is_on_sale, false),
        sale_price_excl: money2(data?.sale?.sale_price_excl),
        qty_available:   toInt(data?.sale?.qty_available, 0),
      },
      pack: {
        unit_count:  toInt(data?.pack?.unit_count, 1),
        volume:      toNum(data?.pack?.volume, 0),
        volume_unit: toStr(data?.pack?.volume_unit, "each"),
      },
      rental: {
        is_rental:         toBool(data?.rental?.is_rental, false),
        rental_price_excl: money2(data?.rental?.rental_price_excl),
        billing_period:    toStr(data?.rental?.billing_period, "monthly"), // daily|weekly|monthly|yearly
      },
      returnable: typeof data?.returnable === "object" && data.returnable ? data.returnable : {},
    };

    // If this variant is default, unset default on others (in their placement)
    if (variant.placement.is_default) {
      for (let i = 0; i < variants.length; i++) {
        if (variants[i]?.placement) variants[i].placement.is_default = false;
      }
    }

    variants.push(variant);

    await updateDoc(pref, {
      variants,
      "timestamps.updatedAt": serverTimestamp(),
    });

    return ok({
      message: "Variant added.",
      unique_id: pid,
      variant_id: variant.variant_id,
      position: variant.placement.position,
      variant
    });
  } catch (e) {
    console.error("products_v2/variants/add (sanitized) failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while adding the variant.");
  }
}
