import jwt from 'jsonwebtoken';
import { db } from '../db.js';

// render.yaml generates JWT_SECRET automatically, so production should
// always have a real one — but if a deploy ever comes up without it, silently
// falling back to a fixed, publicly-known string (visible in this repo's
// history) would let anyone forge a valid session token for any user,
// including super_admin. Fail loud instead of quietly issuing forgeable
// tokens on a platform holding financial/PII data. Local dev without a
// .env still works — only production is required to set it explicitly.
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production — refusing to start with a guessable default.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// impersonatedBy (an admin user id) is only ever set by POST /auth/impersonate/:token
// redeeming an "Enter Portal" link — a real login never passes it. Carrying
// it in the JWT itself (rather than, say, looking up impersonation_tokens.
// used_at by iat, which would be a fragile coincidence to rely on) is what
// lets downstream routes — Store Billing's email-verification gate in
// particular, see routes/storeBilling.js — tell "this is genuinely the
// store's own login" apart from "this is an admin looking through the
// store's eyes," without a second request. Null for a real login.
export function signToken(user, impersonatedBy = null) {
  return jwt.sign({ userId: user.id, tokenVersion: user.token_version || 0, impersonatedBy }, JWT_SECRET, { expiresIn: '30d' });
}

// The shape sent to the client for a `user` object, everywhere one is sent
// (login, /me, accept-invite, impersonate redeem) — strips password_hash
// and parses page_size_prefs (stored as a raw JSON string column) into a
// real object so the frontend never has to JSON.parse it itself.
export function safeUser(user) {
  const { password_hash, page_size_prefs, ...rest } = user;
  let prefs = {};
  try { prefs = page_size_prefs ? JSON.parse(page_size_prefs) : {}; } catch { prefs = {}; }
  return { ...rest, page_size_prefs: prefs };
}

export function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  let decoded;
  try { decoded = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
  const userId = decoded.userId || decoded.id;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || !user.is_active) return res.status(401).json({ error: 'Account not found or disabled' });
  if ((user.token_version || 0) !== (decoded.tokenVersion || 0)) return res.status(401).json({ error: 'Session expired, please log in again' });
  if (user.is_paused) return res.status(423).json({ error: 'Account is paused pending duplicate resolution. Contact the administrator.', code: 'ACCOUNT_PAUSED' });
  req.user = user;
  // Set only for a token minted by POST /auth/impersonate/:token — see
  // signToken's comment. Re-validated here on every request rather than
  // trusted blindly from the token's own claim: if the impersonating admin
  // has since been deactivated, this falls back to treating the session as
  // a normal (non-bypassed) one instead of leaving a stale privilege behind.
  if (decoded.impersonatedBy) {
    const admin = db.prepare('SELECT id, is_active FROM users WHERE id = ?').get(decoded.impersonatedBy);
    req.impersonatedBy = admin && admin.is_active ? admin.id : null;
  } else {
    req.impersonatedBy = null;
  }
  // The JWT's own `iat` (seconds since epoch, set automatically by jwt.sign)
  // doubles as a stable "this login" marker — same token, same iat, on every
  // request until the next login issues a fresh one. Store Billing's invoice
  // submission uses this to require a fresh verification code once per
  // login rather than on every single submission (see routes/storeBilling.js).
  req.tokenIat = decoded.iat;
  next();
}

// Restrict a route to specific roles.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

export function requireAdmin(req, res, next) {
  if (!req.user || !['super_admin', 'org_admin', 'staff'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
  next();
}
