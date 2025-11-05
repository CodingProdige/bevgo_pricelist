// app/api/products_v2/reposition/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, doc, getDoc, getDocs, query, where, writeBatch
} from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true,  ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });
const chunk=(a,n)=>{ const r=[]; for(let i=0;i<a.length;i+=n) r.push(a.slice(i,i+n)); return r; };
const is8 =(s)=>/^\d{8}$/.test(String(s||"").trim());

export async function POST(req){
  try{
    const { id, unique_id, position } = await req.json();
    const pid = String(id ?? unique_id ?? "").trim();
    const newPos = Math.max(1, parseInt(position,10) || 1);
    if (!pid) return err(400,"Missing Locator","Provide 'unique_id' (8-digit) or 'id'.");
    if (!is8(pid)) return err(400,"Invalid Product Id","'unique_id' must be an 8-digit string.");

    // Load target product
    const ref = doc(db,"products_v2", pid);
    const snap = await getDoc(ref);
    if (!snap.exists()) return err(404,"Not Found","Product not found.");

    const data = snap.data() || {};
    const category    = String(data?.grouping?.category || "").trim();
    const subCategory = String(data?.grouping?.subCategory || "").trim();
    const brand       = String(data?.grouping?.brand || "").trim();

    if (!category || !subCategory || !brand) {
      return err(409,"Missing Grouping","Product requires grouping.category, grouping.subCategory, and grouping.brand.");
    }

    // Scope: same (category, subCategory, brand)
    const rs = await getDocs(query(
      collection(db,"products_v2"),
      where("grouping.category","==", category),
      where("grouping.subCategory","==", subCategory),
      where("grouping.brand","==", brand)
    ));

    const rows = rs.docs.map(d => {
      const pos = Number(d.data()?.placement?.position ?? Number.POSITIVE_INFINITY);
      return { id: d.id, pos: Number.isFinite(pos) ? pos : Number.POSITIVE_INFINITY };
    }).sort((a,b)=>a.pos-b.pos);

    const ids = rows.map(r=>r.id);
    const fromIdx = ids.indexOf(pid);
    if (fromIdx < 0) return err(404,"Not Found","Product not in ordering.");

    const arr = [...ids];
    const item = arr.splice(fromIdx,1)[0];
    const targetIdx = Math.min(Math.max(newPos,1), arr.length+1) - 1;
    arr.splice(targetIdx, 0, item);

    // Write back contiguous positions
    let affected = 0;
    for (const part of chunk(arr, 450)){
      const b = writeBatch(db);
      part.forEach(docId => {
        const pos = arr.indexOf(docId) + 1;
        b.update(doc(db,"products_v2", docId), { "placement.position": pos });
        affected++;
      });
      await b.commit();
    }

    return ok({
      message: "Product repositioned.",
      unique_id: pid,
      category, subCategory, brand,
      final_position: targetIdx + 1,
      affected
    });
  } catch (e) {
    console.error("products_v2/reposition failed:", e);
    return err(500,"Unexpected Error","Failed to reposition product.", {
      details: String(e?.message||"").slice(0,300)
    });
  }
}
