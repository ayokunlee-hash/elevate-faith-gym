// GET /api/auth/pin-reset-start?token=...
// Validates a PIN reset token: it must exist, be unused, and be unexpired.
// The token is NOT marked used here (email clients prefetch links), so it
// stays valid until the parent actually sets the new PIN.
// On success redirects into the app setup page in PIN-reset mode. The raw
// token travels in the URL hash so it is never sent to the server in a
// request line or written to access logs.
const crypto = require('crypto');
const { getPool } = require('../../lib/db');
const { sha256 } = require('../../lib/tokens');

module.exports = async (req, res) => {
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  const fail = () => {
    res.writeHead(302, { Location: `${appUrl}/?auth=pinreset_expired#setup` });
    res.end();
  };
  try {
    const token = String((req.query || {}).token || '');
    if (!token) return fail();

    const pool = getPool();
    const { rows } = await pool.query(
      'SELECT token_hash FROM pin_reset_tokens WHERE used_at IS NULL AND expires_at > NOW()'
    );
    const want = sha256(token);
    let ok = false;
    for (const row of rows) {
      if (
        row.token_hash.length === want.length &&
        crypto.timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(want, 'hex'))
      ) {
        ok = true;
        break;
      }
    }
    if (!ok) return fail();

    res.writeHead(302, {
      Location: `${appUrl}/#setup?pinResetToken=${encodeURIComponent(token)}`,
    });
    res.end();
  } catch (err) {
    console.error('pin-reset-start failed'); // never log tokens
    fail();
  }
};
