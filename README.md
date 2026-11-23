# MediaIQ

MediaIQ helps a marketing user keep one campaign-performance file, check that it is coherent, and ask questions about the figures that file supports.

The implemented application is the Campaign Evidence Explainer. A signed-in user uploads a campaign CSV. The server validates the whole file, calculates descriptive totals, and shows those totals with their limits. MIA, the Media Intelligence Assistant, answers from that calculated evidence. It can explain a figure, compare figures, or refuse a question the evidence does not support. It does not recommend a media plan.

The four intelligence pillars, Recommendation Engine, and AI Media Planner are not part of this application.

## What a user can do

1. Create an account with email and password.
2. Confirm the email address and enroll an authenticator app.
3. Sign in. A password alone does not open the workspace. The session must be authenticator assurance level 2 with a verified TOTP factor.
4. Upload one UTF-8 CSV with the columns `date`, `campaign`, `channel`, `spend`, `impressions`, and `clicks`. Optional columns are `conversions`, `revenue`, and `currency`.
5. Review the calculated evidence. Counts and money stay exact decimal text. Rates are omitted when the divisor is zero. The application does not convert currency.
6. Ask MIA about that evidence. The model receives the calculated summary and the question. It does not receive the CSV. The server checks references before showing a figure.
7. Delete that evidence. Deletion removes the stored file text, summary, and latest exchange together.

Performance is the saved-evidence library for this account. Commercial, Audience, Cross-Media, Intelligence, Reports, and the planner state that their data is not connected. They are not separate intelligence products.

## Authentication

Protected pages require a confirmed email, a verified TOTP factor, and an AAL2 session. Password reset changes the password and still requires the authenticator before the workspace opens. Public pages are login, signup, password reset, and the MFA screens. Authentication email links return through `/auth/confirm/enroll` and `/auth/confirm/recovery`.

## Local setup

Node.js 20 or newer, npm, and Docker are required. Docker is used by the local Supabase stack.

```bash
npm install
```

Copy `.env.example` to `.env.local` and replace the placeholders. `.env.local` stays untracked. After the local stack is running, `npx supabase status` shows the project URL and publishable key for the two `NEXT_PUBLIC_` variables. Do not commit real keys.

```bash
npx supabase start
npm run dev
```

The local Auth configuration uses `http://127.0.0.1:3000`. `SITE_URL` can stay empty during local development. The local API listens on port 54321, the database on port 54322, and Studio on port 54323. The local database container is `supabase_db_MediaIQ`. Do not reset that database as part of ordinary startup.

## Checks

```bash
npm test
npm run lint
npx next typegen
npx tsc --noEmit
npm run build
```

`npm test` runs the authentication policy tests, the audit-signature tests, the evidence parser and calculation tests, and the MIA unit tests that use local mocks. It does not run the SQL authorization scripts under `supabase/tests/`, and it does not call a model provider. Those SQL scripts are local transaction tests. Do not point them at a database that holds evidence you need to keep.

For local TypeScript verification, run `npx next typegen` before `npx tsc --noEmit`. GitHub Actions runs `npm ci`, `npm test`, `npm run lint`, then generates route types with `npx next typegen` before `npx tsc --noEmit`, on pulls and on pushes to `main`. The workflow has no production credentials and does not migrate a database.

## Database

Schema changes belong in a new file under `supabase/migrations/`. Do not edit a migration that has already been applied. Workspace membership and business membership are separate. Evidence is owned by the authenticated user, not by workspace membership.

The local seed file named in `supabase/config.toml` is not in this repository.

## Current limits

- MIA is evidence-grounded. It is not a planner, a recommendation engine, or a forecast.
- An invalid CSV is rejected in full. Nothing from that file is stored or sent to the model.
- Unknown provider billing does not by itself record a charge. Releasing a reserved hold is a separate authenticated action and does not prove the provider billed the request.
- The evidence database connection is refused when `NODE_ENV` is `production`, and when `VERCEL_ENV` is `production` or `preview`. Campaign evidence and MIA cannot use that connection in those environments until that restriction is deliberately changed.
- Local development rate limits share one client identity, `local`. A Vercel deployment uses one validated address from `x-vercel-forwarded-for` and rejects the attempt when that address is missing or invalid. Other forwarded client addresses are not trusted.
- A production process must set a valid HTTPS `SITE_URL`. Local HTTP is accepted only for `localhost` and `127.0.0.1` outside production.

## Deployment prerequisites

The application is a Next.js App Router project and can be hosted where that runtime is supported. Deployment is not ready until each of these is true:

- The host provides `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` from the hosted Supabase project.
- `SITE_URL` is the public HTTPS origin, with no path or query. The Supabase project's site URL and additional redirect URLs include `/auth/confirm/enroll` and `/auth/confirm/recovery` on that origin.
- The hosted project sends confirmation and recovery email.
- `MEDIAIQ_SECURITY_DATABASE_URL`, `MEDIAIQ_AUDIT_SIGNING_KEY`, `MEDIAIQ_AUDIT_SIGNING_KEY_ID`, and `MEDIAIQ_RATE_LIMIT_PEPPER` are set as server-only values.
- `MEDIAIQ_OPENAI_API_KEY` is server-only. There is no second model provider.
- `MEDIAIQ_EVIDENCE_DATABASE_URL` remains unused in production and preview. The application rejects that connection there.

This repository does not contain a completed production deployment.
