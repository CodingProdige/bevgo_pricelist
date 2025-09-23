// app/api/suremixTracking/getCylinders/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebase";
import { collection, query, where, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { order_number, companyCode, isAdmin } = await req.json();

    const ref = collection(db, "suremixTracking");
    let q;

    // ✅ Case 1: Admin view — always return all cylinders if isAdmin = true
    if (isAdmin === true) {
      q = query(ref);
    }
    // ✅ Case 2: Filter by order_number + companyCode
    else if (order_number && companyCode) {
      q = query(
        ref,
        where("order_number", "==", order_number),
        where("customer_details.companyCode", "==", companyCode)
      );
    }
    // ✅ Case 3: Filter by companyCode only (active cylinders for customer)
    else if (companyCode) {
      q = query(
        ref,
        where("customer_details.companyCode", "==", companyCode),
        where("status", "==", "Rented")
      );
    }
    // ❌ No valid params
    else {
      return NextResponse.json(
        { error: "Invalid query. Provide order_number + companyCode, or companyCode, or set isAdmin=true." },
        { status: 400 }
      );
    }

    const snap = await getDocs(q);

    if (snap.empty) {
      return NextResponse.json(
        { message: "No cylinders found for given criteria.", cylinders: [] },
        { status: 200 }
      );
    }

    const results = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    return NextResponse.json(
      { count: results.length, cylinders: results },
      { status: 200 }
    );

  } catch (error) {
    console.error("❌ getCylinders error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
