import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, query, where, getDocs, doc, getDoc, deleteDoc } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

export async function POST(req){
  try{
    const { id, slug } = await req.json();
    if (!id && !slug) return err(400,"Missing Locator","Provide 'id' (preferred) or 'slug'.");

    let docId = (id||"").trim();
    if (!docId){
      const rs = await getDocs(query(collection(db,"categories"), where("category.slug","==", String(slug||"").trim())));
      if (rs.empty) return err(404,"Not Found",`No category with slug '${slug}'.`);
      if (rs.size>1) return err(409,"Slug Not Unique",`Multiple categories share slug '${slug}'.`);
      docId = rs.docs[0].id;
    }

    const ref = doc(db,"categories", docId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return err(404,"Not Found",`No category id '${docId}'.`);

    await deleteDoc(ref);
    return ok({ id: docId, message: "Category permanently deleted." });
  } catch (e) {
    console.error("categories/purge failed:", e);
    return err(500,"Unexpected Error","Something went wrong while deleting the category.");
  }
}
