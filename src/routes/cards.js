import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission, redact } from '../middleware/permissions.js';
import * as giftcard from '../services/giftcard.js';
import { sendXlsx } from '../services/xlsx.js';
import { syncOneCard, syncAllCards, lockApplicantCards } from '../services/cardSync.js';
import { normalizePhone, isValidPhone } from '../utils/phone.js';
import { getActiveSeasonId } from '../utils/formSchedule.js';

const router = Router();
router.use(auth, requirePermission('cards'));

router.get('/', (req, res) => {
  const { search, status, season_id, page = 1, pageSize = 50 } = req.query;
  let where = 'WHERE c.org_id = ?';
  const params = [req.user.org_id];
  if (status) { where += ' AND c.status = ?'; params.push(status); }
  if (season_id) { where += ' AND c.season_id = ?'; params.push(season_id); }
  if (search) {
    where += ` AND (a.first_name LIKE ? OR a.last_name LIKE ? OR c.card_number_masked LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  const total = db.prepare(`SELECT COUNT(*) c FROM cards c LEFT JOIN applicants a ON a.id=c.applicant_id ${where}`).get(...params).c;
  const offset = (Math.max(1, +page) - 1) * +pageSize;
  const rows = db.prepare(`SELECT c.*, a.first_name, a.last_name, a.email, s.name_en as shul_name
    FROM cards c LEFT JOIN applicants a ON a.id=c.applicant_id LEFT JOIN shuls s ON s.id=a.shul_id
    ${where} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`).all(...params, +pageSize, offset);
  // mockMode here is a UI badge, not action-critical — a list spanning
  // multiple seasons with different overrides has no single true answer, so
  // report the filtered season's status if one's selected, else the
  // org-wide default every season without its own override actually uses.
  res.json({ cards: redact(rows, req.permission.hidden_fields), total, page: +page, pageSize: +pageSize, mockMode: giftcard.isMockMode(season_id || null) });
});

// Full-detail CSV export — every field, no pagination. Must be registered before /:id.
router.get('/export', requirePermission('cards', 'can_export'), (req, res) => {
  const { search, status, season_id } = req.query;
  let where = 'WHERE c.org_id = ?';
  const params = [req.user.org_id];
  if (status) { where += ' AND c.status = ?'; params.push(status); }
  if (season_id) { where += ' AND c.season_id = ?'; params.push(season_id); }
  if (search) {
    where += ` AND (a.first_name LIKE ? OR a.last_name LIKE ? OR c.card_number_masked LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  const rows = db.prepare(`SELECT c.*, a.first_name, a.last_name, a.email, s.name_en as shul_name
    FROM cards c LEFT JOIN applicants a ON a.id=c.applicant_id LEFT JOIN shuls s ON s.id=a.shul_id
    ${where} ORDER BY c.created_at DESC`).all(...params);
  sendXlsx(res, `cards-${Date.now()}.xlsx`, redact(rows, req.permission.hidden_fields));
});

// Per-shul rollup: how much of the money loaded onto that shul's applicants'
// cards has actually been spent so far. Must be registered before /:id (same
// reason as /export above — otherwise Express matches "by-shul" as an :id).
//
// "Allocated" is SUM(applicants.card_amount) for approved applicants — the
// exact same source and scope as the org-wide "Total Loaded" stat
// (dashboard.js), one row per applicant. It used to join through `cards`
// and SUM(cards.amount) instead, which double- (or triple-)counted any
// applicant with more than one cards row for the same commitment — a
// replaced card left the old row in place (deactivated, but still joined
// and summed), and a family issued two active physical cards against the
// same disccardpromos account had both rows carrying the SAME real balance
// (cardSync.js refreshes every one of an applicant's card rows to the same
// account-level total on each sync) and summed twice. Reading card_amount
// straight off applicants sidesteps all of that — it's one committed
// dollar figure per applicant, however many physical cards they hold.
// "Spent" mirrors the existing store-spend convention elsewhere (negative
// card_transactions.amount, net of refunds, = real spend).
router.get('/by-shul', (req, res) => {
  const { season_id } = req.query;
  const seasonClause = season_id ? ' AND a2.season_id = ?' : '';
  const seasonParams = season_id ? [season_id] : [];
  const rows = db.prepare(`
    SELECT s.id AS shul_id, s.name_en AS shul_name,
      COALESCE((SELECT SUM(a2.card_amount) FROM applicants a2
        WHERE a2.shul_id = s.id AND a2.approval_status = 'approved'${seasonClause}), 0) AS allocated,
      COALESCE((SELECT SUM(CASE WHEN t.type = 'refund' THEN -t.amount WHEN t.amount < 0 THEN -t.amount ELSE 0 END)
        FROM card_transactions t JOIN cards c2 ON c2.id = t.card_id JOIN applicants a2 ON a2.id = c2.applicant_id
        WHERE a2.shul_id = s.id AND c2.org_id = ?${seasonClause}), 0) AS spent
    FROM shuls s
    WHERE s.org_id = ?
    GROUP BY s.id
    HAVING allocated > 0
    ORDER BY allocated DESC`).all(...seasonParams, req.user.org_id, ...seasonParams, req.user.org_id);
  res.json({ shuls: rows.map(r => ({ ...r, remaining: r.allocated - r.spent })) });
});

// Same idea as /by-shul above, but for stores — "see transactions per
// store" needs an at-a-glance list, not just the per-store total buried in
// each store's own profile popup one at a time. Kept here (not routes/
// stores.js) so it's gated by this router's own 'cards' permission rather
// than requiring 'stores' too. txn_count included so a $0/no-history row is
// obviously "nothing synced here yet" rather than "linked but broken."
router.get('/by-store', (req, res) => {
  const rows = db.prepare(`SELECT s.id AS store_id, s.name AS store_name, COUNT(t.id) txn_count,
      COALESCE(SUM(CASE WHEN t.type='refund' THEN -t.amount WHEN t.amount < 0 THEN -t.amount ELSE 0 END),0) total_purchases,
      COALESCE(SUM(CASE WHEN t.type='refund' THEN t.amount ELSE 0 END),0) total_refunds
    FROM stores s LEFT JOIN card_transactions t ON t.store_id = s.id
    WHERE s.org_id = ?
    GROUP BY s.id ORDER BY total_purchases DESC`).all(req.user.org_id);
  res.json({ stores: rows });
});

router.get('/:id', (req, res) => {
  const card = db.prepare(`SELECT c.*, a.first_name, a.last_name, a.husband_cell, a.wife_cell, a.home_phone
    FROM cards c LEFT JOIN applicants a ON a.id=c.applicant_id WHERE c.id = ? AND c.org_id = ?`).get(req.params.id, req.user.org_id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  const transactions = db.prepare('SELECT * FROM card_transactions WHERE card_id = ? ORDER BY occurred_at DESC').all(card.id);
  res.json({ card, transactions });
});

// Assign a card to an approved applicant. Per disccardpromos' real Customer
// API docs, there is no "give me a fresh card" endpoint — the org already
// holds real physical card numbers, and "assigning" one means PATCHing the
// applicant's disccardpromos customer with that exact card_number, which
// activates it for them. So card_number here must be an actual physical
// number in hand (e.g. from a batch of pre-printed cards), not something
// this app generates — replaces the old giftcard.assignCard(), which called
// a guessed, never-confirmed /cards/assign path.
router.post('/assign', requirePermission('cards', 'can_edit'), async (req, res) => {
  const { applicant_id, card_number } = req.body || {};
  if (!card_number) return res.status(400).json({ error: 'A real card number is required — disccardpromos activates an existing physical card, it does not generate one' });
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(applicant_id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Applicant not found' });
  if (applicant.approval_status !== 'approved') return res.status(400).json({ error: 'Applicant must be approved before a card is assigned' });
  if (applicant.is_paused) return res.status(423).json({ error: 'Applicant is paused pending duplicate resolution' });
  if (!applicant.provider_account_id) return res.status(400).json({ error: 'This applicant has no disccardpromos customer on file yet — re-approve them first so one gets created' });
  const finalAmount = applicant.card_amount ?? 0;
  let result;
  try {
    result = await giftcard.linkCardToCustomer(applicant.season_id, applicant.provider_account_id, card_number, applicant.external_id);
  } catch (e) {
    console.error('[cards] assign failed:', e.message);
    return res.status(502).json({ error: `disccardpromos rejected the card assignment: ${e.message}` });
  }
  // active_cards is a list of masked numbers with no stable per-card id in
  // their API — the just-activated one is whichever entry matches this
  // card_number's last 4 digits, falling back to a locally-computed mask if
  // the response didn't come back as expected (mock mode, or an
  // unrecognized shape).
  const last4 = String(card_number).slice(-4);
  const maskedNumber = (result.active_cards || []).find(c => c.endsWith(last4)) || `****${last4}`;
  // Inserted as 'activated' directly, not 'assigned' — disccardpromos
  // itself already treats this exact write as activation (see this route's
  // own comment above), so there's no real interim state to represent.
  // activated_at is set now too; the separate Activate action (below) still
  // exists purely to record an activation phone number, not to change
  // status — it's already activated by the time that ever happens.
  const id = uuid();
  db.prepare(`INSERT INTO cards (id, org_id, applicant_id, season_id, card_number_masked, provider_card_id, status, amount, assigned_at, activated_at)
    VALUES (?,?,?,?,?,?,'activated',?,datetime('now'),datetime('now'))`)
    .run(id, req.user.org_id, applicant.id, applicant.season_id, maskedNumber, null, finalAmount);
  db.prepare(`INSERT INTO card_transactions (id, card_id, type, amount, occurred_at) VALUES (?,?,?,?,datetime('now'))`)
    .run(uuid(), id, 'load', finalAmount);
  db.prepare(`INSERT INTO audit_log (id, org_id, user_id, action, entity_type, entity_id, after_json) VALUES (?,?,?,?,?,?,?)`)
    .run(uuid(), req.user.org_id, req.user.id, 'assign_card', 'card', id, JSON.stringify({ applicant_id, amount: finalAmount }));
  res.status(201).json({ card: db.prepare('SELECT * FROM cards WHERE id = ?').get(id) });
});

// Activate — records the phone number the applicant/gabai provides against
// this card locally. Per disccardpromos' confirmed real Customer API (see
// giftcard.js's Customer section comment), the card is already live and
// spendable the moment Assign PATCHes card_number onto the customer — their
// own docs call that write "activate a card number for this customer".
// There is no separate live activation call to make here: the
// giftcard.activateCard() this used to call hit a guessed placeholder
// endpoint (/cards/:id/activate) that was never real and always 404'd —
// confirmed 2026-09-15 that Assign alone is sufficient, so this is now a
// purely local status change, same as it already effectively was in
// practice (every card assigned here was already live regardless of
// whether this step ever succeeded).
router.post('/:id/activate', requirePermission('cards', 'can_edit'), (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'Activation phone number is required' });
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'Activation phone number must be a valid phone number (10 digits, or 11 digits starting with 1)' });
  const activatedAt = new Date().toISOString();
  db.prepare(`UPDATE cards SET status='activated', activation_phone=?, activated_at=? WHERE id=?`).run(normalizePhone(phone), activatedAt, card.id);
  db.prepare(`INSERT INTO card_transactions (id, card_id, type, amount, occurred_at) VALUES (?,?,?,0,?)`).run(uuid(), card.id, 'activation', activatedAt);
  res.json({ card: db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id) });
});

// Deactivates the whole disccardpromos ACCOUNT this card belongs to, not
// just this one card — confirmed against their real API, there is no
// per-card lock at all, only whole-customer is_active (see cardSync.js's
// lockApplicantCards, the same function reject/set-pending already use to
// do exactly this). giftcard.deactivateCard() used to be called here
// instead, hitting a guessed placeholder endpoint that was never real (same
// "OLD unverified placeholder" issue as activate — see that route's
// comment) and always 404'd, so this never actually worked before. Reuses
// lockApplicantCards rather than duplicating its logic so this stays
// consistent with reject/pause.
router.post('/:id/deactivate', requirePermission('cards', 'can_edit'), async (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  const applicant = card.applicant_id ? db.prepare('SELECT * FROM applicants WHERE id = ?').get(card.applicant_id) : null;
  if (!applicant) return res.status(400).json({ error: 'This card has no applicant on file to deactivate the account for' });
  const result = await lockApplicantCards(req.user.org_id, applicant);
  if (result.errors.length) return res.status(502).json({ error: `disccardpromos rejected the deactivation: ${result.errors[0]}` });
  res.json({ ok: true });
});

// Pull latest balance/status + transactions from disccardpromos for one card.
// Unlike sync-all (below), which sweeps many cards and can't let one bad
// card take the whole batch down, this is a single card the admin just
// clicked "Sync Now" on — a disccardpromos failure here should come back as
// a real error to show them, same 502 pattern as activate/deactivate above,
// not an unhandled throw that surfaces as a bare "Internal server error".
router.post('/:id/sync', requirePermission('cards', 'can_edit'), async (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  let synced;
  try {
    synced = await syncOneCard(req.user.org_id, card);
  } catch (e) {
    console.error('[cards] sync failed:', e.message);
    return res.status(502).json({ error: `disccardpromos sync failed: ${e.message}` });
  }
  res.json({ synced, mockMode: giftcard.isMockMode(card.season_id) });
});

// Sweep every assigned/activated card at once — also runs automatically on a
// background interval (see index.js) so store spend stays live without
// anyone needing to click in.
router.post('/sync-all', requirePermission('cards', 'can_edit'), async (req, res) => {
  const result = await syncAllCards(req.user.org_id);
  // Sweeps every season's cards at once (syncAllCards resolves each card's
  // own season internally) — mockMode here is just the org-wide default for
  // the summary badge, not a per-card truth.
  res.json({ ...result, mockMode: giftcard.isMockMode(null) });
});

router.get('/:id/transactions', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  res.json({ transactions: db.prepare('SELECT * FROM card_transactions WHERE card_id = ? ORDER BY occurred_at DESC').all(card.id) });
});

// Full-detail CSV export of every transaction across the org.
router.get('/transactions/export', requirePermission('cards', 'can_export'), (req, res) => {
  const { type, store_id } = req.query;
  let where = 'WHERE c.org_id = ?';
  const params = [req.user.org_id];
  if (type) { where += ' AND t.type = ?'; params.push(type); }
  if (store_id) { where += ' AND t.store_id = ?'; params.push(store_id); }
  const rows = db.prepare(`SELECT t.*, a.first_name, a.last_name, c.card_number_masked, s.name as resolved_store_name
    FROM card_transactions t JOIN cards c ON c.id=t.card_id LEFT JOIN applicants a ON a.id=c.applicant_id LEFT JOIN stores s ON s.id=t.store_id
    ${where} ORDER BY t.occurred_at DESC`).all(...params);
  sendXlsx(res, `transactions-${Date.now()}.xlsx`, rows);
});

// Reconciliation breakdown for "why doesn't our Total spent match
// disccardpromos' number for the season" — every known way the two can
// legitimately drift, each with a count, a dollar figure, and a few sample
// rows, so the gap can be attributed to a specific cause from the admin
// screen instead of guessed at. Everything here is read-only over rows the
// sync pipeline already stored (raw_payload keeps disccardpromos' original
// entry), scoped to one season through each card's own season.
router.get('/transactions/reconcile', requirePermission('cards', 'can_view'), (req, res) => {
  const orgId = req.user.org_id;
  const seasonId = req.query.season_id || getActiveSeasonId(orgId);
  const season = seasonId ? db.prepare('SELECT id, name, start_date, end_date FROM seasons WHERE id = ? AND org_id = ?').get(seasonId, orgId) : null;
  const rows = db.prepare(`SELECT t.id, t.card_id, t.provider_txn_id, t.type, t.amount, t.store_name, t.occurred_at, t.raw_payload,
      c.status AS card_status, c.card_number_masked, c.season_id, a.id AS applicant_id, a.first_name, a.last_name
    FROM card_transactions t JOIN cards c ON c.id = t.card_id LEFT JOIN applicants a ON a.id = c.applicant_id
    WHERE c.org_id = ? AND t.provider_txn_id IS NOT NULL${season ? ' AND c.season_id = ?' : ''}`).all(orgId, ...(season ? [season.id] : []));
  const money = v => Math.round((Number(v) || 0) * 100) / 100;
  const sample = r => ({ date: r.occurred_at, store: r.store_name, amount: r.amount, who: `${r.first_name || ''} ${r.last_name || ''}`.trim() || '(deleted applicant)', card: r.card_number_masked, providerId: r.provider_txn_id });
  const bucket = () => ({ count: 0, amount: 0, samples: [] });
  const add = (b, r, amt = Math.abs(r.amount)) => { b.count++; b.amount = money(b.amount + amt); if (b.samples.length < 8) b.samples.push(sample(r)); };

  const purchases = bucket(), refunds = bucket(), outOfWindow = bucket(), paidMissing = bucket(), cartDiffers = bucket(),
    deletedApplicant = bucket(), deactivatedCard = bucket(), duplicates = bucket();
  const start = season?.start_date ? String(season.start_date).slice(0, 10) : null;
  const end = season?.end_date ? String(season.end_date).slice(0, 10) : null;
  const seen = new Map();
  for (const r of rows) {
    if (r.amount < 0) add(purchases, r); else if (r.amount > 0) add(refunds, r);
    const day = String(r.occurred_at || '').slice(0, 10);
    if (r.amount < 0 && day && ((start && day < start) || (end && day > end))) add(outOfWindow, r);
    let raw = null; try { raw = JSON.parse(r.raw_payload); } catch {}
    if (raw && r.amount < 0) {
      if (raw.disccardPaid == null && raw.cartAmount != null) add(paidMissing, r);
      else if (raw.disccardPaid != null && raw.cartAmount != null && Number(raw.cartAmount) !== Number(raw.disccardPaid)) add(cartDiffers, r, money(Number(raw.cartAmount) - Number(raw.disccardPaid)));
    }
    if (!r.applicant_id && r.amount < 0) add(deletedApplicant, r);
    if (r.card_status === 'deactivated' && r.amount < 0) add(deactivatedCard, r);
    // Same card, same moment, same store, same amount under two different
    // provider ids — an id-representation duplicate the boot-time repair
    // couldn't pair up. Only the extra copies are counted here.
    const key = `${r.card_id}|${r.occurred_at}|${r.amount}|${r.store_name}`;
    if (seen.has(key)) { if (r.amount < 0) add(duplicates, r); } else seen.set(key, r.id);
  }
  res.json({
    season: season ? { id: season.id, name: season.name, start_date: season.start_date, end_date: season.end_date } : null,
    rowsConsidered: rows.length,
    purchases, refunds, netAfterRefunds: money(purchases.amount - refunds.amount), totalSpent: money(purchases.amount - refunds.amount),
    outOfSeasonWindow: outOfWindow, disccardPaidMissing: paidMissing, cartAmountDiffersFromPaid: cartDiffers,
    onDeletedApplicant: deletedApplicant, onDeactivatedCard: deactivatedCard, likelyDuplicates: duplicates,
  });
});

// All transactions across the org — "see all transactions they make in stores,
// with all transaction info, balance, activation time, refunds — everything."
router.get('/transactions/all', (req, res) => {
  const { page = 1, pageSize = 100, type, store_id } = req.query;
  let where = 'WHERE c.org_id = ?';
  const params = [req.user.org_id];
  if (type) { where += ' AND t.type = ?'; params.push(type); }
  if (store_id) { where += ' AND t.store_id = ?'; params.push(store_id); }
  const total = db.prepare(`SELECT COUNT(*) c FROM card_transactions t JOIN cards c ON c.id=t.card_id ${where}`).get(...params).c;
  const offset = (Math.max(1, +page) - 1) * +pageSize;
  const rows = db.prepare(`SELECT t.*, a.first_name, a.last_name, c.card_number_masked
    FROM card_transactions t JOIN cards c ON c.id=t.card_id LEFT JOIN applicants a ON a.id=c.applicant_id
    ${where} ORDER BY t.occurred_at DESC LIMIT ? OFFSET ?`).all(...params, +pageSize, offset);
  res.json({ transactions: rows, total, page: +page, pageSize: +pageSize });
});

export default router;
