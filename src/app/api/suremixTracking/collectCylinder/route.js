// app/api/suremixTracking/collectCylinder/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebase";
import { collection, query, where, getDocs, updateDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { cylinder_serial } = await req.json();

    if (!cylinder_serial) {
      return NextResponse.json(
        { error: "Missing required field: cylinder_serial" },
        { status: 400 }
      );
    }

    // 🔎 Find cylinder
    const q = query(collection(db, "suremixTracking"), where("cylinder_serial", "==", cylinder_serial));
    const snap = await getDocs(q);

    if (snap.empty) {
      return NextResponse.json(
        { error: `Cylinder with serial ${cylinder_serial} not found.` },
        { status: 404 }
      );
    }

    const docSnap = snap.docs[0];
    const docRef = docSnap.ref;
    const existing = docSnap.data();

    // ✅ Only allow collection if cylinder is currently Rented
    if (existing.status !== "Rented") {
      return NextResponse.json(
        { error: `Cylinder ${cylinder_serial} cannot be collected because it is not currently Rented (status: ${existing.status}).` },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();

    // ✅ Update fields
    await updateDoc(docRef, {
      status: "Collected",
      rental_end: now,   // auto-set when collected
      updatedAt: now
    });

    return NextResponse.json(
      {
        message: `Cylinder ${cylinder_serial} marked as Collected.`,
        rental_end: now,
        previousCustomer: existing.customer_details || null,
        order_number: existing.order_number || null
      },
      { status: 200 }
    );

  } catch (error) {
    console.error("❌ collectCylinder error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
