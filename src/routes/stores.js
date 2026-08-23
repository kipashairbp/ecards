import { Router } from 'express';
import multer from 'multer';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { db, uuid, DEFAULT_ORG_ID, DATA_DIR } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { requirePermission, redact } from '../middleware/permissions.js';
import { sendMailChecked, renderSystemTemplate, notifyNewSignup } from '../services/mail.js';
import { sendXlsx } from '../services/xlsx.js';
import { normalizePhone, isValidPhone } from '../utils/phone.js';
import { validateBySchema } from '../utils/formValidation.js';
import { STORE_APPLICATION_SCHEMA } from '../utils/builtinSchemas.js';
import { logAudit, logMassAudit, getEntityHistory } from '../services/audit.js';
import { deletePolymorphicRefs } from '../utils/entityDelete.js';
import { generateGenericDocumentPdf } from '../services/pdf.js';
import { resolveEntity } from './documents.js';

const router = Router();
const billUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const BILLS_DIR = join(DATA_DIR, 'store-bills');

// Public: store self-application (mirrors the shul public form) — spec #9 says
// stores can be added by admin OR sign up themselves. Starts at setup_status
// 'pending'; admin reviews and invites to the portal same as an admin-added
// store. Fixed question set (see utils/builtinSchemas.js) — no longer driven
// by an editable Form Builder row.
router.post('/apply', async (req, res) => {
  const orgId = req.body.org_id || DEFAULT_ORG_ID;
  const b = req.body || {};
  const errors = validateBySchema(STORE_APPLICATION_SCHEMA, b, { isAdmin: false });
  if (errors.length) return res.status(400).json({ error: errors[0] });
  if (!b.name || !b.owner_email) return res.status(400).json({ error: 'Store name and owner email are required' });
  const id = uuid();
  const samePerson = !!b.same_person;
  db.prepare(`INSERT INTO stores (id, org_id, name, address, city, state, zip, phone, pos_system, manager_name, manager_phone, manager_email,
      owner_name, owner_phone, owner_email, same_person, comments, setup_status, has_provider_account, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,'pending',?, 'application')`)
    .run(id, orgId, b.name, b.address || '', b.city || '', b.state || '', b.zip || '',
      normalizePhone(b.phone || ''), b.pos_system || '',
      samePerson ? b.owner_name || '' : b.manager_name || '', samePerson ? normalizePhone(b.owner_phone || '') : normalizePhone(b.manager_phone || ''), samePerson ? b.owner_email || '' : b.manager_email || '',
      b.owner_name || '', normalizePhone(b.owner_phone || ''), b.owner_email, samePerson ? 1 : 0,
      b.comments || '', b.has_provider_account ? 1 : 0);
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
  await notifyNewSignup(orgId, 'notify_new_store_signup_email', 'newStoreSignup', {
    storeName: store.name, contactName: store.owner_name || store.manager_name || '',
    contactEmail: store.owner_email || store.manager_email || '', contactPhone: store.owner_phone || store.manager_phone || '',
  });

  const signAtSignup = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'store_contract_at_signup'`).get(orgId)?.value !== '0';
  if (!signAtSignup) {
    // No agreement at signup — just a plain "we received it" email, not the
    // actual agreement. The real one gets sent later as a deliberate,
    // separate step (Store detail > Documents tab), not automatically here.
    const tmpl = renderSystemTemplate(orgId, 'applicationReceived', { entityName: store.name });
    const { emailError } = await sendMailChecked(orgId, store.owner_email || store.manager_email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo });
    if (emailError) console.error('[mail] application-received email failed:', emailError);
    return res.status(201).json({ store, contractAtSignup: false, message: "Application received. We'll be in touch." });
  }
  res.status(201).json({ store, contractAtSignup: true, message: 'Application received. We will reach out once your store is reviewed and approved.' });
});

// Public: immediately generate the store's participation agreement right
// after application submission, so it can be signed in the same sitting —
// same "fill out a form, then esign right here" flow as shuls (see
// shuls.js POST /:id/generate-contract), just backed by the generic
// documents system instead of a dedicated contracts table. Only ever called
// by apply-store.html when Settings > Documents > Store Agreement has
// "Require signing during signup" turned on — when it's off, /apply sends a
// plain "we received it" email instead and this route is never reached.
// Idempotent per store. Signing itself goes through documents.js's public
// token endpoints (GET/POST /documents/sign/:token...) since a store's
// agreement is just another entity_type='store' document.
router.post('/:id/generate-contract', async (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.params.id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  const existing = db.prepare(`SELECT * FROM documents WHERE org_id = ? AND entity_type = 'store' AND entity_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(store.org_id, store.id);
  if (existing) return res.json({ sign_token: existing.status === 'signed' ? null : existing.sign_token, alreadySigned: existing.status === 'signed' });

  const entity = resolveEntity('store', store.id, store.org_id);
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(store.org_id);
  const templateSetting = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'document_template_text_store'`).get(store.org_id);
  const pdfPath = await generateGenericDocumentPdf({
    entityType: 'store', entityId: store.id, title: 'Store Participation Agreement', fieldLines: entity.fieldLines,
    templateText: templateSetting?.value, orgName: org?.name,
    record: entity.record, extra: entity.extra, orgId: store.org_id,
  });
  const id = uuid();
  const token = uuid();
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO documents (id, org_id, entity_type, entity_id, title, pdf_path, status, sign_token, sign_token_expires, sent_at)
    VALUES (?,?,'store',?,?,?,'sent',?,?,datetime('now'))`).run(id, store.org_id, store.id, 'Store Participation Agreement', pdfPath, token, expires);
  res.json({ sign_token: token, alreadySigned: false });
});

router.use(auth, requirePermission('stores'));

function scopeWhere(req) {
  let where = 'WHERE org_id = ?';
  const params = [req.user.org_id];
  if (req.user.role === 'store') { where += ' AND id = ?'; params.push(req.user.store_id); }
  else if (req.permission.scope === 'assigned') {
    where += ` AND id IN (SELECT entity_id FROM user_assignments WHERE user_id = ? AND entity_type = 'store')`;
    params.push(req.user.id);
  }
  return { where, params };
}

router.get('/', (req, res) => {
  const { search, setup_status } = req.query;
  let { where, params } = scopeWhere(req);
  if (setup_status) { where += ' AND setup_status = ?'; params.push(setup_status); }
  if (search) { where += ' AND (name LIKE ? OR city LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  const stores = db.prepare(`SELECT * FROM stores ${where} ORDER BY created_at DESC`).all(...params);
  // Live spend per store — computed fresh on every request from the synced
  // transaction ledger, not cached, so it's always current as of the last sync.
  const spendStmt = db.prepare(`SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END),0) total_purchases,
    COALESCE(SUM(CASE WHEN type='refund' THEN amount ELSE 0 END),0) total_refunds, COUNT(*) txn_count
    FROM card_transactions WHERE store_id = ?`);
  const withSpend = stores.map(s => ({ ...s, ...spendStmt.get(s.id) }));
  res.json({ stores: redact(withSpend, req.permission.hidden_fields) });
});

// Full-detail CSV export — every field. Must be registered before /:id.
router.get('/export', requirePermission('stores', 'can_export'), (req, res) => {
  const { search, setup_status } = req.query;
  let { where, params } = scopeWhere(req);
  if (setup_status) { where += ' AND setup_status = ?'; params.push(setup_status); }
  if (search) { where += ' AND (name LIKE ? OR city LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  const stores = db.prepare(`SELECT * FROM stores ${where} ORDER BY created_at DESC`).all(...params);
  const withSpend = stores.map(s => {
    const totals = db.prepare(`SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END),0) total_purchases, COALESCE(SUM(CASE WHEN type='refund' THEN amount ELSE 0 END),0) total_refunds FROM card_transactions WHERE store_id = ?`).get(s.id);
    return { ...s, total_purchases: totals.total_purchases, total_refunds: totals.total_refunds };
  });
  sendXlsx(res, `stores-${Date.now()}.xlsx`, redact(withSpend, req.permission.hidden_fields));
});

router.get('/:id', (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'store' && store.id !== req.user.store_id) return res.status(403).json({ error: 'Not your store' });
  const transactionTotals = db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END),0) total_purchases,
    COALESCE(SUM(CASE WHEN type='refund' THEN amount ELSE 0 END),0) total_refunds
    FROM card_transactions WHERE store_id = ?`).get(store.id);
  // A store's own portal login sees its total purchases (their own sales
  // figure) but not transaction count or refund totals — internal-only
  // numbers a store shouldn't be able to reconstruct their transaction
  // history's shape from.
  if (req.user.role === 'store') { delete transactionTotals.count; delete transactionTotals.total_refunds; }
  res.json({ store: redact(store, req.permission.hidden_fields), transactionTotals });
});

// Who edited this record and when — not shown to the store viewing their own record.
router.get('/:id/history', requireAdmin, (req, res) => {
  const store = db.prepare('SELECT id FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  res.json({ history: getEntityHistory(req.user.org_id, 'store', store.id) });
});

// Stores are one persistent record reused every season (unlike shuls and
// applicants, which get a fresh record each season) — so "other seasons"
// for a store means its real per-season activity, derived from the
// transaction ledger rather than a separate status table.
router.get('/:id/season-history', requireAdmin, (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  const seasons = db.prepare(`SELECT c.season_id, se.name AS season_name, COUNT(*) AS txn_count,
      COALESCE(SUM(CASE WHEN ct.amount < 0 THEN -ct.amount ELSE 0 END),0) AS total_purchases,
      COALESCE(SUM(CASE WHEN ct.type='refund' THEN ct.amount ELSE 0 END),0) AS total_refunds
    FROM card_transactions ct JOIN cards c ON c.id = ct.card_id LEFT JOIN seasons se ON se.id = c.season_id
    WHERE ct.store_id = ? GROUP BY c.season_id ORDER BY se.created_at DESC`).all(store.id);
  res.json({ seasons });
});

router.post('/', requirePermission('stores', 'can_edit'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Store name is required' });
  for (const [f, label] of [['phone', 'Store Phone'], ['manager_phone', 'Manager Phone'], ['owner_phone', 'Owner Phone']]) {
    if (!isValidPhone(b[f])) return res.status(400).json({ error: `${label} must be a valid phone number (10 digits, or 11 digits starting with 1)` });
  }
  const id = uuid();
  db.prepare(`INSERT INTO stores (id, org_id, name, address, city, state, zip, phone, pos_system, manager_name, manager_phone, manager_email,
      owner_name, owner_phone, owner_email, same_person, comments, setup_status, has_provider_account)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?)`)
    .run(id, req.user.org_id, b.name, b.address || '', b.city || '', b.state || '', b.zip || '', normalizePhone(b.phone || ''), b.pos_system || '',
      b.manager_name || '', normalizePhone(b.manager_phone || ''), b.manager_email || '', b.owner_name || '', normalizePhone(b.owner_phone || ''), b.owner_email || '',
      b.same_person ? 1 : 0, b.comments || '', b.setup_status || 'pending', b.has_provider_account ? 1 : 0);
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
  logAudit(req.user.org_id, req.user.id, 'create', 'store', id, null, store, req.ip);
  res.status(201).json({ store });
});

router.put('/:id', requirePermission('stores', 'can_edit'), (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  const fields = ['name','address','city','state','zip','phone','pos_system','manager_name','manager_phone','manager_email','owner_name','owner_phone','owner_email','same_person','comments','setup_status','has_provider_account','provider_store_id'];
  const b = req.body || {};
  if (b.phone !== undefined) b.phone = normalizePhone(b.phone);
  if (b.manager_phone !== undefined) b.manager_phone = normalizePhone(b.manager_phone);
  if (b.owner_phone !== undefined) b.owner_phone = normalizePhone(b.owner_phone);
  for (const [f, label] of [['phone', 'Store Phone'], ['manager_phone', 'Manager Phone'], ['owner_phone', 'Owner Phone']]) {
    if (!isValidPhone(b[f])) return res.status(400).json({ error: `${label} must be a valid phone number (10 digits, or 11 digits starting with 1)` });
  }
  const sets = fields.filter(f => b[f] !== undefined);
  if (sets.length) {
    const vals = sets.map(f => (f === 'has_provider_account' || f === 'same_person') ? (b[f] ? 1 : 0) : b[f]);
    db.prepare(`UPDATE stores SET ${sets.map(f=>`${f}=?`).join(',')} WHERE id=?`).run(...vals, store.id);
    logAudit(req.user.org_id, req.user.id, 'update', 'store', store.id, Object.fromEntries(sets.map(f => [f, store[f]])), Object.fromEntries(sets.map((f,i) => [f, vals[i]])), req.ip);
  }
  res.json({ store: db.prepare('SELECT * FROM stores WHERE id = ?').get(store.id) });
});

const STORE_STATUSES = ['pending', 'in_progress', 'active', 'inactive'];
router.post('/mass-set-status', requirePermission('stores', 'can_edit'), (req, res) => {
  const { ids, setup_status } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  if (!STORE_STATUSES.includes(setup_status)) return res.status(400).json({ error: `setup_status must be one of: ${STORE_STATUSES.join(', ')}` });
  let updated = 0, skipped = 0;
  const affectedIds = [], names = [];
  for (const id of ids) {
    const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!store) { skipped++; continue; }
    db.prepare('UPDATE stores SET setup_status = ? WHERE id = ?').run(setup_status, store.id);
    affectedIds.push(store.id); names.push(store.name);
    updated++;
  }
  logMassAudit(req.user.org_id, req.user.id, 'mass-set-status', 'store', affectedIds, { skipped, setup_status, names }, req.ip);
  res.json({ updated, skipped });
});

// Permanent deletion — full removal. Card transactions against this store
// are kept (a card's own ledger shouldn't lose history) but unlinked
// (store_id set to null) since the store record itself is gone; billing
// rows are hard-deleted since they're meaningless without the store. A
// linked portal login is deactivated, not deleted (that's user
// management's job). FK enforcement is ON, so every hard reference is
// cleaned up first, wrapped in a transaction.
router.delete('/:id/permanent', requirePermission('stores', 'can_edit'), (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  const del = db.transaction(() => {
    db.prepare('UPDATE card_transactions SET store_id = NULL WHERE store_id = ?').run(store.id);
    db.prepare('DELETE FROM store_billing WHERE store_id = ?').run(store.id);
    if (store.portal_user_id) db.prepare('UPDATE users SET is_active = 0, token_version = token_version + 1 WHERE id = ?').run(store.portal_user_id);
    deletePolymorphicRefs('store', store.id);
    db.prepare('DELETE FROM stores WHERE id = ?').run(store.id);
  });
  del();
  logAudit(req.user.org_id, req.user.id, 'delete', 'store', store.id, store, null, req.ip);
  res.json({ ok: true });
});

router.post('/mass-delete-permanent', requirePermission('stores', 'can_edit'), (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  let deleted = 0, skipped = 0;
  const affectedIds = [], names = [];
  for (const id of ids) {
    const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!store) { skipped++; continue; }
    const del = db.transaction(() => {
      db.prepare('UPDATE card_transactions SET store_id = NULL WHERE store_id = ?').run(store.id);
      db.prepare('DELETE FROM store_billing WHERE store_id = ?').run(store.id);
      if (store.portal_user_id) db.prepare('UPDATE users SET is_active = 0, token_version = token_version + 1 WHERE id = ?').run(store.portal_user_id);
      deletePolymorphicRefs('store', store.id);
      db.prepare('DELETE FROM stores WHERE id = ?').run(store.id);
    });
    del();
    affectedIds.push(store.id); names.push(store.name);
    deleted++;
  }
  logMassAudit(req.user.org_id, req.user.id, 'mass-delete', 'store', affectedIds, { skipped, names }, req.ip);
  res.json({ deleted, skipped });
});

// Shared by the single and mass invite routes below.
async function inviteStoreToPortal(orgId, store, emailOverride, sentBy = null) {
  const email = emailOverride || store.owner_email || store.manager_email;
  if (!email) return { error: 'No email on file for this store' };
  let user = db.prepare('SELECT * FROM users WHERE store_id = ?').get(store.id);
  const emailTaken = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, user?.id || '');
  if (emailTaken) return { error: `${email} is already used by another account. Update the store's contact email or that account first.` };
  const token = uuid();
  const expires = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
  if (user) {
    db.prepare('UPDATE users SET invite_token=?, invite_expires=?, email=? WHERE id=?').run(token, expires, email, user.id);
  } else {
    const uid = uuid();
    db.prepare(`INSERT INTO users (id, org_id, email, first_name, role, store_id, invite_token, invite_expires, is_active) VALUES (?,?,?,?,'store',?,?,?,0)`)
      .run(uid, orgId, email, store.manager_name || store.name, store.id, token, expires);
  }
  db.prepare(`UPDATE stores SET portal_user_id = (SELECT id FROM users WHERE store_id = ?) WHERE id = ?`).run(store.id, store.id);
  const portalUrl = `${process.env.APP_URL || ''}/accept-invite?token=${token}`;
  const tmpl = renderSystemTemplate(orgId, 'storeSetup', { storeName: store.name, portalUrl });
  const { emailError } = await sendMailChecked(orgId, email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo, sentBy });
  if (emailError) console.error('[mail] store invite email failed:', emailError);
  return { emailError };
}

// When "Require signing during signup" is ON, a store signs its agreement
// itself as part of applying (POST /documents/store-agreement), so there's
// nothing to gate here by the time an admin invites them. When it's OFF,
// nothing sends an agreement automatically — an admin has to send one from
// the store's own Documents tab first, same requirement as shuls have for
// their contract before approval.
function storeNeedsAgreementBeforeInvite(orgId, store) {
  const atSignup = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'store_contract_at_signup'`).get(orgId)?.value !== '0';
  if (atSignup) return false;
  const doc = db.prepare(`SELECT status FROM documents WHERE org_id = ? AND entity_type = 'store' AND entity_id = ? ORDER BY created_at DESC LIMIT 1`).get(orgId, store.id);
  return !doc || !['sent', 'signed'].includes(doc.status);
}

// Invite a store to their self-service portal.
router.post('/:id/invite', requirePermission('stores', 'can_edit'), async (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  if (!req.body?.bypass_contract && storeNeedsAgreementBeforeInvite(req.user.org_id, store)) {
    return res.status(400).json({ error: "This store's agreement isn't required at signup and hasn't been sent yet. Send it from the Documents tab before inviting, or bypass to skip the requirement.", code: 'CONTRACT_NOT_SENT' });
  }
  const result = await inviteStoreToPortal(req.user.org_id, store, req.body?.email, req.user.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, emailError: result.emailError });
});

router.post('/mass-invite', requirePermission('stores', 'can_edit'), async (req, res) => {
  const { ids, bypass_contract } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  let invited = 0, skipped = 0, emailErrors = 0;
  for (const id of ids) {
    const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!store) { skipped++; continue; }
    if (!bypass_contract && storeNeedsAgreementBeforeInvite(req.user.org_id, store)) { skipped++; continue; }
    const result = await inviteStoreToPortal(req.user.org_id, store, null, req.user.id);
    if (result.error) { skipped++; continue; }
    if (result.emailError) emailErrors++;
    invited++;
  }
  res.json({ invited, skipped, emailErrors });
});

// ---- Store portal onboarding wizard ----
// Steps: 1 = confirm store/contact info, 2 = billing contact + agree to terms, 3 = complete.
// Callable by the store's own portal login OR an admin walking them through it.
router.put('/:id/onboarding', (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'store' && store.id !== req.user.store_id) return res.status(403).json({ error: 'Not your store' });
  if (!['store', 'super_admin', 'org_admin', 'staff'].includes(req.user.role)) return res.status(403).json({ error: 'Not permitted' });

  const { step, info, agree_terms } = req.body || {};
  if (info) {
    if (info.phone !== undefined) info.phone = normalizePhone(info.phone);
    if (info.manager_phone !== undefined) info.manager_phone = normalizePhone(info.manager_phone);
    if (info.owner_phone !== undefined) info.owner_phone = normalizePhone(info.owner_phone);
    for (const [f, label] of [['phone', 'Store Phone'], ['manager_phone', 'Manager Phone'], ['owner_phone', 'Owner Phone']]) {
      if (!isValidPhone(info[f])) return res.status(400).json({ error: `${label} must be a valid phone number (10 digits, or 11 digits starting with 1)` });
    }
    const fields = ['name', 'address', 'city', 'state', 'zip', 'phone', 'manager_name', 'manager_phone', 'manager_email', 'owner_name', 'owner_phone', 'owner_email'];
    const sets = fields.filter(f => info[f] !== undefined);
    if (sets.length) db.prepare(`UPDATE stores SET ${sets.map(f => `${f}=?`).join(',')} WHERE id=?`).run(...sets.map(f => info[f]), store.id);
  }
  if (agree_terms) db.prepare(`UPDATE stores SET agreed_terms_at = datetime('now') WHERE id = ?`).run(store.id);

  const newStep = Math.max(store.onboarding_step || 0, +step || 0);
  const isComplete = newStep >= 3;
  db.prepare(`UPDATE stores SET onboarding_step = ?, onboarding_completed_at = CASE WHEN ? THEN COALESCE(onboarding_completed_at, datetime('now')) ELSE onboarding_completed_at END,
      setup_status = CASE WHEN setup_status = 'pending' AND ? THEN 'in_progress' ELSE setup_status END
    WHERE id = ?`).run(newStep, isComplete ? 1 : 0, newStep > 0 ? 1 : 0, store.id);

  res.json({ store: db.prepare('SELECT * FROM stores WHERE id = ?').get(store.id) });
});

// ===================== Bills a store submits TO the org =====================
// We never bill a store — a store bills us (e.g. reimbursement for
// gift-card redemptions it's already honored). A store portal login
// submits these; an admin can also log one on the store's behalf (email,
// paper) via the same endpoint. An admin reviews and marks them paid.
router.get('/:id/bill-submissions', (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'store' && store.id !== req.user.store_id) return res.status(403).json({ error: 'Not your store' });
  res.json({ bills: db.prepare('SELECT * FROM store_bill_submissions WHERE store_id = ? ORDER BY submitted_at DESC').all(store.id) });
});

router.post('/:id/bill-submissions', billUpload.single('file'), (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'store' && store.id !== req.user.store_id) return res.status(403).json({ error: 'Not your store' });
  if (req.user.role !== 'store' && req.user.role !== 'super_admin' && req.user.role !== 'org_admin' && req.user.role !== 'staff') return res.status(403).json({ error: 'Not permitted' });
  const { period, amount, description } = req.body || {};
  const amountNum = +amount;
  if (!amountNum || amountNum <= 0) return res.status(400).json({ error: 'A valid amount is required' });
  const id = uuid();
  let filePath = null, fileName = null;
  if (req.file) {
    fileName = req.file.originalname;
    const safeName = `${id}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    writeFileSync(join(BILLS_DIR, safeName), req.file.buffer);
    filePath = safeName;
  }
  db.prepare(`INSERT INTO store_bill_submissions (id, org_id, store_id, period, amount, description, file_path, file_name)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, req.user.org_id, store.id, period || '', amountNum, description || '', filePath, fileName);
  res.status(201).json({ bill: db.prepare('SELECT * FROM store_bill_submissions WHERE id = ?').get(id) });
});

router.put('/bill-submissions/:billId', requirePermission('stores', 'can_edit'), (req, res) => {
  const row = db.prepare(`SELECT b.* FROM store_bill_submissions b JOIN stores s ON s.id=b.store_id WHERE b.id=? AND s.org_id=?`).get(req.params.billId, req.user.org_id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { status, admin_notes } = req.body || {};
  db.prepare(`UPDATE store_bill_submissions SET status=COALESCE(?,status), admin_notes=COALESCE(?,admin_notes),
    reviewed_at=CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE reviewed_at END WHERE id=?`)
    .run(status, admin_notes, status, row.id);
  res.json({ bill: db.prepare('SELECT * FROM store_bill_submissions WHERE id = ?').get(row.id) });
});

// Authenticated download for a submitted bill's attachment (not a public
// static mount — these are financial documents) — either the owning
// store's own portal login, or an admin.
router.get('/bill-submissions/:billId/file', (req, res) => {
  const row = db.prepare(`SELECT b.*, s.org_id FROM store_bill_submissions b JOIN stores s ON s.id=b.store_id WHERE b.id=?`).get(req.params.billId);
  if (!row || row.org_id !== req.user.org_id) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'store' && row.store_id !== req.user.store_id) return res.status(403).json({ error: 'Not your bill' });
  if (!row.file_path) return res.status(404).json({ error: 'No file attached' });
  res.download(join(BILLS_DIR, row.file_path), row.file_name || 'bill');
});

export default router;
