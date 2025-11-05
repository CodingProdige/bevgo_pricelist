import { getCountFromServer, query } from "firebase/firestore";

/**
 * Return the next position in a scope = count(scope) + 1
 * @param {import("firebase/firestore").CollectionReference} colRef
 * @param {import("firebase/firestore").QueryConstraint[]} scopeFilters
 * @returns {Promise<number>}
 */
export async function nextPosition(colRef, scopeFilters = []) {
  const qy = query(colRef, ...scopeFilters);
  const snap = await getCountFromServer(qy);
  const count = snap.data().count || 0;
  return Number(count) + 1;
}
