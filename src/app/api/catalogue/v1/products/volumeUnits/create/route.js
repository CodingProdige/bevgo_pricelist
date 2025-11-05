// app/api/catalogue/v1/volumeUnits/create/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, setDoc } from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

const norm = (v)=>String(v??"").trim();
const idOf = (symbol)=>norm(symbol).toLowerCase();

async function createOne(symbolRaw){
  const symbol = norm(symbolRaw);
  if (!symbol) return { ok:false, title:"Invalid Symbol", message:"Provide a non-empty 'symbol'." };

  const id = idOf(symbol);
  const ref = doc(db, "volume_units", id);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    return { ok:false, title:"Already Exists", message:`Volume unit '${symbol}' already exists.` };
  }
  await setDoc(ref, { symbol }); // schema stays { symbol }
  return { ok:true, id, symbol, message:"Volume unit created." };
}

export async function POST(req){
  try{
    const body = await req.json().catch(()=> ({}));
    // Accept:
    // 1) { symbol: "ml" }  OR { data: { symbol: "ml" } }
    // 2) { items: [{symbol:"ml"}, {symbol:"L"}, ...] }
    if (Array.isArray(body?.items)) {
      const results = [];
      for (const it of body.items) {
        const symbol = it?.symbol;
        try {
          results.push(await createOne(symbol));
        } catch(e){
          results.push({ ok:false, title:"Unexpected Error", message:"Failed to create symbol.", symbol, error:String(e) });
        }
      }
      const created   = results.filter(r=>r.ok).length;
      const failed    = results.length - created;
      return ok({ message:"Batch processed.", created, failed, results }, created>0?201:207);
    }

    const symbol = body?.data?.symbol ?? body?.symbol ?? null;
    const res = await createOne(symbol);
    return res.ok ? ok(res, 201) : NextResponse.json(res, { status: res.title==="Already Exists" ? 409 : 400 });
  }catch(e){
    console.error("volumeUnits/create failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while creating the volume unit.");
  }
}
