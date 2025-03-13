import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const searchQuery = searchParams.get("search")?.toLowerCase().trim() || "";

    const querySnapshot = await getDocs(collection(db, "products"));

    // Extract unique product brands
    const productBrands = new Set();

    querySnapshot.docs.forEach((doc) => {
      const productData = doc.data();
      if (productData.product_brand) {
        productBrands.add(productData.product_brand);
      }
    });

    // Convert Set to an array, sort alphabetically
    let uniqueCategories = Array.from(productBrands).sort();

    // Filter by search query if provided
    if (searchQuery) {
      uniqueCategories = uniqueCategories.filter((brand) =>
        brand.toLowerCase().includes(searchQuery)
      );
    }

    return new Response(JSON.stringify(uniqueCategories), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
