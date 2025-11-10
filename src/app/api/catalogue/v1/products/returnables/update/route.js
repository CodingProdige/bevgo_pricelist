import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, updateDoc, serverTimestamp, getDocs, collection } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

const is8 = (s)=>/^\d{8}$/.test(String(s??"").trim());
const money2 = (v)=> Number.isFinite(+v) ? Math.max(0, Math.round(+v*100)/100) : 0;
const toNum  = (v)=> Number.isFinite(+v) ? +v : 0;
const slugify = (s)=> String(s??"")
  .normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
  .replace(/[^a-zA-Z0-9]+/g,"-").replace(/^-+|-+$/g,"").toLowerCase();

function deepMerge(t, p){
  if (p==null || typeof p!=="object") return t;
  const out = Array.isArray(t)? [...t] : { ...t };
  for (const [k,v] of Object.entries(p)){
    if (v && typeof v==="object" && !Array.isArray(v) && typeof out[k]==="object" && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function POST(req){
  try{
    const { returnable_id, data } = await req.json();
    const rid = String(returnable_id ?? "").trim();

    if (!is8(rid))
      return err(400,"Invalid Returnable ID","'returnable_id' must be an 8-digit string.");
    if (!data || typeof data!=="object")
      return err(400,"Invalid Data","Provide a 'data' object.");

    const ref = doc(db,"returnables_v2", rid);
    const snap = await getDoc(ref);
    if (!snap.exists())
      return err(404,"Not Found",`No returnable with id '${rid}'.`);

    const current = snap.data() || {};
    const next = deepMerge(current, data);

    if (next?.returnable?.slug)
      next.returnable.slug = slugify(next.returnable.slug);

    await updateDoc(ref, { ...next, "timestamps.updatedAt": serverTimestamp() });

    // 🔄 Propagate to all variants within products_v2
    const prods = await getDocs(collection(db,"products_v2"));
    let count = 0;
    for (const d of prods.docs){
      const pdata = d.data() || {};
      const variants = Array.isArray(pdata.variants) ? [...pdata.variants] : [];
      let modified = false;

      for (let i=0; i<variants.length; i++){
        if (variants[i]?.returnable?.returnable_id === rid){
          variants[i].returnable = next;
          modified = true;
          count++;
        }
      }

      if (modified){
        await updateDoc(doc(db,"products_v2", d.id), {
          variants,
          "timestamps.updatedAt": serverTimestamp()
        });
      }
    }

    return ok({
      message:`Returnable updated and propagated to ${count} variant${count!==1?"s":""}.`,
      returnable_id: rid,
      propagated_variants: count
    });

  }catch(e){
    console.error("returnables_v2/update failed:", e);
    return err(500,"Unexpected Error","Something went wrong while updating the returnable.");
  }
}
