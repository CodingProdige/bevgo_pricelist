import { db } from "@/lib/firebase";
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

// Function to extract bottle size from product title
const extractBottleSize = (title) => {
  if (!title) return 0;
  const match = title.match(/(\d+(\.\d+)?)\s?(ml|l|lt)/i);
  if (match) {
    let size = parseFloat(match[1]);
    return match[3].toLowerCase().includes("ml") ? size : size * 1000;
  }
  return 0;
};

// Function to determine product type
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

const keywordOrder = Object.fromEntries(keywords.map((k, index) => [k, index + 1]));
keywordOrder["Other"] = keywords.length + 1;

export async function GET() {
  try {
    const querySnapshot = await getDocs(collection(db, "products"));
    const existingCodes = new Set();

    const products = await Promise.all(
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

    // Group by product_brand
    const groupedProducts = products.reduce((acc, product) => {
      const brand = product.product_brand || "Unknown Brand";
      if (!acc[brand]) {
        acc[brand] = [];
      }
      acc[brand].push(product);
      return acc;
    }, {});

    // Sort products within each brand
    Object.keys(groupedProducts).forEach((brand) => {
      groupedProducts[brand].sort((a, b) => {
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

    // Order categories (brands) alphabetically
    const sortedBrands = Object.keys(groupedProducts).sort();
    const sortedGroupedProducts = {};
    sortedBrands.forEach((brand) => {
      sortedGroupedProducts[brand] = groupedProducts[brand];
    });

    return new Response(JSON.stringify(sortedGroupedProducts), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}