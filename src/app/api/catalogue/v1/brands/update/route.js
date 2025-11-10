/**
 * NAME: Update Brand (propagate slug changes to products)
 * PATH: /api/brands/update
 * METHOD: POST
 *
 * INPUT:
 *   - id   (string, optional): brand doc id
 *   - slug (string, optional): current brand.slug (used if id not provided)
 *   - data (object, required): partial update (arrays replace; objects deep-merge)
 *
 * BEHAVIOR:
 *   - Resolves brand by id or slug.
 *   - Applies 'data'.
 *   - If 'data.brand.slug' changes:
 *       * Ensures uniqueness across brands.
 *       * Propagates to products_v2.grouping.brand (old -> new) in batches.
 *
 * RESPONSE:
 *   - 200: {
 *       ok:true, id, slug,
 *       propagated_from, propagated_to,
 *       migrated_products,
 *       message
 *     }
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, getDocs, doc, getDoc, updateDoc,
  writeBatch, serverTimestamp
} from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

function deepMerge(target, patch){
  if (patch==null || typeof patch!=="object") return target;
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const [k,v] of Object.entries(patch)){
    if (v && typeof v==="object" && !Array.isArray(v) && typeof out[k]==="object" && !Array.isArray(out[k])){
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
const chunk = (arr,n)=>{ const r=[]; for(let i=0;i<arr.length;i+=n) r.push(arr.slice(i,i+n)); return r; };

export async function POST(req){
  try{
    const { id, slug, data } = await req.json();
    const idTrim   = String(id ?? "").trim();
    const slugTrim = String(slug ?? "").trim();
    if (!idTrim && !slugTrim) return err(400,"Missing Locator","Provide 'id' (preferred) or 'slug'.");
    if (!data || typeof data !== "object") return err(400,"Invalid Data","Provide a 'data' object.");

    // Resolve brand doc (id may not equal slug)
    let ref, snap, docId;
    if (idTrim){
      ref = doc(db,"brands", idTrim);
      snap = await getDoc(ref);
      if (!snap.exists()) return err(404,"Not Found",`No brand id '${idTrim}'.`);
      docId = snap.id;
    } else {
      const all = await getDocs(collection(db,"brands"));
      const hit = all.docs.find(d => String(d.data()?.brand?.slug ?? "").trim() === slugTrim);
      if (!hit) return err(404,"Not Found",`No brand with slug '${slugTrim}'.`);
      ref = hit.ref; snap = hit; docId = hit.id;
    }

    const current  = snap.data() || {};
    const oldSlug  = String(current?.brand?.slug ?? "").trim();

    // Merge incoming data (arrays replace)
    const next = deepMerge(current, data);

    // Slug change?
    const wantsNew = data?.brand && Object.prototype.hasOwnProperty.call(data.brand,"slug");
    const newSlug  = wantsNew ? String(next?.brand?.slug ?? "").trim() : oldSlug;

    // Uniqueness check for new slug (in-memory)
    if (wantsNew && newSlug && newSlug !== oldSlug){
      const all = await getDocs(collection(db,"brands"));
      const conflict = all.docs.some(d =>
        d.id !== docId && String(d.data()?.brand?.slug ?? "").trim() === newSlug
      );
      if (conflict) return err(409,"Slug In Use",`Brand slug '${newSlug}' already exists.`);
    }

    // Persist brand update
    await updateDoc(ref, {
      ...next,
      "timestamps.updatedAt": serverTimestamp()
    });

    // Propagate to products_v2 if slug changed
    let migrated = 0, from = null, to = null;
    if (wantsNew && newSlug && newSlug !== oldSlug){
      from = oldSlug; to = newSlug;

      const rs = await getDocs(collection(db,"products_v2"));
      const matches = rs.docs.filter(d => String(d.data()?.grouping?.brand ?? "") === from);

      for (const part of chunk(matches, 450)) {
        const b = writeBatch(db);
        for (const d of part){
          b.update(d.ref, {
            "grouping.brand": to,
            "timestamps.updatedAt": serverTimestamp()
          });
          migrated++;
        }
        await b.commit();
      }
    }

    return ok({
      id: docId,
      slug: newSlug,
      propagated_from: from,
      propagated_to: to,
      migrated_products: migrated,
      message: wantsNew && newSlug !== oldSlug
        ? "Brand updated (slug propagated)."
        : "Brand updated."
    });
  }catch(e){
    console.error("brands/update (propagate) failed:", e);
    return err(500,"Unexpected Error","Something went wrong while updating the brand.");
  }
}
