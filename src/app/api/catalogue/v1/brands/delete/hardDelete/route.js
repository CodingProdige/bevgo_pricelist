// /app/api/brands/purge/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs, doc, getDoc, deleteDoc } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

function summaryMessage(slug, refs){
  const parts = [];
  if (refs.products_v2) parts.push(`${refs.products_v2} product${refs.products_v2===1?"":"s"}`);
  const list = parts.length ? parts.join(", ") : "no references";
  return `Cannot delete brand '${slug}' because it is referenced by ${list}.`;
}

export async function POST(req){
  try{
    const { id, slug } = await req.json();
    const idTrim   = String(id ?? "").trim();
    const slugTrim = String(slug ?? "").trim();
    if (!idTrim && !slugTrim) return err(400,"Missing Locator","Provide 'id' (preferred) or 'slug'.");

    // Resolve brand doc by id or by brand.slug
    let ref, snap, docId, brandSlug;
    if (idTrim){
      ref = doc(db,"brands", idTrim);
      snap = await getDoc(ref);
      if (!snap.exists()) return err(404,"Not Found",`No brand id '${idTrim}'.`);
      docId = snap.id;
      brandSlug = String(snap.data()?.brand?.slug ?? "").trim();
    } else {
      const rs = await getDocs(collection(db,"brands"));
      const hit = rs.docs.find(d => String(d.data()?.brand?.slug ?? "").trim() === slugTrim);
      if (!hit) return err(404,"Not Found",`No brand with slug '${slugTrim}'.`);
      ref = hit.ref; snap = hit; docId = hit.id;
      brandSlug = String(hit.data()?.brand?.slug ?? "").trim();
    }

    // Count references in products_v2
    let counts = { products_v2: 0 };
    {
      const rs = await getDocs(collection(db,"products_v2"));
      counts.products_v2 = rs.docs.reduce((n,d)=>n + (String(d.data()?.grouping?.brand||"")===brandSlug?1:0), 0);
    }

    if (counts.products_v2 > 0){
      return err(409,"Brand In Use", summaryMessage(brandSlug, counts), { references: counts });
    }

    await deleteDoc(ref);
    return ok({ id: docId, slug: brandSlug, message: "Brand permanently deleted." });
  }catch(e){
    console.error("brands/purge (guarded) failed:", e);
    return err(500,"Unexpected Error","Something went wrong while deleting the brand.");
  }
}
