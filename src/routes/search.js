import { Router } from 'express';
import { db } from '../db.js';
import { auth } from '../middleware/auth.js';
import { getPermission } from '../middleware/permissions.js';

const router = Router();
// No single blanket permission gate (unlike most routers here) — an admin
// shouldn't need the 'dashboard' resource specifically just to find a
// record they otherwise have full access to. Each resource below checks
// its own can_view instead, same as GET /dashboard/pending-counts, so a
// role that can't see e.g. Stores never gets a store back in its results.
router.use(auth);

// Cross-entity lookup across Shuls/Applicants/Stores by name/email/phone —
// today an admin has to already know which list a person lives in before
// they can find them. Read-only, capped to a handful of results per type
// (a jump-to box, not a report) — each result links straight to that
// record's existing `?id=` deep link (shuls.html/applicants.html/
// stores.html already auto-open the matching detail popup from it).
router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const orgId = req.user.org_id;
  const like = `%${q}%`;
  const results = [];

  if (getPermission(req.user, 'shuls').can_view) {
    const rows = db.prepare(`SELECT id, name_en, gabai_email, gabai_cell FROM shuls
      WHERE org_id = ? AND (name_en LIKE ? OR gabai_email LIKE ? OR gabai_cell LIKE ? OR ruv_phone LIKE ?)
      ORDER BY created_at DESC LIMIT 6`).all(orgId, like, like, like, like);
    for (const r of rows) results.push({ type: 'shul', id: r.id, label: r.name_en, sublabel: r.gabai_email || r.gabai_cell || '', href: `/admin/shuls?id=${r.id}` });
  }
  if (getPermission(req.user, 'applicants').can_view) {
    const rows = db.prepare(`SELECT a.id, a.first_name, a.last_name, a.email, a.external_id, s.name_en AS shul_name
      FROM applicants a LEFT JOIN shuls s ON s.id = a.shul_id
      WHERE a.org_id = ? AND ((a.first_name || ' ' || a.last_name) LIKE ? OR a.email LIKE ? OR a.husband_cell LIKE ? OR a.wife_cell LIKE ? OR a.home_phone LIKE ? OR a.external_id LIKE ?)
      ORDER BY a.created_at DESC LIMIT 6`).all(orgId, like, like, like, like, like, like);
    for (const r of rows) results.push({ type: 'applicant', id: r.id, label: `${r.first_name} ${r.last_name}`, sublabel: r.shul_name || r.email || '', href: `/admin/applicants?id=${r.id}` });
  }
  if (getPermission(req.user, 'stores').can_view) {
    const rows = db.prepare(`SELECT id, name, manager_email, owner_email, manager_phone, owner_phone FROM stores
      WHERE org_id = ? AND (name LIKE ? OR manager_email LIKE ? OR owner_email LIKE ? OR manager_phone LIKE ? OR owner_phone LIKE ?)
      ORDER BY created_at DESC LIMIT 6`).all(orgId, like, like, like, like, like);
    for (const r of rows) results.push({ type: 'store', id: r.id, label: r.name, sublabel: r.manager_email || r.owner_email || '', href: `/admin/stores?id=${r.id}` });
  }
  res.json({ results });
});

export default router;
