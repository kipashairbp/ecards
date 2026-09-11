import { db, uuid } from '../db.js';
import {
  hardDeleteShul, hardDeleteApplicant, hardDeleteStore,
  restoreShulSnapshot, restoreApplicantSnapshot, restoreStoreSnapshot,
} from '../utils/entityDelete.js';
import {
  restoreDuplicateResolve, restoreDuplicateMergeApplicants, restoreDuplicateMergeShuls,
} from './duplicates.js';

// Dispatch tables for undoing a hard delete (shul/applicant/store), or a
// duplicate resolve/bypass/merge (see services/duplicates.js): CASCADE_RESTORERS
// brings a full snapshot back — used whenever the audit_log 'before' value is
// one of these snapshots, i.e. undoing the original action, or redoing a
// previous undo of one. HARD_DELETERS is the reverse direction — re-deleting
// the entity via its real cascade (not a naive single-row DELETE, which
// would violate FK constraints against contracts/notes a prior undo just
// restored) — used whenever the target state is "this entity shouldn't
// exist" (before === null) for one of these three entity types, whether
// that's undoing a 'create' or redoing an original delete (see
// SNAPSHOT_ONLY_ACTIONS below for why 'merge'/'resolve_duplicate' never
// reach this fallback even though their entity_type also appears here).
const CASCADE_RESTORERS = {
  'shul-cascade': restoreShulSnapshot, 'applicant-cascade': restoreApplicantSnapshot, 'store-cascade': restoreStoreSnapshot,
  'duplicate-resolve': restoreDuplicateResolve, 'duplicate-merge-applicant': restoreDuplicateMergeApplicants, 'duplicate-merge-shul': restoreDuplicateMergeShuls,
};
const HARD_DELETERS = { shul: hardDeleteShul, applicant: hardDeleteApplicant, store: hardDeleteStore };

// A duplicate resolve/bypass/merge touches several rows at once (both sides
// of a flag, every member of a merge group, reassigned applicants, ...) —
// there's no single "this record's prior column values" to fall back to the
// way restoreEntityState works for a plain update. So these two actions are
// undoable ONLY via a full kind-tagged snapshot (see services/duplicates.js's
// resolveFlag/mergeApplicants/mergeShuls) — never via the generic
// restoreEntityState or HARD_DELETERS fallback below. Rows logged before
// this snapshot existed (before === null, or a bare post-action summary
// object with no `kind`) simply predate undo support: the exact prior state
// was never recorded for them, so undoAuditEntry refuses rather than
// guessing — critically, refuses rather than falling into HARD_DELETERS,
// which for entity_type 'applicant'/'shul' would otherwise silently
// hard-delete the merge's primary record on an old, snapshot-less row.
const SNAPSHOT_ONLY_ACTIONS = new Set(['merge', 'resolve_duplicate']);
// Actions where before === null legitimately means "this entity shouldn't
// exist" — undoing a 'create', or redoing an 'undo' that itself reversed a
// delete (see the HARD_DELETERS comment above). Deliberately NOT 'merge' or
// any other action added later — before === null on those means "not
// captured," never "should be deleted."
const NULL_BEFORE_MEANS_DELETE = new Set(['create', 'undo']);

// ---------------------------------------------------------------------------
// Shared audit trail + generic undo/redo. Previously logAudit() was a local,
// unexported function duplicated only in shuls.js — every other route's
// mutations went completely unlogged. Pulled out here so every route can log
// consistently, and so undo/redo has one real implementation instead of N
// bespoke ones.
//
// Undo/redo works by restoring exactly the columns captured in before_json/
// after_json — NOT a full-row replace — so an undo never clobbers a column
// some *other*, later action touched. "Redo" isn't a separate code path:
// undoing an action logs a new audit_log row recording what it just did
// (before = the state right before the undo, after = the state it restored
// to); redoing is just calling undo() again on THAT new row. This keeps the
// history a simple forward-only append log instead of a branching structure.
//
// Only a curated set of action names are undoable at all (see
// UNDOABLE_ACTIONS below) — workflow/notification actions like esign, login,
// or send_contract have before/after shapes that don't represent full row
// state, and generically "restoring" them would do something destructive or
// meaningless (e.g. undoing an esign by deleting the contract row instead of
// un-signing it, which is a real, separate feature already).
// ---------------------------------------------------------------------------

// 'undo' is here deliberately: undoing an action logs a new 'undo' entry
// (see undoAuditEntry below), and that entry must itself be undoable — that
// symmetry IS how redo works, rather than a separate redo code path.
// 'merge' and 'resolve_duplicate' are gated further, in getRecentActions and
// undoAuditEntry, via SNAPSHOT_ONLY_ACTIONS above — being in this list alone
// isn't enough to make one of those rows undoable.
export const UNDOABLE_ACTIONS = ['create', 'update', 'delete', 'approve', 'reject', 'undo', 'merge', 'resolve_duplicate'];

// entity_type (as used in audit_log) -> real table + primary key column.
const ENTITY_TABLES = {
  shul: { table: 'shuls', pk: 'id' },
  applicant: { table: 'applicants', pk: 'id' },
  store: { table: 'stores', pk: 'id' },
  season: { table: 'seasons', pk: 'id' },
  task: { table: 'tasks', pk: 'id' },
  user: { table: 'users', pk: 'id' },
  card: { table: 'cards', pk: 'id' },
};

export function logAudit(orgId, userId, action, entityType, entityId, before, after, ip) {
  const id = uuid();
  db.prepare(`INSERT INTO audit_log (id, org_id, user_id, action, entity_type, entity_id, before_json, after_json, ip_address)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, orgId, userId, action, entityType, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, ip || null);
  return id;
}

// One audit_log row for an entire bulk action (mass-approve, mass-delete, a
// whole mass-upload job, ...) instead of one row per record it touched — a
// 300-row import or a 50-shul mass-approve used to flood Recent Actions with
// that many individual entries from a single click. entity_id is
// deliberately null (there's no single record this row is "about"); `ids`
// and whatever else the caller has on hand (skipped count, display names,
// the uniform value applied, ...) live in after_json instead. Never
// undoable — action names passed here are never added to UNDOABLE_ACTIONS,
// so getRecentActions' undoable check fails on the action name alone;
// reversing dozens of different records' worth of changes through the
// single-entity restore mechanism below isn't something this generically
// supports. No-ops (returns null) if nothing was actually affected — a mass
// action that skipped every row isn't worth a log entry.
export function logMassAudit(orgId, userId, action, entityType, ids, extra, ip) {
  if (!ids || !ids.length) return null;
  return logAudit(orgId, userId, action, entityType, null, null, { ids, count: ids.length, ...extra }, ip);
}

// Last N hours of audit_log for an org, newest first, with the acting user's
// name attached — hours === null means no time filter at all ("All time"),
// so an approval (or anything else) from before the previously-fixed 7-day
// window can actually be found and undone instead of just falling off the
// list. `null` user_id (public form submissions, system actions) shows as
// "System".
export function getRecentActions(orgId, hours = 48) {
  const rows = hours === null
    ? db.prepare(`SELECT a.*, u.first_name, u.last_name, u.email AS user_email
        FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.org_id = ? ORDER BY a.created_at DESC`).all(orgId)
    : db.prepare(`SELECT a.*, u.first_name, u.last_name, u.email AS user_email
        FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.org_id = ? AND a.created_at >= datetime('now', ?) ORDER BY a.created_at DESC`)
        .all(orgId, `-${hours} hours`);
  // A row is only "redoable" if the undo-entry it points to hasn't itself
  // been undone yet — otherwise that undo was already consumed by a
  // previous redo (or a second undo/redo cycle), and pointing at it again
  // would hit "already undone" instead of doing anything. Looked up
  // separately since the target row can, in principle, sit outside this
  // window's LIMIT if a lot happened since — a plain id lookup is safe either way.
  const undoEntryIds = [...new Set(rows.map(r => r.undo_entry_id).filter(Boolean))];
  const consumedIds = new Set();
  if (undoEntryIds.length) {
    const placeholders = undoEntryIds.map(() => '?').join(',');
    db.prepare(`SELECT id FROM audit_log WHERE id IN (${placeholders}) AND undone_at IS NOT NULL`).all(...undoEntryIds)
      .forEach(r => consumedIds.add(r.id));
  }
  return rows.map(r => {
    const before = r.before_json ? JSON.parse(r.before_json) : null;
    const after = r.after_json ? JSON.parse(r.after_json) : null;
    // merge/resolve_duplicate rows are only undoable when they carry a real
    // kind-tagged snapshot (see SNAPSHOT_ONLY_ACTIONS above) — a row logged
    // before that snapshot existed (before === null, or an old bare
    // post-action summary) never gets an Undo button, since there's no safe
    // generic fallback for "put every touched row back" the way there is
    // for a plain single-entity update.
    const hasRestorableSnapshot = !!(before && before.kind && CASCADE_RESTORERS[before.kind]);
    // A mass-approve row is undoable whenever it has a record of which ids
    // it touched — either the exact per-record updatedDiffs snapshot (see
    // routes/{applicants,shuls,stores}.js's mass-approve), or, for an older
    // row logged before that snapshot existed, just the plain ids list —
    // undoMassApproveEntry above reconstructs each one's prior state from
    // its own history rather than needing the snapshot to exist up front.
    const hasMassApproveTarget = r.action === 'mass-approve' && !!(after && ((after.updatedDiffs && after.updatedDiffs.length) || (after.ids && after.ids.length)));
    const undoable = SNAPSHOT_ONLY_ACTIONS.has(r.action)
      ? hasRestorableSnapshot && !r.undone_at
      : r.action === 'mass-approve'
        ? hasMassApproveTarget && !r.undone_at
        : (UNDOABLE_ACTIONS.includes(r.action) || r.action === 'mass-import' || r.action === 'mass-delete') && !!ENTITY_TABLES[r.entity_type] && !r.undone_at && !!(r.before_json || r.after_json);
    return {
      ...r, before, after, undoable,
      // Lets the UI put a "Redo" button directly on an already-undone row
      // instead of making the admin go find the separate "Reversed a change
      // to..." entry the undo created.
      redoable: !!r.undone_at && !!r.undo_entry_id && !consumedIds.has(r.undo_entry_id),
    };
  });
}

// Every audit_log row for ONE specific record (an applicant/shul/store/...),
// newest first, with the acting user's name attached — this is what a
// regular admin sees on that record's own "History" tab. Deliberately a
// much narrower read than getRecentActions: that one is a firehose across
// every entity in the org and stays super_admin-only; this is scoped to a
// single record the admin is already allowed to view, so any admin can see
// who touched it. `null` user_id (public form submissions, system actions)
// shows as "System".
export function getEntityHistory(orgId, entityType, entityId, limit = 100) {
  const rows = db.prepare(`SELECT a.id, a.action, a.before_json, a.after_json, a.created_at, u.first_name, u.last_name
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.org_id = ? AND a.entity_type = ? AND a.entity_id = ?
    ORDER BY a.created_at DESC LIMIT ?`).all(orgId, entityType, entityId, limit);
  return rows.map(r => {
    const after = r.after_json ? JSON.parse(r.after_json) : null;
    // For 'update' rows, before/after are captured as exactly the changed
    // fields (see every route's logAudit('update', ...) call) — so after's
    // keys ARE the changed-field list, no diffing needed.
    const changedFields = r.action === 'update' && after ? Object.keys(after) : [];
    return {
      id: r.id, action: r.action, created_at: r.created_at, changedFields,
      userName: r.first_name ? `${r.first_name} ${r.last_name || ''}`.trim() : null,
    };
  });
}

// Restores `targetState` onto entityId in its table:
//  - targetState is an object and the row exists  -> UPDATE just those columns
//  - targetState is an object and the row is gone  -> re-INSERT it (full or partial row)
//  - targetState is null and the row exists        -> DELETE it
//  - targetState is null and the row is gone        -> already correct, no-op
function restoreEntityState(entityType, entityId, targetState) {
  const def = ENTITY_TABLES[entityType];
  if (!def) throw new Error(`Entity type "${entityType}" is not undoable`);
  const exists = !!db.prepare(`SELECT 1 FROM ${def.table} WHERE ${def.pk} = ?`).get(entityId);
  if (targetState === null) {
    if (exists) db.prepare(`DELETE FROM ${def.table} WHERE ${def.pk} = ?`).run(entityId);
    return;
  }
  const keys = Object.keys(targetState).filter(k => k !== def.pk);
  if (exists) {
    if (!keys.length) return;
    db.prepare(`UPDATE ${def.table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE ${def.pk} = ?`)
      .run(...keys.map(k => targetState[k]), entityId);
  } else {
    const allKeys = [def.pk, ...keys];
    db.prepare(`INSERT INTO ${def.table} (${allKeys.join(', ')}) VALUES (${allKeys.map(() => '?').join(', ')})`)
      .run(...allKeys.map(k => (k === def.pk ? entityId : targetState[k])));
  }
}

// Undoes one audit_log entry: restores before_json, marks it undone, and
// logs a fresh 'undo' entry (before = after_json, after = before_json) that
// itself is undoable — clicking Undo on THAT entry is what redo is.
// Reverses a mass upload: every row it created gets hard-deleted, and every
// row it edited gets its touched columns restored to what they said right
// before the import — using the per-row before-snapshot the import route
// captured at update time (updatedDiffs, see routes/shuls.js and
// routes/applicants.js POST /import). Rows this entry never touched are
// left alone even if they've since been deleted or changed elsewhere —
// each id is independently checked to still exist before acting on it.
//
// Entries logged before this snapshot existed (mass-import rows from the
// narrow window after mass-action logging was consolidated to one row per
// click, but before per-row undo data was added) only carry the combined
// id list and counts — but since that list was always built as
// [...createdIds, ...updatedIds] in that exact order, the first `created`
// ids are still safely recoverable as "these were newly created" and can
// be deleted; the remaining ids were edits with no captured before-state,
// so those can't be reverted and are reported back as unrestorable rather
// than silently left alone.
//
// Deliberately NOT itself undoable/redoable — logged as 'mass-import-undo'
// (not 'undo'), a name that's neither in UNDOABLE_ACTIONS nor recognized by
// this function's own dispatch, and undo_entry_id is left unset on the
// original entry so no Redo button appears for it. Reversing dozens of
// deletes-and-restores through the generic single-entity redo mechanism
// isn't something this supports — if the import needs to happen again,
// that's a fresh upload.
function undoMassImportEntry(entry, actingUser, ip) {
  const def = ENTITY_TABLES[entry.entity_type];
  if (!def) throw new Error(`"${entry.entity_type}" records can't be undone`);
  const after = entry.after_json ? JSON.parse(entry.after_json) : {};
  const createdIds = after.createdIds || (after.ids || []).slice(0, after.created || 0);
  const updatedDiffs = after.updatedDiffs || [];
  const legacyUnrestorableCount = after.updatedDiffs ? 0 : Math.max(0, (after.ids || []).length - createdIds.length);
  if (!createdIds.length && !updatedDiffs.length) throw new Error('Nothing to restore for this import — no created or restorable updated records.');

  const hardDelete = { shul: hardDeleteShul, applicant: hardDeleteApplicant }[entry.entity_type]
    || ((row) => db.prepare(`DELETE FROM ${def.table} WHERE ${def.pk} = ?`).run(row[def.pk]));

  let deletedCreated = 0, restoredUpdated = 0;
  const run = db.transaction(() => {
    for (const id of createdIds) {
      const row = db.prepare(`SELECT * FROM ${def.table} WHERE ${def.pk} = ? AND org_id = ?`).get(id, entry.org_id);
      if (!row) continue;
      hardDelete(row);
      deletedCreated++;
    }
    for (const { id, before } of updatedDiffs) {
      if (!before || !Object.keys(before).length) continue;
      const exists = db.prepare(`SELECT 1 FROM ${def.table} WHERE ${def.pk} = ? AND org_id = ?`).get(id, entry.org_id);
      if (!exists) continue;
      const keys = Object.keys(before);
      db.prepare(`UPDATE ${def.table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE ${def.pk} = ?`)
        .run(...keys.map(k => before[k]), id);
      restoredUpdated++;
    }
  });
  run();

  db.prepare(`UPDATE audit_log SET undone_at = datetime('now') WHERE id = ?`).run(entry.id);
  const summary = { reversedEntry: entry.id, deletedCreated, restoredUpdated, unrestorableUpdated: legacyUnrestorableCount };
  const touchedIds = [...createdIds, ...updatedDiffs.map(d => d.id)];
  return logMassAudit(entry.org_id, actingUser.id, 'mass-import-undo', entry.entity_type, touchedIds.length ? touchedIds : [entry.id], summary, ip);
}

// Best-effort reconstruction of a single record's pre-approval state for a
// LEGACY mass-approve row (one logged before per-record snapshots existed —
// see reconstructLegacyBefore below). Walks that record's own audit_log
// history for the last time the relevant column was explicitly recorded
// (a reject, set-pending, or the row's own 'create' — every one of those
// already logs the real value), which is real recorded history, not a
// guess. Returns { state, tier } — tier is 'exact' when a real prior value
// was found this way, 'default' when nothing was ever recorded and the
// record's schema default is used instead (a new applicant/store really
// does always start out 'pending', so this is usually still correct — it's
// only ever wrong for the rarer case of a re-approval).
function reconstructApplicantBefore(id, beforeTs) {
  // <= not < : audit_log.created_at has only 1-second resolution
  // (SQLite datetime('now')), so a record created in the same mass-approve
  // click's second as its own 'create' row would otherwise be excluded by
  // a strict "before" comparison even though it's the real prior state.
  const rows = db.prepare(`SELECT after_json FROM audit_log WHERE entity_type = 'applicant' AND entity_id = ? AND created_at <= ? ORDER BY created_at DESC`).all(id, beforeTs);
  for (const r of rows) {
    if (!r.after_json) continue;
    let after; try { after = JSON.parse(r.after_json); } catch { continue; }
    if (after && Object.prototype.hasOwnProperty.call(after, 'approval_status')) {
      return { state: { approval_status: after.approval_status, card_amount: Object.prototype.hasOwnProperty.call(after, 'card_amount') ? after.card_amount : null }, tier: 'exact' };
    }
  }
  return { state: { approval_status: 'pending', card_amount: null }, tier: 'default' };
}
function reconstructStoreBefore(id, beforeTs) {
  const rows = db.prepare(`SELECT after_json FROM audit_log WHERE entity_type = 'store' AND entity_id = ? AND created_at <= ? ORDER BY created_at DESC`).all(id, beforeTs);
  for (const r of rows) {
    if (!r.after_json) continue;
    let after; try { after = JSON.parse(r.after_json); } catch { continue; }
    if (after && Object.prototype.hasOwnProperty.call(after, 'setup_status')) return { state: { setup_status: after.setup_status }, tier: 'exact' };
  }
  return { state: { setup_status: 'pending' }, tier: 'default' };
}
// Shuls are the one case where the audit trail alone can lie: sending or
// signing a contract writes shuls.status directly (routes/shuls.js) without
// ever calling logAudit, so a shul that went submitted -> contract_sent ->
// contract_signed -> approved would otherwise look, from audit_log alone,
// like it was still 'submitted' right before approval (only its 'create'
// row ever mentions status). The contracts table doesn't have that gap —
// sent_at/signed_at are real columns set at the time — so this compares
// whichever source (an explicit status-changing audit entry, or the
// contract's own sent_at/signed_at) is chronologically LATEST before the
// approval and trusts that one, rather than always preferring one source.
function reconstructShulBefore(id, beforeTs) {
  let best = null; // { at, status, tier }
  // <= throughout this function: audit_log/contracts timestamps only have
  // 1-second resolution, so a same-second transition (e.g. contract signed
  // and shul mass-approved within the same click-driven second) would
  // otherwise be wrongly excluded by a strict "before" comparison.
  const rows = db.prepare(`SELECT created_at, after_json FROM audit_log WHERE entity_type = 'shul' AND entity_id = ? AND action != 'create' AND created_at <= ? ORDER BY created_at DESC`).all(id, beforeTs);
  for (const r of rows) {
    if (!r.after_json) continue;
    let after; try { after = JSON.parse(r.after_json); } catch { continue; }
    if (after && Object.prototype.hasOwnProperty.call(after, 'status')) { best = { at: r.created_at, status: after.status, tier: 'exact' }; break; }
  }
  const contract = db.prepare(`SELECT signed_at, sent_at FROM contracts WHERE shul_id = ? ORDER BY created_at DESC LIMIT 1`).get(id);
  if (contract?.signed_at && contract.signed_at <= beforeTs && (!best || contract.signed_at >= best.at)) best = { at: contract.signed_at, status: 'contract_signed', tier: 'derived' };
  else if (contract?.sent_at && contract.sent_at <= beforeTs && (!best || contract.sent_at >= best.at)) best = { at: contract.sent_at, status: 'contract_sent', tier: 'derived' };
  if (best) return { state: { status: best.status, slots_allocated: 0, portal_user_id: null }, tier: best.tier };
  return { state: { status: 'submitted', slots_allocated: 0, portal_user_id: null }, tier: 'default' };
}
const LEGACY_MASS_APPROVE_RECONSTRUCTORS = { applicant: reconstructApplicantBefore, shul: reconstructShulBefore, store: reconstructStoreBefore };

// Reverses a mass-approve: every record it approved gets the columns it
// overwrote (approval_status/card_amount for applicants, status/
// slots_allocated/portal_user_id for shuls, setup_status for stores) put
// back. Side effects the approval triggered (disccardpromos account/funds,
// the "you're approved" email) are never reversed here — exactly like
// undoing a single /:id/approve already doesn't reverse those either; this
// only ever puts the local record state back.
//
// A row logged after routes/{applicants,shuls,stores}.js's mass-approve
// started capturing a real per-record before-snapshot (updatedDiffs) uses
// that directly — exact, no guessing. An older row without one is
// reconstructed per record via reconstructLegacyBefore above instead of
// being refused outright; the mass-approve-undo summary this logs records
// how many ids were exact vs. reconstructed from a default, so Recent
// Actions can show that honestly rather than silently presenting a guess
// as a certainty.
function undoMassApproveEntry(entry, actingUser, ip) {
  const def = ENTITY_TABLES[entry.entity_type];
  if (!def) throw new Error(`"${entry.entity_type}" records can't be undone`);
  const after = entry.after_json ? JSON.parse(entry.after_json) : {};
  let updatedDiffs = after.updatedDiffs || [];
  let reconstructed = false;
  if (!updatedDiffs.length) {
    const ids = after.ids || [];
    const reconstructor = LEGACY_MASS_APPROVE_RECONSTRUCTORS[entry.entity_type];
    if (!ids.length || !reconstructor) throw new Error('This mass approval was logged before any per-record data was captured — there\'s nothing to reconstruct from.');
    updatedDiffs = ids.map(id => { const { state, tier } = reconstructor(id, entry.created_at); return { id, before: state, tier }; });
    reconstructed = true;
  }
  let restored = 0;
  const tierCounts = { exact: 0, derived: 0, default: 0 };
  const run = db.transaction(() => {
    for (const { id, before, tier } of updatedDiffs) {
      if (!before || !Object.keys(before).length) continue;
      const exists = db.prepare(`SELECT 1 FROM ${def.table} WHERE ${def.pk} = ? AND org_id = ?`).get(id, entry.org_id);
      if (!exists) continue;
      const keys = Object.keys(before);
      db.prepare(`UPDATE ${def.table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE ${def.pk} = ?`)
        .run(...keys.map(k => before[k]), id);
      restored++;
      if (tier) tierCounts[tier] = (tierCounts[tier] || 0) + 1;
    }
  });
  run();
  db.prepare(`UPDATE audit_log SET undone_at = datetime('now') WHERE id = ?`).run(entry.id);
  const touchedIds = updatedDiffs.map(d => d.id);
  const summary = { restored, ...(reconstructed ? { reconstructed: true, exactCount: tierCounts.exact, derivedCount: tierCounts.derived, defaultedCount: tierCounts.default } : {}) };
  return logMassAudit(entry.org_id, actingUser.id, 'mass-approve-undo', entry.entity_type, touchedIds.length ? touchedIds : [entry.id], summary, ip);
}

// Reverses a mass-delete: every record it hard-deleted gets fully restored
// (main row + every related row the cascade removed/unlinked) from the
// per-row snapshot routes/{shuls,applicants,stores}.js captured right
// before deleting each one (see captureShulSnapshot() & friends). Same
// "deliberately not itself undoable/redoable" shape as
// undoMassImportEntry above, for the same reason — logged as
// 'mass-delete-undo', not 'undo', and never wired to a Redo button.
function undoMassDeleteEntry(entry, actingUser, ip) {
  const after = entry.after_json ? JSON.parse(entry.after_json) : {};
  const snapshots = after.snapshots || [];
  if (!snapshots.length) throw new Error('Nothing to restore for this mass delete — no snapshot data was saved for these records.');
  let restored = 0;
  const run = db.transaction(() => {
    for (const snap of snapshots) {
      const restore = CASCADE_RESTORERS[snap.kind];
      if (!restore) continue;
      restore(snap);
      restored++;
    }
  });
  run();
  db.prepare(`UPDATE audit_log SET undone_at = datetime('now') WHERE id = ?`).run(entry.id);
  const touchedIds = snapshots.map(s => s.row.id);
  return logMassAudit(entry.org_id, actingUser.id, 'mass-delete-undo', entry.entity_type, touchedIds.length ? touchedIds : [entry.id], { restored }, ip);
}

export function undoAuditEntry(auditId, actingUser, ip) {
  const entry = db.prepare('SELECT * FROM audit_log WHERE id = ?').get(auditId);
  if (!entry) throw new Error('Action not found');
  if (entry.org_id !== actingUser.org_id) throw new Error('Not found');
  if (entry.undone_at) throw new Error('This action was already undone');
  if (entry.action === 'mass-import') return undoMassImportEntry(entry, actingUser, ip);
  if (entry.action === 'mass-delete') return undoMassDeleteEntry(entry, actingUser, ip);
  if (entry.action === 'mass-approve') return undoMassApproveEntry(entry, actingUser, ip);
  if (!UNDOABLE_ACTIONS.includes(entry.action)) throw new Error(`"${entry.action}" actions can't be undone`);
  if (!ENTITY_TABLES[entry.entity_type]) throw new Error(`"${entry.entity_type}" records can't be undone`);
  const before = entry.before_json ? JSON.parse(entry.before_json) : null;
  const after = entry.after_json ? JSON.parse(entry.after_json) : null;
  if (before === null && after === null) throw new Error('Nothing to restore for this action');

  if (SNAPSHOT_ONLY_ACTIONS.has(entry.action) && !(before && before.kind && CASCADE_RESTORERS[before.kind])) {
    // A merge/resolve touches several rows at once — see SNAPSHOT_ONLY_ACTIONS
    // above — so without a real snapshot there is no safe way to undo it.
    // Refuse outright rather than falling through to restoreEntityState or
    // HARD_DELETERS, either of which would, for entity_type shul/applicant,
    // wrongly delete the merge's primary record.
    throw new Error(`This "${entry.action === 'merge' ? 'merge' : 'duplicate resolve'}" action was logged before undo support existed for it, so the exact prior state was never recorded — it can't be undone.`);
  }

  const run = db.transaction(() => {
    if (before && before.kind && CASCADE_RESTORERS[before.kind]) {
      // Undoing a hard delete, a duplicate resolve/merge (or redoing a
      // previous undo of one) — bring back the whole snapshot, not just a
      // bare row.
      CASCADE_RESTORERS[before.kind](before);
    } else if (before === null && NULL_BEFORE_MEANS_DELETE.has(entry.action) && HARD_DELETERS[entry.entity_type]) {
      // Target state is "doesn't exist" for a shul/applicant/store — use
      // the real cascade delete rather than restoreEntityState's naive
      // single-row DELETE, which would fail (or leave orphans) against any
      // FK-constrained related rows a prior undo just restored.
      const def = ENTITY_TABLES[entry.entity_type];
      const row = db.prepare(`SELECT * FROM ${def.table} WHERE ${def.pk} = ?`).get(entry.entity_id);
      if (row) HARD_DELETERS[entry.entity_type](row);
    } else {
      restoreEntityState(entry.entity_type, entry.entity_id, before);
    }
  });
  run();

  const undoEntryId = logAudit(entry.org_id, actingUser.id, 'undo', entry.entity_type, entry.entity_id, after, before, ip);
  db.prepare(`UPDATE audit_log SET undone_at = datetime('now'), undo_entry_id = ? WHERE id = ?`).run(undoEntryId, auditId);
  return undoEntryId;
}
