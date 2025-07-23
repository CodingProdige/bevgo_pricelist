// app/api/getProducts/route.js   (modified read-only endpoint)
import { db } from "@/lib/firebase";
import { collection, getDocs, doc, updateDoc } from "firebase/firestore";

/* ---------- helpers ---------- */
const generateUniqueCode = async () => {
  // Ask the dedicated endpoint for a never-before-used code
  const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/uniqueCode`);
  if (!res.ok) throw new Error("Could not fetch new product code");
  const { newProductCode } = await res.json();
  return newProductCode;
};

const extractBottleSize = (title) => {
  if (!title) return 0;
  const match = title.match(/(\d+(\.\d+)?)\s?(ml|l|lt)/i);
  if (match) {
    let size = parseFloat(match[1]);
    return match[3].toLowerCase().includes("ml") ? size : size * 1000;
  }
  return 0;
};

const extractProductType = (title) => {
  if (!title) return "Other";
  if (title.toLowerCase().includes("can")) return "Cans";
  if (title.toLowerCase().includes("pet")) return "PET";
  if (title.toLowerCase().includes("glass")) return "Glass";
  return "Other";
};

const typeOrder = { Cans: 1, PET: 2, Glass: 3, Other: 4 };

const keywords = [
  "Tonic", "Soda Water", "Lemonade", "Ginger Ale", "Dry Lemon",
  "Pink Tonic", "Emotions", "Teardrop", "Standard"
];
const keywordOrder = Object.fromEntries(keywords.map((k, i) => [k, i + 1]));
keywordOrder["Other"] = keywords.length + 1;

const extractProductKeyword = (title) => {
  if (!title) return "Other";
  for (let keyword of keywords) {
    if (title.toLowerCase().includes(keyword.toLowerCase())) return keyword;
  }
  return "Other";
};

/* ---------- main GET handler ---------- */
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const categoryFilter = searchParams.get("category")?.trim() || "";
    const searchQuery = searchParams.get("search")?.toLowerCase().trim() || "";

    // 1. read all products
    const querySnapshot = await getDocs(collection(db, "products"));

    // 2. hydrate & fix missing codes on-the-fly
    const products = await Promise.all(
      querySnapshot.docs.map(async (docSnap) => {
        const data = docSnap.data();

        // skip special-pricing items
        if (data.is_special_pricing === true) return null;

        let uniqueCode = data.unique_code;
        if (!uniqueCode) {
          uniqueCode = await generateUniqueCode();
          await updateDoc(doc(db, "products", docSnap.id), {
            unique_code: uniqueCode,
          });
        }

        return {
          id: docSnap.id,
          ...data,
          unique_code: uniqueCode,
          extracted_size: extractBottleSize(data.product_title),
          product_type: extractProductType(data.product_title),
          product_keyword: extractProductKeyword(data.product_title),
        };
      })
    );

    // 3. remove nulls & apply filters
    let filtered = products.filter(Boolean);
    if (categoryFilter) {
      filtered = filtered.filter(
        (p) => p.product_brand?.toLowerCase() === categoryFilter.toLowerCase()
      );
    }
    if (searchQuery) {
      filtered = filtered.filter((p) =>
        p.product_title?.toLowerCase().includes(searchQuery)
      );
    }

    // 4. group & sort
    const grouped = filtered.reduce((acc, p) => {
      const brand = p.product_brand || "Unknown Brand";
      (acc[brand] ||= []).push(p);
      return acc;
    }, {});

    Object.values(grouped).forEach((arr) =>
      arr.sort((a, b) => {
        if (a.extracted_size !== b.extracted_size)
          return a.extracted_size - b.extracted_size;
        if (typeOrder[a.product_type] !== typeOrder[b.product_type])
          return typeOrder[a.product_type] - typeOrder[b.product_type];
        if (keywordOrder[a.product_keyword] !== keywordOrder[b.product_keyword])
          return keywordOrder[a.product_keyword] - keywordOrder[b.product_keyword];
        return a.product_title.localeCompare(b.product_title);
      })
    );

    return new Response(JSON.stringify(grouped), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}