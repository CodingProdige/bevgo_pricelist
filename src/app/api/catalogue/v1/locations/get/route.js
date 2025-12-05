import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  limit as qLimit
} from "firebase/firestore";

/* ---------- response helpers ---------- */
const ok  = (p = {}, s = 200) => NextResponse.json({ ok: true, data: p.data ?? p.data === null ? p.data : p }, { status: s });
const err = (s, t, m, e = {}) => NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

/* ---------- helpers ---------- */
const normStr = (v) => {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const low = s.toLowerCase();
  if (low === "null" || low === "undefined") return "";
  return s;
};

const toBool = (v) => {
  if (typeof v === "boolean") return v;
  const s = normStr(v).toLowerCase();
  if (!s) return null;
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return null;
};

const tsToIso = (v) =>
  v && typeof v?.toDate === "function"
    ? v.toDate().toISOString()
    : v ?? null;

function normalizeTimestamps(doc) {
  if (!doc || typeof doc !== "object") return doc;
  const ts = doc.timestamps;
  return {
    ...doc,
    ...(ts
      ? {
          timestamps: {
            createdAt: tsToIso(ts.createdAt),
            updatedAt: tsToIso(ts.updatedAt),
          },
        }
      : {}),
  };
}

/* ---------- main handler ---------- */
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);

    const byId = normStr(searchParams.get("id"));
    const byLocId = normStr(searchParams.get("location_id"));

    /* ----------------------------------------------------
     * SINGLE-ITEM LOOKUP
     * ---------------------------------------------------- */
    if (byId || byLocId) {
      let snap;

      // Fetch by Firestore docId
      if (byId) {
        const ref = doc(db, "bevgo_locations", byId);
        snap = await getDoc(ref);
      }
      // Fetch by location_id field
      else if (byLocId) {
        const q = query(
          collection(db, "bevgo_locations"),
          where("location_id", "==", byLocId),
          qLimit(1)
        );
        const rs = await getDocs(q);
        snap = rs.docs[0];
      }

      if (!snap || !snap.exists()) {
        return err(
          404,
          "Not Found",
          `No location found with ${byLocId ? `location_id '${byLocId}'` : `id '${byId}'`}.`
        );
      }

      const data = normalizeTimestamps(snap.data() || {});
      return ok({ data: { ...data, docId: snap.id } });
    }

    /* ----------------------------------------------------
     * LIST MODE
     * ---------------------------------------------------- */
    const isActive   = toBool(searchParams.get("isActive"));
    const isPrimary  = toBool(searchParams.get("isPrimary"));
    const typeFilter = normStr(searchParams.get("type"));

    const rawLimitNorm = normStr(searchParams.get("limit"));
    const rawLimit = (rawLimitNorm || "all").toLowerCase();
    const noLimit = rawLimit === "all";

    let lim = noLimit ? null : Number.parseInt(rawLimit, 10);
    if (!noLimit && (!Number.isFinite(lim) || lim <= 0)) lim = 50;

    // Load all documents
    const col = collection(db, "bevgo_locations");
    const rs = await getDocs(col);

    let items = rs.docs.map((d) => ({
      id: d.id,
      data: normalizeTimestamps(d.data() || {}),
    }));

    // filters
    items = items.filter(({ data }) => {
      if (isActive !== null && !!data?.placement?.isActive !== isActive) return false;
      if (isPrimary !== null && !!data?.placement?.isPrimary !== isPrimary) return false;
      if (typeFilter && data?.type?.toLowerCase() !== typeFilter.toLowerCase()) return false;
      return true;
    });

    /* ----------------------------------------------------
     * ORDER BY placement.position ASC
     * If missing/invalid → push to bottom
     * ---------------------------------------------------- */
    items.sort((a, b) => {
      const pa = Number.isFinite(+a.data?.placement?.position)
        ? +a.data.placement.position
        : Number.POSITIVE_INFINITY;

      const pb = Number.isFinite(+b.data?.placement?.position)
        ? +b.data.placement.position
        : Number.POSITIVE_INFINITY;

      return pa - pb;
    });

    // limit
    if (!noLimit && lim != null) items = items.slice(0, lim);

    const count = items.length;

    const data = items.map((it) => ({
      ...it.data,
      docId: it.id,
    }));

    return ok({ count, data });

  } catch (e) {
    console.error("bevgo_locations/get failed:", e);
    return err(500, "Unexpected Error", "Something went wrong while fetching locations.", {
      error: e.message,
      stack: e.stack,
    });
  }
}
