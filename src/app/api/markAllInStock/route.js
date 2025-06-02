import { db } from "@/lib/firebase";
import { collection, getDocs, doc, updateDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    const productsRef = collection(db, "products");
    const snapshot = await getDocs(productsRef);

    const updatePromises = snapshot.docs.map((docSnap) => {
      const productRef = doc(db, "products", docSnap.id);
      return updateDoc(productRef, { in_stock: true });
    });

    await Promise.all(updatePromises);

    return NextResponse.json({
      message: `✅ Updated ${snapshot.size} products to in_stock: true`,
    });
  } catch (error) {
    console.error("❌ Failed to update products:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
