// GET /api/auth/me
// Returns the current session's family profile so the frontend knows who
// is signed in, what name to pre-fill, and whether setup is complete.
// Only the parent's own profile fields are returned. No children's names.
// Extended for progress syncing (Option 1):
//   GET  -> includes progress: { kids: [...] } with coins, points, activities.
//   POST -> saves a progress snapshot, replacing the family's stored
//           progress in a transaction (last-write-wins; fine for Option 1).
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

async function loadProgress(pool, familyId) {
  const kidsRes = await pool.query(
    'SELECT id, name, leaderboard_nickname, avatar FROM kids WHERE family_id = $1 ORDER BY created_at',
    [familyId]
  );
  const kids = [];
  for (const k of kidsRes.rows) {
    const coinsRes = await pool.query(
      'SELECT activity, coins, status, earned_at, approved_at FROM coin_ledger WHERE kid_id = $1 ORDER BY earned_at',
      [k.id]
    );
    const pointsRes = await pool.query(
      'SELECT points_earned, points_spent, source, earned_at FROM point_ledger WHERE kid_id = $1 ORDER BY earned_at',
      [k.id]
    );
    const actRes = await pool.query(
      'SELECT series, week, day, activity_type, minutes_or_value, completed_at FROM activity_log WHERE kid_id = $1 ORDER BY completed_at',
      [k.id]
    );
    kids.push({
      name: k.name,
      leaderboardNickname: k.leaderboard_nickname,
      avatar: k.avatar,
      coins: coinsRes.rows.map((r) => ({
        activity: r.activity,
        coins: r.coins,
        status: r.status,
        earnedAt: r.earned_at,
        approvedAt: r.approved_at,
      })),
      points: pointsRes.rows.map((r) => ({
        earned: r.points_earned,
        spent: r.points_spent,
        source: r.source,
        earnedAt: r.earned_at,
      })),
      activities: actRes.rows.map((r) => ({
        series: r.series,
        week: r.week,
        day: r.day,
        activityType: r.activity_type,
        minutesOrValue: r.minutes_or_value,
        completedAt: r.completed_at,
      })),
    });
  }
  // Parent-set reward gifts (Parent Rewards).
  const giftsRes = await pool.query(
    'SELECT name, coin_price FROM parent_gifts WHERE family_id = $1 ORDER BY created_at',
    [familyId]
  );
  const parentGifts = giftsRes.rows.map((r) => ({
    name: r.name,
    coinPrice: r.coin_price,
  }));
  return { kids, parentGifts };
}

async function saveProgress(pool, familyId, progress) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Remove existing progress (cascades to ledgers via kids).
    await client.query('DELETE FROM kids WHERE family_id = $1', [familyId]);
    // Remove existing parent reward gifts.
    await client.query('DELETE FROM parent_gifts WHERE family_id = $1', [familyId]);

    const kids = (progress && progress.kids) || [];
    for (const kid of kids) {
      const kidRes = await client.query(
        'INSERT INTO kids (family_id, name, leaderboard_nickname, avatar) VALUES ($1, $2, $3, $4) RETURNING id',
        [familyId, String(kid.name || 'Kid'), kid.leaderboardNickname || null, kid.avatar || null]
      );
      const kidId = kidRes.rows[0].id;

      for (const c of kid.coins || []) {
        await client.query(
          "INSERT INTO coin_ledger (kid_id, activity, coins, status, earned_at, approved_at) VALUES ($1, $2, $3, $4, $5, $6)",
          [
            kidId,
            String(c.activity || ''),
            Math.max(0, parseInt(c.coins, 10) || 0),
            c.status === 'approved' ? 'approved' : 'pending',
            c.earnedAt ? new Date(c.earnedAt) : new Date(),
            c.approvedAt ? new Date(c.approvedAt) : null,
          ]
        );
      }
      for (const p of kid.points || []) {
        await client.query(
          'INSERT INTO point_ledger (kid_id, points_earned, points_spent, source, earned_at) VALUES ($1, $2, $3, $4, $5)',
          [
            kidId,
            Math.max(0, parseInt(p.earned, 10) || 0),
            Math.max(0, parseInt(p.spent, 10) || 0),
            p.source || null,
            p.earnedAt ? new Date(p.earnedAt) : new Date(),
          ]
        );
      }
      for (const a of kid.activities || []) {
        await client.query(
          'INSERT INTO activity_log (kid_id, series, week, day, activity_type, minutes_or_value, completed_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [
            kidId,
            a.series || null,
            a.week != null ? parseInt(a.week, 10) : null,
            a.day != null ? parseInt(a.day, 10) : null,
            String(a.activityType || ''),
            a.minutesOrValue != null ? parseInt(a.minutesOrValue, 10) : null,
            a.completedAt ? new Date(a.completedAt) : new Date(),
          ]
        );
      }
    }
    // Parent-set reward gifts (Parent Rewards).
    const parentGifts = (progress && progress.parentGifts) || [];
    for (const g of parentGifts) {
      const name = String(g.name || '').trim();
      if (!name) continue;
      const coinPrice = Math.max(0, parseInt(g.coinPrice != null ? g.coinPrice : g.coin_price, 10) || 0);
      await client.query(
        'INSERT INTO parent_gifts (family_id, name, coin_price) VALUES ($1, $2, $3)',
        [familyId, name, coinPrice]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session) {
      res.status(401).json({ signedIn: false });
      return;
    }
    const pool = getPool();

    if (req.method === 'POST') {
      const body = readBody(req);
      await saveProgress(pool, session.family_id, body.progress);
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method !== 'GET') {
      res.status(405).json({ signedIn: false });
      return;
    }

    const { rows } = await pool.query(
      'SELECT id, parent_name, email, auth_provider, setup_completed FROM families WHERE id = $1',
      [session.family_id]
    );
    if (!rows.length) {
      res.status(401).json({ signedIn: false });
      return;
    }
    const f = rows[0];
    const progress = await loadProgress(pool, f.id);
    res.status(200).json({
      signedIn: true,
      family: {
        id: f.id,
        parentName: f.parent_name,
        email: f.email,
        authProvider: f.auth_provider,
        setupCompleted: !!f.setup_completed,
      },
      progress,
    });
  } catch (err) {
    console.error('me failed'); // never log user data
    res.status(500).json({ signedIn: false });
  }
};
