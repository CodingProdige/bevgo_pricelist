import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, deleteDoc, getDocs, collection } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });
const is8 =(s)=>/^\d{8}$/.test(String(s??"").trim());

export async function POST(req){
  try{
    const { returnable_id } = await req.json();
    const rid = String(returnable_id ?? "").trim();
    if (!is8(rid)) return err(400,"Invalid Returnable ID","'returnable_id' must be an 8-digit string.");

    const ref = doc(db,"returnables_v2", rid);
    const snap = await getDoc(ref);
    if (!snap.exists()) return err(404,"Not Found",`No returnable with id '${rid}'.`);

    // Check across products_v2 → variants[]
    const prods = await getDocs(collection(db,"products_v2"));
    const usedIn = [];
    for (const d of prods.docs){
      const data = d.data() || {};
      const variants = Array.isArray(data.variants) ? data.variants : [];
      for (const v of variants){
        if (v?.returnable?.returnable_id === rid){
          usedIn.push(d.id);
          break;
        }
      }
    }

    if (usedIn.length > 0){
      return err(409,"Returnable In Use",
        `This returnable is still assigned to ${usedIn.length} product variant${usedIn.length>1?"s":""}.`,
        { affected_products: usedIn.slice(0,5) });
    }

    await deleteDoc(ref);
    return ok({ message:"Returnable deleted.", returnable_id: rid });
  }catch(e){
    console.error("returnables_v2/delete failed:", e);
    return err(500,"Unexpected Error","Something went wrong while deleting the returnable.");
  }
}
