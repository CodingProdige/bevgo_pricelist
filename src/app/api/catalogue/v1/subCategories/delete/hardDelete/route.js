/**
 * NAME: Purge Sub-Category (Hard Delete)
 * PATH: /api/sub_categories/purge
 * METHOD: POST
 *
 * WARNING:
 *   - Permanently deletes the document from Firestore.
 *   - No cascading or guardrails. Use with care.
 *
 * INPUT:
 *   - slug (string, required): document id
 *
 * RESPONSE:
 *   - 200: { ok:true, slug, message:"Sub-category permanently deleted." }
 *   - 4xx/5xx: { ok:false, title, message }
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, deleteDoc } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

export async function POST(req){
  try{
    const { slug } = await req.json();
    const id = String(slug ?? "").trim();
    if (!id) return err(400,"Invalid Slug","'slug' is required.");

    const ref = doc(db,"sub_categories", id);
    const snap = await getDoc(ref);
    if (!snap.exists()) return err(404,"Not Found",`No sub-category '${id}'.`);

    await deleteDoc(ref);
    return ok({ slug: id, message: "Sub-category permanently deleted." });
  }catch(e){
    console.error("sub_categories/purge (hard delete) failed:", e);
    return err(500,"Unexpected Error","Something went wrong while deleting the sub-category.");
  }
}
