import { db } from "@/lib/firebase";
import { collection, getDocs, updateDoc, doc } from "firebase/firestore";

export async function POST(req) {
  try {
    const { status } = await req.json();

    if (typeof status !== "boolean") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid 'status' in request body. Expected boolean." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const querySnapshot = await getDocs(collection(db, "products"));
    let updatedCount = 0;

    await Promise.all(
      querySnapshot.docs.map(async (docSnap) => {
        const productRef = doc(db, "products", docSnap.id);
        await updateDoc(productRef, { in_stock: status });
        updatedCount++;
      })
    );

    return new Response(
      JSON.stringify({
        totalProducts: querySnapshot.size,
        updated: updatedCount,
        newStatus: status,
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
