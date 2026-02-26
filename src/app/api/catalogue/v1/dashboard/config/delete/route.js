import { NextResponse } from "next/server";
import { db } from "@/lib/firebase";
import { deleteDoc, doc, getDoc } from "firebase/firestore";
import { toStr } from "../_utils";

const ok = (p = {}, s = 200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

export async function POST(req) {
  try {
    const body = await req.json();
    const dashboardId = toStr(body?.dashboard_id || body?.id);
    if (!dashboardId) {
      return err(400, "Missing Dashboard ID", "Provide 'dashboard_id' (or 'id').");
    }

    const ref = doc(db, "dashboard_config_v1", dashboardId);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      return err(404, "Not Found", `No dashboard config with id '${dashboardId}'.`);
    }

    await deleteDoc(ref);
    return ok({ id: dashboardId, message: "Dashboard config deleted." });
  } catch (e) {
    console.error("dashboard/config/delete failed:", e);
    return err(500, "Unexpected Error", "Failed to delete dashboard config.", {
      details: String(e?.message ?? "").slice(0, 300),
    });
  }
}

