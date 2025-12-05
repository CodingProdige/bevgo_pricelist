import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, doc, getDoc, getDocs, query, where, writeBatch
} from "firebase/firestore";

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, data:{...p} },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

const chunk = (arr,size)=>{
  const out=[];
  for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size));
  return out;
};

const is8 = (s)=>/^\d{8}$/.test(String(s||"").trim());

export async function POST(req){
  try{
    const body = await req.json().catch(()=>({}));

    const unique_id = String(body?.unique_id ?? "").trim();
    const direction = String(body?.direction ?? "").toLowerCase();

    if (!is8(unique_id))
      return err(400,"Invalid Product Id","'unique_id' must be 8 digits.");

    if (!["up","down"].includes(direction))
      return err(400,"Invalid Direction","Must be 'up' or 'down'.");

    // Load the product
    const ref = doc(db,"products_v2", unique_id);
    const snap = await getDoc(ref);
    if (!snap.exists())
      return err(404,"Not Found","Product not found.");

    const data = snap.data() ?? {};

    const category    = String(data?.grouping?.category ?? "").trim();
    const subCategory = String(data?.grouping?.subCategory ?? "").trim();
    const brand       = String(data?.grouping?.brand ?? "").trim();

    if (!category || !subCategory || !brand)
      return err(409,"Missing Grouping","Product grouping incomplete.");

    // Fetch siblings in SAME grouping
    const rs = await getDocs(query(
      collection(db,"products_v2"),
      where("grouping.category","==", category),
      where("grouping.subCategory","==", subCategory),
      where("grouping.brand","==", brand)
    ));

    const rows = rs.docs.map((d,i)=>({
      id: d.id,
      pos: Number.isFinite(+d.data()?.placement?.position)
        ? +d.data().placement.position
        : i+1
    }))
    .sort((a,b)=>a.pos - b.pos);

    if (!rows.length)
      return err(404,"Empty","No products found in this grouping.");

    const ids = rows.map(r=>r.id);
    const fromIdx = ids.indexOf(unique_id);

    if (fromIdx === -1)
      return err(404,"Not Found","Product not in ordering.");

    const len = ids.length;

    // wrap-around one-step movement
    const targetIdx = direction === "up"
      ? (fromIdx - 1 + len) % len
      : (fromIdx + 1) % len;

    // nudge
    const arr = [...ids];
    const [moved] = arr.splice(fromIdx,1);
    arr.splice(targetIdx,0,moved);

    // Build the position map (no duplicates)
    const posMap = arr.reduce((acc,id,i)=>{
      acc[id] = i + 1;
      return acc;
    },{});

    // Write contiguous positions
    let affected = 0;
    for (const part of chunk(arr,450)){
      const batch = writeBatch(db);
      part.forEach(cid=>{
        batch.update(doc(db,"products_v2",cid),{
          "placement.position": posMap[cid]
        });
        affected++;
      });
      await batch.commit();
    }

    return ok({
      message: "Product nudged.",
      unique_id,
      category,
      subCategory,
      brand,
      from_index: fromIdx,
      final_index: targetIdx,
      affected
    });

  } catch(e){
    console.error("products_v2/nudge failed:", e);
    return err(500,"Unexpected Error","Failed to nudge product.",{
      details: String(e?.message ?? "").slice(0,300)
    });
  }
}
