/**
 * Purge Brand (hard delete) — by id or slug
 * POST /api/brands/purge
 *
 * WARNING: Permanently deletes the brand. No cascading deletes.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, query, where, getDocs, doc, getDoc, deleteDoc } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

export async function POST(req){
  try{
    const { id, slug } = await req.json();
    let docId = (id||"").trim();

    if (!docId){
      const s = (slug||"").trim();
      if (!s) return err(400,"Missing Locator","Provide 'id' (preferred) or 'slug'.");
      const rs = await getDocs(query(collection(db,"brands"), where("brand.slug","==", s)));
      if (rs.empty) return err(404,"Not Found",`No brand with slug '${s}'.`);
      if (rs.size>1) return err(409,"Slug Not Unique",`Multiple brands share slug '${s}'.`);
      docId = rs.docs[0].id;
    }

    const ref = doc(db,"brands", docId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return err(404,"Not Found",`No brand id '${docId}'.`);

    await deleteDoc(ref);
    return ok({ id: docId, message: "Brand permanently deleted." });
  }catch(e){
    console.error("brands/purge failed:", e);
    return err(500,"Unexpected Error","Something went wrong while deleting the brand.");
  }
}
