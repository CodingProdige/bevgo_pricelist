import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, doc, getDoc, getDocs, orderBy, query, writeBatch } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });
const chunk=(a,n)=>{const r=[];for(let i=0;i<a.length;i+=n)r.push(a.slice(i,i+n));return r;};

export async function POST(req){
  try{
    const { id, position } = await req.json();
    const docId = String(id || "").trim();
    const newPos = Math.max(1, parseInt(position,10) || 1);
    if (!docId) return err(400,"Invalid Id","'id' is required.");

    const ref = doc(db,"bevgo_locations",docId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return err(404,"Not Found","Location not found.");
    const curr = snap.data() || {};
    const currPos = +curr?.placement?.position || 1;

    // fetch full ordered list
    const col = collection(db,"bevgo_locations");
    const rs = await getDocs(query(col, orderBy("placement.position","asc")));
    const rows = rs.docs.map(d => ({
      id: d.id,
      pos: +(d.data()?.placement?.position || 0)
    })).sort((a,b) => a.pos - b.pos);

    // rebuild ordering
    const ids = rows.map(r => r.id);
    const fromIdx = ids.indexOf(docId);
    if (fromIdx < 0) return err(404,"Not Found","Location not found in ordering.");

    const arr = [...ids];
    const item = arr.splice(fromIdx,1)[0];
    const targetIdx = Math.min(Math.max(newPos,1), arr.length+1) - 1; // 0-based
    arr.splice(targetIdx,0,item);

    // update positions in contiguous order using batched writes
    let affected = 0;
    for (const part of chunk(arr, 450)) {
      const batch = writeBatch(db);
      part.forEach((id, iPartIdx) => {
        const absoluteIdx = arr.indexOf(id);
        const pos = absoluteIdx + 1;
        batch.update(doc(db,"bevgo_locations",id), { "placement.position": pos });
        affected++;
      });
      await batch.commit();
    }

    return ok({
      message: "Location repositioned.",
      affected,
      final_position: targetIdx + 1
    });
  }catch(e){
    console.error("bevgo_locations/reposition failed:", e);
    return err(500,"Unexpected Error","Failed to reposition location.");
  }
}
