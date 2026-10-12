// GET /api/cron/notify
// Single daily cron (9:00 UTC) that sends both parent email jobs:
//   1. Approval reminders (every run): gift redemptions queued for over 24
//      hours and coins pending approval for over 48 hours. One email per
//      parent listing everything waiting, never emailed twice about the
//      same item (deduped through notification_log).
//   2. Weekly digest (Mondays only): a warm "How your child did this week"
//      email with a per-kid summary for the last 7 days. Each family gets
//      at most one digest per calendar week (deduped through
//      notification_log with the Monday date as the ref_id).
// Merged from the previous /api/cron/approval-reminder and
// /api/cron/weekly-digest endpoints so the project stays within the
// Vercel Hobby plan's serverless function limit.
// Auth: Vercel cron sends Authorization: Bearer <CRON_SECRET> when
// CRON_SECRET is set as an env var. Compared in constant time; 401
// otherwise.
const crypto = require('crypto');
const { getPool } = require('../../lib/db');
const { approvalReminder, weeklyDigest } = require('../../lib/email-templates');
const { Resend } = require('resend');

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function prettyActivity(activity) {
  const labels = {
    video: 'watching the video',
    devotional: 'reading the devotional',
    prayer: 'the prayer activity',
    memory_verse: 'the memory verse',
    quiz: 'the quiz',
    notes: 'writing notes',
  };
  return labels[activity] || activity;
}

// Monday of the current week, UTC, as YYYY-MM-DD. Used as the digest
// dedupe key.
function weekKey() {
  const d = new Date();
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return d.toISOString().slice(0, 10);
}

function weekLabel() {
  const d = new Date(weekKey() + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function isMonday() {
  return new Date().getUTCDay() === 1;
}

async function runReminders(pool, resend, appUrl) {
  // Queued gift redemptions older than 24 hours, never notified before.
  const gifts = await pool.query(
    `SELECT gr.id, gr.kid_id, k.name AS kid_name, k.family_id, pg.name AS gift_name
       FROM gift_redemptions gr
       JOIN kids k ON k.id = gr.kid_id
       JOIN parent_gifts pg ON pg.id = gr.gift_id
      WHERE gr.status = 'queued'
        AND gr.redeemed_at < NOW() - INTERVAL '24 hours'
        AND NOT EXISTS (
          SELECT 1 FROM notification_log nl
          WHERE nl.type = 'approval_reminder' AND nl.ref_id = gr.id::text
        )`
  );

  // Pending coins older than 48 hours, never notified before.
  const coins = await pool.query(
    `SELECT cl.id, cl.kid_id, k.name AS kid_name, k.family_id, cl.activity, cl.coins
       FROM coin_ledger cl
       JOIN kids k ON k.id = cl.kid_id
      WHERE cl.status = 'pending'
        AND cl.earned_at < NOW() - INTERVAL '48 hours'
        AND NOT EXISTS (
          SELECT 1 FROM notification_log nl
          WHERE nl.type = 'approval_reminder' AND nl.ref_id = cl.id::text
        )`
  );

  // Group everything by family.
  const byFamily = new Map();
  function addItem(familyId, item) {
    if (!byFamily.has(familyId)) byFamily.set(familyId, { gifts: [], coins: [] });
    const bucket = byFamily.get(familyId);
    if (item.giftName) bucket.gifts.push(item);
    else bucket.coins.push(item);
  }
  gifts.rows.forEach(function (r) {
    addItem(r.family_id, {
      id: r.id, kidId: r.kid_id, kidName: r.kid_name,
      giftName: r.gift_name,
    });
  });
  coins.rows.forEach(function (r) {
    addItem(r.family_id, {
      id: r.id, kidId: r.kid_id, kidName: r.kid_name,
      activity: prettyActivity(r.activity), coins: r.coins,
    });
  });

  if (byFamily.size === 0) return { sent: 0, errors: 0 };

  const families = await pool.query(
    'SELECT id, parent_name, email FROM families WHERE id = ANY($1) AND email IS NOT NULL',
    [Array.from(byFamily.keys())]
  );

  let sent = 0;
  let errors = 0;
  for (const fam of families.rows) {
    const bucket = byFamily.get(fam.id);
    if (!bucket) continue;
    const tpl = approvalReminder({
      parentName: fam.parent_name,
      pendingCoins: bucket.coins,
      queuedGifts: bucket.gifts,
      appUrl: appUrl,
    });
    try {
      const result = await resend.emails.send({
        from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
        to: fam.email,
        subject: tpl.subject,
        text: tpl.text,
        html: tpl.html,
      });
      if (result && !result.error && result.data) {
        // Mark every item in this email as notified so it is never
        // emailed about again.
        for (const item of bucket.gifts.concat(bucket.coins)) {
          await pool.query(
            "INSERT INTO notification_log (family_id, kid_id, type, ref_id) VALUES ($1, $2, 'approval_reminder', $3)",
            [fam.id, item.kidId, String(item.id)]
          );
        }
        sent += 1;
      } else {
        errors += 1;
      }
    } catch (err) {
      errors += 1;
    }
  }
  return { sent: sent, errors: errors };
}

async function runDigest(pool, resend, appUrl) {
  const key = weekKey();

  // Per-kid aggregates for the last 7 days. Only families with a real
  // email address are included (guest families have none).
  const rows = await pool.query(
    `SELECT k.id AS kid_id, k.name AS kid_name, k.family_id,
            (SELECT COUNT(DISTINCT (a.completed_at AT TIME ZONE 'UTC')::date)
               FROM activity_log a
              WHERE a.kid_id = k.id
                AND a.completed_at > NOW() - INTERVAL '7 days') AS days_completed,
            (SELECT COALESCE(SUM(c.coins), 0)
               FROM coin_ledger c
              WHERE c.kid_id = k.id
                AND c.earned_at > NOW() - INTERVAL '7 days') AS coins_earned,
            (SELECT COALESCE(SUM(p.points_earned), 0)
               FROM point_ledger p
              WHERE p.kid_id = k.id
                AND p.earned_at > NOW() - INTERVAL '7 days') AS points_earned,
            (SELECT COUNT(*)
               FROM verse_vault v
              WHERE v.kid_id = k.id
                AND v.memorized_at > NOW() - INTERVAL '7 days') AS verses_memorized
       FROM kids k
       JOIN families f ON f.id = k.family_id
      WHERE f.email IS NOT NULL
        AND NOT EXISTS (
              SELECT 1 FROM notification_log nl
               WHERE nl.type = 'weekly_digest'
                 AND nl.family_id = k.family_id
                 AND nl.ref_id = $1
            )`,
    [key]
  );

  // Group by family, keeping only kids with some activity this week.
  const byFamily = new Map();
  rows.rows.forEach(function (r) {
    const days = Number(r.days_completed);
    const coins = Number(r.coins_earned);
    const points = Number(r.points_earned);
    const verses = Number(r.verses_memorized);
    if (days === 0 && coins === 0 && points === 0 && verses === 0) return;
    if (!byFamily.has(r.family_id)) byFamily.set(r.family_id, []);
    byFamily.get(r.family_id).push({
      name: r.kid_name,
      daysCompleted: days,
      coinsEarned: coins,
      pointsEarned: points,
      versesMemorized: verses,
    });
  });

  if (byFamily.size === 0) return { sent: 0, failed: 0 };

  const families = await pool.query(
    'SELECT id, parent_name, email FROM families WHERE id = ANY($1) AND email IS NOT NULL',
    [Array.from(byFamily.keys())]
  );

  let sent = 0;
  let failed = 0;
  for (const fam of families.rows) {
    const kids = byFamily.get(fam.id);
    if (!kids) continue;
    const tpl = weeklyDigest({
      parentName: fam.parent_name,
      kids: kids,
      appUrl: appUrl,
      weekLabel: weekLabel(),
    });
    try {
      const result = await resend.emails.send({
        from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
        to: fam.email,
        subject: tpl.subject,
        text: tpl.text,
        html: tpl.html,
      });
      if (result && !result.error && result.data) {
        await pool.query(
          "INSERT INTO notification_log (family_id, type, ref_id) VALUES ($1, 'weekly_digest', $2)",
          [fam.id, key]
        );
        sent += 1;
      } else {
        failed += 1;
      }
    } catch (err) {
      failed += 1;
    }
  }
  return { sent: sent, failed: failed };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ ok: false });
    return;
  }

  try {
    const pool = getPool();
    const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
    const resend = new Resend(process.env.RESEND_API_KEY);

    const reminders = await runReminders(pool, resend, appUrl);
    let digest = { sent: 0, failed: 0, skipped: true };
    if (isMonday()) {
      const d = await runDigest(pool, resend, appUrl);
      digest = { sent: d.sent, failed: d.failed, skipped: false };
    }

    // Never log family emails or children's names.
    res.status(200).json({ ok: true, reminders: reminders, digest: digest });
  } catch (err) {
    console.error('cron notify failed');
    res.status(500).json({ ok: false });
  }
};
