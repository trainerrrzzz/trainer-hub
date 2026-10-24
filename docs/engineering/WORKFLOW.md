# Engineering Workflow

How every change gets from idea to `main`, and how we clean up afterwards. It applies equally to every AI coding agent (GitHub Copilot, Claude Code, Codex) and to humans.

## 1. Golden rules

1. **Never commit directly to `main`.** `main` is always deployable.
2. **One change = one branch = one worktree.** No exceptions, including docs and small fixes.
3. **Clean up when the change is merged.** A finished change leaves no worktree, no branch and no running process behind.
4. **Both languages, every platform the feature touches, or it isn't done.** See the Definition of Done (§6).

## 2. Branch naming

| Type | Pattern | Example |
|---|---|---|
| Ticket of a feature (`[F0xx]`) | `feature/<issue>-<slug>` | `feature/57-hold-a-spot` |
| Bug | `fix/<issue>-<slug>` | `fix/63-hold-expiry-race` |
| Ticket of an enabler (`[E0xx]`), tooling | `chore/<issue>-<slug>` or `chore/<slug>` | `chore/71-ci-cache` |
| Docs | `docs/<slug>` | `docs/roadmap` |

`scripts/flow.sh start <n>` picks the name from the issue; `scripts/wt.sh add` refuses anything else.

- **Spec issue title:** `[F031] Open Gym public booking`; ticket titles `[F031] <slice>` (`docs/agents/issue-tracker.md`)
- **PR title:** the ticket's title, `[F031] Hold a spot during verification` (`pr.sh create` sets it)
- **Commits:** Conventional Commits with the ID as scope, e.g. `feat(F031): hold a spot during verification` (the `.githooks/commit-msg` hook checks it, and that author, committer and `Co-authored-by` are GitHub noreply addresses)

## 3. Lifecycle of a change

We follow [Matt Pocock's skills](https://github.com/mattpocock/skills). The owner only talks; the `work` skill (`.agents/skills/work/SKILL.md`) routes each step to Matt's skills and our scripts. `scripts/flow.sh status <n>` tells it where an issue is and what comes next, so a fresh session can always pick up.

| Step | Skill | Script | Result | Who decides |
|---|---|---|---|---|
| 1. Align | `grill-with-docs` | | Shared understanding; `GLOSSARY.md` and ADR proposals updated | Owner answers |
| 2. Spec | `to-spec` | `issue.sh create spec` | Spec issue `[F0xx] …`: ACs (NL/EN), Test plan, platforms, languages | Owner reviews on GitHub and approves with the `spec-approved` label |
| 3. Tickets | `to-tickets` | `issue.sh create ticket --parent --blocked-by` | Tracer-bullet sub-issues with blocking edges, `ready-for-agent` | Agents, only for an approved spec |
| 4. Build | `implement` (`tdd`) in a fresh mid-tier `builder` subagent, then `code-review` in a fresh high-tier `reviewer`, by `docs/agents/build.md` | `flow.sh start`, `check.sh` | One ticket per worktree, no fixed limit in parallel (ADR-021), test-first, reviewed by the `reviewer` | Agents |
| 5. Ship | `pr` | `pr.sh create`, `reviewed`, `ship` (`wait`, `smoke`, `ready`), `merge` | One draft → ready PR per ticket that `Closes #<n>`, CI green, self-review and preview smoke check recorded for the head commit, added to the merge queue, squash-merged by GitHub | Agents queue low-risk PRs, and until G2 high-risk ones that are not owner-only, through the merge gate; the owner queues owner-only ones (§4) |
| 6. Clean up | | `flow.sh finish` | No worktree or branch left; the spec's next ready tickets | Agent |

Tickets that aren't agent-ready and bugs go through `triage`; bugs also through `diagnosing-bugs` (failing test first). `implement-spec` (one integration branch for a whole spec) stays available when the owner asks for it.

- Every branch has its own worktree in `.worktrees/` (git-ignored); `scripts/wt.sh add` creates it, installs dependencies and `packages/database/.env`. `scripts/check.sh` gives each worktree its own `E2E_PORT` (3200–3899), because Playwright reuses a server already running on its port. The page view tests use a second server on `E2E_PORT + 1000`, outside that range.
- If an agent tool already isolates its session in a worktree of its own (for example a Copilot or Claude Code background session), work there instead of creating a second one, with a branch named as in §2 (`git branch -m <name>`).
- **Local checks before a push** (`pr.sh create`): the first push of a branch (no PR yet) runs the full `scripts/check.sh`, including integration and e2e. A follow-up push (review fixes, merges of `main`; the PR exists) runs `check.sh --fast`: lint, types, unit and static checks. `pr.sh create` prints which mode ran and why; `--full` forces the full run, for example after a change to the schema or to a user flow. CI is still the full gate on every commit, and the merge gate (§4) requires its checks on the head commit, so `--fast` only moves the slow suites from your machine to CI.
- The spec's **Test plan** is written before implementing (`TESTING.md §6`).
- A ticket PR changes only its feature's `FEATURES.md` Status: the spec's first ticket sets `IN PROGRESS`, the PR that completes the spec `IMPLEMENTED` with the final one-line summary, and the others leave the file alone (`flow.sh` prints the hint). Progress lives in the spec's tickets, not in the row. The feature's ID links the spec issue.
- An API change regenerates `packages/contract` (OpenAPI + TS/Swift/Kotlin clients) in the same PR. A string change edits only `packages/i18n/*.json` and regenerates the native catalogs in the same PR.
- Every PR that touches a Railway watch pattern gets a preview (its own migrated and seeded Postgres); `pr.sh smoke` checks it and records the result in the PR description; a preview Railway skipped (after a failed first CI run, "Wait for CI") is redeployed with the `railway` CLI, in `fivvi-pr-<n>` only. Merging to `main` deploys production ([`ENVIRONMENTS.md`](ENVIRONMENTS.md)).
- Merge strategy: **squash merge** into `main`, the only method the repo allows, through the **merge queue** (§7): GitHub tests the PR on top of the latest `main` and merges it when the required CI checks pass, so nobody updates a branch by hand. Who adds a PR to the queue depends on its risk (§4).

## 4. Working with AI agents

- **One agent per worktree.** Two agents never share a worktree or a branch.
- **Parallel work:** no fixed limit on the tickets in progress ([ADR-021](../decisions/ADR-021-agents-queue-high-risk.md)). An optional `FIVVI_MAX_TICKETS` (a positive integer; anything else is an error) makes `flow.sh start` refuse a ticket beyond that many, and `--force` overrides it. The orchestrator starts no more agents at once than the tool's rate limits allow, and two tickets that change the same files are built one after the other, to limit merge conflicts. The merge queue's `max_entries_to_build` (3) limits checks running at once, not tickets.
- **Agent instructions live in one place.** `AGENTS.md` holds the rules for every agent; `CLAUDE.md` only imports it. Area rules live in `.github/instructions/*.instructions.md`: Copilot attaches them by path (`applyTo`), other agents read the one for the area they change.
- **Skills.** `.agents/skills/` holds our `work` skill and Matt Pocock's skills, vendored by `scripts/skills.sh` at the commit pinned in `.agents/skills.yaml` (each has a `.upstream` marker; MIT licence in `.agents/LICENSE.mattpocock-skills`). We add no agents or skills of our own that do what one of Matt's does; repo specifics go in `docs/agents/` (`build.md` for building and review). Never edit a vendored skill (the edit guard and `pnpm check` catch it): adapt behaviour in `AGENTS.md` or `docs/agents/`. To take Matt's latest version, run `scripts/skills.sh update` on a `chore/` branch and review the diff like code. Copilot and Codex read `.agents/skills/`; Claude Code reads it through the `.claude/skills` symlink.
- **Model tiers.** Shaping and every code review run on the high tier, building on the mid tier, mechanical work on the small tier; the model of each tier per tool is in `docs/agents/build.md` (**Tiers**). `.agents/agents/` defines the `builder`, `reviewer` and `mechanic` once (`tiers.json` holds the models); `scripts/agents.sh` generates `.claude/agents/`, `.github/agents/` and `.codex/agents/`, and `scripts/check.sh` fails when they differ or an agent has no tier. For Codex, see `docs/agents/codex-model-tiers.md`.
- **Scripts first.** Repetitive steps are scripts in `scripts/` (`AGENTS.md`); agents call them instead of doing the steps by hand. `scripts/bootstrap.sh` installs what they need.
- **Edit guard.** `.claude/settings.json` registers a `PreToolUse` hook, [`.claude/hooks/guard-edits.mjs`](../../.claude/hooks/guard-edits.mjs), that Claude Code and Copilot (CLI and Copilot sessions in VS Code) both run before every file edit. It denies edits in a checkout on `main` (git-ignored files such as `.env` stay editable), hand-edits of generated files (`openapi.json` and the generated clients in `packages/contract`, `packages/i18n/generated/`, the web, Swift and Kotlin outputs of `packages/design-tokens`, `packages/database/migrations/meta/`) and of vendored skills and of the generated agent definitions (`.claude/agents/`, `.github/agents/`, `.codex/agents/`). It covers the agents' edit tools, not shell commands, and only runs in folders the tool trusts. Codex and the VS Code Local agent don't run it. Its tests run in `pnpm test`.
- **Local review:** before the PR, the high-tier `reviewer` runs `code-review` on the diff on two axes in parallel subagents, one against `CODING_STANDARDS.md`, one against the ticket and spec (`docs/agents/build.md`). A `builder` fixes the findings on the branch, at most two rounds, ending with a review-only round. When the `reviewer` calls both axes clean, `pr.sh reviewed` records it in the PR body for the head commit; any later push makes the record stale, so review again.
- **Spec approval:** the owner approves a spec with the `spec-approved` label. Only then are its tickets cut and built (`flow.sh` reports `needs-approval` before). A material change to an approved spec removes the label (`issue.sh update`, unless `--minor` for a typo fix), so the owner approves again.
- **Who merges** ([ADR-016](../decisions/ADR-016-agent-merges.md), amended by [ADR-021](../decisions/ADR-021-agents-queue-high-risk.md)): `scripts/risk.sh` classifies each PR from its changed paths (`scripts/high-risk-paths.txt`) and the `owner-merge` and `owner-only` labels on its issue or spec into three levels: `low`; `high`, with only agent-queueable reasons (the path groups the file declares with `@agent-queue`: auth, tenant data, health notes, dependencies, infrastructure; and the `owner-merge` label); and `owner`, with at least one owner-only reason (any other path group: guardrails, legal, billing, product docs and ADRs; the `owner-only` label). Until G2 agents add a low-risk or a high-risk PR to the merge queue with `pr.sh merge` ([ADR-018](../decisions/ADR-018-merge-queue.md)) only when every condition holds: not owner-only, every check passed on the head commit, both `code-review` axes clean on it, `pr.sh smoke` recorded for the head commit that the preview passed or that there is none, no unresolved threads, ready for review, and the merge queue has not removed that commit ("not removed from the queue"). There is no "up to date with `main`" condition: the queue tests every PR on the latest `main`. For a high-risk PR, `pr.sh merge` first records `**High-risk agent merge:**` with the commit and the reasons in the PR body, and `flow.sh next` lists the high-risk PRs agents merged in the last 7 days under "For the owner to read". `pr.sh merge` records the queued commit in the PR body, never uses `--auto` or `--admin`, and leaves the branch alone (deleting the head branch of a queued PR closes it); GitHub squash-merges the PR when the checks pass on the combined commit, and `flow.sh finish` cleans up afterwards. If the gate refuses, it queues nothing, records the refusal and its reasons in the PR body for the head commit, and the PR waits for the owner, as every owner-only PR does (the owner adds it to the queue); agents don't retry it on that commit, and a new push makes the refusal stale. If the queue removes the PR (the combined commit failed a check or timed out), `flow.sh status` shows `queue-removed` with the reason and `flow.sh next` lists it for the owner; the gate refuses that commit ("not removed from the queue"). An agent fixes a cause in the PR and pushes, otherwise the owner decides. Until G2 an agent merge is also a production release; from G2 the owner approves production releases separately and removes the `@agent-queue` lines, so every high-risk PR goes to the owner again (`ROADMAP.md` M4). The processor agreement (`docs/legal/verwerkersovereenkomst.md`, measure T12) says the same.
- **Run the factory:** when the owner says so, the `work` skill builds, ships and merges every ready ticket, as many at a time as the tool's rate limits allow, until only owner items are left: specs to approve, owner-only PRs, refused PRs, PRs the merge queue removed, `needs-info` questions (`flow.sh next`). A PR in the queue waits on GitHub, not on the owner. This runs locally; running it unattended in GitHub Actions is a later decision.
- **No agent review in GitHub CI/CD:** do not add Copilot code review, Claude or Codex review jobs, bot PR reviewers, required agent-review status checks or required cross-agent approvals. GitHub CI is for deterministic checks such as tests, lint, generated-file drift and security scans.
- **Small PRs:** one ticket per PR. A spec that touches backend + iOS + Android heavily gets a contract ticket that blocks the platform tickets.
- **No silent contract breaks:** after a contract freeze (end of M4, end of M7), API changes are additive only.
- **Agents never** approve a PR, push to `main`, force-push shared branches, merge outside `pr.sh merge`, commit secrets, or edit generated files by hand.

## 5. Cleanup checklist (after merge)

`scripts/flow.sh finish <n>`, from the **main checkout**, checks that the PR is merged and the local branch holds nothing more, then removes the worktree, the local and remote branch and the ticket's notes, updates `main`, closes the issue if the PR didn't, and reports what the spec needs next.

Also make sure that:

- [ ] Dev servers, watchers, simulators/emulators and Docker containers started for this change are stopped.
- [ ] Temporary files, scratch scripts and debug output are deleted (never committed).
- [ ] Scratch Railway services or environments created for the change are deleted ([`ENVIRONMENTS.md`](ENVIRONMENTS.md)); the PR environment is deleted automatically on merge.
- [ ] When the last ticket of a spec is merged: `FEATURES.md` shows `IMPLEMENTED` with the final one-line summary, and the spec issue is closed (`flow.sh status <spec>` says `complete`, then `done`).

## 6. Definition of Done

From `PRODUCT.md §86`, extended for native apps. A user-facing feature is **not done** unless:

- [ ] Web behaviour works where required
- [ ] iOS **and** Android behaviour works where required (parity: same screens and states on both)
- [ ] Permissions are correct (Owner / Trainer / Client)
- [ ] Tenant isolation holds (covered by the isolation suite)
- [ ] Dutch UI exists and has passed the local copy review against `packages/i18n/GLOSSARY.md`
- [ ] English UI exists
- [ ] Dates/times localize correctly (nl-NL: `22 september 2026`, `18:00`, Europe/Amsterdam)
- [ ] Relevant emails exist in nl-NL and en
- [ ] No hard-coded user-facing strings (CI enforced)
- [ ] Generated contract and string catalogs are up to date (CI enforced)
- [ ] Tests cover the acceptance criteria per the spec issue's Test plan and the checklist in [`TESTING.md §3`](TESTING.md) (e2e runs in both locales for user flows)
- [ ] Review by the `reviewer` (`code-review`, both axes) completed and findings fixed (`CODING_STANDARDS.md`)
- [ ] Spec issue up to date with what was built (ACs, languages, platforms)
- [ ] Feature registry status updated
- [ ] Acceptance criteria pass
- [ ] Cleanup (§5) completed after merge

## 7. CI and required checks

CI is GitHub Actions ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)). It runs on every pull request, every push to `main`, every merge group of the merge queue (`merge_group`, `checks_requested`) and on demand (`workflow_dispatch`). A new push to a PR cancels that PR's previous run; runs on `main` and of merge groups are never cancelled.

| Check (job name) | Runner | Runs when | What it does |
|---|---|---|---|
| `Detect changes` | Linux | Always | Works out which native jobs need to run ([`scripts/native-jobs.sh`](../../scripts/native-jobs.sh)). Required because a skipped job counts as passed: if this job broke, the native jobs would pass without running |
| `Checks (Linux)` | Linux | Always | `pnpm install`, then one `turbo run lint typecheck test test:integration build format:check check` with the turbo cache. Integration tests run against a Postgres 18 service container (`TEST_DATABASE_URL`). The contract drift check is cached like the other tasks, so it only runs when the API, a generator or the generated clients change; its generator tools are cached per version ([`packages/contract/README.md`](../../packages/contract/README.md#drift-check)) |
| `E2E (Linux)` | Linux | Always | Builds `apps/web` and runs the Playwright specs in nl-NL and en with axe checks (`turbo run test:e2e`). Each e2e server runs on its own migrated database on a Postgres 18 service container (`TEST_DATABASE_URL`). Chromium is cached per Playwright version; the report is uploaded when the job fails |
| `iOS` | macOS | See "Native jobs" below | `pnpm test:ios`'s script on `macos-26` with Xcode 26.6 ([`apps/ios/README.md`](../../apps/ios/README.md#tests)): SwiftLint, the configuration checks (one `-showBuildSettings` call, on the cached Swift packages), one `build-for-testing`, then the unit and UI tests in nl and en without building again, in one `test-without-building` run on one simulator (two simulators were slower on the 3-core runner; `IOS_PARALLEL=1` runs one run per locale at the same time). The text-dependent UI tests run in both locales, the locale-independent ones in nl only ([`apps/ios/README.md`](../../apps/ios/README.md#tests)). One job rather than a matrix per locale, so the check keeps its name and both locales share the build. DerivedData and the Swift packages are cached by `Package.resolved`, the Xcode version and the runner OS. Prints the build timing summary and the slowest tests; uploads the test results (one bundle with both locales) when it fails |
| `Android` | Linux | See "Native jobs" below | Frees disk space for the emulator, then `pnpm test:android` (ktlint with the literal-text and colour rules, build, unit tests, Compose UI tests on a KVM emulator), then `pnpm test:maestro` (Postgres, migrate, seed, the web server and the Maestro flows in nl-NL and en) ([`apps/android/README.md`](../../apps/android/README.md)). The emulator boots from a cached snapshot of the AVD (keyed by system image, emulator and settings), or cold when there is none or it doesn't load. Reports and the emulator log are uploaded on every run, also after a cancel |

**Required checks on `main`:** all five jobs above, enforced by the ruleset in [`.github/rulesets/main.json`](../../.github/rulesets/main.json). It also requires a PR and the merge queue, and blocks force-pushes and deletion; it no longer requires an up-to-date branch, which the queue replaces. The repo allows squash merges only ([`.github/repo-settings.json`](../../.github/repo-settings.json)). `scripts/github-settings.sh apply` applies both, and can be run again at any time. Renaming a job renames its check, so change this table and the ruleset in the same PR and apply it after the merge (a test compares the ruleset with `ci.yml`).

**Merge queue** ([ADR-018](../decisions/ADR-018-merge-queue.md)): when a PR is added to the queue, GitHub builds a temporary branch `gh-readonly-queue/main/pr-<n>-<sha>` with the PR on top of the latest `main`, and starts `ci.yml` on it with the `merge_group` event. The five required checks must report on that commit, or the queue times out and removes the PR; that is why `ci.yml` has the `merge_group` trigger. The ruleset (`merge_queue` rule) sets squash, `ALLGREEN` (every queued PR's commit must pass, not only the last), one PR per merge, up to three builds at once, and a check timeout of 60 minutes: more than `Detect changes` (5) plus the longest job timeout (`Android`, 45). A cold `iOS` run takes about 25 minutes (its job times out at 30), the longest a PR waits in the queue. `Detect changes` compares the merge group with the event's `base_sha`, so the native jobs still run only when native paths changed (see "Native jobs"). A PR is added with `scripts/pr.sh merge` (low-risk, and until G2 high-risk that is not owner-only; agents) or the "Merge when ready" button (the owner); never with auto-merge or the admin bypass. Railway deploys `main` only ("Wait for CI", [`ENVIRONMENTS.md`](ENVIRONMENTS.md)), so the temporary branches deploy nothing.

**Adding a check:** a new deterministic check (i18n parity, ICU syntax, OpenAPI drift, generated files up to date, …) is a `check` script in the package that owns it. `turbo run check` in `Checks (Linux)` picks it up, so the workflow file doesn't change. Keep `Checks (Linux)` under ~10 minutes (`TESTING.md §7`).

**Releases:** a build for testers is a separate, hand-started run in the protected `release` environment, which the owner approves and which only deploys from `main`; it is not part of CI. See [`RELEASE.md`](RELEASE.md).

**Native jobs:** `iOS` and `Android` run in a PR, a merge group or a push to `main` that touches the app, its generated inputs (client, string catalogs, design tokens) or its own scripts, the exact paths being those in [`scripts/native-jobs.sh`](../../scripts/native-jobs.sh), and only when `apps/ios` or `apps/android` exists. A skipped job counts as passed. Shared files (`.github/workflows/ci.yml`, `scripts/_lib.sh`) don't run them on their own. A push to `main` or a merge group that touches none of those paths skips them (a merge group is compared with the queue's base commit, so a native change in any queued PR runs them). The `run-native` label belongs to the PR's own run; the merge group runs a native job only when a native path changed. To run them anyway, add the `run-native` label to the PR before you push (CI reads it on the PR's pushes; re-running a job doesn't pick up a label added later), or run `gh workflow run CI --ref <branch>`. Each runs the same `pnpm test:*` scripts as locally, so a green job means the same as a green local run. The caches (the iOS build, the Android AVD) belong to the PR that created them or to `main`; the pushes to `main` that change native paths write the `main` caches every PR can read, so a PR's first run is warm once `main` has run its paths. The cache action never overwrites an existing key: when a cached AVD snapshot stops loading, the job falls back to a cold boot but the fresh snapshot isn't saved under the same key, so bump the `v1` in the AVD cache key in `ci.yml` to rebuild it. The Android job stops the emulator with `scripts/android.sh stop`, which waits for it to exit before the AVD cache is saved. Both jobs end with their step durations in the job summary ([`scripts/step-timings.sh`](../../scripts/step-timings.sh)); the iOS job adds the build timing and the slowest tests, the Android job the emulator boot time.
