// GET /api/auth/email-verify?token=...
// Verifies a magic-link token: it must exist, be unused, and be unexpired.
// On success the token is marked used, the family record is found or
// created, a server-side session is created, the signed httpOnly cookie is
// set, and the user is redirected to the setup page.
const crypto = require('crypto');
const { getPool } = require('../../lib/db');
const { sha256 } = require('../../lib/tokens');
const { createSession, sessionCookieHeader } = require('../../lib/session');

module.exports = async (req, res) => {
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  const fail = () => {
    res.writeHead(302, { Location: `${appUrl}/?auth=expired#setup` });
    res.end();
  };

  try {
    const token = String((req.query || {}).token || '');
    if (!token) return fail();

    const pool = getPool();
    const { rows } = await pool.query(
      'SELECT id, email, token_hash FROM magic_links WHERE used_at IS NULL AND expires_at > NOW()'
    );
    let match = null;
    const want = sha256(token);
    for (const row of rows) {
      if (
        row.token_hash.length === want.length &&
        crypto.timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(want, 'hex'))
      ) {
        match = row;
        break;
      }
    }
    if (!match) return fail();

    await pool.query('UPDATE magic_links SET used_at = NOW() WHERE id = $1', [match.id]);

    const email = match.email;
    const found = await pool.query('SELECT id FROM families WHERE email = $1 LIMIT 1', [email]);
    let familyId;
    if (found.rows.length) {
      familyId = found.rows[0].id;
      await pool.query(
        "UPDATE families SET auth_provider = COALESCE(auth_provider, 'email') WHERE id = $1",
        [familyId]
      );
    } else {
      const ins = await pool.query(
        "INSERT INTO families (email, auth_provider) VALUES ($1, 'email') RETURNING id",
        [email]
      );
      familyId = ins.rows[0].id;
    }

    const session = await createSession(familyId);
    res.writeHead(302, {
      Location: `${appUrl}/#setup`,
      'Set-Cookie': sessionCookieHeader(session.id, session.expiresAt, req),
    });
    res.end();
  } catch (err) {
    console.error('email-verify failed'); // never log user data or tokens
    fail();
  }
};
