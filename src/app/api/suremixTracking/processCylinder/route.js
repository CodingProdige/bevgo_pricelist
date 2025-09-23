// app/api/suremixTracking/processCylinder/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebase";
import { collection, query, where, getDocs, addDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { cylinder_serial, status, product_details } = await req.json();

    // ✅ Validate required fields
    if (!cylinder_serial || !status || !product_details) {
      return NextResponse.json(
        { error: "Missing required fields (cylinder_serial, status, product_details)" },
        { status: 400 }
      );
    }

    // ✅ Ensure status is always Available when processing
    if (status !== "Available") {
      return NextResponse.json(
        { error: "Invalid status. When processing a new cylinder, status must be 'Available'." },
        { status: 400 }
      );
    }

    // 🔎 Check if cylinder already exists in system
    const q = query(collection(db, "suremixTracking"), where("cylinder_serial", "==", cylinder_serial));
    const snap = await getDocs(q);

    if (!snap.empty) {
      return NextResponse.json(
        { error: `Cylinder ${cylinder_serial} already exists in the system.` },
        { status: 409 } // Conflict
      );
    }

    // ✅ Add new cylinder doc
    const now = new Date().toISOString();
    const docData = {
      cylinder_serial,
      status: "Available", // force Available
      product_details,
      createdAt: now,
      updatedAt: now
    };

    const docRef = await addDoc(collection(db, "suremixTracking"), docData);

    return NextResponse.json(
      { message: "Cylinder processed successfully", id: docRef.id, data: docData },
      { status: 200 }
    );

  } catch (error) {
    console.error("❌ processCylinder error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
