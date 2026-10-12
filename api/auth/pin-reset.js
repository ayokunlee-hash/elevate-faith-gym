// /api/auth/pin-reset  (single function; old paths rewrite here)
// Signed-in parents only. Three actions in one endpoint:
//   GET  ?token=...     -> validate a reset token; redirect into the app
//                        setup page in PIN-reset mode.
//   POST { }            -> request a reset email (throttled to one per
//                        minute per family).
//   POST { token, pin } -> set the new 4-digit PIN (strictly single-use).
// The previous routes /api/auth/pin-reset-request, /api/auth/pin-reset-start
// and /api/auth/pin-reset-confirm keep working unchanged through
// vercel.json rewrites. Only SHA-256 hashes of tokens and scrypt hashes of
// PINs are ever stored; plain values never touch the database or logs.
const crypto = require('crypto');
const { getPool } = require('../../lib/db');
const { getSession } = require('../../lib/session');
const { randomToken, sha256 } = require('../../lib/tokens');
const { hashPin } = require('../../lib/pin');
const { Resend } = require('resend');
const { pinReset } = require('../../lib/email-templates');

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
// here (email clients prefetch links); it stays valid until the new PIN
// is actually set.
async function handleGet(req, res) {
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  const fail = () => {
    res.writeHead(302, { Location: `${appUrl}/?auth=pinreset_expired#setup` });
    res.end();
  };
  const token = String((req.query || {}).token || '');
  if (!token) return fail();

  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT token_hash FROM pin_reset_tokens WHERE used_at IS NULL AND expires_at > NOW()'
  );
  if (!findToken(rows, token)) return fail();

  res.writeHead(302, {
    Location: `${appUrl}/#setup?pinResetToken=${encodeURIComponent(token)}`,
  });
  res.end();
}

// POST {} : create a token and email the reset link. Always returns the
// same 200 response, except when the email itself fails to send (502).
async function handleRequest(req, res, session) {
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
    const link = `${appUrl}/api/auth/pin-reset?token=${token}`;
    const tpl = pinReset({ appUrl, link });

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
      });
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
      console.error('pin-reset: resend send failed'); // never log the address
      res.status(502).json({ ok: false, error: 'email_failed' });
      return;
    }
  }
  res.status(200).json({ ok: true });
}

// POST { token, pin } : set the new PIN. The token must belong to the
// session's family, be unused, and be unexpired; it is marked used in the
// same step, so it is strictly single-use.
async function handleConfirm(req, res, session, body) {
  const token = String(body.token || '');
  const pin = String(body.pin || '');
  if (!token || !/^\d{4}$/.test(pin)) {
    res.status(400).json({ ok: false, error: 'invalid_request' });
    return;
  }

  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT id, token_hash FROM pin_reset_tokens WHERE family_id = $1 AND used_at IS NULL AND expires_at > NOW()',
    [session.family_id]
  );
  const match = findToken(rows, token);
  if (!match) {
    res.status(400).json({ ok: false, error: 'invalid_or_expired' });
    return;
  }

  const pinHash = hashPin(pin);
  await pool.query('UPDATE families SET pin_hash = $1 WHERE id = $2', [
    pinHash,
    session.family_id,
  ]);
  await pool.query(
    'UPDATE pin_reset_tokens SET used_at = NOW() WHERE id = $1 AND used_at IS NULL',
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
    const session = await getSession(req);
    if (!session) {
      res.status(401).json({ ok: false });
      return;
    }
    const body = readBody(req);
    if (body.token) {
      await handleConfirm(req, res, session, body);
      return;
    }
    await handleRequest(req, res, session);
  } catch (err) {
    console.error('pin-reset failed'); // never log user data or tokens
    res.status(500).json({ ok: false });
  }
};
