// POST /api/auth/setup-complete   { "parentName": "optional edited name" }
// Marks the family setup as complete. The frontend calls this after the
// parent finishes the setup page (kids, gifts, PIN). Until this is called,
// /api/auth/me reports setupCompleted: false and the frontend keeps the
// user on the setup page, blocking entry into the app.
const { getPool } = require('../../lib/db');
const { getSession } = require('../../lib/session');

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
    const parentName =
      typeof body.parentName === 'string' ? body.parentName.trim().slice(0, 120) : '';
    const pool = getPool();
    if (parentName) {
      await pool.query(
        'UPDATE families SET parent_name = $1, setup_completed = TRUE WHERE id = $2',
        [parentName, session.family_id]
      );
    } else {
      await pool.query('UPDATE families SET setup_completed = TRUE WHERE id = $1', [
        session.family_id,
      ]);
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('setup-complete failed'); // never log user data
    res.status(500).json({ ok: false });
  }
};
