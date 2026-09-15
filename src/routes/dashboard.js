import { Router } from 'express';
import { db } from '../db.js';
import { auth } from '../middleware/auth.js';
import { getPermission, requirePermission } from '../middleware/permissions.js';
import { getActiveSeasonId } from '../utils/formSchedule.js';

const router = Router();
// Internal team only — every count below is computed org-wide (total shuls,
// total applicants, total card dollars loaded, top stores by spend), not
// scoped to a single shul/store, so a portal login must never reach this at
// all (no portal page calls it — each has its own scoped dashboard).
router.use(auth, requirePermission('dashboard'));

// Lightweight pending-counts for the nav notification dots — called on
// every admin page load (see renderShell() in app.js), so this stays a
// separate, minimal query rather than reusing the much heavier /stats
// (which joins across cards/stores/duplicate flags too). Respects each
// resource's view permission the same way /stats does, so a role that
// can't see a resource never gets a dot for it.
//
// Shuls and applicants are scoped to the org's current active season (#10:
// "make sure the red dots only work when needed") — without this, a shul or
// applicant left sitting unactioned in a long-closed past season would keep
// lighting up the nav forever, since nothing else ever revisits old-season
// records once a new season starts. Stores aren't season-scoped here since
// a store is one persistent record reused every season (see
// routes/stores.js's /:id/season-history), not a fresh per-season row —
// setup_status='pending' is meaningful regardless of season.
router.get('/pending-counts', (req, res) => {
  const orgId = req.user.org_id;
  const seasonId = getActiveSeasonId(orgId);
  const counts = {};
  if (getPermission(req.user, 'shuls').can_view) {
    counts.shuls = db.prepare(`SELECT COUNT(*) c FROM shuls WHERE org_id = ? AND is_locked = 0 AND status IN ('submitted','contract_sent','contract_signed') AND season_id = ?`).get(orgId, seasonId).c;
  }
  if (getPermission(req.user, 'applicants').can_view) {
    counts.applicants = db.prepare(`SELECT COUNT(*) c FROM applicants WHERE org_id = ? AND approval_status = 'pending' AND season_id = ?`).get(orgId, seasonId).c;
  }
  if (getPermission(req.user, 'stores').can_view) {
    counts.stores = db.prepare(`SELECT COUNT(*) c FROM stores WHERE org_id = ? AND setup_status = 'pending'`).get(orgId).c;
  }
  // Open duplicate-applicant flags for the active season — these only ever
  // surface today when an admin happens to click the Duplicates button, so
  // a fresh flag from an overnight import/carry-forward could sit unseen
  // indefinitely. Scoped the same way as counts.applicants above.
  if (getPermission(req.user, 'applicants').can_view) {
    counts.duplicates = db.prepare(`SELECT COUNT(*) c FROM duplicate_flags df JOIN applicants a ON a.id = df.entity_id
      WHERE df.org_id = ? AND df.entity_type = 'applicant' AND df.status = 'open' AND a.season_id = ?`).get(orgId, seasonId).c;
  }
  // Open rejection appeals — a shul asked why, and nobody's answered yet
  // (see applicant_rejection_appeals). Not season-scoped like the other
  // counts here: an appeal on an old-season rejection is still a real,
  // unanswered question from a shul, not something to let go stale.
  if (getPermission(req.user, 'applicants').can_view) {
    counts.appeals = db.prepare(`SELECT COUNT(*) c FROM applicant_rejection_appeals WHERE org_id = ? AND status = 'open'`).get(orgId).c;
  }
  res.json({ counts });
});

router.get('/stats', (req, res) => {
  const orgId = req.user.org_id;
  // Empty/absent season_id = "All Seasons" (the original, unscoped
  // behavior); a real id scopes every count below to just that season.
  const seasonId = req.query.season_id || '';
  const shulPerm = getPermission(req.user, 'shuls');
  const applicantPerm = getPermission(req.user, 'applicants');
  const cardPerm = getPermission(req.user, 'cards');
  const stats = {};

  const seasonClause = seasonId ? ' AND season_id = ?' : '';
  const seasonParams = seasonId ? [seasonId] : [];

  if (shulPerm.can_view) {
    stats.shuls = {
      total: db.prepare(`SELECT COUNT(*) c FROM shuls WHERE org_id = ? AND is_locked = 0${seasonClause}`).get(orgId, ...seasonParams).c,
      pending: db.prepare(`SELECT COUNT(*) c FROM shuls WHERE org_id = ? AND is_locked = 0 AND status IN ('submitted','contract_sent','contract_signed')${seasonClause}`).get(orgId, ...seasonParams).c,
      approved: db.prepare(`SELECT COUNT(*) c FROM shuls WHERE org_id = ? AND is_locked = 0 AND status = 'approved'${seasonClause}`).get(orgId, ...seasonParams).c,
      paused: db.prepare(`SELECT COUNT(*) c FROM shuls WHERE org_id = ? AND is_locked = 0 AND is_paused = 1${seasonClause}`).get(orgId, ...seasonParams).c,
    };
  }
  if (applicantPerm.can_view) {
    stats.applicants = {
      total: db.prepare(`SELECT COUNT(*) c FROM applicants WHERE org_id = ?${seasonClause}`).get(orgId, ...seasonParams).c,
      pending: db.prepare(`SELECT COUNT(*) c FROM applicants WHERE org_id = ? AND approval_status = 'pending'${seasonClause}`).get(orgId, ...seasonParams).c,
      approved: db.prepare(`SELECT COUNT(*) c FROM applicants WHERE org_id = ? AND approval_status = 'approved'${seasonClause}`).get(orgId, ...seasonParams).c,
      paused: db.prepare(`SELECT COUNT(*) c FROM applicants WHERE org_id = ? AND is_paused = 1${seasonClause}`).get(orgId, ...seasonParams).c,
    };
  }
  if (cardPerm.can_view) {
    stats.cards = {
      total: db.prepare(`SELECT COUNT(*) c FROM cards WHERE org_id = ?${seasonClause}`).get(orgId, ...seasonParams).c,
      activated: db.prepare(`SELECT COUNT(*) c FROM cards WHERE org_id = ? AND status='activated'${seasonClause}`).get(orgId, ...seasonParams).c,
      // Every approved applicant's committed card_amount, NOT SUM(cards.amount)
      // — the `cards` table only gets a row once a physical card number is
      // actually registered/discovered (see cardSync.js), so an approved
      // applicant whose money was loaded onto their disccardpromos package
      // but who never had a physical card activated was silently missing
      // from this total, even though Donor's Dash (routes/donorDashboard.js)
      // already used this same applicants-based formula and read correctly.
      // Same query as that page's `loaded` and this file's own /daily route
      // below (which already made this exact call) — now genuinely one
      // source of truth instead of two disagreeing ones.
      totalLoaded: db.prepare(`SELECT COALESCE(SUM(card_amount),0) t FROM applicants WHERE org_id = ? AND approval_status = 'approved'${seasonClause}`).get(orgId, ...seasonParams).t,
    };
  }
  // Duplicate flags aren't tied to a season (a flagged duplicate is either
  // resolved or not, independent of which season it was raised in), so this
  // stays org-wide regardless of the season filter.
  stats.duplicates = {
    open: db.prepare(`SELECT COUNT(*) c FROM duplicate_flags WHERE org_id = ? AND status = 'open'`).get(orgId).c,
  };
  const storePerm = getPermission(req.user, 'stores');
  if (storePerm.can_view) {
    // Store spend is per-transaction, not per-season directly — scope it
    // through the card a transaction was made against (a card belongs to
    // exactly one season).
    const storeSeasonClause = seasonId ? ' AND c2.season_id = ?' : '';
    stats.topStores = db.prepare(`SELECT s.id, s.name, COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END),0) total_purchases
      FROM stores s LEFT JOIN card_transactions t ON t.store_id = s.id LEFT JOIN cards c2 ON c2.id = t.card_id
      WHERE s.org_id = ?${storeSeasonClause} GROUP BY s.id ORDER BY total_purchases DESC LIMIT 5`).all(orgId, ...seasonParams).filter(s => s.total_purchases > 0);
    // Genuinely ALL real spend, not just spend attributable to a store
    // that's been added as a "participating store" record here — the
    // headline "Total spent across all participating stores" figure used
    // an INNER JOIN to stores, so any transaction whose vendor name (per
    // disccardpromos) didn't match an already-configured store — which is
    // the overwhelmingly common case for an org that hasn't manually
    // pre-added every vendor disccardpromos actually has — was silently
    // excluded from this total entirely, not just from the per-store
    // breakdown where that scoping actually belongs. Fixing the sync
    // pipeline to correctly pull and sign real transactions did nothing to
    // move this number, since the real gap was here, not in what got
    // synced. topStores above stays store-scoped on purpose — a per-store
    // breakdown inherently can't include spend with no store to attribute
    // it to — but the headline total no longer requires that match.
    const storeCardSeasonClause = seasonId ? ' AND c2.season_id = ?' : '';
    stats.totalStoreSpend = db.prepare(`SELECT COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END),0) total
      FROM card_transactions t JOIN cards c2 ON c2.id = t.card_id WHERE c2.org_id = ?${storeCardSeasonClause}`).get(orgId, ...seasonParams).total;
  }
  res.json({ stats });
});

// Per-day breakdown for the trailing `days` days (default 30, capped at 90)
// — new shul/applicant submissions, applicants approved, and $ loaded (card
// amount at approval time, since that's what's reliably populated the
// moment an approval happens, unlike the separate `cards` table which only
// gets a row once someone's actually issued a physical card). Every date in
// the window is always present in the response, zero-filled, so the
// frontend can render a continuous trend without gap-filling itself.
router.get('/daily', (req, res) => {
  const orgId = req.user.org_id;
  const seasonId = req.query.season_id || '';
  const days = Math.min(90, Math.max(1, +req.query.days || 30));
  const seasonClause = seasonId ? ' AND season_id = ?' : '';
  const seasonParams = seasonId ? [seasonId] : [];

  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const since = dates[0];

  const toMap = (rows) => Object.fromEntries(rows.map(r => [r.d, r.c]));
  const newShuls = toMap(db.prepare(`SELECT date(created_at) d, COUNT(*) c FROM shuls WHERE org_id = ? AND is_locked = 0 AND date(created_at) >= ?${seasonClause} GROUP BY d`).all(orgId, since, ...seasonParams));
  const newApplicants = toMap(db.prepare(`SELECT date(created_at) d, COUNT(*) c FROM applicants WHERE org_id = ? AND date(created_at) >= ?${seasonClause} GROUP BY d`).all(orgId, since, ...seasonParams));
  const approved = toMap(db.prepare(`SELECT date(approved_at) d, COUNT(*) c FROM applicants WHERE org_id = ? AND approval_status = 'approved' AND date(approved_at) >= ?${seasonClause} GROUP BY d`).all(orgId, since, ...seasonParams));
  const loadedRows = db.prepare(`SELECT date(approved_at) d, COALESCE(SUM(card_amount),0) c FROM applicants WHERE org_id = ? AND approval_status = 'approved' AND date(approved_at) >= ?${seasonClause} GROUP BY d`).all(orgId, since, ...seasonParams);
  const loaded = Object.fromEntries(loadedRows.map(r => [r.d, r.c]));

  const daily = dates.map(d => ({
    date: d,
    newShuls: newShuls[d] || 0,
    newApplicants: newApplicants[d] || 0,
    approved: approved[d] || 0,
    loaded: loaded[d] || 0,
  }));
  res.json({ daily });
});

export default router;
