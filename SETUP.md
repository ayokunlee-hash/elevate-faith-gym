# Elevate Faith Gym: Auth Kit Setup

This kit adds real Google and email sign-up to the Elevate Faith Gym app.
It is built for Vercel serverless functions plus a Neon Postgres database.
Nothing here is faked: Google uses real OAuth 2.0, email uses real
magic links sent through Resend, and sessions live in the database.

## What is in this folder

- `api/auth/` - the serverless endpoints (Google start and callback,
  email magic-link start and verify, email password sign-up and sign-in,
  current user, logout, PIN reset, setup and PIN save)
- `api/admin/stats.js` - real aggregate figures for the admin dashboard
  (requires a signed-in parent session)
- `api/cron/notify.js` - the daily parent notification job (approval
  reminders every run, weekly digest on Mondays, protected by
  `CRON_SECRET`)
- `vercel.json` - the cron schedule Vercel runs automatically, plus
  rewrites that keep the previous endpoint URLs working
- `lib/` - shared helpers (database pool, sessions, PIN hashing,
  password hashing, tokens, email templates)
- `schema.sql` - the full database schema, run once
- `specs/` - approved build specs not yet implemented (guest carry-over)
- `frontend-snippet.js` - the JavaScript to paste into the existing
  `index.html`, just before `</body>`
- `package.json` - the only two dependencies: `pg` and `resend`

## How the project is laid out for deploy

1. Copy `api/`, `lib/`, and `package.json` from this folder into the
   app project.
2. Place the app's `index.html` at the project root, next to `api/`.
3. Push to GitHub. Vercel deploys automatically.

Vercel treats every file under `api/` as a serverless function, so
`/api/auth/google-start.js` becomes the live endpoint
`https://your-app.vercel.app/api/auth/google-start`.

## Environment variables

Set these in Vercel: open the project, go to Settings, then
Environment Variables. Add each one for the Production environment.

| Variable | What it is | Where to get it |
|---|---|---|
| `APP_URL` | The live app address, no trailing slash. Example: `https://elevate-faith-gym.vercel.app` | Your Vercel project URL |
| `DATABASE_URL` | The Neon Postgres connection string | Vercel Storage tab, or the Neon dashboard |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | Google Cloud Console (step 2 below) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret. Never share this. | Google Cloud Console (step 2 below) |
| `SESSION_SECRET` | A long random string used to sign session cookies. Generate with: `openssl rand -hex 32` | You create it |
| `RESEND_API_KEY` | API key for sending magic-link emails | Resend dashboard |
| `EMAIL_FROM` | Optional. The address magic links are sent from. Defaults to `onboarding@resend.dev`. For production, verify your own domain in Resend and set it here. | Resend dashboard |
| `CRON_SECRET` | A long random string that protects the scheduled notification endpoints. Generate with: `openssl rand -hex 32`. Vercel cron sends it automatically as a bearer token; the endpoints reject any request without it. | You create it |

After adding or changing variables, redeploy the project so they take effect.

## Step 1: create the database (needs the account owner)

Why the owner: the database lives inside the owner's Vercel team, and only
the owner can attach paid or free storage integrations to it.

1. In the Vercel project dashboard, open the Storage tab.
2. Choose Postgres and create a Neon database (free tier is fine).
3. Vercel adds `DATABASE_URL` to the project automatically. Confirm it is
   listed under Settings, Environment Variables.
4. Open the Neon dashboard, go to the SQL editor, paste the entire
   contents of `schema.sql`, and run it. This creates all tables once.

## Migration for an existing database

If you already ran the first version of `schema.sql`, run this one
statement in the Neon SQL editor to add the two new family columns.
It is safe to run more than once.

```sql
ALTER TABLE families ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE families ADD COLUMN IF NOT EXISTS country TEXT;

CREATE TABLE IF NOT EXISTS notification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  kid_id UUID REFERENCES kids(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('approval_reminder', 'weekly_digest')),
  ref_id TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notification_log_family ON notification_log(family_id);
CREATE INDEX IF NOT EXISTS idx_notification_log_dedupe ON notification_log(type, ref_id);

CREATE TABLE IF NOT EXISTS pin_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pin_reset_tokens_family ON pin_reset_tokens(family_id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_family ON password_reset_tokens(family_id);
```

`password_hash` stores only a salted scrypt hash for families that sign
up with an email and password. `country` is an optional ISO country
code used only for aggregate sign-up counts on the admin dashboard.
`notification_log` records every parent notification email so nothing is
ever sent twice: `type` is `approval_reminder` (with `ref_id` set to the
redemption or coin row that triggered it) or `weekly_digest` (with
`ref_id` set to the Monday date of the week). `pin_reset_tokens` holds
single-use, 30-minute PIN reset tokens (only SHA-256 hashes are stored);
each row is marked used when the new PIN is set.

## PIN reset for signed-in parents (email link)

For Google and email families, "Forgot PIN?" no longer signs the parent
out. Instead, the single endpoint `POST /api/auth/pin-reset` handles all
three steps (the old `/api/auth/pin-reset-request`, `/api/auth/pin-reset-start`
and `/api/auth/pin-reset-confirm` URLs keep working through rewrites in
`vercel.json`):

1. The app calls `POST /api/auth/pin-reset` with no token (session
   required). The server creates a single-use token and emails a reset
   link to the parent's account email via Resend.
2. The parent clicks the link, which hits
   `GET /api/auth/pin-reset?token=...`. A valid token redirects to
   `/#setup?pinResetToken=...` (setup page in PIN-reset mode). Expired or
   used tokens redirect to `?auth=pinreset_expired#setup`.
3. On the setup page the parent enters a new 4-digit PIN twice. The app
   calls `POST /api/auth/pin-reset` with `{ token, pin }`, which stores
   only the scrypt hash and marks the token used.

This requires `RESEND_API_KEY`, `EMAIL_FROM`, and `APP_URL` in Vercel.
Guest families keep the local flow: "Forgot PIN?" clears the stored PIN
and the parent sets a new one (typed twice) on the setup page.

## Step 2: create the Google OAuth client (needs the account owner)

Why the owner: Google ties OAuth credentials to a Google identity. The
client ID and secret belong to whoever owns the Google account, and only
that person can consent on behalf of the app.

1. Go to console.cloud.google.com and sign in with the Google account
   that will own the app.
2. Create a new project and name it Elevate Faith Gym.
3. In the left menu go to APIs and Services, then OAuth consent screen.
   Choose External, and fill in the app name and a support email.
4. Go to Credentials, then Create Credentials, then OAuth client ID.
   Choose Web application.
5. Under Authorized redirect URIs, add exactly:
   `https://your-app.vercel.app/api/auth/google-callback`
   Replace the domain with the real `APP_URL`. It must match character
   for character, including `https://`.
6. Copy the Client ID into `GOOGLE_CLIENT_ID` in Vercel, and the Client
   Secret into `GOOGLE_CLIENT_SECRET` in Vercel. The secret goes only
   into Vercel's Environment Variables, never into chat, email, or code.

## Step 3: wire up the frontend

1. Open the app's `index.html`.
2. Paste the entire contents of `frontend-snippet.js` just before the
   closing `</body>` tag.
3. Find the lines marked `ADAPT` in the snippet and point them at the
   real button labels, input ids, and view functions in the page.
4. The snippet enables the Google and email buttons (the prototype had
   them disabled), pre-fills the parent name from the Google account
   into the editable parent name field, returns the user to the setup
   page after login, and blocks entry into the app until setup is
   finished.

## Step 4: deploy

1. Commit everything (`api/`, `lib/`, `package.json`, `index.html` with
   the snippet) and push to the GitHub repo.
2. Vercel builds and deploys automatically.
3. Open the live URL and test: sign up with Google, confirm the parent
   name is pre-filled and editable, finish setup, and confirm the app
   opens. Then test the email magic link the same way, and test email
   sign-up and sign-in with a password (try a short password and a
   duplicate email to confirm the 400 and 409 responses).

## How sign-in works, in plain language

- Google: the app sends the parent to Google, Google sends back a code,
  the server trades the code for the parent's name and email, creates
  the family record, and sets a signed login cookie that JavaScript
  cannot read.
- Email: the parent enters an email, the server emails a one-time link
  that expires in 15 minutes, and tapping it signs them in the same way.
  Parents can also sign up and sign in with an email and a password of
  at least 8 characters: `POST /api/auth/email-signup` takes
  `{ email, password, parentName }` and returns 409 if the email is
  already registered; `POST /api/auth/email-signin` takes
  `{ email, password }` and returns 401 without saying whether the
  address exists. Passwords are stored only as salted scrypt hashes.
- Admin stats: `GET /api/admin/stats` returns real aggregate figures
  from the database (family and kid counts, sign-ups today, active kids
  over 7 days, pending and approved coins, points issued and spent,
  verses memorized, queued redemptions, sign-ups by country, activity
  by day for the last 14 days, and week-by-week drop-off). It requires
  a signed-in parent session and returns 401 otherwise. It never
  returns children's names or any other PII, only counts.
- The 4-digit parent PIN is stored only as a salted hash. The plain PIN
  never touches the database or the logs.
- Children's names are never written to logs anywhere in this kit.

## Parent notification emails

Two scheduled jobs send transactional account emails to parents,
as disclosed in the app's Terms. Both live in the single endpoint
`GET /api/cron/notify`, which Vercel runs daily at 9:00 UTC
(`0 9 * * *` in `vercel.json`). The templates live in
`lib/email-templates.js` and return both a plain-text and an HTML
version of each email.

- Approval reminders (every run): finds gift
  redemptions queued for over 24 hours and coins pending approval for
  over 48 hours, groups them by family, and sends ONE email per parent
  listing everything waiting, with a link back to Parent's Corner.
  An item is never emailed about twice: each one is recorded in
  `notification_log` the moment its email goes out.
- Weekly digest (Mondays only): builds a
  per-kid summary for the last 7 days (days practiced, coins earned,
  quiz points earned, verses memorized) from `activity_log`,
  `coin_ledger`, `point_ledger`, and `verse_vault`, and emails it to
  the parent. Families with no activity that week are skipped, and
  each family gets at most one digest per week (tracked in
  `notification_log`).

The endpoint requires the `CRON_SECRET` bearer token and returns 401
without it, so it cannot be triggered by outsiders.

The jobs were merged into one endpoint so the project stays within the
Vercel Hobby plan's limit of 12 serverless functions per deployment.
For the same reason, `/api/auth/pin-reset` handles the whole PIN-reset
flow and `/api/auth/setup` handles both PIN saving and setup
completion; the previous individual URLs keep working through the
`rewrites` in `vercel.json`, so the app's fetch calls did not change.

How Vercel runs it: the schedule lives in `vercel.json` at the
project root. When `CRON_SECRET` is set as an environment variable, Vercel
automatically attaches it as the `Authorization: Bearer` header on
every cron invocation, so there is nothing else to configure. Make
sure `vercel.json` is committed at the project root next to `api/`.

To test an endpoint by hand, call it with curl and the secret:

```
curl -H "Authorization: Bearer YOUR_CRON_SECRET" \
  https://your-app.vercel.app/api/cron/notify
```

It returns `{ ok: true, reminders: {...}, digest: {...} }` with how many parents were emailed.

## Hardening checklist (recommended before launch)

- Verify a sending domain in Resend and set `EMAIL_FROM` to it.
- Add a real privacy policy and terms of service, and review COPPA
  requirements for users under 13.
- Set up database backups in Neon (automatic on paid tiers).
- Review the `ADAPT` points in `frontend-snippet.js` against the final
  page before announcing the launch.
