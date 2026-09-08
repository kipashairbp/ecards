import { Router } from 'express';
import multer from 'multer';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { db, uuid, DATA_DIR } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { logAudit } from '../services/audit.js';
import * as googleDrive from '../services/googleDrive.js';

const router = Router();
const LIBRARY_DIR = join(DATA_DIR, 'library-documents'); // created at boot by db.js
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// PDFs, Word, Excel, PowerPoint, plain text — "PDFs Word etc." per the
// feature request. Anything else (including executables/scripts) is
// rejected outright rather than accepted and merely un-openable.
const ALLOWED_UPLOAD_TYPES = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/plain': '.txt',
};

// ============================= Google OAuth (public callback) ==============================
// Registered before the auth-gated routes below and never behind `auth` —
// Google redirects the bare browser here with no Authorization header, so
// identity/authorization for this whole flow is carried by the one-time
// `state` value minted (for an already-authenticated admin) by
// POST /google/connect-url below, not by a header on this request.
router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const entry = state ? googleDrive.consumeOAuthState(state) : null;
  if (error) return res.redirect(`/admin/library?google_error=${encodeURIComponent(String(error))}`);
  if (!entry) return res.redirect('/admin/library?google_error=' + encodeURIComponent('This connection link expired or was already used — try Connect Google Account again.'));
  try {
    const { email } = await googleDrive.connectWithCode(entry.orgId, code);
    logAudit(entry.orgId, entry.userId, 'connect', 'google_account', null, null, { email }, req.ip);
    res.redirect('/admin/library?google_connected=1');
  } catch (e) {
    res.redirect(`/admin/library?google_error=${encodeURIComponent(e.message)}`);
  }
});

// ============================= ADMIN (authenticated) ==============================
router.use(auth, requirePermission('library'));

// Connecting/disconnecting the org's ONE real Google account is a step
// above ordinary 'library' can_edit access (it's a live external credential
// with broad Drive scope) — restricted to super_admin/org_admin the same
// way other account-level actions (e.g. Delete Permanently) are elsewhere
// in this app, rather than requireAdmin's broader super_admin/org_admin/
// staff set.
function requireAccountAdmin(req, res, next) {
  if (!['super_admin', 'org_admin'].includes(req.user.role)) return res.status(403).json({ error: 'Only an org admin can connect or disconnect the Google account' });
  next();
}

router.post('/google/connect-url', requireAccountAdmin, (req, res) => {
  if (!googleDrive.isConfigured()) return res.status(400).json({ error: 'Google integration is not configured on this deploy (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI) — contact whoever manages the server.' });
  const state = googleDrive.createOAuthState(req.user.org_id, req.user.id);
  res.json({ url: googleDrive.getAuthUrl(state) });
});

router.get('/google/status', (req, res) => {
  res.json({ configured: googleDrive.isConfigured(), connected: googleDrive.getConnectedAccount(req.user.org_id) });
});

router.post('/google/disconnect', requireAccountAdmin, (req, res) => {
  googleDrive.disconnect(req.user.org_id);
  logAudit(req.user.org_id, req.user.id, 'disconnect', 'google_account', null, null, null, req.ip);
  res.json({ ok: true });
});

// A minimal staff/admin picklist for the "share with" UI — deliberately not
// GET /users (routes/users.js), which is locked to requireRole('super_admin',
// 'org_admin') for the full Users & Permissions page. A staff member who's
// been granted 'library' access but not 'users' access still needs to see
// who they can share a doc with.
router.get('/share-candidates', (req, res) => {
  const users = db.prepare(`SELECT id, first_name, last_name, email FROM users WHERE org_id = ? AND role IN ('staff','org_admin','super_admin') AND is_active = 1 ORDER BY first_name, last_name`).all(req.user.org_id);
  res.json({ users });
});

// Every doc plus who it's currently shared with (our own record of grants —
// see library_google_doc_shares' comment in db.js; Drive itself is the
// source of truth for whether the permission still exists).
router.get('/google-docs', (req, res) => {
  const docs = db.prepare(`SELECT d.*, (u.first_name || ' ' || u.last_name) AS added_by_name FROM library_google_docs d LEFT JOIN users u ON u.id = d.added_by WHERE d.org_id = ? ORDER BY d.created_at DESC`).all(req.user.org_id);
  const sharesStmt = db.prepare(`SELECT s.id, s.user_id, s.role, s.granted_at, (u.first_name || ' ' || u.last_name) AS name, u.email FROM library_google_doc_shares s JOIN users u ON u.id = s.user_id WHERE s.doc_id = ? ORDER BY s.granted_at DESC`);
  for (const d of docs) d.shares = sharesStmt.all(d.id);
  res.json({ docs });
});

router.post('/google-docs', requirePermission('library', 'can_edit'), async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Paste a Google Docs or Sheets link' });
  const fileId = googleDrive.extractFileId(url);
  if (!fileId) return res.status(400).json({ error: 'Could not find a Google file id in that link' });
  const existing = db.prepare('SELECT id FROM library_google_docs WHERE org_id = ? AND google_file_id = ?').get(req.user.org_id, fileId);
  if (existing) return res.status(409).json({ error: 'This document is already in the Library' });
  try {
    const meta = await googleDrive.verifyAndGetMetadata(req.user.org_id, fileId);
    const id = uuid();
    db.prepare(`INSERT INTO library_google_docs (id, org_id, google_file_id, title, mime_type, url, owner_email, added_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, req.user.org_id, meta.id, meta.title, meta.mimeType, meta.webViewLink || url, meta.ownerEmail, req.user.id);
    const doc = db.prepare('SELECT * FROM library_google_docs WHERE id = ?').get(id);
    doc.shares = [];
    logAudit(req.user.org_id, req.user.id, 'create', 'library_google_doc', id, null, doc, req.ip);
    res.status(201).json({ doc });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/google-docs/:id', requirePermission('library', 'can_edit'), async (req, res) => {
  const doc = db.prepare('SELECT * FROM library_google_docs WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const shares = db.prepare('SELECT * FROM library_google_doc_shares WHERE doc_id = ?').all(doc.id);
  // Removing from the Library also takes back what it granted — leaving
  // real, live Drive access behind for something no longer even visible
  // here would be exactly the "who has access to what" confusion this
  // feature exists to prevent.
  for (const s of shares) {
    try { await googleDrive.revokeAccess(req.user.org_id, doc.google_file_id, s.google_permission_id); }
    catch (e) { console.error('[library] failed to revoke Drive access on delete:', e.message); }
  }
  db.prepare('DELETE FROM library_google_doc_shares WHERE doc_id = ?').run(doc.id);
  db.prepare('DELETE FROM library_google_docs WHERE id = ?').run(doc.id);
  logAudit(req.user.org_id, req.user.id, 'delete', 'library_google_doc', doc.id, doc, null, req.ip);
  res.json({ ok: true });
});

// Grants 'writer' (see, edit, and share) access on the real Drive file to
// each selected platform user, by their platform login email — this
// integration has no separate "Google email" field, so a user's login
// email is assumed to be a real Google-account-capable address. Partial
// failure (e.g. a bad email) never aborts the rest of the batch; each
// user's own outcome comes back so the admin can see exactly who got in.
router.post('/google-docs/:id/share', requirePermission('library', 'can_edit'), async (req, res) => {
  const doc = db.prepare('SELECT * FROM library_google_docs WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const { user_ids } = req.body || {};
  if (!Array.isArray(user_ids) || !user_ids.length) return res.status(400).json({ error: 'user_ids array required' });
  const results = [];
  for (const userId of user_ids) {
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').get(userId, req.user.org_id);
    if (!user?.email) { results.push({ user_id: userId, ok: false, error: 'User not found' }); continue; }
    const userName = `${user.first_name} ${user.last_name}`;
    const already = db.prepare('SELECT id FROM library_google_doc_shares WHERE doc_id = ? AND user_id = ?').get(doc.id, userId);
    if (already) { results.push({ user_id: userId, ok: true, name: userName, already: true }); continue; }
    try {
      const perm = await googleDrive.grantAccess(req.user.org_id, doc.google_file_id, user.email, 'writer');
      const shareId = uuid();
      db.prepare(`INSERT INTO library_google_doc_shares (id, doc_id, user_id, role, google_permission_id, granted_by) VALUES (?,?,?,?,?,?)`)
        .run(shareId, doc.id, userId, 'writer', perm.id, req.user.id);
      results.push({ user_id: userId, ok: true, name: userName });
    } catch (e) {
      results.push({ user_id: userId, ok: false, name: userName, error: e.message });
    }
  }
  logAudit(req.user.org_id, req.user.id, 'share', 'library_google_doc', doc.id, null, { results }, req.ip);
  res.json({ results });
});

router.delete('/google-docs/:docId/shares/:shareId', requirePermission('library', 'can_edit'), async (req, res) => {
  const doc = db.prepare('SELECT * FROM library_google_docs WHERE id = ? AND org_id = ?').get(req.params.docId, req.user.org_id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const share = db.prepare('SELECT * FROM library_google_doc_shares WHERE id = ? AND doc_id = ?').get(req.params.shareId, doc.id);
  if (!share) return res.status(404).json({ error: 'Not found' });
  try { await googleDrive.revokeAccess(req.user.org_id, doc.google_file_id, share.google_permission_id); }
  catch (e) { return res.status(502).json({ error: `Could not revoke on Google's side: ${e.message}` }); }
  db.prepare('DELETE FROM library_google_doc_shares WHERE id = ?').run(share.id);
  logAudit(req.user.org_id, req.user.id, 'unshare', 'library_google_doc', doc.id, share, null, req.ip);
  res.json({ ok: true });
});

// ============================= Season Documents ==============================
router.get('/documents', (req, res) => {
  const { season_id } = req.query;
  let where = 'WHERE d.org_id = ?'; const params = [req.user.org_id];
  if (season_id) { where += ' AND d.season_id = ?'; params.push(season_id); }
  const docs = db.prepare(`SELECT d.*, s.name AS season_name, (u.first_name || ' ' || u.last_name) AS uploaded_by_name FROM library_documents d
    LEFT JOIN seasons s ON s.id = d.season_id LEFT JOIN users u ON u.id = d.uploaded_by ${where} ORDER BY d.created_at DESC`).all(...params);
  res.json({ documents: docs });
});

router.post('/documents', requirePermission('library', 'can_edit'), upload.single('file'), (req, res) => {
  const { title, season_id } = req.body || {};
  if (!req.file) return res.status(400).json({ error: 'Choose a file to upload' });
  const ext = ALLOWED_UPLOAD_TYPES[req.file.mimetype];
  if (!ext) return res.status(400).json({ error: `Unsupported file type — allowed: PDF, Word, Excel, PowerPoint, plain text.` });
  if (season_id && !db.prepare('SELECT id FROM seasons WHERE id = ? AND org_id = ?').get(season_id, req.user.org_id)) {
    return res.status(400).json({ error: 'Season not found' });
  }
  const id = uuid();
  const path = join(LIBRARY_DIR, `${id}${ext}`);
  writeFileSync(path, req.file.buffer);
  db.prepare(`INSERT INTO library_documents (id, org_id, season_id, title, file_path, mime_type, file_size, uploaded_by) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, req.user.org_id, season_id || null, title || req.file.originalname, path, req.file.mimetype, req.file.size, req.user.id);
  const doc = db.prepare('SELECT * FROM library_documents WHERE id = ?').get(id);
  logAudit(req.user.org_id, req.user.id, 'create', 'library_document', id, null, { title: doc.title, season_id: doc.season_id }, req.ip);
  res.status(201).json({ document: doc });
});

// One click, straight to the file — no intermediate page.
router.get('/documents/:id/download', (req, res) => {
  const doc = db.prepare('SELECT * FROM library_documents WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!doc || !existsSync(doc.file_path)) return res.status(404).json({ error: 'Not found' });
  res.download(doc.file_path, doc.title + extname(doc.file_path));
});

router.delete('/documents/:id', requirePermission('library', 'can_edit'), (req, res) => {
  const doc = db.prepare('SELECT * FROM library_documents WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (existsSync(doc.file_path)) unlinkSync(doc.file_path);
  db.prepare('DELETE FROM library_documents WHERE id = ?').run(doc.id);
  logAudit(req.user.org_id, req.user.id, 'delete', 'library_document', doc.id, { title: doc.title, season_id: doc.season_id }, null, req.ip);
  res.json({ ok: true });
});

export default router;
