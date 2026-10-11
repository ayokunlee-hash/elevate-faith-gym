// POST /api/auth/email-start   { "email": "parent@example.com" }
// Creates a single-use magic-link token (only its hash is stored, 15 minute
// expiry) and emails the sign-in link via Resend.
// Always returns the same 200 response so addresses cannot be probed,
// except when the email itself fails to send: then it returns 502
// {ok:false, error:"email_failed"}. The 502 is about the send failing, not
// about the address, so it leaks nothing.
// Sends are throttled to one per minute per address.
const { getPool } = require('../../lib/db');
const { randomToken, sha256 } = require('../../lib/tokens');
const { Resend } = require('resend');

function isEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }
  return body || {};
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false });
    return;
  }
  try {
    const email = String(readBody(req).email || '').trim().toLowerCase();
    if (!isEmail(email)) {
      res.status(200).json({ ok: true });
      return;
    }

    const pool = getPool();
    const recent = await pool.query(
      "SELECT id FROM magic_links WHERE email = $1 AND created_at > NOW() - INTERVAL '1 minute' LIMIT 1",
      [email]
    );
    if (!recent.rows.length) {
      const token = randomToken(32);
      const tokenHash = sha256(token);
      await pool.query(
        "INSERT INTO magic_links (email, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '15 minutes')",
        [email, tokenHash]
      );

      const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
      const link = `${appUrl}/api/auth/email-verify?token=${token}`;

      // The send is isolated from the outer catch on purpose: a delivery
      // failure must surface as 502, not as the probing-safe 200.
      let accepted = false;
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const result = await resend.emails.send({
          from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
          to: email,
          subject: 'Sign in to Elevate Faith Gym',
          html:
            '<p>Tap the link below to sign in to Elevate Faith Gym. ' +
            'It expires in 15 minutes and can only be used once.</p>' +
            `<p><a href="${link}">Sign in to Elevate Faith Gym</a></p>` +
            '<p>If you did not ask for this email, you can safely ignore it.</p>',
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
            'DELETE FROM magic_links WHERE email = $1 AND token_hash = $2',
            [email, tokenHash]
          );
        } catch (cleanupErr) {
          // stale row expires on its own; nothing to do
        }
        console.error('email-start: resend send failed'); // never log the address
        res.status(502).json({ ok: false, error: 'email_failed' });
        return;
      }
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('email-start failed'); // never log the address
    res.status(200).json({ ok: true }); // same response either way
  }
};
