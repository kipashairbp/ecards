// Read-only Google Sheet mirror of the platform's basic records: one
// spreadsheet owned by the org's connected Google account (the same
// connection the Library uses — services/googleDrive.js), with a tab per
// record type, fully rewritten on every sync. "Read-only" in practice:
// anyone the admin shares it with gets Drive's `reader` role, and because
// every tab is regenerated from the database on the next sync, nothing
// typed into the sheet survives anyway — the database is the source of
// truth, the sheet is a window on it. The Sheets API accepts the broad
// `drive` scope the connection already holds, so no re-consent is needed
// (the Sheets API does have to be enabled on the same Google Cloud project
// as the Drive API; a 403 "API has not been used" error means it isn't).
import { db } from '../db.js';
import { getAccessToken, getConnectedAccount } from './googleDrive.js';
import { logAudit } from './audit.js';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const ABOUT_TAB = 'About';

const getSetting = (orgId, key) => db.prepare('SELECT value FROM settings WHERE org_id = ? AND key = ?').get(orgId, key)?.value || '';
const setSetting = (orgId, key, value) => db.prepare(`INSERT INTO settings (org_id, key, value) VALUES (?,?,?) ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value`).run(orgId, key, value ?? '');

async function gcall(orgId, url, opts = {}) {
  const token = await getAccessToken(orgId);
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!res.ok) {
    const err = new Error(`Google API error: ${body?.error?.message || text.slice(0, 300) || `status ${res.status}`}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

const money = v => v == null ? '' : Math.round((Number(v) || 0) * 100) / 100;
const yn = v => v == null ? '' : (v ? 'Yes' : 'No');
const periodLabel = (s, e, fallback) => {
  if (!s) return fallback || '';
  const f = d => { try { return new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); } catch { return d; } };
  return `${f(s)} – ${f(e)}`;
};

// One matrix (header row first) per tab. Every cell is a string or number —
// no bank account/routing numbers, no password hashes, no tokens: "basic
// info entered in the system," not the sensitive extras behind reveal gates.
export function buildTabs(orgId) {
  const shuls = db.prepare(`SELECT s.*, se.name AS season_name,
      (SELECT COUNT(*) FROM applicants a WHERE a.shul_id = s.id AND a.approval_status = 'approved') AS approved_count,
      (SELECT COUNT(*) FROM applicants a WHERE a.shul_id = s.id AND a.approval_status = 'pending') AS pending_count
    FROM shuls s LEFT JOIN seasons se ON se.id = s.season_id WHERE s.org_id = ? ORDER BY se.created_at DESC, s.name_en`).all(orgId);
  const applicants = db.prepare(`SELECT a.*, s.name_en AS shul_name, se.name AS season_name,
      (SELECT c.card_number_masked FROM cards c WHERE c.applicant_id = a.id ORDER BY c.created_at DESC LIMIT 1) AS card_masked,
      (SELECT c.status FROM cards c WHERE c.applicant_id = a.id ORDER BY c.created_at DESC LIMIT 1) AS card_status,
      (SELECT COALESCE(SUM(CASE WHEN t.type = 'refund' THEN -t.amount WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0) FROM card_transactions t JOIN cards c ON c.id = t.card_id WHERE c.applicant_id = a.id) AS spent
    FROM applicants a LEFT JOIN shuls s ON s.id = a.shul_id LEFT JOIN seasons se ON se.id = a.season_id WHERE a.org_id = ? ORDER BY se.created_at DESC, a.last_name, a.first_name`).all(orgId);
  const stores = db.prepare(`SELECT st.*, se.name AS season_name, u.email AS login_email,
      (SELECT COALESCE(SUM(CASE WHEN t.type = 'refund' THEN -t.amount WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0) FROM card_transactions t WHERE t.store_id = st.id) AS live_spend,
      (SELECT COUNT(*) FROM card_transactions t WHERE t.store_id = st.id) AS txn_count
    FROM stores st LEFT JOIN seasons se ON se.id = st.season_id LEFT JOIN users u ON u.id = st.portal_user_id WHERE st.org_id = ? ORDER BY st.name`).all(orgId);
  const cards = db.prepare(`SELECT c.*, a.first_name, a.last_name, a.external_id, s.name_en AS shul_name, se.name AS season_name,
      (SELECT COALESCE(SUM(CASE WHEN t.type = 'refund' THEN -t.amount WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0) FROM card_transactions t WHERE t.card_id = c.id) AS spent,
      (SELECT COUNT(*) FROM card_transactions t WHERE t.card_id = c.id AND t.amount < 0) AS purchases
    FROM cards c LEFT JOIN applicants a ON a.id = c.applicant_id LEFT JOIN shuls s ON s.id = a.shul_id LEFT JOIN seasons se ON se.id = c.season_id WHERE c.org_id = ? ORDER BY c.created_at DESC`).all(orgId);
  const invoices = db.prepare(`SELECT b.*, st.name AS store_name, bp.start_date, bp.end_date,
      TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS approved_by_name
    FROM store_bill_submissions b JOIN stores st ON st.id = b.store_id LEFT JOIN billing_periods bp ON bp.id = b.billing_period_id LEFT JOIN users u ON u.id = b.approved_by
    WHERE b.org_id = ? ORDER BY b.submitted_at DESC`).all(orgId);
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  return [
    { title: ABOUT_TAB, rows: [
      ['This sheet is a read-only copy of the platform\'s records.'],
      ['It is regenerated automatically — anything typed here is overwritten on the next sync. Make changes in the platform itself.'],
      ['Last synced (Eastern)', now],
      ['Tabs', 'Shuls, Applicants, Stores, Cards, Store Invoices'],
      ['Not included', 'Bank account/routing numbers, passwords, login tokens'],
    ] },
    { title: 'Shuls', rows: [['Name', 'Hebrew Name', 'Status', 'Season', 'Address', 'City', 'State', 'Zip', 'Rav', 'Rav Phone', 'Gabai', 'Gabai Cell', 'Gabai Email', 'Slots', 'Approved Applicants', 'Pending Applicants', 'Source', 'Created'],
      ...shuls.map(s => [s.name_en, s.name_he || '', s.status, s.season_name || '', s.address || '', s.city || '', s.state || '', s.zip || '', `${s.ruv_first_name || ''} ${s.ruv_last_name || ''}`.trim(), s.ruv_phone || '', `${s.gabai_first_name || ''} ${s.gabai_last_name || ''}`.trim(), s.gabai_cell || '', s.gabai_email || '', s.slots_allocated || 0, s.approved_count, s.pending_count, s.source || '', s.created_at || ''])] },
    { title: 'Applicants', rows: [['ID', 'First Name', 'Last Name', 'Shul', 'Season', 'Status', 'Marital Status', 'Home Phone', 'Husband Cell', 'Wife Cell', 'Email', 'Address', 'City', 'State', 'Zip', 'Children', 'Home for Yom Tov', 'Card Amount', 'Card', 'Card Status', 'Spent', 'Paused', 'Source', 'Submitted'],
      ...applicants.map(a => [a.external_id || '', a.first_name, a.last_name, a.shul_name || '', a.season_name || '', a.approval_status, a.marital_status || '', a.home_phone || '', a.husband_cell || '', a.wife_cell || '', a.email || '', a.address || '', a.city || '', a.state || '', a.zip || '', a.num_children ?? '', yn(a.home_for_yomtov), money(a.card_amount), a.card_masked || '', a.card_status || '', money(a.spent), yn(a.is_paused), a.source || '', a.created_at || ''])] },
    { title: 'Stores', rows: [['Name', 'Setup Status', 'Season', 'Address', 'City', 'State', 'Zip', 'Phone', 'Manager', 'Manager Phone', 'Manager Email', 'Owner', 'Owner Phone', 'Owner Email', 'Portal Login', 'POS System', 'Discount', 'Live Spend', 'Transactions', 'Source', 'Created'],
      ...stores.map(s => [s.name, s.setup_status || '', s.season_name || '', s.address || '', s.city || '', s.state || '', s.zip || '', s.phone || '', s.manager_name || '', s.manager_phone || '', s.manager_email || '', s.owner_name || '', s.owner_phone || '', s.owner_email || '', s.login_email || '', s.pos_system || '', s.discount ?? '', money(s.live_spend), s.txn_count, s.source || '', s.created_at || ''])] },
    { title: 'Cards', rows: [['Applicant', 'Applicant ID', 'Shul', 'Season', 'Card', 'Status', 'Amount Loaded', 'Spent', 'Purchases', 'Activated', 'Deactivated'],
      ...cards.map(c => [`${c.first_name || ''} ${c.last_name || ''}`.trim(), c.external_id || '', c.shul_name || '', c.season_name || '', c.card_number_masked || '', c.status, money(c.amount), money(c.spent), c.purchases, c.activated_at || '', c.deactivated_at || ''])] },
    { title: 'Store Invoices', rows: [['Store', 'Period', 'Amount', 'Status', 'Submitted', 'Approved for Payment', 'Approved Amount', 'Approved By', 'Approved At', 'Payment Amount', 'Payment Date', 'Rejection Reason'],
      ...invoices.map(b => [b.store_name, periodLabel(b.start_date, b.end_date, b.period), money(b.amount), b.status, b.submitted_at || '', yn(b.approved_for_payment), money(b.approved_amount), b.approved_by_name || '', b.approved_at || '', money(b.payment_amount), b.payment_sent_date || '', b.rejection_reason || ''])] },
  ];
}

export function getStatus(orgId) {
  const account = getConnectedAccount(orgId);
  const id = getSetting(orgId, 'google_sheet_export_id');
  return {
    connected: !!account, email: account?.email || null,
    spreadsheetId: id || null, url: id ? `https://docs.google.com/spreadsheets/d/${id}/edit` : null,
    lastSync: getSetting(orgId, 'google_sheet_export_last_sync') || null,
    lastError: getSetting(orgId, 'google_sheet_export_last_error') || null,
    interval: getSetting(orgId, 'google_sheet_export_interval') || 'off',
    sharedWith: (() => { try { return JSON.parse(getSetting(orgId, 'google_sheet_export_shared') || '[]'); } catch { return []; } })(),
  };
}

async function ensureSpreadsheet(orgId, tabs) {
  const existing = getSetting(orgId, 'google_sheet_export_id');
  if (existing) {
    try {
      const meta = await gcall(orgId, `${SHEETS_API}/${encodeURIComponent(existing)}?fields=spreadsheetId,properties.title,sheets.properties(sheetId,title)`);
      return { id: meta.spreadsheetId, sheets: meta.sheets.map(s => s.properties), created: false };
    } catch (e) {
      if (e.status !== 404) throw e; // deleted/trashed on Drive's side -> make a fresh one below
    }
  }
  const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(orgId);
  const body = { properties: { title: `${org?.name || 'Platform'} — System Data (read-only)` }, sheets: tabs.map((t, i) => ({ properties: { title: t.title, index: i, gridProperties: { frozenRowCount: t.title === ABOUT_TAB ? 0 : 1 } } })) };
  const created = await gcall(orgId, SHEETS_API, { method: 'POST', body: JSON.stringify(body) });
  setSetting(orgId, 'google_sheet_export_id', created.spreadsheetId);
  setSetting(orgId, 'google_sheet_export_shared', '[]');
  return { id: created.spreadsheetId, sheets: created.sheets.map(s => s.properties), created: true };
}

const colLetter = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

export async function syncSheet(orgId, { trigger = 'manual', userId = null } = {}) {
  if (!getConnectedAccount(orgId)) throw new Error('No Google account connected — connect one from the Library page first.');
  try {
    const tabs = buildTabs(orgId);
    const { id, sheets, created } = await ensureSpreadsheet(orgId, tabs);
    // add any tab that doesn't exist yet (e.g. a new record type added after the sheet was created)
    const missing = tabs.filter(t => !sheets.some(s => s.title === t.title));
    const requests = missing.map(t => ({ addSheet: { properties: { title: t.title, gridProperties: { frozenRowCount: t.title === ABOUT_TAB ? 0 : 1 } } } }));
    if (requests.length) await gcall(orgId, `${SHEETS_API}/${id}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
    // wipe every tab, then write the fresh matrices in one batch
    await gcall(orgId, `${SHEETS_API}/${id}/values:batchClear`, { method: 'POST', body: JSON.stringify({ ranges: tabs.map(t => `'${t.title}'`) }) });
    const data = tabs.map(t => ({ range: `'${t.title}'!A1`, majorDimension: 'ROWS', values: t.rows }));
    await gcall(orgId, `${SHEETS_API}/${id}/values:batchUpdate`, { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data }) });
    // bold header rows + auto-size columns; sheetIds come from the live sheet list
    const meta = await gcall(orgId, `${SHEETS_API}/${id}?fields=sheets.properties(sheetId,title)`);
    const fmt = [];
    for (const t of tabs) {
      const sid = meta.sheets.find(s => s.properties.title === t.title)?.properties.sheetId;
      if (sid == null) continue;
      const cols = Math.max(1, ...t.rows.map(r => r.length));
      if (t.title !== ABOUT_TAB) fmt.push({ repeatCell: { range: { sheetId: sid, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: cols }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 } } }, fields: 'userEnteredFormat(textFormat,backgroundColor)' } });
      fmt.push({ autoResizeDimensions: { dimensions: { sheetId: sid, dimension: 'COLUMNS', startIndex: 0, endIndex: cols } } });
    }
    if (fmt.length) await gcall(orgId, `${SHEETS_API}/${id}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: fmt }) });
    const at = new Date().toISOString();
    setSetting(orgId, 'google_sheet_export_last_sync', at);
    setSetting(orgId, 'google_sheet_export_last_error', '');
    const counts = Object.fromEntries(tabs.filter(t => t.title !== ABOUT_TAB).map(t => [t.title, t.rows.length - 1]));
    logAudit(orgId, userId, 'google_sheet_sync', 'settings', id, null, { trigger, created, ...counts }, null);
    return { spreadsheetId: id, url: `https://docs.google.com/spreadsheets/d/${id}/edit`, created, counts, syncedAt: at };
  } catch (e) {
    setSetting(orgId, 'google_sheet_export_last_error', `${new Date().toISOString()} — ${e.message}`);
    throw e;
  }
}

// Viewer access only (Drive role `reader`): they can open and read, never
// edit — and even an edit by the owner is overwritten on the next sync.
export async function shareReadOnly(orgId, email) {
  const id = getSetting(orgId, 'google_sheet_export_id');
  if (!id) throw new Error('Create the sheet first');
  const clean = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(clean)) throw new Error('Enter a valid email address');
  const perm = await gcall(orgId, `${DRIVE_API}/files/${encodeURIComponent(id)}/permissions?sendNotificationEmail=true`, { method: 'POST', body: JSON.stringify({ type: 'user', role: 'reader', emailAddress: clean }) });
  const shared = getStatus(orgId).sharedWith.filter(s => s.email !== clean);
  shared.push({ email: clean, permissionId: perm.id || null, at: new Date().toISOString() });
  setSetting(orgId, 'google_sheet_export_shared', JSON.stringify(shared));
  return shared;
}

export async function unshare(orgId, email) {
  const id = getSetting(orgId, 'google_sheet_export_id');
  const shared = getStatus(orgId).sharedWith;
  const entry = shared.find(s => s.email === email);
  if (entry?.permissionId && id) {
    try { await gcall(orgId, `${DRIVE_API}/files/${encodeURIComponent(id)}/permissions/${encodeURIComponent(entry.permissionId)}`, { method: 'DELETE' }); } catch (e) { if (e.status !== 404) throw e; }
  }
  const rest = shared.filter(s => s.email !== email);
  setSetting(orgId, 'google_sheet_export_shared', JSON.stringify(rest));
  return rest;
}

// Called from the server's hourly timer: honours the interval setting
// ('off' | 'hourly' | 'daily') and the last successful sync time.
export async function syncIfDue(orgId) {
  const { connected, interval, lastSync, spreadsheetId } = getStatus(orgId);
  if (!connected || !spreadsheetId || interval === 'off') return false;
  const ms = interval === 'daily' ? 24 * 3600 * 1000 : 3600 * 1000;
  if (lastSync && Date.now() - new Date(lastSync).getTime() < ms - 60 * 1000) return false;
  await syncSheet(orgId, { trigger: 'scheduled' });
  return true;
}
