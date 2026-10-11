// POST /api/auth/email-signup   { "email": "...", "password": "...", "parentName": "..." }
// Creates a family account with an email and password. The password is
// stored only as a salted scrypt hash, never in plain text. Returns 400
// for a bad email or a password shorter than 8 characters, and 409 if
// the email is already registered. On success a session is created and
// { ok: true, setupCompleted: false } is returned; the frontend then
// routes the parent to the family setup (build your family's reward) page.
const { getPool } = require('../../lib/db');
const { createSession, sessionCookieHeader } = require('../../lib/session');
const { hashPassword } = require('../../lib/password');

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
  } catch (err) {
    console.error('email-signup failed'); // never log email or password
    res.status(500).json({ ok: false });
  }
};
