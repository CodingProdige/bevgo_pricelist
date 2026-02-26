import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { collection, doc, getDoc, getDocs } from "firebase/firestore";
import { normalizeTimestamps, toInt, toStr } from "../_utils";

const ok = (p = {}, s = 200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const id = toStr(searchParams.get("id"));

    if (id) {
      const snap = await getDoc(doc(db, "dashboard_config_v1", id));
      if (!snap.exists()) {
        return err(404, "Not Found", `No dashboard config with id '${id}'.`);
      }
      return ok({ id: snap.id, data: normalizeTimestamps(snap.data() || {}) });
    }

    const limitRaw = toStr(searchParams.get("limit"), "24").toLowerCase();
    const unlimited = limitRaw === "all";
    const limit = unlimited ? null : Math.max(1, toInt(limitRaw, 24));

    let items = (await getDocs(collection(db, "dashboard_config_v1"))).docs.map((d) => ({
      id: d.id,
      data: normalizeTimestamps(d.data() || {}),
    }));

    items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (!unlimited && limit != null) items = items.slice(0, limit);

    return ok({ count: items.length, items });
  } catch (e) {
    console.error("dashboard/config/get failed:", e);
    return err(500, "Unexpected Error", "Failed to fetch dashboard config.", {
      details: String(e?.message ?? "").slice(0, 300),
    });
  }
}

