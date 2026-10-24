# Environments and deployment

Where Fivvi runs, how a change gets there, and how to undo it (E003, [ADR-011](../decisions/ADR-011-hosting-and-environments.md)). Everything runs on Railway, project `fivvi`, region **EU West Metal, Amsterdam** (`europe-west4-drams3a`).

## 1. Environments

| Environment | Where | Deploys | Database | Seed | Secrets |
|---|---|---|---|---|---|
| `local` | Your machine | `pnpm dev` | Docker Postgres 18 (`pnpm db:up`, [database README](../../packages/database/README.md)) | `pnpm db:seed` | Your own `.env` files, never committed |
| `pr-<number>` (preview) | Railway PR environment, one per open PR | The PR branch, on every push, after CI passes | Its own Postgres, empty at creation | Yes, on every deploy | Copied from `development`: test values only |
| `development` | Railway | `main`, after CI passes | Its own Postgres | Yes, on every deploy | Test or placeholder values only |
| `production` | Railway | `main` only, after CI passes | Its own Postgres, private network only | **Never** | Real values, set by the owner |

- **PR environments** are created when a PR opens and deleted when it is merged or closed. Railway copies them from the **base environment**. Bot PR environments and focused PR environments are off.
- **`development` is the base environment, so production values never reach a preview.** Without a base environment, Railway copies PR environments from `production`, including every secret (Brevo, Sentry, …). Previews run code nobody has merged yet, so they only ever get the test values in `development`. It also deploys `main` with demo data, as a shared place to try things. Its `web` sleeps when idle, so it costs little.
- No `staging` environment (`ROADMAP.md` M1). Add one only when a real need appears.
- **Production address:** `https://web-production-d3fe2.up.railway.app`, the Railway domain of `web`. fivvi.app (bought 21 October 2026) replaces it, once it is added as a custom domain in Railway, before M5 (`ROADMAP.md` §4.5).
- **Uptime monitors** (UptimeRobot, free plan, set up by the owner in #47): every 5 minutes, with an email alert to the owner, on the production address:
  - `GET /api/v1/health`, which expects `200` (it answers `503` when Postgres is unreachable);
  - `/`, the web app.

## 2. Services

One Docker image ([`Dockerfile`](../../Dockerfile)) serves every service. Each service runs a different command:

| Service | What runs | Command in the image | Notes |
|---|---|---|---|
| `web` | Next.js web + API (Hono under `/api`), standalone Node server | `node web/apps/web/server.js` (image default) | Health check `GET /api/v1/health` pings Postgres. Railway domain; the custom domain fivvi.app is added before M5 (`ROADMAP.md` §4.5) |
| `web` pre-deploy | Release step: migrations (+ seed outside production) | `node /app/ops/packages/database/src/scripts/release.ts [--seed]` | Runs once per deploy, before the new version gets traffic |
| `cron` | Daily jobs (ADR-010). Skeleton until E012: connects, logs, exits 0 | `node /app/ops/apps/cron/src/main.ts` | `0 3 * * *` UTC. Exits 1 on failure, after reporting it to Sentry ([OBSERVABILITY.md](OBSERVABILITY.md)); no retries |
| `postgres` | Railway Postgres 18 (`postgres-ssl:18`) with a volume | n/a | **Private network only**: no TCP proxy, no public address |

**Why a Dockerfile, not Railpack:** Node 26 ships without Corepack, so the image installs the pinned pnpm itself. The image also needs two layouts: the standalone Next.js server, and the release and cron TypeScript sources with their production dependencies, run by Node directly as in local development. A Dockerfile pins all of this (base image by digest), and `docker build .` reproduces it locally.

```bash
docker build -t fivvi .
```

## 3. Infrastructure as code

[`.railway/railway.ts`](../../.railway/railway.ts) describes the services, region, builds, health check, pre-deploy step, cron schedule, sleeping and variable references. It uses [Railway Infrastructure as Code](https://docs.railway.com/infrastructure-as-code) (`railway` SDK, pinned exactly in the root `package.json`). It replaces Config as Code (`railway.json`/`railway.toml`), which is deprecated: new services can't use it since 2026-08-28, and it stops working on 2026-12-01.

Railway doesn't read this file on deploy. Changes are planned and applied with the Railway CLI, logged in as the owner, **to both environments**:

```bash
railway link --project fivvi --environment development
```

```bash
railway config plan
```

```bash
railway config apply
```

Then do the same with `--environment production`. Never apply to a PR environment; the file refuses to.

- Apply changes to `development` first: the next PRs pick them up, and production follows when you apply there.
- When `plan` keeps showing a change after `apply`, Railway may be dropping a value equal to its default (for example the restart policy). Remove it from the file. A first apply that creates services can need a second run to set every field; re-run `plan` until it says *already up to date*.
- **Adding Postgres to another environment:** Railway then stores the password generator as plain text (`POSTGRES_PASSWORD` = the literal `secret(32, "…")`), so the database runs with a known password. After applying to a new environment, check it (§7) and have the owner set a real value. Production, created first, has a random one.
- Things the file doesn't hold: the PR environment settings (PR environments on, base environment `development`, bot and focused PR environments off), Railway domains, the spending alert and variable values. They are in the dashboard; this document is their record.

Check the regions after any change:

```bash
railway environment config --json | jq '.services[].deploy.multiRegionConfig'
```

## 4. From PR to production

1. **Open a PR.** Railway creates `pr-<number>` from `development` and builds `web`, `cron` and `postgres` once CI is green ("Wait for CI").
2. **Pre-deploy:** `release.ts --seed` applies every migration to the PR's empty Postgres and inserts demo data. If it fails, the deploy stops.
3. **Health check:** Railway calls `/api/v1/health` until it returns 200 (timeout 120 s). Only then does the deployment get traffic.
4. **Smoke check** the PR URL and put the result in the PR description:

   ```bash
   curl -fsS https://<pr-domain>/api/v1/health
   ```

5. **Merge.** The PR goes through the merge queue ([ADR-018](../decisions/ADR-018-merge-queue.md)): GitHub tests it on the latest `main` and merges it when the checks pass. Railway deploys only `main` and the PR environments of open PRs, so the queue's temporary `gh-readonly-queue/main/*` branch deploys nothing. The PR environment is deleted when the PR is merged. CI runs on `main`; when it is green, `development` and `production` build `main`. In production, `release.ts` only migrates. Traffic switches after the health check passes.

Watch patterns limit rebuilds: `web` rebuilds for `apps/web`, `packages/**` and root build files; `cron` for `apps/cron`, `packages/database`, `packages/observability` and root build files. A docs-only change deploys nothing, but Railway still posts a green `fivvi - web` status on the commit, described "No deployment needed - watched paths not modified". `scripts/pr.sh smoke` and the merge gate read that status's description, not just its presence, to tell whether a PR has a preview.

## 5. Migrations

- **Forward-only** (ADR-005). They run in the pre-deploy step, from one process, never on app start-up.
- A failed migration fails the deploy; the previous deployment keeps serving. Fix it with a new migration.
- The old version keeps running until the new one is healthy, so for a moment both run against the new schema. Every migration must be safe for the code that's already deployed: expand → migrate → contract for anything destructive.
- **System rows that every environment needs are data migrations**, not seed data (`packages/database/README.md`).
- `cron` doesn't migrate. Its first run after a deploy may run before `web` has migrated; jobs are idempotent (ADR-010).

## 6. Rollback

- **Application:** in the dashboard, open the service's *Deployments*, choose an earlier successful deployment → *Rollback*. Or by ID:

  ```bash
  railway deployment list --service web --json
  ```

  ```bash
  railway api 'mutation { deploymentRollback(id: "<deployment-id>") }'
  ```

  A rollback runs the old image without its pre-deploy step and doesn't undo migrations, which is why every migration must be backwards-compatible (§5). Then revert the change on `main` with a PR, so the next deploy doesn't bring it back.
- **Database:** fix forward with a new migration. Restoring a backup is the last resort for data loss (§8; the full runbook is E016).
- **Configuration:** revert `.railway/railway.ts` in a PR and apply it again.

## 7. Variables

Railway sets `PORT`, `RAILWAY_*` and the Postgres variables itself. Error reporting reads two of them: `RAILWAY_ENVIRONMENT_NAME` (Sentry's `environment`) and `RAILWAY_GIT_COMMIT_SHA` (its `release`), see [OBSERVABILITY.md](OBSERVABILITY.md) §1. The image sets `NODE_ENV=production` and `HOSTNAME=0.0.0.0`.

Railway passes every variable to the Docker build too, but the build only sees those the `Dockerfile` declares with `ARG`. The `web` build stage declares `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `RAILWAY_ENVIRONMENT_NAME` and `RAILWAY_GIT_COMMIT_SHA`. A change to a build-time variable only takes effect after a rebuild (redeploy), not a restart.

| Name | Services | `production` | `development` (and so previews) | Set by |
|---|---|---|---|---|
| `DATABASE_URL` | `web`, `cron` | Reference `${{postgres.DATABASE_URL}}` (private network) | Same reference: each environment has its own Postgres | `.railway/railway.ts` |
| `PORT` | `web` | `3000` | `3000` | `.railway/railway.ts`. Railway would inject `8080`, but the Railway domain targets 3000: a mismatch passes the health check and answers 502 publicly |
| `BREVO_API_KEY` | `web` | The production Brevo API key (secret) | A separate dev/test key, **never** the production one; empty turns sending off (`readEmailConfig` throws) | Owner (`preserve()` in `.railway/railway.ts`) |
| `EMAIL_FROM_ADDRESS` | `web` | `noreply@fivvi.app`, the verified Brevo sender on fivvi.app (SPF, DKIM and DMARC set up, #162) | The same verified sender | Owner (`preserve()` in `.railway/railway.ts`) |
| `EMAIL_FROM_NAME` | `web` | `Fivvi` | `Fivvi` | `.railway/railway.ts` |
| `POSTHOG_KEY` | `web` | The project API key of the PostHog EU project, for server-side product events ([OBSERVABILITY.md](OBSERVABILITY.md) §4) | Empty: analytics is production-only, so previews and test traffic never skew the pilot metrics. **Never** the production key | Owner (`preserve()` in `.railway/railway.ts`) |
| `SENTRY_DSN` | `web` | The DSN of the Sentry `web` project (EU region), which also receives API errors | The same DSN (allowed, see the rules below): previews report as `preview`, `development` as `development`. Empty turns reporting off | Owner (`preserve()` in `.railway/railway.ts`) |
| `SENTRY_DSN` | `cron` | The DSN of the Sentry `cron` project (EU region) | The same DSN, or empty to turn it off | Owner (`preserve()` in `.railway/railway.ts`) |
| `NEXT_PUBLIC_SENTRY_DSN` | `web` (build time) | The DSN of the Sentry `web` project, the same value as `SENTRY_DSN`. Inlined into the browser bundle, so it is public, like every DSN | The same DSN: browser errors from previews report as `preview`. Empty turns browser reporting off | Owner (`preserve()` in `.railway/railway.ts`) |
| `SENTRY_AUTH_TOKEN` | `web` (build time only) | A Sentry organisation auth token (secret; it only allows uploading source maps and releases). **Sealed**, so it is never shown again and never copied into a PR environment | Empty: previews don't upload source maps, so their stack traces stay minified. Never the production token | Owner (`preserve()` in `.railway/railway.ts`) |
| `NEXT_PUBLIC_POSTHOG_KEY` | `web` | The project API key of the PostHog EU project, for cookieless page views ([OBSERVABILITY.md](OBSERVABILITY.md) §5). Public: the browser sends it with every page view. Read at runtime, despite the prefix, so no rebuild is needed | Empty: analytics is production-only, so previews and test traffic never skew the pilot metrics. **Never** the production key | Owner (`preserve()` in `.railway/railway.ts`) |
| `POSTHOG_HOST` | `web` | `https://eu.i.posthog.com`: PostHog EU Cloud (Frankfurt), the region in [sub-processors.md](../legal/sub-processors.md). Where product events and page views go. Read at runtime, so no rebuild is needed. Not secret. A key without a valid host turns analytics off ([OBSERVABILITY.md](OBSERVABILITY.md) §4.1) | Empty, like the keys | Owner (`preserve()` in `.railway/railway.ts`) |
| `BETTER_AUTH_SECRET` | `web` | A strong random secret of at least 32 characters, used by Better Auth to sign sign-in sessions and to key the hashes of sign-in links and codes (ADR-007, F001). Rotating it signs everyone out and voids pending sign-in emails | A separate generated secret, **never** the production one | Owner (`preserve()` in `.railway/railway.ts`) |
| `BETTER_AUTH_URL` | `web` | The public address of the environment, without a path: the Railway domain until fivvi.app is added, then `https://fivvi.app`. The links in sign-in emails point at it, and the sign-in cookie is `Secure` because it is `https` | The same reference: a preview's emails link to that preview | `.railway/railway.ts`: `https://${{RAILWAY_PUBLIC_DOMAIN}}`. Set the value explicitly in `production` when the custom domain is added |
| `BREVO_API_URL` | `web` | Not set | Not set. Only e2e runs set it, to a fake Brevo server (`packages/email/README.md`) | e2e config, never Railway |
| `SIGN_UP_ALLOWED_EMAILS` | `web` | Comma-separated exact addresses and `@domain` entries (`pilot@gym.test,@gym.test`; case-insensitive; an `@domain` entry covers that domain only, not its subdomains). The pilot owner's real email address (`PRODUCT.md §27`), set directly in the dashboard, **never** committed. Empty or unset: nobody may sign up | `@example.com`: every synthetic address may sign up, and the seeded `owner@example.com` exists (`ROADMAP.md` M2) | `production`: the owner, in the dashboard (`preserve()` in `.railway/railway.ts`). `development`: `.railway/railway.ts` (`@example.com`) |
| `POSTGRES_PASSWORD` | `postgres` | Random, generated by Railway | Random, **set by the owner** (see §3); every preview copies it | Railway / owner |
| `PGPASSWORD`, `DATABASE_URL`, other `PG*` | `postgres` | References to `POSTGRES_PASSWORD` etc. | Same | Railway |

Check that no environment has a template-text password, without printing values:

```bash
railway variable list --service postgres --environment development --json | jq '.POSTGRES_PASSWORD | test("secret\\(")'
```

It must print `false`.

Rules for the secrets that later enablers add (for example `BREVO_API_KEY` in E006 and `SENTRY_DSN` in E009):

- The enabler lists the variable **names** here and declares them in `.railway/railway.ts` with `preserve()`, so the file never contains a value.
- The **owner** sets the values in the dashboard or with `railway variable set`. Agents never handle secret values or read `.env*` files.
- `production` gets the real value. `development` gets a test key, a sandbox account or an empty value that turns the feature off. **Never copy a production value into `development`:** every preview inherits it. The one exception is the Sentry DSN (`SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`): a DSN can only send events, and previews must report to the same Sentry projects under their own environment (spec #32).

`BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` (F001, `ADR-007`) are declared in `.railway/railway.ts`; apply it to `development` and `production`, then set the secret in each (a different value per environment). `SIGN_UP_ALLOWED_EMAILS` (F001, spec #128) is declared there too: `@example.com` in `development` (and so every preview), `preserve()` in `production`, where the owner puts the pilot owner's address. What the list does, and what an address on it or off it gets, is in [`packages/auth/README.md`](../../packages/auth/README.md). A malformed entry (say `example.com` without the `@`, or a `*`) stops the web server at start-up with an error that names the entry's position, so the deploy fails its health check and a typo can't silently lock the pilot owner out or open sign-up.

**Client IP address (sign-in rate limits):** the per-IP limit of sign-in requests (F001 AC10) reads the address from the `X-Real-IP` header and nothing else. [Railway's docs](https://docs.railway.com/networking/public-networking/specs-and-limits) name `X-Real-IP` "for identifying client's remote IP" and say nothing more about it. That the edge proxy **overwrites** a value the client sent comes from Railway staff replies on their forum ([1](https://station.railway.com/questions/security-critical-questions-on-edge-prox-8fddd775), [2](https://station.railway.com/questions/need-authoritative-client-ip-proxy-tru-090eac86)), who also say it is not a versioned guarantee; it is **unverified here: check it on the PR preview** (send a forged `X-Real-IP`, see which bucket the request lands in) before relying on the limit. `X-Forwarded-For`, a header a client can fill in, is not used. It holds only for traffic through the public domain: a request over Railway's private network skips the proxy. If a CDN is ever put in front of Railway (the custom domain), check what `X-Real-IP` holds then; staff have reported it holding the CDN's address. A missing or invalid `X-Real-IP` (not an IP address, or several) is "no usable client IP". With `requireClientIp` such a request counts against one shared "unknown IP" bucket; without it (local, tests) it has no per-IP limit, only the per-address one. `requireClientIp` is an option of `createAuth` and defaults to `NODE_ENV=production`. That is every Railway environment, previews and `development` included, and e2e, where `next start` sets it. It is not the `production` environment, so never wire it to `isProductionEnvironment()`. Whoever sends the header picks the IP address, so e2e specs send their own `x-real-ip` to keep their buckets apart.

**Sign-in emails outside production:** mail to an `@example.com` address is not sent. The server writes it to its log, the code and the link included, so a preview can be signed in to without an inbox: open the `web` deployment logs in Railway and look for `[email] not sent, logged instead (sign-in)`. The seed (`development` and previews, never `production`) has the account `owner@example.com`. Production always sends through Brevo and never logs a code or a link.

The native apps aren't on Railway: their variables are build settings, per platform:

- **Android:** Gradle properties in `apps/android/gradle.properties`, or `-P` on the Gradle command line. `fivvi.sentryDsn` (debug builds): empty; set it only to test reporting by hand. `fivvi.releaseSentryDsn` (release builds): the DSN of the Sentry `android` project (EU region), set (#85); the build checks it is in the EU region ([Android README](../../apps/android/README.md)). What they do: [OBSERVABILITY.md](OBSERVABILITY.md) §1 "Android".
- **iOS:** build settings in `apps/ios/Config/*.xcconfig`. `FIVVI_SENTRY_DSN`: empty in `Debug.xcconfig`, always, so local builds, tests and CI send nothing (`pnpm test:ios` checks it); set it only in the git-ignored `Config/Local.xcconfig` to test reporting by hand. In `Release.xcconfig` it is the DSN of the Sentry `ios` project (EU region), committed (#85): a DSN only sends events and ships inside the app. `pnpm test:ios` checks it is in the EU region ([iOS README](../../apps/ios/README.md)). `FIVVI_SENTRY_ENVIRONMENT`: `development` (Debug), `production` (Release). What they do: [OBSERVABILITY.md](OBSERVABILITY.md) §1 "iOS".

## 8. Backups

Measured in the M1 spike (ADR-011, "M1 spike results"):

- **Hobby (now):** volume backups and scheduled backups are refused. Postgres **point-in-time recovery (PITR)** can be enabled; a restore to a point in time into a new service works (about 2 minutes for a small database).
- **Before real data (pilot setup, no later than G2):** enable PITR on production: `railway postgres pitr enable --service postgres --environment production`. Owner decision; it adds bucket storage cost.
- **At G4 (Pro):** enable daily backups and repeat the restore drill (E016).

Restore into a new service, then point `web` at it after checking the data:

```bash
railway postgres pitr restore --service postgres --environment production --at <RFC3339 time>
```

Disabling PITR leaves its bucket behind at project level; delete it in the dashboard.

## 9. Costs

Railway Hobby during the build, Pro from G4 (ADR-011). A spending alert is set in the workspace. An open preview costs about $0.5–0.8/month, mostly its Postgres; its `web` sleeps after 10 idle minutes and wakes in about a second. Close stale PRs. Measured costs are in ADR-011, "M1 spike results".
