// Spend that is real on disccardpromos' side but has no card row here —
// unattributed_transactions (see cardSync.js): transactions of customers
// that aren't linked to any applicant at all, or of a multi-card applicant
// whose transaction mask matched no specific card. disccardpromos counts
// all of it in its own totals, so every headline spend figure here adds it
// too, otherwise "our number is lower than theirs" by exactly this much.
// Scoped to a season through the season's own date window (these rows have
// no card to carry a season); a season without dates, or no season, means
// everything.
import { db } from '../db.js';
import { memo } from './aggCache.js';

const NET = `CASE WHEN type = 'refund' THEN -amount WHEN amount < 0 THEN -amount ELSE 0 END`;

function seasonWindow(orgId, seasonId) {
  if (!seasonId) return null;
  const s = db.prepare('SELECT start_date, end_date FROM seasons WHERE id = ? AND org_id = ?').get(seasonId, orgId);
  if (!s || (!s.start_date && !s.end_date)) return null;
  return { start: s.start_date ? String(s.start_date).slice(0, 10) : null, end: s.end_date ? String(s.end_date).slice(0, 10) : null };
}

function windowClause(orgId, seasonId, params) {
  const w = seasonWindow(orgId, seasonId);
  let sql = '';
  if (w?.start) { sql += ` AND substr(occurred_at, 1, 10) >= ?`; params.push(w.start); }
  if (w?.end) { sql += ` AND substr(occurred_at, 1, 10) <= ?`; params.push(w.end); }
  return sql;
}

export function unattributedNet(orgId, { seasonId = null, storeId = null } = {}) {
  const params = [orgId];
  let sql = `SELECT COALESCE(SUM(${NET}), 0) AS net, COUNT(*) AS n FROM unattributed_transactions WHERE org_id = ?`;
  sql += windowClause(orgId, seasonId, params);
  if (storeId) { sql += ' AND store_id = ?'; params.push(storeId); }
  const r = db.prepare(sql).get(...params);
  return { net: Math.round((Number(r.net) || 0) * 100) / 100, count: r.n };
}

// { storeId: net } for every store with unattributed spend in the window.
export function unattributedByStore(orgId, seasonId = null) {
  const params = [orgId];
  let sql = `SELECT store_id, COALESCE(SUM(${NET}), 0) AS net FROM unattributed_transactions WHERE org_id = ? AND store_id IS NOT NULL`;
  sql += windowClause(orgId, seasonId, params);
  sql += ' GROUP BY store_id';
  return Object.fromEntries(db.prepare(sql).all(...params).map(r => [r.store_id, Math.round((Number(r.net) || 0) * 100) / 100]));
}

// Net spend on cards that exist here (card_transactions), for an org and
// optionally one season (through the card the charge was made on). A
// whole-table scan, so it is cached briefly (see aggCache.js — every sync and
// audited change drops the cache). Total spent everywhere = this + unattributedNet().
export function attributedNet(orgId, seasonId) {
  return memo(`attributedNet:${orgId}:${seasonId || ''}`, () => {
    const r = db.prepare(`SELECT COALESCE(SUM(CASE WHEN t.type = 'refund' THEN -t.amount WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0) net
      FROM card_transactions t JOIN cards c ON c.id = t.card_id WHERE c.org_id = ?${seasonId ? ' AND c.season_id = ?' : ''}`).get(orgId, ...(seasonId ? [seasonId] : []));
    return Math.round((Number(r.net) || 0) * 100) / 100;
  });
}
