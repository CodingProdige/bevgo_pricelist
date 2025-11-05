// app/api/products_v2/inventory/delete/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, runTransaction, serverTimestamp } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });
const is8 =(s)=>/^\d{8}$/.test(String(s||"").trim());

export async function POST(req){
  try{
    const { unique_id, warehouse_id } = await req.json();
    const pid = String(unique_id||"").trim();
    const wh  = String(warehouse_id||"").trim();
    if (!is8(pid)) return err(400,"Invalid Product Id","'unique_id' must be an 8-digit string.");
    if (!wh) return err(400,"Missing Warehouse","'warehouse_id' is required.");

    await runTransaction(db, async (tx)=>{
      const ref = doc(db,"products_v2", pid);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("NOT_FOUND");

      const inv = Array.isArray(snap.data()?.inventory)?[...snap.data().inventory]:[];
      const next = inv.filter(r => String(r?.warehouse_id||"").trim() !== wh);
      if (next.length === inv.length) throw new Error("ROW_NOT_FOUND");

      tx.update(ref, { inventory: next, "timestamps.updatedAt": serverTimestamp() });
    });

    return ok({ message: "Inventory row deleted.", warehouse_id: wh });
  }catch(e){
    if (String(e.message)==="NOT_FOUND")     return err(404,"Not Found","Product not found.");
    if (String(e.message)==="ROW_NOT_FOUND") return err(404,"Not Found","No inventory row for that warehouse_id.");
    console.error("inventory/delete failed:", e);
    return err(500,"Unexpected Error","Failed to delete inventory row.");
  }
}
