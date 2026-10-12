// Email templates for Elevate Faith Skills parent notifications.
// Each function returns { subject, text, html }.
// Warm, plain-spoken, addressed to the parent, kid-positive tone.
// These are transactional account emails disclosed in the app's Terms.

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapHtml(title, body) {
  return (
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1f3a4d;">' +
    '<h1 style="color:#0b7fa4;font-size:22px;margin:0 0 16px;">' + esc(title) + '</h1>' +
    body +
    '<p style="margin-top:24px;font-size:12px;color:#7a8a96;">' +
    'You are getting this because you have an Elevate Faith Skills parent account. ' +
    'These are account emails about your child\u2019s activity, as described in our Terms.</p>' +
    '</div>'
  );
}

// pendingCoins: [{ kidName, activity, coins, earnedAt }]
// queuedGifts: [{ kidName, giftName, redeemedAt }]
function approvalReminder({ parentName, pendingCoins, queuedGifts, appUrl }) {
  const name = parentName && parentName.trim() ? parentName.trim() : 'there';
  const subject = 'Things waiting for your approval in Elevate Faith Skills';

  const coinLines = pendingCoins.map(function (c) {
    return '- ' + c.kidName + ' earned ' + c.coins + ' coins for ' + c.activity;
  });
  const giftLines = queuedGifts.map(function (g) {
    return '- ' + g.kidName + ' redeemed "' + g.giftName + '" and it is waiting for you to fulfill';
  });

  const text =
    'Hi ' + name + ',\n\n' +
    'Your child has been putting in the work, and a few things in Elevate Faith Skills are waiting for your approval:\n\n' +
    coinLines.join('\n') + '\n' +
    giftLines.join('\n') + '\n\n' +
    'Open the app, tap Parent\u2019s Corner, and approve or fulfill them when you get a moment. ' +
    'Your child will see the coins land and the reward move forward, which is a big deal to them.\n\n' +
    'Open Parent\u2019s Corner: ' + appUrl + '\n\n' +
    'Keep up the great parenting,\nThe Elevate Faith Skills team';

  let body = '<p>Hi ' + esc(name) + ',</p>' +
    '<p>Your child has been putting in the work, and a few things in Elevate Faith Skills are waiting for your approval:</p>' +
    '<ul style="padding-left:20px;">';
  pendingCoins.forEach(function (c) {
    body += '<li>' + esc(c.kidName) + ' earned <strong>' + esc(c.coins) + ' coins</strong> for ' + esc(c.activity) + '</li>';
  });
  queuedGifts.forEach(function (g) {
    body += '<li>' + esc(g.kidName) + ' redeemed <strong>' + esc(g.giftName) + '</strong> and it is waiting for you to fulfill</li>';
  });
  body += '</ul>' +
    '<p>Open the app, tap Parent\u2019s Corner, and approve or fulfill them when you get a moment. ' +
    'Your child will see the coins land and the reward move forward, which is a big deal to them.</p>' +
    '<p><a href="' + esc(appUrl) + '" style="display:inline-block;background:#0b7fa4;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;">Open Parent\u2019s Corner</a></p>' +
    '<p>Keep up the great parenting,<br>The Elevate Faith Skills team</p>';

  return { subject: subject, text: text, html: wrapHtml('Approval needed', body) };
}

// kids: [{ name, daysCompleted, activitiesDone, coinsEarned, pointsEarned, versesMemorized }]
function weeklyDigest({ parentName, kids, appUrl, weekLabel }) {
  const name = parentName && parentName.trim() ? parentName.trim() : 'there';
  const subject = 'How your child did this week in Elevate Faith Skills';

  const kidBlocks = kids.map(function (k) {
    const lines = [];
    lines.push(k.name + ':');
    lines.push('  Days trained: ' + k.daysCompleted);
    lines.push('  Coins earned: ' + k.coinsEarned);
    lines.push('  Quiz points earned: ' + k.pointsEarned);
    lines.push('  Verses memorized: ' + k.versesMemorized);
    return lines.join('\n');
  });

  const text =
    'Hi ' + name + ',\n\n' +
    'Here is how your child did in Elevate Faith Skills this week' +
    (weekLabel ? ' (' + weekLabel + ')' : '') + ':\n\n' +
    kidBlocks.join('\n\n') + '\n\n' +
    'Every day they show up, their faith fitness grows. A little encouragement from you goes a long way, ' +
    'so celebrate the streaks you see above.\n\n' +
    'Open the app: ' + appUrl + '\n\n' +
    'Cheering you both on,\nThe Elevate Faith Skills team';

  let body = '<p>Hi ' + esc(name) + ',</p>' +
    '<p>Here is how your child did in Elevate Faith Skills this week' +
    (weekLabel ? ' (' + esc(weekLabel) + ')' : '') + ':</p>';
  kids.forEach(function (k) {
    body += '<div style="border:2px solid #0b7fa4;border-radius:12px;padding:16px;margin:0 0 16px;">' +
      '<h2 style="margin:0 0 8px;font-size:18px;color:#0b7fa4;">' + esc(k.name) + '</h2>' +
      '<ul style="margin:0;padding-left:20px;">' +
      '<li>Days trained: <strong>' + esc(k.daysCompleted) + '</strong></li>' +
      '<li>Coins earned: <strong>' + esc(k.coinsEarned) + '</strong></li>' +
      '<li>Quiz points earned: <strong>' + esc(k.pointsEarned) + '</strong></li>' +
      '<li>Verses memorized: <strong>' + esc(k.versesMemorized) + '</strong></li>' +
      '</ul></div>';
  });
  body += '<p>Every day they show up, their faith fitness grows. A little encouragement from you goes a long way, ' +
    'so celebrate the streaks you see above.</p>' +
    '<p><a href="' + esc(appUrl) + '" style="display:inline-block;background:#0b7fa4;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;">Open Elevate Faith Skills</a></p>' +
    '<p>Cheering you both on,<br>The Elevate Faith Skills team</p>';

  return { subject: subject, text: text, html: wrapHtml('Weekly progress', body) };
}

// Reset link for a forgotten parent PIN. Single use, 30 minute expiry.
function pinReset({ appUrl, link }) {
  const subject = 'Reset your Elevate Faith Skills parent PIN';
  const body =
    '<p>Tap the link below to set a new 4-digit parent PIN for Elevate Faith Skills. ' +
    'It expires in 30 minutes and can only be used once.</p>' +
    '<p><a href="' + esc(link) + '" style="display:inline-block;background:#0b7fa4;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;">Reset my PIN</a></p>' +
    '<p>If you did not ask for this email, you can safely ignore it. Your current PIN still works.</p>';
  const text =
    'Set a new 4-digit parent PIN for Elevate Faith Skills (expires in 30 minutes, single use):\n' +
    link +
    '\n\nIf you did not ask for this email, ignore it. Your current PIN still works.';
  return { subject: subject, text: text, html: wrapHtml('Reset your parent PIN', body) };
}

function passwordReset({ appUrl, link }) {
  const subject = 'Reset your Elevate Faith Skills password';
  const body =
    '<p>Tap the link below to set a new password for your Elevate Faith Skills family account. ' +
    'It expires in 30 minutes and can only be used once.</p>' +
    '<p><a href="' + esc(link) + '" style="display:inline-block;background:#0b7fa4;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;">Reset my password</a></p>' +
    '<p>If you did not ask for this email, you can safely ignore it. Your current password still works.</p>';
  const text =
    'Set a new password for your Elevate Faith Skills family account (expires in 30 minutes, single use):\n' +
    link +
    '\n\nIf you did not ask for this email, ignore it. Your current password still works.';
  return { subject: subject, text: text, html: wrapHtml('Reset your password', body) };
}

module.exports = { approvalReminder, weeklyDigest, pinReset, passwordReset };
