// app/api/returnables/reposition/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, getDocs, doc, getDoc, writeBatch, serverTimestamp
} from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });
const is8 =(s)=>/^\d{8}$/.test(String(s??"").trim());

const chunk=(arr,n)=>{ const out=[]; for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; };

export async function POST(req){
  try{
    const { returnable_id, position } = await req.json();

    const rid = String(returnable_id ?? "").trim();
    if (!is8(rid)) return err(400,"Invalid Returnable ID","'returnable_id' must be an 8-digit string.");

    const newPos = Math.max(1, parseInt(position,10) || 1);

    // Ensure target exists
    const targetRef = doc(db,"returnables_v2", rid);
    const targetSnap = await getDoc(targetRef);
    if (!targetSnap.exists()) return err(404,"Not Found",`No returnable with id '${rid}'.`);

    // Load ALL returnables (in memory)
    const rs = await getDocs(collection(db,"returnables_v2"));
    if (rs.empty) return err(409,"No Returnables","There are no returnables to reorder.");

    // Build an ordered list by placement.position asc (missing -> Infinity)
    const list = rs.docs
      .map(d => ({
        id: d.id,
        data: d.data() || {},
        pos: Number.isFinite(+d.data()?.placement?.position)
              ? +d.data().placement.position
              : Number.POSITIVE_INFINITY
      }))
      .sort((a,b)=>a.pos - b.pos);

    // If some positions were missing, normalize to 1..N first
    list.forEach((row, idx) => { row.pos = idx + 1; });

    const ids = list.map(r => r.id);
    const fromIdx = ids.indexOf(rid);
    if (fromIdx < 0) return err(404,"Not Found","Returnable not found in ordering.");

    // Move to target index (0-based), clamp to [0..N-1]
    const arr = [...ids];
    const item = arr.splice(fromIdx,1)[0];
    const targetIdx = Math.min(Math.max(newPos,1), arr.length+1) - 1;
    arr.splice(targetIdx,0,item);

    // Write back contiguous positions 1..N
    let affected = 0;
    for (const part of chunk(arr, 400)) {
      const batch = writeBatch(db);
      part.forEach((id, iPartIdx) => {
        const absoluteIdx = arr.indexOf(id); // pos in full array
        const pos = absoluteIdx + 1;
        batch.update(doc(db,"returnables_v2", id), {
          "placement.position": pos,
          "timestamps.updatedAt": serverTimestamp()
        });
        affected++;
      });
      await batch.commit();
    }

    return ok({
      message: "Returnable repositioned.",
      returnable_id: rid,
      final_position: targetIdx + 1,
      affected
    });
  }catch(e){
    console.error("returnables/reposition failed:", e);
    return err(500,"Unexpected Error","Failed to reposition returnable.");
  }
}
