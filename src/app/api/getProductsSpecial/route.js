import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";

/* ----------------------------- helpers ----------------------------- */

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
  const t = title.toLowerCase();
  if (t.includes("can")) return "Cans";
  if (t.includes("pet")) return "PET";
  if (t.includes("glass")) return "Glass";
  return "Other";
};

const typeOrder = { Cans: 1, PET: 2, Glass: 3, Other: 4 };

const keywords = [
  "Tonic", "Soda Water", "Lemonade", "Ginger Ale", "Dry Lemon",
  "Pink Tonic", "Emotions", "Teardrop", "Standard"
];

const extractProductKeyword = (title) => {
  if (!title) return "Other";
  const lower = title.toLowerCase();
  for (let keyword of keywords) {
    if (lower.includes(keyword.toLowerCase())) return keyword;
  }
  return "Other";
};

const keywordOrder = Object.fromEntries(keywords.map((k, i) => [k, i + 1]));
keywordOrder["Other"] = keywords.length + 1;

// tiny helper to parse boolean-ish query params
const parseBool = (v) => {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
};

/* ------------------------------ route ------------------------------ */

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const categoryFilter = (searchParams.get("category") || "").trim().toLowerCase();
    const topCategoryFilter = (searchParams.get("topCategory") || "").trim().toLowerCase();
    const searchQuery = (searchParams.get("search") || "").toLowerCase().trim();
    const companyCode = (searchParams.get("companyCode") || "").trim();
    const isFreeEligible = parseBool(searchParams.get("isFreeEligible"));

    // load favorites (only if needed)
    let favoriteCodes = [];
    if (categoryFilter === "favorites" && companyCode) {
      try {
        const res = await fetch("https://bevgo-client.vercel.app/api/getUser", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyCode }),
        });
        if (!res.ok) throw new Error("User fetch failed: " + res.status);
        const json = await res.json();
        favoriteCodes = Array.isArray(json?.data?.favorites_unique_codes)
          ? json.data.favorites_unique_codes.map(String)
          : [];
      } catch (err) {
        console.warn("⚠️ Failed to fetch user favorites:", err.message);
      }
    }

    // fetch all products (NO side-effects; no unique_code generation here)
    const snap = await getDocs(collection(db, "products"));
    let products = snap.docs.map((d) => {
      const p = d.data();
      return {
        id: d.id,
        ...p,
        extracted_size: extractBottleSize(p.product_title),
        product_type: extractProductType(p.product_title),
        product_keyword: extractProductKeyword(p.product_title),
      };
    });

    // filter: category
    if (categoryFilter === "favorites") {
      products = products.filter((p) => favoriteCodes.includes(String(p.unique_code)));
    } else if (categoryFilter === "sale") {
      products = products.filter((p) => p.on_sale === true);
    } else if (categoryFilter) {
      products = products.filter(
        (p) => ((p.product_brand || "").toLowerCase() === categoryFilter)
      );
    }

    // filter: topCategory
    if (topCategoryFilter) {
      products = products.filter(
        (p) => ((p.product_category || "").toLowerCase() === topCategoryFilter)
      );
    }

    // filter: search
    if (searchQuery) {
      products = products.filter((p) =>
        (p.product_title || "").toLowerCase().includes(searchQuery)
      );
    }

    // filter: free-eligible (AND with above)
    if (isFreeEligible) {
      products = products.filter((p) => p.free_item_eligible === true);
    }

    // stable flat sort: brand → size → type → keyword → title
    products.sort((a, b) => {
      const brandA = (a.product_brand || "Unknown Brand").localeCompare(b.product_brand || "Unknown Brand");
      if (brandA !== 0) return brandA;
      if (a.extracted_size !== b.extracted_size) return a.extracted_size - b.extracted_size;
      if (typeOrder[a.product_type] !== typeOrder[b.product_type]) {
        return (typeOrder[a.product_type] || 999) - (typeOrder[b.product_type] || 999);
      }
      if (keywordOrder[a.product_keyword] !== keywordOrder[b.product_keyword]) {
        return (keywordOrder[a.product_keyword] || 999) - (keywordOrder[b.product_keyword] || 999);
      }
      return (a.product_title || "").localeCompare(b.product_title || "");
    });

    // ALWAYS return a flat list
    return new Response(JSON.stringify(products), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
