# Instructions: editable bank list + "Download Store Bank Details" export

Two Store Billing additions, done in the `kipashairbp/ecards` repo. Reproduce them in the
sibling repo (`ecards-williamsburg`) — same codebase lineage, so the file names and ids below
should match; grep to confirm before editing.

## 1. Admin-editable bank list (and add Metropolitan Bank)

**What it does.** The bank picker on the store portal's Payment Information form used to be a
hardcoded array (`window.US_BANKS` in `frontend/js/usbanks.js`). Now:

- `Metropolitan Bank` is in the built-in list.
- An admin can replace the whole list from **Settings › Organization › Store Billing › Bank List**
  (a textarea, one bank per line, Save / Reset to Built-in List). Stored as a JSON array under the
  `store_billing_banks` setting through the existing generic `PUT /api/settings`.
- The store portal fetches the list from a new `GET /api/store-billing/banks` (any logged-in user)
  and falls back to the bundled `usbanks.js` if that call fails.
- `"Other / Not Listed"` is always forced to the end server-side, since it is what unlocks the
  free-text bank-name field on the form.

**Files.**

`frontend/js/usbanks.js` — add `'Metropolitan Bank'` to the array (anywhere; the NY banks line is
natural).

`src/routes/storeBilling.js` — import `readFileSync` from `fs`, then right after `router.use(auth);`:

```js
const OTHER_BANK = 'Other / Not Listed';
const DEFAULT_BANKS = (() => {
  try {
    const src = readFileSync(new URL('../../frontend/js/usbanks.js', import.meta.url), 'utf8');
    return new Function('return ' + src.match(/window\.US_BANKS\s*=\s*(\[[\s\S]*?\]);/)[1])();
  } catch (e) { console.error('[store-billing] could not read usbanks.js:', e.message); return []; }
})();
function getBanks(orgId) {
  let list = null;
  try { const v = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'store_billing_banks'`).get(orgId)?.value; if (v) list = JSON.parse(v); } catch {}
  if (!Array.isArray(list) || !list.length) list = DEFAULT_BANKS;
  const clean = [...new Set(list.map(b => String(b).trim()).filter(b => b && b !== OTHER_BANK))];
  return [...clean, OTHER_BANK];
}
router.get('/banks', (req, res) => res.json({ banks: getBanks(req.user.org_id) }));
```

(The built-in list is read out of `usbanks.js` so there is exactly one copy of it.)

`frontend/store-portal/billing.html` — in `refreshStatus()` after the status call:

```js
if (!BW.banks) { try { BW.banks = (await api('/store-billing/banks')).banks; } catch { BW.banks = window.US_BANKS; } }
```

and in `BW.filterBanks`, replace `US_BANKS.filter(` with `(BW.banks || window.US_BANKS).filter(`.

`frontend/admin/settings.html` — inside the existing "Store Billing" card, after its Save button:

```html
<div class="divider" style="margin:18px 0"></div>
<h3 style="font-size:15px">Bank List</h3>
<p class="small-muted">The banks a store can pick from on its Payment Information form, one per line, in the order shown. Add, rename or remove freely — "Other / Not Listed" is always kept at the end so a store can still type in a bank that isn't here. Changes apply the next time a store opens the form.</p>
<textarea id="sb-banks" rows="12" style="font-family:inherit;font-size:13px"></textarea>
<div style="display:flex;gap:8px;margin-top:10px;align-items:center">
  <button class="btn btn-sm btn-primary" onclick="saveBankList()">Save Bank List</button>
  <button class="btn btn-sm btn-outline" onclick="resetBankList()">Reset to Built-in List</button>
  <span class="small-muted" id="sb-banks-count"></span>
</div>
```

and in the script, have `loadStoreBillingSettings()` end with
`await loadBankList(!!settings.store_billing_banks);` and add:

```js
async function loadBankList(customized) {
  const { banks } = await api('/store-billing/banks');
  const editable = banks.filter(b => b !== 'Other / Not Listed');
  qs('#sb-banks').value = editable.join('\n');
  qs('#sb-banks-count').textContent = `${editable.length} banks${customized ? ' (customized)' : ' (built-in list)'}`;
}
window.saveBankList = async () => {
  const banks = [...new Set(qs('#sb-banks').value.split('\n').map(s => s.trim()).filter(Boolean))];
  if (!banks.length) return toast('Enter at least one bank, or use Reset to go back to the built-in list', true);
  try { await api('/settings', { method: 'PUT', body: { store_billing_banks: JSON.stringify(banks) } }); toast('Bank list saved'); await loadBankList(true); } catch (err) { toast(err.message, true); }
};
window.resetBankList = async () => {
  if (!confirm('Replace your custom bank list with the built-in one?')) return;
  try { await api('/settings', { method: 'PUT', body: { store_billing_banks: '' } }); toast('Reset to the built-in list'); await loadBankList(false); } catch (err) { toast(err.message, true); }
};
```

(An empty string for the setting means "use the built-in list"; a malformed value also falls back.)

## 2. "Download Store Bank Details (Excel)" on Store Billing

**What it does.** One click on the Store Billing page downloads an `.xlsx` with every store
(active/pending/in-progress — `setup_status != 'inactive'`) and its payment info **in full**:
bank, name on account, bank address, billing contact + cell, **full account number**, routing
number, when it was last updated — plus the store's own address/phones/owner/manager/portal login.
Stores with no payment info on file are included with blank bank columns and sorted last, so the
sheet also works as a "who still hasn't set up payment" list.

**Gate.** Same as the existing per-store "Reveal Full Numbers": `requirePermission('store_billing')`
**and** role must be `super_admin` or `org_admin` (staff get 403 even with store_billing rights).
Every download writes an `export_payment_info` audit row (`audit_log`) with the counts.

**Files.**

`src/routes/storeBilling.js` — import `sendXlsx` from `../services/xlsx.js`, then add this route
(put it before the `/stores/:storeId/payment-info/reveal` route):

```js
router.get('/stores/payment-info/export', requirePermission('store_billing'), (req, res) => {
  if (!['super_admin', 'org_admin'].includes(req.user.role)) return res.status(403).json({ error: 'Not permitted' });
  const rows = db.prepare(`SELECT s.name, s.setup_status, s.address, s.city, s.state, s.zip, s.phone,
      s.owner_name, s.owner_phone, s.owner_email, s.manager_name, s.manager_phone, s.manager_email, u.email AS login_email,
      pi.bank_name, pi.name_on_account, pi.address AS bank_address, pi.city AS bank_city, pi.state AS bank_state, pi.zip AS bank_zip,
      pi.contact_name, pi.contact_cell, pi.account_number, pi.routing_number, pi.updated_at AS payment_info_updated_at
    FROM stores s LEFT JOIN store_payment_info pi ON pi.store_id = s.id LEFT JOIN users u ON u.id = s.portal_user_id
    WHERE s.org_id = ? AND s.setup_status != 'inactive' ORDER BY (pi.id IS NULL), s.name`).all(req.user.org_id);
  logAudit(req.user.org_id, req.user.id, 'export_payment_info', 'store', null, null, { stores: rows.length, with_payment_info: rows.filter(r => r.account_number).length }, req.ip);
  const out = rows.map(r => ({
    'Store': r.name, 'Setup Status': r.setup_status, 'Address': r.address, 'City': r.city, 'State': r.state, 'Zip': r.zip, 'Store Phone': r.phone,
    'Owner': r.owner_name, 'Owner Phone': r.owner_phone, 'Owner Email': r.owner_email, 'Manager': r.manager_name, 'Manager Phone': r.manager_phone, 'Manager Email': r.manager_email, 'Portal Login': r.login_email,
    'Bank': r.bank_name, 'Name on Account': r.name_on_account, 'Bank Address': [r.bank_address, r.bank_city, r.bank_state, r.bank_zip].filter(Boolean).join(', '),
    'Billing Contact': r.contact_name, 'Billing Contact Cell': r.contact_cell, 'Account Number': r.account_number, 'Routing Number': r.routing_number, 'Payment Info Updated': r.payment_info_updated_at,
  }));
  sendXlsx(res, `store-bank-details-${new Date().toISOString().slice(0, 10)}.xlsx`, out);
});
```

If the sibling's `store_payment_info` table has no separate `city/state/zip` columns (older
schema kept everything in `address`), drop those three from the SELECT and the `Bank Address` join.
Account/routing numbers are TEXT in the DB, so `sendXlsx` writes them as text cells (no scientific
notation / lost leading zeros).

`frontend/admin/store-billing.html` — in the Invoices toolbar, after the status `<select>`:

```html
${['super_admin', 'org_admin'].includes(Auth.user()?.role) ? `<button class="btn btn-sm btn-outline" style="margin-left:auto" title="Every store with its full bank account and routing numbers — treat the file as confidential" onclick="downloadAuthed('/store-billing/stores/payment-info/export', 'store-bank-details.xlsx')">Download Store Bank Details (Excel)</button>` : ''}
```

(`downloadAuthed` already exists in `app.js` and sends the bearer token with the download.)

## Verify

- `GET /api/store-billing/banks` as an admin: contains `Metropolitan Bank`, ends with `Other / Not Listed`.
- Save a custom list in Settings → the store portal's bank search only offers those (plus Other).
- Reset → built-in list again.
- Store Billing as super_admin: download opens an .xlsx; open the row for a store that saved payment
  info and confirm the full account number is there; Logs › Recent Actions shows
  `export_payment_info`. As a staff user with store_billing rights the button is hidden and the URL
  returns 403.
