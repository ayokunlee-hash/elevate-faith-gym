// GET /api/auth/google-callback
// Handles the Google OAuth callback: validates state, exchanges the code
// for tokens, reads the Google profile, finds or creates the family record,
// creates a server-side session, sets the signed httpOnly cookie, and
// redirects to the setup page. The frontend then pre-fills the parent name
// (editable) via /api/auth/me and requires setup before app entry.
const { getPool } = require('../../lib/db');
const { createSession, sessionCookieHeader } = require('../../lib/session');

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error('token exchange failed');
  return res.json();
}

module.exports = async (req, res) => {
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  const goSetup = (suffix) => {
    res.writeHead(302, { Location: `${appUrl}/?auth=${suffix}#setup` });
    res.end();
  };

  try {
    const { code, state, error } = req.query || {};
    if (error) throw new Error('Google sign-in was cancelled');
    if (!code || !state) throw new Error('Missing code or state');

    const pool = getPool();
    const found = await pool.query(
      'SELECT state FROM oauth_states WHERE state = $1 AND expires_at > NOW()',
      [state]
    );
    if (!found.rows.length) throw new Error('Invalid or expired state');
    await pool.query('DELETE FROM oauth_states WHERE state = $1', [state]);

    const tokens = await postForm('https://oauth2.googleapis.com/token', {
      code: String(code),
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${appUrl}/api/auth/google-callback`,
      grant_type: 'authorization_code',
    });

    const meRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!meRes.ok) throw new Error('Could not read Google profile');
    const profile = await meRes.json();
    if (!profile.sub || !profile.email) throw new Error('Incomplete Google profile');

    // Find or create the family. Never log names or emails.
    const existing = await pool.query(
      'SELECT id FROM families WHERE google_sub = $1 OR email = $2 LIMIT 1',
      [profile.sub, profile.email]
    );
    let familyId;
    if (existing.rows.length) {
      familyId = existing.rows[0].id;
      await pool.query(
        'UPDATE families SET google_sub = COALESCE(google_sub, $1), auth_provider = $2 WHERE id = $3',
        [profile.sub, 'google', familyId]
      );
    } else {
      const ins = await pool.query(
        'INSERT INTO families (parent_name, email, auth_provider, google_sub) VALUES ($1, $2, $3, $4) RETURNING id',
        [profile.name || '', profile.email, 'google', profile.sub]
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
    console.error('google-callback failed'); // never log user data or tokens
    goSetup('error');
  }
};
