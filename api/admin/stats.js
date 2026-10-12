// GET /api/admin/stats
// Returns real aggregate figures for the admin dashboard. Requires a
// signed-in parent session (401 otherwise). Never returns children's
// names or any other PII, only counts and aggregates.
//
// Definitions (all dates in UTC, matching the database clock):
// - signupsToday: families created since the start of today
// - activeKids7d: distinct kids with any logged activity in the last 7 days
// - dropoffByWeek: for weeks 1 to 7, started = distinct kids with any
//   logged activity that week, completed = distinct kids with logged
//   activity on at least 7 distinct days that week
const { getPool } = require('../../lib/db');
const { getSession } = require('../../lib/session');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false });
    return;
  }
  try {
    const session = await getSession(req);
    if (!session) {
      res.status(401).json({ ok: false });
      return;
    }
    const pool = getPool();

    const totals = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM families) AS families,
         (SELECT COUNT(*)::int FROM kids) AS kids,
         (SELECT COUNT(*)::int FROM families WHERE created_at >= CURRENT_DATE) AS signups_today,
         (SELECT COUNT(DISTINCT kid_id)::int FROM activity_log WHERE completed_at >= NOW() - INTERVAL '7 days') AS active_kids_7d,
         (SELECT COALESCE(SUM(coins), 0)::int FROM coin_ledger WHERE status = 'pending') AS coins_pending,
         (SELECT COALESCE(SUM(coins), 0)::int FROM coin_ledger WHERE status = 'approved') AS coins_approved,
         (SELECT COALESCE(SUM(points_earned), 0)::int FROM point_ledger) AS points_issued,
         (SELECT COALESCE(SUM(points_spent), 0)::int FROM point_ledger) AS points_spent,
         (SELECT COUNT(*)::int FROM verse_vault) AS verses_memorized,
         (SELECT COUNT(*)::int FROM gift_redemptions WHERE status = 'queued') AS redemptions_queued`
    );

    const countries = await pool.query(
      `SELECT country, COUNT(*)::int AS count
         FROM families
        WHERE country IS NOT NULL AND country <> ''
        GROUP BY country
        ORDER BY count DESC`
    );

    const activity = await pool.query(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COUNT(a.id)::int AS events
         FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') AS d(day)
         LEFT JOIN activity_log a
           ON a.completed_at >= d.day AND a.completed_at < d.day + INTERVAL '1 day'
        GROUP BY d.day
        ORDER BY d.day`
    );

    const dropoff = await pool.query(
      `SELECT w.week,
              COALESCE(s.started, 0)::int AS started,
              COALESCE(c.completed, 0)::int AS completed
         FROM generate_series(1, 7) AS w(week)
         LEFT JOIN (
           SELECT week, COUNT(DISTINCT kid_id) AS started
             FROM activity_log
            WHERE week BETWEEN 1 AND 7
            GROUP BY week
         ) s ON s.week = w.week
         LEFT JOIN (
           SELECT week, COUNT(*) AS completed
             FROM (
               SELECT week, kid_id
                 FROM activity_log
                WHERE week BETWEEN 1 AND 7
                GROUP BY week, kid_id
               HAVING COUNT(DISTINCT day) >= 7
             ) t
            GROUP BY week
         ) c ON c.week = w.week
        ORDER BY w.week`
    );

    const t = totals.rows[0] || {};
    res.status(200).json({
      ok: true,
      families: t.families || 0,
      kids: t.kids || 0,
      signupsToday: t.signups_today || 0,
      activeKids7d: t.active_kids_7d || 0,
      coinsPending: t.coins_pending || 0,
      coinsApproved: t.coins_approved || 0,
      pointsIssued: t.points_issued || 0,
      pointsSpent: t.points_spent || 0,
      versesMemorized: t.verses_memorized || 0,
      redemptionsQueued: t.redemptions_queued || 0,
      signupsByCountry: countries.rows.map((r) => ({ country: r.country, count: r.count })),
      activityByDay: activity.rows.map((r) => ({ day: r.day, events: r.events })),
      dropoffByWeek: dropoff.rows.map((r) => ({
        week: r.week,
        started: r.started,
        completed: r.completed,
      })),
    });
  } catch (err) {
    console.error('admin stats failed');
    res.status(500).json({ ok: false });
  }
};
