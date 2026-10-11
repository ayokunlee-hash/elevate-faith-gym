// POST /api/auth/email-signin   { "email": "...", "password": "..." }
// Signs in a family that registered with an email and password. On
// failure this returns 401 with no detail, so a caller cannot learn
// whether the address is registered. A dummy hash check keeps the
// failure timing close to the success timing. On success a session is
// created and { ok: true, setupCompleted } is returned.
const { getPool } = require('../../lib/db');
const { createSession, sessionCookieHeader } = require('../../lib/session');
const { verifyPassword } = require('../../lib/password');

// A well-formed scrypt hash of a random value. Used only to keep the
// timing of a failed lookup close to the timing of a real check.
const DUMMY_HASH =
  'scrypt:0f6605a1d45147a8f750d1837967bc1d:2c183415589f1271125cf07d913120ebeae79c70e871ef972509d4c5c3f3b2d452219af716a4e62e2529b868fff6c94c951192c939f87af46da95e36d83ee714';

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
    const body = readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    const pool = getPool();
    const { rows } = await pool.query(
      'SELECT id, password_hash, setup_completed FROM families WHERE email = $1 LIMIT 1',
      [email]
    );
    const family = rows[0];
    const ok = family && family.password_hash && verifyPassword(password, family.password_hash);
    if (!ok) {
      // Run the same work for unknown addresses so failures look alike.
      verifyPassword(password || 'x', DUMMY_HASH);
      res.status(401).json({ ok: false });
      return;
    }

    const { id: sessionId, expiresAt } = await createSession(family.id);
    res.setHeader('Set-Cookie', sessionCookieHeader(sessionId, expiresAt, req));
    res.status(200).json({ ok: true, setupCompleted: family.setup_completed === true });
  } catch (err) {
    console.error('email-signin failed'); // never log email or password
    res.status(401).json({ ok: false });
  }
};
