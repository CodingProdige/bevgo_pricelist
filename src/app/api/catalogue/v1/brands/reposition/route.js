// app/api/brands/reposition/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, doc, getDoc, getDocs, query, where, writeBatch
} from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true,  ...p },{ status:s });
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
      const rs = await getDocs(query(collection(db,"brands"), where("brand.slug","==", s)));
      if (rs.empty)  return err(404,"Not Found",`No brand with slug '${s}'.`);
      if (rs.size>1) return err(409,"Slug Not Unique",`Multiple brands share slug '${s}'.`);
      docId = rs.docs[0].id;
    }

    // Load target (need its category for scope)
    const ref = doc(db,"brands", docId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return err(404,"Not Found","Brand not found.");
    const data = snap.data() || {};
    const category = String(data?.grouping?.category || "").trim();
    if (!category) return err(409,"Missing Category","Brand is missing 'grouping.category'.");

    // Fetch scope = all brands in same category (no orderBy; sort in memory)
    const rs = await getDocs(query(collection(db,"brands"), where("grouping.category","==", category)));

    const rows = rs.docs.map(d => {
      const pos = Number(d.data()?.placement?.position ?? Number.POSITIVE_INFINITY);
      return { id: d.id, pos: Number.isFinite(pos) ? pos : Number.POSITIVE_INFINITY };
    }).sort((a,b)=>a.pos-b.pos);

    const ids = rows.map(r=>r.id);
    const fromIdx = ids.indexOf(docId);
    if (fromIdx < 0) return err(404,"Not Found","Brand not in ordering.");

    const arr = [...ids];
    const item = arr.splice(fromIdx,1)[0];
    const targetIdx = Math.min(Math.max(newPos,1), arr.length+1) - 1;
    arr.splice(targetIdx, 0, item);

    // Write back contiguous positions
    let affected = 0;
    for (const part of chunk(arr, 450)){
      const b = writeBatch(db);
      part.forEach(cid => {
        const pos = arr.indexOf(cid) + 1;
        b.update(doc(db,"brands", cid), { "placement.position": pos });
        affected++;
      });
      await b.commit();
    }

    return ok({
      message: "Brand repositioned.",
      id: docId,
      category,
      final_position: targetIdx + 1,
      affected
    });
  } catch (e) {
    console.error("brands/reposition failed:", e);
    return err(500,"Unexpected Error","Failed to reposition brand.", {
      details: String(e?.message||"").slice(0,300)
    });
  }
}
