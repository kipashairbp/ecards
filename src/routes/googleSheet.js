import { Router } from 'express';
import { db } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { getStatus, syncSheet, shareReadOnly, unshare } from '../services/googleSheetSync.js';

const router = Router();
router.use(auth);

router.get('/status', requirePermission('settings'), (req, res) => res.json(getStatus(req.user.org_id)));

// Creates the spreadsheet on first use, then fills every tab from the database.
router.post('/sync', requirePermission('settings', 'can_edit'), async (req, res) => {
  try { res.json(await syncSheet(req.user.org_id, { trigger: 'manual', userId: req.user.id })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/settings', requirePermission('settings', 'can_edit'), (req, res) => {
  const interval = ['off', 'hourly', 'daily'].includes(req.body?.interval) ? req.body.interval : 'off';
  db.prepare(`INSERT INTO settings (org_id, key, value) VALUES (?,?,?) ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value`).run(req.user.org_id, 'google_sheet_export_interval', interval);
  res.json(getStatus(req.user.org_id));
});

router.post('/share', requirePermission('settings', 'can_edit'), async (req, res) => {
  try { res.json({ sharedWith: await shareReadOnly(req.user.org_id, req.body?.email) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/share', requirePermission('settings', 'can_edit'), async (req, res) => {
  try { res.json({ sharedWith: await unshare(req.user.org_id, String(req.query.email || req.body?.email || '').toLowerCase()) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

export default router;
