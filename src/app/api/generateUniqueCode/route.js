import { db } from "@/lib/firebase"; // Firestore
import { collection, getDocs, doc, updateDoc } from "firebase/firestore";

// Function to generate a unique 3-digit code
const generateUniqueCode = async (existingCodes) => {
  let code;
  do {
    code = Math.floor(100 + Math.random() * 900).toString(); // Generate a 3-digit number
  } while (existingCodes.has(code)); // Ensure uniqueness
  existingCodes.add(code);
  return code;
};

export async function POST(req) {
  try {
    console.log("🔍 Scanning for duplicate unique codes...");

    const querySnapshot = await getDocs(collection(db, "products"));
    const existingCodes = new Set();
    const duplicateCodes = new Map();
    const products = [];

    // ✅ First pass: Collect all codes and detect duplicates
    querySnapshot.forEach((docSnapshot) => {
      const productData = docSnapshot.data();
      const uniqueCode = productData.unique_code;

      if (uniqueCode) {
        if (existingCodes.has(uniqueCode)) {
          // If the code is duplicated, add to duplicate list
          if (!duplicateCodes.has(uniqueCode)) {
            duplicateCodes.set(uniqueCode, []);
          }
          duplicateCodes.get(uniqueCode).push(docSnapshot);
        } else {
          existingCodes.add(uniqueCode);
        }
      } else {
        // Handle case where unique_code is missing
        products.push({ docSnapshot, uniqueCode: null });
      }
    });

    // ✅ Second pass: Fix duplicates
    for (const [code, docs] of duplicateCodes) {
      for (const docSnapshot of docs) {
        const newCode = await generateUniqueCode(existingCodes);
        existingCodes.add(newCode);

        // Update the product document with the new unique code
        await updateDoc(doc(db, "products", docSnapshot.id), {
          unique_code: newCode,
        });

        console.log(`✅ Fixed duplicate: Updated product ${docSnapshot.id} with new unique code: ${newCode}`);
      }
    }

    // ✅ Fix missing codes from the first pass
    for (const { docSnapshot } of products) {
      const newCode = await generateUniqueCode(existingCodes);
      existingCodes.add(newCode);

      // Update the product document with the new unique code
      await updateDoc(doc(db, "products", docSnapshot.id), {
        unique_code: newCode,
      });

      console.log(`✅ Fixed missing code: Updated product ${docSnapshot.id} with new unique code: ${newCode}`);
    }

    console.log("🎉 All duplicates and missing unique codes have been fixed.");

    return new Response(
      JSON.stringify({ message: "Duplicate and missing unique codes fixed successfully." }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("❌ Error fixing duplicate unique codes:", error);
    return new Response(
      JSON.stringify({ error: "Failed to fix duplicate unique codes", details: error.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
