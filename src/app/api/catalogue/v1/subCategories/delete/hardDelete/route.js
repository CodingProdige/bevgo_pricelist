// /app/api/sub_categories/purge/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, getDocs, query, where,
  doc, getDoc, deleteDoc
} from "firebase/firestore";

const ok  = (p={},s=200)=>NextResponse.json({ ok:true,  ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

function summaryMessage(slug, refs){
  const parts = [];
  if (refs.brands)      parts.push(`${refs.brands} brand${refs.brands===1?"":"s"} (grouping.subCategories)`);
  if (refs.products_v2) parts.push(`${refs.products_v2} product${refs.products_v2===1?"":"s"}`);
  const list = parts.length ? parts.join(", ") : "no references";
  return `Cannot delete sub-category '${slug}' because it is referenced by ${list}.`;
}

export async function POST(req){
  try{
    const { id, slug } = await req.json();
    const idTrim   = String(id   ?? "").trim();
    const slugTrim = String(slug ?? "").trim();

    if (!idTrim && !slugTrim) {
      return err(400,"Missing Locator","Provide 'id' (Firestore doc id) or 'slug' (subCategory.slug).");
    }

    // --- Resolve the document by id OR by subCategory.slug ---
    let ref, snap, subcatSlug, docId;

    if (idTrim){
      ref  = doc(db, "sub_categories", idTrim);
      snap = await getDoc(ref);
      if (!snap.exists()) return err(404,"Not Found",`No sub-category id '${idTrim}'.`);
      docId = snap.id;
      subcatSlug = String(snap.data()?.subCategory?.slug ?? "").trim();
      if (!subcatSlug) return err(409,"Invalid Document","This sub-category is missing 'subCategory.slug'.");
    } else {
      // Resolve by slug via query (doc id is auto-generated)
      const rs = await getDocs(query(collection(db,"sub_categories"), where("subCategory.slug","==", slugTrim)));
      if (rs.empty)  return err(404,"Not Found",`No sub-category with slug '${slugTrim}'.`);
      if (rs.size>1) return err(409,"Slug Not Unique",`Multiple sub-categories share slug '${slugTrim}'.`);
      const d = rs.docs[0];
      ref = d.ref; snap = d; docId = d.id;
      subcatSlug = String(d.data()?.subCategory?.slug ?? "").trim();
      if (!subcatSlug) return err(409,"Invalid Document","This sub-category is missing 'subCategory.slug'.");
    }

    // --- Count references before allowing delete ---
    const counts = { brands: 0, products_v2: 0 };

    // Brands referencing this subCategory in grouping.subCategories (array)
    {
      const rs = await getDocs(collection(db,"brands"));
      counts.brands = rs.docs.reduce((n, d) => {
        const arr = Array.isArray(d.data()?.grouping?.subCategories) ? d.data().grouping.subCategories : [];
        return n + (arr.includes(subcatSlug) ? 1 : 0);
      }, 0);
    }

    // Products referencing this subCategory in grouping.subCategory (string)
    {
      const rs = await getDocs(collection(db,"products_v2"));
      counts.products_v2 = rs.docs.reduce((n, d) => {
        return n + (String(d.data()?.grouping?.subCategory || "") === subcatSlug ? 1 : 0);
      }, 0);
    }

    const totalRefs = Object.values(counts).reduce((a,b)=>a+b,0);
    if (totalRefs > 0){
      return err(409, "Sub-Category In Use", summaryMessage(subcatSlug, counts), {
        references: counts,
        id: docId,
        slug: subcatSlug
      });
    }

    // --- Safe to delete ---
    await deleteDoc(ref);
    return ok({ id: docId, slug: subcatSlug, message: "Sub-category permanently deleted." });

  } catch (e) {
    console.error("sub_categories/purge (guarded, auto-id) failed:", e);
    return err(500,"Unexpected Error","Something went wrong while deleting the sub-category.");
  }
}
