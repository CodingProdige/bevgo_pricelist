/**
 * NAME: Update Sub-Category (auto-ID; supports id or slug) + propagate slug changes
 * PATH: /api/sub_categories/update
 * METHOD: POST
 *
 * INPUT:
 *   - id   (string, optional): doc id
 *   - slug (string, optional): current slug (if id not provided)
 *   - data (object, required): partial update; objects deep-merge, arrays replace
 *
 * BEHAVIOR:
 *   - Locates the doc by id, else by slug (must resolve to exactly one doc).
 *   - Applies 'data' (arrays replace).
 *   - If 'data.subCategory.slug' is provided and changes:
 *       - Enforces uniqueness
 *       - Updates this doc's slug
 *       - Propagates to products_v2.grouping.subCategory (batched)
 *
 * RESPONSE:
 *   - 200: { ok:true, id, slug, propagated_from, propagated_to, migrated_products, message }
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, doc, getDoc, updateDoc, query, where, getDocs,
  writeBatch, serverTimestamp
} from "firebase/firestore";

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

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
      return err(400, "Invalid Data", "Provide a 'data' object.");
    if (!id && !slug)
      return err(400, "Missing Locator", "Provide 'id' (preferred) or 'slug'.");

    // Locate the doc
    let docId = id?.trim();
    if (!docId){
      const col = collection(db, "sub_categories");
      const qy  = query(col, where("subCategory.slug", "==", String(slug||"").trim()));
      const rs  = await getDocs(qy);
      if (rs.empty) return err(404, "Not Found", `No sub-category with slug '${slug}'.`);
      if (rs.size > 1) return err(409, "Slug Not Unique", `Multiple sub-categories share slug '${slug}'.`);
      docId = rs.docs[0].id;
    }

    const ref   = doc(db, "sub_categories", docId);
    const snap  = await getDoc(ref);
    if (!snap.exists()) return err(404, "Not Found", `No sub-category id '${docId}'.`);
    const current = snap.data() || {};
    const oldSlug = String(current?.subCategory?.slug ?? "").trim();

    // Build next state
    const next = deepMerge(current, data);

    // Determine slug change
    const wantsNew = data?.subCategory && Object.prototype.hasOwnProperty.call(data.subCategory, "slug");
    const newSlug  = wantsNew ? String(next?.subCategory?.slug ?? "").trim() : oldSlug;

    // If changing slug, check uniqueness
    if (wantsNew && newSlug && newSlug !== oldSlug) {
      const col = collection(db, "sub_categories");
      const rs  = await getDocs(query(col, where("subCategory.slug", "==", newSlug)));
      const conflict = rs.docs.some(d => d.id !== docId);
      if (conflict) return err(409, "Slug In Use", `Sub-category slug '${newSlug}' already exists.`);
    }

    // Update the sub-category doc
    await updateDoc(ref, {
      ...next,
      "timestamps.updatedAt": serverTimestamp()
    });

    // Propagate to products if slug changed
    let migrated = 0, from = null, to = null;
    if (wantsNew && newSlug && newSlug !== oldSlug) {
      from = oldSlug; to = newSlug;

      const prodCol = collection(db, "products_v2");
      const rs = await getDocs(query(prodCol, where("grouping.subCategory", "==", from)));
      if (!rs.empty){
        for (const part of chunk(rs.docs, 450)) {
          const b = writeBatch(db);
          for (const d of part) {
            b.update(d.ref, {
              "grouping.subCategory": to,
              "timestamps.updatedAt": serverTimestamp()
            });
            migrated++;
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
      migrated_products: migrated,
      message: "Sub-category updated."
    });
  } catch (e) {
    console.error("sub_categories/update (auto-ID) failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while updating the sub-category.");
  }
}
