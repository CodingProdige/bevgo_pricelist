/**
 * NAME: Soft Delete Brand (auto-ID; supports id or slug)
 * PATH: /api/brands/delete
 * METHOD: POST
 *
 * INPUT:
 *   - id   (string, optional)
 *   - slug (string, optional) // used if id not provided
 *
 * EFFECT:
 *   - placement.isActive=false, placement.isFeatured=false, deletedAt=serverTimestamp()
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, query, where, getDocs, doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

export async function POST(req){
  try{
    const { id, slug } = await req.json();
    let docId = (id||"").trim();

    if (!docId){
      const s = (slug||"").trim();
      if (!s) return err(400,"Missing Locator","Provide 'id' (preferred) or 'slug'.");
      const rs = await getDocs(query(collection(db,"brands"), where("brand.slug","==",s)));
      if (rs.empty) return err(404,"Not Found",`No brand with slug '${s}'.`);
      if (rs.size>1) return err(409,"Slug Not Unique",`Multiple brands share slug '${s}'.`);
      docId = rs.docs[0].id;
    }

    const ref = doc(db,"brands", docId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return err(404,"Not Found",`No brand id '${docId}'.`);

    await updateDoc(ref, {
      "placement.isActive": false,
      "placement.isFeatured": false,
      deletedAt: serverTimestamp(),
      "timestamps.updatedAt": serverTimestamp()
    });

    return ok({ id: docId, message: "Brand soft-deleted." });
  } catch (e) {
    console.error("brands/delete (soft) failed:", e);
    return err(500,"Unexpected Error","Something went wrong while soft-deleting the brand.");
  }
}
