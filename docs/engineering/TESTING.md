# Testing Strategy

How we test Fivvi so that AI agents and humans can change it often without breaking it. The tools are fixed by ADR-014 (`ROADMAP.md §4`). This document covers **what** to test, **where**, **how**, and **what blocks a merge**. It applies to every PR.

## 1. Principles

1. **Tests ship with the change.** A PR that adds or changes behaviour includes the tests for it. "Tests later" does not exist, just like "translate later".
2. **Acceptance criteria become tests.** Every acceptance criterion in a spec issue maps to at least one automated test (§6). If a criterion can't be automated, the spec says why and how it is checked by hand.
3. **Bug fix = failing test first.** Reproduce the bug in a test, see it fail, then fix it. The test stays as a regression guard.
4. **Test at the lowest layer that can prove the rule.** Business rules live in `packages/domain`, so most tests live there too. E2E tests prove that the pieces are wired together; they don't re-test every rule.
5. **Real Postgres, not mocks, for data.** RLS, constraints, transactions and locks are part of our correctness. Mock only at system boundaries (§5.4).
6. **Deterministic or it doesn't count.** No real clock, no real network, no `sleep`. A flaky test is a bug (§8).
7. **Never weaken a test to get green.** Don't delete, skip or loosen assertions, and don't update snapshots without reading the diff. If a test is wrong, fix it in the PR and explain why in the description.

## 2. Test layers

| Layer | Tool | Lives in | Proves | Speed |
|---|---|---|---|---|
| **Domain unit** | Vitest | `packages/domain/**/*.test.ts` (next to the code) | Business rules: recurrence, capacity, holds, permissions matrix, time and locale formatting | ms, no I/O |
| **API integration** | Vitest + real Postgres | `packages/api/test/**/*.integration.test.ts` | Routes end to end in-process: validation, auth, roles, tenant scoping, RLS, transactions, migrations, response matches the OpenAPI schema | seconds |
| **Tenant isolation suite** (E011) | Vitest + real Postgres | `packages/api/test/isolation/*.integration.test.ts` | Workspace A can never read or write workspace B's data, through **any** route (§4.1) | seconds |
| **Email** | Vitest | `packages/email/**/*.test.ts` | Every template renders in nl-NL and en with no missing keys; links and dates are correct | ms |
| **Web component** | Vitest + Testing Library | `apps/web/**/*.test.tsx` | Only for components with real logic (forms, pickers, stateful widgets). Not for static markup | ms |
| **Web e2e** | Playwright | `apps/web/e2e/*.spec.ts` | Critical user flows in a real browser, **in NL and EN**, with axe accessibility checks; mobile viewport for public pages | minutes |
| **iOS unit** | XCTest | `apps/ios/FivviProTests/` | View models, state handling, API-client mapping, error states | seconds |
| **iOS UI** | XCUITest | `apps/ios/FivviProUITests/` | A few platform-specific flows Maestro can't cover | minutes |
| **Android unit** | JUnit | `apps/android/app/src/test/` | View models, state handling, API-client mapping, error states | seconds |
| **Android UI** | Compose UI tests | `apps/android/app/src/androidTest/` | Screen states and interactions | minutes |
| **Mobile e2e** | Maestro | `e2e/maestro/` | **The same flow YAML on iOS and Android**, in both locales. This is the parity acceptance test (M8, the native track: run per milestone from M2) | minutes |
| **Static checks** | CI (E002, E005, E018) | — | Lint, typecheck, i18n parity, ICU syntax, no hard-coded strings, OpenAPI drift, generated clients up to date | seconds |

The file name picks the suite: `*.test.ts(x)` is a unit test (`pnpm test`, no database), `*.integration.test.ts` an integration test (`pnpm test:integration`, real Postgres), and `apps/web/e2e/*.spec.ts` a Playwright spec (`pnpm test:e2e`). The shared Vitest presets in `packages/testing` (`unitConfig`, `integrationConfig`) apply this split, run tests with `TZ=UTC`, restore mocks, stubbed env and globals after every test, and turn retries off.

Rough shape: many domain tests, a solid layer of API integration tests, a small number of e2e flows. If an e2e test is the only thing catching a rule, add a lower-level test for that rule.

## 3. What to test, by type of change

Use this as the checklist when writing and reviewing a PR.

| Change | Required tests |
|---|---|
| New or changed **business rule** | Domain unit tests, including edge cases and invalid input |
| New or changed **API route** | Integration test: happy path, validation error, **every role** (Owner / Trainer / Client / anonymous) allowed or denied as specified, response matches the schema. The isolation suite picks the route up automatically (§4.1) |
| **Schema / migration** | Migrations apply to an empty DB and on top of the previous version; RLS policy exists for every new business table (a test checks this) |
| **Scheduling, time, recurrence** | DST fixtures (§4.3); times near midnight in Europe/Amsterdam |
| **Booking, capacity, holds** | Concurrency test (§4.2); hold expiry; cancellation frees the spot |
| **Tokens** (magic link, 6-digit code, invitations) | Single use, expiry, stored hashed, rate limit, wrong-workspace rejection |
| **Notes / health data** | Roles that must not see notes get a denial, and no note content leaks into lists, emails, logs or error messages |
| **User-facing web flow** | Playwright e2e in NL **and** EN for the flow's main path |
| **Mobile feature** | Unit tests on **both** iOS and Android for the view model, plus a Maestro flow (both locales) for the main path |
| **Strings** | Covered by CI checks; no extra test unless the string has plural or date logic |
| **Email template** | Render test in both locales |
| **Bug fix** | A regression test that fails without the fix, at the lowest layer that reproduces it |
| **Refactor, no behaviour change** | Existing tests stay green, unchanged. If you have to change tests, it wasn't a pure refactor |

## 4. High-risk areas

These are the bugs that hurt most (`ROADMAP.md §13`: R2, R3, R4). They get dedicated, always-on tests.

### 4.1 Tenant isolation (R4)

- The suite **enumerates every route from `openapi.json`**. For each route that touches a business record it creates data in workspace A and calls the route as a user of workspace B. Expected result: `404` (never `403`, so we don't reveal the record exists) and no data from A in the response.
- A new route without an isolation case fails CI. Public routes are listed explicitly in an allow-list, which is reviewed in the PR.
- A second set of tests runs queries directly against Postgres with a workspace-scoped role to prove RLS blocks cross-tenant reads **even if the data-access layer has a bug**.

### 4.2 Overbooking (R3)

- Fire N parallel booking requests (separate DB connections) at an occurrence with 1 spot left. Exactly one succeeds; the others get a "full" result; the database agrees.
- The same for holds: an active hold counts against capacity; an expired hold does not.

### 4.3 Time and daylight saving (R2)

- Fixed fixtures for the **last Sunday of March and October** in Europe/Amsterdam: "every Tuesday 18:00" stays 18:00 local on both sides of the change.
- Times between 00:00 and 02:00 local, which fall on the previous day in UTC.
- Rendering: nl-NL `22 september 2026`, `18:00`; en uses the English format, same timezone.

## 5. Conventions

### 5.1 Naming and traceability

- Group tests by feature ID and name them after the behaviour, not the function:
  `describe('F029 booking hold')` → `it('releases the spot when the hold expires')`
- Tests that cover an acceptance criterion reference it: `it('AC2: client receives the confirmation email in their locale')`. A reviewer can then check the spec issue against the test list.
- Native: the same idea in XCTest/JUnit method names, e.g. `test_F043_AC1_logsSetWhileOffline`.

### 5.2 Test data

- **Factories, not fixtures files.** Shared builders will live in `packages/testing` once the first business tables exist (M2), e.g. `createWorkspace()`, `createTrainer(ws)`, `createClass(ws, { capacity: 1 })`. They create valid records with sensible defaults, so a test only states what matters to it.
- **Every test creates its own workspace.** Tests never depend on each other's data or on order, and they can run in parallel. This also exercises tenant scoping by default.
- **Seed data is for local development and the e2e baseline only.** Tests don't modify shared seed data.
- **No real personal data**, ever. Use obviously fake names and `@example.com` addresses.

### 5.3 Database

- Local: Postgres in Docker (`pnpm db:up`, same major version as production). CI: a `postgres:18-alpine` service container in `Checks (Linux)` and in `E2E (Linux)`, where the e2e servers create their own databases. Never run tests against the Railway production or preview databases: the helpers refuse any server that isn't on `localhost`.
- Tests never share data. `@fivvi/testing/database` isolates them at three levels:

| Level | How | Helper |
|---|---|---|
| **Run** | The package's Vitest global setup creates a **template database** and applies the migrations once. Nobody may connect to it afterwards. Teardown drops the template and every database the run created | `setupTemplateDatabase(migrate)` from `@fivvi/testing/database/setup`, in `test/global-setup.ts` |
| **Test file** | `beforeAll` clones the template into the file's own database (`CREATE DATABASE … TEMPLATE`, milliseconds, no migrations), `afterAll` drops it. Files run in parallel on different workers without seeing each other | `cloneTemplateDatabase()` |
| **Test** | The test body runs in one transaction that is **always rolled back**, so every test starts from the migrated, empty state | `withRollback(db, async (tx) => …)` |

- **Transaction rollback is the default** for API integration tests and the E011 isolation suite. It fits the RLS model: the per-request context (`SET LOCAL ROLE`, `set_config('app.organization_id', …, true)`) is transaction-local, so a test sets it inside `withRollback` and it disappears with the rollback. For this to work, code under test takes the executor it runs on (`DatabaseExecutor`: the database or a transaction) instead of opening its own pool, and the in-process API gets its executor injected per request.
- **Commit instead** when rollback can't prove the behaviour: concurrency tests with separate connections (§4.2), anything a second connection must see, deferred constraints (checked only at commit), `now()` differences (it is the transaction's start time inside one transaction), and migrations. Such a test creates its own database, `cloneTemplateDatabase()` (migrated) or `createTestDatabase()` (empty, for migration tests), and drops it in `finally`.
- **Rejected: a schema per worker.** RLS policies, grants and the migrator's `drizzle` schema are schema-qualified, so `search_path` tricks would test a different setup than production. A database clone keeps the real schema names and is just as fast.
- **Roles are per server, not per database** (E011): create the app role and the migration role idempotently in the global setup, before the template is migrated; a clone doesn't copy them.
- Concurrency tests use real, separate connections and are allowed to be slower.

### 5.4 Time, locale and external services

- **Clock:** domain code gets "now" from an injected `Clock` (`{ now(): Date }`), never `Date.now()` / `Date()` / `new Date()` directly. Tests use a fixed clock. The test process runs with `TZ=UTC` so the machine's timezone never leaks in. `@fivvi/testing/clock` has the helpers:
  - `fixedClock(instant)`, `manualClock(start)` with `advance({ hours: 25 })`, and `freezeSystemTime(instant)` for code that can't take a clock (it restores the real clock after the test);
  - `zonedTime('2026-03-31T18:00')` turns Europe/Amsterdam wall-clock time into an instant, and `wallTime(instant)` goes back. A time in the skipped or repeated DST hour throws unless the test passes `disambiguation` (`earlier`, `later`, `compatible`), so no test picks one by accident;
  - `dstTransitions(2026)` gives the §4.3 fixtures from the time zone database: the instant, local date, offsets and the skipped/repeated hour of the March and October changes.
- **Locale-independent selectors:** e2e and UI tests find elements by role + accessible name from the catalog, or by test ID / accessibility identifier, so **the same test runs in both locales**. Assert on visible text only where the text is the point, and read it from `packages/i18n`, never hard-code Dutch or English in a test.
- **Mock only at boundaries:** email provider (a capture transport that records to, locale, subject and links), Cloudflare Turnstile (official test keys), Sentry/PostHog (disabled without a DSN or key; to check what would be sent, use the capture transport of `packages/observability`, or for page views `scrubPageView()` and an e2e test that intercepts the PostHog host, [OBSERVABILITY.md](OBSERVABILITY.md) §5.2), the clock. Don't mock the database, the domain package or our own API.
- **No network** in unit and integration tests. E2E hits only our own local stack.

### 5.5 Coverage

- Coverage is reported on every PR, but **the checklist in §3 is the real bar**, not a number.
- One hard gate: `packages/domain` line coverage must not drop below **90%**. That package is small, pure and where the rules live, so it is cheap to keep high.

## 6. Test plan in the spec issue

Every spec issue (`docs/agents/issue-tracker.md`) has a **Test plan** in its *Testing Decisions*, written **before** implementation, at the seams `/to-spec` agreed with the owner. It lists each acceptance criterion with the layer(s) that prove it:

| AC | Layer | Test |
|---|---|---|
| AC1 (NL/EN) | Playwright | `apps/web/e2e/booking.spec.ts` → `AC1: client books a class` |
| AC2 | API integration | `packages/api/test/bookings.test.ts` → `AC2: rejects booking when full` |
| AC3 | Domain unit | `packages/domain/booking/hold.test.ts` → `AC3: hold expires after 10 minutes` |

The reviewer checks this table against the code.

## 7. Where tests run

| When | What runs |
|---|---|
| **Locally, before opening a PR** | Everything for the areas you touched. Agents paste the commands and results in the PR description. Mobile changes: build and run the unit tests and the affected Maestro flows on both platforms locally |
| **Every PR (Linux, required)** | `Checks (Linux)`: static checks, domain unit, API integration, isolation suite, email, web component. `E2E (Linux)`: Playwright (NL + EN) |
| **PR touching the Android app or its inputs (Linux, required when triggered)** | `Android`: `pnpm test:android`, then `pnpm test:maestro` (§7.1). Path-filtered; the paths are in `WORKFLOW.md §7` |
| **PR touching the iOS app or its inputs (macOS, required when triggered)** | `iOS`: `pnpm test:ios` (§7.1). Path-filtered to save macOS minutes (ROADMAP §12); the paths are in `WORKFLOW.md §7` |
| **PR touching mobile apps, contract or strings** | Maestro flows on the platforms affected. If CI minutes run short, Maestro runs locally and nightly instead; the PR description must say it ran |
| **Before a TestFlight / Play internal build** | Full suite on both platforms, both locales |

**Budget:** keep the required Linux checks under ~10 minutes. If they get slower, speed them up (parallelise, move logic tests down a layer), don't drop them.

### 7.1 Commands

Run from the repo root. Turbo runs the task in every package that has it; add `--filter <package>` to run one package, e.g. `pnpm test --filter @fivvi/database`.

| Command | Runs | Needs |
|---|---|---|
| `scripts/check.sh` | Everything below plus repo hygiene (shellcheck, version pinned in `scripts/_shellcheck.sh`; vendored skills, commit messages, commit emails, file emails, doc links); `--fast` skips integration and e2e. At the end it prints the tests each suite passed, failed and skipped and writes them to `.work/check-summary.json` (git-ignored); native iOS and Android counts are not in it, `check.sh` doesn't run them. The contract check runs only when the branch touches `packages/api` or `packages/contract`; CI runs it whenever turbo has no cached result for its inputs. The pre-PR gate | `scripts/bootstrap.sh` once; `--api` for API changes (Java, Swift) |
| `pnpm test` | Every unit suite (`*.test.ts(x)`) | Nothing |
| `pnpm test:integration` | Every integration suite (`*.integration.test.ts`) against real Postgres | `pnpm db:up`, and `TEST_DATABASE_URL` set to it (below) |
| `pnpm test:e2e` | Builds `apps/web`, starts it on port 3100 (`E2E_PORT`), and a second time with a synthetic PostHog key on `E2E_PORT + 1000` for the page view tests, each on a fresh migrated database of its own (`fivvi_test_e2e_<port>`, `apps/web/e2e/serve.ts`), and runs every Playwright spec in **nl-NL and en** with axe | `pnpm db:up` (or `TEST_DATABASE_URL`); Chromium, once: `pnpm --filter @fivvi/web exec playwright install chromium --only-shell` |
| `pnpm test:android` | `scripts/android.sh test`: ktlint with the literal-text, colour and Sentry rules, the release Sentry DSN (EU region), build, Android unit tests (nl-NL and en), Compose UI tests on an emulator (booted when none is connected). What CI's `Android` job runs | `scripts/bootstrap.sh --mobile` once |
| `pnpm test:maestro` | `scripts/maestro.sh android`: Postgres (migrated, seeded) and the web server on `E2E_PORT`, warmed up with `GET /api/v1/hello` in both locales, the debug app on the emulator, every flow in `e2e/maestro/` with the emulator in **nl-NL and en**, each once Android has settled after the language change | Docker, `scripts/bootstrap.sh --mobile` once |
| `scripts/maestro.sh ios` | The same flows on the iPhone simulator (local only), after the same warm-up | Docker, `scripts/bootstrap.sh --mobile` once |
| `pnpm lint`, `pnpm typecheck`, `pnpm check`, `pnpm format:check` | Static checks (§2) | Nothing |
| `pnpm test:ios` | What the `iOS` CI job runs: SwiftLint with the literal-text, colour and Sentry rules, the build configurations (Debug sends nothing to Sentry; Release's DSN is in the EU region; Info.plists in Xcode's form), the Swift package allowlist (no analytics SDK), that Xcode's string catalog sync leaves the generated catalogs unchanged, that every UI test runs in at least one test-plan configuration, then the iOS unit and UI tests in **nl and en** on a simulator, in one run ([`apps/ios/README.md`](../../apps/ios/README.md#tests)): the text-dependent UI tests in both locales, the locale-independent ones in nl only | `scripts/bootstrap.sh --mobile` |

```bash
pnpm db:up
export TEST_DATABASE_URL=postgres://trainer_hub:trainer_hub@localhost:5432/trainer_hub
pnpm test:integration
```

`TEST_DATABASE_URL` falls back to `DATABASE_URL`; `packages/database` also reads either from its git-ignored `.env`. Without one, integration tests fail with a message instead of being skipped. Tests only create and drop their own `fivvi_test_*` databases, so they don't disturb the dev database on the same server.

Inside a package, `pnpm exec vitest` watches unit tests, `pnpm exec vitest --config vitest.integration.config.ts` integration tests, and in `apps/web`, `pnpm exec playwright test --ui` debugs e2e specs (after `pnpm build` and `pnpm db:up`). Playwright writes `playwright-report/` and `test-results/` (git-ignored); CI uploads them when `E2E (Linux)` fails.

**Writing a Playwright spec:** import `test` and `expect` from `apps/web/e2e/fixtures.ts`. Each spec runs once per locale project (`nl-NL`, `en`); the browser language is set to the project's locale. The `messages` fixture is that locale's catalog, `otherLocale` the other one, for switching. Every test ends with an automatic axe check (WCAG 2.2 A and AA) on the page it left open; call `expectNoAxeViolations(page, 'the open dialog')` for states in between.

**Sign-in specs and the rate limits (F001 AC10, from #134):** sign-in requests are limited per IP address and per email address, so a spec that signs in uses its own `x-real-ip` and its own email address, never one shared with another spec, locale or retry. Which header, the limits and why: [ENVIRONMENTS.md §7](ENVIRONMENTS.md#7-variables) and the [auth README](../../packages/auth/README.md) (both once #134 lands).

### 7.2 Native tests (E008)

How to run them, per app:

- iOS: [`apps/ios/README.md`](../../apps/ios/README.md#tests).
- Android and Maestro: [`apps/android/README.md`](../../apps/android/README.md).

| Suite | Location | What it is |
|---|---|---|
| **iOS unit** (XCTest) | `apps/ios/FivviProTests/` | The unit test target in the Xcode project. The shared scheme's **test plan** (`apps/ios/FivviPro.xctestplan`) has two configurations, `nl` / region `NL` and `en` / `GB`, time zone `Europe/Amsterdam`; the unit tests run in both. View models run against a stub of the generated client's `APIProtocol` |
| **iOS UI** (XCUITest) | `apps/ios/FivviProUITests/` | The UI test target in the same scheme and test plan. Find elements by `accessibilityIdentifier`, never by visible text. The app runs against a stub HTTP server in the test runner, so tests assert the requested `locale` too. The text-dependent tests (greeting, error and loading text, display name) run in both configurations; the locale-independent ones run in `nl` only. Which ones and why: [`apps/ios/README.md`](../../apps/ios/README.md#tests) ("Which tests run in which locale"); `pnpm test:ios` fails if a UI test would run in no configuration |
| **Android unit** (JUnit) | `apps/android/app/src/test/` | JUnit dependencies in the app module; run with `./gradlew testDebugUnitTest`. Locale-dependent tests run for `nl-NL` and `en` (parameterised) |
| **Android UI** (Compose UI tests) | `apps/android/app/src/androidTest/` | `androidx.compose.ui:ui-test-junit4` and the `testInstrumentationRunner`; run with `./gradlew connectedDebugAndroidTest` on an emulator. Find nodes by `testTag`, never by visible text |
| **Mobile e2e** (Maestro) | `e2e/maestro/` at the repo root, one flow per feature (`<feature>.yaml`) plus a shared `config.yaml` | The **same flow file** runs on both apps: the apps use the same `accessibilityIdentifier` / `testTag` for the same element, and one bundle/application id per platform goes in the flow's `env`. Each flow runs once per locale, by setting the device or simulator language before launch |

Also for E008:

- **Scripts** so every suite starts the same way, each wrapping the native commands above (listed in §7.1):
  - iOS: `pnpm test:ios`. A worktree tests on its own simulator, `Fivvi <worktree folder>`: a copy of the newest iPhone, created on first use and deleted by `scripts/flow.sh finish`. The main checkout and CI use the newest iPhone; `IOS_SIMULATOR="iPhone 17"` picks one by name. When the run ends (passed, failed or Ctrl-C) it shuts down the simulator it booted; one that was already booted stays booted. `KEEP_DEVICE=1` leaves it running, for fast repeated runs. It builds once and runs nl and en in one `test-without-building` run (one result bundle, the simulator prepared once) on one simulator, also on CI (two simulators were slower on the 3-core runner; `IOS_PARALLEL=1` runs one run per locale at the same time on two, the second deleted afterwards), and prints its step durations, the build timing and the slowest tests per locale.
  - Android: `pnpm test:android`. When the run ends (passed, failed or Ctrl-C) it kills the emulator it started, never one that was already running, and stops this checkout's Gradle daemons. `KEEP_DEVICE=1` leaves both running, for fast repeated runs.
  - Maestro: `pnpm test:maestro`. It uses and cleans up the emulator and the Gradle daemons like `pnpm test:android`, `KEEP_DEVICE=1` included.
  - Maestro on iOS: `scripts/maestro.sh ios`. It uses and cleans up the simulator like `pnpm test:ios`, `KEEP_DEVICE=1` included.
  - A real iPhone, by hand: `scripts/ios-device.sh [nl|en]` builds, installs and launches the Debug app, signed through the git-ignored `Config/Local.xcconfig` ([`apps/ios/README.md`](../../apps/ios/README.md#a-real-iphone)).
- **CI** (the jobs are in `WORKFLOW.md §7`):
  - iOS: the `iOS` job runs `pnpm test:ios`'s script.
  - Android: the `Android` job runs `pnpm test:android`, then `pnpm test:maestro`.
  - Maestro: runs in CI on Android only, to save macOS minutes; on iOS it runs locally with `scripts/maestro.sh ios`.
- **Selectors:** assert on visible text only where the text is the point, and read the expected copy from the generated catalogs, like the web does (§5.4).

## 8. Flaky tests

- A flaky test is a bug with a priority, not noise. Fix the cause (usually a race, a real clock or shared data).
- CI retries are off for unit and integration tests. Playwright and Maestro may retry once, and a test that only passes on retry is reported as flaky.
- Quarantine (skip) is allowed only with a linked issue, an owner and a date, for at most one week. Never quarantine tenant isolation, concurrency or permission tests: fix them or revert the change that broke them.

## 9. Agent workflow

1. Read the spec issue and your ticket. The spec's **Test plan** (§6) says which tests prove each AC; update it in the spec if the plan has to change.
2. Build with `/tdd`: write the failing test for the next vertical slice, make it pass, refactor (red-green-refactor). Bugs go through `/diagnosing-bugs`, which starts from a failing regression test.
3. Run `scripts/check.sh` (every suite, with a per-worktree `E2E_PORT`); `scripts/pr.sh create` runs it again before a PR's first push, and `--fast` on follow-up pushes (`WORKFLOW.md §3`).
4. **Review locally before pushing** (`/code-review`, standards and spec axes): do the tests actually assert the acceptance criteria, cover the roles and both locales, and would they fail if the feature broke? No agent review runs in GitHub. A test that can't fail is worse than no test.
5. Never mark a feature `IMPLEMENTED` in `FEATURES.md` while its Test plan has gaps.
