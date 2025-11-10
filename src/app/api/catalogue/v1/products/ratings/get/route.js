import { db } from "@/lib/firebase";
import { collection, getDocs, query, where } from "firebase/firestore";
import { NextResponse } from "next/server";

/* ------------------------- helpers ------------------------- */
const ok  =(p={},s=200)=>NextResponse.json({ok:true,...p},{status:s});
const err =(s,t,m,e={})=>NextResponse.json({ok:false,title:t,message:m,...e},{status:s});

async function findProduct(id){
  const q=query(collection(db,"products_v2"),where("product.unique_id","==",id));
  const s=await getDocs(q);
  return s.empty?null:s.docs[0];
}

function computeLevelCounts(entries=[]) {
  const counts = { one_star:0, two_star:0, three_star:0, four_star:0, five_star:0 };
  for (const r of entries) {
    const val = Number(r.stars);
    if (val === 1) counts.one_star++;
    else if (val === 2) counts.two_star++;
    else if (val === 3) counts.three_star++;
    else if (val === 4) counts.four_star++;
    else if (val === 5) counts.five_star++;
  }
  return counts;
}

/* --------------------------- GET --------------------------- */
export async function GET(req){
  try{
    const { searchParams } = new URL(req.url);
    const product_unique_id = searchParams.get("product_unique_id");
    const stars = Number(searchParams.get("stars") || 0);

    /* ----------------- SINGLE PRODUCT MODE ----------------- */
    if (product_unique_id) {
      const prodDoc = await findProduct(product_unique_id);
      if(!prodDoc)
        return err(404,"Product Not Found","No product found with that unique_id.");

      const data = prodDoc.data() || {};
      const ratings = data.ratings || {};
      const entries = Array.isArray(ratings.entries) ? ratings.entries : [];
      const levelCounts = computeLevelCounts(entries);
      const filtered = stars>=1&&stars<=5 ? entries.filter(r=>Number(r.stars)===stars) : entries;

      return ok({
        data: {
          ratings: {
            ...ratings,
            entries: filtered,
            levelCounts
          }
        }
      });
    }

    /* ----------------- GLOBAL MODE (ALL PRODUCTS) ----------------- */
    const snap = await getDocs(collection(db,"products_v2"));
    const allProducts = [];
    const globalEntries = [];

    for (const d of snap.docs) {
      const data = d.data() || {};
      const ratings = data.ratings || {};
      const entries = Array.isArray(ratings.entries)?ratings.entries:[];
      if (entries.length === 0) continue;

      const productInfo = {
        unique_id: data?.product?.unique_id || null,
        title: data?.product?.title || null,
        average: ratings.average || 0,
        count: ratings.count || 0,
        levelCounts: computeLevelCounts(entries),
        entries: stars>=1&&stars<=5 ? entries.filter(r=>Number(r.stars)===stars) : entries
      };

      allProducts.push(productInfo);
      globalEntries.push(...productInfo.entries);
    }

    const globalLevelCounts = computeLevelCounts(globalEntries);
    const globalAverage = globalEntries.length
      ? Number((globalEntries.reduce((a,b)=>a+(Number(b.stars)||0),0)/globalEntries.length).toFixed(2))
      : 0;

    return ok({
      data: {
        ratings: {
          scope: "global",
          productCount: allProducts.length,
          globalAverage,
          globalCount: globalEntries.length,
          levelCounts: globalLevelCounts,
          products: allProducts
        }
      }
    });
  }catch(e){
    console.error("getRatings failed:",e);
    return err(500,"Unexpected Error","Failed to retrieve ratings.");
  }
}
