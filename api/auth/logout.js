// GET or POST /api/auth/logout
// Destroys the server-side session and clears the session cookie.
const { destroySession, clearCookieHeader } = require('../../lib/session');

module.exports = async (req, res) => {
  try {
    await destroySession(req);
  } catch (err) {
    console.error('logout failed');
  }
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  res.writeHead(302, {
    Location: appUrl ? `${appUrl}/` : '/',
    'Set-Cookie': clearCookieHeader(),
  });
  res.end();
};
