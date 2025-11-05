// app/api/products_v2/inventory/update/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, runTransaction, serverTimestamp } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });
const is8 =(s)=>/^\d{8}$/.test(String(s||"").trim());
const toInt=(v,f=0)=>Number.isFinite(+v)?Math.trunc(+v):f;
const toBool=(v,f=false)=>typeof v==="boolean"?v:typeof v==="number"?v!==0:typeof v==="string"?["true","1","yes"].includes(v.toLowerCase()):f;

export async function POST(req){
  try{
    const { unique_id, warehouse_id, data } = await req.json();
    const pid = String(unique_id||"").trim();
    const wh  = String(warehouse_id||"").trim();
    if (!is8(pid)) return err(400,"Invalid Product Id","'unique_id' must be an 8-digit string.");
    if (!wh) return err(400,"Missing Warehouse","'warehouse_id' is required.");
    if (!data || typeof data!=="object") return err(400,"Invalid Data","Provide a 'data' object.");

    await runTransaction(db, async (tx)=>{
      const ref = doc(db,"products_v2", pid);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("NOT_FOUND");

      const curr = snap.data()||{};
      const inv = Array.isArray(curr.inventory)?[...curr.inventory]:[];
      const idx = inv.findIndex(r => String(r.warehouse_id||"").trim() === wh);
      if (idx<0) throw new Error("ROW_NOT_FOUND");

      const row = { ...inv[idx] };
      if ("warehouse_postal_code" in data) row.warehouse_postal_code = data.warehouse_postal_code ?? null;
      if ("supplier_out_of_stock" in data) row.supplier_out_of_stock = toBool(data.supplier_out_of_stock, row.supplier_out_of_stock);
      if ("in_stock" in data)             row.in_stock             = toBool(data.in_stock,             row.in_stock);
      if ("unit_stock_qty" in data)       row.unit_stock_qty       = toInt(data.unit_stock_qty, row.unit_stock_qty);

      // optional fields
      if ("reserved_qty" in data)   row.reserved_qty   = toInt(data.reserved_qty, row.reserved_qty ?? 0);

      row.updated_at = new Date().toISOString();
      inv[idx] = row;

      tx.update(ref, { inventory: inv, "timestamps.updatedAt": serverTimestamp() });
    });

    return ok({ message: "Inventory row updated.", warehouse_id: wh });
  }catch(e){
    if (String(e.message)==="NOT_FOUND")     return err(404,"Not Found","Product not found.");
    if (String(e.message)==="ROW_NOT_FOUND") return err(404,"Not Found","No inventory row for that warehouse_id.");
    console.error("inventory/update failed:", e);
    return err(500,"Unexpected Error","Failed to update inventory row.");
  }
}
