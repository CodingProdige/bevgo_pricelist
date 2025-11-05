import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, collection, getDocs, query, where, orderBy, limit as qLimit } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });
const toBool=(v)=>{ if (typeof v==="boolean") return v; if (v==null) return null;
  const s=String(v).toLowerCase(); if (["true","1","yes"].includes(s)) return true; if (["false","0","no"].includes(s)) return false; return null; };

export async function GET(req){
  try{
    const { searchParams } = new URL(req.url);
    const byId   = (searchParams.get("id")||"").trim();
    const bySlug = (searchParams.get("slug")||"").trim();

    if (byId){
      const snap = await getDoc(doc(db,"categories", byId));
      if (!snap.exists()) return err(404,"Not Found",`No category id '${byId}'.`);
      return ok({ id: byId, data: snap.data()||{} });
    }

    if (bySlug){
      const rs = await getDocs(query(collection(db,"categories"), where("category.slug","==", bySlug)));
      if (rs.empty) return err(404,"Not Found",`No category with slug '${bySlug}'.`);
      if (rs.size>1) return err(409,"Slug Not Unique",`Multiple categories share slug '${bySlug}'.`);
      const d = rs.docs[0];
      return ok({ id: d.id, data: d.data()||{} });
    }

    const isActive   = toBool(searchParams.get("isActive"));
    const isFeatured = toBool(searchParams.get("isFeatured"));

    const filters = [];
    if (isActive!==null)   filters.push(where("placement.isActive","==",isActive));
    if (isFeatured!==null) filters.push(where("placement.isFeatured","==",isFeatured));

    const limRaw = (searchParams.get("limit")||"").trim();
    const unlimited = limRaw.toLowerCase() === "all";
    let lim = 24;
    if (!unlimited && limRaw){
      const n = parseInt(limRaw,10);
      if (Number.isFinite(n) && n>0) lim = n;
    }

    const col = collection(db,"categories");
    const base = [ ...filters, orderBy("placement.position","asc") ];
    const qy   = unlimited ? query(col, ...base) : query(col, ...base, qLimit(lim));
    const rs   = await getDocs(qy);

    const items = rs.docs.map(d=>({ id:d.id, data:d.data()||{} }));
    return ok({ count: items.length, items });
  } catch (e) {
    const hint = /FAILED_PRECONDITION|PERMISSION_DENIED/i.test(String(e?.message||""))
      ? "This query may require a Firestore composite index or updated security rules." : undefined;
    console.error("categories/get failed:", e);
    return err(500,"Unexpected Error","Something went wrong while fetching categories.", hint?{hint}:{});
  }
}
