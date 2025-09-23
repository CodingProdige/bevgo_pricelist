// app/api/suremixTracking/deliverCylinder/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebase";
import { collection, query, where, getDocs, updateDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { cylinder_serial, customer_details, order_number } = await req.json();

    // ✅ Validate required fields
    if (!cylinder_serial || !customer_details || !order_number) {
      return NextResponse.json(
        { error: "Missing required fields (cylinder_serial, customer_details, order_number)" },
        { status: 400 }
      );
    }

    // ✅ Find cylinder doc in Firestore
    const q = query(collection(db, "suremixTracking"), where("cylinder_serial", "==", cylinder_serial));
    const snap = await getDocs(q);

    if (snap.empty) {
      return NextResponse.json(
        { error: `Cylinder with serial ${cylinder_serial} not found` },
        { status: 404 }
      );
    }

    const docSnap = snap.docs[0];
    const docRef = docSnap.ref;
    const cylinderData = docSnap.data();

    // ✅ Prevent double booking
    if (cylinderData.status === "Rented") {
      return NextResponse.json(
        {
          error: `Cylinder ${cylinder_serial} is already allocated to a customer (status: Rented).`,
          currentCustomer: cylinderData.customer_details || null,
          order_number: cylinderData.order_number || null
        },
        { status: 409 } // Conflict
      );
    }

    const now = new Date().toISOString();

    // ✅ Update fields
    await updateDoc(docRef, {
      customer_details,
      order_number,
      rental_start: now,  // auto-set on delivery
      status: "Rented",
      updatedAt: now
    });

    return NextResponse.json(
      {
        message: "Cylinder delivered and updated successfully",
        cylinder_serial,
        order_number,
        rental_start: now,
        customer_details
      },
      { status: 200 }
    );

  } catch (error) {
    console.error("❌ deliverCylinder error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
