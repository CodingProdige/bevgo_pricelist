import { db } from "@/lib/firebase"; // Firestore for products
import { collection, query, where, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { unique_code } = await req.json();

    if (!unique_code) {
      return NextResponse.json({ error: "Missing unique_code" }, { status: 400 });
    }

    // Query Firestore for the product with the given unique_code
    const productQuery = query(collection(db, "products"), where("unique_code", "==", unique_code));
    const productDocs = await getDocs(productQuery);

    if (productDocs.empty) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    // Return product data
    const productData = productDocs.docs[0].data();
    return NextResponse.json({ product: productData }, { status: 200 });

  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
