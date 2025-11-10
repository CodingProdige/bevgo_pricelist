// /app/api/catalogue/v1/categories/purge/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, query, where, getDocs, doc, getDoc, deleteDoc } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

function summaryMessage(slug, refs){
  const parts = [];
  if (refs.sub_categories) parts.push(`${refs.sub_categories} sub-categor${refs.sub_categories===1?"y":"ies"}`);
  if (refs.brands)         parts.push(`${refs.brands} brand${refs.brands===1?"":"s"}`);
  if (refs.products_v2)    parts.push(`${refs.products_v2} product${refs.products_v2===1?"":"s"}`);
  if (refs.returnables)    parts.push(`${refs.returnables} returnable${refs.returnables===1?"":"s"}`);
  const list = parts.length ? parts.join(", ") : "no references";
  return `Cannot delete category '${slug}' because it is referenced by ${list}.`;
}

export async function POST(req){
  try{
    const { id, slug } = await req.json();
    if (!id && !slug) return err(400,"Missing Locator","Provide 'id' (preferred) or 'slug'.");

    // Resolve docId & slug
    let docId = (id||"").trim();
    let catSlug = (slug||"").trim();

    if (!docId){
      const rs = await getDocs(query(collection(db,"categories"), where("category.slug","==", catSlug)));
      if (rs.empty) return err(404,"Not Found",`No category with slug '${catSlug}'.`);
      if (rs.size>1) return err(409,"Slug Not Unique",`Multiple categories share slug '${catSlug}'.`);
      docId   = rs.docs[0].id;
      catSlug = String(rs.docs[0].data()?.category?.slug ?? "").trim();
    } else {
      const snap = await getDoc(doc(db,"categories", docId));
      if (!snap.exists()) return err(404,"Not Found",`No category id '${docId}'.`);
      catSlug = String(snap.data()?.category?.slug ?? "").trim();
    }

    // Count references (in-memory scans; no indexes)
    let counts = { sub_categories:0, brands:0, products_v2:0, returnables:0 };

    {
      const rs = await getDocs(collection(db,"sub_categories"));
      counts.sub_categories = rs.docs.reduce((n,d)=>n + (String(d.data()?.grouping?.category||"")===catSlug?1:0), 0);
    }
    {
      const rs = await getDocs(collection(db,"brands"));
      counts.brands = rs.docs.reduce((n,d)=>n + (String(d.data()?.grouping?.category||"")===catSlug?1:0), 0);
    }
    {
      const rs = await getDocs(collection(db,"products_v2"));
      counts.products_v2 = rs.docs.reduce((n,d)=>n + (String(d.data()?.grouping?.category||"")===catSlug?1:0), 0);
    }
    {
      const rs = await getDocs(collection(db,"returnables"));
      counts.returnables = rs.docs.reduce((n,d)=>n + (String(d.data()?.grouping?.category||"")===catSlug?1:0), 0);
    }

    const total = Object.values(counts).reduce((a,b)=>a+b,0);
    if (total > 0){
      return err(409, "Category In Use", summaryMessage(catSlug, counts), { references: counts });
    }

    await deleteDoc(doc(db,"categories", docId));
    return ok({ id: docId, slug: catSlug, message: "Category permanently deleted." });
  } catch (e) {
    console.error("categories/purge (guarded) failed:", e);
    return err(500,"Unexpected Error","Something went wrong while deleting the category.");
  }
}
