// app/api/returnables/delete/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, deleteDoc } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });
const is8 =(s)=>/^\d{8}$/.test(String(s??"").trim());

export async function POST(req){
  try{
    const { returnable_id } = await req.json();

    const rid = String(returnable_id ?? "").trim();
    if (!is8(rid)) return err(400,"Invalid Returnable ID","'returnable_id' must be an 8-digit string.");

    const ref = doc(db,"returnables", rid);
    const snap = await getDoc(ref);
    if (!snap.exists()) return err(404,"Not Found",`No returnable with id '${rid}'.`);

    // (Optional: add referential checks here if you later link returnables to variants)
    await deleteDoc(ref);

    return ok({ message:"Returnable deleted.", returnable_id: rid });
  }catch(e){
    console.error("returnables/delete failed:", e);
    return err(500,"Unexpected Error","Something went wrong while deleting the returnable.");
  }
}
