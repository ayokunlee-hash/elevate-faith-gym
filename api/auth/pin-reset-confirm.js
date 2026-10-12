// POST /api/auth/pin-reset-confirm   { "token": "...", "pin": "1234" }
// Sets a new parent PIN from a valid reset token. Requires the signed-in
// session AND a token that belongs to that family, is unused, and is
// unexpired. The token is marked used only when the new PIN is stored, so
// it is strictly single-use. Only a scrypt hash of the PIN is stored; the
// plain PIN is never written to the database or logs.
const crypto = require('crypto');
const { getPool } = require('../../lib/db');
const { getSession } = require('../../lib/session');
const { sha256 } = require('../../lib/tokens');
const { hashPin } = require('../../lib/pin');

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
    const session = await getSession(req);
    if (!session) {
      res.status(401).json({ ok: false });
      return;
    }
    const body = readBody(req);
    const token = String(body.token || '');
    const pin = String(body.pin || '');
    if (!token || !/^\d{4}$/.test(pin)) {
      res.status(400).json({ ok: false, error: 'invalid_request' });
      return;
    }

    const pool = getPool();
    const want = sha256(token);
    const { rows } = await pool.query(
      'SELECT id, token_hash FROM pin_reset_tokens WHERE family_id = $1 AND used_at IS NULL AND expires_at > NOW()',
      [session.family_id]
    );
    let tokenId = null;
    for (const row of rows) {
      if (
        row.token_hash.length === want.length &&
        crypto.timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(want, 'hex'))
      ) {
        tokenId = row.id;
        break;
      }
    }
    if (!tokenId) {
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
      [tokenId]
    );
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('pin-reset-confirm failed'); // never log user data or tokens
    res.status(500).json({ ok: false });
  }
};
