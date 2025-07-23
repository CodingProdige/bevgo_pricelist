import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const snap = await getDocs(collection(db, "products"));

    // 1. bucket products by unique_code
    const buckets = {};
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      const code = data.unique_code;
      if (!code) return; // ignore missing/empty codes
      (buckets[code] ||= []).push({
        id: docSnap.id,
        ...data,
      });
    });

    // 2. keep only codes that occur > 1
    const duplicates = Object.fromEntries(
      Object.entries(buckets).filter(([, items]) => items.length > 1)
    );

    return NextResponse.json({ duplicates }, { status: 200 });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Failed to fetch duplicate unique codes", details: err.message },
      { status: 500 }
    );
  }
}