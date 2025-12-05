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

    // Resolve subcategory by slug
    const rs = await getDocs(query(
      collection(db,"sub_categories"),
      where("subCategory.slug","==", slug)
    ));

    if (rs.empty)
      return err(404,"Not Found",`No sub-category found with slug '${slug}'.`);
    if (rs.size > 1)
      return err(409,"Conflict","Multiple sub-categories share this slug.");

    const docSnap = rs.docs[0];
    const docId = docSnap.id;

    // -------- GLOBAL ORDERING (no category scoping) --------
    const allSnap = await getDocs(collection(db,"sub_categories"));

    const rows = allSnap.docs.map((d,i)=>({
      id: d.id,
      pos: Number.isFinite(+d.data()?.placement?.position)
        ? +d.data().placement.position
        : i+1
    }))
    .sort((a,b)=>a.pos - b.pos);

    if (!rows.length)
      return err(404,"Empty","No sub-categories available.");

    const ids = rows.map(r=>r.id);
    const fromIdx = ids.indexOf(docId);

    if (fromIdx === -1)
      return err(404,"Not Found","Sub-category not in ordering.");

    const len = ids.length;

    // wrap-around movement
    const targetIdx = direction === "up"
      ? (fromIdx - 1 + len) % len
      : (fromIdx + 1) % len;

    // reorder
    const arr = [...ids];
    const [moved] = arr.splice(fromIdx,1);
    arr.splice(targetIdx,0,moved);

    // position map
    const posMap = arr.reduce((acc,id,i)=>{
      acc[id] = i + 1;
      return acc;
    },{});

    // write back contiguous positions
    let affected = 0;
    for (const part of chunk(arr,450)){
      const batch = writeBatch(db);
      part.forEach(cid=>{
        batch.update(doc(db,"sub_categories",cid),{
          "placement.position": posMap[cid]
        });
        affected++;
      });
      await batch.commit();
    }

    return ok({
      message: "Sub-category nudged.",
      slug,
      from_index: fromIdx,
      final_index: targetIdx,
      affected
    });

  } catch(e){
    console.error("sub_categories/nudge failed:", e);
    return err(500,"Unexpected Error","Failed to nudge sub-category.",{
      details: String(e?.message ?? "").slice(0,300)
    });
  }
}
