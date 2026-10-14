// /api/auth/password-reset  (single function)
// For families that sign in with an email and password. Three actions
// in one endpoint:
//   GET  ?token=...          -> validate a reset token; redirect into the
//                               app password-reset mode.
//   POST { email }            -> request a reset email (probing-safe 200
//                               except when the email itself fails: 502;
//                               throttled to one per minute per family).
//   POST { token, password }  -> set the new password (strictly
//                               single-use, 8+ characters).
// No session is required: the family is signed out when they need this,
// so the single-use token is the authorization. Only SHA-256 hashes of
// tokens and scrypt hashes of passwords are ever stored; plain values
// never touch the database or logs.
const crypto = require('crypto');
const { getPool } = require('../../lib/db');
const { randomToken, sha256 } = require('../../lib/tokens');
const { hashPassword } = require('../../lib/password');
const { Resend } = require('resend');
const { passwordReset } = require('../../lib/email-templates');

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

function isEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function findToken(rows, token) {
  const want = sha256(String(token));
  for (const row of rows) {
    if (
      row.token_hash.length === want.length &&
      crypto.timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(want, 'hex'))
    ) {
      return row;
    }
  }
  return null;
}

// GET ?token=... : validate and redirect. The token is NOT marked used
// here (email clients prefetch links); it stays valid until the new
// password is actually set.
async function handleGet(req, res) {
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  const fail = () => {
    res.writeHead(302, { Location: `${appUrl}/?auth=pwreset_expired#setup` });
    res.end();
  };
  const token = String((req.query || {}).token || '');
  if (!token) return fail();

  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT token_hash FROM password_reset_tokens WHERE used_at IS NULL AND expires_at > NOW()'
  );
  if (!findToken(rows, token)) return fail();

  res.writeHead(302, {
    Location: `${appUrl}/#setup?passwordResetToken=${encodeURIComponent(token)}`,
  });
  res.end();
}

// POST { email } : create a token and email the reset link. Always
// returns the same 200 response so a caller cannot learn whether the
// address is registered, except when the email itself fails to send
// (502).
async function handleRequest(req, res, body) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!isEmail(email)) {
    res.status(200).json({ ok: true }); // probing-safe
    return;
  }
  const pool = getPool();
  const fam = await pool.query(
    'SELECT id FROM families WHERE email = $1 LIMIT 1',
    [email]
  );
  if (!fam.rows.length) {
    res.status(200).json({ ok: true }); // probing-safe; nothing to send to
    return;
  }
  const familyId = fam.rows[0].id;

  const recent = await pool.query(
    "SELECT id FROM password_reset_tokens WHERE family_id = $1 AND created_at > NOW() - INTERVAL '1 minute' LIMIT 1",
    [familyId]
  );
  if (!recent.rows.length) {
    const token = randomToken(32);
    const tokenHash = sha256(token);
    await pool.query(
      "INSERT INTO password_reset_tokens (family_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 minutes')",
      [familyId, tokenHash]
    );

    const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
    const link = `${appUrl}/api/auth/password-reset?token=${token}`;
    const tpl = passwordReset({ appUrl, link });

    // The send is isolated on purpose: a delivery failure must surface
    // as 502, not as the probing-safe 200.
    let accepted = false;
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const result = await resend.emails.send({
        from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
        to: email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });
      accepted = !!(result && !result.error && result.data);
    } catch (sendErr) {
      accepted = false;
    }

    if (!accepted) {
      try {
        await pool.query(
          'DELETE FROM password_reset_tokens WHERE family_id = $1 AND token_hash = $2',
          [familyId, tokenHash]
        );
      } catch (cleanupErr) {
        // stale row expires on its own; nothing to do
      }
      console.error('password-reset: resend send failed'); // never log the address
      res.status(502).json({ ok: false, error: 'email_failed' });
      return;
    }
  }
  res.status(200).json({ ok: true });
}

// POST { token, password } : set the new password. The token must be
// unused and unexpired; it is marked used in the same step, so it is
// strictly single-use.
async function handleConfirm(req, res, body) {
  const token = String(body.token || '');
  const password = String(body.password || '');
  if (!token || password.length < 8) {
    res.status(400).json({ ok: false, error: 'invalid_request' });
    return;
  }

  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT id, family_id, token_hash FROM password_reset_tokens WHERE used_at IS NULL AND expires_at > NOW()'
  );
  const match = findToken(rows, token);
  if (!match) {
    res.status(400).json({ ok: false, error: 'invalid_or_expired' });
    return;
  }

  const passwordHash = hashPassword(password); // throws unless 8+ chars
  await pool.query('UPDATE families SET password_hash = $1 WHERE id = $2', [
    passwordHash,
    match.family_id,
  ]);
  await pool.query(
    'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1 AND used_at IS NULL',
    [match.id]
  );
  res.status(200).json({ ok: true });
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      await handleGet(req, res);
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false });
      return;
    }
    const body = readBody(req);
    if (body.token) {
      await handleConfirm(req, res, body);
      return;
    }
    await handleRequest(req, res, body);
  } catch (err) {
    console.error('password-reset failed'); // never log user data or tokens
    res.status(500).json({ ok: false });
  }
};
