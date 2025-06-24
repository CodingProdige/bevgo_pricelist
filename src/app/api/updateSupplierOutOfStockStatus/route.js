import { db } from "@/lib/firebase";
import { collection, getDocs, updateDoc, doc } from "firebase/firestore";

export async function POST(req) {
  try {
    const { supplier_out_of_stock } = await req.json();

    if (typeof supplier_out_of_stock !== "boolean") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid 'supplier_out_of_stock' in request body. Expected boolean." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const querySnapshot = await getDocs(collection(db, "products"));
    let updatedCount = 0;

    await Promise.all(
      querySnapshot.docs.map(async (docSnap) => {
        const productRef = doc(db, "products", docSnap.id);
        await updateDoc(productRef, { supplier_out_of_stock });
        updatedCount++;
      })
    );

    return new Response(
      JSON.stringify({
        totalProducts: querySnapshot.size,
        updated: updatedCount,
        newSupplierOutOfStockStatus: supplier_out_of_stock,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
