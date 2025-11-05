// app/api/products_v2/inventory/add/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, runTransaction, serverTimestamp } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

const is8 =(s)=>/^\d{8}$/.test(String(s||"").trim());
const toInt=(v,f=0)=>Number.isFinite(+v)?Math.trunc(+v):f;
const toBool=(v,f=false)=>typeof v==="boolean"?v:typeof v==="number"?v!==0:typeof v==="string"?["true","1","yes"].includes(v.toLowerCase()):f;

export async function POST(req){
  try{
    const { unique_id, item } = await req.json();
    const pid = String(unique_id||"").trim();
    if (!is8(pid)) return err(400,"Invalid Product Id","'unique_id' must be an 8-digit string.");
    if (!item || typeof item!=="object") return err(400,"Invalid Item","Provide an 'item' object.");

    const wh = String(item.warehouse_id||"").trim();
    if (!wh) return err(400,"Missing Warehouse","'item.warehouse_id' is required.");

    await runTransaction(db, async (tx)=>{
      const ref = doc(db,"products_v2", pid);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("NOT_FOUND");
      const curr = snap.data()||{};
      const inv = Array.isArray(curr.inventory)?[...curr.inventory]:[];

      if (inv.some(r => String(r.warehouse_id||"").trim() === wh)){
        throw new Error("DUP_WAREHOUSE");
      }

      const row = {
        warehouse_id: wh,
        warehouse_postal_code: item.warehouse_postal_code ?? null,
        supplier_out_of_stock: toBool(item.supplier_out_of_stock, false),
        in_stock: toBool(item.in_stock, true),
        unit_stock_qty: toInt(item.unit_stock_qty, 0),

        // optional/future-proof:
        reserved_qty: toInt(item.reserved_qty, 0),
        updated_at: new Date().toISOString()
      };

      inv.push(row);
      tx.update(ref, { inventory: inv, "timestamps.updatedAt": serverTimestamp() });
    });

    return ok({ message: "Inventory row added.", warehouse_id: wh }, 201);
  }catch(e){
    if (String(e.message)==="NOT_FOUND") return err(404,"Not Found","Product not found.");
    if (String(e.message)==="DUP_WAREHOUSE") return err(409,"Duplicate Warehouse","This product already has an inventory row for that warehouse_id.");
    console.error("inventory/add failed:", e);
    return err(500,"Unexpected Error","Failed to add inventory row.");
  }
}
