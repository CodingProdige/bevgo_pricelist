import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";

export async function GET() {
  try {
    const querySnapshot = await getDocs(collection(db, "products"));
    const products = querySnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Group by product_brand
    const groupedProducts = products.reduce((acc, product) => {
      const brand = product.product_brand || "Unknown Brand"; // Fallback in case of missing brand
      if (!acc[brand]) {
        acc[brand] = [];
      }
      acc[brand].push(product);
      return acc;
    }, {});

    return new Response(JSON.stringify(groupedProducts), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
