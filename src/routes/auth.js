import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, uuid } from '../db.js';
import { auth, signToken, safeUser } from '../middleware/auth.js';
import { sendMailChecked, renderSystemTemplate } from '../services/mail.js';
import { computePermissionMap } from '../middleware/permissions.js';

const router = Router();

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  // COLLATE NOCASE: users.email is normalized to lowercase on write and
  // backfilled at boot (see db.js), but stay case-insensitive here anyway —
  // a single un-normalized row (e.g. a skipped backfill collision) should
  // degrade to "wrong password", never to an account that can't be found.
  const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(String(email).trim().toLowerCase());
  if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!user.is_active) return res.status(403).json({ error: 'This account has been deactivated' });
  if (user.is_paused) return res.status(423).json({ error: 'Account is paused pending duplicate resolution. Contact the administrator.', code: 'ACCOUNT_PAUSED' });
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(user.id);
  db.prepare(`INSERT INTO audit_log (id, org_id, user_id, action, entity_type, entity_id, ip_address) VALUES (?,?,?,?,?,?,?)`)
    .run(uuid(), user.org_id, user.id, 'login', 'user', user.id, req.ip);
  // Handed to the client so nav items it can't view are hidden outright
  // (see app.js's renderShell) instead of shown and only 403ing on click.
  res.json({ token: signToken(user), user: safeUser(user), permissions: computePermissionMap(user) });
});

router.get('/me', auth, (req, res) => {
  res.json({ user: safeUser(req.user), permissions: computePermissionMap(req.user) });
});

// Accept an invite (set initial password) — token comes from the approval email.
router.post('/accept-invite', (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 8) return res.status(400).json({ error: 'A valid token and an 8+ character password are required' });
  const user = db.prepare('SELECT * FROM users WHERE invite_token = ?').get(token);
  if (!user) return res.status(404).json({ error: 'Invalid or expired invite link' });
  if (user.invite_expires && new Date(user.invite_expires) < new Date()) return res.status(410).json({ error: 'This invite link has expired' });
  db.prepare(`UPDATE users SET password_hash = ?, invite_token = NULL, invite_expires = NULL, is_active = 1 WHERE id = ?`)
    .run(bcrypt.hashSync(password, 10), user.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ token: signToken(fresh), user: safeUser(fresh), permissions: computePermissionMap(fresh) });
});

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(String(email || '').trim().toLowerCase());
  // Always respond 200 to avoid leaking which emails exist.
  if (user) {
    const token = uuid();
    const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    db.prepare('UPDATE users SET invite_token = ?, invite_expires = ? WHERE id = ?').run(token, expires, user.id);
    const resetUrl = `${process.env.APP_URL || ''}/reset-password?token=${token}`;
    const tmpl = renderSystemTemplate(user.org_id, 'passwordReset', { resetUrl });
    const { emailError } = await sendMailChecked(user.org_id, user.email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo });
    if (emailError) console.error('[mail] password reset email failed:', emailError);
  }
  res.json({ ok: true });
});

// Redeems a one-time "Enter Portal" code (see POST /shuls/:id/impersonate
// and /stores/:id/impersonate) for a real session on the target shul/store
// login — same shape as login/accept-invite, so the new tab that opens this
// URL can Auth.set() straight from the response. Never requires or reads
// the target account's actual password. The code itself is single-use and
// expires in minutes (see the issuing routes), so a link left in browser
// history or a mistakenly-forwarded message is worthless within moments of
// being issued.
router.post('/impersonate/:token', (req, res) => {
  const row = db.prepare('SELECT * FROM impersonation_tokens WHERE token = ?').get(req.params.token);
  if (!row || row.used_at) return res.status(404).json({ error: 'Invalid or expired link' });
  if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'This link has expired' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user || !user.is_active) return res.status(404).json({ error: 'This account is no longer active' });
  db.prepare('UPDATE impersonation_tokens SET used_at = datetime(\'now\') WHERE token = ?').run(row.token);
  res.json({ token: signToken(user), user: safeUser(user), permissions: computePermissionMap(user) });
});

router.post('/change-password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  if (req.user.password_hash && !bcrypt.compareSync(currentPassword || '', req.user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, 10), req.user.id);
  res.json({ ok: true, message: 'Password changed. Please log in again.' });
});

// Any authenticated user (staff included) can save their own page-size
// preference for a list page — deliberately NOT under routes/users.js,
// which is locked to requireRole('super_admin','org_admin') for the whole
// Users & Permissions page and would wrongly block a plain staff member
// from saving something about their own session. Merges into the existing
// JSON blob (never replaces it) so setting one page's size never wipes out
// what was already saved for every other page.
router.put('/preferences', auth, (req, res) => {
  const { page, pageSize } = req.body || {};
  if (!page || !Number.isFinite(+pageSize) || +pageSize <= 0) return res.status(400).json({ error: 'page and a positive pageSize are required' });
  let prefs = {};
  try { prefs = req.user.page_size_prefs ? JSON.parse(req.user.page_size_prefs) : {}; } catch { prefs = {}; }
  prefs[page] = +pageSize;
  db.prepare('UPDATE users SET page_size_prefs = ? WHERE id = ?').run(JSON.stringify(prefs), req.user.id);
  res.json({ ok: true, page_size_prefs: prefs });
});

export default router;
