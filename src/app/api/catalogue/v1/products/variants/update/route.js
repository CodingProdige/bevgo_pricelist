// app/api/catalogue/v1/products/utils/updateVariant/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, getDocs, doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";

/* ---------- helpers ---------- */
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

async function collectAllBarcodes() {
  const snap = await getDocs(collection(db,"products_v2"));
  const list = [];
  for (const d of snap.docs) {
    const pid = d.id;
    const data = d.data() || {};
    const variants = Array.isArray(data?.variants) ? data.variants : [];
    for (const v of variants) {
      const bc = String(v?.barcode ?? "").trim().toUpperCase();
      const vId = String(v?.variant_id ?? "").trim();
      if (bc) list.push({ productId: pid, variantId: vId, barcode: bc });
    }
  }
  return list;
}

function deepMerge(target,patch){
  if(patch==null||typeof patch!=="object")return target;
  const out=Array.isArray(target)?[...target]:{...target};
  for(const[k,v]of Object.entries(patch)){
    if(v&&typeof v==="object"&&!Array.isArray(v)&&typeof out[k]==="object"&&!Array.isArray(out[k])){
      out[k]=deepMerge(out[k],v);
    }else{
      out[k]=v;
    }
  }
  return out;
}

/** Sanitize inventory array (replaces full array) */
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

/* ---------- Sanitize patch ---------- */
function sanitizePatch(patch){
  const out={};
  if("sku" in patch) out.sku=toStr(patch.sku);
  if("label" in patch) out.label=toStr(patch.label);
  if("barcode" in patch) out.barcode=toStr(patch.barcode);

  if("placement" in patch){
    const src=patch.placement||{};
    out.placement={};
    if("position" in src) out.placement.position=Number.isFinite(+src.position)?Math.trunc(+src.position):undefined;
    if("isActive" in src) out.placement.isActive=toBool(src.isActive);
    if("isFeatured" in src) out.placement.isFeatured=toBool(src.isFeatured);
    if("is_default" in src) out.placement.is_default=toBool(src.is_default);
    if("is_loyalty_eligible" in src) out.placement.is_loyalty_eligible=toBool(src.is_loyalty_eligible);
  }

  if("pricing" in patch){
    const src=patch.pricing||{};
    out.pricing={};
    if("supplier_price_excl" in src) out.pricing.supplier_price_excl=money2(src.supplier_price_excl);
    if("selling_price_excl" in src) out.pricing.selling_price_excl=money2(src.selling_price_excl);
    if("cost_price_excl" in src) out.pricing.cost_price_excl=money2(src.cost_price_excl);
    if(!("cost_price_excl" in out.pricing)&&"base_price_excl" in src)
      out.pricing.cost_price_excl=money2(src.base_price_excl);
    if("rebate_eligible" in src) out.pricing.rebate_eligible=toBool(src.rebate_eligible);
    if("deposit_included" in src) out.pricing.deposit_included=toBool(src.deposit_included);
  }

  if("sale" in patch){
    const src=patch.sale||{};
    out.sale={};
    if("is_on_sale" in src) out.sale.is_on_sale=toBool(src.is_on_sale);
    if("sale_price_excl" in src) out.sale.sale_price_excl=money2(src.sale_price_excl);
    if("qty_available" in src) out.sale.qty_available=toInt(src.qty_available,0);
  }

  if("pack" in patch){
    const src=patch.pack||{};
    out.pack={};
    if("unit_count" in src) out.pack.unit_count=toInt(src.unit_count,1);
    if("volume" in src) out.pack.volume=toNum(src.volume,0);
    if("volume_unit" in src) out.pack.volume_unit=toStr(src.volume_unit,"each");
  }

  if("rental" in patch){
    const src=patch.rental||{};
    out.rental={};
    if("is_rental" in src) out.rental.is_rental=toBool(src.is_rental);
    if("rental_price_excl" in src) out.rental.rental_price_excl=money2(src.rental_price_excl);
    if("billing_period" in src) out.rental.billing_period=toStr(src.billing_period,"monthly");
  }

  if("returnable" in patch){
    out.returnable=(patch.returnable && typeof patch.returnable==="object")?patch.returnable:{};
  }

  if("inventory" in patch){
    out.inventory = parseInventory(patch.inventory);
  }

  return out;
}

/* ---------- MAIN ---------- */
export async function POST(req){
  try{
    const {unique_id,variant_id,data}=await req.json();
    const pid=toStr(unique_id);
    if(!is8(pid))return err(400,"Invalid Product ID","'unique_id' must be an 8-digit string.");
    const vid=toStr(variant_id);
    if(!is8(vid))return err(400,"Invalid Variant ID","'variant_id' must be an 8-digit string.");
    if(!data||typeof data!=="object")return err(400,"Invalid Data","Provide a 'data' object.");

    if("variant_id" in data && toStr(data.variant_id)!==vid)
      return err(409,"Mismatched Variant ID","data.variant_id must match the target variant.");

    const ref=doc(db,"products_v2",pid);
    const snap=await getDoc(ref);
    if(!snap.exists())return err(404,"Product Not Found",`No product exists with unique_id ${pid}.`);

    const docData=snap.data()||{};
    const list=Array.isArray(docData.variants)?[...docData.variants]:[];
    const idx=list.findIndex(v=>toStr(v?.variant_id)===vid);
    if(idx<0)return err(404,"Variant Not Found",`No variant with variant_id ${vid}.`);

    const incomingBC=toStr(data?.barcode);
    if(incomingBC){
      const allBCs=await collectAllBarcodes();
      const normalized=incomingBC.toUpperCase();
      const currentBC=toStr(list[idx]?.barcode).toUpperCase();
      const conflict=allBCs.find(b=>b.barcode===normalized && !(b.productId===pid && b.variantId===vid));
      if(conflict){
        return err(409,"Duplicate Barcode",`Barcode '${incomingBC}' already exists on another variant.`);
      }
    }

    const patch=sanitizePatch(data);

    // Always replace inventory fully
    if(Object.prototype.hasOwnProperty.call(data,"inventory")){
      list[idx].inventory = patch.inventory || [];
    }

    if(Object.prototype.hasOwnProperty.call(data,"returnable")){
      list[idx].returnable = patch.returnable || {};
    }

    let updated=deepMerge(list[idx],patch);

    const askedFlip=("placement" in patch)&&("is_default" in patch.placement);
    if(askedFlip){
      const makeDefault=!!patch.placement.is_default;
      if(makeDefault){
        for(let i=0;i<list.length;i++){
          if(i!==idx&&list[i]?.placement)list[i].placement.is_default=false;
        }
        updated.placement=updated.placement||{};
        updated.placement.is_default=true;
      }else{
        updated.placement=updated.placement||{};
        updated.placement.is_default=false;
      }
    }

    list[idx]=updated;
    await updateDoc(ref,{variants:list,"timestamps.updatedAt":serverTimestamp()});

    const default_variant_id=(list.find(v=>v?.placement?.is_default)||{}).variant_id??null;
    return ok({
      message:"Variant updated.",
      unique_id:pid,
      variant_id:vid,
      default_variant_id,
      variant:list[idx]
    });
  }catch(e){
    console.error("variant update failed:",e);
    return err(500,"Unexpected Error","Failed to update variant.");
  }
}
