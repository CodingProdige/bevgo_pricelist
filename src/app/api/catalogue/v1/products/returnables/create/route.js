import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, doc, getDoc, getDocs, setDoc,
  serverTimestamp, getCountFromServer
} from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

/* -------- helpers -------- */
const is8 = (s)=>/^\d{8}$/.test(String(s??"").trim());
const money2 = (v)=> Number.isFinite(+v) ? Math.max(0, Math.round(+v*100)/100) : 0;
const toNum  = (v)=> Number.isFinite(+v) ? +v : 0;
const toBool = (v,def=false)=>{
  if (typeof v==="boolean") return v;
  if (v==null) return def;
  const s=String(v).toLowerCase();
  if (["true","1","yes"].includes(s)) return true;
  if (["false","0","no"].includes(s)) return false;
  return def;
};
const slugify = (s)=> String(s??"")
  .normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
  .replace(/[^a-zA-Z0-9]+/g,"-").replace(/^-+|-+$/g,"").toLowerCase();

async function nextPosition(){
  const snap = await getCountFromServer(collection(db,"returnables_v2"));
  return (snap.data().count || 0) + 1;
}

async function slugExists(slug){
  const snap = await getDocs(collection(db,"returnables_v2"));
  for (const d of snap.docs){
    const s = String(d.data()?.returnable?.slug ?? "").trim().toLowerCase();
    if (s && s === String(slug).toLowerCase()) return true;
  }
  return false;
}

async function unitExists(unit){
  const u = String(unit??"").trim().toLowerCase();
  if (!u) return false;
  const snap = await getDocs(collection(db,"volume_units"));
  for (const d of snap.docs){
    const sym = String(d.data()?.symbol ?? "").trim().toLowerCase();
    if (sym === u) return true;
  }
  return false;
}

const tsToIso = v => v && typeof v?.toDate==="function" ? v.toDate().toISOString() : v ?? null;
const normalizeTimestamps = doc => !doc||typeof doc!=="object"? doc : ({
  ...doc,
  ...(doc.timestamps? { timestamps:{ createdAt:tsToIso(doc.timestamps.createdAt), updatedAt:tsToIso(doc.timestamps.updatedAt) } } : {})
});

/* -------- route -------- */
export async function POST(req){
  try{
    const { data } = await req.json();
    if (!data || typeof data!=="object") {
      return err(400,"Invalid Data","Provide a 'data' object.");
    }

    // required: returnable_id + slug
    const rid = String(data?.returnable?.returnable_id ?? "").trim();
    if (!is8(rid)) return err(400,"Invalid Returnable ID","'returnable.returnable_id' must be an 8-digit string.");

    let slug = String(data?.returnable?.slug ?? "").trim();
    if (!slug) return err(400,"Missing Slug","Provide 'returnable.slug'.");
    slug = slugify(slug);

    // uniqueness checks
    const ref = doc(db,"returnables_v2", rid);
    const exist = await getDoc(ref);
    if (exist.exists()) return err(409,"Returnable Exists",`A returnable with id '${rid}' already exists.`);
    if (await slugExists(slug)) return err(409,"Duplicate Slug",`A returnable with slug '${slug}' already exists.`);

    // validate volume unit
    const volume_unit = String(data?.pack?.volume_unit ?? "").trim();
    if (volume_unit && !(await unitExists(volume_unit))) {
      return err(400,"Unknown Volume Unit",`'${volume_unit}' is not in volume_units.`);
    }

    // position
    const position =
      Number.isFinite(+data?.placement?.position) && +data.placement.position>0
        ? Math.trunc(+data.placement.position)
        : await nextPosition();

    const body = {
      docId: rid,
      returnable: {
        returnable_id: rid,
        title: String(data?.returnable?.title ?? "").trim(),
        slug
      },
      grouping: {
        category: String(data?.grouping?.category ?? "").trim() || null,
        type:     String(data?.grouping?.type ?? "").trim()     || null
      },
      pricing: {
        partial_returnable_price_excl: money2(data?.pricing?.partial_returnable_price_excl),
        full_returnable_price_excl:    money2(data?.pricing?.full_returnable_price_excl)
      },
      pack: {
        volume: Math.max(0, toNum(data?.pack?.volume)),
        volume_unit: volume_unit || null
      },
      placement: {
        position,
        isActive: toBool(data?.placement?.isActive, true)
      },
      timestamps: { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
    };

    await setDoc(ref, body);
    const saved = await getDoc(ref);
    const dataOut = normalizeTimestamps(saved.data()||{});
    return ok({ message:"Returnable created.", id:saved.id, data:dataOut }, 201);

  }catch(e){
    console.error("returnables_v2/create failed:", e);
    return err(500,"Unexpected Error","Something went wrong while creating the returnable.");
  }
}
