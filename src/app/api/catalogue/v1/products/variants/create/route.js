import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, doc, getDoc, getDocs, updateDoc, serverTimestamp } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ok:true,...p},{status:s});
const err =(s,t,m,e={})=>NextResponse.json({ok:false,title:t,message:m,...e},{status:s});

const money2=(v)=>Number.isFinite(+v)?Math.round(+v*100)/100:0;
const toInt=(v,f=0)=>Number.isFinite(+v)?Math.trunc(+v):f;
const toNum=(v,f=0)=>Number.isFinite(+v)?+v:f;
const toStr=(v,f="")=>(v==null?f:String(v)).trim();
const toBool=(v,f=false)=>
  typeof v==="boolean"?v:
  typeof v==="number"?v!==0:
  typeof v==="string"?["true","1","yes","y"].includes(v.toLowerCase()):
  f;
const is8=(s)=>/^\d{8}$/.test(String(s??"").trim());

async function collectAllCodesAndBarcodes() {
  const snap = await getDocs(collection(db, "products_v2"));
  const ids = new Set();
  const barcodes = new Set();
  for (const d of snap.docs) {
    const data = d.data() || {};
    const pCode = String(data?.product?.unique_id ?? "").trim();
    if (is8(pCode)) ids.add(pCode);
    const vars = Array.isArray(data?.variants) ? data.variants : [];
    for (const v of vars) {
      const vid = String(v?.variant_id ?? "").trim();
      const bc  = String(v?.barcode ?? "").trim();
      if (is8(vid)) ids.add(vid);
      if (bc) barcodes.add(bc.toUpperCase());
    }
  }
  return { ids, barcodes };
}

function parseInventory(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(it => it && typeof it === "object")
    .map(it => ({
      in_stock_qty: toInt(it.in_stock_qty, 0),
      warehouse_id: toStr(it.warehouse_id, null) || null
    }))
    .filter(it => it.warehouse_id !== null);
}

export async function POST(req){
  try{
    const { unique_id, data } = await req.json();
    const pid = toStr(unique_id);
    if (!is8(pid)) return err(400,"Invalid Product ID","'unique_id' must be an 8-digit string.");
    if (!data || typeof data!=="object") return err(400,"Invalid Variant","Provide a valid 'data' object.");

    const vId = toStr(data?.variant_id);
    if (!is8(vId)) return err(400,"Invalid Variant ID","'data.variant_id' must be an 8-digit string.");

    const pref = doc(db,"products_v2",pid);
    const psnap=await getDoc(pref);
    if(!psnap.exists())return err(404,"Product Not Found",`No product exists with unique_id ${pid}.`);

    const { ids, barcodes } = await collectAllCodesAndBarcodes();
    if (ids.has(vId)) return err(409,"Duplicate Code",`variant_id ${vId} already in use.`);
    const barcode = toStr(data?.barcode);
    if (barcode && barcodes.has(barcode.toUpperCase()))
      return err(409,"Duplicate Barcode",`Barcode '${barcode}' already assigned to another variant.`);

    const current = psnap.data()||{};
    const variants = Array.isArray(current.variants)?[...current.variants]:[];
    const nextPos=(variants.length
      ?Math.max(...variants.map(v=>Number.isFinite(+v?.placement?.position)?+v.placement.position:0))
      :0)+1;

    const variant={
      variant_id:vId,
      sku:toStr(data?.sku),
      label:toStr(data?.label),
      barcode:barcode,
      barcodeImageUrl: toStr(data?.barcodeImageUrl, null) || null,

      placement:{
        position:Number.isFinite(+data?.placement?.position)
          ?Math.trunc(+data.placement.position)
          :nextPos,
        isActive:toBool(data?.placement?.isActive,true),
        isFeatured:toBool(data?.placement?.isFeatured,false),
        is_default:toBool(data?.placement?.is_default,variants.length===0),
        is_loyalty_eligible:toBool(data?.placement?.is_loyalty_eligible,true),
      },

      pricing:{
        supplier_price_excl:money2(data?.pricing?.supplier_price_excl),
        selling_price_excl:money2(data?.pricing?.selling_price_excl),
        cost_price_excl:Number.isFinite(+data?.pricing?.cost_price_excl)
          ?money2(data.pricing.cost_price_excl)
          :money2(data?.pricing?.base_price_excl),
        rebate_eligible:toBool(data?.pricing?.rebate_eligible,true),
        deposit_included:toBool(data?.pricing?.deposit_included,false),
      },

      sale:{
        is_on_sale:toBool(data?.sale?.is_on_sale,false),
        disabled_by_admin:toBool(data?.sale?.disabled_by_admin,false),
        sale_price_excl:money2(data?.sale?.sale_price_excl),
        qty_available:toInt(data?.sale?.qty_available,0),
      },

      pack:{
        unit_count:toInt(data?.pack?.unit_count,1),
        volume:toNum(data?.pack?.volume,0),
        volume_unit:toStr(data?.pack?.volume_unit,"each"),
      },

      /* ----------------------------------------------------
         UPDATED RENTAL MODULE WITH new fields:
         - limited_stock (default false)
         - qty_available (default 0)
      ----------------------------------------------------- */
      rental:{
        is_rental:toBool(data?.rental?.is_rental,false),
        rental_price_excl:money2(data?.rental?.rental_price_excl),
        billing_period:toStr(data?.rental?.billing_period,"monthly"),
        limited_stock: toBool(data?.rental?.limited_stock, false),
        qty_available: toInt(data?.rental?.qty_available, 0)
      },

      returnable: typeof data?.returnable==="object" && data.returnable
        ? data.returnable
        : {},

      inventory: parseInventory(data?.inventory)
    };

    /* Ensure only one is_default */
    if(variant.placement.is_default){
      for(let i=0;i<variants.length;i++){
        if(variants[i]?.placement) variants[i].placement.is_default=false;
      }
    }

    variants.push(variant);

    await updateDoc(pref,{
      variants,
      "timestamps.updatedAt":serverTimestamp()
    });

    return ok({
      message:"Variant added.",
      unique_id:pid,
      variant_id:vId,
      variant
    });

  }catch(e){
    console.error("variant create failed:",e);
    return err(500,"Unexpected Error","Failed to add variant.");
  }
}
