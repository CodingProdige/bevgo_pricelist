// app/api/brands/update/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, query, where, getDocs, doc, getDoc, updateDoc, serverTimestamp
} from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true,  ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

export async function POST(req){
  try{
    const { id, slug, data, propagate } = await req.json();
    if (!id && !slug) return err(400,"Missing Locator","Provide 'id' (preferred) or 'slug' plus 'data'.");

    // Resolve docId
    let docId = (id||"").trim();
    if (!docId){
      const rs = await getDocs(query(collection(db,"brands"), where("brand.slug","==", String(slug||"").trim())));
      if (rs.empty)  return err(404,"Not Found",`No brand with slug '${slug}'.`);
      if (rs.size>1) return err(409,"Slug Not Unique",`Multiple brands share slug '${slug}'.`);
      docId = rs.docs[0].id;
    }
    if (!data || typeof data !== "object") return err(400,"Invalid Data","Provide a 'data' object.");

    const ref = doc(db,"brands", docId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return err(404,"Not Found","Brand not found.");
    const curr = snap.data() || {};

    // Prepare updates
    const upd = {};
    // grouping.subCategories (array-overwrite)
    if (data?.grouping?.subCategories){
      const arr = Array.isArray(data.grouping.subCategories)
        ? data.grouping.subCategories.filter(Boolean).map(s=>String(s).trim())
        : [];
      upd["grouping.subCategories"] = arr;
    }
    // Optional: category change (rare)
    if (typeof data?.grouping?.category === "string"){
      upd["grouping.category"] = data.grouping.category.trim();
    }

    // brand fields
    if (typeof data?.brand?.title === "string")        upd["brand.title"] = data.brand.title;
    if (typeof data?.brand?.description === "string")  upd["brand.description"] = data.brand.description;
    if (Array.isArray(data?.brand?.keywords))          upd["brand.keywords"] = data.brand.keywords;

    // slug change — check uniqueness
    let oldSlug = curr?.brand?.slug;
    let newSlug = undefined;
    if (typeof data?.brand?.slug === "string"){
      newSlug = data.brand.slug.trim();
      if (!newSlug) return err(400,"Invalid Slug","'brand.slug' cannot be empty.");
      if (newSlug !== oldSlug){
        const dup = await getDocs(query(collection(db,"brands"), where("brand.slug","==", newSlug)));
        if (!dup.empty) return err(409,"Slug In Use",`Brand slug '${newSlug}' already exists.`);
        upd["brand.slug"] = newSlug;
      }
    }

    // placement/media
    if (data?.placement){
      if (Number.isFinite(+data.placement.position))  upd["placement.position"]  = +data.placement.position;
      if (typeof data.placement.isActive === "boolean")   upd["placement.isActive"]  = data.placement.isActive;
      if (typeof data.placement.isFeatured === "boolean") upd["placement.isFeatured"]= data.placement.isFeatured;
    }
    if (data?.media){
      if ("color" in data.media)   upd["media.color"]  = data.media.color ?? null;
      if ("images" in data.media)  upd["media.images"] = Array.isArray(data.media.images) ? data.media.images : [];
      if ("video" in data.media)   upd["media.video"]  = data.media.video ?? null;
      if ("icon" in data.media)    upd["media.icon"]   = data.media.icon ?? null;
    }

    upd["timestamps.updatedAt"] = serverTimestamp();
    await updateDoc(ref, upd);

    // Optional propagation: if slug changed and propagate.slug === true
    if (oldSlug && newSlug && propagate?.slug){
      // Update products_v2 that reference this brand slug
      const prs = await getDocs(query(collection(db,"products_v2"), where("grouping.brand","==", oldSlug)));
      const batchSize = 400;
      for (let i=0;i<prs.docs.length;i+=batchSize){
        const chunk = prs.docs.slice(i, i+batchSize);
        const writes = chunk.map(d => updateDoc(doc(db,"products_v2", d.id), {
          "grouping.brand": newSlug,
          "timestamps.updatedAt": serverTimestamp()
        }));
        await Promise.all(writes);
      }
      // (Optional) If your SKUs are brand-prefixed, you can also refit SKUs here.
      // Keeping off by default to avoid unintentional changes.
    }

    return ok({ id: docId, message: "Brand updated.", changed_slug: !!(oldSlug && newSlug && oldSlug!==newSlug) });
  }catch(e){
    console.error("brands/update failed:", e);
    return err(500,"Unexpected Error","Something went wrong while updating the brand.");
  }
}
