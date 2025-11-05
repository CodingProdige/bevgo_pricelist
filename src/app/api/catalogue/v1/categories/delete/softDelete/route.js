import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  doc, getDoc, updateDoc, serverTimestamp,
  collection, query, where, getDocs
} from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

export async function POST(req){
  try{
    const { id, slug } = await req.json();
    if (!id && !slug)
      return err(400,"Missing Locator","Provide 'id' (preferred) or 'slug'.");

    // Resolve doc id
    let docId = (id||"").trim();
    if (!docId){
      const s = String(slug||"").trim();
      const rs = await getDocs(query(collection(db,"categories"), where("category.slug","==", s)));
      if (rs.empty)  return err(404,"Not Found",`No category with slug '${s}'.`);
      if (rs.size>1) return err(409,"Slug Not Unique",`Multiple categories share slug '${s}'.`);
      docId = rs.docs[0].id;
    }

    const ref = doc(db,"categories", docId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return err(404,"Not Found",`No category id '${docId}'.`);

    await updateDoc(ref, {
      "placement.isActive": false,
      "placement.isFeatured": false,
      deletedAt: serverTimestamp(),
      "timestamps.updatedAt": serverTimestamp()
    });

    return ok({ id: docId, message: "Category soft-deleted." });
  }catch(e){
    console.error("categories/delete (soft) failed:", e);
    return err(500,"Unexpected Error","Something went wrong while soft-deleting the category.");
  }
}
