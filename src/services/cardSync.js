import { db, uuid } from '../db.js';
import * as giftcard from './giftcard.js';
import { resolveStoreId } from './storeMatch.js';
import { scheduleProviderEnforceSoon } from './providerEnforce.js';

// Pulls fresh transaction history for the one applicant this card belongs
// to and syncs everything for them in one shot — disccardpromos has no
// per-card endpoint at all (confirmed 2026-09-15: transactions live on the
// CUSTOMER, same as balances/active_cards — see syncApplicantCards below),
// so there's no way to ask for just this one card's activity when the
// applicant holds more than one. Shared by the manual per-card "Sync Now"
// button; returns the number of NEW transactions inserted across every
// card this applicant holds, not just this specific one.
export async function syncOneCard(orgId, card) {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ?').get(card.applicant_id);
  if (!applicant) return 0;
  const { synced } = await syncApplicantCards(orgId, applicant);
  return synced;
}

// Locks an applicant's disccardpromos customer — used when an applicant is
// rejected or moved back to pending (spec: "rejecting or making a customer
// pending should trigger a lock on the card by disccard"), so their card(s)
// can't keep being spent once they're no longer approved. Per disccardpromos'
// real Customer API, `is_active` is a field on the CUSTOMER, not on an
// individual card — there is no per-card lock/deactivate endpoint at all —
// so this deactivates the whole customer record rather than any specific
// card, and every local card row for them is marked deactivated to match
// (an applicant only ever has one disccardpromos customer regardless of how
// many cards they hold). Reactivation on (re-)approval is folded directly
// into giftcard.js's upsertAccountForApproval (isActive: true alongside
// every other field in the same call) rather than a separate PATCH here —
// live-tested 2026-08-19 that a bare `{is_active: true}` PATCH issued right
// after account creation/update was wiping the external_id that same
// approval had just set, breaking duplicate-customer prevention and
// add-funds (both look the customer up by external_id) on every approval.
// Best-effort: a provider failure is returned to the caller to surface, but
// never blocks the status change that triggered it — the local rows are
// still marked deactivated either way, since "no longer approved" should
// never show as still-active in our own UI regardless of whether the
// provider call succeeded.
export async function lockApplicantCards(orgId, applicant) {
  db.prepare(`UPDATE cards SET status='deactivated', deactivated_at=datetime('now') WHERE applicant_id = ? AND status IN ('assigned','activated')`).run(applicant.id);
  if (!applicant.provider_account_id) return { errors: [] };
  // Used to check for another applicant row still approved and sharing this
  // same provider_account_id, and skip the live lock if so — a leftover
  // guard from before services/duplicates.js's mergeApplicants hard-deleted
  // the losing row on merge (it does now — see hardDeleteApplicant there).
  // A merge collapses into exactly one live applicant row, so there is no
  // "other still-approved row sharing this account" left to protect; two
  // separate rows pointing at the same account is not a real, current
  // state. Removed rather than left as a check that could never fire.
  try {
    // externalId included alongside isActive — live-tested 2026-08-19 that a
    // bare {is_active:false}-only PATCH clears the customer's external_id
    // back to null instead of leaving it alone (see upsertAccountForApproval
    // in giftcard.js for the full story). Re-sending it here is what keeps
    // by-external-id lookups working for this applicant after a reject.
    await giftcard.updateCustomer(applicant.season_id, applicant.provider_account_id, { isActive: false, externalId: applicant.external_id });
    return { errors: [] };
  } catch (e) {
    console.error('[cardSync] failed to lock disccardpromos customer for applicant', applicant.id, ':', e.message);
    // Best-effort here, but never silently forgotten: the enforcer re-runs
    // shortly and locks it then (see services/providerEnforce.js).
    scheduleProviderEnforceSoon(orgId, `lock failed for applicant ${applicant.id}`);
    return { errors: [e.message] };
  }
}

// disccardpromos' documented List Customers response already includes
// active_cards (masked numbers) and packages (with amount/rate) on every
// customer by default, and — confirmed 2026-09-15 — transaction history
// too, opt-in via the same ?transactions=true flag already confirmed on
// getCustomerByExternalId, now also confirmed on the list endpoint. So an
// `index` from ONE giftcard.buildCustomerIndex(seasonId, {transactions:true})
// pull covering the whole sweep has everything this function needs; no
// per-applicant GET required at all when it's provided. See syncAllCards
// below, which is the only real caller.
const cleanProviderId = id => String(id).replace(/\.0$/, '');

// Reconciles a customer's actual active_cards against our local cards table
// in both directions, AND syncs their transaction history — everything
// disccardpromos exposes for this applicant lives on their one CUSTOMER
// record, not per-card (there is no stable per-card id at all — confirmed,
// see giftcard.js's linkCardToCustomer):
//  - discovers cards activated directly on disccardpromos' own dashboard,
//    which this app would otherwise never learn about since they never went
//    through routes/cards.js's /assign.
//  - marks locally assigned/activated cards as removed once their masked
//    number is no longer in the customer's active_cards, so a card
//    unassigned/removed on disccardpromos' side stops showing as live here.
//  - inserts every new transaction (INSERT OR IGNORE on provider_txn_id, so
//    a repeat sync never double-counts) into the ledger. card_transactions
//    requires a specific local card_id, so each transaction is attributed
//    by matching its own card-number field (their exact field name for this
//    isn't pinned down by anything confirmed yet — every plausible one is
//    tried) against a masked number on file; when nothing matches AND this
//    applicant holds exactly one card (the overwhelmingly common case),
//    it's attributed to that one card instead of dropped. A genuinely
//    unattributable transaction (more than one card on file, no way to
//    tell which) is counted in `unattributed` rather than guessed at.
//
// index (optional): a { byId, byExt } map from ONE
// giftcard.buildCustomerIndex(seasonId, {transactions:true}) pull, passed
// by syncAllCards below covering every applicant in that whole sweep — read
// off it instead of this function doing its own GET. This used to mean one
// disccardpromos request PER APPLICANT with a provider account, every
// single 15-minute sweep. Omit index for a single-applicant caller (the
// manual "Sync Now" button), which falls back to a live per-applicant GET.
export async function syncApplicantCards(orgId, applicant, index) {
  if (!applicant.provider_account_id || applicant.provider_exempt) return { discovered: 0, removed: 0, synced: 0, unattributed: 0, malformed: 0, fetchFailed: false };
  let customer;
  if (index) {
    const cleanId = cleanProviderId(applicant.provider_account_id);
    customer = index.byId.get(cleanId) || (applicant.external_id ? index.byExt.get(String(applicant.external_id)) : null) || null;
  } else {
    try {
      customer = await giftcard.getCustomerByExternalId(applicant.season_id, applicant.external_id, { balances: true, transactions: true });
    } catch (e) {
      console.error('[cardSync] failed to fetch customer for sync, applicant', applicant.id, ':', e.message);
      // Distinct from "fetched fine, nothing new" — this used to return the
      // exact same all-zero shape as a genuinely up-to-date applicant, so a
      // real fetch failure (network hiccup, disccardpromos rate limit, a
      // timeout on a large org with many real accounts) was indistinguishable
      // from "nothing to sync" anywhere the caller could see. Surfaced now so
      // a sweep that's silently failing for many applicants — the likely
      // reason a manual re-sync keeps finding a few more each time instead of
      // catching up in one pass — is visible instead of looking like slow,
      // steady, expected progress.
      return { discovered: 0, removed: 0, synced: 0, unattributed: 0, malformed: 0, fetchFailed: true };
    }
  }
  if (!customer) return { discovered: 0, removed: 0, synced: 0, unattributed: 0, malformed: 0, fetchFailed: false };
  const remoteMasked = new Set(Array.isArray(customer.active_cards) ? customer.active_cards : []);
  const localActive = db.prepare(`SELECT id, card_number_masked FROM cards WHERE applicant_id = ? AND status IN ('assigned','activated')`).all(applicant.id);
  // Matched by trailing digits, not exact string equality. routes/cards.js's
  // /assign only gets disccardpromos' OWN masked format when their PATCH
  // response happens to already reflect the just-added card in active_cards
  // — if it doesn't (yet), it falls back to inventing `****${last4}` itself,
  // which may not match whatever convention disccardpromos actually masks
  // with (more digits shown, different padding, ...). An exact-string
  // comparison here would then never recognize that invented mask as the
  // same card: every sync would see it as "no longer active" (removed) AND
  // "a new card" (discovered) at once — a real card silently disappearing
  // and a phantom duplicate appearing in its place, every single sweep. The
  // last 4 digits are the one thing guaranteed to agree regardless of
  // either side's exact display convention.
  const trailingDigits = s => String(s || '').replace(/\D+$/, '').slice(-4);
  const remoteByLast4 = new Map([...remoteMasked].map(m => [trailingDigits(m), m]));
  const knownLast4 = new Set(localActive.map(c => trailingDigits(c.card_number_masked)));

  // Package balance is the customer's aggregate — the best per-card figure
  // available, since disccardpromos doesn't expose a per-card balance
  // without a stable card id to ask about.
  const balance = (customer.packages || []).reduce((sum, p) => sum + (Number(p.balance) || 0), 0);
  let discovered = 0;
  for (const [last4, masked] of remoteByLast4) {
    if (knownLast4.has(last4)) continue;
    db.prepare(`INSERT INTO cards (id, org_id, applicant_id, season_id, card_number_masked, provider_card_id, status, amount, assigned_at, activated_at)
      VALUES (?,?,?,?,?,NULL,'activated',?,datetime('now'),datetime('now'))`)
      .run(uuid(), orgId, applicant.id, applicant.season_id, masked, balance);
    discovered++;
  }

  let removed = 0;
  const deactivate = db.prepare(`UPDATE cards SET status='deactivated', deactivated_at=datetime('now') WHERE id = ?`);
  const updateMask = db.prepare(`UPDATE cards SET card_number_masked = ? WHERE id = ?`);
  for (const local of localActive) {
    const last4 = trailingDigits(local.card_number_masked);
    const real = remoteByLast4.get(last4);
    if (real === undefined) { deactivate.run(local.id); removed++; continue; }
    // A locally-invented fallback mask (see the comment above) now has a
    // real one to reconcile against — keep what's shown here matching what
    // disccardpromos' own dashboard shows for the same physical card.
    if (real !== local.card_number_masked) updateMask.run(real, local.id);
  }
  // Refresh EVERY still-active local card's displayed amount to the real
  // current balance on every sync — this used to only ever get written once,
  // at assign time (routes/cards.js) or for a freshly-discovered card
  // (above), and never again, so the Cards page went on showing whatever the
  // committed amount happened to be the moment the card was assigned
  // forever after, regardless of real spend-down or later top-ups.
  if (localActive.length) {
    const updateAmount = db.prepare(`UPDATE cards SET amount = ? WHERE id = ?`);
    for (const local of localActive) updateAmount.run(balance, local.id);
  }

  // Every local card this applicant has (including one just discovered
  // above), for transaction attribution below.
  const allLocal = db.prepare(`SELECT id, card_number_masked FROM cards WHERE applicant_id = ?`).all(applicant.id);
  const byMasked = new Map(allLocal.filter(c => c.card_number_masked).map(c => [c.card_number_masked, c.id]));
  const soleCardId = allLocal.length === 1 ? allLocal[0].id : null;

  // Real per-card mask on a transaction (confirmed 2026-09-15 from a live
  // sample: "************1123", 12 asterisks + last4) doesn't match either
  // our own stored format or disccardpromos' own active_cards format
  // ("****1123") — same mismatch already handled above for active_cards,
  // matched here the same way, by trailing digits.
  const byLast4 = new Map(allLocal.filter(c => c.card_number_masked).map(c => [trailingDigits(c.card_number_masked), c.id]));

  let synced = 0, unattributed = 0;
  // customer.transactions is confirmed (2026-09-15, live sample) as the
  // real field name for the array ?transactions=true adds. Falls back to
  // checking each package for a nested transactions array in case that
  // ever changes. If genuinely nothing is found, logs exactly which
  // top-level (and array-valued) fields the real response DOES carry, so
  // the actual field name is discoverable straight from server logs the
  // next time a real sync runs, without needing a live sample handed over
  // separately.
  const hasTopLevelArray = Array.isArray(customer.transactions);
  const packagesWithTxns = (customer.packages || []).filter(p => Array.isArray(p.transactions));
  const txns = hasTopLevelArray ? customer.transactions : packagesWithTxns.flatMap(p => p.transactions);
  // Only a genuinely missing/wrong-typed field is worth flagging — an
  // array that's just empty (a real customer with no spend yet) is not a
  // mapping bug and would make this fire on almost every sync.
  if (!hasTopLevelArray && !packagesWithTxns.length) {
    const arrayKeys = Object.keys(customer).filter(k => Array.isArray(customer[k]) && k !== 'active_cards' && k !== 'packages');
    console.error(`[cardSync] no transaction history field found on customer ${customer.id ?? customer._id ?? applicant.external_id} even though ?transactions=true was requested — top-level keys on the response: ${Object.keys(customer).join(', ')}.${arrayKeys.length ? ` Other array field(s) present: ${arrayKeys.join(', ')} — one of these is likely the real transaction list; tell Claude the name to fix the mapping.` : ' No array field at all was found on this customer to guess from.'}`);
  }
  const insert = db.prepare(`INSERT OR IGNORE INTO card_transactions (id, card_id, provider_txn_id, type, amount, balance_after, store_name, store_id, occurred_at, raw_payload)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  let malformed = 0;
  for (const t of txns) {
    // Each entry is handled in its own try/catch — one transaction whose
    // shape doesn't match anything guessed below (an older/legacy entry
    // kind, a refund/adjustment shape we haven't seen yet, ...) must never
    // take down the rest of the array with it. Before this, a single bad
    // entry (e.g. every guessed amount field missing, so `amount` came out
    // `undefined` — better-sqlite3 throws on binding `undefined`) threw
    // uncaught, aborting this whole loop and silently dropping every
    // transaction after it for the rest of this sync — exactly the "only
    // some transactions load, older ones never show up" symptom, since
    // disccardpromos' own array order isn't something this app controls.
    try {
      // Real field names confirmed 2026-09-15 from a live sample: "card"
      // (masked, "************1123" format — matched by trailing digits, see
      // byLast4 above), "disccardPaid" (the actual amount debited from the
      // account — preferred over "cartAmount", which can differ when a
      // discount/split applies), "vendor", "timestamp". There is no "type"
      // field in real responses at all; the sign-based guess is kept only as
      // a fallback in case a refund ever does show up with a negative amount.
      const maskedRaw = t.card || t.card_number_masked || t.masked_card_number || t.card_number || null;
      const last4 = maskedRaw ? trailingDigits(maskedRaw) : null;
      const cardId = (last4 && byLast4.get(last4)) || (maskedRaw && byMasked.get(maskedRaw)) || soleCardId;
      if (!cardId) { unattributed++; continue; }
      const rawAmount = t.disccardPaid ?? t.cartAmount ?? t.amount;
      const occurredAt = t.timestamp || t.occurred_at || t.date;
      if (rawAmount === undefined || occurredAt === undefined) {
        malformed++;
        console.error(`[cardSync] transaction ${t.id ?? t.transaction_id ?? '(no id)'} on customer ${customer.id ?? applicant.external_id} doesn't match any known shape (missing amount and/or date) — raw entry: ${JSON.stringify(t)}`);
        continue;
      }
      // Trimmed — disccardpromos has sent the same real vendor with stray
      // leading/trailing whitespace on some transactions and not others,
      // which used to split one store's history into multiple "different"
      // vendor names (see storeMatch.js's now case/whitespace-insensitive
      // resolveStoreId, and routes/stores.js's provider-vendors grouping).
      const storeName = (t.vendor || t.store_name || t.merchant || '').trim();
      // Stringified explicitly — the real id is a bare JSON number (320972),
      // and binding a raw JS integer into this TEXT column lets SQLite coerce
      // it through REAL first, silently storing "320972.0" instead (the same
      // trailing-".0" quirk documented elsewhere for provider_account_id).
      const providerTxnId = String(t.id ?? t.transaction_id);
      // A refund is recognised by any of: a negative charged amount, an
      // explicit type/kind/status/flag field saying so, or "refund"/
      // "reversal"/"void"/"chargeback" in the vendor or description text —
      // disccardpromos' real entries carry no `type`, so which of these
      // (if any) marks a refund isn't pinned down; matching all of them
      // means a refund counts as a refund whichever way it shows up, and
      // an ordinary purchase (positive amount, no such marker) never does.
      const refundWord = /\b(refund|refunded|reversal|reversed|void|voided|chargeback)\b/i;
      const isRefund = rawAmount < 0
        || t.is_refund === true || t.refund === true
        || [t.type, t.kind, t.transaction_type, t.status, t.description, t.note, t.vendor].some(v => typeof v === 'string' && refundWord.test(v));
      const type = isRefund ? 'refund' : 'purchase';
      // Every existing spend total in this app (dashboard.js's
      // totalStoreSpend/topStores, stores.js's total_purchases) sums
      // card_transactions by SIGN, not by `type`: negative = a purchase,
      // positive = money added back (refund/load) — set by the ONE other
      // writer of this table, /cards/assign's initial "load" row, which is
      // always a positive amount. disccardPaid/cartAmount are always
      // POSITIVE in real disccardpromos data (confirmed 2026-09-15 — it's
      // "how much was charged", not signed), so storing it as-is put every
      // single real purchase on the wrong side of every sign check in the
      // app — the actual reason store/dashboard spend totals came out a
      // small fraction of the real disccardpromos number, since virtually
      // all real spend was silently excluded from every SUM(...WHERE
      // amount < 0...) in the codebase. Negating it here (a purchase becomes
      // negative, a refund becomes positive) is the one place this needs to
      // happen to match every existing convention instead of rewriting every
      // query that already relies on it.
      const storedAmount = isRefund ? Math.abs(rawAmount) : -Math.abs(rawAmount);
      const info = insert.run(uuid(), cardId, providerTxnId, type, storedAmount, t.balance_after ?? null, storeName, resolveStoreId(orgId, storeName), occurredAt, JSON.stringify(t));
      if (info.changes) synced++;
    } catch (e) {
      malformed++;
      console.error(`[cardSync] failed to insert a transaction for customer ${customer.id ?? applicant.external_id}:`, e.message, '— raw entry:', JSON.stringify(t));
    }
  }
  if (allLocal.length) db.prepare(`UPDATE cards SET last_synced_at = datetime('now') WHERE applicant_id = ?`).run(applicant.id);

  return { discovered, removed, synced, unattributed, malformed, fetchFailed: false };
}

// Sweeps every applicant with a disccardpromos account in an org: syncs
// transaction history, discovers any card activated straight on
// disccardpromos' own dashboard, and marks a removed card deactivated here
// too. Used by the automatic background interval (see index.js) and the
// "Sync All" button — this is what makes card activity/store spend "live"
// without someone having to click into each card individually. No-ops
// instantly in mock mode.
export async function syncAllCards(orgId) {
  const applicants = db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND provider_account_id IS NOT NULL AND provider_exempt = 0`).all(orgId);
  // One List Customers pull per distinct season represented here (cached —
  // almost always just the one active season in practice), instead of
  // syncApplicantCards doing its own GET for every single applicant on
  // every 15-minute sweep. Falls back to null (syncApplicantCards' own
  // per-applicant lookup) if the pull itself fails.
  const indexBySeason = new Map();
  let indexPullsFailed = 0;
  const getIndex = async (seasonId) => {
    if (!indexBySeason.has(seasonId)) {
      indexBySeason.set(seasonId, giftcard.isMockMode(seasonId) ? null : giftcard.buildCustomerIndex(seasonId, { balances: true, transactions: true }).catch(e => {
        console.error(`[cardSync] could not pull the customer list up front for season ${seasonId}, falling back to per-applicant lookups:`, e.message);
        indexPullsFailed++;
        return null;
      }));
    }
    return indexBySeason.get(seasonId);
  };
  let totalSynced = 0, cardsDiscovered = 0, cardsRemoved = 0, unattributed = 0, malformed = 0, failed = 0;
  for (const applicant of applicants) {
    try {
      const index = await getIndex(applicant.season_id);
      const { discovered, removed, synced, unattributed: u, malformed: m, fetchFailed } = await syncApplicantCards(orgId, applicant, index);
      cardsDiscovered += discovered; cardsRemoved += removed; totalSynced += synced; unattributed += u; malformed += m;
      if (fetchFailed) failed++;
    } catch (e) { console.error('[cardSync] sync failed for applicant', applicant.id, e.message); failed++; }
  }
  const cardsChecked = db.prepare(`SELECT COUNT(*) c FROM cards WHERE org_id = ? AND status IN ('assigned','activated')`).get(orgId).c;
  // When the ONE bulk list pull for a season fails, every applicant in it
  // falls back to its own live per-applicant GET — for an org with many real
  // accounts, that's a lot of sequential round trips in one request, and any
  // one of those can time out or get rate-limited independently. `failed`
  // surfaces exactly how many applicants a run genuinely could not reach,
  // as opposed to ones that were reached and simply had nothing new — this
  // is what makes "the total keeps climbing a little on every re-sync
  // instead of catching up in one pass" diagnosable instead of looking like
  // ordinary incremental progress.
  return { cardsChecked, transactionsSynced: totalSynced, cardsDiscovered, cardsRemoved, unattributed, malformed, failed, indexPullsFailed };
}
