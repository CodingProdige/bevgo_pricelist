import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { normalizeTimestamps, parseDashboardModules, toStr } from "../_utils";

const ok = (p = {}, s = 201) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

export async function POST(req) {
  try {
    const body = await req.json();
    const dashboardId = toStr(body?.dashboard_id || body?.id);
    if (!dashboardId) {
      return err(400, "Missing Dashboard ID", "Provide 'dashboard_id' (or 'id').");
    }

    const parsed = parseDashboardModules(body?.data ?? body?.dashboardModules ?? body);
    if (!parsed.ok) {
      return err(400, parsed.error, parsed.message);
    }

    const ref = doc(db, "dashboard_config_v1", dashboardId);
    const existing = await getDoc(ref);
    if (existing.exists()) {
      return err(409, "Already Exists", `Dashboard '${dashboardId}' already exists.`);
    }

    await setDoc(ref, {
      docId: dashboardId,
      dashboardModules: parsed.modules,
      timestamps: {
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
    });

    const snap = await getDoc(ref);
    return ok({
      id: dashboardId,
      data: normalizeTimestamps(snap.data() || {}),
      message: "Dashboard config created.",
    });
  } catch (e) {
    console.error("dashboard/config/create failed:", e);
    return err(500, "Unexpected Error", "Failed to create dashboard config.", {
      details: String(e?.message ?? "").slice(0, 300),
    });
  }
}

