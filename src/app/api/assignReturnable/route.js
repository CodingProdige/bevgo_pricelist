import { db } from "@/lib/firebase";
import { collection, query, where, getDocs, updateDoc, doc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { unique_code, assigned_returnable } = await req.json();

    if (!unique_code || typeof unique_code !== "string" || typeof assigned_returnable !== "object") {
      return NextResponse.json({ error: "Missing or invalid parameters" }, { status: 400 });
    }

    const productsRef = collection(db, "products");
    const productQuery = query(productsRef, where("unique_code", "==", unique_code));
    const querySnapshot = await getDocs(productQuery);

    if (querySnapshot.empty) {
      return NextResponse.json({ error: "No product found with the provided unique_code" }, { status: 404 });
    }

    const productDoc = querySnapshot.docs[0];
    const productRef = doc(db, "products", productDoc.id);

    await updateDoc(productRef, {
      assigned_returnable,
    });

    return NextResponse.json({
      message: "assigned_returnable successfully set",
      productId: productDoc.id,
      assigned_returnable,
    }, { status: 200 });

  } catch (error) {
    console.error("❌ Error assigning returnable:", error.message);
    return NextResponse.json({ error: "Failed to assign returnable", details: error.message }, { status: 500 });
  }
}
