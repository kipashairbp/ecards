// ---------------------------------------------------------------------------
// Google Drive/Docs/Sheets integration for the Library feature
// (routes/library.js). Single-org platform — like giftcard.js/mail.js, there
// is exactly ONE Google account ever connected (the org's own), so its OAuth
// refresh token + connected email live in the `settings` table (org_id+key),
// not a per-user table. Uses plain fetch against Google's REST endpoints
// (same "no heavy SDK" approach as giftcard.js) rather than the `googleapis`
// npm package.
//
// Requires a Google Cloud OAuth client (Client ID + Secret) configured by
// whoever deploys this app — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and
// GOOGLE_REDIRECT_URI (e.g. https://yourapp.com/api/library/google/callback,
// which must be added to the OAuth client's "Authorized redirect URIs" in
// Google Cloud Console) as env vars. isConfigured() below is false — and
// every route in routes/library.js reports a clear "not configured" state
// rather than mocking anything — until all three are set, since this
// integration only means anything against a real Google account.
//
// Scope requested is the broad `drive` scope (not the narrower `drive.file`,
// which only ever sees files OUR app created) because the whole point is
// linking EXISTING docs/sheets the admin already owns. That's a Google
// "sensitive scope" — for an internal admin-only connect (one person ever
// goes through this consent screen: whoever clicks Connect), an unverified
// OAuth consent screen in "Testing" mode with that Google account added as
// a test user is enough; Google's app-verification review is only required
// to lift the ~100-test-user cap or remove the "unverified app" warning
// screen, neither of which matters for a single connecting account.
// ---------------------------------------------------------------------------

import { db } from '../db.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

const SCOPES = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/userinfo.email'];

export function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

function getSetting(orgId, key) {
  return db.prepare('SELECT value FROM settings WHERE org_id = ? AND key = ?').get(orgId, key)?.value || null;
}
function setSetting(orgId, key, value) {
  db.prepare(`INSERT INTO settings (org_id, key, value) VALUES (?,?,?) ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value`).run(orgId, key, value);
}

export function getConnectedAccount(orgId) {
  const email = getSetting(orgId, 'google_oauth_email');
  const refreshToken = getSetting(orgId, 'google_oauth_refresh_token');
  if (!email || !refreshToken) return null;
  return { email, connectedAt: getSetting(orgId, 'google_oauth_connected_at') };
}

export function disconnect(orgId) {
  db.prepare(`DELETE FROM settings WHERE org_id = ? AND key IN ('google_oauth_email','google_oauth_refresh_token','google_oauth_connected_at')`).run(orgId);
}

// Short-lived in-memory pending-state store for the OAuth redirect round
// trip (CSRF protection) — this app has no session store, and a signed
// cookie would be overkill for a flow only an already-authenticated admin
// ever starts. Expires on its own; a stale/replayed state is just rejected.
const pendingStates = new Map();
export function createOAuthState(orgId, userId) {
  const state = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  pendingStates.set(state, { orgId, userId, expires: Date.now() + 10 * 60 * 1000 });
  return state;
}
export function consumeOAuthState(state) {
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!entry || entry.expires < Date.now()) return null;
  return entry;
}

export function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // forces a refresh_token every time, not just first-ever consent
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function connectWithCode(orgId, code) {
  const body = new URLSearchParams({
    code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI, grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const tokens = await res.json();
  if (!res.ok) throw new Error(tokens.error_description || tokens.error || `token exchange failed (${res.status})`);
  if (!tokens.refresh_token) throw new Error('Google did not return a refresh token — disconnect any prior connection for this app under myaccount.google.com/permissions and try again.');
  const userinfoRes = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  const userinfo = await userinfoRes.json();
  if (!userinfoRes.ok || !userinfo.email) throw new Error('Could not read the connected account\'s email address');
  setSetting(orgId, 'google_oauth_refresh_token', tokens.refresh_token);
  setSetting(orgId, 'google_oauth_email', userinfo.email);
  setSetting(orgId, 'google_oauth_connected_at', new Date().toISOString());
  return { email: userinfo.email };
}

// Access tokens are short-lived (~1hr) and this integration is used
// intermittently, not on a hot path — a fresh one is fetched per call
// rather than maintaining a cache that would need its own expiry bookkeeping.
async function getAccessToken(orgId) {
  const refreshToken = getSetting(orgId, 'google_oauth_refresh_token');
  if (!refreshToken) throw new Error('No Google account connected — connect one from the Library page first.');
  const body = new URLSearchParams({
    refresh_token: refreshToken, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await res.json();
  if (!res.ok) {
    // invalid_grant almost always means the refresh token was revoked
    // (disconnected from myaccount.google.com, or the OAuth client's
    // testing-mode 7-day token expiry for unverified apps) — surface that
    // plainly instead of a bare 400, since the fix is "reconnect," not a
    // bug to chase.
    if (data.error === 'invalid_grant') throw new Error('The connected Google account\'s access has expired or been revoked — reconnect it from the Library page.');
    throw new Error(data.error_description || data.error || `could not refresh Google access token (${res.status})`);
  }
  return data.access_token;
}

async function driveCall(orgId, path, opts = {}) {
  const token = await getAccessToken(orgId);
  const res = await fetch(`${DRIVE_API}${path}`, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!res.ok) {
    const detail = body?.error?.message || text.slice(0, 300) || `status ${res.status}`;
    const err = new Error(`Google Drive API error: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// docs.google.com/document/d/{id}/..., .../spreadsheets/d/{id}/...,
// drive.google.com/file/d/{id}/..., or a bare id pasted directly.
export function extractFileId(url) {
  const s = String(url || '').trim();
  const m = s.match(/\/d\/([a-zA-Z0-9_-]{10,})/) || s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s; // a bare file id, no URL wrapper
  return null;
}

const ALLOWED_MIME_TYPES = ['application/vnd.google-apps.document', 'application/vnd.google-apps.spreadsheet'];

// Fetches metadata and verifies BOTH that it's a real Google Doc/Sheet (not
// some other Drive file type) and that it's owned by the org's connected
// account — "the right account" the feature is gated on. A Shared-Drive
// item has no individual `owners` field at all (ownership belongs to the
// shared drive itself), which this treats as "not owned by you" rather than
// guessing — supporting shared drives would need its own explicit design.
export async function verifyAndGetMetadata(orgId, fileId) {
  const connected = getConnectedAccount(orgId);
  if (!connected) throw new Error('No Google account connected — connect one from the Library page first.');
  const meta = await driveCall(orgId, `/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,owners,webViewLink`);
  if (!ALLOWED_MIME_TYPES.includes(meta.mimeType)) {
    throw new Error('Only Google Docs and Google Sheets links can be added to the Library.');
  }
  const ownerEmail = meta.owners?.[0]?.emailAddress;
  const isOwnedByConnectedAccount = meta.owners?.some(o => o.emailAddress?.toLowerCase() === connected.email.toLowerCase());
  if (!isOwnedByConnectedAccount) {
    throw new Error(ownerEmail
      ? `This document is owned by ${ownerEmail}, not the connected account (${connected.email}) — only docs owned by ${connected.email} can be added.`
      : `Could not determine this document's owner (it may live in a Shared Drive, which isn't supported yet) — only docs owned by ${connected.email} can be added.`);
  }
  return { id: meta.id, title: meta.name, mimeType: meta.mimeType, webViewLink: meta.webViewLink, ownerEmail };
}

// role: 'writer' grants view+edit+share — see, edit, and share, exactly
// what this feature promises a granted user. sendNotificationEmail lets the
// user actually discover they got access, same as sharing manually in the
// Drive UI would.
export async function grantAccess(orgId, fileId, email, role = 'writer') {
  const body = JSON.stringify({ type: 'user', role, emailAddress: email });
  return driveCall(orgId, `/files/${encodeURIComponent(fileId)}/permissions?sendNotificationEmail=true`, { method: 'POST', body });
}

export async function revokeAccess(orgId, fileId, permissionId) {
  if (!permissionId) return { ok: true }; // nothing to revoke on Drive's side (e.g. the grant predates permission-id tracking)
  try {
    await driveCall(orgId, `/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`, { method: 'DELETE' });
  } catch (e) {
    if (e.status !== 404) throw e; // already gone on Drive's side — fine, that's the end state we wanted anyway
  }
  return { ok: true };
}
