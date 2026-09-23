import { db } from '../db.js';

// Match of a transaction's raw store name text (as reported by
// disccardpromos — services/cardSync.js's `vendor`) to a known participating
// store, so spend can be aggregated per store live. Falls back to null —
// the transaction still shows up in the ledger by name, just isn't linked
// to a store record yet.
//
// An explicit link (routes/stores.js's provider-links endpoints, set from a
// store's own profile) always wins when one exists — that's the whole point
// of letting an admin link "Amazon.com" the disccardpromos vendor name to
// "Amazon" the store record here even though the names don't match at all.
// Only when NO explicit link exists for this exact vendor name does this
// fall back to the old best-effort name matching, so an org that hasn't
// linked anything yet keeps behaving as before.
export function resolveStoreId(orgId, storeName) {
  if (!storeName) return null;
  // Case/whitespace-insensitive: disccardpromos doesn't always report the
  // exact same vendor name string byte-for-byte between syncs (casing,
  // stray leading/trailing spaces), and an exact match here silently left
  // some of a linked store's own transactions unattributed forever — the
  // store looked "not linking" even though a link genuinely existed.
  const linked = db.prepare('SELECT store_id FROM store_provider_links WHERE org_id = ? AND LOWER(TRIM(vendor_name)) = LOWER(TRIM(?))').get(orgId, storeName);
  if (linked) return linked.store_id;
  const exact = db.prepare('SELECT id FROM stores WHERE org_id = ? AND LOWER(name) = LOWER(?)').get(orgId, storeName);
  if (exact) return exact.id;
  const partial = db.prepare('SELECT id FROM stores WHERE org_id = ? AND LOWER(name) LIKE LOWER(?)').get(orgId, `%${storeName}%`);
  return partial?.id || null;
}
