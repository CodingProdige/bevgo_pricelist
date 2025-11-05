// app/api/catalogue/v1/returnableTypes/create/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, setDoc } from "firebase/firestore";

const ok  = (p={}, s=200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e={}) => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

const norm = (v) => String(v ?? "").trim();
const idOf = (type) => norm(type).toLowerCase();

async function createOne(typeRaw){
  const type = norm(typeRaw);
  if (!type) return { ok:false, title:"Invalid Type", message:"Provide a non-empty 'type'." };

  const id = idOf(type);
  const ref = doc(db, "returnable_types", id);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    return { ok:false, title:"Already Exists", message:`Returnable type '${type}' already exists.` };
  }

  // Schema mirrors volume_units: { type: "..." }
  await setDoc(ref, { type });
  return { ok:true, id, type, message:"Returnable type created." };
}

export async function POST(req){
  try{
    const body = await req.json().catch(()=> ({}));

    // Accept:
    // 1) { type: "crate" }  OR { data: { type: "crate" } }
    // 2) { items: [{type:"crate"}, {type:"bottle"}, ...] }
    if (Array.isArray(body?.items)) {
      const results = [];
      for (const it of body.items) {
        const typeVal = it?.type;
        try {
          results.push(await createOne(typeVal));
        } catch(e){
          results.push({ ok:false, title:"Unexpected Error", message:"Failed to create type.", type:typeVal, error:String(e) });
        }
      }
      const created = results.filter(r=>r.ok).length;
      const failed  = results.length - created;
      return ok({ message:"Batch processed.", created, failed, results }, created>0?201:207);
    }

    const typeVal = body?.data?.type ?? body?.type ?? null;
    const res = await createOne(typeVal);
    return res.ok
      ? ok(res, 201)
      : NextResponse.json(res, { status: res.title === "Already Exists" ? 409 : 400 });

  }catch(e){
    console.error("returnableTypes/create failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while creating the returnable type.");
  }
}
