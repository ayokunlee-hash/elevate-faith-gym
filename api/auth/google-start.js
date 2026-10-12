// GET /api/auth/google-start
// Begins the Google OAuth 2.0 authorization code flow.
// The `state` value protects against CSRF: it is random, stored server-side
// with a 10 minute expiry, and checked on the callback.
const { getPool } = require('../../lib/db');
const { randomToken } = require('../../lib/tokens');

module.exports = async (req, res) => {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
    if (!clientId || !appUrl) {
      res.status(500).send('Server is not configured for Google sign-in.');
      return;
    }

    const state = randomToken(16);
    const pool = getPool();
    await pool.query('DELETE FROM oauth_states WHERE expires_at < NOW()');
    await pool.query(
      "INSERT INTO oauth_states (state, expires_at) VALUES ($1, NOW() + INTERVAL '10 minutes')",
      [state]
    );

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${appUrl}/api/auth/google-callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account',
    });

    res.writeHead(302, {
      Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    });
    res.end();
  } catch (err) {
    console.error('google-start failed'); // never log user data
    res.status(500).send('Could not start Google sign-in.');
  }
};
