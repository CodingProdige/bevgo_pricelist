// app/api/brands/slugs/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs, query, where } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });
const toBool=v=>typeof v==="boolean"?v:v==null?null:["true","1","yes"].includes(String(v).toLowerCase())?true:["false","0","no"].includes(String(v).toLowerCase())?false:null;

export async function GET(req){
  try{
    const { searchParams } = new URL(req.url);
    const category    = (searchParams.get("category")||"").trim();
    const subCategory = (searchParams.get("subCategory")||"").trim(); // matches grouping.subCategories via array-contains
    const isActive    = toBool(searchParams.get("isActive"));

    const filters = [];
    if (category)        filters.push(where("grouping.category","==", category));
    if (subCategory)     filters.push(where("grouping.subCategories","array-contains", subCategory));
    if (isActive!==null) filters.push(where("placement.isActive","==", isActive));

    const rs   = await getDocs(query(collection(db,"brands"), ...filters));
    const rows = rs.docs.map(d => d.data() || {});
    rows.sort((a,b)=>{
      const ap = Number(a?.placement?.position ?? Number.POSITIVE_INFINITY);
      const bp = Number(b?.placement?.position ?? Number.POSITIVE_INFINITY);
      return ap - bp;
    });
    const items = rows.map(d => ({
      slug:  d?.brand?.slug ?? null,
      title: d?.brand?.title ?? null
    }));

    return ok({ count: items.length, items });
  }catch(e){
    console.error("brands/slugs failed:", e);
    return err(500,"Unexpected Error","Failed to fetch brand slugs.");
  }
}
