/**
 * NAME: Update Sub-Category (propagate slug changes)
 * PATH: /api/sub_categories/update
 * METHOD: POST
 *
 * INPUT:
 *   - id   (string, optional): document id
 *   - slug (string, optional): current slug (used if id not provided)
 *   - data (object, required): partial update; objects deep-merge, arrays replace
 *
 * BEHAVIOR:
 *   - Locates doc by id, else by slug (must resolve uniquely).
 *   - Applies 'data'.
 *   - If 'data.subCategory.slug' changes, ensures uniqueness and then propagates:
 *       - products_v2.grouping.subCategory (old -> new)
 *       - brands.grouping.subCategories    (replace old with new, keep order, dedupe)
 *
 * RESPONSE:
 *   - 200: {
 *       ok:true, id, slug,
 *       propagated_from, propagated_to,
 *       migrated_products, touched_brands,
 *       message
 *     }
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, getDocs, doc, getDoc, updateDoc, serverTimestamp, writeBatch
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
    if (!data || typeof data !== "object")
      return err(400,"Invalid Data","Provide a 'data' object.");
    if (!id && !slug)
      return err(400,"Missing Locator","Provide 'id' (preferred) or 'slug'.");

    // ---------- Locate sub-category (no composite indexes; in-memory fallback) ----------
    let docRef = null, docSnap = null, docId = String(id ?? "").trim();

    if (docId){
      docRef = doc(db,"sub_categories", docId);
      docSnap = await getDoc(docRef);
      if (!docSnap.exists()) return err(404,"Not Found",`No sub-category id '${docId}'.`);
    } else {
      const targetSlug = String(slug ?? "").trim();
      if (!targetSlug) return err(400,"Invalid Slug","Provide a non-empty 'slug' when 'id' is omitted.");

      const all = await getDocs(collection(db,"sub_categories"));
      const hits = all.docs.filter(d => String(d.data()?.subCategory?.slug ?? "").trim() === targetSlug);
      if (hits.length === 0) return err(404,"Not Found",`No sub-category with slug '${targetSlug}'.`);
      if (hits.length > 1)  return err(409,"Slug Not Unique",`Multiple sub-categories share slug '${targetSlug}'.`);
      docSnap = hits[0];
      docRef  = hits[0].ref;
      docId   = hits[0].id;
    }

    const current = docSnap.data() || {};
    const oldSlug = String(current?.subCategory?.slug ?? "").trim();

    // ---------- Build next state ----------
    const next = deepMerge(current, data);

    // Decide if slug is changing
    const wantsNew = data?.subCategory && Object.prototype.hasOwnProperty.call(data.subCategory, "slug");
    const newSlug  = wantsNew ? String(next?.subCategory?.slug ?? "").trim() : oldSlug;

    // Uniqueness check for new slug (in-memory)
    if (wantsNew && newSlug && newSlug !== oldSlug){
      const all = await getDocs(collection(db,"sub_categories"));
      const conflict = all.docs.some(d =>
        d.id !== docId && String(d.data()?.subCategory?.slug ?? "").trim() === newSlug
      );
      if (conflict) return err(409,"Slug In Use",`Sub-category slug '${newSlug}' already exists.`);
    }

    // ---------- Update the sub-category doc ----------
    await updateDoc(docRef, {
      ...next,
      "timestamps.updatedAt": serverTimestamp()
    });

    // ---------- Propagate if slug changed ----------
    let migratedProducts = 0;
    let touchedBrands    = 0;
    let from = null, to = null;

    if (wantsNew && newSlug && newSlug !== oldSlug){
      from = oldSlug; to = newSlug;

      // products_v2: grouping.subCategory == old -> new
      {
        const rs = await getDocs(collection(db,"products_v2"));
        const matches = rs.docs.filter(d => String(d.data()?.grouping?.subCategory ?? "") === from);
        for (const part of chunk(matches, 450)){
          const b = writeBatch(db);
          for (const d of part){
            b.update(d.ref, {
              "grouping.subCategory": to,
              "timestamps.updatedAt": serverTimestamp()
            });
            migratedProducts++;
          }
          await b.commit();
        }
      }

      // brands: grouping.subCategories (array) replace old with new (preserve order; dedupe)
      {
        const rs = await getDocs(collection(db,"brands"));
        const toChange = [];
        for (const d of rs.docs){
          const arr = Array.isArray(d.data()?.grouping?.subCategories)
            ? d.data().grouping.subCategories.map(x=>String(x))
            : [];
          if (arr.includes(from)){
            // map replace + dedupe while preserving order
            const mapped = arr.map(x => (x === from ? to : x));
            const seen = new Set();
            const deduped = mapped.filter(x => (x && !seen.has(x) ? (seen.add(x), true) : false));
            toChange.push({ ref: d.ref, subCategories: deduped });
          }
        }
        for (const part of chunk(toChange, 450)){
          const b = writeBatch(db);
          for (const row of part){
            b.update(row.ref, {
              "grouping.subCategories": row.subCategories
            });
            touchedBrands++;
          }
          await b.commit();
        }
      }
    }

    return ok({
      id: docId,
      slug: newSlug,
      propagated_from: from,
      propagated_to: to,
      migrated_products: migratedProducts,
      touched_brands: touchedBrands,
      message: wantsNew && newSlug !== oldSlug
        ? "Sub-category updated (slug propagated)."
        : "Sub-category updated."
    });
  }catch(e){
    console.error("sub_categories/update (propagate) failed:", e);
    return err(500,"Unexpected Error","Something went wrong while updating the sub-category.");
  }
}
