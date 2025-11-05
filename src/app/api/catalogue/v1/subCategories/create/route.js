import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, query, where, getDocs, doc, setDoc, serverTimestamp } from "firebase/firestore";
import { nextPosition } from "@/app/api/_utils/position";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

export async function POST(req){
  try{
    const { data } = await req.json();
    if (!data || typeof data !== "object") return err(400,"Invalid Data","Provide a 'data' object.");

    const category = data?.grouping?.category?.trim();
    const slug     = data?.subCategory?.slug?.trim();
    if (!category || !slug) return err(400,"Missing Fields","'grouping.category' and 'subCategory.slug' are required.");

    const dup = await getDocs(query(collection(db,"sub_categories"), where("subCategory.slug","==",slug)));
    if (!dup.empty) return err(409,"Slug In Use",`Sub-category slug '${slug}' already exists.`);

    const col = collection(db,"sub_categories");
    const position = Number.isFinite(+data?.placement?.position)
      ? +data.placement.position
      : await nextPosition(col, [ where("grouping.category","==",category) ]);

    const ref = doc(col); // auto-ID
    const body = {
      docId: ref.id,                   // <- store docId
      grouping: { category },
      subCategory: {
        slug,
        kind: data?.subCategory?.kind ?? "consumable",
        title: data?.subCategory?.title ?? null,
        description: data?.subCategory?.description ?? null,
        keywords: Array.isArray(data?.subCategory?.keywords) ? data.subCategory.keywords : [],
      },
      placement: {
        position,
        isActive: data?.placement?.isActive ?? true,
        isFeatured: data?.placement?.isFeatured ?? false
      },
      media: {
        color: data?.media?.color ?? null,
        images: Array.isArray(data?.media?.images) ? data.media.images : [],
        video: data?.media?.video ?? null,
        icon: data?.media?.icon ?? null
      },
      timestamps: { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
    };

    await setDoc(ref, body);
    return ok({ id: ref.id, slug, position, message: "Sub-category created." }, 201);
  }catch(e){
    console.error("sub_categories/create failed:", e);
    return err(500,"Unexpected Error","Something went wrong while creating the sub-category.");
  }
}
