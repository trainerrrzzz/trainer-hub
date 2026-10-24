# Feature Registry

The single source of truth for feature status. A status changes **in the same PR** as the code that earns it.

- **Lifecycle:** `IDEA → PLANNED → DESIGNED → IN PROGRESS → IN REVIEW → IMPLEMENTED → RELEASED` (`PRODUCT.md §81`)
- **Priority:** `Must` (MVP cannot ship without it) · `Should` (first to slip to 1.1 if dates are at risk) · `Must (proposed, decision 9)` (proposed M11 scope, `ROADMAP.md` decision 9: a `Must` only once the owner confirms it)
- **Languages:** a feature is not `IMPLEMENTED` until both NL and EN work (`PRODUCT.md §82`)
- **Platforms:** a feature with a trainer mobile surface (marked `+ iOS/Android` in the Milestone column) is not `IMPLEMENTED` until web, iOS and Android all work; its iOS and Android tickets sit next to the web ticket with the same acceptance criteria (`ROADMAP.md` M8, the native track). Client apps stay Release 1.2
- **Spec:** the *Spec* column points to the requirements in [`PRODUCT.md`](PRODUCT.md). Each feature's spec and tickets are GitHub issues (`/to-spec`, `/to-tickets`, [`docs/agents/issue-tracker.md`](../agents/issue-tracker.md)); once a spec issue exists, the ID links to it, e.g. `[F031](https://github.com/fivvi-app/fivvi/issues/<n>)`
- **Rows:** a stable summary and a Status. A ticket PR changes only its row's Status: the spec's first ticket sets `IN PROGRESS`, and the PR that completes the spec sets `IMPLEMENTED` and writes the final one-line summary. A spec's progress (what's open, what's next) lives in its tickets (`scripts/flow.sh status <spec>`), not in the row, so parallel PRs don't edit the same lines
- **Milestones:** see [`ROADMAP.md §5`](ROADMAP.md#5-mvp-delivery-plan-m1m11)

## Summary

| Release | Features | Released |
|---|---|---|
| MVP | 61 (F001–F061) + 19 engineering enablers (E001–E019); F017–F019 (more locations) and M7 (F039–F048, F051) come after go-live; trainer iOS and Android screens are built with their web features (the M8 native track) | 0 |

---

## MVP: user-facing features

### Foundation

| ID | Feature | Status | Priority | Milestone | Depends on | NL | EN | Spec |
|---|---|---|---|---|---|---|---|---|
| [F001](https://github.com/fivvi-app/fivvi/issues/128) | Authentication | PLANNED | Must | M2 (+ iOS/Android; native sign-in: separate spec) | E004, E006 | ⬜ | ⬜ | §2.4, §27 |
| F002 | Workspaces | PLANNED | Must | M2 | F001 | ⬜ | ⬜ | §5 |
| F003 | Workspace Membership | PLANNED | Must | M2 | F002 | ⬜ | ⬜ | §2.9, §6, §9 (team role next to client relationship) |
| F004 | Roles | PLANNED | Must | M2 | F003 | ⬜ | ⬜ | §9, §50 (Owner and Trainer; Admin is a later role 🔜) |
| F005 | Trainer Profile | PLANNED | Must | M2 (+ iOS/Android: profile) | F003 | ⬜ | ⬜ | §9 |
| F006 | Client Profile | PLANNED | Must | M2 (+ iOS/Android in M4) | F002 | ⬜ | ⬜ | §2.9, §9, §10, §34 (quick add, name only; links to an existing account) |
| F007 | Localization Infrastructure | PLANNED | Must | M1–M2 | E005 | ⬜ | ⬜ | §3, §73 |
| F008 | Dutch UI | PLANNED | Must | continuous | F007 | ⬜ | — | §2.2 |
| F009 | English UI | PLANNED | Must | continuous | F007 | — | ⬜ | §2.2 |
| F010 | Locale Preference | PLANNED | Must | M2 (+ iOS/Android) | F001, F007 | ⬜ | ⬜ | §3 |

### Trainers

| ID | Feature | Status | Priority | Milestone | Depends on | NL | EN | Spec |
|---|---|---|---|---|---|---|---|---|
| F011 | Trainer Invitations | PLANNED | Must | M3 | F003, F004, E006 | ⬜ | ⬜ | §49 |
| F012 | Multi-Workspace Trainer | PLANNED | Must | M3 (+ iOS/Android: workspace switch in the profile) | F003, F005 | ⬜ | ⬜ | §4, §6 |
| F013 | Personal Trainer Calendar | PLANNED | Must | M4 (+ iOS/Android) | F012, F020 | ⬜ | ⬜ | §45–§48, §78 (type labels and filters) |
| F014 | Workspace Calendar | PLANNED | Must | M4 | F020 | ⬜ | ⬜ | §45, §48, §78 (type and trainer filters) |

### Locations

| ID | Feature | Status | Priority | Milestone | Depends on | NL | EN | Spec |
|---|---|---|---|---|---|---|---|---|
| F015 | Locations | PLANNED | Must | M3 (one location; more after G4) (+ iOS/Android: shown) | F002 | ⬜ | ⬜ | §12 (go-live: one location per workspace; after go-live: more locations and the other types) |
| F016 | Organization Default Location | PLANNED | Must | M3 (+ iOS/Android: shown) | F015 | ⬜ | ⬜ | §13 (the workspace's one location) |
| F017 | Trainer Locations | PLANNED | Must | After G4, with M7 (+ iOS/Android) | F005, F015 | ⬜ | ⬜ | §13 |
| F018 | Client Preferred Location | PLANNED | Must | After G4, with M7 (+ iOS/Android) | F006, F015 | ⬜ | ⬜ | §14 |
| F019 | Automatic Location Selection | PLANNED | Must | After G4, with M7 (v1.19) (+ iOS/Android) | F016, F017, F018 | ⬜ | ⬜ | §2.6, §13 |

### Scheduling

| ID | Feature | Status | Priority | Milestone | Depends on | NL | EN | Spec |
|---|---|---|---|---|---|---|---|---|
| F020 | Private Sessions | PLANNED | Must | M4 (+ iOS/Android) | F005, F006, F015 | ⬜ | ⬜ | §17 |
| F021 | Group Class Templates | PLANNED | Must | M4 (+ iOS/Android: create a class) | F005, F015 | ⬜ | ⬜ | §15, §18, §19 |
| F022 | Recurring Classes | PLANNED | Must | M4 (+ iOS/Android: weekly repeat) | F021, E012 | ⬜ | ⬜ | §15, §20 |
| F023 | Trainer Assignment | PLANNED | Must | M4 (+ iOS/Android: double-booking check) | F020, F021 | ⬜ | ⬜ | §17, §19 |
| F024 | Trainer Substitution | PLANNED | Must | M4 | F022, F023 | ⬜ | ⬜ | §19 |
| F025 | Attendance | PLANNED | Must | M4 (+ iOS/Android) | F020, F022 | ⬜ | ⬜ | §43 |
| F026 | Cancellations | PLANNED | Must | M4 (+ iOS/Android: cancel a session) | F020, F022, F049 | ⬜ | ⬜ | §17, §43, §51 (records time and actor for the §93 cutoff) |

### Booking

| ID | Feature | Status | Priority | Milestone | Depends on | NL | EN | Spec |
|---|---|---|---|---|---|---|---|---|
| F027 | Public Booking Page | PLANNED | Must | M5 | F022, F007 | ⬜ | ⬜ | §15, §21 |
| F028 | Booking Capacity | PLANNED | Must | M5 (+ iOS/Android: add a participant) | F027 | ⬜ | ⬜ | §18 |
| F029 | Booking Hold | PLANNED | Must | M5 | F028, E012 | ⬜ | ⬜ | §24 |
| F030 | Magic-Link Verification | PLANNED | Must | M5 | F029, F049 | ⬜ | ⬜ | §23, §27 |
| F031 | Booking with Email Verification | PLANNED | Must | M5 | F030 | ⬜ | ⬜ | §25 |
| F032 | Client Account on First Booking | PLANNED | Must | M5 | F031, F001 | ⬜ | ⬜ | §2.4, §26 |
| F033 | Client Booking Dashboard | PLANNED | Must | M5 (+M11 commerce) | F031 | ⬜ | ⬜ | §15 (Client Web: my schedule with private + group) |

### Open Gym

| ID | Feature | Status | Priority | Milestone | Depends on | NL | EN | Spec |
|---|---|---|---|---|---|---|---|---|
| F034 | Open Gym Slots | PLANNED | Must | M6 (+ iOS/Android) | F015, F020 | ⬜ | ⬜ | §2.7, §15, §28 |
| F035 | Open Gym Public Booking | PLANNED | Must | M6 | F034, F027–F031 | ⬜ | ⬜ | §30 |
| F036 | Open Gym Suggestions | PLANNED | **Should** | M6 | F034, F013 | ⬜ | ⬜ | §29 |

### Sharing

| ID | Feature | Status | Priority | Milestone | Depends on | NL | EN | Spec |
|---|---|---|---|---|---|---|---|---|
| F037 | Booking Links | PLANNED | Must | M6 | F027, F035 | ⬜ | ⬜ | §32 |
| F038 | QR Codes | PLANNED | Must | M6 | F037 | ⬜ | ⬜ | §33 |

### Workouts

| ID | Feature | Status | Priority | Milestone | Depends on | NL | EN | Spec |
|---|---|---|---|---|---|---|---|---|
| F039 | Exercise Library | PLANNED | Must | M7, after G4 (+ iOS/Android) | F007 | ⬜ | ⬜ | §38 |
| F040 | Custom Exercises | PLANNED | Must | M7, after G4 (+ iOS/Android) | F039 | ⬜ | ⬜ | §38 |
| F041 | Workout Templates | PLANNED | Must | M7, after G4 (+ iOS/Android) | F039 | ⬜ | ⬜ | §39 (save a logged workout as template) |
| F042 | Client Workouts | PLANNED | Must | M7, after G4 (+ iOS/Android) | F041, F006 | ⬜ | ⬜ | §40 |
| F043 | Live Workout Logging | PLANNED | Must | M7, after G4 (+ iOS/Android) | F039, F020 | ⬜ | ⬜ | §41 (with or without a template) |
| F044 | Previous Workout Display | PLANNED | Must | M7, after G4 (+ iOS/Android) | F043 | ⬜ | ⬜ | §41 |
| F045 | Workout History | PLANNED | Must | M7, after G4 (+ iOS/Android) | F043 | ⬜ | ⬜ | §42, §37 (shared recap) |
| F051 | Repeat Previous Workout | PLANNED | Must | M7, after G4 (+ iOS/Android) | F043, F045 | ⬜ | ⬜ | §41 (moved from §54) |

### Notes

| ID | Feature | Status | Priority | Milestone | Depends on | NL | EN | Spec |
|---|---|---|---|---|---|---|---|---|
| F046 | Client Notes | PLANNED | Must | M7, after G4 (+ iOS/Android) | F006 | ⬜ | ⬜ | §35 |
| F047 | Session Notes | PLANNED | Must | M7, after G4 (+ iOS/Android) | F020 | ⬜ | ⬜ | §36–37 (internal note) |
| F048 | Note Visibility | PLANNED | Must | M7, after G4 (+ iOS/Android) | F046, F047 | ⬜ | ⬜ | §37, §79 (explicit client share) |

### Commerce

Added in roadmap v1.19 (M11), before go-live; credit packs and credit plans, group and private, followed in v1.21 (owner, 21 October 2026). The subscription model and invoices ship together. Single classes and payouts are proposed scope ([decision 9](ROADMAP.md#14-decisions)).

| ID | Feature | Status | Priority | Milestone | Depends on | NL | EN | Spec |
|---|---|---|---|---|---|---|---|---|
| F052 | Offers and Prices | PLANNED | Must | M11 | F002, E019 | ⬜ | ⬜ | §90 (three default plans, pre-filled and switched off until the owner turns them on; the owner adds the price; owner-made offers of the four kinds; rules around the defaults are proposals, QC19) |
| F053 | Memberships | PLANNED | Must | M11 | F052, F022, F028, F057 | ⬜ | ⬜ | §91 (fixed weekdays, term, terms stored) |
| F054 | Credit Packs and Plans (group and private) | PLANNED | Must | M11 | F052, F020, F028, F055, F057 | ⬜ | ⬜ | §92 (credit packs bought once; credit plans paid monthly, with a carry-over limit; group and private credits never mix) |
| F055 | Credit Balance | PLANNED | Must | M11 | F025, F026 | ⬜ | ⬜ | §92 (one balance per kind, group or private, per agreement; history: granted, used, returned, expired) |
| F056 | Cancellation Policy and Makeups | PLANNED | Must | M11 | F026, F055 | ⬜ | ⬜ | §93 (cutoff, late cancellation, makeups) |
| F057 | Recurring Payments | PLANNED | Must | M11 | E019, F059 | ⬜ | ⬜ | §94 (first payment + mandate, SEPA Direct Debit: proposal, QC06; exactly once) |
| F058 | Single Class Purchase | PLANNED | Must (proposed, decision 9) | M11 | F029, E019, F059 | ⬜ | ⬜ | §95 |
| F059 | Invoices and Billing Details | PLANNED | Must | M11 | F006, F052 | ⬜ | ⬜ | §96 (company details, gapless numbers, credit notes) |
| F060 | Failed Payments and Refunds | PLANNED | Must | M11 | F057, F059 | ⬜ | ⬜ | §94 |
| F061 | Payouts and Reconciliation | PLANNED | Must (proposed, decision 9) | M11 | F057, F060 | ⬜ | ⬜ | §97 |

### Notifications

| ID | Feature | Status | Priority | Milestone | Depends on | NL | EN | Spec |
|---|---|---|---|---|---|---|---|---|
| F049 | Localized Transactional Emails | PLANNED | Must | M1 (infra) → M5 | E006, F007 | ⬜ | ⬜ | §51, §74 (commerce emails in M11, EM-12 in M7) |
| F050 | Trainer Booking Notifications | PLANNED | Must | M5 | F049, F031 | ⬜ | ⬜ | §51 |

---

## MVP: engineering enablers

These are not user-facing, so they don't need NL/EN columns. They still go through the same branch/PR/cleanup workflow.

| ID | Enabler | Status | Milestone | Notes |
|---|---|---|---|---|
| E001 | Monorepo & tooling | IMPLEMENTED | M1 | pnpm workspaces + Turborepo (`lint`, `typecheck`, `test`, `build`, `format:check`), Node 26 + pnpm pinned, TypeScript 7 strict, Biome (lint + format); empty `apps/web` Next.js skeleton (React Server Components). `apps/ios` / `apps/android` and SwiftLint/ktlint come with E008 (ADR-001) |
| E002 | CI pipeline | IMPLEMENTED | M1 | GitHub Actions (`.github/workflows/ci.yml`) on every PR and push to `main`: one Linux job runs `turbo run lint typecheck test build format:check check` with pnpm and turbo caches; later static checks (i18n parity, OpenAPI drift) plug in as `check` tasks. Path-filtered native jobs `iOS` (macOS) and `Android` (Linux), real since E008 (paths in `WORKFLOW.md §7`). A ruleset on `main` enforces the required checks (`.github/rulesets/main.json`, applied by `scripts/github-settings.sh`, ADR-016) |
| E003 | Environments & deployment | IMPLEMENTED | M1 | Railway, EU West Amsterdam, managed by Railway Infrastructure as Code (`.railway/railway.ts`): `web` (Next.js standalone + API, Dockerfile, Wait for CI, health check `GET /api/v1/health` with DB ping), private-network Postgres, `cron` skeleton (`apps/cron`). Migrations (+ seed outside production) run as the pre-deploy step; the `hello` greeting is a data migration. `production` deploys `main`; `development` is the base of per-PR environments, so previews never get production secrets. ADR-011 conditions 1–2 checked (M1 spike results: restore works on Hobby, scheduled backups need Pro). See `docs/engineering/ENVIRONMENTS.md` (ADR-011) |
| E004 | Database, ORM & migrations | IMPLEMENTED | M1 | `packages/database`: Drizzle ORM (`node-postgres`), versioned SQL migrations (`db:generate` / `db:migrate`, schema drift check), idempotent seed, typed client from `DATABASE_URL` (sessions in UTC); Postgres 18 in `compose.yaml` (same major as Railway); `system_greetings` table for the M1 hello slice; conventions in the package README; `test:integration` turbo task (migrate → seed → read on real Postgres). RLS comes with E011 (ADR-005, ADR-006) |
| E005 | i18n package, native export & guardrails | IMPLEMENTED | M1 | `packages/i18n`: nl-NL + en ICU catalogs with typed keys, exporters → `.xcstrings` / `strings.xml` + plurals (committed in `generated/`), `pnpm check` (key + placeholder parity, ICU subset, generated files up to date), next-intl in `apps/web` (nl-NL default, en formatted as en-GB), Biome no-hard-coded-JSX-text plugin, `GLOSSARY.md` (ADR-008). Native no-literal-string rules (SwiftLint/ktlint) and wiring the generated catalogs into the apps come with E008 |
| E006 | Email infrastructure | IMPLEMENTED | M1 | `packages/email`: React Email templates localized from `packages/i18n` (`email.*` keys, skipped by the native exporters), `sendEmail` with a Brevo transport (transactional API, idempotency key), inline retry with backoff (ADR-010) and an in-memory capture transport for tests; sender from config; `pnpm email:preview` and `pnpm email:send-test`; Brevo free tier, DPA, EU storage, tracking and log retention checked (`docs/legal/sub-processors.md §4`). G1 delivery check: NL + EN test emails in the Gmail inbox, not spam (2026-10-03). Open: second mailbox check; domain + SPF/DKIM/DMARC before M5; ask Brevo support to disable transactional tracking before G2 (ADR-009) |
| [E007](https://github.com/fivvi-app/fivvi/issues/33) | Design tokens & UI foundation | IMPLEMENTED | M1 | `packages/design-tokens`: Style Dictionary v4 (DTCG) source from the M0 draft, light and dark; generates web CSS variables, Tailwind v4 theme and shadcn theme variables, a SwiftPM package (adaptive colours, Dynamic Type styles) and Kotlin (Material 3 light/dark schemes, shapes); `pnpm check` fails on stale outputs and on contrast pairs below WCAG AA. `packages/ui`: standard shadcn kit (Button, Input, Label, Card) themed only by tokens, Tailwind's default palette removed, 3:1 focus outline, compact/touch densities per layout, self-hosted Bricolage Grotesque display font; a `check` rejects raw colours in web source. Web follows the system light/dark setting. Native wiring is E008 (ADR-015) |
| [E008](https://github.com/fivvi-app/fivvi/issues/34) | Native app shells | IMPLEMENTED | M1 | iOS (Swift + SwiftUI, iOS 17+, `apps/ios`) and Android (Kotlin + Compose, API 26+, `apps/android`) shells with the generated API client and the generated string catalogs (ADR-003): a hello screen that gets the greeting key from `GET /api/v1/hello` (read from `system_greetings`) and shows it in the interface language chosen by ADR-017's rule, mirroring the shared resolver in `packages/i18n`; themed from the design tokens in light and dark; SwiftLint and ktlint reject literal text and colour literals; unit and UI tests in nl and en (`pnpm test:ios`, `pnpm test:android`), the shared Maestro flow (`pnpm test:maestro`) and the `iOS` and `Android` CI jobs; checked on the owner's iPhone and Android phone against production in Dutch and English (#59) |
| [E009](https://github.com/fivvi-app/fivvi/issues/32) | Observability | IMPLEMENTED | M1 | `packages/observability`, the only TypeScript code that imports Sentry or PostHog (ADR-013): Sentry (EU, Frankfurt) error reporting for the API, the cron job and the web app (server and browser), tagged with environment and release, scrubbed by an allowlist before sending, with private source maps; typed server product events from a versioned catalog and cookieless page views to PostHog EU Cloud (host from `POSTHOG_HOST`, production only); Sentry crash reporting with crash-free sessions in the iOS and Android apps, scrubbed by the same rules, release builds only. Off without a DSN or key (local, tests, CI). UptimeRobot monitors on production's health check and home page; Sentry and PostHog set to free-tier limits, DPAs signed, legal docs aligned. See `docs/engineering/OBSERVABILITY.md` |
| E010 | Test infrastructure | IMPLEMENTED | M1 | `packages/testing`: shared Vitest presets (`unitConfig` / `integrationConfig`, `*.integration.test.ts`, `TZ=UTC`, no retries), database isolation (template database migrated once per run → clone per test file → `withRollback` per test; commit-needing tests get their own database), clock and Europe/Amsterdam DST helpers. CI runs `test:integration` against a Postgres 18 service in `Checks (Linux)`, and Playwright in a new `E2E (Linux)` job: every spec in nl-NL and en with automatic axe (WCAG 2.2 AA) checks, Chromium cached. Commands in `TESTING.md §7.1`. XCTest/XCUITest, JUnit + Compose UI tests and Maestro are specified for E008 in `TESTING.md §7.2` (ADR-014) |
| E011 | Tenant isolation suite & RLS | PLANNED | M2 | Cross-tenant tests in CI (ADR-006) |
| E012 | Scheduled jobs | PLANNED | M4 | Daily cron: recurrence materialization, hold cleanup, retention; holds expire lazily (ADR-010) |
| E013 | Public surface security | PLANNED | M5 | Rate limits, hold caps, Cloudflare Turnstile, headers |
| E014 | Privacy tooling | PLANNED | M9 | Data export, deletion, retention jobs, note-access audit log (§79) |
| E015 | Data import tooling | PLANNED | M9 | Pilot data from the old app export or a CSV template → clients, timetable, sessions, active agreements, credit balances, next due dates, billing details; reconciliation report |
| E016 | Backups, restore drill & runbooks | PLANNED | M9 | A verified restore, incident/rollback runbooks |
| E017 | App distribution | IN PROGRESS | M2 | Existing Apple company membership (owner-reported): verify access; confirm Play Console account or enroll; set up TestFlight and Play internal testing early (M2), so the internal alpha runs on the apps; app IDs `app.fivvi.pro` (Fivvi Pro, the trainer and owner app) and `app.fivvi` (the client app, Release 1.2), and check that the store names are available; store requirements follow before the first public listing |
| E018 | API contract & client generation | IMPLEMENTED | M1 | `packages/api`: Hono + zod-openapi, mounted in `apps/web` under `/api`; `GET /api/v1/hello` reads `system_greetings` (#93). `packages/contract`: committed `openapi.json` (3.1) → TS (openapi-typescript + openapi-fetch), Swift (swift-openapi-generator), Kotlin (openapi-generator, retrofit2 + kotlinx.serialization); generators pinned. Drift check: `pnpm check` (Turborepo `check` task); E002 makes it a required CI check (ADR-004) |
| E019 | Payment provider integration | PLANNED | M11 | ADR-020 (Accepted 21 October 2026: Mollie Connect for Platforms, the gym as merchant on its own Mollie account; Stripe Connect as fallback) and the questions for Mollie it lists; one guided connection step for the Owner (Mollie Client Links), test mode for previews, idempotent requests, stored webhook events processed once, replay tests |

---

## Post-MVP backlog (IDEA)

These get `F0xx` IDs when they move to `PLANNED`. Full context is in [`ROADMAP.md §9`](ROADMAP.md#9-post-mvp-roadmap-11--70).

| Release | Candidate items |
|---|---|
| 1.1 | Waitlists · recurring private appointments · schedule exceptions · holidays · blocked time · workout duplication · warm-up sets · supersets · workout reordering · pinned notes · note search · offline resilience · bulk attendance · *session reminder emails (suggested)* · *read-only ICS calendar feed (suggested)* · *Universal Links / App Links (suggested)* |
| 1.2 | Native client iOS/Android apps · push (APNs + FCM) · email → app deep links |
| 1.3 | AI note capture (NL/EN, speech + text, trainer confirms) |
| 1.4 | AI pre-session client briefing |
| 2.0 | Self-serve signup · persona onboarding · marketing site · help center · *platform billing (decision pending)* |
| 2.1 | Freelance improvements · gym access information |
| 2.2 | Workspace switching · cross-workspace conflict detection · workspace-specific permissions |
| 2.3 | Multi-location organizations |
| 4.0 | Advanced commerce: discounts · gift cards · reminders and dunning · POS/kiosk · accounting integrations · revenue reports |
| 3.0 – 3.2, 5.0 – 7.0 | See roadmap themes |
