/**
 * NAME: Soft Delete Sub-Category (auto-ID; supports id or slug)
 * PATH: /api/sub_categories/delete
 * METHOD: POST
 *
 * INPUT:
 *   - id   (string, optional)
 *   - slug (string, optional) // used if id not given
 *
 * EFFECT:
 *   - placement.isActive=false, placement.isFeatured=false, deletedAt=serverTimestamp()
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, query, where, getDocs, doc, getDoc, updateDoc, serverTimestamp
} from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

export async function POST(req){
  try{
    const { id, slug } = await req.json();
    let docId = (id||"").trim();

    if (!docId){
      const s = (slug||"").trim();
      if (!s) return err(400,"Missing Locator","Provide 'id' (preferred) or 'slug'.");
      const col = collection(db,"sub_categories");
      const rs  = await getDocs(query(col, where("subCategory.slug","==",s)));
      if (rs.empty) return err(404,"Not Found",`No sub-category with slug '${s}'.`);
      if (rs.size>1) return err(409,"Slug Not Unique",`Multiple sub-categories share slug '${s}'.`);
      docId = rs.docs[0].id;
    }

    const ref = doc(db,"sub_categories", docId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return err(404,"Not Found",`No sub-category id '${docId}'.`);

    await updateDoc(ref, {
      "placement.isActive": false,
      "placement.isFeatured": false,
      deletedAt: serverTimestamp(),
      "timestamps.updatedAt": serverTimestamp()
    });

    return ok({ id: docId, message: "Sub-category soft-deleted." });
  } catch (e) {
    console.error("sub_categories/delete (soft) failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while soft-deleting the sub-category.");
  }
}
