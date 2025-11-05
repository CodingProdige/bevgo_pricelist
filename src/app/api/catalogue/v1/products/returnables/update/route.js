// app/api/returnables/update/route.js
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

async function slugTaken(slug, exceptId){
  const snap = await getDocs(collection(db,"returnables"));
  for (const d of snap.docs){
    if (d.id === exceptId) continue;
    const s = String(d.data()?.returnable?.slug ?? "").trim().toLowerCase();
    if (s && s === slug.toLowerCase()) return true;
  }
  return false;
}

async function unitExists(unit){
  const u = String(unit??"").trim().toLowerCase();
  if (!u) return true; // treat empty as "no change"
  const snap = await getDocs(collection(db,"volume_units"));
  for (const d of snap.docs){
    const sym = String(d.data()?.symbol ?? "").trim().toLowerCase();
    if (sym === u) return true;
  }
  return false;
}

export async function POST(req){
  try{
    const { returnable_id, data } = await req.json();

    const rid = String(returnable_id ?? "").trim();
    if (!is8(rid)) return err(400,"Invalid Returnable ID","'returnable_id' must be an 8-digit string.");
    if (!data || typeof data!=="object") return err(400,"Invalid Data","Provide a 'data' object.");

    const ref = doc(db,"returnables", rid);
    const snap = await getDoc(ref);
    if (!snap.exists()) return err(404,"Not Found",`No returnable with id '${rid}'.`);

    let patch = { ...data };

    // sanitize fields if present
    if (patch.returnable){
      if (Object.prototype.hasOwnProperty.call(patch.returnable,"slug")){
        const slug = slugify(String(patch.returnable.slug ?? ""));
        if (!slug) return err(400,"Invalid Slug","'returnable.slug' cannot be empty.");
        if (await slugTaken(slug, rid)) return err(409,"Duplicate Slug",`A returnable with slug '${slug}' already exists.`);
        patch.returnable.slug = slug;
      }
      if (Object.prototype.hasOwnProperty.call(patch.returnable,"returnable_id")){
        // prevent changing id
        const incoming = String(patch.returnable.returnable_id ?? "").trim();
        if (incoming && incoming !== rid){
          return err(409,"Mismatched ID","'returnable.returnable_id' cannot differ from the document id.");
        }
      }
    }

    if (patch.pricing){
      if (Object.prototype.hasOwnProperty.call(patch.pricing,"partial_returnable_price_excl")){
        patch.pricing.partial_returnable_price_excl = money2(patch.pricing.partial_returnable_price_excl);
      }
      if (Object.prototype.hasOwnProperty.call(patch.pricing,"full_returnable_price_excl")){
        patch.pricing.full_returnable_price_excl = money2(patch.pricing.full_returnable_price_excl);
      }
    }

    if (patch.pack){
      if (Object.prototype.hasOwnProperty.call(patch.pack,"volume")){
        patch.pack.volume = Math.max(0, toNum(patch.pack.volume));
      }
      if (Object.prototype.hasOwnProperty.call(patch.pack,"volume_unit")){
        const vu = String(patch.pack.volume_unit ?? "").trim();
        if (vu && !(await unitExists(vu))) {
          return err(400,"Unknown Volume Unit",`'${vu}' is not in volume_units.`);
        }
        patch.pack.volume_unit = vu || null;
      }
    }

    if (patch.placement){
      if (Object.prototype.hasOwnProperty.call(patch.placement,"position")){
        const p = Math.trunc(+patch.placement.position);
        if (Number.isFinite(p) && p>0) patch.placement.position = p;
        else delete patch.placement.position; // ignore invalid position
      }
    }

    const next = deepMerge(snap.data()||{}, patch);

    await updateDoc(ref, { ...next, "timestamps.updatedAt": serverTimestamp() });

    return ok({ message:"Returnable updated.", returnable_id: rid });
  }catch(e){
    console.error("returnables/update failed:", e);
    return err(500,"Unexpected Error","Something went wrong while updating the returnable.");
  }
}
