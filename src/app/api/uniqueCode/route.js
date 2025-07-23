// app/api/products/new-code/route.js
import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    // 1. Pull every product once
    const snap = await getDocs(collection(db, "products"));

    // 2. Collect every existing unique_code
    const used = new Set();
    snap.forEach((doc) => {
      const code = doc.data()?.unique_code;
      if (code) used.add(String(code));
    });

    // 3. Generate a brand-new 3-digit code not in that set
    let code;
    do {
      code = String(Math.floor(100 + Math.random() * 900)); // "100"-"999"
    } while (used.has(code));

    // 4. Return it
    return NextResponse.json({ newProductCode: code }, { status: 200 });
  } catch (err) {
    console.error("Error generating new product code:", err);
    return NextResponse.json(
      { error: "Failed to generate code", details: err.message },
      { status: 500 }
    );
  }
}