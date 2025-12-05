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

    const location_id = String(body?.location_id ?? "").trim();
    const direction   = String(body?.direction ?? "").toLowerCase();

    if (!location_id)
      return err(400,"Missing Id","Provide 'location_id'.");

    if (!["up","down"].includes(direction))
      return err(400,"Invalid Direction","Direction must be 'up' or 'down'.");

    // Find doc by location_id
    const lookupSnap = await getDocs(query(
      collection(db,"bevgo_locations"),
      where("location_id","==", location_id)
    ));

    if (lookupSnap.empty)
      return err(404,"Not Found",`No location found with location_id '${location_id}'.`);

    if (lookupSnap.size > 1)
      return err(409,"Conflict","location_id must be unique.");

    const docSnap = lookupSnap.docs[0];
    const docId   = docSnap.id;

    // -------- GLOBAL ORDERING OF ALL LOCATIONS --------
    const allSnap = await getDocs(collection(db,"bevgo_locations"));

    const rows = allSnap.docs.map((d,i)=>({
      id: d.id,
      pos: Number.isFinite(+d.data()?.placement?.position)
          ? +d.data().placement.position
          : i+1
    }))
    .sort((a,b)=>a.pos - b.pos);

    if (!rows.length)
      return err(404,"Empty","No locations available.");

    const ids = rows.map(r=>r.id);
    const fromIdx = ids.indexOf(docId);

    if (fromIdx === -1)
      return err(404,"Not Found","Location not in ordering.");

    const len = ids.length;

    // wrap-around step movement
    const targetIdx = direction === "up"
      ? (fromIdx - 1 + len) % len
      : (fromIdx + 1) % len;

    // do the nudge
    const arr = [...ids];
    const [moved] = arr.splice(fromIdx,1);
    arr.splice(targetIdx,0,moved);

    // position map: { id -> position }
    const posMap = arr.reduce((acc,id,i)=>{
      acc[id] = i + 1;
      return acc;
    },{});

    // write updated positions
    let affected = 0;
    for (const part of chunk(arr,450)){
      const batch = writeBatch(db);
      part.forEach(cid=>{
        batch.update(doc(db,"bevgo_locations",cid),{
          "placement.position": posMap[cid]
        });
        affected++;
      });
      await batch.commit();
    }

    return ok({
      message: "Location nudged.",
      location_id,
      from_index: fromIdx,
      final_index: targetIdx,
      affected
    });

  } catch(e){
    console.error("bevgo_locations/nudge failed:", e);
    return err(500,"Unexpected Error","Failed to nudge location.",{
      details: String(e?.message ?? "").slice(0,300)
    });
  }
}
