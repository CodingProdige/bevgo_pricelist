import { db } from "@/lib/firebase";
import { collection, query, where, getDocs, updateDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

const ok  =(p={},s=200)=>NextResponse.json({ok:true,...p},{status:s});
const err =(s,t,m,e={})=>NextResponse.json({ok:false,title:t,message:m,...e},{status:s});
const now =()=>new Date().toISOString();
const recompute=(a)=>{const c=a.length;const s=a.reduce((n,x)=>n+(+x.stars||0),0);return{average:c?(s/c).toFixed(2)*1:0,count:c,lastUpdated:now()}};
async function findProduct(id){const q=query(collection(db,"products_v2"),where("product.unique_id","==",id));const s=await getDocs(q);return s.empty?null:s.docs[0];}

export async function PUT(req){
  try{
    const body=await req.json().catch(()=>({}));
    const {product_unique_id,userId,stars,comment}=body;
    if(!product_unique_id||!userId) return err(400,"Missing Fields","Provide product_unique_id and userId.");
    const prodDoc=await findProduct(product_unique_id);
    if(!prodDoc) return err(404,"Product Not Found","No product found with that unique_id.");

    const data=prodDoc.data()||{};
    const ratings=data.ratings||{entries:[]};
    const entries=Array.isArray(ratings.entries)?ratings.entries:[];
    const idx=entries.findIndex(r=>r.userId===userId);
    if(idx===-1) return err(404,"Rating Not Found","User has not rated this product.");

    entries[idx]={...entries[idx],stars:stars??entries[idx].stars,comment:comment??entries[idx].comment,updatedAt:now()};
    const updated={...ratings,entries,...recompute(entries)};
    await updateDoc(prodDoc.ref,{ratings:updated});
    return ok({data:{ratings:updated}});
  }catch(e){console.error("updateRating failed:",e);return err(500,"Unexpected Error","Failed to update rating.");}
}
