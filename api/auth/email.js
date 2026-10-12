// /api/auth/email  (single function; old paths rewrite here)
// Merged email sign-in and sign-up. The mode comes from ?mode=signin
// or ?mode=signup (see vercel.json rewrites for the old
// /api/auth/email-signin and /api/auth/email-signup paths).
//
// signin: POST { "email", "password" } -> 200 { ok, setupCompleted }
//   on success (session created); 401 with no detail on failure, so a
//   caller cannot learn whether the address is registered. A dummy hash
//   check keeps the failure timing close to the success timing.
// signup: POST { "email", "password", "parentName" } -> 200 on success
//   (session created, setupCompleted false); 400 for a bad email or a
//   password shorter than 8 characters; 409 if already registered.
const { getPool } = require('../../lib/db');
const { createSession, sessionCookieHeader } = require('../../lib/session');
const { verifyPassword, hashPassword } = require('../../lib/password');

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

function isEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

async function handleSignin(req, res) {
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
}

async function handleSignup(req, res) {
  const body = readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const parentName = String(body.parentName || '').trim();
  if (!isEmail(email) || password.length < 8) {
    res.status(400).json({ ok: false });
    return;
  }

  const pool = getPool();
  const existing = await pool.query('SELECT id FROM families WHERE email = $1 LIMIT 1', [email]);
  if (existing.rows.length) {
    res.status(409).json({ ok: false, error: 'email_taken' });
    return;
  }

  const passwordHash = hashPassword(password); // throws unless 8+ chars
  const { rows } = await pool.query(
    "INSERT INTO families (email, auth_provider, parent_name, password_hash) VALUES ($1, 'email', $2, $3) RETURNING id, setup_completed",
    [email, parentName, passwordHash]
  );
  const family = rows[0];

  const { id: sessionId, expiresAt } = await createSession(family.id);
  res.setHeader('Set-Cookie', sessionCookieHeader(sessionId, expiresAt, req));
  res.status(200).json({ ok: true, setupCompleted: family.setup_completed === true });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false });
    return;
  }
  const mode = String((req.query || {}).mode || '');
  try {
    if (mode === 'signin') {
      await handleSignin(req, res);
      return;
    }
    if (mode === 'signup') {
      await handleSignup(req, res);
      return;
    }
    res.status(400).json({ ok: false });
  } catch (err) {
    console.error('email auth failed'); // never log email or password
    res.status(mode === 'signin' ? 401 : 500).json({ ok: false });
  }
};
