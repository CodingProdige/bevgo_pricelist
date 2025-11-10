import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, doc, getDoc, getDocs } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

const toBool=(v)=>{ if (typeof v==="boolean") return v; if (v==null) return null;
  const s=String(v).toLowerCase(); if (["true","1","yes"].includes(s)) return true;
  if (["false","0","no"].includes(s)) return false; return null; };
const is8 =(s)=>/^\d{8}$/.test(String(s??"").trim());
const tsToIso = v => v && typeof v?.toDate==="function" ? v.toDate().toISOString() : v ?? null;
const normalizeTimestamps = doc => !doc||typeof doc!=="object"? doc : ({
  ...doc,
  ...(doc.timestamps? { timestamps:{ createdAt:tsToIso(doc.timestamps.createdAt), updatedAt:tsToIso(doc.timestamps.updatedAt) } } : {})
});

export async function GET(req){
  try{
    const { searchParams } = new URL(req.url);
    const val = (k)=> {
      const raw = (searchParams.get(k)||"").trim();
      if (!raw || raw.toLowerCase()==="null") return "";
      return raw;
    };

    // --- NEW: fetch returnable assigned to a specific variant across products_v2
    const byVariantId = val("variant_id");
    if (byVariantId){
      if (!is8(byVariantId)) return err(400,"Invalid Variant ID","'variant_id' must be an 8-digit string.");

      // Scan all products_v2 for variant_id
      const prs = await getDocs(collection(db, "products_v2"));
      let found = null;

      for (const d of prs.docs){
        const pdata = d.data() || {};
        const variants = Array.isArray(pdata.variants) ? pdata.variants : [];
        for (let i = 0; i < variants.length; i++){
          const v = variants[i] || {};
          if (String(v?.variant_id ?? "") === byVariantId){
            found = {
              unique_id: d.id,
              variant_index: i,
              variant: v
            };
            break;
          }
        }
        if (found) break;
      }

      if (!found) {
        return err(404, "Variant Not Found", `No variant found with variant_id '${byVariantId}'.`);
      }

      const r = found.variant?.returnable;
      if (!r || typeof r !== "object" || Object.keys(r).length === 0){
        return err(404, "No Returnable Assigned", `Variant '${byVariantId}' has no returnable assigned.`);
      }

      // Return the assigned returnable in a 'data' object for single-item parity
      return ok({
        unique_id: found.unique_id,
        variant_id: byVariantId,
        variant_index: found.variant_index,
        data: normalizeTimestamps(r)
      });
    }

    // --- Single by id (returnables_v2 doc)
    const byId = val("id");
    if (byId){
      if (!is8(byId)) return err(400,"Invalid Id","'id' must be an 8-digit string.");
      const ref = doc(db,"returnables_v2", byId);
      const snap = await getDoc(ref);
      if (!snap.exists()) return err(404,"Not Found",`No returnable with id '${byId}'.`);
      const data = normalizeTimestamps(snap.data()||{});
      return ok({ id: snap.id, data });
    }

    // --- Single by slug (returnables_v2 doc)
    const bySlug = val("slug").toLowerCase();
    if (bySlug){
      const rs = await getDocs(collection(db,"returnables_v2"));
      const match = rs.docs.find(d => String(d.data()?.returnable?.slug ?? "").toLowerCase() === bySlug);
      if (!match) return err(404,"Not Found",`No returnable with slug '${bySlug}'.`);
      return ok({ id: match.id, data: normalizeTimestamps(match.data()||{}) });
    }

    // --- List mode with filters
    const category = val("category");
    const type     = val("type");
    const isActive = toBool(val("isActive"));
    const rawLimit = (val("limit")||"24").toLowerCase();
    const unlimited = rawLimit === "all";
    let limit = 24;
    if (!unlimited){
      const n = parseInt(rawLimit,10);
      if (Number.isFinite(n) && n>0) limit = n;
    }

    const rs = await getDocs(collection(db,"returnables_v2"));
    let items = rs.docs.map(d=>({ id:d.id, data: normalizeTimestamps(d.data()||{}) }));

    items = items.filter(({data})=>{
      if (category && String(data?.grouping?.category||"") !== category) return false;
      if (type     && String(data?.grouping?.type||"")     !== type)     return false;
      if (isActive !== null && !!data?.placement?.isActive !== isActive) return false;
      return true;
    });

    items.sort((a,b)=>{
      const ap = Number(a.data?.placement?.position ?? Number.POSITIVE_INFINITY);
      const bp = Number(b.data?.placement?.position ?? Number.POSITIVE_INFINITY);
      return ap - bp;
    });

    if (!unlimited) items = items.slice(0, limit);

    return ok({ count: items.length, items });
  }catch(e){
    console.error("returnables_v2/get failed:", e);
    return err(500,"Unexpected Error","Something went wrong while fetching returnables.");
  }
}
