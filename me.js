// GET /api/auth/me
// Returns the current session's family profile so the frontend knows who
// is signed in, what name to pre-fill, and whether setup is complete.
// Only the parent's own profile fields are returned. No children's names.
const { getPool } = require('../../lib/db');
const { getSession } = require('../../lib/session');

module.exports = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session) {
      res.status(401).json({ signedIn: false });
      return;
    }
    const { rows } = await getPool().query(
      'SELECT id, parent_name, email, auth_provider, setup_completed FROM families WHERE id = $1',
      [session.family_id]
    );
    if (!rows.length) {
      res.status(401).json({ signedIn: false });
      return;
    }
    const f = rows[0];
    res.status(200).json({
      signedIn: true,
      family: {
        id: f.id,
        parentName: f.parent_name,
        email: f.email,
        authProvider: f.auth_provider,
        setupCompleted: !!f.setup_completed,
      },
    });
  } catch (err) {
    console.error('me failed'); // never log user data
    res.status(500).json({ signedIn: false });
  }
};
