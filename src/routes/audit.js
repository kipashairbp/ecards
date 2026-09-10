import { Router } from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import { getRecentActions, undoAuditEntry } from '../services/audit.js';
import { getApiCallLogs } from '../services/apiCallLog.js';

const router = Router();
// This is a full activity feed across every entity in the org (every
// applicant/shul/store/card change, who made it, from what IP), plus the
// ability to reverse changes — a materially different power than most
// resources, so it's hardcoded to super_admin only rather than a grantable
// permission — no admin can hand this out to an org_admin/staff user via
// Users & Permissions, ever. Not in PERMISSION_RESOURCES at all (see
// middleware/permissions.js).
router.use(auth, requireRole('super_admin'));

router.get('/recent', (req, res) => {
  const hours = Math.min(168, Math.max(1, +req.query.hours || 48));
  res.json({ actions: getRecentActions(req.user.org_id, hours) });
});

router.post('/:id/undo', (req, res) => {
  try {
    const newEntryId = undoAuditEntry(req.params.id, req.user, req.ip);
    res.json({ ok: true, undoEntryId: newEntryId });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// The Logs page's "Logs" tab (as distinct from "Recent Actions") — every
// outbound request this platform made to SMS/email/disccardpromos, logged
// at the one low-level call function each service funnels through (see
// services/apiCallLog.js). Filterable/sortable/searchable/paginated, same
// shape as every other list endpoint in this app.
router.get('/api-logs', (req, res) => {
  const { provider, success, search, hours, sort, dir, page, pageSize } = req.query;
  res.json(getApiCallLogs(req.user.org_id, { provider, success, search, hours, sort, dir, page, pageSize }));
});

export default router;
