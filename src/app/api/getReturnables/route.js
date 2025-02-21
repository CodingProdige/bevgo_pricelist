import { db } from "@/lib/firebase"; // Adjust this based on your Firebase setup
import { collection, getDocs } from "firebase/firestore";

export async function GET() {
  try {
    const querySnapshot = await getDocs(collection(db, "returnables"));
    const returnablesData = {};

    querySnapshot.forEach((doc) => {
      const data = doc.data();
      const returnType = data.return_type || "Unknown";

      if (!returnablesData[returnType]) {
        returnablesData[returnType] = [];
      }

      returnablesData[returnType].push({
        id: doc.id,
        code: data.code || "",
        price: data.price || 0,
        product_size: data.product_size || "",
        product_type: data.product_type || "",
        return_type: data.return_type || "Unknown",
      });
    });

    // Sort each category by product_size in ascending order
    Object.keys(returnablesData).forEach((category) => {
      returnablesData[category].sort((a, b) => {
        // Extract numeric values from product_size (e.g., "500ml" → 500)
        const sizeA = parseInt(a.product_size.replace(/\D/g, ""), 10) || 0;
        const sizeB = parseInt(b.product_size.replace(/\D/g, ""), 10) || 0;
        return sizeA - sizeB;
      });
    });

    return new Response(JSON.stringify(returnablesData), { status: 200 });
  } catch (error) {
    console.error("Error fetching returnables:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch returnables" }), { status: 500 });
  }
}
