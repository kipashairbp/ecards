import { db, uuid, DEFAULT_ORG_ID } from '../db.js';

// Records one outbound call to a third-party provider (email/sms/
// disccardpromos) — see services/mail.js, services/sms.js, services/
// giftcard.js for the single low-level call function each funnels every
// request through, which is where this gets invoked from. Never throws —
// a failure to log the call must never be the reason the call itself (or
// whatever business action triggered it) fails.
export function logApiCall(orgId, provider, {
  method, endpoint, requestSummary, statusCode, success, responseSummary,
  errorMessage, durationMs, relatedEntityType, relatedEntityId, userId, seasonId,
} = {}) {
  try {
    const clip = (v, n = 2000) => {
      if (v == null) return null;
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return s.length > n ? s.slice(0, n) + '…' : s;
    };
    db.prepare(`INSERT INTO api_call_log
      (id, org_id, provider, method, endpoint, request_summary, status_code, success, response_summary, error_message, duration_ms, related_entity_type, related_entity_id, user_id, season_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), orgId || DEFAULT_ORG_ID, provider, method || 'GET', endpoint || '',
        clip(requestSummary), statusCode ?? null, success ? 1 : 0, clip(responseSummary),
        errorMessage || null, durationMs ?? null, relatedEntityType || null, relatedEntityId || null,
        userId || null, seasonId || null);
  } catch (e) { console.error('[apiCallLog] failed to record call:', e.message); }
}

// Filtered/sorted/paginated read for the Logs page's "Logs" (API calls) tab.
// hours narrows to a recent window like getRecentActions; omit for "all time".
export function getApiCallLogs(orgId, {
  provider, success, search, hours, sort = 'created_at', dir = 'DESC', page = 1, pageSize = 50,
} = {}) {
  let where = 'WHERE l.org_id = ?';
  const params = [orgId];
  if (provider) { where += ' AND l.provider = ?'; params.push(provider); }
  if (success === '1' || success === '0' || success === 1 || success === 0) {
    where += ' AND l.success = ?'; params.push(+success);
  }
  if (hours) { where += ` AND l.created_at >= datetime('now', ?)`; params.push(`-${+hours} hours`); }
  if (search) {
    where += ` AND (l.endpoint LIKE ? OR l.request_summary LIKE ? OR l.response_summary LIKE ? OR l.error_message LIKE ? OR l.related_entity_id LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }
  const allowedSort = ['created_at', 'provider', 'method', 'endpoint', 'status_code', 'success', 'duration_ms'];
  const sortCol = allowedSort.includes(sort) ? sort : 'created_at';
  const sortDir = dir === 'ASC' ? 'ASC' : 'DESC';
  const total = db.prepare(`SELECT COUNT(*) c FROM api_call_log l ${where}`).get(...params).c;
  const offset = (Math.max(1, +page) - 1) * +pageSize;
  const rows = db.prepare(`SELECT l.*, u.first_name, u.last_name FROM api_call_log l LEFT JOIN users u ON u.id = l.user_id
    ${where} ORDER BY l.${sortCol} ${sortDir} LIMIT ? OFFSET ?`).all(...params, +pageSize, offset).map(r => ({
    ...r, success: !!r.success,
    userName: r.first_name ? `${r.first_name} ${r.last_name || ''}`.trim() : null,
  }));
  return { rows, total, page: +page, pageSize: +pageSize };
}
