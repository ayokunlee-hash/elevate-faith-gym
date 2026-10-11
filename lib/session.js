// Server-side sessions for Elevate Faith Gym.
// Session rows live in Postgres. The browser only holds a random session id
// signed with HMAC-SHA256, so the cookie value cannot be forged.
// The cookie is httpOnly, so page JavaScript can never read it.
const crypto = require('crypto');
const { getPool } = require('./db');

const COOKIE_NAME = 'efg_session';
const SESSION_DAYS = 30;

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return secret;
}

function sign(value) {
  return crypto.createHmac('sha256', getSecret()).update(value).digest('hex');
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > -1) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  });
  return out;
}

// Returns the session id if the cookie signature is valid, else null.
function getSessionIdFromRequest(req) {
  const raw = parseCookies(req)[COOKIE_NAME];
  if (!raw) return null;
  const idx = raw.lastIndexOf('.');
  if (idx < 0) return null;
  const id = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  let expected;
  try {
    expected = sign(id);
  } catch (e) {
    return null;
  }
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return id;
}

async function createSession(familyId) {
  const pool = getPool();
  const id = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO sessions (id, family_id, expires_at) VALUES ($1, $2, $3)',
    [id, familyId, expiresAt.toISOString()]
  );
  return { id, expiresAt };
}

// Returns { id, family_id, expires_at } or null. Expired sessions are deleted.
async function getSession(req) {
  const id = getSessionIdFromRequest(req);
  if (!id) return null;
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT id, family_id, expires_at FROM sessions WHERE id = $1',
    [id]
  );
  if (!rows.length) return null;
  const s = rows[0];
  if (new Date(s.expires_at) < new Date()) {
    await pool.query('DELETE FROM sessions WHERE id = $1', [id]);
    return null;
  }
  return s;
}

async function destroySession(req) {
  const id = getSessionIdFromRequest(req);
  if (!id) return;
  await getPool().query('DELETE FROM sessions WHERE id = $1', [id]);
}

function isSecureRequest(req) {
  const proto = req.headers['x-forwarded-proto'] || '';
  if (proto === 'https') return true;
  return (process.env.APP_URL || '').startsWith('https://');
}

function sessionCookieHeader(sessionId, expiresAt, req) {
  const value = `${sessionId}.${sign(sessionId)}`;
  const parts = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    `Expires=${expiresAt.toUTCString()}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax`;
}

module.exports = {
  createSession,
  getSession,
  destroySession,
  sessionCookieHeader,
  clearCookieHeader,
  COOKIE_NAME,
};
