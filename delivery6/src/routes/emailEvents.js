import { Router } from 'express';
import { db, DEFAULT_ORG_ID } from '../db.js';
import { renderSystemTemplate, sendMailChecked, escapeHtml } from '../services/mail.js';

const router = Router();

// Public — Brevo calls this directly, with no session of its own to
// authenticate. Configured once in Brevo's own dashboard (Transactional >
// Settings > Webhooks), not per-send, so every email this app sends
// through that account reports back here regardless of which code path
// sent it. Optional shared-secret check via a query param, since there's
// no session to otherwise prove this really came from Brevo and not
// someone guessing the URL — set EMAIL_WEBHOOK_SECRET and append
// ?secret=... to the webhook URL you give Brevo to enable it; without it
// configured, the endpoint stays open (same tradeoff the SMS inbound
// webhook already makes — see routes/sms.js).
const WEBHOOK_SECRET = process.env.EMAIL_WEBHOOK_SECRET || '';

// Brevo's own event names for "this didn't reach an inbox" — matched as a
// case-insensitive substring since the exact casing/spelling has drifted
// across Brevo API versions (hardBounce/hard_bounce, softBounce, blocked,
// invalid/invalidEmail, spam/complaint, unsubscribed). delivered/opened/
// clicked/request and anything else is ignored — this endpoint only cares
// about delivery failures, not engagement tracking.
const KICKBACK_PATTERN = /bounce|block|invalid|spam|complain|unsub/i;
const EVENT_LABELS = {
  harbounce: 'Hard bounce', hardbounce: 'Hard bounce', softbounce: 'Soft bounce',
  blocked: 'Blocked by recipient server', invalid: 'Invalid address', invalidemail: 'Invalid address',
  spam: 'Marked as spam', complaint: 'Spam complaint', unsubscribed: 'Recipient unsubscribed',
};
function eventLabel(event) {
  const key = String(event || '').toLowerCase().replace(/[^a-z]/g, '');
  return EVENT_LABELS[key] || event || 'Delivery failure';
}

router.post('/webhook', async (req, res) => {
  // Always 200 — a non-2xx response makes Brevo retry the same event
  // repeatedly, and a malformed/unexpected payload here is Brevo's problem
  // to fix on their end, not something worth it hammering this endpoint over.
  res.status(200).json({ ok: true });
  try {
    if (WEBHOOK_SECRET && req.query.secret !== WEBHOOK_SECRET) {
      console.warn('[email-events] webhook called with missing/wrong secret');
      return;
    }
    const body = req.body || {};
    const event = body.event || body.type || '';
    if (!KICKBACK_PATTERN.test(event)) return; // delivered/opened/clicked/etc. — not a kickback
    const toEmail = (body.email || body.to || '').toLowerCase().trim();
    // Field name for the send-time message id has drifted across Brevo API
    // versions too — check every spelling we've seen.
    const messageId = body['message-id'] || body.messageId || body.message_id || null;
    if (!toEmail) return;
    const row = messageId
      ? db.prepare('SELECT * FROM emails_sent WHERE message_id = ?').get(messageId)
      : db.prepare('SELECT * FROM emails_sent WHERE to_email = ? ORDER BY created_at DESC LIMIT 1').get(toEmail);
    if (!row) { console.warn(`[email-events] bounce for ${toEmail} — no matching emails_sent row (messageId=${messageId || 'none'})`); return; }
    const reason = body.reason || body.reason_msg || body['reason-msg'] || '';
    db.prepare(`UPDATE emails_sent SET status = 'bounced', error_message = ? WHERE id = ?`).run(`${eventLabel(event)}${reason ? `: ${reason}` : ''}`, row.id);

    const notifyTo = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'notify_email_bounce_email'`).get(row.org_id || DEFAULT_ORG_ID)?.value;
    if (!notifyTo) return;
    const recipients = notifyTo.split(',').map(s => s.trim()).filter(Boolean).filter(r => r.toLowerCase() !== toEmail); // never notify the address that itself bounced
    if (!recipients.length) return;
    const tmpl = renderSystemTemplate(row.org_id, 'emailBounce', {
      toEmail: escapeHtml(toEmail), subject: escapeHtml(row.subject || ''), eventLabel: escapeHtml(eventLabel(event)), reason: reason ? `: ${escapeHtml(reason)}` : '',
    });
    for (const to of recipients) {
      const { emailError } = await sendMailChecked(row.org_id, to, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo });
      if (emailError) console.error('[email-events] bounce notification failed:', emailError);
    }
  } catch (e) {
    console.error('[email-events] webhook handling failed:', e.message);
  }
});

export default router;
