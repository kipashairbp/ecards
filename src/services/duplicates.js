import { db, uuid } from '../db.js';
import { captureApplicantSnapshot, hardDeleteApplicant, restoreApplicantSnapshot } from '../utils/entityDelete.js';

const norm = (s) => (s || '').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');

// Fields an admin can pick a per-field winner for when merging a confirmed
// applicant duplicate (see mergeApplicants below) — real identity/contact/
// demographic data only, not status/shul/source/system fields, which aren't
// something to "merge" (each member keeps its own shul_id, approval_status,
// etc. — only the primary's copy of these actual data fields changes).
const MERGE_FIELDS = ['first_name', 'last_name', 'marital_status', 'home_phone', 'husband_cell', 'wife_cell', 'email',
  'address', 'city', 'state', 'zip', 'preferred_contact_method', 'preferred_number', 'num_children', 'home_for_yomtov',
  'comments', 'card_amount'];

// Same idea for shuls (see mergeShuls below) — real identity/contact data
// only, never status/slots_allocated/source/portal_user_id, which aren't
// something to "merge" (the surviving record keeps its own).
const SHUL_MERGE_FIELDS = ['name_en', 'name_he', 'address', 'city', 'state', 'zip',
  'ruv_first_name', 'ruv_last_name', 'ruv_phone', 'ruv_address', 'ruv_city', 'ruv_state', 'ruv_zip',
  'gabai_first_name', 'gabai_last_name', 'gabai_cell', 'gabai_email', 'gabai_address', 'gabai_city', 'gabai_state', 'gabai_zip'];

// Freezes both the newly-created record's owning account AND the matched record's
// owning account (per spec: "pause both accounts from doing any action or using
// the card until the duplicate is fixed or bypassed").
function pauseAccountsFor(entityType, entityId, matchedId) {
  if (entityType === 'shul') {
    db.prepare('UPDATE shuls SET is_paused = 1 WHERE id IN (?, ?)').run(entityId, matchedId);
    db.prepare(`UPDATE users SET is_paused = 1 WHERE shul_id IN (?, ?)`).run(entityId, matchedId);
  } else {
    db.prepare('UPDATE applicants SET is_paused = 1 WHERE id IN (?, ?)').run(entityId, matchedId);
    // Applicants don't log in directly, but pause their card use.
    db.prepare(`UPDATE cards SET status = 'deactivated' WHERE applicant_id IN (?, ?) AND status != 'deactivated'`).run(entityId, matchedId);
  }
}

// Checks a shul against existing shuls in the same org (any season — "shouldn't
// need to upload everyone again", so duplicates are detected across seasons too).
// Matches on: normalized name+city, or same Rav phone, or same Gabai email.
// excludeIds lets a caller rule out a specific candidate that's known to be
// the same record on purpose (e.g. carry-forward's own source shul, which
// necessarily matches every field of the row it just generated) rather than
// a genuine second entry of the same real-world shul.
export function checkShulDuplicate(orgId, shul, excludeIds = []) {
  const ids = [shul.id, ...excludeIds];
  const candidates = db.prepare(`SELECT * FROM shuls WHERE org_id = ? AND id NOT IN (${ids.map(() => '?').join(',')})`).all(orgId, ...ids);
  for (const c of candidates) {
    let reason = null;
    if (norm(c.name_en) === norm(shul.name_en) && norm(c.city) === norm(shul.city) && norm(shul.name_en)) reason = 'Same shul name + city';
    else if (shul.ruv_phone && norm(c.ruv_phone) === norm(shul.ruv_phone)) reason = 'Same Rav phone number';
    else if (shul.gabai_email && norm(c.gabai_email) === norm(shul.gabai_email)) reason = 'Same Gabai email';
    if (reason) return { matchedId: c.id, reason };
  }
  return null;
}

// A full first+last name match is a duplicate on its own — no longer
// requires a matching zip too — and so is a match on any single phone
// number (home, husband cell, or wife cell), the email address, or the
// full mailing address (street+city+state+zip together, not just zip
// alone — two applicants sharing a zip code isn't meaningful, but sharing
// an actual street address is).
const fullAddress = (a) => norm([a.address, a.city, a.state, a.zip].filter(Boolean).join('|'));
// Scoped to the applicant's own season, unlike checkShulDuplicate above —
// a shul only exists once and reuses the same row across seasons via
// carry-forward, so matching it against its own past self would be a false
// positive worth catching; an applicant legitimately reapplies fresh every
// season (a new row each time), so matching last season's version of the
// same person is expected, normal behavior, not a duplicate.
// Every field-based reason `a` currently matches candidate `c` on, in the
// same priority order the old single-reason version used to short-circuit
// on — kept as an ordered list (not just a boolean) so checkApplicantDuplicate
// below can report "reasonsNow[0]" for plain creation-time checks (identical
// behavior to before) while also being able to diff the full set against a
// prior state for the continuous re-check case.
function matchReasons(a, aAddress, c) {
  const reasons = [];
  const sameName = norm(a.first_name) && norm(a.last_name) && norm(c.first_name) === norm(a.first_name) && norm(c.last_name) === norm(a.last_name);
  if (sameName) reasons.push('Same first and last name');
  if (a.home_phone && norm(c.home_phone) === norm(a.home_phone)) reasons.push('Same home phone number');
  if (a.husband_cell && norm(c.husband_cell) === norm(a.husband_cell)) reasons.push('Same husband cell number');
  if (a.wife_cell && norm(c.wife_cell) === norm(a.wife_cell)) reasons.push('Same wife cell number');
  if (a.email && norm(c.email) === norm(a.email)) reasons.push('Same email address');
  if (a.address && aAddress === fullAddress(c)) reasons.push('Same address');
  return reasons;
}
// previousApplicant (optional): the record's own field values immediately
// before whatever save is being checked — passed by callers that re-check
// on every edit (not just first-time creation), so a match caused ENTIRELY
// by data that was already there on both sides before this save doesn't
// get re-flagged; only a reason that wasn't already true against this same
// candidate counts as new. Omitted (or null) for a genuinely new record —
// nothing "already existed" for it, so every match is new by definition,
// same as the original one-time creation-only check.
// 'draft' (shul-portal bulk upload, not yet submitted) and 'incomplete'
// (carried-forward, awaiting re-enrollment) rows are excluded from the
// candidate pool entirely — not "real" submissions yet, so they never
// count as either side of a match: two drafts that happen to share a name
// don't flag each other, and an already-active applicant never gets
// flagged just because some unrelated draft shares a field with them. A
// draft/incomplete row being checked can still match — and get flagged
// against — a genuinely active (non-draft/incomplete) applicant, since
// this only narrows the CANDIDATE side, not which row is doing the
// checking.
export function checkApplicantDuplicate(orgId, applicant, previousApplicant) {
  // 'incomplete' (carried-forward, awaiting re-enrollment) is excluded as
  // the SUBJECT too, not just the candidate side above — unlike 'draft',
  // which is still deliberately checked as subject against a genuinely
  // active applicant (see the comment above). An admin/shul editing basic
  // info on a carried-forward row before ever re-enrolling it (PUT /:id
  // calls this on every save, regardless of status) used to be able to
  // trigger a real flag+pause against, most commonly, its own prior-season
  // self or a sibling record sharing carried-over data — before the shul
  // has done anything that counts as "activating" it (complete-
  // reenrollment/mass-complete-reenrollment, which turns it into 'pending'
  // and runs this same check for real at that point).
  if (applicant.approval_status === 'incomplete') return null;
  const candidates = db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND season_id = ? AND id != ? AND approval_status NOT IN ('draft', 'incomplete')`).all(orgId, applicant.season_id, applicant.id);
  return checkAgainst(applicant, candidates, previousApplicant);
}

// Extracted so recheckAllApplicantDuplicates below can share the exact same
// matching logic against a candidate list it already has in hand, instead
// of re-querying per applicant.
function checkAgainst(applicant, candidates, previousApplicant) {
  const applicantAddress = fullAddress(applicant);
  const previousAddress = previousApplicant ? fullAddress(previousApplicant) : null;
  for (const c of candidates) {
    // Already confirmed the same real person (see mergeApplicants) — a
    // later edit to either one's own fields shouldn't re-flag a pair
    // that's already been resolved as one identity.
    if (applicant.merge_group_id && c.merge_group_id === applicant.merge_group_id) continue;
    const reasonsNow = matchReasons(applicant, applicantAddress, c);
    if (!reasonsNow.length) continue;
    if (previousApplicant) {
      const reasonsBefore = new Set(matchReasons(previousApplicant, previousAddress, c));
      const newReasons = reasonsNow.filter(r => !reasonsBefore.has(r));
      if (!newReasons.length) continue;
      return { matchedId: c.id, reason: newReasons[0] };
    }
    return { matchedId: c.id, reason: reasonsNow[0] };
  }
  return null;
}

// Runs the appropriate check, and if found: flags it, pauses both accounts, returns the flag row.
// If not found: returns null and leaves the record active. excludeIds (shul only,
// see checkShulDuplicate) lets a caller rule out a record known to be the same
// entity on purpose, like carry-forward's own source shul. previousEntity
// (applicant only) is the record's own pre-save state — see
// checkApplicantDuplicate's matching comment — passed by callers that
// re-check on every edit rather than just at first-time creation.
export function detectAndFlag(orgId, entityType, entity, excludeIds = [], previousEntity) {
  const match = entityType === 'shul' ? checkShulDuplicate(orgId, entity, excludeIds) : checkApplicantDuplicate(orgId, entity, previousEntity);
  if (!match) return null;
  // Never stack a second open flag on the same pair — an edit that
  // introduces one newly-matching field on top of an already-open flag
  // (from an earlier, different reason) doesn't need its own separate row;
  // there's already one sitting there for an admin to resolve.
  const existingOpen = db.prepare(`SELECT * FROM duplicate_flags WHERE org_id = ? AND entity_type = ? AND status = 'open'
      AND ((entity_id = ? AND matched_entity_id = ?) OR (entity_id = ? AND matched_entity_id = ?))`)
    .get(orgId, entityType, entity.id, match.matchedId, match.matchedId, entity.id);
  if (existingOpen) return existingOpen;
  const id = uuid();
  db.prepare(`INSERT INTO duplicate_flags (id, org_id, entity_type, entity_id, matched_entity_id, reason, status)
    VALUES (?,?,?,?,?,?,'open')`).run(id, orgId, entityType, entity.id, match.matchedId, match.reason);
  if (entityType === 'shul') db.prepare(`UPDATE shuls SET duplicate_status = 'flagged', duplicate_of_shul_id = ? WHERE id = ?`).run(match.matchedId, entity.id);
  else db.prepare(`UPDATE applicants SET duplicate_status = 'flagged', duplicate_of_applicant_id = ? WHERE id = ?`).run(match.matchedId, entity.id);
  pauseAccountsFor(entityType, entity.id, match.matchedId);
  return db.prepare('SELECT * FROM duplicate_flags WHERE id = ?').get(id);
}

// Called by utils/entityDelete.js's hardDeleteApplicant/hardDeleteShul
// BEFORE the entity's own duplicate_flags rows get deleted (part of that
// same delete cascade) — captures who else was paused because of THIS
// entity, so unpauseIfNoLongerFlagged below can be called AFTER the
// cascade to decide, from what's actually left, whether each of them
// still has a real reason to stay paused. Without this two-step split, a
// deleted applicant's own flag against its duplicate partner just vanishes
// with the row, and the partner was never the one told to check again —
// it stays paused forever, with no open flag left pointing at it for any
// later recheck to even notice.
export function getDuplicatePartnerIds(entityType, entityId) {
  const rows = db.prepare(`SELECT entity_id, matched_entity_id FROM duplicate_flags WHERE entity_type = ? AND status = 'open' AND (entity_id = ? OR matched_entity_id = ?)`).all(entityType, entityId, entityId);
  return [...new Set(rows.map(r => (r.entity_id === entityId ? r.matched_entity_id : r.entity_id)))];
}
export function unpauseIfNoLongerFlagged(entityType, ids) {
  for (const id of ids) {
    const stillFlagged = db.prepare(`SELECT 1 FROM duplicate_flags WHERE status = 'open' AND entity_type = ? AND (entity_id = ? OR matched_entity_id = ?)`).get(entityType, id, id);
    if (stillFlagged) continue;
    if (entityType === 'shul') {
      db.prepare(`UPDATE shuls SET is_paused = 0, duplicate_status = NULL, duplicate_of_shul_id = NULL WHERE id = ?`).run(id);
      db.prepare(`UPDATE users SET is_paused = 0 WHERE shul_id = ?`).run(id);
    } else {
      db.prepare(`UPDATE applicants SET is_paused = 0, duplicate_status = NULL, duplicate_of_applicant_id = NULL WHERE id = ?`).run(id);
    }
  }
}

// Org-wide sweep, run once after the 'incomplete' fix above landed (and
// safe to re-run any time). Two passes:
//  1. Undoes every flag+pause that only exists because of the bug just
//     fixed — an 'incomplete' row was checked as SUBJECT and flagged
//     against a real applicant before it was ever re-enrolled. Only
//     entity_id needs checking: 'incomplete' is excluded from the
//     candidate pool, so it can never appear as matched_entity_id. The
//     matched real applicant is unpaused too, but only if nothing ELSE
//     still has an open flag against it — a genuinely separate duplicate
//     on that same record must stay paused.
//  2. A fresh, no-previousApplicant check (so anything true right now
//     counts, not just what changed since a last save) across every real
//     (non-draft/incomplete), currently-unpaused applicant in the org —
//     catches anything a bug, an import, or a direct DB edit ever let
//     through without ever being checked.
// seasonId narrows pass 2 to one season (duplicate flags are always
// within a season); pass 1 always runs org-wide since a spurious flag from
// this bug could be sitting in any season.
export function recheckAllApplicantDuplicates(orgId, seasonId) {
  const spurious = db.prepare(`
    SELECT f.* FROM duplicate_flags f JOIN applicants a ON a.id = f.entity_id
    WHERE f.org_id = ? AND f.entity_type = 'applicant' AND f.status = 'open' AND a.approval_status = 'incomplete'
  `).all(orgId);
  let cleared = 0;
  for (const f of spurious) {
    db.prepare(`UPDATE duplicate_flags SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?`).run(f.id);
    db.prepare(`UPDATE applicants SET is_paused = 0, duplicate_status = NULL, duplicate_of_applicant_id = NULL WHERE id = ?`).run(f.entity_id);
    const stillFlagged = db.prepare(`SELECT 1 FROM duplicate_flags WHERE status = 'open' AND (entity_id = ? OR matched_entity_id = ?)`).get(f.matched_entity_id, f.matched_entity_id);
    if (!stillFlagged) db.prepare(`UPDATE applicants SET is_paused = 0, duplicate_status = NULL, duplicate_of_applicant_id = NULL WHERE id = ?`).run(f.matched_entity_id);
    cleared++;
  }

  // General safety net, not just the 'incomplete' case above: any applicant
  // still sitting is_paused=1 with no open flag pointing at it at all (most
  // commonly its duplicate partner was hard-deleted before
  // getDuplicatePartnerIds/unpauseIfNoLongerFlagged existed — deleting the
  // OTHER side of a flag removes the flag row itself, which used to leave
  // this side stuck paused forever with nothing left for any recheck to
  // notice) gets unpaused here too. Runs before pass 2 below so a
  // genuinely still-duplicate row gets correctly re-flagged in the same
  // pass instead of staying clear on a technicality.
  const orphanPaused = db.prepare(`SELECT id FROM applicants WHERE org_id = ? AND is_paused = 1
    AND NOT EXISTS (SELECT 1 FROM duplicate_flags f WHERE f.status = 'open' AND f.entity_type = 'applicant' AND (f.entity_id = applicants.id OR f.matched_entity_id = applicants.id))`).all(orgId);
  let unpaused = 0;
  for (const a of orphanPaused) {
    db.prepare(`UPDATE applicants SET is_paused = 0, duplicate_status = NULL, duplicate_of_applicant_id = NULL WHERE id = ?`).run(a.id);
    unpaused++;
  }

  const rows = seasonId
    ? db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND season_id = ? AND approval_status NOT IN ('draft', 'incomplete') AND is_paused = 0`).all(orgId, seasonId)
    : db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND approval_status NOT IN ('draft', 'incomplete') AND is_paused = 0`).all(orgId);
  const bySeasonAndOrg = new Map();
  for (const r of rows) { const k = r.season_id; if (!bySeasonAndOrg.has(k)) bySeasonAndOrg.set(k, db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND season_id = ? AND approval_status NOT IN ('draft', 'incomplete')`).all(orgId, k)); }
  let flagged = 0;
  for (const a of rows) {
    const candidates = bySeasonAndOrg.get(a.season_id).filter(c => c.id !== a.id);
    const match = checkAgainst(a, candidates, null);
    if (!match) continue;
    const existingOpen = db.prepare(`SELECT * FROM duplicate_flags WHERE org_id = ? AND entity_type = 'applicant' AND status = 'open'
      AND ((entity_id = ? AND matched_entity_id = ?) OR (entity_id = ? AND matched_entity_id = ?))`).get(orgId, a.id, match.matchedId, match.matchedId, a.id);
    if (existingOpen) continue;
    const id = uuid();
    db.prepare(`INSERT INTO duplicate_flags (id, org_id, entity_type, entity_id, matched_entity_id, reason, status) VALUES (?,?,?,?,?,?,'open')`).run(id, orgId, 'applicant', a.id, match.matchedId, match.reason);
    db.prepare(`UPDATE applicants SET duplicate_status = 'flagged', duplicate_of_applicant_id = ? WHERE id = ?`).run(match.matchedId, a.id);
    pauseAccountsFor('applicant', a.id, match.matchedId);
    flagged++;
  }
  return { cleared, unpaused, checked: rows.length, flagged };
}

// Which fields count as "a phone number" for the never-bypass-if-matched
// rule below — checked as a set against a set, so a cell on one side
// matching the OTHER side's home phone (not just the same field) still
// counts; only an actual phone-to-phone match blocks bypass, never an
// address/name coincidence.
const PHONE_FIELDS = ['home_phone', 'husband_cell', 'wife_cell'];
function phoneSet(a) { return new Set(PHONE_FIELDS.map(f => norm(a[f])).filter(Boolean)); }
export function applicantsSharePhone(a, b) {
  const setA = phoneSet(a);
  for (const p of phoneSet(b)) if (setA.has(p)) return true;
  return false;
}

// Admin resolves an applicant duplicate flag one of two ways:
//  - bypass: these are actually two different people who happened to share
//    one non-phone detail (address, name, ...) — un-pauses both, leaves
//    both records exactly as they are. Refused outright if the two records
//    share an actual phone number — that's never a coincidence, so bypass
//    isn't offered as an option; mergeApplicants() below is the only path.
//  - shul duplicates (entity_type 'shul') additionally keep the original
//    simple bypass/resolve actions on top of mergeShuls() below — either
//    "these are genuinely two different shuls" (bypass) or "handled some
//    other way, not by merging" (resolve), for the cases where a real merge
//    (moving one shul's applicants onto the other, one surviving record)
//    isn't actually what happened.
// Returns { flag, undoSnapshot } — undoSnapshot is a full pre-resolve
// capture (the flag's own prior status/resolved_by/resolved_at, both
// entities' full rows, and — for shuls — the linked portal users' pause
// state) with a `kind: 'duplicate-resolve'` marker, meant to be passed as
// the `before` value to logAudit so services/audit.js's undoAuditEntry can
// put every touched row back exactly as it was via restoreDuplicateResolve
// below. Rows logged before this snapshot existed carry no such `kind` and
// so simply aren't undoable — the exact prior state was never recorded for
// them (see audit.js's SNAPSHOT_ONLY_ACTIONS handling).
export function resolveFlag(flagId, resolvedByUserId, action) {
  const flag = db.prepare('SELECT * FROM duplicate_flags WHERE id = ?').get(flagId);
  if (!flag) return null;
  if (flag.status !== 'open') throw new Error('This flag was already resolved');
  const table = flag.entity_type === 'applicant' ? 'applicants' : 'shuls';
  const entityA = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(flag.entity_id);
  const entityB = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(flag.matched_entity_id);
  const usersBefore = flag.entity_type === 'shul'
    ? db.prepare(`SELECT id, is_paused FROM users WHERE shul_id IN (?, ?)`).all(flag.entity_id, flag.matched_entity_id)
    : [];
  const undoSnapshot = {
    kind: 'duplicate-resolve',
    entityType: flag.entity_type,
    flagId,
    flagBefore: { status: flag.status, resolved_by: flag.resolved_by, resolved_at: flag.resolved_at },
    entityA, entityB, usersBefore,
  };

  if (flag.entity_type === 'applicant') {
    if (action !== 'bypass') throw new Error('Applicant duplicates can only be bypassed here — resolving one as the same person is done through the merge action instead');
    if (entityA && entityB && applicantsSharePhone(entityA, entityB)) throw new Error('These records share a phone number, so they can\'t be bypassed as different people — resolve this as a merge instead.');
    db.prepare(`UPDATE duplicate_flags SET status = 'bypassed', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?`).run(resolvedByUserId, flagId);
    db.prepare('UPDATE applicants SET is_paused = 0, duplicate_status = ? WHERE id IN (?, ?)').run('bypassed', flag.entity_id, flag.matched_entity_id);
    return { flag: db.prepare('SELECT * FROM duplicate_flags WHERE id = ?').get(flagId), undoSnapshot };
  }
  db.prepare(`UPDATE duplicate_flags SET status = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?`)
    .run(action === 'bypass' ? 'bypassed' : 'resolved', resolvedByUserId, flagId);
  db.prepare('UPDATE shuls SET is_paused = 0, duplicate_status = ? WHERE id IN (?, ?)')
    .run(action === 'bypass' ? 'bypassed' : 'resolved', flag.entity_id, flag.matched_entity_id);
  db.prepare(`UPDATE users SET is_paused = 0 WHERE shul_id IN (?, ?)`).run(flag.entity_id, flag.matched_entity_id);
  return { flag: db.prepare('SELECT * FROM duplicate_flags WHERE id = ?').get(flagId), undoSnapshot };
}

// Restores everything resolveFlag's undoSnapshot captured — the flag back
// to 'open' (or whatever it was), both entities' is_paused/duplicate_status/
// duplicate_of_*_id, and (shuls) the linked portal users' pause state. A
// row that was already deleted since (entityA/entityB null) is skipped
// rather than erroring — nothing left to restore it onto.
export function restoreDuplicateResolve(snap) {
  const { entityType, flagId, flagBefore, entityA, entityB, usersBefore } = snap;
  const table = entityType === 'applicant' ? 'applicants' : 'shuls';
  const pauseCol = entityType === 'applicant' ? 'duplicate_of_applicant_id' : 'duplicate_of_shul_id';
  db.prepare(`UPDATE duplicate_flags SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`)
    .run(flagBefore.status, flagBefore.resolved_by, flagBefore.resolved_at, flagId);
  for (const row of [entityA, entityB]) {
    if (!row) continue;
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(row.id)) continue;
    db.prepare(`UPDATE ${table} SET is_paused = ?, duplicate_status = ?, ${pauseCol} = ? WHERE id = ?`)
      .run(row.is_paused, row.duplicate_status, row[pauseCol], row.id);
  }
  for (const u of usersBefore) {
    db.prepare(`UPDATE users SET is_paused = ? WHERE id = ?`).run(u.is_paused, u.id);
  }
}

// Finds every applicant that's part of the same real-world-person cluster as
// any of `startIds` — a duplicate isn't always just a pair; the same family
// can get submitted by three, four, five different shuls in one season.
// Chains through open flags (a flag A<->B plus a separate flag B<->C
// surfaces A, B, and C together) and through any merge_group_id an id
// already carries (so flagging a new 5th shul's applicant against one
// member of an already-merged group pulls in the whole existing group).
export function getMergeGroupIds(orgId, startIds) {
  const ids = new Set(startIds);
  let grew = true;
  while (grew) {
    grew = false;
    const list = [...ids];
    const placeholders = list.map(() => '?').join(',');
    const groupRows = db.prepare(`SELECT merge_group_id FROM applicants WHERE id IN (${placeholders}) AND merge_group_id IS NOT NULL`).all(...list);
    const groupIds = [...new Set(groupRows.map(r => r.merge_group_id))];
    if (groupIds.length) {
      const gp = groupIds.map(() => '?').join(',');
      for (const m of db.prepare(`SELECT id FROM applicants WHERE merge_group_id IN (${gp})`).all(...groupIds)) {
        if (!ids.has(m.id)) { ids.add(m.id); grew = true; }
      }
    }
    for (const f of db.prepare(`SELECT entity_id, matched_entity_id FROM duplicate_flags
        WHERE org_id = ? AND entity_type='applicant' AND status='open' AND (entity_id IN (${placeholders}) OR matched_entity_id IN (${placeholders}))`)
        .all(orgId, ...list, ...list)) {
      if (!ids.has(f.entity_id)) { ids.add(f.entity_id); grew = true; }
      if (!ids.has(f.matched_entity_id)) { ids.add(f.matched_entity_id); grew = true; }
    }
  }
  return [...ids];
}

// Forced resolution for an applicant duplicate: admin has confirmed these
// really are the same person across however many shuls submitted them.
// `values` is the admin's chosen composite (per-field, mixed and matched
// from whichever member's data is correct) — written onto the primary
// record only; every other member's own row is left completely untouched,
// so each shul still sees exactly what THEY submitted (shul-blind, per
// spec — a shul only ever sees its own applicant, never that the same
// person is enrolled elsewhere). Every member gets merge_group_id set to
// the primary's id (== how a "is this the primary" check works elsewhere),
// duplicate_status='merged', and unpaused. Every open flag connecting two
// members of the resolved group is marked resolved.
//
// Genuinely ONE real `applicants` row survives a merge — one status, one
// card, one disccardpromos account — not N rows quietly sharing an account
// behind the scenes. Every OTHER member's own submitted data (name/contact/
// demographics, exactly as THEIR shul entered it) is snapshotted into
// applicant_submissions before that member's row is hard-deleted (full
// cascade, fully undoable — see utils/entityDelete.js), which is what makes
// shul-blindness survive losing the separate row: that shul's portal keeps
// reading its own snapshot forever, under its own name, never learning
// about the merge or the surviving row's (possibly different-shul's) data.
// Repoints every SMS/email message currently attached to `fromApplicantId`
// onto `toApplicantId` — used when folding a merged-away member into the
// surviving record, so that shul's own communication history shows up
// combined on the one real record's Messages tab instead of disappearing
// into an undo-only delete snapshot. Must run AFTER captureApplicantSnapshot
// (so the snapshot still captures the original related_entity_id for a
// clean undo) and BEFORE hardDeleteApplicant (whose own deletePolymorphicRefs
// becomes a safe no-op afterward — nothing's left under fromApplicantId's id
// for it to find). Returns what moved so the caller can record it in the
// merge's undoSnapshot for restoreRepointedMessages to move back on undo.
function repointApplicantMessages(fromApplicantId, toApplicantId) {
  const moved = [];
  for (const table of ['sms_messages', 'emails_sent']) {
    const ids = db.prepare(`SELECT id FROM ${table} WHERE related_entity_type='applicant' AND related_entity_id=?`).all(fromApplicantId).map(r => r.id);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      db.prepare(`UPDATE ${table} SET related_entity_id = ? WHERE id IN (${ph})`).run(toApplicantId, ...ids);
      moved.push({ table, fromApplicantId, ids });
    }
  }
  return moved;
}
function restoreRepointedMessages(repointed) {
  for (const r of repointed || []) {
    const ph = r.ids.map(() => '?').join(',');
    db.prepare(`UPDATE ${r.table} SET related_entity_id = ? WHERE id IN (${ph})`).run(r.fromApplicantId, ...r.ids);
  }
}

export function mergeApplicants(orgId, userId, { primaryId, values, memberIds } = {}) {
  if (!primaryId) throw new Error('primaryId is required');
  const fullGroupIds = getMergeGroupIds(orgId, [primaryId]);
  // memberIds lets an admin merge only PART of a larger connected group in
  // this pass (see the compare view's per-member Dismiss button — a group
  // can be 3, 4, 5+ records once duplicate flags chain together, and not
  // every pair in it is necessarily the same person just because they're
  // all transitively connected to each other). Whatever's left out stays
  // exactly as it is — still an open duplicate flag, unmerged — so it can
  // be resolved separately later instead of being forced into one merge.
  // Falls back to the full transitive group when omitted, same as before.
  const groupIds = Array.isArray(memberIds) && memberIds.length
    ? [...new Set(memberIds.filter(id => fullGroupIds.includes(id)).concat(primaryId))]
    : fullGroupIds;
  const placeholders = groupIds.map(() => '?').join(',');
  const members = db.prepare(`SELECT * FROM applicants WHERE id IN (${placeholders}) AND org_id = ?`).all(...groupIds, orgId);
  if (members.length < 2) throw new Error('Need at least two related records to merge');
  const primary = members.find(m => m.id === primaryId);
  if (!primary) throw new Error('Primary record not found in this group');
  // A soft-rejected record (see routes/applicants.js's POST /:id/soft-reject)
  // has no shul by definition — that's what the status means. Picking one as
  // primary would "resolve" the flag into a record nobody can actually act
  // on, silently losing whatever shul was trying to re-enroll this person.
  // The correct resolution for that case is the other direction: pick the
  // ACTIVE record (the one with a real shul) as primary, which naturally
  // folds the old soft-rejected identity into it below — the frontend's
  // merge view disables picking a soft-rejected member as primary for
  // exactly this reason, this is just the backend backstop.
  if (!primary.shul_id) throw new Error('This record has no shul — pick the other record as Primary instead.');

  // Full pre-merge capture — every member's complete row, plus the exact
  // prior state of every flag this merge is about to resolve — so undo can
  // put back not just the pause/merge-group bookkeeping but the composite
  // values written onto the primary and any provider_account_id linking
  // reconcileAccountsForGroup below does. See restoreDuplicateMergeApplicants.
  const membersBefore = members.map(m => ({ ...m }));
  const flagsBeforeRows = db.prepare(`SELECT * FROM duplicate_flags WHERE org_id = ? AND entity_type='applicant' AND status='open'
      AND entity_id IN (${placeholders}) AND matched_entity_id IN (${placeholders})`).all(orgId, ...groupIds, ...groupIds);
  const undoSnapshot = {
    kind: 'duplicate-merge-applicant', primaryId, membersBefore,
    flagsBefore: flagsBeforeRows.map(f => ({ id: f.id, status: f.status, resolved_by: f.resolved_by, resolved_at: f.resolved_at })),
  };

  const sets = Object.keys(values || {}).filter(k => MERGE_FIELDS.includes(k));
  const setSql = sets.length ? `, ${sets.map(k => `${k} = ?`).join(', ')}` : '';
  db.prepare(`UPDATE applicants SET merge_group_id = ?, duplicate_status = 'merged', is_paused = 0, updated_at = datetime('now')${setSql} WHERE id = ?`)
    .run(primaryId, ...sets.map(k => values[k]), primaryId);
  for (const m of members) {
    if (m.id === primaryId) continue;
    // A losing member that was soft-rejected is now permanently subsumed
    // into the primary (not just "orphaned and recoverable" anymore, which
    // is what 'soft_rejected' means) — 'rejected' is the correct terminal
    // state for it, and keeps it out of the Soft Reject filter/queue going
    // forward. Every other loser keeps whatever status it already had, same
    // as before.
    const loserStatus = m.approval_status === 'soft_rejected' ? `, approval_status = 'rejected'` : '';
    db.prepare(`UPDATE applicants SET merge_group_id = ?, duplicate_status = 'merged', is_paused = 0, updated_at = datetime('now')${loserStatus} WHERE id = ?`).run(primaryId, m.id);
  }
  const flagIds = flagsBeforeRows.map(f => f.id);
  if (flagIds.length) {
    const fp = flagIds.map(() => '?').join(',');
    db.prepare(`UPDATE duplicate_flags SET status='resolved', resolved_by=?, resolved_at=datetime('now') WHERE id IN (${fp})`).run(userId, ...flagIds);
  }
  // A member that already carries its own disccardpromos account (from
  // before it was ever recognized as a duplicate) is never touched here —
  // see reconcileAccountsForGroup below for why that's deliberate. Runs
  // while every member row still exists, so it can find and adopt a loser's
  // already-real account onto the primary before those rows are folded away
  // below.
  const accountConflicts = reconcileAccountsForGroup(primaryId);

  // Snapshot every member's ORIGINAL submitted data (membersBefore, captured
  // before any of the updates above ran) into applicant_submissions — one
  // row per shul, including the primary's own shul, so "who submitted this"
  // survives independent of whose data won as the composite. A member with
  // no shul_id (a soft-rejected loser) has nothing for its own shul to read
  // back later, so it's skipped here — it's still fully preserved in that
  // member's own hard-delete snapshot below for undo.
  const submissionIds = [];
  // A member being folded away now might itself already be a PRIOR merge's
  // survivor (a chained pairwise merge — see applicants.html's pairwise
  // compare flow), already holding applicant_submissions rows from that
  // earlier step. Those have to move with it onto the new primary instead
  // of being orphaned when this member's own row is deleted below —
  // captured here (before the repoint) so undo can move them back.
  const repointedSubmissions = [];
  for (const m of membersBefore) {
    if (m.id === primaryId) continue;
    const existing = db.prepare('SELECT id FROM applicant_submissions WHERE applicant_id = ?').all(m.id).map(r => r.id);
    if (existing.length) {
      repointedSubmissions.push({ fromApplicantId: m.id, ids: existing });
      const ph = existing.map(() => '?').join(',');
      db.prepare(`UPDATE applicant_submissions SET applicant_id = ? WHERE id IN (${ph})`).run(primaryId, ...existing);
    }
  }
  for (const m of membersBefore) {
    if (!m.shul_id) continue; // no shul to attribute a submission to (soft-rejected loser)
    // Already has a submission under the surviving record for this exact
    // shul — either the primary's own prior submission from an earlier
    // merge step, or one the repoint above just moved here for this same
    // shul_id. Either way, inserting again would duplicate it.
    if (db.prepare('SELECT 1 FROM applicant_submissions WHERE applicant_id = ? AND shul_id = ?').get(primaryId, m.shul_id)) continue;
    const subId = uuid();
    db.prepare(`INSERT INTO applicant_submissions (id, org_id, applicant_id, shul_id, is_primary,
        first_name, last_name, marital_status, home_phone, husband_cell, wife_cell, email,
        address, city, state, zip, preferred_contact_method, preferred_number,
        num_children, home_for_yomtov, comments, approval_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(subId, orgId, primaryId, m.shul_id, m.id === primaryId ? 1 : 0,
        m.first_name, m.last_name, m.marital_status, m.home_phone, m.husband_cell, m.wife_cell, m.email,
        m.address, m.city, m.state, m.zip, m.preferred_contact_method, m.preferred_number,
        m.num_children, m.home_for_yomtov, m.comments, m.approval_status);
    submissionIds.push(subId);
  }
  // Exactly one submission counts as "primary" per applicant — whichever
  // shul_id the surviving row currently carries. Recomputed fresh each
  // merge step rather than trusted from the loop above, since a chained
  // merge can change which shul that is without touching every row.
  db.prepare('UPDATE applicant_submissions SET is_primary = 0 WHERE applicant_id = ?').run(primaryId);
  db.prepare(`UPDATE applicant_submissions SET is_primary = 1 WHERE applicant_id = ? AND shul_id = (SELECT shul_id FROM applicants WHERE id = ?)`).run(primaryId, primaryId);

  // Fold every non-primary member away for real — full cascade capture
  // (cards, notes, documents, messages, flags — see captureApplicantSnapshot)
  // so undo can bring the exact row back, then hard-delete it. Its own shul
  // keeps seeing it via the applicant_submissions row just written above,
  // read through primaryId from here on. Its SMS/email history is moved
  // onto the surviving record first (see repointApplicantMessages) so the
  // one real record's Messages tab shows the combined history instead of
  // that shul's own conversations vanishing into an undo-only snapshot.
  const deletedApplicantSnapshots = [];
  const repointedMessages = [];
  for (const m of membersBefore) {
    if (m.id === primaryId) continue;
    const liveRow = db.prepare('SELECT * FROM applicants WHERE id = ?').get(m.id);
    if (!liveRow) continue; // already gone somehow — nothing left to fold away
    deletedApplicantSnapshots.push(captureApplicantSnapshot(liveRow));
    repointedMessages.push(...repointApplicantMessages(m.id, primaryId));
    hardDeleteApplicant(liveRow);
  }

  undoSnapshot.submissionIds = submissionIds;
  undoSnapshot.repointedSubmissions = repointedSubmissions;
  undoSnapshot.repointedMessages = repointedMessages;
  undoSnapshot.deletedApplicantSnapshots = deletedApplicantSnapshots;

  return { primaryId, memberIds: groupIds, accountConflicts, undoSnapshot };
}

// Restores everything mergeApplicants' undoSnapshot captured: every
// non-primary member's row (hard-deleted by the merge — see
// deletedApplicantSnapshots) is fully recreated FIRST via
// restoreApplicantSnapshot, so the field-level restore below has a row to
// update again; then every member's full row (merge_group_id,
// duplicate_status, is_paused, the composite values written onto the
// primary, any provider_account_id reconcileAccountsForGroup linked, the
// soft_rejected->rejected flip) goes back to its exact pre-merge value, and
// every flag the merge resolved back to open. Finally, this merge's own
// applicant_submissions rows are removed, and any it repointed from a
// chained prior merge move back to where they came from.
export function restoreDuplicateMergeApplicants(snap) {
  for (const s of snap.deletedApplicantSnapshots || []) restoreApplicantSnapshot(s);
  for (const row of snap.membersBefore) {
    if (!db.prepare('SELECT 1 FROM applicants WHERE id = ?').get(row.id)) continue;
    const keys = Object.keys(row).filter(k => k !== 'id');
    db.prepare(`UPDATE applicants SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => row[k]), row.id);
  }
  for (const f of snap.flagsBefore) {
    db.prepare(`UPDATE duplicate_flags SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`).run(f.status, f.resolved_by, f.resolved_at, f.id);
  }
  for (const r of snap.repointedSubmissions || []) {
    const ph = r.ids.map(() => '?').join(',');
    db.prepare(`UPDATE applicant_submissions SET applicant_id = ? WHERE id IN (${ph})`).run(r.fromApplicantId, ...r.ids);
  }
  restoreRepointedMessages(snap.repointedMessages);
  if (snap.submissionIds?.length) {
    const ph = snap.submissionIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM applicant_submissions WHERE id IN (${ph})`).run(...snap.submissionIds);
  }
}

// A merged secondary is only ever supposed to hold the SAME disccardpromos
// account as its primary (see routes/applicants.js's isMergedSecondary —
// approval time links it that way going forward). But mergeApplicants above
// never touches provider_account_id on merge itself, so two cases fall
// through the cracks:
//  1. A group merged before an account existed on either side, or where a
//     secondary just never got re-approved/re-edited since — its row sits
//     at provider_account_id=NULL forever even though the primary already
//     has a real account. Safe to just copy the primary's id onto it: it
//     was never a real distinct disccardpromos customer.
//  2. A secondary that was independently approved (got its OWN real
//     disccardpromos account) BEFORE being recognized as a duplicate of
//     someone else. Overwriting that in our DB wouldn't touch the real
//     account sitting on disccardpromos' side — it'd just stop us from ever
//     seeing it again, silently orphaning whatever's on it (possibly
//     already-loaded funds). That's an admin decision (deactivate/merge the
//     real accounts on disccardpromos, then re-run), not something to do
//     silently — returned as a conflict instead of applied.
// Runs on every merge (folded into mergeApplicants) and is also reusable
// standalone for a one-time sweep across every merge group that already
// existed before this reconciliation was added (see routes/applicants.js's
// POST /reconcile-merged-accounts) — same function, same safety rule,
// either way it gets invoked.
// The account "holder" is the primary when it has one, otherwise whichever
// member does — a live audit found 16 approved secondaries stuck with no
// account forever because their primary (the losing shul's copy) was never
// approved, so nothing ever created the group's account. The rule is now
// simply "a merged group shares ONE account; whoever was approved first
// created it; everyone else links to it" — see routes/applicants.js's
// ensureProviderAccount for the creating half.
export function reconcileAccountsForGroup(primaryId) {
  const members = db.prepare('SELECT id, first_name, last_name, provider_account_id FROM applicants WHERE merge_group_id = ? OR id = ?').all(primaryId, primaryId);
  const primary = members.find(m => m.id === primaryId);
  const holder = primary?.provider_account_id ? primary : members.find(m => m.provider_account_id);
  if (!holder) return [];
  const conflicts = [];
  for (const m of members) {
    if (m.id === holder.id) continue;
    if (!m.provider_account_id) {
      db.prepare('UPDATE applicants SET provider_account_id = ? WHERE id = ?').run(holder.provider_account_id, m.id);
    } else if (m.provider_account_id !== holder.provider_account_id) {
      conflicts.push({
        primaryId: holder.id, primaryName: `${holder.first_name} ${holder.last_name}`.trim(), primaryAccountId: holder.provider_account_id,
        secondaryId: m.id, secondaryName: `${m.first_name} ${m.last_name}`.trim(), secondaryAccountId: m.provider_account_id,
      });
    }
  }
  return conflicts;
}

// One-time (or re-runnable) sweep for every merge group in an org — see
// reconcileAccountsForGroup's comment for what this does per group and why
// a conflict is reported rather than silently overwritten. seasonId narrows
// to one season; omit it to sweep every season the org has ever had (old
// merges predating this reconciliation could be sitting in a past season).
export function reconcileAllMergedAccounts(orgId, seasonId) {
  const rows = seasonId
    ? db.prepare(`SELECT DISTINCT merge_group_id FROM applicants WHERE org_id = ? AND season_id = ? AND merge_group_id IS NOT NULL`).all(orgId, seasonId)
    : db.prepare(`SELECT DISTINCT merge_group_id FROM applicants WHERE org_id = ? AND merge_group_id IS NOT NULL`).all(orgId);
  let linked = 0, groupsChecked = 0;
  const conflicts = [];
  for (const { merge_group_id } of rows) {
    const primary = db.prepare('SELECT id, provider_account_id FROM applicants WHERE id = ? AND org_id = ?').get(merge_group_id, orgId);
    if (!primary) continue;
    groupsChecked++;
    const nulls = () => db.prepare('SELECT COUNT(*) c FROM applicants WHERE merge_group_id = ? AND provider_account_id IS NULL').get(merge_group_id).c;
    const before = nulls();
    conflicts.push(...reconcileAccountsForGroup(merge_group_id));
    linked += before - nulls();
  }
  return { groupsChecked, linked, conflicts };
}

// One-time (safely re-runnable) migration for every merge group that
// predates applicant_submissions existing at all: collapses each into a
// genuinely single applicants row, the exact same way a fresh
// mergeApplicants call does from here on — snapshot every member's own
// submitted data (including the primary's own shul) into
// applicant_submissions, then hard-delete every non-primary row (full
// cascade capture first, so it's fully undoable). Returns one
// mergeApplicants-shaped undoSnapshot per group actually collapsed, so the
// caller can log each as its own audit_log row — undoable independently
// from Recent Actions, same as any other merge. A group that already has
// applicant_submissions rows (already collapsed by an earlier run of this,
// or merged fresh after this shipped) is skipped, not reprocessed.
export function collapseAllMergedApplicantGroups(orgId) {
  const groupRows = db.prepare(`SELECT DISTINCT merge_group_id FROM applicants WHERE org_id = ? AND merge_group_id IS NOT NULL`).all(orgId);
  const collapsed = [];
  for (const { merge_group_id: primaryId } of groupRows) {
    const primary = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(primaryId, orgId);
    if (!primary) continue; // primary itself already gone somehow
    const membersBefore = db.prepare('SELECT * FROM applicants WHERE merge_group_id = ? AND org_id = ?').all(primaryId, orgId);
    if (membersBefore.length < 2) continue; // nothing left to collapse
    if (db.prepare('SELECT 1 FROM applicant_submissions WHERE applicant_id = ?').get(primaryId)) continue; // already collapsed

    const submissionIds = [];
    for (const m of membersBefore) {
      if (!m.shul_id) continue; // no shul to attribute a submission to (soft-rejected loser)
      const subId = uuid();
      db.prepare(`INSERT INTO applicant_submissions (id, org_id, applicant_id, shul_id, is_primary,
          first_name, last_name, marital_status, home_phone, husband_cell, wife_cell, email,
          address, city, state, zip, preferred_contact_method, preferred_number,
          num_children, home_for_yomtov, comments, approval_status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(subId, orgId, primaryId, m.shul_id, m.id === primaryId ? 1 : 0,
          m.first_name, m.last_name, m.marital_status, m.home_phone, m.husband_cell, m.wife_cell, m.email,
          m.address, m.city, m.state, m.zip, m.preferred_contact_method, m.preferred_number,
          m.num_children, m.home_for_yomtov, m.comments, m.approval_status);
      submissionIds.push(subId);
    }
    db.prepare('UPDATE applicant_submissions SET is_primary = 0 WHERE applicant_id = ?').run(primaryId);
    db.prepare(`UPDATE applicant_submissions SET is_primary = 1 WHERE applicant_id = ? AND shul_id = (SELECT shul_id FROM applicants WHERE id = ?)`).run(primaryId, primaryId);

    const deletedApplicantSnapshots = [];
    const repointedMessages = [];
    for (const m of membersBefore) {
      if (m.id === primaryId) continue;
      deletedApplicantSnapshots.push(captureApplicantSnapshot(m));
      repointedMessages.push(...repointApplicantMessages(m.id, primaryId));
      hardDeleteApplicant(m);
    }
    collapsed.push({
      primaryId,
      memberIds: membersBefore.map(m => m.id),
      undoSnapshot: { kind: 'duplicate-merge-applicant', primaryId, membersBefore, flagsBefore: [], submissionIds, repointedSubmissions: [], repointedMessages, deletedApplicantSnapshots },
    });
  }
  return collapsed;
}

// Same idea as getMergeGroupIds above, but for shuls: chains through open
// shul flags AND through duplicate_of_shul_id (shuls have no dedicated
// merge_group_id column — this reuses the same field a flag already sets,
// since after a merge it means the same thing: "this record's real,
// surviving self is that other one"), so re-flagging a shul against one
// already-merged member pulls the whole existing group back in.
export function getShulMergeGroupIds(orgId, startIds) {
  const ids = new Set(startIds);
  let grew = true;
  while (grew) {
    grew = false;
    const list = [...ids];
    const placeholders = list.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT duplicate_of_shul_id FROM shuls WHERE id IN (${placeholders}) AND duplicate_of_shul_id IS NOT NULL`).all(...list)) {
      if (!ids.has(r.duplicate_of_shul_id)) { ids.add(r.duplicate_of_shul_id); grew = true; }
    }
    const list2 = [...ids];
    const placeholders2 = list2.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT id FROM shuls WHERE duplicate_of_shul_id IN (${placeholders2})`).all(...list2)) {
      if (!ids.has(r.id)) { ids.add(r.id); grew = true; }
    }
    for (const f of db.prepare(`SELECT entity_id, matched_entity_id FROM duplicate_flags
        WHERE org_id = ? AND entity_type='shul' AND status='open' AND (entity_id IN (${placeholders}) OR matched_entity_id IN (${placeholders}))`)
        .all(orgId, ...list, ...list)) {
      if (!ids.has(f.entity_id)) { ids.add(f.entity_id); grew = true; }
      if (!ids.has(f.matched_entity_id)) { ids.add(f.matched_entity_id); grew = true; }
    }
  }
  return [...ids];
}

// Forced resolution for a shul duplicate: admin has confirmed two (or more,
// chained) shul records are really the same real-world shul. `primaryId`
// picks which record survives going forward; `values` is the admin's
// per-field composite (mixed and matched from whichever member's data is
// correct), written onto the primary only. Every other member's own
// applicants — the ones actually in the primary's season, since an
// applicant can never be reassigned across seasons (see applicants.js
// PUT /:id's identical rule) — are moved onto the primary so nothing
// submitted under the duplicate is orphaned; the duplicate row itself is
// left in place (never deleted) as a historical record, marked
// duplicate_status='merged' and pointed at the primary via
// duplicate_of_shul_id, unpaused along with its portal login.
// `memberIds` mirrors mergeApplicants' same-named param (see the compare
// view's per-member Dismiss button) — a chained group can have a member
// that isn't actually the same shul as the rest, and leaving it off
// memberIds keeps it, and its flag(s) against the merged members, exactly
// as they were: still open, still flagged. Falls back to the full
// transitive group when omitted.
export function mergeShuls(orgId, userId, { primaryId, values, memberIds } = {}) {
  if (!primaryId) throw new Error('primaryId is required');
  const fullGroupIds = getShulMergeGroupIds(orgId, [primaryId]);
  const groupIds = Array.isArray(memberIds) && memberIds.length
    ? [...new Set(memberIds.filter(id => fullGroupIds.includes(id)).concat(primaryId))]
    : fullGroupIds;
  const placeholders = groupIds.map(() => '?').join(',');
  const members = db.prepare(`SELECT * FROM shuls WHERE id IN (${placeholders}) AND org_id = ?`).all(...groupIds, orgId);
  if (members.length < 2) throw new Error('Need at least two related records to merge');
  const primary = members.find(m => m.id === primaryId);
  if (!primary) throw new Error('Primary record not found in this group');

  // Full pre-merge capture, same idea as mergeApplicants above: every
  // member's complete row, every user's pause state, every flag this merge
  // is about to resolve, AND (unlike applicants) exactly which applicants
  // are about to have their shul_id reassigned — captured BEFORE the
  // reassignment below so undo can put each one back on its original shul.
  const membersBefore = members.map(m => ({ ...m }));
  const usersBefore = db.prepare(`SELECT id, is_paused FROM users WHERE shul_id IN (${placeholders})`).all(...groupIds);
  const flagsBeforeRows = db.prepare(`SELECT * FROM duplicate_flags WHERE org_id = ? AND entity_type='shul' AND status='open'
      AND entity_id IN (${placeholders}) AND matched_entity_id IN (${placeholders})`).all(orgId, ...groupIds, ...groupIds);
  const applicantReassignments = [];
  for (const m of members) {
    if (m.id === primaryId) continue;
    for (const a of db.prepare(`SELECT id, shul_id FROM applicants WHERE shul_id = ? AND season_id = ?`).all(m.id, primary.season_id)) {
      applicantReassignments.push(a);
    }
  }
  const undoSnapshot = {
    kind: 'duplicate-merge-shul', primaryId, membersBefore, usersBefore, applicantReassignments,
    flagsBefore: flagsBeforeRows.map(f => ({ id: f.id, status: f.status, resolved_by: f.resolved_by, resolved_at: f.resolved_at })),
  };

  let applicantsReassigned = 0;
  for (const m of members) {
    if (m.id === primaryId) continue;
    const result = db.prepare(`UPDATE applicants SET shul_id = ?, updated_at = datetime('now') WHERE shul_id = ? AND season_id = ?`)
      .run(primaryId, m.id, primary.season_id);
    applicantsReassigned += result.changes;
    db.prepare(`UPDATE shuls SET duplicate_of_shul_id = ?, duplicate_status = 'merged', is_paused = 0, updated_at = datetime('now') WHERE id = ?`).run(primaryId, m.id);
    db.prepare(`UPDATE users SET is_paused = 0 WHERE shul_id = ?`).run(m.id);
  }
  const sets = Object.keys(values || {}).filter(k => SHUL_MERGE_FIELDS.includes(k));
  const setSql = sets.length ? `, ${sets.map(k => `${k} = ?`).join(', ')}` : '';
  db.prepare(`UPDATE shuls SET duplicate_status = 'merged', is_paused = 0, updated_at = datetime('now')${setSql} WHERE id = ?`)
    .run(...sets.map(k => values[k]), primaryId);
  db.prepare(`UPDATE users SET is_paused = 0 WHERE shul_id = ?`).run(primaryId);

  const flagIds = flagsBeforeRows.map(f => f.id);
  if (flagIds.length) {
    const fp = flagIds.map(() => '?').join(',');
    db.prepare(`UPDATE duplicate_flags SET status='resolved', resolved_by=?, resolved_at=datetime('now') WHERE id IN (${fp})`).run(userId, ...flagIds);
  }
  return { primaryId, memberIds: groupIds, applicantsReassigned, undoSnapshot };
}

// Restores everything mergeShuls' undoSnapshot captured: every member's
// full row, every reassigned applicant back onto its original shul, every
// linked user's pause state, and every flag the merge resolved back to
// open. Same "skip what's been deleted since, don't recreate it" rule as
// restoreDuplicateMergeApplicants.
export function restoreDuplicateMergeShuls(snap) {
  for (const row of snap.membersBefore) {
    if (!db.prepare('SELECT 1 FROM shuls WHERE id = ?').get(row.id)) continue;
    const keys = Object.keys(row).filter(k => k !== 'id');
    db.prepare(`UPDATE shuls SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => row[k]), row.id);
  }
  for (const a of snap.applicantReassignments) {
    if (!db.prepare('SELECT 1 FROM applicants WHERE id = ?').get(a.id)) continue;
    db.prepare(`UPDATE applicants SET shul_id = ? WHERE id = ?`).run(a.shul_id, a.id);
  }
  for (const u of snap.usersBefore) {
    db.prepare(`UPDATE users SET is_paused = ? WHERE id = ?`).run(u.is_paused, u.id);
  }
  for (const f of snap.flagsBefore) {
    db.prepare(`UPDATE duplicate_flags SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`).run(f.status, f.resolved_by, f.resolved_at, f.id);
  }
}
