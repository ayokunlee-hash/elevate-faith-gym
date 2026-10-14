// /api/auth/setup  (single function; old paths rewrite here)
// Signed-in parents only. Handles three setup jobs, routed by body shape so
// the previous /api/auth/set-pin and /api/auth/setup-complete routes keep
// working unchanged through vercel.json rewrites:
//   POST { pin }             -> store the parent 4-digit PIN (scrypt hash)
//   POST { parentName }      -> mark family setup complete (name optional)
//   POST { pin, parentName } -> do both
//   POST { username }        -> set the family username (one-time, for
//                               existing families migrating to username
//                               sign-in; new families set it at signup)
// Until setup is marked complete, /api/auth/me reports setupCompleted:
// false and the frontend keeps the parent on the setup page. The plain
// PIN is never written to the database or the logs.
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
    const body = readBody(req);

    // Username set (one-time, for existing families migrating to username sign-in).
    // Handled first and returns early, so it does not touch PIN or setup state.
    if (body.username !== undefined) {
      const username = String(body.username || '').trim().toLowerCase();
      if (!/^[a-z0-9_]{3,20}$/.test(username)) {
        res.status(400).json({ ok: false, error: 'invalid_username' });
        return;
      }
      const pool = getPool();
      const current = await pool.query(
        'SELECT username FROM families WHERE id = $1 LIMIT 1',
        [session.family_id]
      );
      if (current.rows.length && current.rows[0].username) {
        res.status(409).json({ ok: false, error: 'username_already_set' });
        return;
      }
      const taken = await pool.query(
        'SELECT id FROM families WHERE LOWER(username) = $1 AND id <> $2 LIMIT 1',
        [username, session.family_id]
      );
      if (taken.rows.length) {
        res.status(409).json({ ok: false, error: 'username_taken' });
        return;
      }
      await pool.query(
        'UPDATE families SET username = $1 WHERE id = $2',
        [username, session.family_id]
      );
      res.status(200).json({ ok: true, username });
      return;
    }

    const pin = body.pin !== undefined && body.pin !== null ? String(body.pin) : '';
    const wantsPin = pin !== '';
    // setup-complete behavior runs when no PIN was sent, or when the
    // caller explicitly included parentName (even empty).
    const wantsComplete = !wantsPin || body.parentName !== undefined;

    const pool = getPool();
    if (wantsPin) {
      let pinHash;
      try {
        pinHash = hashPin(pin); // throws unless exactly 4 digits
      } catch (pinErr) {
        res.status(400).json({ ok: false });
        return;
      }
      await pool.query('UPDATE families SET pin_hash = $1 WHERE id = $2', [
        pinHash,
        session.family_id,
      ]);
    }
    if (wantsComplete) {
      const parentName =
        typeof body.parentName === 'string' ? body.parentName.trim().slice(0, 120) : '';
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
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('setup failed'); // never log user data or the PIN
    res.status(500).json({ ok: false });
  }
};
