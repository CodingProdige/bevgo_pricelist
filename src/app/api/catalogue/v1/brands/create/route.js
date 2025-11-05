// app/api/brands/create/route.js
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection, query, where, getDocs, doc, setDoc, serverTimestamp, getCountFromServer
} from "firebase/firestore";

const ok  =(p={},s=200)=>NextResponse.json({ ok:true,  ...p },{ status:s });
const err =(s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

export async function POST(req){
  try{
    const { data } = await req.json();
    if (!data || typeof data !== "object") return err(400,"Invalid Data","Provide a 'data' object.");

    const category = data?.grouping?.category?.trim();
    const subCategories = Array.isArray(data?.grouping?.subCategories)
      ? data.grouping.subCategories.filter(Boolean).map(s=>String(s).trim())
      : [];
    const slug = data?.brand?.slug?.trim();

    if (!category || !slug) return err(400,"Missing Fields","'grouping.category' and 'brand.slug' are required.");

    // Uniqueness by brand.slug (global)
    const dup = await getDocs(query(collection(db,"brands"), where("brand.slug","==", slug)));
    if (!dup.empty) return err(409,"Slug In Use",`Brand slug '${slug}' already exists.`);

    // Auto position within category (count + 1)
    const col = collection(db,"brands");
    const countSnap = await getCountFromServer(query(col, where("grouping.category","==", category)));
    const nextPos = (countSnap.data().count || 0) + 1;
    const position = Number.isFinite(+data?.placement?.position)
      ? +data.placement.position
      : nextPos;

    const ref = doc(col); // auto ID
    const body = {
      docId: ref.id,
      grouping: { category, subCategories },
      brand: {
        slug,
        title: data?.brand?.title ?? null,
        description: data?.brand?.description ?? null,
        keywords: Array.isArray(data?.brand?.keywords) ? data.brand.keywords : [],
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
    return ok({ id: ref.id, slug, position, message: "Brand created." }, 201);
  }catch(e){
    console.error("brands/create failed:", e);
    return err(500,"Unexpected Error","Something went wrong while creating the brand.");
  }
}
