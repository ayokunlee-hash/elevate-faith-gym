// POST /api/auth/set-pin   { "pin": "1234" }
// Saves the parent-created 4-digit PIN. Only a salted scrypt hash is
// stored; the plain PIN is never written to the database or the logs.
// Requires a valid session. Used for Parent's Corner and leaderboard
// consent inside the app (client-side gates only; real enforcement needs
// this server record, checked by future endpoints).
const { getPool } = require('../../lib/db');
const { getSession } = require('../../lib/session');
const { hashPin } = require('../../lib/pin');

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
    const pin = String(readBody(req).pin || '');
    const pinHash = hashPin(pin); // throws unless exactly 4 digits
    await getPool().query('UPDATE families SET pin_hash = $1 WHERE id = $2', [
      pinHash,
      session.family_id,
    ]);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('set-pin failed'); // never log the PIN
    res.status(400).json({ ok: false });
  }
};
