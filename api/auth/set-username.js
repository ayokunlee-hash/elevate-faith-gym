// POST /api/auth/set-username
// Lets a signed-in family choose a username if they do not have one yet.
// Used by existing Google and email families to migrate to username sign-in.
// Requires a valid session. Username must be 3-20 chars, letters/numbers/underscore,
// unique across all families (case-insensitive). Once set, it cannot be changed
// through this endpoint (prevents username squatting and confusion).
const { getPool } = require('../../lib/db');
const { getSessionFamilyId } = require('../../lib/session');

function isUsername(value) {
  return typeof value === 'string' && /^[a-z0-9_]{3,20}$/.test(value.trim().toLowerCase());
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
    const familyId = await getSessionFamilyId(req);
    if (!familyId) {
      res.status(401).json({ ok: false });
      return;
    }
    const body = readBody(req);
    const username = String(body.username || '').trim().toLowerCase();
    if (!isUsername(username)) {
      res.status(400).json({ ok: false, error: 'invalid_username' });
      return;
    }
    const pool = getPool();
    const current = await pool.query(
      'SELECT username FROM families WHERE id = $1 LIMIT 1',
      [familyId]
    );
    if (current.rows.length && current.rows[0].username) {
      res.status(409).json({ ok: false, error: 'username_already_set' });
      return;
    }
    const taken = await pool.query(
      'SELECT id FROM families WHERE LOWER(username) = $1 AND id <> $2 LIMIT 1',
      [username, familyId]
    );
    if (taken.rows.length) {
      res.status(409).json({ ok: false, error: 'username_taken' });
      return;
    }
    await pool.query(
      'UPDATE families SET username = $1 WHERE id = $2',
      [username, familyId]
    );
    res.status(200).json({ ok: true, username });
  } catch (err) {
    console.error('set-username failed');
    res.status(500).json({ ok: false });
  }
};
