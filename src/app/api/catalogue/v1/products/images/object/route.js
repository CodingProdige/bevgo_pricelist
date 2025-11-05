// app/api/utils/image/object/route.js
import { NextResponse } from "next/server";

/* ---------------- helpers ---------------- */
const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

/** Only for real URLs (imageUrl) */
function sanitizeImageUrl(u){
  if (u == null) return null;
  const s = String(u).trim();
  if (!s) return null;
  // allow http(s) and data URIs; reject others
  if (/^(https?:\/\/|data:)/i.test(s)) return s;
  return null;
}

/** For blurhash tokens or fallback placeholders: accept any non-empty string */
function sanitizeBlurHash(v){
  if (v == null) return null;
  const s = String(v).trim();
  // Typical blurhashes are short ASCII strings; allow anything non-empty
  return s.length ? s : null;
}

/**
 * Normalize inputs (string or object) into:
 *   { imageUrl: string|null, blurHashUrl: string|null }
 * Supports keys: imageUrl|url, blurHashUrl|blurhash|blurHash
 */
function toImageObject({ imageUrl, blurHashUrl, url, blurhash, blurHash }){
  const img = sanitizeImageUrl(imageUrl ?? url);
  // IMPORTANT: do NOT use URL sanitizer on blurHash
  const bh  = sanitizeBlurHash(blurHashUrl ?? blurhash ?? blurHash);
  return { imageUrl: img, blurHashUrl: bh };
}

/** Compute next position from an array of images with a 'position' field */
function nextPositionFrom(existing){
  if (!Array.isArray(existing) || existing.length === 0) return 1;
  let max = 0;
  for (const it of existing){
    const p = Number(it?.position ?? 0);
    if (Number.isFinite(p) && p > max) max = p;
  }
  return max + 1;
}

/* ---------------- routes ------------------ */
export async function GET(req){
  try{
    const { searchParams } = new URL(req.url);
    const imageUrl    = searchParams.get("imageUrl");
    const blurHashUrl = searchParams.get("blurHashUrl");

    // Optional: quick position via count for GET-only usage
    const existingCount = parseInt(searchParams.get("existingCount") || "", 10);
    const position = Number.isFinite(existingCount) && existingCount > 0
      ? existingCount + 1
      : 1;

    const obj = toImageObject({ imageUrl, blurHashUrl });
    if (!obj.imageUrl && !obj.blurHashUrl){
      return err(400, "No Image Data", "Provide at least 'imageUrl' or 'blurHashUrl' as query parameters.");
    }

    return ok({ image: { ...obj, position } });
  }catch(e){
    console.error("utils/image/object GET failed:", e);
    return err(500, "Unexpected Error", "Failed to build image object.");
  }
}

export async function POST(req){
  try{
    const body = await req.json().catch(()=> ({}));

    // Supports:
    // { imageUrl, blurHashUrl, existing?: [] }
    // { images: { imageUrl, blurHashUrl }, existing?: [] }
    // legacy { url, blurhash }
    const payload  = typeof body?.images === "object" ? body.images : body;
    const existing = Array.isArray(body?.existing) ? body.existing : [];

    const base = toImageObject(payload ?? {});
    if (!base.imageUrl && !base.blurHashUrl){
      return err(400, "No Image Data", "Provide at least 'imageUrl' or 'blurHashUrl' in the JSON body.");
    }

    // Auto-position unless explicitly provided (must be positive integer)
    const position = Number.isFinite(+body?.position) && +body.position > 0
      ? +body.position
      : nextPositionFrom(existing);

    const image = { ...base, position };

    // Return full updated array with the new image appended
    const images = [...existing, image];

    return ok({ image, images }, 201);
  }catch(e){
    console.error("utils/image/object POST failed:", e);
    return err(500, "Unexpected Error", "Failed to build image object.");
  }
}
