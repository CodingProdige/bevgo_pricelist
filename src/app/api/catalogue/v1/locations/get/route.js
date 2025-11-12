import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, doc, getDoc, getDocs } from "firebase/firestore";

/* ---------- response helpers ---------- */
const ok  =(p={},s=200)=>NextResponse.json({ok:true,...p},{status:s});
const err =(s,t,m,e={})=>NextResponse.json({ok:false,title:t,message:m,...e},{status:s});

/* ---------- type helpers ---------- */
function normStr(v){
  const s = String(v ?? "").trim();
  if (!s) return "";
  const low = s.toLowerCase();
  if (low === "null" || low === "undefined") return "";
  return s;
}
function toBool(v){
  if (typeof v === "boolean") return v;
  const s = normStr(v).toLowerCase();
  if (!s) return null;
  if (["true","1","yes","y"].includes(s)) return true;
  if (["false","0","no","n"].includes(s)) return false;
  return null;
}
function tsToIso(v){
  return v && typeof v?.toDate === "function" ? v.toDate().toISOString() : v ?? null;
}
function normalizeTimestamps(doc){
  if (!doc || typeof doc !== "object") return doc;
  const ts = doc.timestamps;
  return {
    ...doc,
    ...(ts ? { 
      timestamps: { 
        createdAt: tsToIso(ts.createdAt), 
        updatedAt: tsToIso(ts.updatedAt) 
      } 
    } : {})
  };
}

/* ---------- main handler ---------- */
export async function GET(req){
  try{
    const { searchParams } = new URL(req.url);

    const byId = normStr(searchParams.get("id"));
    const byLocId = normStr(searchParams.get("location_id"));

    // ----- Single lookup -----
    if (byId || byLocId){
      const ref = doc(db, "bevgo_locations", byId || byLocId);
      const snap = await getDoc(ref);
      if (!snap.exists()) return err(404, "Not Found", `No location found with id '${byId || byLocId}'.`);
      const data = normalizeTimestamps(snap.data() || {});
      data.docId = snap.id;
      return ok({ id: snap.id, data });
    }

    // ----- List mode -----
    const isActive   = toBool(searchParams.get("isActive"));
    const isPrimary  = toBool(searchParams.get("isPrimary"));
    const typeFilter = normStr(searchParams.get("type"));
    const rawLimitNorm = normStr(searchParams.get("limit"));
    const rawLimit = (rawLimitNorm || "all").toLowerCase();
    const noLimit = rawLimit === "all";
    let lim = noLimit ? null : Number.parseInt(rawLimit, 10);
    if (!noLimit && (!Number.isFinite(lim) || lim <= 0)) lim = 50;

    const col = collection(db, "bevgo_locations");
    const rs = await getDocs(col);

    let items = rs.docs.map(d => ({
      id: d.id,
      data: normalizeTimestamps(d.data() || {})
    }));

    // Apply filters
    items = items.filter(({ data }) => {
      if (isActive !== null && !!data?.placement?.isActive !== isActive) return false;
      if (isPrimary !== null && !!data?.placement?.isPrimary !== isPrimary) return false;
      if (typeFilter && data?.type?.toLowerCase() !== typeFilter.toLowerCase()) return false;
      return true;
    });

    // Sort by placement.position asc
    items.sort((a,b)=>{
      const pa = +a.data?.placement?.position || 0;
      const pb = +b.data?.placement?.position || 0;
      return pa - pb;
    });

    if (!noLimit && lim != null) items = items.slice(0, lim);
    const count = items.length;

    // Normalize for final return
    const data = items.map(it => ({
      ...it.data,
      docId: it.id
    }));

    return ok({ count, data });
  }catch(e){
    console.error("bevgo_locations/get failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while fetching locations.");
  }
}
