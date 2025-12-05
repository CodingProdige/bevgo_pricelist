import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, getDocs, doc, getDoc, writeBatch, serverTimestamp
} from "firebase/firestore";

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, data:{...p} },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

const chunk = (arr,n)=>{
  const out = [];
  for (let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n));
  return out;
};

const is8 = (s)=>/^\d{8}$/.test(String(s||"").trim());

export async function POST(req){
  try{
    const body = await req.json().catch(()=>({}));

    const returnable_id = String(body?.returnable_id ?? "").trim();
    const direction     = String(body?.direction ?? "").toLowerCase();

    if (!is8(returnable_id))
      return err(400,"Invalid Returnable ID","'returnable_id' must be 8 digits.");

    if (!["up","down"].includes(direction))
      return err(400,"Invalid Direction","Direction must be 'up' or 'down'.");

    // Ensure returnable exists
    const targetRef = doc(db,"returnables_v2", returnable_id);
    const targetSnap = await getDoc(targetRef);

    if (!targetSnap.exists())
      return err(404,"Not Found",`No returnable with id '${returnable_id}'.`);

    // Fetch ALL returnables (global ordering)
    const rs = await getDocs(collection(db,"returnables_v2"));
    if (rs.empty)
      return err(404,"Empty","No returnables available.");

    // Build normalized sortable list
    const rows = rs.docs.map((d,i)=>({
      id: d.id,
      pos: Number.isFinite(+d.data()?.placement?.position)
        ? +d.data().placement.position
        : i+1
    }))
    .sort((a,b)=>a.pos - b.pos);

    const ids = rows.map(r=>r.id);
    const fromIdx = ids.indexOf(returnable_id);

    if (fromIdx === -1)
      return err(404,"Not Found","Returnable not in ordering.");

    const len = ids.length;

    // wrap-around movement
    const targetIdx =
      direction === "up"
        ? (fromIdx - 1 + len) % len
        : (fromIdx + 1) % len;

    // reorder list
    const arr = [...ids];
    const [moved] = arr.splice(fromIdx,1);
    arr.splice(targetIdx,0,moved);

    // build position map (1..N)
    const posMap = arr.reduce((acc,id,i)=>{
      acc[id] = i + 1;
      return acc;
    },{});

    // write back positions
    let affected = 0;
    for (const part of chunk(arr,400)){
      const batch = writeBatch(db);
      part.forEach(cid=>{
        batch.update(doc(db,"returnables_v2",cid),{
          "placement.position": posMap[cid],
          "timestamps.updatedAt": serverTimestamp()
        });
        affected++;
      });
      await batch.commit();
    }

    return ok({
      message: "Returnable nudged.",
      returnable_id,
      from_index: fromIdx,
      final_index: targetIdx,
      affected
    });

  } catch (e){
    console.error("returnables/nudge failed:", e);
    return err(500,"Unexpected Error","Failed to nudge returnable.",{
      details: String(e?.message ?? "").slice(0,300)
    });
  }
}
