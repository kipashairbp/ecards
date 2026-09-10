// Reverse lookup: given a phone number or email address as it appears on an
// SMS/email log row, find which account it belongs to (shul, store,
// applicant, or staff user). Powers the "Account" column in the SMS/Email
// Center logs — useful because inbound messages and group/broadcast sends
// don't carry a related_entity_type/id the way a single entity-triggered
// send does, so that column alone can't answer "who is this."
//
// Matches against the same normalized phone format normalizePhone() writes
// everywhere else (see db.js's normalizePhoneColumn migration), so this
// works against existing data without a backfill.
import { db } from '../db.js';
import { normalizePhone } from './phone.js';
import { getActiveSeasonId } from './formSchedule.js';

// Shuls and applicants get a fresh row every season, so the SAME phone
// number (a gabai's cell, say) can legitimately match more than one row —
// one per season they've ever been enrolled. Preferring the org's active
// season on a tie means an SMS/email thread gets attributed to the CURRENT
// enrollment, not whichever old row SQLite happened to return first; still
// falls back to any match (most recently created) if there's no
// active-season match, so historical messages stay attributable too.
function preferActiveSeason(orgId) {
  const seasonId = getActiveSeasonId(orgId);
  return { clause: seasonId ? ' ORDER BY (season_id = ?) DESC, created_at DESC' : ' ORDER BY created_at DESC', param: seasonId };
}

export function findAccountByPhone(orgId, rawPhone) {
  if (!rawPhone) return null;
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;
  const { clause, param } = preferActiveSeason(orgId);
  const orderParams = param ? [param] : [];

  const shul = db.prepare(`SELECT id, name_en AS label, season_id FROM shuls WHERE org_id = ? AND (gabai_cell = ? OR ruv_phone = ?)${clause}`).get(orgId, phone, phone, ...orderParams);
  if (shul) return { type: 'shul', id: shul.id, label: shul.label, season_id: shul.season_id };

  const store = db.prepare(`SELECT id, name AS label FROM stores WHERE org_id = ? AND (manager_phone = ? OR owner_phone = ? OR phone = ?)`).get(orgId, phone, phone, phone);
  if (store) return { type: 'store', id: store.id, label: store.label, season_id: null };

  const applicant = db.prepare(`SELECT id, (first_name || ' ' || last_name) AS label, season_id FROM applicants WHERE org_id = ? AND (husband_cell = ? OR wife_cell = ? OR home_phone = ?)${clause}`).get(orgId, phone, phone, phone, ...orderParams);
  if (applicant) return { type: 'applicant', id: applicant.id, label: applicant.label, season_id: applicant.season_id };

  const user = db.prepare(`SELECT id, (first_name || ' ' || last_name) AS label FROM users WHERE org_id = ? AND phone = ?`).get(orgId, phone);
  if (user) return { type: 'user', id: user.id, label: user.label, season_id: null };

  return null;
}

// Forward lookup — the other direction from findAccountByEmail/
// findAccountByPhone above: given a list of record ids for one known entity
// type, resolve each one's own contact info AND its own {{variable}}
// values (same field mapping/COALESCE order as those reverse lookups and
// the SMS group-send in routes/sms.js). Powers the mass Email/SMS actions
// on the Shuls/Applicants/Stores list pages — recipients are resolved
// server-side from just the checked ids, not trusted from whatever the
// client already has cached. Returns one row per id that actually has that
// channel's contact info on file (silently drops the rest rather than
// erroring). Per-recipient vars matter here: a mass send used to only be
// able to substitute ONE shared `variables` object across the whole batch
// (same {{first_name}} for everyone, or none at all) — this gives each
// recipient their own. Field names match ENTITY_TEMPLATE_VARS in
// frontend/js/app.js (varsHintHtml) — keep the two in sync.
export function resolveRecipientsForIds(orgId, entityType, ids, channel) {
  if (!ids || !ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  let rows;
  if (entityType === 'shul') {
    const contactCol = channel === 'email' ? 'gabai_email' : 'gabai_cell';
    rows = db.prepare(`SELECT id, ${contactCol} AS contact, name_en, ruv_first_name, ruv_last_name, gabai_first_name, gabai_last_name, gabai_email
      FROM shuls WHERE org_id = ? AND id IN (${placeholders})`).all(orgId, ...ids)
      .map(r => ({ id: r.id, contact: r.contact, vars: { name: r.name_en || '', rav_first_name: r.ruv_first_name || '', rav_last_name: r.ruv_last_name || '', gabai_first_name: r.gabai_first_name || '', gabai_last_name: r.gabai_last_name || '', email: r.gabai_email || '' } }));
  } else if (entityType === 'applicant') {
    const contactCol = channel === 'email' ? 'a.email' : `COALESCE(NULLIF(a.husband_cell,''), NULLIF(a.wife_cell,''), a.home_phone)`;
    rows = db.prepare(`SELECT a.id, ${contactCol} AS contact, a.first_name, a.last_name, a.external_id, a.email, s.name_en AS shul_name
      FROM applicants a LEFT JOIN shuls s ON s.id = a.shul_id WHERE a.org_id = ? AND a.id IN (${placeholders})`).all(orgId, ...ids)
      .map(r => ({ id: r.id, contact: r.contact, vars: { first_name: r.first_name || '', last_name: r.last_name || '', shul_name: r.shul_name || '', external_id: r.external_id || '', email: r.email || '' } }));
  } else if (entityType === 'store') {
    const contactCol = channel === 'email' ? `COALESCE(NULLIF(manager_email,''), owner_email)` : `COALESCE(NULLIF(manager_phone,''), owner_phone)`;
    rows = db.prepare(`SELECT id, ${contactCol} AS contact, name, manager_name, owner_name
      FROM stores WHERE org_id = ? AND id IN (${placeholders})`).all(orgId, ...ids)
      .map(r => ({ id: r.id, contact: r.contact, vars: { name: r.name || '', manager_name: r.manager_name || '', owner_name: r.owner_name || '' } }));
  } else {
    throw new Error(`Unsupported entity type: ${entityType}`);
  }
  return rows.filter(r => r.contact);
}

export function findAccountByEmail(orgId, rawEmail) {
  if (!rawEmail) return null;
  const email = String(rawEmail).trim().toLowerCase();
  if (!email) return null;
  const { clause, param } = preferActiveSeason(orgId);
  const orderParams = param ? [param] : [];

  const shul = db.prepare(`SELECT id, name_en AS label, season_id FROM shuls WHERE org_id = ? AND LOWER(gabai_email) = ?${clause}`).get(orgId, email, ...orderParams);
  if (shul) return { type: 'shul', id: shul.id, label: shul.label, season_id: shul.season_id };

  const store = db.prepare(`SELECT id, name AS label FROM stores WHERE org_id = ? AND (LOWER(manager_email) = ? OR LOWER(owner_email) = ?)`).get(orgId, email, email);
  if (store) return { type: 'store', id: store.id, label: store.label, season_id: null };

  const applicant = db.prepare(`SELECT id, (first_name || ' ' || last_name) AS label, season_id FROM applicants WHERE org_id = ? AND LOWER(email) = ?${clause}`).get(orgId, email, ...orderParams);
  if (applicant) return { type: 'applicant', id: applicant.id, label: applicant.label, season_id: applicant.season_id };

  const user = db.prepare(`SELECT id, (first_name || ' ' || last_name) AS label FROM users WHERE org_id = ? AND LOWER(email) = ?`).get(orgId, email);
  if (user) return { type: 'user', id: user.id, label: user.label, season_id: null };

  return null;
}
