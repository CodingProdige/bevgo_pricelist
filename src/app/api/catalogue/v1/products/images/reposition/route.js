import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });
const is8 =(s)=>/^\d{8}$/.test(String(s||"").trim());

/**
 * BODY:
 * {
 *   "unique_id": "00123456", // product doc id (8-digit)
 *   "from": 2,               // current 1-based position
 *   "to": 1                  // desired 1-based position
 * }
 */
export async function POST(req){
  try{
    const { unique_id, from, to } = await req.json();

    const pid = String(unique_id||"").trim();
    if (!is8(pid)) return err(400,"Invalid Product Id","'unique_id' must be an 8-digit string.");

    const fromPos = parseInt(from,10);
    const toPos   = parseInt(to,10);
    if (!Number.isFinite(fromPos) || fromPos < 1) return err(400,"Invalid 'from'","'from' must be a 1-based position.");
    if (!Number.isFinite(toPos)   || toPos   < 1) return err(400,"Invalid 'to'","'to' must be a 1-based position.");

    const ref  = doc(db,"products_v2", pid);
    const snap = await getDoc(ref);
    if (!snap.exists()) return err(404,"Product Not Found",`No product with unique_id ${pid}.`);

    const curr   = snap.data() || {};
    const images = Array.isArray(curr?.media?.images) ? [...curr.media.images] : [];
    if (images.length === 0) return err(404,"No Images","This product has no images to reorder.");

    // sort by current position (fallback to original order if missing)
    images.sort((a,b)=> (+(a?.position||0)) - (+(b?.position||0)));

    if (fromPos > images.length || toPos > images.length){
      return err(400,"Out Of Range",`Positions must be between 1 and ${images.length}.`);
    }

    // reorder
    const arr = [...images];
    const [item] = arr.splice(fromPos-1, 1);
    arr.splice(toPos-1, 0, item);

    // rewrite contiguous positions 1..N
    const reindexed = arr.map((img, i) => ({ ...img, position: i+1 }));

    await updateDoc(ref, {
      "media.images": reindexed,
      "timestamps.updatedAt": serverTimestamp()
    });

    return ok({
      unique_id: pid,
      message: "Images repositioned.",
      affected: reindexed.length,
      final_order: reindexed.map(x => ({ imageUrl: x.imageUrl, position: x.position }))
    });
  }catch(e){
    console.error("products_v2/images/reposition failed:", e);
    return err(500,"Unexpected Error","Failed to reposition images.");
  }
}
