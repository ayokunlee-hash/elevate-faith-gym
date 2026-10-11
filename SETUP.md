# Elevate Faith Gym: Auth Kit Setup

This kit adds real Google and email sign-up to the Elevate Faith Gym app.
It is built for Vercel serverless functions plus a Neon Postgres database.
Nothing here is faked: Google uses real OAuth 2.0, email uses real
magic links sent through Resend, and sessions live in the database.

## What is in this folder

- `api/auth/` - the serverless endpoints (Google start and callback,
  email magic-link start and verify, email password sign-up and sign-in,
  current user, logout, PIN save, setup completion)
- `api/admin/stats.js` - real aggregate figures for the admin dashboard
  (requires a signed-in parent session)
- `lib/` - shared helpers (database pool, sessions, PIN hashing,
  password hashing, tokens)
- `schema.sql` - the full database schema, run once
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
```

`password_hash` stores only a salted scrypt hash for families that sign
up with an email and password. `country` is an optional ISO country
code used only for aggregate sign-up counts on the admin dashboard.

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

## Hardening checklist (recommended before launch)

- Verify a sending domain in Resend and set `EMAIL_FROM` to it.
- Add a real privacy policy and terms of service, and review COPPA
  requirements for users under 13.
- Set up database backups in Neon (automatic on paid tiers).
- Review the `ADAPT` points in `frontend-snippet.js` against the final
  page before announcing the launch.
