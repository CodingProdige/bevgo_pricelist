import { db } from "@/lib/firebase";
import { collection, getDocs, doc, updateDoc } from "firebase/firestore";

const generateUniqueCode = async (existingCodes) => {
  let code;
  do {
    code = Math.floor(100 + Math.random() * 900).toString();
  } while (existingCodes.has(code));
  existingCodes.add(code);
  return code;
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

const extractProductKeyword = (title) => {
  if (!title) return "Other";
  for (let keyword of keywords) {
    if (title.toLowerCase().includes(keyword.toLowerCase())) {
      return keyword;
    }
  }
  return "Other";
};

const keywordOrder = Object.fromEntries(keywords.map((k, i) => [k, i + 1]));
keywordOrder["Other"] = keywords.length + 1;

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const categoryFilter = searchParams.get("category")?.trim() || "";
    const searchQuery = searchParams.get("search")?.toLowerCase().trim() || "";
    const companyCode = searchParams.get("companyCode")?.trim();

    let favoriteCodes = [];

    // ✅ Fetch user favorites if category is "Favorites"
    if (categoryFilter.toLowerCase() === "favorites" && companyCode) {
      try {
        const res = await fetch("https://bevgo-client.vercel.app/api/getUser", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyCode }),
        });

        if (!res.ok) throw new Error(`User fetch failed: ${res.status}`);
        const json = await res.json();

        favoriteCodes = Array.isArray(json?.data?.favorites_unique_codes)
          ? json.data.favorites_unique_codes
          : [];
      } catch (err) {
        console.warn("⚠️ Failed to fetch user favorites:", err.message);
      }
    }

    const querySnapshot = await getDocs(collection(db, "products"));
    const existingCodes = new Set();

    let products = await Promise.all(
      querySnapshot.docs.map(async (docSnapshot) => {
        const productData = docSnapshot.data();
        let uniqueCode = productData.unique_code;

        if (!uniqueCode) {
          uniqueCode = await generateUniqueCode(existingCodes);
          await updateDoc(doc(db, "products", docSnapshot.id), {
            unique_code: uniqueCode,
          });
        }

        return {
          id: docSnapshot.id,
          ...productData,
          unique_code: uniqueCode,
          extracted_size: extractBottleSize(productData.product_title),
          product_type: extractProductType(productData.product_title),
          product_keyword: extractProductKeyword(productData.product_title),
        };
      })
    );

    products = products.filter(Boolean);

    // ✅ Favorites filter
    if (categoryFilter.toLowerCase() === "favorites") {
      products = products.filter((product) =>
        favoriteCodes.includes(String(product.unique_code))
      );
    } else if (categoryFilter) {
      products = products.filter((product) =>
        product.product_brand?.toLowerCase() === categoryFilter.toLowerCase()
      );
    }

    // ✅ Search filter
    if (searchQuery) {
      products = products.filter((product) =>
        product.product_title?.toLowerCase().includes(searchQuery)
      );
    }

    // ✅ Group by brand
    const grouped = products.reduce((acc, product) => {
      const brand = product.product_brand || "Unknown Brand";
      if (!acc[brand]) acc[brand] = [];
      acc[brand].push(product);
      return acc;
    }, {});

    // ✅ Sort products within each brand group
    Object.keys(grouped).forEach((brand) => {
      grouped[brand].sort((a, b) => {
        if (a.extracted_size !== b.extracted_size) {
          return a.extracted_size - b.extracted_size;
        }
        if (typeOrder[a.product_type] !== typeOrder[b.product_type]) {
          return typeOrder[a.product_type] - typeOrder[b.product_type];
        }
        if (keywordOrder[a.product_keyword] !== keywordOrder[b.product_keyword]) {
          return keywordOrder[a.product_keyword] - keywordOrder[b.product_keyword];
        }
        return a.product_title.localeCompare(b.product_title);
      });
    });

    // ✅ Return flat list if Favorites, else grouped
    const responseData = categoryFilter.toLowerCase() === "favorites"
      ? products
      : Object.values(grouped);

    return new Response(JSON.stringify(responseData), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
