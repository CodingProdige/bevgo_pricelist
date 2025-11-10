import { db } from "@/lib/firebase";
import { collection, query, where, getDocs, updateDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

/* ----------------------------- helpers ----------------------------- */
const ok  =(p={},s=200)=>NextResponse.json({ok:true,...p},{status:s});
const err =(s,t,m,e={})=>NextResponse.json({ok:false,title:t,message:m,...e},{status:s});
const now =()=>new Date().toISOString();

const recompute=(a)=>{
  const c=a.length;
  const s=a.reduce((n,x)=>n+(+x.stars||0),0);
  return {average:c?(s/c).toFixed(2)*1:0,count:c,lastUpdated:now()};
};
async function findProduct(unique_id){
  const q=query(collection(db,"products_v2"),where("product.unique_id","==",unique_id));
  const s=await getDocs(q);
  return s.empty?null:s.docs[0];
}

/* ----------------------------- profanity filter ----------------------------- */
const PROFANE_WORDS = [
  "fuck","shit","bitch","asshole","bastard","dick","pussy","cunt","slut","cock","faggot",
  "nigger","nigga","damn","crap","whore"
];

function sanitizeComment(comment="") {
  let clean = String(comment);
  for (const w of PROFANE_WORDS) {
    const regex = new RegExp(`\\b${w}\\b`, "gi");
    if (regex.test(clean)) {
      const mask = "*".repeat(w.length);
      clean = clean.replace(regex, mask);
    }
  }
  return clean;
}

/* ----------------------------- POST ----------------------------- */
export async function POST(req){
  try{
    const body=await req.json().catch(()=>({}));
    const {product_unique_id,userId,stars,comment}=body;
    if(!product_unique_id||!userId||!stars)
      return err(400,"Missing Fields","Provide product_unique_id, userId and stars.");

    const prodDoc=await findProduct(product_unique_id);
    if(!prodDoc)
      return err(404,"Product Not Found","No product found with that unique_id.");

    const data=prodDoc.data()||{};
    const ratings=data.ratings||{entries:[]};
    const entries=Array.isArray(ratings.entries)?ratings.entries:[];
    const existing=entries.findIndex(r=>r.userId===userId);
    if(existing!==-1)
      return err(409,"Already Rated","User already submitted a rating; use the update endpoint.");

    const safeComment = sanitizeComment(comment || "");

    entries.push({
      userId,
      stars,
      comment: safeComment,
      createdAt: now()
    });

    const updated={...ratings,entries,...recompute(entries)};
    await updateDoc(prodDoc.ref,{ratings:updated});

    return ok({data:{ratings:updated}});
  }catch(e){
    console.error("createRating failed:",e);
    return err(500,"Unexpected Error","Failed to create rating.");
  }
}
