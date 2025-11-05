import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, doc, getDoc, getDocs, query, where, writeBatch
} from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });
const chunk=(a,n)=>{ const r=[]; for(let i=0;i<a.length;i+=n) r.push(a.slice(i,i+n)); return r; };

export async function POST(req){
  try{
    const { id, slug, position } = await req.json();
    const newPos = Math.max(1, parseInt(position,10) || 1);
    if (!id && !slug) return err(400,"Missing Locator","Provide 'id' (preferred) or 'slug'.");

    // Resolve docId
    let docId = (id||"").trim();
    if (!docId){
      const s = String(slug||"").trim();
      const rs = await getDocs(query(collection(db,"sub_categories"), where("subCategory.slug","==", s)));
      if (rs.empty)  return err(404,"Not Found",`No sub-category with slug '${s}'.`);
      if (rs.size>1) return err(409,"Slug Not Unique",`Multiple sub-categories share slug '${s}'.`);
      docId = rs.docs[0].id;
    }

    // Load the target document (need its parent category for scope)
    const ref = doc(db,"sub_categories", docId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return err(404,"Not Found","Sub-category not found.");
    const data = snap.data() || {};
    const parentCat = String(data?.grouping?.category || "").trim();
    if (!parentCat) return err(409,"Missing Category","Sub-category is missing 'grouping.category'.");

    // Fetch all subs under that category (no orderBy to avoid composite index)
    const col = collection(db,"sub_categories");
    const rs  = await getDocs(query(col, where("grouping.category","==", parentCat)));

    // Build sortable array (fallback position pushes to end)
    const rows = rs.docs.map(d => {
      const pos = Number(d.data()?.placement?.position ?? Number.POSITIVE_INFINITY);
      return { id: d.id, pos: Number.isFinite(pos) ? pos : Number.POSITIVE_INFINITY };
    });

    // Sort in memory by position asc; items with missing/NaN go last
    rows.sort((a,b)=>a.pos-b.pos);

    // Build id list, move target
    const ids = rows.map(r => r.id);
    const fromIdx = ids.indexOf(docId);
    if (fromIdx < 0) return err(404,"Not Found","Sub-category not in ordering.");

    const arr = [...ids];
    const item = arr.splice(fromIdx,1)[0];
    const targetIdx = Math.min(Math.max(newPos,1), arr.length+1) - 1; // 0-based
    arr.splice(targetIdx, 0, item);

    // Write contiguous positions 1..N in chunks
    let affected = 0;
    for (const part of chunk(arr, 450)){
      const b = writeBatch(db);
      part.forEach((cid) => {
        const pos = arr.indexOf(cid) + 1;
        b.update(doc(db,"sub_categories", cid), { "placement.position": pos });
        affected++;
      });
      await b.commit();
    }

    return ok({
      message: "Sub-category repositioned.",
      id: docId,
      category: parentCat,
      final_position: targetIdx + 1,
      affected
    });
  } catch (e) {
    console.error("sub_categories/reposition failed:", e);
    return err(500,"Unexpected Error","Failed to reposition sub-category.", {
      details: String(e?.message||"").slice(0,300)
    });
  }
}
