import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, doc, getDocs, query, where, writeBatch
} from "firebase/firestore";

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, data:{...p} },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

const chunk = (arr,size)=>{
  const out=[];
  for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size));
  return out;
};

export async function POST(req){
  try{
    const body = await req.json().catch(()=>({}));
    const slug = String(body?.slug ?? "").trim();
    const direction = String(body?.direction ?? "").toLowerCase();

    if (!slug)
      return err(400,"Missing Slug","Provide 'slug'.");
    if (!["up","down"].includes(direction))
      return err(400,"Invalid Direction","Direction must be 'up' or 'down'.");

    // Lookup category by slug
    const rs = await getDocs(query(
      collection(db,"categories"),
      where("category.slug","==", slug)
    ));

    if (rs.empty)
      return err(404,"Not Found",`No category found with slug '${slug}'.`);
    if (rs.size > 1)
      return err(409,"Conflict","Multiple categories share this slug.");

    const docSnap = rs.docs[0];
    const docId = docSnap.id;

    // Fetch ALL categories (global ordering)
    const allSnap = await getDocs(collection(db,"categories"));

    const rows = allSnap.docs.map((d,i)=>({
      id: d.id,
      pos: Number.isFinite(+d.data()?.placement?.position)
        ? +d.data().placement.position
        : i+1
    }))
    .sort((a,b)=>a.pos - b.pos);

    const ids = rows.map(r=>r.id);
    const fromIdx = ids.indexOf(docId);
    if (fromIdx === -1)
      return err(404,"Not Found","Category not in ordering.");

    const len = ids.length;
    const targetIdx =
      direction === "up"
        ? (fromIdx - 1 + len) % len
        : (fromIdx + 1) % len;

    // Nudge 1 step
    const arr = [...ids];
    const [moved] = arr.splice(fromIdx,1);
    arr.splice(targetIdx,0,moved);

    // Build deterministic position map
    const posMap = arr.reduce((acc,id,i)=>{
      acc[id] = i + 1;
      return acc;
    },{});

    // Write contiguous positions
    let affected = 0;
    for (const part of chunk(arr,450)){
      const batch = writeBatch(db);
      part.forEach(cid=>{
        batch.update(doc(db,"categories",cid),{
          "placement.position": posMap[cid]
        });
        affected++;
      });
      await batch.commit();
    }

    return ok({
      message: "Category nudged.",
      slug,
      from_index: fromIdx,
      final_index: targetIdx,
      affected
    });

  } catch(e){
    console.error("categories/nudge failed:", e);
    return err(500,"Unexpected Error","Failed to nudge category.",{
      details: String(e?.message ?? "").slice(0,300)
    });
  }
}
