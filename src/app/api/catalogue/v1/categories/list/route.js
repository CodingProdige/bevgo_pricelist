// app/api/categories/slugs/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs, query, where } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });
const toBool=v=>typeof v==="boolean"?v:v==null?null:["true","1","yes"].includes(String(v).toLowerCase())?true:["false","0","no"].includes(String(v).toLowerCase())?false:null;

export async function GET(req){
  try{
    const { searchParams } = new URL(req.url);
    const isActive = toBool(searchParams.get("isActive"));

    const filters = [];
    if (isActive!==null) filters.push(where("placement.isActive","==", isActive));

    const rs   = await getDocs(query(collection(db,"categories"), ...filters));
    const rows = rs.docs.map(d => d.data() || {});
    rows.sort((a,b)=>{
      const ap = Number(a?.placement?.position ?? Number.POSITIVE_INFINITY);
      const bp = Number(b?.placement?.position ?? Number.POSITIVE_INFINITY);
      return ap - bp;
    });
    const items = rows.map(d => ({
      slug:  d?.category?.slug ?? null,
      title: d?.category?.title ?? null
    }));

    return ok({ count: items.length, items });
  }catch(e){
    console.error("categories/slugs failed:", e);
    return err(500,"Unexpected Error","Failed to fetch category slugs.");
  }
}
