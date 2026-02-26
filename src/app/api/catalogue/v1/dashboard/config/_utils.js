export const toStr = (v, f = "") => (v == null ? f : String(v)).trim();
export const toInt = (v, f = 0) => (Number.isFinite(+v) ? Math.trunc(+v) : f);
export const toBool = (v, f = false) =>
  typeof v === "boolean"
    ? v
    : typeof v === "number"
    ? v !== 0
    : typeof v === "string"
    ? ["true", "1", "yes", "y"].includes(v.toLowerCase())
    : f;

export function tsToIso(v) {
  return v && typeof v?.toDate === "function" ? v.toDate().toISOString() : v ?? null;
}

export function normalizeTimestamps(docData) {
  if (!docData || typeof docData !== "object") return docData;
  const out = { ...docData };
  if (out.timestamps) {
    out.timestamps = {
      createdAt: tsToIso(out.timestamps.createdAt),
      updatedAt: tsToIso(out.timestamps.updatedAt),
    };
  }
  return out;
}

function sanitizeModule(raw, idx) {
  if (!raw || typeof raw !== "object") return null;

  const type = toStr(raw.type);
  if (!type) return null;

  const data = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? raw.data : {};
  const key = toStr(raw.key);
  const enabled = toBool(raw.enabled, true);
  const order = (() => {
    const n = toInt(raw.order, idx + 1);
    return n > 0 ? n : idx + 1;
  })();

  return { key, type, enabled, order, data };
}

function normalizeKeySeed(value, fallback = "module") {
  const s = toStr(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || fallback;
}

function ensureUniqueModuleKey(seed, seen) {
  const base = normalizeKeySeed(seed, "module");
  let candidate = base;
  let i = 2;
  while (seen.has(candidate)) {
    candidate = `${base}_${i}`;
    i++;
  }
  seen.add(candidate);
  return candidate;
}

export function parseDashboardModules(input) {
  const modulesRaw = Array.isArray(input)
    ? input
    : Array.isArray(input?.dashboardModules)
    ? input.dashboardModules
    : null;

  if (!modulesRaw) {
    return {
      ok: false,
      error: "Invalid Data",
      message: "Provide 'data.dashboardModules' as an array (or pass the array directly).",
    };
  }

  const sanitized = modulesRaw
    .map((raw, idx) => sanitizeModule(raw, idx))
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);

  const seenKeys = new Set();
  const modules = sanitized.map((m, idx) => ({
    ...m,
    key: ensureUniqueModuleKey(m.key || `${m.type}_${idx + 1}`, seenKeys),
  }));

  if (!modules.length) {
    return {
      ok: false,
      error: "Invalid Modules",
      message: "At least one valid module with a non-empty 'type' is required.",
    };
  }

  return { ok: true, modules };
}
