// app/api/utils/image/nudge/route.js
import { NextResponse } from "next/server";

const ok  = (p={}, s=200) => NextResponse.json({ ok:true, ...p }, { status:s });
const err = (s,t,m,e={}) => NextResponse.json({ ok:false, title:t, message:m, ...e }, { status:s });

/** Normalize one image and keep original index for stable fallback ordering */
const norm = (x, i) => ({
  imageUrl:    (x?.imageUrl ?? null) || null,
  blurHashUrl: (x?.blurHashUrl ?? null) || null,
  position:    Number.isFinite(+x?.position) && +x.position > 0 ? +x.position : 0,
  _origIndex:  i
});

const toNonNegativeInt = (v) => {
  if (v == null) return null;
  const n = Number(String(v).trim?.() ?? v);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i >= 0 ? i : null; // 0..∞
};

export async function POST(req){
  try{
    const body = await req.json().catch(()=> ({}));

    const imagesIn = Array.isArray(body?.images) ? body.images : null;
    if (!imagesIn) return err(400,"Invalid Images","'images' must be an array.");

    const direction = String(body?.direction ?? "").toLowerCase();
    if (!["left","right"].includes(direction)) {
      return err(400,"Invalid Direction","'direction' must be 'left' or 'right'.");
    }

    // Identify the item to move by key (preferred) OR by index (0-based)
    const keyField = body?.keyField || "imageUrl";
    const key      = body?.key;
    const indexIn  = toNonNegativeInt(body?.index);

    // Build stable current order (by position asc; fallback to input order)
    const items = imagesIn.map(norm);
    if (!items.length) return err(404,"No Images","There are no images to reorder.");
    const ordered = [...items].sort((a,b)=>{
      const ap = a.position || (a._origIndex + 1);
      const bp = b.position || (b._origIndex + 1);
      return ap - bp;
    });

    const len = ordered.length;

    // Resolve current index
    let fromIdx = null;
    if (key != null) {
      fromIdx = ordered.findIndex(it => String(it?.[keyField] ?? "") === String(key));
      if (fromIdx < 0) return err(404,"Key Not Found",`No image where ${keyField} == ${JSON.stringify(key)}.`);
    } else if (indexIn != null) {
      if (indexIn > len - 1) return err(400,"Out Of Range",`'index' must be 0..${len-1}. Received: ${indexIn}`);
      fromIdx = indexIn;
    } else {
      return err(400,"Missing Target","Provide either 'key' (e.g. imageUrl) or a 0-based 'index'.");
    }

    // Compute target with wrap-around
    let targetIdx = direction === "left"
      ? (fromIdx - 1 + len) % len
      : (fromIdx + 1) % len;

    // Reorder one step
    const arr = [...ordered];
    const [moved] = arr.splice(fromIdx, 1);
    arr.splice(targetIdx, 0, moved);

    // Rewrite contiguous positions 1..N
    const images = arr.map((it,i)=>({
      imageUrl: it.imageUrl,
      blurHashUrl: it.blurHashUrl,
      position: i + 1
    }));

    return ok({
      message: "Image nudged.",
      received: { keyField, key: key ?? null, index: indexIn ?? null, direction },
      from_index: fromIdx,
      final_index: targetIdx,
      count: images.length,
      images
    });
  } catch (e) {
    console.error("utils/image/nudge failed:", e);
    return err(500,"Unexpected Error","Failed to nudge the image.");
  }
}
