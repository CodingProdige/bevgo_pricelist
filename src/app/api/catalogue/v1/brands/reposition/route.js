import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, doc, getDocs, query, where, writeBatch
} from "firebase/firestore";

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, data:{...p} },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
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

    // Resolve brand by slug
    const rs = await getDocs(query(
      collection(db,"brands"),
      where("brand.slug","==", slug)
    ));

    if (rs.empty)
      return err(404,"Not Found",`No brand found with slug '${slug}'.`);
    if (rs.size > 1)
      return err(409,"Conflict","Multiple brands share this slug.");

    const brandDoc = rs.docs[0];
    const docId = brandDoc.id;

    // Fetch ALL brands (global ordering)
    const allSnap = await getDocs(collection(db,"brands"));

    const rows = allSnap.docs.map((d, i) => {
      const pos = Number.isFinite(+d.data()?.placement?.position)
        ? +d.data().placement.position
        : i + 1;
      return { id: d.id, pos };
    })
    .sort((a,b)=>a.pos - b.pos);

    if (!rows.length)
      return err(404,"Empty","No brands in collection.");

    const ids = rows.map(r=>r.id);
    const fromIdx = ids.indexOf(docId);

    if (fromIdx === -1)
      return err(404,"Not Found","Brand not found in ordering.");

    const len = ids.length;

    // wrap-around one-step movement
    const targetIdx = direction === "up"
      ? (fromIdx - 1 + len) % len
      : (fromIdx + 1) % len;

    // nudge
    const arr = [...ids];
    const [moved] = arr.splice(fromIdx,1);
    arr.splice(targetIdx,0,moved);

    // BUILD POSITION MAP → NO DUPLICATES EVER
    const posMap = arr.reduce((acc, id, i) => {
      acc[id] = i + 1;
      return acc;
    }, {});

    // WRITE BACK CONTIGUOUS POSITIONS
    let affected = 0;
    for (const part of chunk(arr, 450)){
      const batch = writeBatch(db);
      part.forEach(cid=>{
        batch.update(doc(db,"brands",cid),{
          "placement.position": posMap[cid]
        });
        affected++;
      });
      await batch.commit();
    }

    return ok({
      message: "Brand nudged.",
      slug,
      from_index: fromIdx,
      final_index: targetIdx,
      affected
    });

  } catch (e){
    console.error("brands/nudge failed:", e);
    return err(500,"Unexpected Error","Failed to nudge brand.",{
      details: String(e?.message ?? "").slice(0,300)
    });
  }
}
