import { Router } from 'express';
import multer from 'multer';
import { db, uuid, DEFAULT_ORG_ID } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { requirePermission, redact } from '../middleware/permissions.js';
import { detectAndFlag, resolveFlag, getMergeGroupIds, mergeApplicants, applicantsSharePhone, reconcileAccountsForGroup, reconcileAllMergedAccounts, recheckAllApplicantDuplicates, collapseAllMergedApplicantGroups } from '../services/duplicates.js';
import { sendMailChecked, renderSystemTemplate, escapeHtml } from '../services/mail.js';
import { sendSmsChecked } from '../services/sms.js';
import * as giftcard from '../services/giftcard.js';
import { parseSpreadsheet, buildXlsxTemplate, APPLICANT_IMPORT_COLUMNS } from '../services/importer.js';
import { sendXlsx } from '../services/xlsx.js';
import { normalizePhone, isValidPhone } from '../utils/phone.js';
import { generateApplicantExternalId } from '../utils/externalId.js';
import { getOrCreateEzrasHabayisShul } from '../utils/ezrasHabayis.js';
import { getActiveSeasonId } from '../utils/formSchedule.js';
import { validateBySchema, validateRowsBySchema, shulInfoErrors, getEffectiveSchema } from '../utils/formValidation.js';
import { logAudit, logMassAudit, getEntityHistory } from '../services/audit.js';
import { hardDeleteApplicant, captureApplicantSnapshot } from '../utils/entityDelete.js';
import { lockApplicantCards } from '../services/cardSync.js';
import { registerProviderEnforceRunner, scheduleProviderEnforceSoon } from '../services/providerEnforce.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Coerces a home_for_yomtov value to a real 0/1 — it arrives as a real
// checkbox boolean from the shul-portal's own "Add Applicant" form, but as
// the schema-driven Yes/No select's string '0'/'1' from every other
// submission path (apply.html, apply-store.html, complete-reenrollment, the
// shul-portal edit form). A plain `v ? 1 : 0` treats the string "0" as
// truthy, silently saving every "No" answer as "Yes".
function yomtovBit(v) { return v === '0' || v === 0 || !v ? 0 : 1; }

const EDITABLE_FIELDS = ['first_name','last_name','marital_status','home_phone','husband_cell','wife_cell','email',
  'address','city','state','zip','preferred_contact_method','preferred_number','num_children','home_for_yomtov','comments','card_amount','provider_exempt',
  'shul_contribution_amount','shul_contribution_confirmed'];

// Which applicant fields Settings > Organization > Gift Card Loading lets an
// admin choose to push to disccardpromos — external_id and the shul's group
// name are always included regardless (they're how a customer gets matched
// and organized at all, not "applicant info" in the sense being toggled).
// Default (no setting saved yet) is everything, matching the original
// always-push-it-all behavior so existing orgs see no change until someone
// deliberately narrows it.
export const PROVIDER_PUSH_FIELDS = ['first_name', 'last_name', 'home_phone', 'husband_cell', 'wife_cell', 'email', 'address', 'city', 'state', 'zip'];

function getProviderPushFields(orgId) {
  const row = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'disccardpromos_push_fields'`).get(orgId);
  if (!row) return PROVIDER_PUSH_FIELDS;
  try {
    const saved = JSON.parse(row.value);
    return Array.isArray(saved) ? saved.filter(f => PROVIDER_PUSH_FIELDS.includes(f)) : PROVIDER_PUSH_FIELDS;
  } catch { return PROVIDER_PUSH_FIELDS; }
}

// Builds the opts object giftcard.js's create/updateCustomer expect, limited
// to whichever fields are configured to push. husband_cell/wife_cell map to
// disccardpromos' cell/phone2 slots respectively — sending both, not just
// whichever one happens to be set, was itself a bug (only one ever reached
// disccardpromos before).
function buildProviderOpts(orgId, applicant, groupName) {
  const allowed = getProviderPushFields(orgId);
  const opts = { externalId: applicant.external_id, groupName };
  if (allowed.includes('first_name')) opts.firstName = applicant.first_name;
  if (allowed.includes('last_name')) opts.lastName = applicant.last_name;
  if (allowed.includes('home_phone')) opts.homePhone = applicant.home_phone;
  if (allowed.includes('husband_cell')) opts.cell = applicant.husband_cell;
  if (allowed.includes('wife_cell')) opts.phone2 = applicant.wife_cell;
  if (allowed.includes('email')) opts.email = applicant.email;
  if (allowed.includes('address')) opts.address = applicant.address;
  if (allowed.includes('city')) opts.city = applicant.city;
  if (allowed.includes('state')) opts.state = applicant.state;
  if (allowed.includes('zip')) opts.zip = applicant.zip;
  return opts;
}

// Only meaningful for an approved applicant — everyone else is null (no
// disccardpromos account is ever expected for a pending/rejected/draft/
// incomplete row). 'synced' means the approve routes' best-effort push
// (see upsertAccountForApproval below) actually succeeded and stuck.
// 'exempt' is deliberate (the one-time-backfill provider_exempt flag —
// see POST /import's initialStatus comment). A $0 card_amount does NOT
// belong in this list as its own reason: both approve routes always
// attempt upsertAccountForApproval as long as shul_id is set and the
// applicant isn't exempt, regardless of amount — amount only gates the
// separate addFunds call further down (a $0 applicant still gets a real
// disccardpromos customer record, just with nothing loaded onto it). So
// anything left over here — approved, not exempt, still no account — is
// the genuine gap: a disccardpromos API error at approval time (or a
// merged-secondary whose primary never got approved either) that nothing
// retried afterward.
// 'deactivated' means: no longer approved, but still carries a real
// provider_account_id from when it WAS approved — reject/set-pending/
// soft-reject/hard-delete all call cardSync.js's lockApplicantCards to
// deactivate that account on disccardpromos, but that call is best-effort
// (never blocks the status change) and its failure has historically been
// easy to miss — see POST /retry-deactivation below, which exists
// specifically because a bulk check turned up far more of these than
// disccardpromos itself showed as actually inactive.
function providerSyncStatus(a) {
  if (a.approval_status !== 'approved') return a.provider_account_id ? 'deactivated' : null;
  if (a.provider_account_id) return 'synced';
  if (a.provider_exempt) return 'exempt';
  return 'missing';
}

// True if this applicant was merged into another shul's record as the same
// real person (see services/duplicates.js's mergeApplicants) — merge_group_id
// is set to the PRIMARY member's own id on every member of a merged group,
// so a secondary is any row where that id differs from its own.
function isMergedSecondary(applicant) {
  return !!applicant.merge_group_id && applicant.merge_group_id !== applicant.id;
}

// Same trailing-".0" strip giftcard.js applies on every read (see its
// normalizeCustomerId) — db.js now rewrites stored ids too, but anything
// that compares/dedupes ids still goes through this so a fresh corruption
// can never split one account into two.
const cleanProviderId = id => String(id).replace(/\.0$/, '');

// A merged-duplicate group shares ONE disccardpromos account: whichever
// member is approved first creates it, every other member links to it.
// (It used to be "only the primary ever creates it", which left an approved
// secondary with no account forever whenever the primary — often the
// losing shul's copy — was never approved at all. A live audit found 16
// applicants in exactly that state.) Best-effort like every other provider
// write at approval: returns { accountId, created, linked, error } and
// never throws.
async function ensureProviderAccount(orgId, applicant) {
  if (!applicant.shul_id || applicant.provider_exempt) return { skipped: true };
  if (!applicant.provider_account_id && applicant.merge_group_id) {
    reconcileAccountsForGroup(applicant.merge_group_id);
    const shared = db.prepare('SELECT provider_account_id FROM applicants WHERE id = ?').get(applicant.id)?.provider_account_id;
    if (shared) {
      // Linked to the group's existing customer — make sure it's active
      // again in case a reject on another member locked it since.
      try { await giftcard.reactivateCustomer(applicant.season_id, shared, applicant.external_id); }
      catch (e) { return { accountId: shared, linked: true, error: `linked to the shared account ${shared}, but re-activating it failed — ${e.message}` }; }
      return { accountId: shared, linked: true };
    }
  }
  const shul = db.prepare('SELECT name_en FROM shuls WHERE id = ?').get(applicant.shul_id);
  const opts = buildProviderOpts(orgId, applicant, shul?.name_en || 'Unknown');
  if (applicant.provider_account_id) {
    // Already holds an account — refresh it BY ID, never by an external_id
    // lookup: a shared customer carries whichever member's external_id
    // created it, so looking this member's up would 404 and create a
    // duplicate (and a customer whose external_id got wiped — see
    // giftcard.js — would too, which is how earlier duplicates happened).
    // A shared customer only gets re-activated, not overwritten with this
    // member's copy of the name/contact details.
    try {
      const current = await giftcard.getCustomerById(applicant.season_id, applicant.provider_account_id);
      const shared = db.prepare('SELECT 1 FROM applicants WHERE provider_account_id = ? AND id != ?').get(applicant.provider_account_id, applicant.id);
      if (shared) await giftcard.reactivateCustomer(applicant.season_id, applicant.provider_account_id, current?.external_id || applicant.external_id);
      else await giftcard.updateCustomer(applicant.season_id, applicant.provider_account_id, { ...opts, isActive: true, externalId: current?.external_id || applicant.external_id });
      return { accountId: cleanProviderId(applicant.provider_account_id), created: false, linked: !!shared };
    } catch (e) {
      // 404 = the stored id is stale (deleted on their side) — fall through
      // and create a fresh one. Anything else is a real failure.
      if (e.status !== 404) return { accountId: applicant.provider_account_id, error: e.message };
    }
  }
  try {
    const result = await giftcard.upsertAccountForApproval(applicant.season_id, opts);
    if (!result.accountId) { scheduleProviderEnforceSoon(orgId, `no account id for applicant ${applicant.id}`); return { error: 'disccardpromos returned no account id' }; }
    db.prepare('UPDATE applicants SET provider_account_id = ? WHERE id = ?').run(result.accountId, applicant.id);
    // Every other member of the group without an account links to this one
    // (a member that already holds a DIFFERENT real account is left alone —
    // reconcileAccountsForGroup reports those as conflicts, never clobbers).
    db.prepare(`UPDATE applicants SET provider_account_id = ? WHERE merge_group_id = ? AND id != ? AND provider_account_id IS NULL`).run(result.accountId, applicant.merge_group_id || applicant.id, applicant.id);
    return { accountId: result.accountId, created: !!result.created };
  } catch (e) {
    // Best-effort at approval time, but the enforcer re-runs shortly and
    // finishes the job — an approved applicant never stays without an
    // account just because disccardpromos hiccupped once.
    scheduleProviderEnforceSoon(orgId, `account write failed for applicant ${applicant.id}`);
    return { error: e.message };
  }
}

// Season setting "require_shul_contribution": before an applicant can be
// approved/carded, the shul must have confirmed how much they personally
// gave the family, and that amount must meet the effective minimum bar
// (an admin-only per-applicant override, falling back to the shul's
// admin-only default, falling back to no minimum at all). Returns an
// admin-facing error string (safe to include the real minimum — only admins
// ever see /approve responses) or null if the applicant clears the gate.
function shulContributionError(applicant) {
  if (!applicant.shul_contribution_confirmed) {
    return 'The shul has not yet reported and confirmed how much they personally gave this family — cannot approve until they do.';
  }
  const shul = applicant.shul_id ? db.prepare('SELECT min_contribution_default FROM shuls WHERE id = ?').get(applicant.shul_id) : null;
  const effectiveMin = applicant.min_contribution_override ?? shul?.min_contribution_default ?? 0;
  const reported = applicant.shul_contribution_amount ?? 0;
  if (effectiveMin > 0 && reported < effectiveMin) {
    return `The shul-reported contribution ($${reported.toFixed(2)}) is below the required minimum of $${effectiveMin.toFixed(2)} for this applicant.`;
  }
  return null;
}

// ============================= PUBLIC ==============================
// Ezras Habayis applicants self-apply directly (no shul in between), so
// this mirrors the shul/store public /apply forms: no auth, and the shul_id
// is never taken from the client — every submission auto-attaches to this
// season's locked system shul (see utils/ezrasHabayis.js).
router.post('/apply-ezras-habayis', (req, res) => {
  const orgId = req.body.org_id || DEFAULT_ORG_ID;
  const b = req.body || {};
  if (b.home_phone !== undefined) b.home_phone = normalizePhone(b.home_phone);
  if (b.husband_cell !== undefined) b.husband_cell = normalizePhone(b.husband_cell);
  if (b.wife_cell !== undefined) b.wife_cell = normalizePhone(b.wife_cell);
  // Fixed question set (see utils/builtinSchemas.js) — no longer driven by
  // an editable Form Builder row.
  const errors = validateBySchema(getEffectiveSchema('applicant_application'), b, { isAdmin: false });
  if (errors.length) return res.status(400).json({ error: errors[0] });
  if (!b.first_name || !b.last_name) return res.status(400).json({ error: 'First and last name are required' });

  const shul = getOrCreateEzrasHabayisShul(orgId, getActiveSeasonId(orgId));
  const capError = seasonCapacityError(shul.season_id);
  if (capError) return res.status(400).json({ error: capError });

  const id = uuid();
  const initialStatus = isZipAllowed(orgId, b.zip) ? 'pending' : 'rejected';
  db.prepare(`INSERT INTO applicants (id, org_id, shul_id, season_id, external_id, first_name, last_name, marital_status, home_phone, husband_cell, wife_cell, email,
      address, city, state, zip, preferred_contact_method, preferred_number, num_children, home_for_yomtov, comments, source, approval_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, 'public_form', ?)`)
    .run(id, orgId, shul.id, shul.season_id, generateApplicantExternalId(db), b.first_name, b.last_name, b.marital_status || '', b.home_phone || '', b.husband_cell || '', b.wife_cell || '', b.email || '',
      b.address || '', b.city || '', b.state || '', b.zip || '', b.preferred_contact_method || '', b.preferred_number || '', +b.num_children || 0, yomtovBit(b.home_for_yomtov), b.comments || '', initialStatus);
  const created = db.prepare('SELECT * FROM applicants WHERE id = ?').get(id);
  detectAndFlag(orgId, 'applicant', created);
  res.status(201).json({ ok: true, message: 'Application received. You will be contacted if any additional information is needed.' });
});

router.use(auth, requirePermission('applicants'));

// Returns an error string if the given season has a max-accepted-applicants
// cap set and has already hit it — used to lock out new submissions once a
// season is full — or null if there's no cap or room remains.
function seasonCapacityError(seasonId) {
  if (!seasonId) return null;
  const season = db.prepare('SELECT max_accepted_applicants FROM seasons WHERE id = ?').get(seasonId);
  if (!season || season.max_accepted_applicants == null) return null;
  const accepted = db.prepare(`SELECT COUNT(*) c FROM applicants WHERE season_id = ? AND approval_status = 'approved'`).get(seasonId).c;
  if (accepted >= season.max_accepted_applicants) return 'This season has reached its maximum number of accepted applicants and is no longer accepting new applications.';
  return null;
}

// Shuls must never learn that one of their applicants was rejected or
// flagged as a possible duplicate — from their side it should just look
// like a normal pending/approved application. Applies to both the zip-code
// auto-rejection below and any other rejection reason.
function maskForShul(records, role, orgId) {
  if (role !== 'shul') return records;
  // Card amount visibility is an admin-configurable toggle (Settings >
  // Organization > Shul Portal) — defaults to visible, same as before the
  // toggle existed, unless explicitly turned off.
  const cardVisible = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'shul_card_amount_visible'`).get(orgId)?.value !== '0';
  // Cache season lookups across a whole list-page mask pass rather than
  // re-querying per row.
  const seasonReqCache = new Map();
  const requiresContribution = (seasonId) => {
    if (!seasonId) return false;
    if (!seasonReqCache.has(seasonId)) {
      seasonReqCache.set(seasonId, !!db.prepare('SELECT require_shul_contribution FROM seasons WHERE id = ?').get(seasonId)?.require_shul_contribution);
    }
    return seasonReqCache.get(seasonId);
  };
  const mask = (r) => {
    const rec = { ...r, duplicate_status: null, duplicate_of_applicant_id: null, is_paused: 0 };
    if (!cardVisible) delete rec.card_amount;
    // Internal-only, not a configurable hidden field — a shul should never
    // even know this column exists, same boundary as applicant_notes.
    delete rec.permanent_comments;
    // The actual minimum bar is admin-only (per-applicant override) — a shul
    // only ever learns whether it must report/confirm an amount at all,
    // never the number it's being checked against.
    delete rec.min_contribution_override;
    rec.requiresShulContribution = requiresContribution(r.season_id);
    return rec;
  };
  return Array.isArray(records) ? records.map(mask) : mask(records);
}

// A plain 5-digit (or 5+4) US zip loses its leading zero the moment it
// passes through a spreadsheet cell formatted as a number ("07030" becomes
// 7030) — very common for the Northeast zips this platform mostly deals
// with. Without this, that applicant's zip ("7030") would never match the
// admin's Allowed Zip Codes list ("07030"), silently auto-rejecting a
// perfectly in-area applicant. Only touches clean numeric/zip+4 strings —
// anything else (a non-US postal code, stray text) is compared as-is, same
// as before.
function normalizeZip(z) {
  const s = String(z || '').trim();
  if (!s || !/^\d+(-\d+)?$/.test(s)) return s;
  return s.split('-')[0].padStart(5, '0');
}

// If the org has restricted accepted zips (Settings > Organization >
// Allowed Zip Codes), an applicant outside that list is auto-rejected
// silently at submission time — the submission still appears to succeed
// normally so the submitting shul is never told why (or that) it happened.
export function isZipAllowed(orgId, zip) {
  const setting = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'allowed_zip_codes'`).get(orgId);
  if (!setting || !setting.value.trim()) return true;
  const allowed = setting.value.split(',').map(z => normalizeZip(z)).filter(Boolean);
  if (!allowed.length) return true;
  return allowed.includes(normalizeZip(zip));
}

// Shul-portal users only ever see/act on their own shul's applicants; regardless
// of any assignment rows, force shul_id = req.user.shul_id for that role.
// A shul viewing an applicant merged into another shul's real record (see
// applicant_submissions / services/duplicates.js's mergeApplicants) must
// see exactly what IT submitted — never the surviving row's own values
// (which might be a different shul's data entirely, per whatever the
// admin's merge chose as the composite), and never any hint that this
// person is enrolled anywhere else. Overlays each such row's identity/
// contact/demographic fields with that shul's own submission snapshot in
// place, and flags it _merged_readonly so the frontend never offers to
// edit or remove it — there's no shul_id link on the real row for this
// shul to act on. A no-op for any row this shul is the actual shul_id
// owner of (the normal, non-merged case).
const SUBMISSION_OVERLAY_FIELDS = ['first_name', 'last_name', 'marital_status', 'home_phone', 'husband_cell',
  'wife_cell', 'email', 'address', 'city', 'state', 'zip', 'preferred_contact_method', 'preferred_number',
  'num_children', 'home_for_yomtov', 'comments'];
function applySubmissionOverlay(rows, shulId) {
  const list = Array.isArray(rows) ? rows : [rows];
  const needOverlay = list.filter(r => r && r.shul_id !== shulId);
  if (!needOverlay.length) return;
  const ids = needOverlay.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const subs = db.prepare(`SELECT * FROM applicant_submissions WHERE shul_id = ? AND applicant_id IN (${placeholders})`).all(shulId, ...ids);
  const byId = new Map(subs.map(s => [s.applicant_id, s]));
  for (const r of needOverlay) {
    const s = byId.get(r.id);
    if (!s) continue;
    for (const f of SUBMISSION_OVERLAY_FIELDS) r[f] = s[f];
    r._merged_readonly = true;
  }
}

function scopeWhere(req) {
  let where = 'WHERE a.org_id = ?';
  const params = [req.user.org_id];
  // A shul sees its own applicants (a.shul_id) PLUS any applicant merged
  // into another shul's real record where this shul is one of the
  // contributing submissions (see applicant_submissions / mergeApplicants)
  // — its own row was folded away, but it still needs to see the merged
  // record (with its own submitted data overlaid on top — see
  // applySubmissionOverlay below) rather than the applicant just vanishing
  // from its list.
  if (req.user.role === 'shul') {
    where += ' AND (a.shul_id = ? OR a.id IN (SELECT applicant_id FROM applicant_submissions WHERE shul_id = ?))';
    params.push(req.user.shul_id, req.user.shul_id);
  }
  else if (req.permission.scope === 'assigned') {
    where += ` AND a.shul_id IN (SELECT entity_id FROM user_assignments WHERE user_id = ? AND entity_type = 'shul')`;
    params.push(req.user.id);
  }
  return { where, params };
}

router.get('/', (req, res) => {
  const { search, status, shul_id, season_id, home_for_yomtov, marital_status, paused, provider_sync, provider_check, amount_min, amount_max, sort = 'created_at', dir = 'DESC', page = 1, pageSize = 50 } = req.query;
  let { where, params } = scopeWhere(req);
  if (status) { where += ' AND a.approval_status = ?'; params.push(status); }
  if (paused === '1' || paused === '0') { where += ' AND a.is_paused = ?'; params.push(+paused); }
  if (shul_id) { where += ' AND a.shul_id = ?'; params.push(shul_id); }
  if (season_id) { where += ' AND a.season_id = ?'; params.push(season_id); }
  if (marital_status) { where += ' AND a.marital_status = ?'; params.push(marital_status); }
  if (home_for_yomtov !== undefined && home_for_yomtov !== '') { where += ' AND a.home_for_yomtov = ?'; params.push(home_for_yomtov === 'true' || home_for_yomtov === '1' ? 1 : 0); }
  if (amount_min !== undefined && amount_min !== '') { where += ' AND a.card_amount >= ?'; params.push(+amount_min); }
  if (amount_max !== undefined && amount_max !== '') { where += ' AND a.card_amount <= ?'; params.push(+amount_max); }
  // Only 'missing' is offered as a real filter — the actual, unexplained
  // gap between "approved" and "has a disccardpromos account" (see
  // providerSyncStatus above): approved, not deliberately exempt, and
  // still has no provider_account_id. Not conditioned on card_amount — a
  // $0 applicant still gets a real account (see providerSyncStatus).
  if (provider_sync === 'missing') {
    where += ` AND a.approval_status = 'approved' AND a.provider_exempt = 0 AND a.provider_account_id IS NULL`;
  } else if (provider_sync === 'deactivated') {
    where += ` AND a.approval_status != 'approved' AND a.provider_account_id IS NOT NULL`;
  }
  // What disccardpromos itself said about this row's account the last time
  // the provider audit ran (see runProviderAudit below) — not_found / mock
  // / inactive / active / relinked / error / missing / cleared.
  if (provider_check) { where += ' AND a.provider_check_status = ?'; params.push(provider_check); }
  if (search) {
    where += ` AND (a.first_name LIKE ? OR a.last_name LIKE ? OR a.email LIKE ? OR a.home_phone LIKE ? OR a.husband_cell LIKE ? OR a.wife_cell LIKE ? OR a.external_id LIKE ?
      OR a.address LIKE ? OR a.city LIKE ? OR a.state LIKE ? OR a.zip LIKE ? OR a.comments LIKE ? OR a.permanent_comments LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like, like, like, like, like, like, like, like);
  }
  const allowedSort = ['created_at','last_name','approval_status','num_children','card_amount','external_id'];
  const sortCol = allowedSort.includes(sort) ? `a.${sort}` : 'a.created_at';
  const sortDir = dir === 'ASC' ? 'ASC' : 'DESC';
  const total = db.prepare(`SELECT COUNT(*) c FROM applicants a ${where}`).get(...params).c;
  const offset = (Math.max(1, +page) - 1) * +pageSize;
  const rows = db.prepare(`SELECT a.*, s.name_en as shul_name, ps.name_en as previous_shul_name FROM applicants a LEFT JOIN shuls s ON s.id = a.shul_id LEFT JOIN shuls ps ON ps.id = a.previous_shul_id ${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`).all(...params, +pageSize, offset);
  for (const r of rows) r.provider_sync = providerSyncStatus(r);
  if (req.user.role === 'shul') applySubmissionOverlay(rows, req.user.shul_id);
  // Every contributing shul for a merged record (see applicant_submissions)
  // — admin-only, so the list can show "ShulA, ShulB, ShulC" instead of the
  // one shul_name the surviving row happens to carry. Only rows with more
  // than one contributor get anything here; a never-merged applicant's own
  // shul_name column already covers it.
  if (req.user.role !== 'shul' && rows.length) {
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const subs = db.prepare(`SELECT s.applicant_id, s.is_primary, sh.name_en FROM applicant_submissions s JOIN shuls sh ON sh.id = s.shul_id
      WHERE s.applicant_id IN (${placeholders}) ORDER BY s.is_primary DESC, sh.name_en`).all(...ids);
    if (subs.length) {
      const byId = new Map();
      for (const s of subs) { if (!byId.has(s.applicant_id)) byId.set(s.applicant_id, []); byId.get(s.applicant_id).push(s.name_en); }
      for (const r of rows) { const names = byId.get(r.id); if (names && names.length > 1) r.contributing_shuls = names; }
    }
  }
  res.json({ applicants: maskForShul(redact(rows, req.permission.hidden_fields), req.user.role, req.user.org_id), total, page: +page, pageSize: +pageSize });
});

// Full-detail CSV export — every field, no pagination, respects the same
// filters as the list view. Must be registered before /:id.
router.get('/export', requirePermission('applicants', 'can_export'), (req, res) => {
  const { search, status, shul_id, season_id, home_for_yomtov, marital_status, paused, amount_min, amount_max } = req.query;
  let { where, params } = scopeWhere(req);
  if (status) { where += ' AND a.approval_status = ?'; params.push(status); }
  if (paused === '1' || paused === '0') { where += ' AND a.is_paused = ?'; params.push(+paused); }
  if (shul_id) { where += ' AND a.shul_id = ?'; params.push(shul_id); }
  if (season_id) { where += ' AND a.season_id = ?'; params.push(season_id); }
  if (marital_status) { where += ' AND a.marital_status = ?'; params.push(marital_status); }
  if (home_for_yomtov !== undefined && home_for_yomtov !== '') { where += ' AND a.home_for_yomtov = ?'; params.push(home_for_yomtov === 'true' || home_for_yomtov === '1' ? 1 : 0); }
  if (amount_min !== undefined && amount_min !== '') { where += ' AND a.card_amount >= ?'; params.push(+amount_min); }
  if (amount_max !== undefined && amount_max !== '') { where += ' AND a.card_amount <= ?'; params.push(+amount_max); }
  if (search) {
    where += ` AND (a.first_name LIKE ? OR a.last_name LIKE ? OR a.email LIKE ? OR a.home_phone LIKE ? OR a.husband_cell LIKE ? OR a.wife_cell LIKE ? OR a.external_id LIKE ?
      OR a.address LIKE ? OR a.city LIKE ? OR a.state LIKE ? OR a.zip LIKE ? OR a.comments LIKE ? OR a.permanent_comments LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like, like, like, like, like, like, like, like);
  }
  const rows = db.prepare(`SELECT a.*, s.name_en as shul_name FROM applicants a LEFT JOIN shuls s ON s.id = a.shul_id ${where} ORDER BY a.created_at DESC`).all(...params);
  sendXlsx(res, `applicants-${Date.now()}.xlsx`, redact(rows, req.permission.hidden_fields));
});

// Answers "594 approved but only 567 in disccardpromos" — the counts
// behind providerSyncStatus above, for whichever season is asked about
// (defaults to the org's active one). 'missing' is the only bucket that
// actually needs attention; 'exempt' is an expected, deliberate reason an
// approved applicant never gets an account there. A $0 card amount is
// NOT its own bucket — see providerSyncStatus's comment for why. Admin-
// only (requireAdmin below) — this is an org-wide reconciliation view,
// not something a shul/store portal login has any use for.
router.get('/provider-sync-summary', requireAdmin, (req, res) => {
  const seasonId = req.query.season_id || getActiveSeasonId(req.user.org_id);
  const rows = db.prepare(`SELECT provider_account_id, provider_exempt FROM applicants WHERE org_id = ? AND season_id = ? AND approval_status = 'approved'`)
    .all(req.user.org_id, seasonId);
  let synced = 0, exempt = 0, missing = 0;
  const accountIds = new Set();
  for (const r of rows) {
    if (r.provider_account_id) { synced++; accountIds.add(cleanProviderId(r.provider_account_id)); }
    else if (r.provider_exempt) exempt++;
    else missing++;
  }
  // A rejected/soft-rejected/pending-reverted applicant that was APPROVED at
  // some point already had a real disccardpromos account created — reject
  // and set-pending both call lockApplicantCards, which deactivates that
  // customer (is_active=false) but never deletes it (real money may already
  // be loaded on it — see cardSync.js's lockApplicantCards comment). That
  // account keeps existing, and keeps counting toward disccardpromos' own
  // total customer count, forever — it just no longer shows up above since
  // this only counts CURRENTLY-approved rows. Without this, the diagnostic
  // could never fully reconcile against disccardpromos' real total: every
  // one of these is a real account that's genuinely just not "approved" by
  // us anymore, not an error anywhere.
  const deactivatedRows = db.prepare(`SELECT provider_account_id FROM applicants WHERE org_id = ? AND season_id = ? AND approval_status != 'approved' AND provider_account_id IS NOT NULL`)
    .all(req.user.org_id, seasonId);
  const deactivatedAccountIds = new Set(deactivatedRows.map(r => cleanProviderId(r.provider_account_id)).filter(id => !accountIds.has(id)));
  // synced counts applicant ROWS with an account — a merged-duplicate group
  // shares one real disccardpromos account across every member (see
  // isMergedSecondary), so synced can legitimately run higher than the
  // actual number of accounts disccardpromos shows. distinctAccounts is the
  // number that should match their side; a gap between the two here means
  // some merged group still has a member pointing at a stale/different
  // account than its primary — see POST /reconcile-merged-accounts.
  res.json({
    seasonId, approved: rows.length, synced, exempt, missing, distinctAccounts: accountIds.size,
    deactivated: deactivatedAccountIds.size,
    totalAccountsEverCreated: accountIds.size + deactivatedAccountIds.size,
  });
});

// One-time (re-runnable) fix for merge groups that predate
// reconcileAccountsForGroup being folded into mergeApplicants/approve — see
// that function's comment in services/duplicates.js. Copies a primary's
// disccardpromos account onto any secondary still sitting at NULL; a
// secondary that already carries its OWN different real account is left
// untouched and reported back instead, since that needs an admin to decide
// (deactivate/merge the real accounts on disccardpromos, then re-run this)
// rather than silently losing track of it. seasonId optional — omitted
// sweeps every season the org has, since a stale merge could be sitting in
// an old one.
router.post('/reconcile-merged-accounts', requireAdmin, (req, res) => {
  const result = reconcileAllMergedAccounts(req.user.org_id, req.body?.season_id || null);
  logAudit(req.user.org_id, req.user.id, 'mass-reconcile-accounts', 'applicant', null, null, {
    count: result.linked, groupsChecked: result.groupsChecked, conflicts: result.conflicts.length,
    conflictDetails: result.conflicts.map(c => `${c.secondaryName}: has its own account (${c.secondaryAccountId}) — primary ${c.primaryName} uses ${c.primaryAccountId}`),
  }, req.ip);
  res.json(result);
});

// One-time (safely re-runnable) migration: collapses every merge group that
// predates applicant_submissions into a genuinely single applicants row —
// see collapseAllMergedApplicantGroups. Each group collapsed gets its own
// 'merge' audit_log row (same undo shape a fresh merge produces), so any
// one of them can be undone independently from Recent Actions if something
// looks wrong, without affecting the others.
router.post('/collapse-merged-groups', requireAdmin, (req, res) => {
  const collapsed = collapseAllMergedApplicantGroups(req.user.org_id);
  for (const c of collapsed) {
    logAudit(req.user.org_id, req.user.id, 'merge', 'applicant', c.primaryId, c.undoSnapshot, { primaryId: c.primaryId, memberIds: c.memberIds }, req.ip);
  }
  res.json({ groupsCollapsed: collapsed.length, primaryIds: collapsed.map(c => c.primaryId) });
});

// Re-attempts the disccardpromos deactivation for every applicant sitting in
// the 'deactivated' bucket (see providerSyncStatus above) — no longer
// approved, but still carrying the real account it got while it was.
// reject/set-pending/soft-reject/hard-delete all call this same
// lockApplicantCards on the way out, but that call is best-effort and never
// blocks the status change, so a failure there has historically been easy
// to miss (surfaced only as a toast at the moment of the original action,
// nothing persisted). Idempotent — a customer already inactive on
// disccardpromos' side just gets the same {isActive:false} PATCH again — so
// safe to run repeatedly. seasonId optional, same all-seasons-by-default
// rule as reconcile-merged-accounts above.
router.post('/retry-deactivation', requireAdmin, async (req, res) => {
  const seasonId = req.body?.season_id || null;
  const rows = seasonId
    ? db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND season_id = ? AND approval_status != 'approved' AND provider_account_id IS NOT NULL`).all(req.user.org_id, seasonId)
    : db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND approval_status != 'approved' AND provider_account_id IS NOT NULL`).all(req.user.org_id);
  let succeeded = 0, failed = 0;
  const failureDetails = [];
  for (const applicant of rows) {
    const { errors } = await lockApplicantCards(req.user.org_id, applicant);
    if (errors?.length) { failed++; failureDetails.push(`${applicant.first_name} ${applicant.last_name}: ${errors.join('; ')}`); }
    else succeeded++;
  }
  logAudit(req.user.org_id, req.user.id, 'mass-retry-deactivation', 'applicant', null, null,
    { count: succeeded, attempted: rows.length, failed, failureDetails }, req.ip);
  res.json({ attempted: rows.length, succeeded, failed, failureDetails });
});

// ---------------------------------------------------------------------------
// Provider audit — ground truth from disccardpromos itself, both directions.
//
// Everything above (provider-sync-summary, reconcile, retry-deactivation)
// reasons purely from what OUR database says, and every one of those
// numbers kept failing to line up with what disccardpromos' own dashboard
// shows. This stops inferring and asks: for every account id we hold, does
// it actually exist on their side, and is it active? And, listing THEIR
// customers, which of those does nothing here point at? That's the only
// way to explain a gap in either direction without guessing:
//  - not_found: we hold an id disccardpromos says doesn't exist (deleted on
//    their dashboard, or never really created) — counted by us, not them.
//  - mock: an id written while the season was still in mock mode (no API
//    key configured yet) — was never real at all.
//  - relinked: an approved applicant we had NO id for, but disccardpromos
//    already has their customer (matched by external_id) — we'd lost the
//    id, not the account. Fixed on the spot, nothing to re-create.
//  - orphans (their side): customers with no applicant here at all —
//    created directly on their dashboard, or belonging to a record that
//    was hard-deleted here before hard-delete learned to lock them.
// Runs as a background job (one per org, single-instance app — same
// assumption as approvalsInFlight) because it's one API call per account;
// the UI polls GET /provider-audit for progress. The final result is also
// saved to settings so it survives a restart, and every applicant row gets
// provider_check_status stamped so the list can filter on it.
// ---------------------------------------------------------------------------
const providerAuditJobs = new Map();
function saveProviderAudit(orgId, seasonId, result) {
  db.prepare(`INSERT INTO settings (org_id, key, value) VALUES (?,?,?) ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value`)
    .run(orgId, `provider_audit_last_${seasonId}`, JSON.stringify(result));
}
function loadProviderAudit(orgId, seasonId) {
  const row = db.prepare('SELECT value FROM settings WHERE org_id = ? AND key = ?').get(orgId, `provider_audit_last_${seasonId}`);
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}
async function runProviderAudit(orgId, seasonId, job) {
  const rows = db.prepare(`SELECT a.*, s.name_en AS shul_name FROM applicants a LEFT JOIN shuls s ON s.id = a.shul_id WHERE a.org_id = ? AND a.season_id = ?`).all(orgId, seasonId);
  const describe = r => `${r.first_name} ${r.last_name}`.trim() + (r.shul_name ? ` (${r.shul_name})` : '');
  const now = new Date().toISOString();
  const setCheck = db.prepare(`UPDATE applicants SET provider_check_status = ?, provider_check_at = ? WHERE id = ?`);

  // Pull disccardpromos' full customer list ONCE up front (their List
  // Customers endpoint) instead of a separate GET per account id we hold
  // plus a separate GET per external_id lookup plus yet another full list
  // pull for orphan detection — every classification below (ours by id,
  // ours by external_id, theirs with nothing pointing at it) reads off this
  // one in-memory pull, so all three sections see the same snapshot instead
  // of three snapshots that could disagree with each other mid-run.
  let list = null, listError = null;
  try { list = await giftcard.listCustomers(seasonId); } catch (e) { listError = e.message; }
  const byId = new Map(), byExt = new Map();
  for (const c of list || []) {
    if (c?.id == null) continue;
    byId.set(cleanProviderId(c.id), c);
    if (c.external_id != null && c.external_id !== '') byExt.set(String(c.external_id), c);
  }

  // 1. Every distinct account id we hold, classified from the list above.
  const byAccount = new Map();
  for (const r of rows) {
    if (!r.provider_account_id) continue;
    const k = cleanProviderId(r.provider_account_id);
    if (!byAccount.has(k)) byAccount.set(k, []);
    byAccount.get(k).push(r);
  }
  const accountIds = [...byAccount.keys()];
  const missingRows = rows.filter(r => !r.provider_account_id && r.approval_status === 'approved' && !r.provider_exempt && !isMergedSecondary(r));
  job.total = accountIds.length + missingRows.length + 1; job.progress = 0;

  const counts = { active: 0, inactive: 0, not_found: 0, mock: 0, error: 0, relinked: 0 };
  const details = { not_found: [], mock: [], error: [], relinked: [] };
  for (const accountId of accountIds) {
    const members = byAccount.get(accountId);
    let status, message = null;
    if (/^mock_/.test(accountId)) status = 'mock';
    else if (listError) { status = 'error'; message = listError; }
    else {
      const c = byId.get(accountId);
      status = c ? (c.is_active === false ? 'inactive' : 'active') : 'not_found';
    }
    counts[status]++;
    for (const m of members) setCheck.run(status, now, m.id);
    if (details[status]) details[status].push({ applicantIds: members.map(m => m.id), accountId, names: members.map(describe).join(' / '), statuses: members.map(m => m.approval_status).join('/'), message });
    job.progress++;
  }

  // 2. Approved applicants we hold NO id for — does disccardpromos already
  //    have them under their external_id (in the list already pulled
  //    above)? If so, we lost the id, not the account: link it back rather
  //    than ever creating a duplicate.
  for (const r of missingRows) {
    if (listError) {
      counts.error++; setCheck.run('error', now, r.id);
      details.error.push({ applicantIds: [r.id], accountId: null, names: describe(r), message: listError });
    } else {
      const found = r.external_id ? byExt.get(String(r.external_id)) : null;
      if (found?.id) {
        const id = cleanProviderId(found.id);
        db.prepare('UPDATE applicants SET provider_account_id = ? WHERE id = ?').run(id, r.id);
        reconcileAccountsForGroup(r.id);
        setCheck.run('relinked', now, r.id);
        counts.relinked++; details.relinked.push({ applicantIds: [r.id], accountId: id, names: describe(r), message: 'found on disccardpromos by external id; id restored here' });
      } else setCheck.run('missing', now, r.id);
    }
    job.progress++;
  }

  // 3. Their full customer list — the reverse direction — reusing the same
  //    `list`/`byId`/`byExt` pulled once at the top of this function.
  let provider = null;
  if (!listError) {
    const ourIds = new Set(db.prepare(`SELECT DISTINCT provider_account_id FROM applicants WHERE org_id = ? AND provider_account_id IS NOT NULL`).all(orgId).map(r => cleanProviderId(r.provider_account_id)));
    const orphans = [];
    let active = 0, inactive = 0;
    for (const c of list) {
      if (c?.id == null) continue;
      const id = cleanProviderId(c.id);
      if (c.is_active === false) inactive++; else active++;
      if (ourIds.has(id)) continue;
      const ext = c.external_id != null && c.external_id !== '' ? String(c.external_id) : null;
      const match = ext ? rows.find(r => r.external_id && String(r.external_id) === ext) : null;
      const current = match ? db.prepare('SELECT provider_account_id FROM applicants WHERE id = ?').get(match.id) : null;
      if (match && !current?.provider_account_id && !isMergedSecondary(match)) {
        db.prepare('UPDATE applicants SET provider_account_id = ? WHERE id = ?').run(id, match.id);
        reconcileAccountsForGroup(match.id);
        setCheck.run('relinked', now, match.id);
        ourIds.add(id);
        counts.relinked++; details.relinked.push({ applicantIds: [match.id], accountId: id, names: describe(match), message: 'matched from disccardpromos customer list by external id; id restored here' });
        continue;
      }
      // Trace where it came from: a record in another season with the same
      // external id (carry-forward reuses it), or one hard-deleted here —
      // the delete snapshot in the audit log still carries the row.
      let origin = null;
      if (ext) {
        const elsewhere = db.prepare(`SELECT a.first_name, a.last_name, a.approval_status, s.name AS season_name FROM applicants a LEFT JOIN seasons s ON s.id = a.season_id WHERE a.org_id = ? AND a.external_id = ? AND a.season_id != ? LIMIT 1`).get(orgId, ext, seasonId);
        if (elsewhere) origin = `same external id as ${elsewhere.first_name} ${elsewhere.last_name} in season "${elsewhere.season_name || '?'}" (${elsewhere.approval_status})`;
        else {
          const deleted = db.prepare(`SELECT before_json, created_at FROM audit_log WHERE org_id = ? AND entity_type = 'applicant' AND action = 'delete' AND before_json LIKE ? ORDER BY created_at DESC LIMIT 1`).get(orgId, `%"external_id":"${ext}"%`);
          if (deleted) {
            try { const rowSnap = JSON.parse(deleted.before_json)?.row; if (rowSnap) origin = `was ${rowSnap.first_name} ${rowSnap.last_name}, permanently deleted here ${deleted.created_at}`; } catch {}
          }
        }
      }
      orphans.push({ accountId: id, name: `${c.first_name || ''} ${c.last_name || ''}`.trim() || '(no name)', externalId: ext, groupName: c.group_name || null, isActive: c.is_active !== false, origin });
    }
    provider = { total: list.length, active, inactive, orphans };
  }
  job.progress++;

  const stillMissing = db.prepare(`SELECT id, first_name, last_name FROM applicants WHERE org_id = ? AND season_id = ? AND approval_status = 'approved' AND provider_exempt = 0 AND provider_account_id IS NULL`).all(orgId, seasonId);
  const result = {
    seasonId, ranAt: now,
    ours: { distinctAccounts: accountIds.length, ...counts, stillMissing: stillMissing.length },
    provider, listError, details,
  };
  saveProviderAudit(orgId, seasonId, result);
  return result;
}

router.post('/provider-audit', requireAdmin, (req, res) => {
  const seasonId = req.body?.season_id || getActiveSeasonId(req.user.org_id);
  if (giftcard.isMockMode(seasonId)) return res.status(400).json({ error: 'This season has no live disccardpromos API configured (mock mode) — there is nothing real to verify against.' });
  const existing = providerAuditJobs.get(req.user.org_id);
  if (existing?.status === 'running') return res.status(409).json({ error: 'A verification is already running — wait for it to finish.' });
  const job = { status: 'running', seasonId, progress: 0, total: 0, startedAt: new Date().toISOString(), result: null, error: null };
  providerAuditJobs.set(req.user.org_id, job);
  const { org_id: orgId, id: userId } = req.user, ip = req.ip;
  runProviderAudit(orgId, seasonId, job)
    .then(result => {
      job.result = result; job.status = 'done';
      logAudit(orgId, userId, 'mass-provider-audit', 'applicant', null, null, {
        count: result.ours.distinctAccounts, active: result.ours.active, inactive: result.ours.inactive, notFound: result.ours.not_found, mock: result.ours.mock,
        relinked: result.ours.relinked, providerErrors: result.ours.error, providerTotal: result.provider?.total ?? null, orphansOnProvider: result.provider?.orphans.length ?? null, listError: result.listError,
      }, ip);
    })
    .catch(e => { job.status = 'error'; job.error = e.message; console.error('[provider-audit] failed:', e); });
  res.json({ started: true });
});

router.get('/provider-audit', requireAdmin, (req, res) => {
  const seasonId = req.query.season_id || getActiveSeasonId(req.user.org_id);
  const job = providerAuditJobs.get(req.user.org_id);
  if (job && job.seasonId === seasonId && job.status !== 'done') return res.json({ status: job.status, progress: job.progress, total: job.total, error: job.error });
  const result = (job?.seasonId === seasonId && job.result) || loadProviderAudit(req.user.org_id, seasonId);
  res.json({ status: result ? 'done' : 'none', result });
});

// ---------------------------------------------------------------------------
// Make disccardpromos match — one idempotent job that ENFORCES the rule
// instead of just reporting against it:
//   every approved, non-exempt applicant with a shul holds exactly one
//   ACTIVE customer there (a merged group shares one); every customer held
//   only by non-approved applicants, or by nobody at all, is INACTIVE.
// Order matters and is deliberate: pull their list once, fix our side
// (link → reactivate → create), then lock what shouldn't be active, then
// re-pull and put their active count next to our approved count so the
// admin sees whether it matched and, if not, exactly which applicants are
// left and why. Nothing is ever deleted on either side. Funds are loaded
// only onto a customer this run CREATED — exactly what approval would have
// done — never onto one that already existed.
// ---------------------------------------------------------------------------
async function runProviderEnforce(orgId, seasonId, job) {
  const now = new Date().toISOString();
  const discountId = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'disccardpromos_discount_id'`).get(orgId)?.value;
  const describe = r => `${r.first_name} ${r.last_name}`.trim() + (r.shul_name ? ` (${r.shul_name})` : '');
  const setCheck = db.prepare(`UPDATE applicants SET provider_check_status = ?, provider_check_at = ? WHERE id = ?`);
  const counts = { alreadyRight: 0, relinked: 0, reactivated: 0, created: 0, fundsLoaded: 0, deactivatedNonApproved: 0, deactivatedOrphans: 0, sharedByMerge: 0, exemptSkipped: 0 };
  const unfixable = [], notes = [];

  const pullList = async () => {
    const list = await giftcard.listCustomers(seasonId);
    const byId = new Map(), byExt = new Map();
    for (const c of list) {
      if (c?.id == null) continue;
      const id = cleanProviderId(c.id);
      c._id = id; byId.set(id, c);
      if (c.external_id != null && c.external_id !== '') byExt.set(String(c.external_id), c);
    }
    return { list, byId, byExt };
  };
  const before = await pullList();
  const { byId, byExt } = before;
  const beforeTally = { total: before.list.length, active: before.list.filter(c => c.is_active !== false).length };
  beforeTally.inactive = beforeTally.total - beforeTally.active;

  const approved = db.prepare(`SELECT a.*, s.name_en AS shul_name FROM applicants a LEFT JOIN shuls s ON s.id = a.shul_id WHERE a.org_id = ? AND a.season_id = ? AND a.approval_status = 'approved'`).all(orgId, seasonId);
  job.total = approved.length + 2; job.progress = 0;

  // 1. Our side: every approved applicant ends up holding an ACTIVE customer.
  const groupOf = a => a.merge_group_id ? db.prepare('SELECT * FROM applicants WHERE merge_group_id = ?').all(a.merge_group_id) : [a];
  const seenAccounts = new Set();
  for (const stale of approved) {
    job.progress++;
    const a = { ...db.prepare('SELECT * FROM applicants WHERE id = ?').get(stale.id), shul_name: stale.shul_name };
    if (a.provider_exempt) { counts.exemptSkipped++; continue; }
    if (!a.shul_id) { unfixable.push({ id: a.id, name: describe(a), reason: 'no shul assigned — nothing to create the account under' }); setCheck.run('missing', now, a.id); continue; }
    const members = groupOf(a);
    let cust = a.provider_account_id ? byId.get(cleanProviderId(a.provider_account_id)) : null;
    if (!cust) for (const m of members) { if (m.provider_account_id && byId.has(cleanProviderId(m.provider_account_id))) { cust = byId.get(cleanProviderId(m.provider_account_id)); break; } }
    if (!cust) for (const ext of [a.external_id, ...members.map(m => m.external_id)].filter(Boolean)) { if (byExt.has(String(ext))) { cust = byExt.get(String(ext)); break; } }
    try {
      if (cust) {
        if (cleanProviderId(a.provider_account_id || '') !== cust._id) {
          db.prepare('UPDATE applicants SET provider_account_id = ? WHERE id = ?').run(cust._id, a.id);
          db.prepare(`UPDATE applicants SET provider_account_id = ? WHERE merge_group_id = ? AND id != ? AND provider_account_id IS NULL`).run(cust._id, a.merge_group_id || a.id, a.id);
          counts.relinked++;
        } else if (cust.is_active !== false) counts.alreadyRight++;
        if (cust.is_active === false) {
          await giftcard.reactivateCustomer(seasonId, cust._id, cust.external_id || a.external_id);
          cust.is_active = true; counts.reactivated++;
        }
        if (seenAccounts.has(cust._id)) counts.sharedByMerge++;
        seenAccounts.add(cust._id);
        setCheck.run('active', now, a.id);
      } else {
        const r = await ensureProviderAccount(orgId, a);
        if (!r.accountId) { unfixable.push({ id: a.id, name: describe(a), reason: r.error || 'disccardpromos returned no account id' }); setCheck.run('error', now, a.id); continue; }
        if (r.error) notes.push(`${describe(a)}: ${r.error}`);
        const id = cleanProviderId(r.accountId);
        const created = { _id: id, id, external_id: a.external_id, is_active: true, first_name: a.first_name, last_name: a.last_name };
        byId.set(id, created); if (a.external_id) byExt.set(String(a.external_id), created);
        if (r.linked || seenAccounts.has(id)) counts.sharedByMerge++;
        else {
          counts.created++;
          const amount = a.card_amount ?? 0;
          if (r.created && amount > 0 && discountId) {
            try { await giftcard.addFunds(seasonId, { customerId: id, externalId: a.external_id, discountId, amount }); counts.fundsLoaded++; }
            catch (e) { notes.push(`${describe(a)}: account created, but loading $${amount} failed — ${e.message}`); }
          } else if (r.created && amount > 0) notes.push(`${describe(a)}: account created, but no disccardpromos Package/Discount ID is configured so $${amount} was not loaded`);
        }
        seenAccounts.add(id);
        setCheck.run('active', now, a.id);
      }
    } catch (e) {
      unfixable.push({ id: a.id, name: describe(a), reason: e.message }); setCheck.run('error', now, a.id);
    }
  }

  // 2. Their side: anything not held by an approved applicant goes inactive.
  const heldByApproved = new Set(db.prepare(`SELECT DISTINCT provider_account_id FROM applicants WHERE org_id = ? AND approval_status = 'approved' AND provider_account_id IS NOT NULL`).all(orgId).map(r => cleanProviderId(r.provider_account_id)));
  const heldByAnyone = new Set(db.prepare(`SELECT DISTINCT provider_account_id FROM applicants WHERE org_id = ? AND provider_account_id IS NOT NULL`).all(orgId).map(r => cleanProviderId(r.provider_account_id)));
  const deactivated = [];
  for (const c of byId.values()) {
    if (c.is_active === false || heldByApproved.has(c._id)) continue;
    const holder = heldByAnyone.has(c._id)
      ? db.prepare(`SELECT first_name, last_name, approval_status, external_id FROM applicants WHERE org_id = ? AND provider_account_id = ? ORDER BY updated_at DESC LIMIT 1`).get(orgId, c._id)
      : null;
    try {
      await giftcard.updateCustomer(seasonId, c._id, { isActive: false, externalId: c.external_id || holder?.external_id || undefined });
      c.is_active = false;
      if (holder) { counts.deactivatedNonApproved++; deactivated.push(`${holder.first_name} ${holder.last_name} (${holder.approval_status}) — customer ${c._id}`); }
      else { counts.deactivatedOrphans++; deactivated.push(`customer ${c._id}${c.external_id ? ` (external id ${c.external_id})` : ''} — held by no applicant here`); }
    } catch (e) { notes.push(`could not deactivate customer ${c._id}: ${e.message}`); }
  }
  job.progress++;

  // 3. Re-pull and put the two numbers side by side.
  let after = null;
  try {
    const re = await pullList();
    after = { total: re.list.length, active: re.list.filter(c => c.is_active !== false).length };
    after.inactive = after.total - after.active;
  } catch (e) { notes.push(`could not re-pull their customer list for the final tally: ${e.message}`); }
  job.progress++;

  const ours = {
    approved: approved.length,
    exempt: counts.exemptSkipped,
    distinctActiveAccounts: heldByApproved.size,
    unfixable: unfixable.length,
  };
  const result = { seasonId, ranAt: now, before: beforeTally, after, ours, counts, unfixable, deactivated, notes,
    matched: !!after && after.active === ours.distinctActiveAccounts };
  db.prepare(`INSERT INTO settings (org_id, key, value) VALUES (?,?,?) ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value`)
    .run(orgId, `provider_enforce_last_${seasonId}`, JSON.stringify(result));
  return result;
}

const providerEnforceJobs = new Map();

// The automatic version — what actually keeps the two systems matched
// without anyone clicking anything. src/index.js runs this once shortly
// after boot (so a deploy heals whatever old drift is sitting there) and
// every 15 minutes after; services/providerEnforce.js also fires it about
// a minute after any single disccardpromos write fails mid-action. Active
// season only — that's where approvals happen; an old season is reachable
// through the manual button with the season filter. Skips silently in
// mock mode or while a run is already in progress, and only writes an
// audit row when it actually changed something (or something's stuck), so
// a quiet 15-minute tick leaves no trace.
export async function enforceProviderForOrg(orgId, trigger = 'scheduled') {
  const seasonId = getActiveSeasonId(orgId);
  if (!seasonId || giftcard.isMockMode(seasonId)) return null;
  const existing = providerEnforceJobs.get(orgId);
  if (existing?.status === 'running') return null;
  const job = { status: 'running', seasonId, progress: 0, total: 0, startedAt: new Date().toISOString(), result: null, error: null, trigger };
  providerEnforceJobs.set(orgId, job);
  try {
    const result = await runProviderEnforce(orgId, seasonId, job);
    job.result = result; job.status = 'done';
    const c = result.counts;
    const changed = c.relinked + c.reactivated + c.created + c.deactivatedNonApproved + c.deactivatedOrphans;
    if (changed || result.unfixable.length || !result.matched) {
      logAudit(orgId, null, 'mass-provider-enforce', 'applicant', null, null, {
        count: result.ours.approved, trigger, matched: result.matched, theirActiveBefore: result.before.active, theirActiveAfter: result.after?.active ?? null,
        ...c, unfixable: result.unfixable.length, failureDetails: result.unfixable.map(u => `${u.name}: ${u.reason}`), notes: result.notes,
      }, null);
    }
    console.log(`[providerEnforce] ${trigger}: ${changed} change(s), ${result.unfixable.length} unfixable, matched=${result.matched}`);
    return result;
  } catch (e) {
    job.status = 'error'; job.error = e.message;
    console.error('[providerEnforce] run failed:', e.message);
    return null;
  }
}
registerProviderEnforceRunner(enforceProviderForOrg);

router.post('/provider-enforce', requireAdmin, (req, res) => {
  const seasonId = req.body?.season_id || getActiveSeasonId(req.user.org_id);
  if (giftcard.isMockMode(seasonId)) return res.status(400).json({ error: 'This season has no live disccardpromos API configured (mock mode) — there is nothing real to match against.' });
  const existing = providerEnforceJobs.get(req.user.org_id);
  if (existing?.status === 'running') return res.status(409).json({ error: 'A match run is already in progress — wait for it to finish.' });
  const job = { status: 'running', seasonId, progress: 0, total: 0, startedAt: new Date().toISOString(), result: null, error: null };
  providerEnforceJobs.set(req.user.org_id, job);
  const { org_id: orgId, id: userId } = req.user, ip = req.ip;
  runProviderEnforce(orgId, seasonId, job)
    .then(result => {
      job.result = result; job.status = 'done';
      logAudit(orgId, userId, 'mass-provider-enforce', 'applicant', null, null, {
        count: result.ours.approved, matched: result.matched, theirActiveBefore: result.before.active, theirActiveAfter: result.after?.active ?? null,
        ...result.counts, unfixable: result.unfixable.length, failureDetails: result.unfixable.map(u => `${u.name}: ${u.reason}`), notes: result.notes,
      }, ip);
    })
    .catch(e => { job.status = 'error'; job.error = e.message; console.error('[provider-enforce] failed:', e); });
  res.json({ started: true });
});
router.get('/provider-enforce', requireAdmin, (req, res) => {
  const seasonId = req.query.season_id || getActiveSeasonId(req.user.org_id);
  const job = providerEnforceJobs.get(req.user.org_id);
  if (job && job.seasonId === seasonId && job.status !== 'done') return res.json({ status: job.status, progress: job.progress, total: job.total, error: job.error });
  const row = db.prepare('SELECT value FROM settings WHERE org_id = ? AND key = ?').get(req.user.org_id, `provider_enforce_last_${seasonId}`);
  let saved = null; try { saved = row ? JSON.parse(row.value) : null; } catch {}
  const result = (job?.seasonId === seasonId && job.result) || saved;
  res.json({ status: result ? 'done' : 'none', result });
});

// Locks a customer that exists on disccardpromos with no applicant here to
// hold it (an orphan from the audit above). Deactivate, never delete —
// same rule as lockApplicantCards: it may already carry real money, and
// deactivating is reversible on their dashboard. Only ever for an id the
// last audit actually reported as an orphan, so this can't be pointed at
// an account some applicant still legitimately holds.
router.post('/provider-audit/deactivate-orphan', requireAdmin, async (req, res) => {
  const seasonId = req.body?.season_id || getActiveSeasonId(req.user.org_id);
  const accountId = req.body?.account_id ? cleanProviderId(req.body.account_id) : null;
  if (!accountId) return res.status(400).json({ error: 'account_id is required' });
  const last = loadProviderAudit(req.user.org_id, seasonId);
  const orphan = last?.provider?.orphans?.find(o => o.accountId === accountId);
  if (!orphan) return res.status(400).json({ error: 'That account was not reported as an orphan by the last verification — run Verify again first.' });
  if (db.prepare('SELECT 1 FROM applicants WHERE org_id = ? AND provider_account_id = ?').get(req.user.org_id, accountId)) {
    return res.status(400).json({ error: 'An applicant here now holds that account — nothing to do.' });
  }
  try {
    await giftcard.updateCustomer(seasonId, accountId, { isActive: false, externalId: orphan.externalId || undefined });
  } catch (e) { return res.status(502).json({ error: e.message }); }
  orphan.isActive = false;
  saveProviderAudit(req.user.org_id, seasonId, last);
  logAudit(req.user.org_id, req.user.id, 'mass-deactivate-orphans', 'applicant', null, null,
    { count: 1, names: [`disccardpromos customer ${accountId}${orphan.externalId ? ` (external id ${orphan.externalId})` : ''}${orphan.origin ? ` — ${orphan.origin}` : ''}`] }, req.ip);
  res.json({ ok: true });
});

// Drops every account id disccardpromos itself said doesn't exist (or that
// was only ever a mock-mode placeholder). Nothing is touched on their side
// — there's nothing there to touch, that's the point. An approved applicant
// cleared here becomes plain 'missing', which POST /retry-provider-sync
// below then re-creates for real.
router.post('/provider-audit/clear-phantoms', requireAdmin, (req, res) => {
  const seasonId = req.body?.season_id || getActiveSeasonId(req.user.org_id);
  const rows = db.prepare(`SELECT id, first_name, last_name, provider_account_id FROM applicants WHERE org_id = ? AND season_id = ? AND provider_check_status IN ('not_found','mock') AND provider_account_id IS NOT NULL`).all(req.user.org_id, seasonId);
  const clear = db.prepare(`UPDATE applicants SET provider_account_id = NULL, provider_check_status = 'cleared' WHERE id = ?`);
  for (const r of rows) clear.run(r.id);
  logMassAudit(req.user.org_id, req.user.id, 'mass-clear-phantom-accounts', 'applicant', rows.map(r => r.id),
    { names: rows.map(r => `${r.first_name} ${r.last_name}`.trim()), previousAccountIds: rows.map(r => r.provider_account_id) }, req.ip);
  res.json({ cleared: rows.length });
});

// Re-runs the approval-time account write for every approved applicant
// still without a disccardpromos account — the retry the approve routes
// never had. Same upsertAccountForApproval as approval (idempotent by
// external_id, so an account that turns out to already exist is linked, not
// duplicated). Funds are loaded ONLY onto a brand-new customer, exactly as
// approval would have: an existing customer we're merely re-linking may
// already carry the money from the original approval, and loading again
// would double it — that case is reported so an admin can check the
// balance instead. Every failure comes back with disccardpromos' actual
// error text per applicant, which is the piece that was always missing
// when "re-approving doesn't do anything" — it did try, it just never said
// why it failed.
router.post('/retry-provider-sync', requireAdmin, async (req, res) => {
  const seasonId = req.body?.season_id || getActiveSeasonId(req.user.org_id);
  const rows = db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND season_id = ? AND approval_status = 'approved' AND provider_exempt = 0 AND provider_account_id IS NULL`).all(req.user.org_id, seasonId);
  const discountId = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'disccardpromos_discount_id'`).get(req.user.org_id)?.value;
  let created = 0, linkedExisting = 0, linkedSecondaries = 0, failed = 0, fundsLoaded = 0;
  const failureDetails = [], notes = [];
  for (const applicant of rows) {
    const name = `${applicant.first_name} ${applicant.last_name}`.trim();
    if (!applicant.shul_id) { failed++; failureDetails.push(`${name}: no shul assigned, so there is no group to create the account under — assign a shul, then run this again`); continue; }
    // A row in this list may already have been linked by an earlier
    // iteration (its group-mate created the account) — re-read before acting.
    const fresh = db.prepare('SELECT * FROM applicants WHERE id = ?').get(applicant.id);
    if (fresh.provider_account_id) { linkedSecondaries++; continue; }
    {
      const result = await ensureProviderAccount(req.user.org_id, fresh);
      if (result.error && !result.accountId) { failed++; failureDetails.push(`${name}: ${result.error}`); continue; }
      if (result.error) notes.push(`${name}: ${result.error}`);
      db.prepare(`UPDATE applicants SET provider_check_status = 'active', provider_check_at = datetime('now') WHERE id = ?`).run(applicant.id);
      if (result.linked) { linkedSecondaries++; continue; }
      if (result.created) {
        created++;
        const amount = applicant.card_amount ?? 0;
        if (amount > 0 && discountId) {
          try { await giftcard.addFunds(seasonId, { customerId: result.accountId, externalId: applicant.external_id, discountId, amount }); fundsLoaded++; }
          catch (e) { failureDetails.push(`${name}: account created, but loading $${amount} failed — ${e.message}`); }
        } else if (amount > 0) notes.push(`${name}: account created, but no disccardpromos Package/Discount ID is configured so $${amount} was not loaded`);
      } else {
        linkedExisting++;
        notes.push(`${name}: an account already existed on disccardpromos and was linked back (not re-created) — funds were NOT re-loaded automatically, check its balance`);
      }
    }
  }
  logAudit(req.user.org_id, req.user.id, 'mass-retry-provider-sync', 'applicant', null, null,
    { count: created + linkedExisting + linkedSecondaries, attempted: rows.length, created, linkedExisting, linkedSecondaries, fundsLoaded, failed, failureDetails, notes }, req.ip);
  res.json({ attempted: rows.length, created, linkedExisting, linkedSecondaries, fundsLoaded, failed, failureDetails, notes });
});

// Shul-portal export: the shul's own pending/approved applicants, in the
// exact same column layout as the upload template (with real `id`s filled
// in) so this sheet can be edited and re-uploaded through the normal
// POST /import unchanged (see #3 — export, edit/fill-in-missing-info,
// re-upload). A shul never gets the general can_export permission (see the
// PORTAL_ALLOWED_RESOURCES note near /export above) — this is a separate,
// narrowly-scoped route instead of opening that up. 'incomplete' (carried-
// over, awaiting re-enrollment) and 'draft' (uploaded but not yet submitted)
// rows are left out — those have their own dedicated flows (complete-
// reenrollment / mass-submit-drafts) with their own required-field rules.
router.get('/my-export', (req, res) => {
  if (req.user.role !== 'shul') return res.status(403).json({ error: 'Not permitted' });
  const rows = db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND shul_id = ? AND approval_status IN ('pending','approved') ORDER BY created_at DESC`)
    .all(req.user.org_id, req.user.shul_id);
  const columns = ['id', ...APPLICANT_IMPORT_COLUMNS.filter(c => c !== 'shul_name')];
  const out = rows.map(r => Object.fromEntries(columns.map(c => {
    if (c === 'id') return [c, r.id];
    if (c === 'home_for_yomtov') return [c, r.home_for_yomtov ? 'Yes' : 'No'];
    return [c, r[c] ?? ''];
  })));
  sendXlsx(res, `my-applicants-${Date.now()}.xlsx`, out, columns);
});

// Reusable rejection-reason text so an admin doesn't retype the same
// explanation every time — mirrors sms_templates/email_templates exactly.
// Must be registered before GET /:id below — a bare single-segment path
// like this one would otherwise match that route's `:id` param first
// (same reasoning as /export and /my-export above).
router.get('/rejection-reason-templates', requireAdmin, (req, res) => {
  res.json({ templates: db.prepare('SELECT * FROM rejection_reason_templates WHERE org_id = ? ORDER BY name').all(req.user.org_id) });
});
router.post('/rejection-reason-templates', requireAdmin, (req, res) => {
  const { name, body } = req.body || {};
  if (!name || !body) return res.status(400).json({ error: 'name and body are required' });
  const id = uuid();
  db.prepare(`INSERT INTO rejection_reason_templates (id, org_id, name, body, created_by) VALUES (?,?,?,?,?)`).run(id, req.user.org_id, name, body, req.user.id);
  res.status(201).json({ template: db.prepare('SELECT * FROM rejection_reason_templates WHERE id = ?').get(id) });
});
router.delete('/rejection-reason-templates/:id', requireAdmin, (req, res) => {
  const tmpl = db.prepare('SELECT * FROM rejection_reason_templates WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!tmpl) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM rejection_reason_templates WHERE id = ?').run(tmpl.id);
  res.json({ ok: true });
});

router.get('/:id', (req, res) => {
  const applicant = db.prepare(`SELECT a.*, s.name_en as shul_name, ps.name_en as previous_shul_name FROM applicants a
      LEFT JOIN shuls s ON s.id=a.shul_id
      LEFT JOIN shuls ps ON ps.id=a.previous_shul_id
      WHERE a.id = ? AND a.org_id = ?`).get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  let ownSubmission = null;
  if (req.user.role === 'shul' && applicant.shul_id !== req.user.shul_id) {
    // Not the real shul_id owner — only reachable at all if this shul is
    // one of the contributing submissions on a merged record (see
    // applicant_submissions). Anyone else still gets the original 403.
    ownSubmission = db.prepare('SELECT * FROM applicant_submissions WHERE applicant_id = ? AND shul_id = ?').get(applicant.id, req.user.shul_id);
    if (!ownSubmission) return res.status(403).json({ error: 'Not your applicant' });
  }
  // Internal admin notes and duplicate flags may reference rejection/duplicate
  // reasons directly, so a shul-portal viewer gets neither, on top of the
  // approval_status/duplicate_status masking below.
  const notes = req.user.role === 'shul' ? [] : db.prepare('SELECT n.*, u.first_name, u.last_name FROM applicant_notes n LEFT JOIN users u ON u.id=n.user_id WHERE applicant_id = ? ORDER BY n.created_at DESC').all(applicant.id);
  const cards = db.prepare('SELECT * FROM cards WHERE applicant_id = ? ORDER BY created_at DESC').all(applicant.id);
  const flags = req.user.role === 'shul' ? [] : db.prepare(`SELECT * FROM duplicate_flags WHERE entity_type='applicant' AND (entity_id=? OR matched_entity_id=?) AND status='open'`).all(applicant.id, applicant.id);
  // Every shul that contributed a submission to this real record (see
  // applicant_submissions / services/duplicates.js's mergeApplicants) —
  // replaces the old merge_group_id chain, which stopped finding anything
  // once a merge started hard-deleting the losing rows instead of just
  // tagging them. Admin-only, per spec: a shul must never learn its
  // applicant is enrolled (or was ever) anywhere else.
  let mergeGroup = [];
  if (req.user.role !== 'shul') {
    mergeGroup = db.prepare(`SELECT s.shul_id AS id, s.first_name, s.last_name, s.approval_status AS own_approval_status, sh.name_en AS shul_name, s.is_primary
        FROM applicant_submissions s JOIN shuls sh ON sh.id = s.shul_id
        WHERE s.applicant_id = ? ORDER BY s.is_primary DESC, sh.name_en`).all(applicant.id);
  }
  if (ownSubmission) {
    for (const f of SUBMISSION_OVERLAY_FIELDS) applicant[f] = ownSubmission[f];
    applicant._merged_readonly = true;
  }
  const requiresShulContribution = !!db.prepare('SELECT require_shul_contribution FROM seasons WHERE id = ?').get(applicant.season_id)?.require_shul_contribution;
  res.json({ applicant: maskForShul(redact(applicant, req.permission.hidden_fields), req.user.role, req.user.org_id), notes, cards, flags, mergeGroup, requiresShulContribution });
});

// Who edited this record and when — a shul viewing their own applicant
// never sees this (same admin-only gate as notes/flags above).
router.get('/:id/history', requireAdmin, (req, res) => {
  const applicant = db.prepare('SELECT id FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  res.json({ history: getEntityHistory(req.user.org_id, 'applicant', applicant.id) });
});

// Admin-only quick-contact: send a one-off SMS/email straight from an
// applicant's detail view, and see the full history of both — not just
// what was sent *about* this applicant (related_entity_type/id) but
// anything ever sent to their phone numbers/email, in case a message went
// out through the general SMS/Email Center compose flow rather than from
// this modal.
router.get('/:id/messages', requireAdmin, (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  const phones = [applicant.home_phone, applicant.husband_cell, applicant.wife_cell].filter(Boolean);
  const phonePlaceholders = phones.length ? phones.map(() => '?').join(',') : "''";
  const sms = db.prepare(`SELECT * FROM sms_messages WHERE org_id = ? AND ((related_entity_type='applicant' AND related_entity_id=?) OR phone IN (${phonePlaceholders})) ORDER BY created_at DESC`)
    .all(req.user.org_id, applicant.id, ...phones);
  const emails = applicant.email
    ? db.prepare(`SELECT * FROM emails_sent WHERE org_id = ? AND ((related_entity_type='applicant' AND related_entity_id=?) OR to_email=?) ORDER BY created_at DESC`).all(req.user.org_id, applicant.id, applicant.email)
    : db.prepare(`SELECT * FROM emails_sent WHERE org_id = ? AND related_entity_type='applicant' AND related_entity_id=? ORDER BY created_at DESC`).all(req.user.org_id, applicant.id);
  res.json({ sms, emails });
});

router.post('/:id/send-sms', requirePermission('applicants', 'can_edit'), async (req, res) => {
  // Admin-only quick-send feature (see loadMessagesTab/app.js) — the
  // shul-portal never calls this, and a shul sending SMS "from the org" to
  // any applicant (not just their own) isn't a capability it should have.
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  const { to, body } = req.body || {};
  const phone = to || applicant.husband_cell || applicant.wife_cell || applicant.home_phone;
  if (!phone) return res.status(400).json({ error: 'No phone number on file for this applicant' });
  if (!body) return res.status(400).json({ error: 'Message body is required' });
  const { emailError } = await sendSmsChecked(req.user.org_id, phone, body, { relatedEntityType: 'applicant', relatedEntityId: applicant.id, sentBy: req.user.id });
  res.json({ ok: !emailError, emailError });
});

router.post('/:id/send-email', requirePermission('applicants', 'can_edit'), async (req, res) => {
  // Admin-only quick-send feature — see the identical note on /send-sms above.
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  const { to, subject, body } = req.body || {};
  const email = to || applicant.email;
  if (!email) return res.status(400).json({ error: 'No email on file for this applicant' });
  if (!subject || !body) return res.status(400).json({ error: 'Subject and body are required' });
  const { emailError } = await sendMailChecked(req.user.org_id, email, subject, body, { relatedEntityType: 'applicant', relatedEntityId: applicant.id, sentBy: req.user.id });
  res.json({ ok: !emailError, emailError });
});

// Same idea as shuls' /other-seasons: each season's applicant is its own
// independent record, so match likely repeat applicants across seasons by
// email (falling back to first+last name) rather than a direct foreign key.
router.get('/:id/other-seasons', requireAdmin, (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  const matches = applicant.email
    ? db.prepare(`SELECT a.id, a.first_name, a.last_name, a.approval_status, a.season_id, se.name AS season_name FROM applicants a LEFT JOIN seasons se ON se.id = a.season_id
        WHERE a.org_id = ? AND a.id != ? AND a.email = ? ORDER BY se.created_at DESC`).all(req.user.org_id, applicant.id, applicant.email)
    : db.prepare(`SELECT a.id, a.first_name, a.last_name, a.approval_status, a.season_id, se.name AS season_name FROM applicants a LEFT JOIN seasons se ON se.id = a.season_id
        WHERE a.org_id = ? AND a.id != ? AND a.first_name = ? AND a.last_name = ? ORDER BY se.created_at DESC`).all(req.user.org_id, applicant.id, applicant.first_name, applicant.last_name);
  res.json({ matches });
});

router.post('/', requirePermission('applicants', 'can_edit'), (req, res) => {
  const b = req.body || {};
  if (b.home_phone !== undefined) b.home_phone = normalizePhone(b.home_phone);
  if (b.husband_cell !== undefined) b.husband_cell = normalizePhone(b.husband_cell);
  if (b.wife_cell !== undefined) b.wife_cell = normalizePhone(b.wife_cell);
  if (!b.first_name || !b.last_name) return res.status(400).json({ error: 'First and last name are required' });
  // Shul-portal users can only ever create applicants under their own shul.
  const shulId = req.user.role === 'shul' ? req.user.shul_id : b.shul_id;
  if (!shulId) return res.status(400).json({ error: 'shul_id is required' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(shulId, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Shul not found' });
  if (shul.is_paused) return res.status(423).json({ error: 'This shul account is paused and cannot submit applicants' });
  // A shul (e.g. one carried forward into a new season — #147) can't submit
  // ANY applicant until its own shul record is complete against the live
  // shul application form. Admin-added applicants skip this — it's a
  // self-service gate on the shul-portal submission path, not a rule about
  // the shul row's state in general.
  if (req.user.role === 'shul') {
    const shulErrors = shulInfoErrors(shul);
    if (shulErrors.length) return res.status(400).json({ error: `Please complete your shul's information before submitting applicants: ${shulErrors.join('; ')}`, code: 'SHUL_INFO_INCOMPLETE' });
  }
  // 'incomplete' (carried-over, not yet re-enrolled) rows don't count as
  // used slots — see the identical check in complete-reenrollment below.
  const used = db.prepare(`SELECT COUNT(*) c FROM applicants WHERE shul_id = ? AND approval_status NOT IN ('rejected','incomplete','draft')`).get(shulId).c;
  if (shul.slots_allocated && used >= shul.slots_allocated) return res.status(400).json({ error: `This shul has used all ${shul.slots_allocated} allocated slot(s) for this season` });
  const capError = seasonCapacityError(shul.season_id);
  if (capError) return res.status(400).json({ error: capError });
  // Same fixed question set (utils/builtinSchemas.js) a shul portal add, an
  // admin add, and the public form all ask. Admins get two levels of
  // leniency: bypass_required skips every required field at once for this
  // one submission (e.g. an incomplete record that needs to exist now and
  // get filled in later); short of that, any individually "Admin can
  // override" field is skipped automatically. A shul-portal submitter gets
  // neither — only an admin.
  const isAdminSubmitter = req.user.role !== 'shul';
  const bypassRequired = isAdminSubmitter && !!b.bypass_required;
  if (!bypassRequired) {
    const errors = validateBySchema(getEffectiveSchema('applicant_application'), b, { isAdmin: isAdminSubmitter });
    if (errors.length) return res.status(400).json({ error: errors[0] });
  }

  const id = uuid();
  // Zip-restricted applicants are auto-rejected silently — the submission
  // still appears to succeed normally so the submitting shul is never told.
  const initialStatus = isZipAllowed(req.user.org_id, b.zip) ? 'pending' : 'rejected';
  const cardAmount = req.user.role !== 'shul' && b.card_amount ? +b.card_amount : null;
  db.prepare(`INSERT INTO applicants (id, org_id, shul_id, season_id, external_id, first_name, last_name, marital_status, home_phone, husband_cell, wife_cell, email,
      address, city, state, zip, preferred_contact_method, preferred_number, num_children, home_for_yomtov, card_amount, comments, source, approval_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?, ?, ?)`)
    .run(id, req.user.org_id, shulId, shul.season_id, generateApplicantExternalId(db), b.first_name, b.last_name, b.marital_status || '', b.home_phone || '', b.husband_cell || '', b.wife_cell || '', b.email || '',
      b.address || '', b.city || '', b.state || '', b.zip || '', b.preferred_contact_method || '', b.preferred_number || '', +b.num_children || 0, yomtovBit(b.home_for_yomtov), cardAmount, b.comments || '',
      req.user.role === 'shul' ? 'shul_upload' : 'admin', initialStatus);
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ?').get(id);
  const flag = detectAndFlag(req.user.org_id, 'applicant', applicant);
  logAudit(req.user.org_id, req.user.id, 'create', 'applicant', id, null, applicant, req.ip);
  res.status(201).json({ applicant: maskForShul(applicant, req.user.role), duplicate: req.user.role === 'shul' ? false : !!flag });
});

router.put('/:id', requirePermission('applicants', 'can_edit'), async (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'shul' && applicant.shul_id !== req.user.shul_id) return res.status(403).json({ error: 'Not your applicant' });
  // A shul can edit its own applicant's info right up until an admin has
  // actually reviewed it — once approved, the record is locked to the shul
  // (an admin can still edit anything, any time, via requirePermission above).
  if (req.user.role === 'shul' && applicant.approval_status === 'approved') {
    return res.status(403).json({ error: 'This applicant has already been approved — contact your admin for changes.' });
  }
  const b = req.body || {};
  if (b.home_phone !== undefined) b.home_phone = normalizePhone(b.home_phone);
  if (b.husband_cell !== undefined) b.husband_cell = normalizePhone(b.husband_cell);
  if (b.wife_cell !== undefined) b.wife_cell = normalizePhone(b.wife_cell);
  for (const [f, label] of [['home_phone', 'Home Phone'], ['husband_cell', 'Husband Cell'], ['wife_cell', 'Wife Cell']]) {
    if (!isValidPhone(b[f])) return res.status(400).json({ error: `${label} must be a valid phone number (10 digits, or 11 digits starting with 1)` });
  }
  if (b.shul_id !== undefined) {
    const targetShul = db.prepare('SELECT id, name_en, season_id FROM shuls WHERE id = ? AND org_id = ?').get(b.shul_id, req.user.org_id);
    if (!targetShul) return res.status(400).json({ error: 'Shul not found' });
    // An applicant's season is fixed at creation (inherited from whichever
    // shul they were added under — see the INSERT statements above) and
    // never changes on its own, so reassigning them to a shul from a
    // different season would silently split their record across seasons —
    // e.g. an approved-this-season applicant reassigned under a next-season
    // shul while still showing as this season's approval/card. Block it
    // instead; if the applicant genuinely needs to move seasons, that's a
    // deliberate separate action, not a side effect of a shul reassignment.
    if (targetShul.season_id !== applicant.season_id) return res.status(400).json({ error: `"${targetShul.name_en}" is in a different season than this applicant — reassigning across seasons isn't allowed.` });
  }
  // card_amount and reassigning which shul an applicant belongs to are
  // admin-only (spec #5 for card_amount; shul_id because a shul reassigning
  // its own applicants to a different shul would be a data-integrity/scope
  // violation, not a legitimate self-service edit).
  const fields = req.user.role === 'shul' ? EDITABLE_FIELDS.filter(f => f !== 'card_amount' && f !== 'provider_exempt') : [...EDITABLE_FIELDS, 'shul_id', 'permanent_comments', 'min_contribution_override'];
  const sets = fields.filter(f => b[f] !== undefined);
  // A 'soft_rejected' applicant (see POST /:id/soft-reject) has no shul —
  // that's what the status means. The moment this update actually gives it
  // one again, it's no longer "removed from a shul waiting to be picked
  // back up" — it's a normal submission again, so status clears back to
  // pending in the same write. Set-pending/reject/approve are the only
  // other ways off 'soft_rejected' and already do their own explicit status
  // change, so this only ever fires on the one path that doesn't otherwise
  // touch approval_status.
  if (sets.includes('shul_id') && applicant.approval_status === 'soft_rejected' && b.shul_id) {
    sets.push('approval_status', 'previous_shul_id');
  }
  if (sets.length) {
    const vals = sets.map(f => f === 'home_for_yomtov' ? yomtovBit(b[f])
      : (f === 'provider_exempt' || f === 'shul_contribution_confirmed') ? (b[f] ? 1 : 0)
      : f === 'approval_status' ? 'pending' : f === 'previous_shul_id' ? null : b[f]);
    db.prepare(`UPDATE applicants SET ${sets.map(f => `${f}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`).run(...vals, applicant.id);
    logAudit(req.user.org_id, req.user.id, 'update', 'applicant', applicant.id,
      Object.fromEntries(sets.map(f => [f, applicant[f]])), Object.fromEntries(sets.map((f, i) => [f, vals[i]])), req.ip);
  }
  const updated = db.prepare('SELECT * FROM applicants WHERE id = ?').get(applicant.id);
  // Re-check for duplicates on every edit, not just at first submission —
  // but only flags a NEW match: passing `applicant` (this record's own
  // pre-edit state) lets checkApplicantDuplicate tell "this field already
  // matched someone before this save" (skip — not a new problem) apart
  // from "this field didn't match before, but does now" (flag — the edit
  // itself is what surfaced it). A field that was never touched this save
  // can't be the cause of a new match either way, so this never re-flags
  // stale data that was already sitting there matching on both sides.
  if (sets.length) detectAndFlag(req.user.org_id, 'applicant', updated, [], applicant);
  // Push the current info to disccardpromos on every save, not just at
  // approval — only meaningful once a customer already exists there
  // (provider_account_id is set the first time they're approved); nothing
  // to push to before that. Best-effort, same as every other provider
  // write: a disccardpromos hiccup never blocks the save that triggered it.
  if (sets.length && updated.provider_account_id && !updated.provider_exempt) {
    try {
      const shul = updated.shul_id ? db.prepare('SELECT name_en FROM shuls WHERE id = ?').get(updated.shul_id) : null;
      await giftcard.updateCustomer(updated.season_id, updated.provider_account_id, buildProviderOpts(req.user.org_id, updated, shul?.name_en || 'Unknown'));
    } catch (e) {
      console.error('[giftcard] failed to push applicant update to disccardpromos:', e.message);
    }
  }
  res.json({ applicant: maskForShul(updated, req.user.role, req.user.org_id) });
});

// Turns a carried-forward applicant (approval_status='incomplete' — see
// POST /shuls/:id/carry-forward) into a real submission for this season.
// This is where required-field validation actually happens for a
// carried-over record — against the *live* form schema, so a field that
// wasn't required last season but is now genuinely blocks completion, same
// as any other submission. Body fields not provided fall back to whatever
// was already copied over from last season. Applies the same shul-blind
// zip rule as every other submission path (isZipAllowed) since this is the
// moment the record actually becomes a real applicant for this season.
router.post('/:id/complete-reenrollment', requirePermission('applicants', 'can_edit'), (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'shul' && applicant.shul_id !== req.user.shul_id) return res.status(403).json({ error: 'Not your applicant' });
  if (applicant.approval_status !== 'incomplete') return res.status(400).json({ error: 'This applicant is not pending re-enrollment' });
  // Same allocated-slots gate as a brand new submission (POST /) — a shul
  // can have more carried-forward "incomplete" applicants pre-enrolled than
  // it has slots for this season (the admin may carry everyone over so the
  // shul can pick which ones to re-enroll), so completing them one at a
  // time must still stop once slots run out. Other still-incomplete rows
  // (nobody's chosen them yet) don't count as "used" — only real
  // submissions (pending/approved) do — otherwise pre-enrolling more
  // candidates than there are slots would make ALL of them uncompletable
  // instead of leaving the shul free to pick which ones fill the slots.
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ?').get(applicant.shul_id);
  // Same shul-info-complete gate as a brand new submission (POST /) — a
  // carried-forward shul with missing info can't re-enroll anyone until
  // that's fixed either, since completing a re-enrollment is itself
  // submitting an applicant for this season (#147).
  if (req.user.role === 'shul' && shul) {
    const shulErrors = shulInfoErrors(shul);
    if (shulErrors.length) return res.status(400).json({ error: `Please complete your shul's information before re-enrolling applicants: ${shulErrors.join('; ')}`, code: 'SHUL_INFO_INCOMPLETE' });
    // A carried-forward shul only signs a fresh contract once, per season,
    // via the admin-triggered "send contract" step — re-enrolling an
    // applicant for THIS season is exactly the kind of commitment that
    // contract covers, so it can't happen before the shul has actually
    // signed it for the season they're currently in.
    if (!['contract_signed', 'approved'].includes(shul.status)) {
      return res.status(400).json({ error: 'Please sign your contract for this season before re-enrolling applicants.', code: 'CONTRACT_NOT_SIGNED' });
    }
  }
  if (shul?.slots_allocated) {
    const used = db.prepare(`SELECT COUNT(*) c FROM applicants WHERE shul_id = ? AND approval_status NOT IN ('rejected','incomplete','draft')`).get(applicant.shul_id).c;
    if (used >= shul.slots_allocated) return res.status(400).json({ error: `This shul has used all ${shul.slots_allocated} allocated slot(s) for this season` });
  }
  const b = req.body || {};
  if (b.home_phone !== undefined) b.home_phone = normalizePhone(b.home_phone);
  if (b.husband_cell !== undefined) b.husband_cell = normalizePhone(b.husband_cell);
  if (b.wife_cell !== undefined) b.wife_cell = normalizePhone(b.wife_cell);
  const merged = { ...applicant, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
  const errors = validateBySchema(getEffectiveSchema('applicant_application'), merged, { isAdmin: false });
  if (errors.length) return res.status(400).json({ error: errors[0] });
  if (!merged.first_name || !merged.last_name) return res.status(400).json({ error: 'First and last name are required' });

  const initialStatus = isZipAllowed(req.user.org_id, merged.zip) ? 'pending' : 'rejected';
  db.prepare(`UPDATE applicants SET first_name=?, last_name=?, marital_status=?, home_phone=?, husband_cell=?, wife_cell=?, email=?,
      address=?, city=?, state=?, zip=?, preferred_contact_method=?, preferred_number=?, num_children=?, home_for_yomtov=?, comments=?,
      approval_status=?, updated_at=datetime('now') WHERE id=?`)
    .run(merged.first_name, merged.last_name, merged.marital_status || '', merged.home_phone || '', merged.husband_cell || '', merged.wife_cell || '', merged.email || '',
      merged.address || '', merged.city || '', merged.state || '', merged.zip || '', merged.preferred_contact_method || '', merged.preferred_number || '',
      +merged.num_children || 0, yomtovBit(merged.home_for_yomtov), merged.comments || '', initialStatus, applicant.id);
  const updated = db.prepare('SELECT * FROM applicants WHERE id = ?').get(applicant.id);
  detectAndFlag(req.user.org_id, 'applicant', updated);
  logAudit(req.user.org_id, req.user.id, 'complete-reenrollment', 'applicant', applicant.id, { approval_status: 'incomplete' }, { approval_status: initialStatus }, req.ip);
  res.json({ applicant: maskForShul(db.prepare('SELECT * FROM applicants WHERE id = ?').get(applicant.id), req.user.role, req.user.org_id) });
});

// Bulk version of the above: re-enrolls every one of a shul's carried-over
// 'incomplete' applicants whose already-known data (from being carried
// forward) already satisfies every required field on the application — no
// per-applicant review needed since nothing is missing on that one. Anyone
// still missing something is left alone rather than partially submitted, so
// the shul still goes through the normal one-at-a-time completion flow for
// those specific applicants. Same ownership, shul-info-complete (#147), and
// allocated-slots gates as the single-applicant route above — re-checked
// per applicant since completing one changes how many slots are left for
// the next.
router.post('/mass-complete-reenrollment', requirePermission('applicants', 'can_edit'), (req, res) => {
  const shulId = req.user.role === 'shul' ? req.user.shul_id : req.body?.shul_id;
  if (!shulId) return res.status(400).json({ error: 'shul_id is required' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(shulId, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Shul not found' });
  if (req.user.role === 'shul' && shul.id !== req.user.shul_id) return res.status(403).json({ error: 'Not your shul' });
  if (req.user.role === 'shul') {
    const shulErrors = shulInfoErrors(shul);
    if (shulErrors.length) return res.status(400).json({ error: `Please complete your shul's information before re-enrolling applicants: ${shulErrors.join('; ')}`, code: 'SHUL_INFO_INCOMPLETE' });
    if (!['contract_signed', 'approved'].includes(shul.status)) {
      return res.status(400).json({ error: 'Please sign your contract for this season before re-enrolling applicants.', code: 'CONTRACT_NOT_SIGNED' });
    }
  }

  // Optional ids: scopes this to just the applicants the shul actually
  // checked off (see shul-portal/dashboard.html's multi-select), instead of
  // every carried-over 'incomplete' row at once. Omitted entirely keeps the
  // original "re-enroll everything that's ready" behavior, which the
  // admin-triggered path (no ids, req.body.shul_id) still relies on.
  const { ids } = req.body || {};
  const candidates = Array.isArray(ids) && ids.length
    ? db.prepare(`SELECT * FROM applicants WHERE shul_id = ? AND approval_status = 'incomplete' AND id IN (${ids.map(() => '?').join(',')})`).all(shulId, ...ids)
    : db.prepare(`SELECT * FROM applicants WHERE shul_id = ? AND approval_status = 'incomplete'`).all(shulId);
  let completed = 0, skippedIncomplete = 0, skippedSlotsFull = 0;
  const affectedIds = [], names = [];
  for (const applicant of candidates) {
    if (shul.slots_allocated) {
      const used = db.prepare(`SELECT COUNT(*) c FROM applicants WHERE shul_id = ? AND approval_status NOT IN ('rejected','incomplete','draft')`).get(shulId).c;
      if (used >= shul.slots_allocated) { skippedSlotsFull++; continue; }
    }
    const errors = validateBySchema(getEffectiveSchema('applicant_application'), applicant, { isAdmin: false });
    if (errors.length) { skippedIncomplete++; continue; }
    const initialStatus = isZipAllowed(req.user.org_id, applicant.zip) ? 'pending' : 'rejected';
    db.prepare(`UPDATE applicants SET approval_status=?, updated_at=datetime('now') WHERE id=?`).run(initialStatus, applicant.id);
    const updated = db.prepare('SELECT * FROM applicants WHERE id = ?').get(applicant.id);
    detectAndFlag(req.user.org_id, 'applicant', updated);
    affectedIds.push(applicant.id); names.push(`${applicant.first_name} ${applicant.last_name}`);
    completed++;
  }
  logMassAudit(req.user.org_id, req.user.id, 'mass-complete-reenrollment', 'applicant', affectedIds,
    { skippedIncomplete, skippedSlotsFull, shul_id: shulId, names }, req.ip);
  res.json({ completed, skippedIncomplete, skippedSlotsFull });
});

// Shul-portal only: turns specific 'draft' rows (created by the shul's own
// bulk upload — see POST /import's initialStatus comment, #3) into real
// submissions. A shul-uploaded new row never auto-submits — the shul picks
// which of them to actually send in, same explicit checkbox-then-submit
// pattern as mass-complete-reenrollment above. Same shul-info-complete and
// contract-signed gates as every other shul-portal submission path; only the
// per-shul slots cap applies here (not the org-wide season cap) — same as
// complete-reenrollment, since these rows already exist and aren't a brand
// new application being created.
router.post('/mass-submit-drafts', requirePermission('applicants', 'can_edit'), (req, res) => {
  if (req.user.role !== 'shul') return res.status(403).json({ error: 'Not permitted' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.user.shul_id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Shul not found' });
  const shulErrors = shulInfoErrors(shul);
  if (shulErrors.length) return res.status(400).json({ error: `Please complete your shul's information before submitting applicants: ${shulErrors.join('; ')}`, code: 'SHUL_INFO_INCOMPLETE' });
  if (!['contract_signed', 'approved'].includes(shul.status)) {
    return res.status(400).json({ error: 'Please sign your contract for this season before submitting applicants.', code: 'CONTRACT_NOT_SIGNED' });
  }
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  const candidates = db.prepare(`SELECT * FROM applicants WHERE shul_id = ? AND approval_status = 'draft' AND id IN (${ids.map(() => '?').join(',')})`).all(shul.id, ...ids);
  let submitted = 0, skippedIncomplete = 0, skippedSlotsFull = 0; const affectedIds = [], names = [];
  for (const applicant of candidates) {
    if (shul.slots_allocated) {
      const used = db.prepare(`SELECT COUNT(*) c FROM applicants WHERE shul_id = ? AND approval_status NOT IN ('rejected','incomplete','draft')`).get(shul.id).c;
      if (used >= shul.slots_allocated) { skippedSlotsFull++; continue; }
    }
    // Same required-field gate as mass-complete-reenrollment just above —
    // a draft is only a placeholder until this moment, so nothing stops a
    // shul from creating one with just a name and leaving the rest blank;
    // this is where it actually becomes a real submission, same as any
    // other, so it has to pass the same schema every other submission does.
    const errors = validateBySchema(getEffectiveSchema('applicant_application'), applicant, { isAdmin: false });
    if (errors.length) { skippedIncomplete++; continue; }
    const initialStatus = isZipAllowed(req.user.org_id, applicant.zip) ? 'pending' : 'rejected';
    db.prepare(`UPDATE applicants SET approval_status=?, updated_at=datetime('now') WHERE id=?`).run(initialStatus, applicant.id);
    const updated = db.prepare('SELECT * FROM applicants WHERE id = ?').get(applicant.id);
    detectAndFlag(req.user.org_id, 'applicant', updated);
    affectedIds.push(applicant.id); names.push(`${applicant.first_name} ${applicant.last_name}`.trim());
    submitted++;
  }
  logMassAudit(req.user.org_id, req.user.id, 'mass-submit-drafts', 'applicant', affectedIds, { skippedIncomplete, skippedSlotsFull, names }, req.ip);
  res.json({ submitted, skippedIncomplete, skippedSlotsFull });
});

// Manually move an applicant back to 'pending' — for un-rejecting one after
// a decision was made too early/in error, or un-approving one to reconsider
// (approved_by/approved_at/card_amount are left as-is so there's a record of
// the prior decision; approving again overwrites them same as normal).
router.post('/:id/set-pending', requirePermission('applicants', 'can_edit'), async (req, res) => {
  // Admin decision-workflow action — a shul (even for its own applicant)
  // never has a legitimate reason to un-approve/un-reject one itself, since
  // that would let it bypass the review it's waiting on. The shul-portal UI
  // never calls this.
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE applicants SET approval_status='pending', updated_at=datetime('now') WHERE id=?`).run(applicant.id);
  logAudit(req.user.org_id, req.user.id, 'set-pending', 'applicant', applicant.id, { approval_status: applicant.approval_status }, { approval_status: 'pending' }, req.ip);
  const { errors: cardLockErrors } = await lockApplicantCards(req.user.org_id, applicant);
  res.json({ applicant: db.prepare('SELECT * FROM applicants WHERE id = ?').get(applicant.id), cardLockErrors });
});

router.post('/mass-set-pending', requirePermission('applicants', 'can_edit'), async (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  let updated = 0, skipped = 0, cardLockErrors = 0;
  const affectedIds = [], names = [];
  for (const id of ids) {
    const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!applicant) { skipped++; continue; }
    db.prepare(`UPDATE applicants SET approval_status='pending', updated_at=datetime('now') WHERE id=?`).run(applicant.id);
    const { errors } = await lockApplicantCards(req.user.org_id, applicant);
    if (errors?.length) cardLockErrors++;
    affectedIds.push(applicant.id); names.push(`${applicant.first_name} ${applicant.last_name}`.trim());
    updated++;
  }
  logMassAudit(req.user.org_id, req.user.id, 'mass-set-pending', 'applicant', affectedIds, { skipped, names }, req.ip);
  res.json({ updated, skipped, cardLockErrors });
});

// Permanent deletion — full removal, not the pause/reject soft-states
// elsewhere in this file. Every table's reference to this applicant is
// cleaned up first (FK enforcement is ON): cards + their transactions and
// notes are hard-deleted since they're meaningless without the applicant;
// any other applicant's duplicate_of_applicant_id pointing here is cleared
// so that applicant survives; the polymorphic entity_type/entity_id rows
// (documents, tasks, etc.) are cleaned up too. Wrapped in a transaction so a
// failure partway through doesn't leave orphaned rows.
// Deleting our local record must never leave a still-usable disccardpromos
// customer/card behind — locking (is_active=false) happens first and is
// never skipped, even though the delete itself always proceeds regardless
// of whether the lock succeeds (best-effort, same as reject/set-pending;
// any failure comes back as cardLockErrors so the admin knows to check
// disccardpromos directly rather than assuming it's handled). Deliberately
// a lock, not deleteCustomer — a customer that already had real money
// loaded onto a card should stay on record there, just deactivated, not be
// erased.
router.delete('/:id/permanent', requirePermission('applicants', 'can_edit'), async (req, res) => {
  // Admin-only — a shul removing its own applicant goes through
  // POST /:id/soft-reject instead (detach + recoverable), not a true
  // destructive delete. See that route for the shul-eligibility rule.
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  const { errors: cardLockErrors } = await lockApplicantCards(req.user.org_id, applicant);
  // Snapshot every related row before the cascade removes it, so a
  // super_admin can fully undo this from Recent Actions — "Delete
  // Permanently" still reads and behaves as a real permanent delete, this
  // is purely a safety net (see utils/entityDelete.js's snapshot/restore
  // comment block).
  const snapshot = captureApplicantSnapshot(applicant);
  const del = db.transaction(() => hardDeleteApplicant(applicant));
  del();
  logAudit(req.user.org_id, req.user.id, 'delete', 'applicant', applicant.id, snapshot, null, req.ip);
  res.json({ ok: true, cardLockErrors });
});

router.post('/mass-delete-permanent', requirePermission('applicants', 'can_edit'), async (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  let deleted = 0, skipped = 0, cardLockErrors = 0;
  const affectedIds = [], names = [], snapshots = [];
  for (const id of ids) {
    const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!applicant) { skipped++; continue; }
    const { errors } = await lockApplicantCards(req.user.org_id, applicant);
    if (errors?.length) cardLockErrors++;
    const snapshot = captureApplicantSnapshot(applicant);
    const del = db.transaction(() => hardDeleteApplicant(applicant));
    del();
    snapshots.push(snapshot);
    affectedIds.push(applicant.id); names.push(`${applicant.first_name} ${applicant.last_name}`.trim());
    deleted++;
  }
  logMassAudit(req.user.org_id, req.user.id, 'mass-delete', 'applicant', affectedIds, { skipped, names, snapshots }, req.ip);
  res.json({ deleted, skipped, cardLockErrors });
});

// #11: guards against the SAME applicant being written to disccardpromos
// twice as a separate "new" customer — most plausibly a double-click on
// Approve (or two admins approving the same applicant at once), which
// races two concurrent requests through upsertAccountForApproval's
// find-then-create with nothing serializing them: both can see "no
// existing customer" before either has actually created one, so both
// create. Keyed on external_id (not applicant.id) since that's what
// disccardpromos itself matches an existing customer by — see
// giftcard.js's findCustomerByExternalId — and, after the carry-forward
// fix above, the same external_id can legitimately belong to more than one
// applicant row across seasons. In-process only (this app runs single-
// instance — see services/reminders.js's identical assumption).
const approvalsInFlight = new Set();

router.post('/:id/approve', requirePermission('applicants', 'can_edit'), async (req, res) => {
  // Admin decision only — a shul approving its own applicant would bypass
  // the review it's waiting on (and, since approval can trigger a real
  // disccardpromos gift-card write, self-approve real money). The
  // shul-portal UI never calls this.
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  if (applicant.is_paused) return res.status(423).json({ error: 'Applicant has an unresolved duplicate flag' });
  // Belt-and-suspenders: every INSERT path generates an external_id and a
  // startup migration backfills any legacy row missing one (see db.js), so
  // this should never actually fire — but approval is the one place a blank
  // external_id has real financial consequences (disccardpromos silently
  // drops the field from the create-customer request entirely — see
  // giftcard.js's customerPayload — leaving a live customer with no way to
  // ever be matched back to this applicant again). Cheap to guarantee here.
  if (!applicant.external_id) {
    applicant.external_id = generateApplicantExternalId(db);
    db.prepare('UPDATE applicants SET external_id = ? WHERE id = ?').run(applicant.external_id, applicant.id);
  }
  if (approvalsInFlight.has(applicant.external_id)) {
    return res.status(409).json({ error: 'This applicant is already being approved — please wait for that to finish.' });
  }
  approvalsInFlight.add(applicant.external_id);
  try {
    const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(applicant.season_id);
    if (applicant.approval_status !== 'approved' && season?.max_accepted_applicants != null) {
      const accepted = db.prepare(`SELECT COUNT(*) c FROM applicants WHERE season_id = ? AND approval_status = 'approved'`).get(season.id).c;
      if (accepted >= season.max_accepted_applicants) return res.status(400).json({ error: `This season's cap of ${season.max_accepted_applicants} accepted applicant(s) has already been reached.` });
    }
    if (season?.require_shul_contribution) {
      const contribErr = shulContributionError(applicant);
      if (contribErr) return res.status(400).json({ error: contribErr });
    }
    const amount = req.body?.card_amount ?? applicant.card_amount ?? season?.default_card_amount ?? 0;
    db.prepare(`UPDATE applicants SET approval_status='approved', approved_by=?, approved_at=datetime('now'), card_amount=? WHERE id=?`)
      .run(req.user.id, amount, applicant.id);
    logAudit(req.user.org_id, req.user.id, 'approve', 'applicant', applicant.id,
      { approval_status: applicant.approval_status, card_amount: applicant.card_amount }, { approval_status: 'approved', card_amount: amount }, req.ip);
    let emailError = null;
    if (applicant.email) {
      const tmpl = renderSystemTemplate(req.user.org_id, 'applicantApproved', { name: `${applicant.first_name} ${applicant.last_name}` });
      ({ emailError } = await sendMailChecked(req.user.org_id, applicant.email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo, sentBy: req.user.id }));
      if (emailError) console.error('[mail] applicant approval email failed:', emailError);
    }
    // A merged-duplicate secondary (see services/duplicates.js's
    // mergeApplicants — confirmed the same real person as another shul's
    // applicant) never gets its own disccardpromos account/card, no matter
    // how many times it's approved — that would be exactly the double gift
    // card merging was meant to prevent. It just links straight to whatever
    // the primary member already has (nothing yet if the primary hasn't
    // been approved either) so admin views show the connection.
    // reconcileAccountsForGroup (not a bare overwrite) so a secondary that
    // already carries its OWN real disccardpromos account — from before it
    // was ever recognized as a duplicate — never gets silently clobbered;
    // see that function's comment for why that case is reported instead.
    let providerAccountError = null, providerFundsError = null;
    // Writes/links the disccardpromos account for this applicant — idempotent
    // by external_id (existing account just gets the current season added;
    // a new one is created under a group matching the shul's English name,
    // creating that group first if needed — see giftcard.js's
    // upsertAccountForApproval, via ensureProviderAccount above for the
    // merged-group rule). Best-effort: a disccardpromos hiccup here must
    // never undo or block the approval that already committed above, same
    // "external side-effect can fail without failing the action" pattern as
    // the approval email right above.
    const account = await ensureProviderAccount(req.user.org_id, applicant);
    if (account.error) { providerAccountError = account.error; console.error('[giftcard] failed to write disccardpromos account on approval:', account.error); }
    {
      // disccardpromos has no separate "assign/activate a card" step — crediting
      // a customer's balance against a configured Package (Settings >
      // Organization > Gift Card Loading) via add-funds IS how a card actually
      // gets issued with an amount. Same best-effort pattern as the account
      // write above: skipped if that write failed (nothing to credit yet), and
      // never blocks/undoes the approval itself. provider_exempt applicants
      // (one-time backfill import — see POST /import) never reach either block,
      // permanently, no matter how many times they're approved/rejected. A
      // member merely linked to its group's existing shared account (not the
      // one that created it) never loads funds — the person already has
      // their card through the other record.
      if (applicant.shul_id && !applicant.provider_exempt && !providerAccountError && !account.linked) {
        if (amount > 0) {
          const discountId = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'disccardpromos_discount_id'`).get(req.user.org_id)?.value;
          if (!discountId) {
            providerFundsError = 'No disccardpromos Package/Discount ID configured (Settings > Organization > Gift Card Loading) — card amount was not loaded.';
          } else {
            try {
              await giftcard.addFunds(applicant.season_id, { customerId: account.accountId, externalId: applicant.external_id, discountId, amount });
            } catch (e) {
              providerFundsError = e.message;
              console.error('[giftcard] failed to load funds on approval:', e.message);
            }
          }
        } else {
          // amount<=0 isn't itself an error — the account still gets
          // created above with no funds, same as an intentionally-comped
          // applicant — but it used to be entirely silent, indistinguishable
          // from funds genuinely loading successfully. This resolved from
          // req.body.card_amount ?? applicant.card_amount ?? season's
          // default_card_amount ?? 0 — if this fires for every approval,
          // the season's default (or each applicant's own Card Amount) is
          // almost certainly $0/unset and that's the real thing to fix, not
          // this route.
          providerFundsError = 'Card amount resolved to $0 — nothing was sent to disccardpromos. Set a Card Amount on the applicant (or the season default) before approving if this should have loaded funds.';
        }
      }
    }
    res.json({ applicant: db.prepare('SELECT * FROM applicants WHERE id = ?').get(applicant.id), emailError, providerAccountError, providerFundsError });
  } finally {
    approvalsInFlight.delete(applicant.external_id);
  }
});

// Raw disccardpromos customer record for this applicant — active_cards
// (masked numbers), packages (with their real numeric ids, useful for
// checking Settings > Organization > Gift Card Loading's Package/Discount
// ID against what actually exists), and balances. A thin passthrough of
// getCustomerByExternalId, not stored locally, so it's always live.
router.get('/:id/provider-customer', requireAdmin, async (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  if (!applicant.external_id) return res.status(400).json({ error: 'This applicant has no external_id yet' });
  try {
    const customer = await giftcard.getCustomerByExternalId(applicant.season_id, applicant.external_id, { balances: true, suppressNotFound: false });
    res.json({ customer, mockMode: giftcard.isMockMode(applicant.season_id) });
  } catch (e) {
    res.status(502).json({ error: e.message, status: e.status, rawText: e.rawText });
  }
});

// Diagnostic-only: fetch a disccardpromos customer directly by their
// numeric provider id (not by our external_id) — pass ?provider_id=74412.
// Used to check whether a customer known to exist actually carries the
// external_id we sent, i.e. whether the by-external-id lookup's 404s mean
// "no such route" or "route works, this customer genuinely doesn't match".
router.get('/:id/provider-customer-by-id', requireAdmin, async (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  const providerId = req.query.provider_id;
  if (!providerId) return res.status(400).json({ error: 'provider_id query param is required' });
  try {
    const customer = await giftcard.getCustomerById(applicant.season_id, providerId);
    res.json({ customer });
  } catch (e) {
    res.status(502).json({ error: e.message, status: e.status, rawText: e.rawText });
  }
});

router.post('/:id/reject', requirePermission('applicants', 'can_edit'), async (req, res) => {
  // Admin decision only — see the identical note on /:id/approve above.
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE applicants SET approval_status='rejected', approved_by=?, approved_at=datetime('now') WHERE id=?`).run(req.user.id, applicant.id);
  logAudit(req.user.org_id, req.user.id, 'reject', 'applicant', applicant.id, { approval_status: applicant.approval_status }, { approval_status: 'rejected' }, req.ip);
  const { errors: cardLockErrors } = await lockApplicantCards(req.user.org_id, applicant);
  res.json({ ok: true, cardLockErrors });
});

// Every shul this applicant is (or, via an open/resolved duplicate match,
// might be) submitted under — the pick-list for POST /:id/soft-reject
// below. Reuses getMergeGroupIds rather than the narrower merge_group_id-
// only `mergeGroup` GET /:id already returns, since that field is only
// populated after an admin has explicitly merged the duplicate; this needs
// to work just as well while a match is still an open, unresolved flag (the
// far more common case when an admin first notices the same person at two
// shuls and wants to pick one to remove). Degrades to just this one
// applicant's own shul when there's no duplicate at all — soft-reject
// doesn't require one.
router.get('/:id/shul-group', requireAdmin, (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  const ids = getMergeGroupIds(req.user.org_id, [applicant.id]);
  const members = db.prepare(`SELECT a.id, a.first_name, a.last_name, a.shul_id, a.approval_status, s.name_en as shul_name, ps.name_en as previous_shul_name
    FROM applicants a LEFT JOIN shuls s ON s.id = a.shul_id LEFT JOIN shuls ps ON ps.id = a.previous_shul_id WHERE a.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  res.json({ members });
});

// Duplicate-resolution tool AND the shul-portal's own "remove this
// applicant" action — both land here. Admin use: this exact applicant
// appears to be submitted by more than one shul (or an admin just wants
// one specific shul's submission gone without touching the others in the
// group), so this picks ONE record — not necessarily the one the request
// URL is even on, see the frontend's shul-group modal. Shul-portal use: a
// shul removing an applicant from their own list was, until now, a real
// permanent delete — it's this instead, so an accidental removal (or one
// genuinely meant to be temporary) doesn't destroy history and can find
// its way back. Either way this detaches the record: shul_id cleared and
// status set to 'soft_rejected'. That status behaves like 'rejected'
// everywhere a slot count matters (every such query is already scoped
// `WHERE shul_id = ?`, which a NULL shul_id can never match — nothing
// extra needed there), but it's meant to be temporary: PUT /:id auto-
// clears it back to 'pending' the moment this same row is ever given a
// shul_id again (any admin action, not just a dedicated "re-add" flow),
// and re-enrolling the same person elsewhere gets caught by the ordinary
// duplicate-detection flag (checkApplicantDuplicate has no status filter,
// so a soft-rejected record is still a live match candidate) — resolving
// that flag by merging with the new submission as primary is what actually
// brings them back under a shul (see services/duplicates.js's
// mergeApplicants). Never exposed to the shul beyond the fact that their
// own action succeeded — no flag/group/other-shul detail ever reaches
// that role (see GET /:id and GET /:id/shul-group, both admin-only).
router.post('/:id/soft-reject', requirePermission('applicants', 'can_edit'), async (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'shul') {
    if (applicant.shul_id !== req.user.shul_id) return res.status(403).json({ error: 'Not your applicant' });
    // Same rule the old shul-side hard-delete used: an applicant an admin
    // has ever actually decided on (approved_at, set by both approve AND
    // reject, deliberately left alone by set-pending) is no longer purely
    // the shul's to retract, no matter its current status.
    if (applicant.approved_at) return res.status(403).json({ error: 'This applicant has already been reviewed by an admin and can no longer be removed. Contact your admin.' });
  }
  if (applicant.approval_status === 'approved') return res.status(400).json({ error: 'This applicant is already approved — use Set to Pending or Reject instead, not Soft Reject.' });
  if (!applicant.shul_id) return res.status(400).json({ error: 'This applicant isn\'t currently assigned to a shul.' });
  // previous_shul_id records who they were removed from — shul_id itself
  // has to go to NULL (that's what makes them invisible to every shul-
  // scoped query), but losing that history entirely would leave an admin
  // looking at a soft-rejected record with no way to tell where it came
  // from. Cleared again the moment they're given a real shul_id (see PUT
  // /:id's auto-revert) — it's only meaningful while actually soft-rejected.
  db.prepare(`UPDATE applicants SET shul_id = NULL, previous_shul_id = ?, approval_status = 'soft_rejected', updated_at = datetime('now') WHERE id = ?`).run(applicant.shul_id, applicant.id);
  logAudit(req.user.org_id, req.user.id, 'soft-reject', 'applicant', applicant.id,
    { shul_id: applicant.shul_id, approval_status: applicant.approval_status }, { shul_id: null, previous_shul_id: applicant.shul_id, approval_status: 'soft_rejected' }, req.ip);
  const { errors: cardLockErrors } = await lockApplicantCards(req.user.org_id, applicant);
  res.json({ ok: true, cardLockErrors });
});

router.post('/mass-reject', requirePermission('applicants', 'can_edit'), async (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  let rejected = 0, skipped = 0, cardLockErrors = 0;
  const affectedIds = [], names = [];
  for (const id of ids) {
    const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!applicant) { skipped++; continue; }
    db.prepare(`UPDATE applicants SET approval_status='rejected', approved_by=?, approved_at=datetime('now') WHERE id=?`).run(req.user.id, applicant.id);
    const { errors } = await lockApplicantCards(req.user.org_id, applicant);
    if (errors?.length) cardLockErrors++;
    affectedIds.push(applicant.id); names.push(`${applicant.first_name} ${applicant.last_name}`.trim());
    rejected++;
  }
  logMassAudit(req.user.org_id, req.user.id, 'mass-reject', 'applicant', affectedIds, { skipped, names }, req.ip);
  res.json({ rejected, skipped, cardLockErrors });
});

// Mass approval — spec #5 "allow mass approval".
router.post('/mass-approve', requirePermission('applicants', 'can_edit'), async (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { ids, card_amount } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  const discountId = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'disccardpromos_discount_id'`).get(req.user.org_id)?.value;
  let approved = 0, skipped = 0, capReached = false, providerErrors = 0, contributionBlocked = 0, zeroAmountSkipped = 0;
  const affectedIds = [], names = [];
  // Unlike the single /:id/approve route (which returns providerFundsError
  // verbatim), this used to only ever report a bare providerErrors COUNT —
  // the actual disccardpromos error text only ever reached console.error,
  // invisible to whoever's actually running the mass-approve. Collecting the
  // real reason per applicant here is what lets an admin (or whoever they
  // forward this to) tell "no Package/Discount ID configured" apart from a
  // genuine live API rejection, instead of guessing from a number alone.
  const providerErrorDetails = [];
  for (const id of ids) {
    const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!applicant || applicant.is_paused) { skipped++; continue; }
    const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(applicant.season_id);
    if (applicant.approval_status !== 'approved' && season?.max_accepted_applicants != null) {
      const accepted = db.prepare(`SELECT COUNT(*) c FROM applicants WHERE season_id = ? AND approval_status = 'approved'`).get(season.id).c;
      if (accepted >= season.max_accepted_applicants) { skipped++; capReached = true; continue; }
    }
    if (season?.require_shul_contribution && shulContributionError(applicant)) { skipped++; contributionBlocked++; continue; }
    const amount = card_amount ?? applicant.card_amount ?? season?.default_card_amount ?? 0;
    db.prepare(`UPDATE applicants SET approval_status='approved', approved_by=?, approved_at=datetime('now'), card_amount=? WHERE id=?`).run(req.user.id, amount, id);
    affectedIds.push(id); names.push(`${applicant.first_name} ${applicant.last_name}`.trim());
    approved++;
    // Same best-effort account-write + fund-load as the single /:id/approve
    // route — see the comments there. A disccardpromos hiccup on one
    // applicant never stops the rest of the batch. A merged-duplicate
    // secondary (see isMergedSecondary) never gets its own account/card —
    // just links to whatever the primary already has, via
    // reconcileAccountsForGroup so a secondary with its own pre-existing
    // real account is reported as a conflict rather than clobbered.
    if (applicant.shul_id && !applicant.provider_exempt) {
      // See ensureProviderAccount — a member linked to its group's existing
      // shared account (accountOk stays false) never loads funds here.
      const account = await ensureProviderAccount(req.user.org_id, applicant);
      let accountOk = !!account.accountId && !account.error && !account.linked;
      if (account.error) {
        providerErrors++;
        providerErrorDetails.push(`${applicant.first_name} ${applicant.last_name}: account write failed — ${account.error}`);
        console.error('[giftcard] failed to write disccardpromos account on mass-approve:', account.error);
      }
      if (accountOk && amount > 0 && discountId) {
        try { await giftcard.addFunds(applicant.season_id, { customerId: account.accountId, externalId: applicant.external_id, discountId, amount }); }
        catch (e) {
          providerErrors++;
          providerErrorDetails.push(`${applicant.first_name} ${applicant.last_name}: card not loaded — ${e.message}`);
          console.error('[giftcard] failed to load funds on mass-approve:', e.message);
        }
      } else if (accountOk && amount > 0 && !discountId) {
        providerErrors++;
        providerErrorDetails.push(`${applicant.first_name} ${applicant.last_name}: card not loaded — no disccardpromos Package/Discount ID configured`);
      } else if (accountOk && amount <= 0) {
        // Not itself an error (an intentionally-comped applicant looks
        // identical), but it used to be entirely silent — indistinguishable
        // from funds genuinely loading. amount here is the ONE uniform
        // card_amount typed into the mass-approve prompt (falls back per-
        // applicant to their own existing card_amount, then the season
        // default, then $0) — if this fires for most/all of a batch, the
        // season default (or the applicants' own Card Amount) is almost
        // certainly $0/unset, which is the real thing to go fix.
        zeroAmountSkipped++;
      }
    }
  }
  logMassAudit(req.user.org_id, req.user.id, 'mass-approve', 'applicant', affectedIds, { skipped, capReached, providerErrors, contributionBlocked, zeroAmountSkipped, names, providerErrorDetails }, req.ip);
  res.json({ approved, skipped, capReached, providerErrors, contributionBlocked, zeroAmountSkipped, providerErrorDetails, providerErrorsHint: providerErrors && !discountId ? 'No disccardpromos Package/Discount ID configured (Settings > Organization > Gift Card Loading).' : undefined });
});

router.post('/:id/notes', (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { note } = req.body || {};
  if (!note) return res.status(400).json({ error: 'Note text required' });
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  const id = uuid();
  db.prepare('INSERT INTO applicant_notes (id, applicant_id, user_id, note) VALUES (?,?,?,?)').run(id, applicant.id, req.user.id, note);
  res.status(201).json({ note: db.prepare('SELECT * FROM applicant_notes WHERE id = ?').get(id) });
});

// CSV/XLSX bulk import (spec #1 "via XCLS and CSV files", #3 mass upload, #5 shul self-upload).
// If the requester is a shul-portal user, shul_name is ignored server-side
// (always their own shul — see forcedShul below) — and, since that column
// would otherwise be confusing/pointless for them to fill in, this drops
// it from the template they download entirely. An admin's own template
// still has it, since an admin's upload can span many shuls.
router.get('/import/template', (req, res) => {
  const columns = req.user.role === 'shul' ? APPLICANT_IMPORT_COLUMNS.filter(c => c !== 'shul_name') : APPLICANT_IMPORT_COLUMNS;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="applicant_import_template.xlsx"');
  res.send(buildXlsxTemplate(['id', ...columns]));
});

// Every column an UPDATE row (see rowExisting below) can touch, and how to
// read it off a parsed sheet row — a blank cell means "leave this column
// alone", not "clear it", same contract as the shuls import. Shul
// reassignment is deliberately not editable this way — moving an applicant
// between shuls has real side effects (season cap, disccardpromos account)
// better done as its own explicit action than a spreadsheet cell.
const APPLICANT_UPDATABLE_FIELDS = {
  first_name: r => r.first_name, last_name: r => r.last_name, marital_status: r => r.marital_status,
  home_phone: r => r.home_phone && normalizePhone(r.home_phone), husband_cell: r => r.husband_cell && normalizePhone(r.husband_cell), wife_cell: r => r.wife_cell && normalizePhone(r.wife_cell),
  email: r => r.email, address: r => r.address, city: r => r.city, state: r => r.state, zip: r => r.zip,
  preferred_contact_method: r => r.preferred_contact_method, preferred_number: r => r.preferred_number,
  num_children: r => (r.num_children !== '' && r.num_children != null ? +r.num_children : ''),
  card_amount: r => (r.card_amount !== '' && r.card_amount != null ? +r.card_amount : ''),
  comments: r => r.comments,
};

router.post('/import', requirePermission('applicants', 'can_edit'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!/\.xlsx$/i.test(req.file.originalname || '')) return res.status(400).json({ error: 'Only .xlsx files are accepted (CSV does not reliably support Hebrew text).' });
  const rows = parseSpreadsheet(req.file.buffer, req.file.originalname);
  const jobId = uuid();
  const forcedShul = req.user.role === 'shul' ? db.prepare('SELECT * FROM shuls WHERE id = ?').get(req.user.shul_id) : null;
  // Same shul-info-complete gate as POST / and complete-reenrollment (#147)
  // — a shul-portal bulk upload is still "submitting applicants," all-or-
  // nothing like the rest of this route's validation.
  if (forcedShul) {
    const shulErrors = shulInfoErrors(forcedShul);
    if (shulErrors.length) return res.status(400).json({ error: `Please complete your shul's information before submitting applicants: ${shulErrors.join('; ')}`, code: 'SHUL_INFO_INCOMPLETE' });
  }
  // One-time backfill flag (spec: "import shuls and applicants for another
  // season, that should never load onto disccard") — every row in this
  // import is marked provider_exempt, which the approve routes below check
  // before making any disccardpromos call at all, permanently, regardless
  // of what happens to the applicant afterward.
  const providerExempt = req.body.provider_exempt === 'true' || req.body.provider_exempt === true ? 1 : 0;

  // A row with a non-blank `id` column that matches an existing applicant
  // is an edit, not a new submission — the file Export Excel produces,
  // edited in place and re-uploaded. A shul-portal upload can only match
  // its own applicants (same boundary forcedShul already enforces on
  // create) — a match against someone else's applicant is treated as not
  // found rather than granting cross-shul edit access.
  const rowExisting = rows.map(r => {
    const id = r.id ? String(r.id).trim() : '';
    if (!id) return null;
    const rec = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!rec) return null;
    if (forcedShul && rec.shul_id !== forcedShul.id) return null;
    return rec;
  });

  // All-or-nothing: every true-create row must have every field the fixed
  // Applicant Application question set (utils/builtinSchemas.js) requires,
  // or nothing in the sheet is imported — no partial imports. An admin
  // uploading a sheet normally gets just the "Admin can override" leniency
  // the public form/shul-portal upload never does; bypass_required (admin
  // only, same idea as the single admin-add's bypass_required checkbox)
  // skips this whole check for the entire sheet. first_name/last_name stay
  // hard-required per new row below regardless — a nameless record isn't
  // useful even as a placeholder. shul_name isn't one of the fixed
  // questions (shul assignment isn't part of the intake questions) —
  // checked separately, and only for an admin upload; a shul-portal
  // upload's shul is always forced to their own, and shul_name is never
  // bypassable since without a shul a new row has nowhere to go. Update
  // rows skip all of this — they're patching specific cells on a record
  // that's already valid, not submitting a fresh application.
  const isAdminSubmitter = req.user.role !== 'shul';
  const bypassRequired = isAdminSubmitter && (req.body.bypass_required === 'true' || req.body.bypass_required === true);
  const schemaErrors = bypassRequired ? [] : validateRowsBySchema(getEffectiveSchema('applicant_application'), rows, { isAdmin: isAdminSubmitter, skipKeys: ['shul_id'] })
    .filter(e => !rowExisting[e.row - 2]);
  const shulNameErrors = forcedShul ? [] : rows.map((r, i) => (!rowExisting[i] && !r.shul_name) ? { row: i + 2, error: 'Missing required field: shul_name' } : null).filter(Boolean);
  const idNotFoundErrors = rows.map((r, i) => (r.id && String(r.id).trim() && !rowExisting[i]) ? { row: i + 2, error: `No existing applicant found with id "${r.id}"` } : null).filter(Boolean);
  // Update rows (matched by id) skip validateRowsBySchema entirely (see
  // rowExisting above) since a blank cell there means "leave alone," not
  // "missing" — but a non-blank phone cell still has to be a real phone
  // number, so that one check runs separately here.
  const updatePhoneErrors = rows.map((r, i) => {
    if (!rowExisting[i]) return null;
    const bad = [['home_phone', 'Home Phone'], ['husband_cell', 'Husband Cell'], ['wife_cell', 'Wife Cell']].find(([f]) => r[f] && !isValidPhone(r[f]));
    return bad ? { row: i + 2, error: `${bad[1]} must be a valid phone number (10 digits, or 11 digits starting with 1)` } : null;
  }).filter(Boolean);
  const requiredErrors = [...schemaErrors, ...shulNameErrors, ...idNotFoundErrors, ...updatePhoneErrors].sort((a, b) => a.row - b.row);
  if (requiredErrors.length) {
    return res.status(400).json({ error: 'Some rows have errors. Nothing was imported — fix the sheet and re-upload.', errors: requiredErrors });
  }

  let success = 0, dupes = 0, updated = 0; const errors = [];
  const createdIds = [], createdNames = [], updatedIds = [], updatedNames = [];
  // Per-row "what did this column used to say" snapshot, captured right
  // before each UPDATE — this is what makes mass-import undo (see
  // services/audit.js undoMassImportEntry) able to actually restore an
  // edited row instead of just deleting the newly-created ones.
  const updatedDiffs = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const existing = rowExisting[i];
    if (existing) {
      try {
        const sets = Object.keys(APPLICANT_UPDATABLE_FIELDS).filter(f => { const v = APPLICANT_UPDATABLE_FIELDS[f](r); return v !== undefined && v !== ''; });
        const vals = sets.map(f => APPLICANT_UPDATABLE_FIELDS[f](r));
        const yomtovRaw = String(r.home_for_yomtov ?? '').trim();
        if (yomtovRaw !== '') { sets.push('home_for_yomtov'); vals.push(/^(y|yes|true|1)$/i.test(yomtovRaw) ? 1 : 0); }
        if (sets.length) {
          db.prepare(`UPDATE applicants SET ${sets.map(f => `${f}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`).run(...vals, existing.id);
          updatedIds.push(existing.id); updatedNames.push(`${existing.first_name} ${existing.last_name}`.trim());
          updatedDiffs.push({ id: existing.id, before: Object.fromEntries(sets.map(f => [f, existing[f]])) });
          // Same "only flag what the edit itself newly caused" re-check as
          // PUT /:id — a re-uploaded sheet is just as much an edit as
          // typing into the form, and shouldn't re-flag a match that was
          // already sitting there on both sides before this row was
          // updated.
          detectAndFlag(req.user.org_id, 'applicant', db.prepare('SELECT * FROM applicants WHERE id = ?').get(existing.id), [], existing);
        }
        updated++;
      } catch (e) {
        errors.push({ row: i + 2, error: e.message });
      }
      continue;
    }
    if (!r.first_name || !r.last_name) { errors.push({ row: i + 2, error: 'Missing first_name or last_name' }); continue; }
    let shul = forcedShul;
    if (!shul) {
      shul = r.shul_name ? db.prepare('SELECT * FROM shuls WHERE org_id = ? AND name_en = ?').get(req.user.org_id, r.shul_name) : null;
      if (!shul) { errors.push({ row: i + 2, error: `Shul not found: "${r.shul_name || ''}" (must match an existing shul name exactly)` }); continue; }
    }
    if (shul.is_paused) { errors.push({ row: i + 2, error: `Shul "${shul.name_en}" is paused` }); continue; }
    const capError = seasonCapacityError(shul.season_id);
    if (capError) { errors.push({ row: i + 2, error: capError }); continue; }
    try {
      const id = uuid();
      // Zip-restricted rows are auto-rejected silently — the upload still
      // reports as a normal success so the submitting shul is never told.
      // A shul-portal upload's brand-new rows (not matched by id — see
      // rowExisting above) land as 'draft', not 'pending': they don't count
      // against slots or show up as real submissions until the shul
      // explicitly picks which ones to submit (POST /mass-submit-drafts).
      // An admin's own upload is unaffected — admin rows go straight to
      // 'pending' as before, same as every other admin-submitted row.
      const initialStatus = !isZipAllowed(req.user.org_id, r.zip) ? 'rejected' : (isAdminSubmitter ? 'pending' : 'draft');
      db.prepare(`INSERT INTO applicants (id, org_id, shul_id, season_id, external_id, first_name, last_name, marital_status, home_phone, husband_cell, wife_cell, email,
          address, city, state, zip, preferred_contact_method, preferred_number, num_children, home_for_yomtov, card_amount, comments, source, approval_status, provider_exempt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?, 'mass_upload', ?, ?)`)
        .run(id, req.user.org_id, shul.id, shul.season_id, generateApplicantExternalId(db), r.first_name, r.last_name, r.marital_status || '', normalizePhone(r.home_phone || ''), normalizePhone(r.husband_cell || ''), normalizePhone(r.wife_cell || ''), r.email || '',
          r.address || '', r.city || '', r.state || '', r.zip || '', r.preferred_contact_method || '', r.preferred_number || '', +r.num_children || 0,
          /^(y|yes|true|1)$/i.test(String(r.home_for_yomtov || '')) ? 1 : 0, r.card_amount ? +r.card_amount : null, r.comments || '', initialStatus, providerExempt);
      const applicant = db.prepare('SELECT * FROM applicants WHERE id = ?').get(id);
      const flag = detectAndFlag(req.user.org_id, 'applicant', applicant);
      createdIds.push(id); createdNames.push(`${applicant.first_name} ${applicant.last_name}`.trim());
      if (flag && req.user.role !== 'shul') dupes++; else success++;
    } catch (e) {
      errors.push({ row: i + 2, error: e.message });
    }
  }
  db.prepare(`INSERT INTO import_jobs (id, org_id, entity_type, file_name, status, total_rows, success_count, error_count, duplicate_count, error_log, created_by)
    VALUES (?,?,?,?,'completed',?,?,?,?,?,?)`)
    .run(jobId, req.user.org_id, 'applicants', req.file.originalname, rows.length, success, errors.length, dupes, JSON.stringify(errors), req.user.id);
  logMassAudit(req.user.org_id, req.user.id, 'mass-import', 'applicant', [...createdIds, ...updatedIds],
    { created: createdIds.length, updated: updatedIds.length, duplicates: dupes, errors: errors.length, names: [...createdNames, ...updatedNames], createdIds, updatedIds, updatedDiffs }, req.ip);
  res.json({ jobId, total: rows.length, success, updated, duplicates: dupes, errors });
});

// season_id (optional) scopes this to flags whose FLAGGED applicant
// (entity_id) belongs to that season. Matching itself only ever happens
// within one season to begin with (see services/duplicates.js's
// checkApplicantDuplicate — a returning family reapplying next season isn't
// a duplicate), so this filter is just keeping flags for a *different*
// season's applicant entirely out of whatever season the admin is currently
// working in.
// One-time (re-runnable) cleanup for the 'incomplete' fix above — see
// services/duplicates.js's recheckAllApplicantDuplicates for exactly what it
// does. season_id optional; org-wide when omitted.
router.post('/duplicates/recheck-all', requireAdmin, (req, res) => {
  const result = recheckAllApplicantDuplicates(req.user.org_id, req.body?.season_id || null);
  logAudit(req.user.org_id, req.user.id, 'mass-recheck-duplicates', 'applicant', null, null,
    { count: result.cleared + result.flagged, cleared: result.cleared, checked: result.checked, flagged: result.flagged }, req.ip);
  res.json(result);
});

router.get('/duplicates/open', requireAdmin, (req, res) => {
  const { season_id } = req.query;
  const rows = season_id
    ? db.prepare(`SELECT df.* FROM duplicate_flags df JOIN applicants a ON a.id = df.entity_id
        WHERE df.org_id = ? AND df.entity_type='applicant' AND df.status='open' AND a.season_id = ? ORDER BY df.created_at DESC`).all(req.user.org_id, season_id)
    : db.prepare(`SELECT * FROM duplicate_flags WHERE org_id = ? AND entity_type='applicant' AND status='open' ORDER BY created_at DESC`).all(req.user.org_id);
  const withEntities = rows.map(r => ({
    ...r,
    entity: db.prepare('SELECT a.*, s.name_en as shul_name FROM applicants a LEFT JOIN shuls s ON s.id=a.shul_id WHERE a.id = ?').get(r.entity_id),
    matched: db.prepare('SELECT a.*, s.name_en as shul_name FROM applicants a LEFT JOIN shuls s ON s.id=a.shul_id WHERE a.id = ?').get(r.matched_entity_id),
  }));
  res.json({ flags: withEntities });
});

router.post('/duplicates/:flagId/resolve', requirePermission('applicants', 'can_edit'), (req, res) => {
  const { action } = req.body || {};
  try {
    const result = resolveFlag(req.params.flagId, req.user.id, action);
    if (!result) return res.status(404).json({ error: 'Not found' });
    const { flag, undoSnapshot } = result;
    logAudit(req.user.org_id, req.user.id, 'resolve_duplicate', 'applicant', flag.entity_id, undoSnapshot, flag, req.ip);
    res.json({ flag });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Full merge group for a flag — every applicant confirmed (or provisionally,
// via a chain of open flags) to be the same real person, which can be more
// than a pair: the same family can get submitted by three, four, five
// different shuls in one season. Used to render a merge comparison with one
// column per member, not just two.
router.get('/duplicates/:flagId/group', requireAdmin, (req, res) => {
  const flag = db.prepare(`SELECT * FROM duplicate_flags WHERE id = ? AND org_id = ? AND entity_type='applicant'`).get(req.params.flagId, req.user.org_id);
  if (!flag) return res.status(404).json({ error: 'Not found' });
  // ?ids= lets a caller re-fetch the CURRENT state of an already-established
  // working set instead of re-deriving the transitive closure from scratch
  // (getMergeGroupIds always reseeds from this flag's own two original
  // entities — once THEIR connecting flags close, one-by-one, during a
  // multi-step pairwise merge, re-deriving from scratch can silently lose
  // members still connected to each other but no longer to the original
  // seed pair). The frontend's pairwise compare-and-merge flow captures the
  // full group once on first open and passes it back on every refresh so
  // nobody it already surfaced ever quietly disappears mid-review. Always
  // re-scoped to this org regardless of what the client sends.
  const explicitIds = typeof req.query.ids === 'string' ? req.query.ids.split(',').filter(Boolean) : null;
  const ids = explicitIds && explicitIds.length ? explicitIds : getMergeGroupIds(req.user.org_id, [flag.entity_id, flag.matched_entity_id]);
  const placeholders0 = ids.map(() => '?').join(',');
  const members = db.prepare(`SELECT a.*, s.name_en as shul_name, ps.name_en as previous_shul_name FROM applicants a
    LEFT JOIN shuls s ON s.id = a.shul_id LEFT JOIN shuls ps ON ps.id = a.previous_shul_id
    WHERE a.id IN (${placeholders0}) AND a.org_id = ?`).all(...ids, req.user.org_id);
  const e = members.find(m => m.id === flag.entity_id), m = members.find(m => m.id === flag.matched_entity_id);
  // Every open flag connecting any two members of this group (not just the
  // single flag this view was opened from) — the pairwise compare-and-merge
  // UI needs this to know, for whichever two members the admin picks, which
  // reason they were actually flagged for and whether a real flag even
  // exists between them (only a direct one can be bypassed; two members
  // that are only transitively related through a third have nothing to
  // bypass — see mergeApplicants/getMergeGroupIds in services/duplicates.js).
  const placeholders = ids.map(() => '?').join(',');
  const flags = db.prepare(`SELECT * FROM duplicate_flags WHERE org_id = ? AND entity_type='applicant' AND status='open'
    AND entity_id IN (${placeholders}) AND matched_entity_id IN (${placeholders})`).all(req.user.org_id, ...ids, ...ids);
  res.json({ flag, members, flags, sharesPhone: !!(e && m && applicantsSharePhone(e, m)) });
});

// Forces this flag's whole merge group to be resolved as one confirmed
// duplicate. `primaryId` picks which member keeps going forward as the real
// card-holder; `values` is the admin's field-by-field chosen composite
// (mixed and matched across members) written onto that primary only — every
// other member's own row is left untouched, so each shul keeps seeing
// exactly what it itself submitted.
router.post('/duplicates/:flagId/merge', requirePermission('applicants', 'can_edit'), (req, res) => {
  const flag = db.prepare(`SELECT * FROM duplicate_flags WHERE id = ? AND org_id = ? AND entity_type='applicant'`).get(req.params.flagId, req.user.org_id);
  if (!flag) return res.status(404).json({ error: 'Not found' });
  const { primaryId, values, memberIds } = req.body || {};
  try {
    const result = mergeApplicants(req.user.org_id, req.user.id, { primaryId, values, memberIds });
    const { undoSnapshot, ...after } = result;
    logAudit(req.user.org_id, req.user.id, 'merge', 'applicant', primaryId, undoSnapshot, after, req.ip);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ============================= Rejection Appeals =============================
// A shul asking "why was this rejected" — one click, no form (see
// applicant_rejection_appeals). Available to whichever shul actually
// submitted it, including a merged applicant's non-owning contributor (see
// applicant_submissions) — same access rule as GET /:id above.
router.post('/:id/appeal', (req, res) => {
  if (req.user.role !== 'shul') return res.status(403).json({ error: 'Not permitted' });
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  const isOwner = applicant.shul_id === req.user.shul_id;
  const hasSubmission = isOwner || db.prepare('SELECT 1 FROM applicant_submissions WHERE applicant_id = ? AND shul_id = ?').get(applicant.id, req.user.shul_id);
  if (!hasSubmission) return res.status(403).json({ error: 'Not your applicant' });
  if (applicant.approval_status !== 'rejected') return res.status(400).json({ error: 'This applicant is not currently rejected' });
  // Idempotent — clicking twice (or a stray double-click, same reasoning as
  // the double-click guard on the mass Email/SMS buttons) just returns the
  // existing open appeal rather than creating a second one.
  const existing = db.prepare(`SELECT * FROM applicant_rejection_appeals WHERE applicant_id = ? AND shul_id = ? AND status = 'open'`).get(applicant.id, req.user.shul_id);
  if (existing) return res.json({ appeal: existing });
  const id = uuid();
  db.prepare(`INSERT INTO applicant_rejection_appeals (id, org_id, applicant_id, shul_id) VALUES (?,?,?,?)`).run(id, req.user.org_id, applicant.id, req.user.shul_id);
  res.status(201).json({ appeal: db.prepare('SELECT * FROM applicant_rejection_appeals WHERE id = ?').get(id) });
});

// Open appeals, admin-only — backs the Appeals button's tally badge and its
// list modal on the Applicants page (same pattern as GET /duplicates/open).
router.get('/appeals/open', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT ap.*, a.first_name, a.last_name, a.external_id, sh.name_en AS shul_name
    FROM applicant_rejection_appeals ap
    JOIN applicants a ON a.id = ap.applicant_id
    JOIN shuls sh ON sh.id = ap.shul_id
    WHERE ap.org_id = ? AND ap.status = 'open' ORDER BY ap.created_at`).all(req.user.org_id);
  res.json({ appeals: rows });
});

// Only the fields a shul's own read-only view already shows it (see
// openApplicantReadOnly in shul-portal/dashboard.html) — an explicit
// allowlist, not the raw applicant row, since that also carries
// admin-internal columns (permanent_comments, provider_account_id,
// min_contribution_override, ...) a shul must never see.
const APPEAL_NOTICE_FIELDS = [
  ['external_id', 'Applicant ID'], ['first_name', 'First Name'], ['last_name', 'Last Name'],
  ['marital_status', 'Marital Status'], ['num_children', 'Children'], ['home_phone', 'Home Phone'],
  ['husband_cell', 'Husband Cell'], ['wife_cell', 'Wife Cell'], ['email', 'Email'],
  ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['zip', 'Zip'],
  ['home_for_yomtov', 'Home for Yom Tov'], ['comments', 'Comments'],
];
// Admin answers an appeal — saves the reason (also onto the applicant row
// itself, so it shows without a join wherever the status badge does), marks
// the appeal answered, and sends the shul an Update (same tables
// routes/updates.js's own compose-and-send writes to) with the full
// applicant info plus the reason.
router.post('/appeals/:appealId/respond', requireAdmin, async (req, res) => {
  const appeal = db.prepare('SELECT * FROM applicant_rejection_appeals WHERE id = ? AND org_id = ?').get(req.params.appealId, req.user.org_id);
  if (!appeal) return res.status(404).json({ error: 'Not found' });
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required' });
  const trimmedReason = reason.trim();
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ?').get(appeal.applicant_id);
  if (!applicant) return res.status(404).json({ error: 'Applicant no longer exists' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ?').get(appeal.shul_id);

  db.prepare(`UPDATE applicant_rejection_appeals SET status='answered', reason=?, responded_by=?, responded_at=datetime('now') WHERE id=?`).run(trimmedReason, req.user.id, appeal.id);
  db.prepare(`UPDATE applicants SET rejection_reason=? WHERE id=?`).run(trimmedReason, applicant.id);

  // If this appeal came from a merged non-owning contributor (see
  // applicant_submissions), show THEIR own submitted copy in the notice —
  // never the surviving row's own (possibly different-shul's) data.
  let info = applicant;
  if (appeal.shul_id !== applicant.shul_id) {
    const ownSubmission = db.prepare('SELECT * FROM applicant_submissions WHERE applicant_id = ? AND shul_id = ?').get(applicant.id, appeal.shul_id);
    if (ownSubmission) info = { ...applicant, ...Object.fromEntries(SUBMISSION_OVERLAY_FIELDS.map(f => [f, ownSubmission[f]])) };
  }
  const detailRows = APPEAL_NOTICE_FIELDS
    .filter(([k]) => info[k] !== null && info[k] !== undefined && info[k] !== '')
    .map(([k, label]) => `<tr><td style="padding:3px 12px 3px 0;color:#6b6b6b;white-space:nowrap">${escapeHtml(label)}</td><td style="padding:3px 0">${escapeHtml(k === 'home_for_yomtov' ? (info[k] ? 'Yes' : 'No') : info[k])}</td></tr>`)
    .join('');
  const title = `Rejection reason: ${info.first_name} ${info.last_name}`.trim();
  const bodyHtml = `
    <p>Here is the reason your applicant was rejected, along with their full submitted information:</p>
    <p><strong>Reason:</strong><br>${escapeHtml(trimmedReason).replace(/\n/g, '<br>')}</p>
    ${detailRows ? `<table style="border-collapse:collapse;margin-top:10px">${detailRows}</table>` : ''}
  `;
  const updateId = uuid();
  db.prepare(`INSERT INTO updates (id, org_id, title, body, created_by) VALUES (?,?,?,?,?)`).run(updateId, req.user.org_id, title, bodyHtml, req.user.id);
  let emailStatus = 'sent', emailError = null;
  if (shul?.gabai_email) {
    const result = await sendMailChecked(req.user.org_id, shul.gabai_email, title, bodyHtml, { relatedEntityType: 'shul', relatedEntityId: shul.id, sentBy: req.user.id });
    if (result.emailError) { emailStatus = 'failed'; emailError = result.emailError; }
  } else { emailStatus = 'failed'; emailError = 'No email on file'; }
  db.prepare(`INSERT INTO update_recipients (id, update_id, entity_type, entity_id, email_status, email_error) VALUES (?,?,?,?,?,?)`)
    .run(uuid(), updateId, 'shul', appeal.shul_id, emailStatus, emailError);

  logAudit(req.user.org_id, req.user.id, 'respond-appeal', 'applicant', applicant.id, { rejection_reason: null }, { rejection_reason: trimmedReason }, req.ip);
  res.json({ ok: true, emailError });
});

export default router;
