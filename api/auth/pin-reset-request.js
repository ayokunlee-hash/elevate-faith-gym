// POST /api/auth/pin-reset-request
// Signed-in parents only (session required). Creates a single-use PIN
// reset token (only its hash is stored, 30 minute expiry) and emails the
// reset link to the parent's account email via Resend.
// Always returns the same 200 response, except when the email itself fails
// to send: then it returns 502 {ok:false, error:"email_failed"}.
// Sends are throttled to one per minute per family.
const { getPool } = require('../../lib/db');
const { getSession } = require('../../lib/session');
const { randomToken, sha256 } = require('../../lib/tokens');
const { Resend } = require('resend');
const { pinReset } = require('../../lib/email-templates');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false });
    return;
  }
  try {
    const session = await getSession(req);
    if (!session) {
      res.status(401).json({ ok: false });
      return;
    }
    const pool = getPool();
    const fam = await pool.query('SELECT id, email FROM families WHERE id = $1', [
      session.family_id,
    ]);
    if (!fam.rows.length || !fam.rows[0].email) {
      res.status(200).json({ ok: true }); // probing-safe; nothing to send to
      return;
    }
    const familyId = fam.rows[0].id;
    const email = fam.rows[0].email;

    const recent = await pool.query(
      "SELECT id FROM pin_reset_tokens WHERE family_id = $1 AND created_at > NOW() - INTERVAL '1 minute' LIMIT 1",
      [familyId]
    );
    if (!recent.rows.length) {
      const token = randomToken(32);
      const tokenHash = sha256(token);
      await pool.query(
        "INSERT INTO pin_reset_tokens (family_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 minutes')",
        [familyId, tokenHash]
      );

      const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
      const link = `${appUrl}/api/auth/pin-reset-start?token=${token}`;
      const tpl = pinReset({ appUrl, link });

      // The send is isolated from the outer catch on purpose: a delivery
      // failure must surface as 502, not as the probing-safe 200.
      let accepted = false;
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const result = await resend.emails.send({
          from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
          to: email,
          subject: tpl.subject,
          html: tpl.html,
        });
        // Resend resolves with { data, error } on API-level failures
        // instead of throwing, so check both.
        accepted = !!(result && !result.error && result.data);
      } catch (sendErr) {
        accepted = false;
      }

      if (!accepted) {
        try {
          await pool.query(
            'DELETE FROM pin_reset_tokens WHERE family_id = $1 AND token_hash = $2',
            [familyId, tokenHash]
          );
        } catch (cleanupErr) {
          // stale row expires on its own; nothing to do
        }
        console.error('pin-reset-request: resend send failed'); // never log the address
        res.status(502).json({ ok: false, error: 'email_failed' });
        return;
      }
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('pin-reset-request failed'); // never log user data
    res.status(500).json({ ok: false });
  }
};
