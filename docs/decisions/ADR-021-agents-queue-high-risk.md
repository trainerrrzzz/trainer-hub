# ADR-021: Agents queue high-risk PRs before G2, except owner-only changes, and no fixed parallel limit

| | |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-10-24 |
| **Deciders** | Keyvan Mahmoudi (owner) |
| **Related** | Amends ADR-016 (decision 1, the merge gate's "low-risk" condition, and the parallel limit of three) and ADR-018 (decision 4, "a high-risk PR is refused"); ROADMAP.md §4.3, M4 (Gate G2); WORKFLOW.md §7; `docs/legal/verwerkersovereenkomst.md` measure T12 |

## Context

ADR-016 lets agents merge low-risk PRs; ADR-018 sends them through the merge queue. Every high-risk PR still waits for the owner to add it to the queue. On 24 October 2026 that was every PR of the factory: the whole of F001 (Authentication, #128) is labelled `owner-merge`, and so are the next approved specs (#168 native sign-in, #169 app distribution, #170–#172 workspaces, membership and roles). So the factory stopped after every ticket, and tickets blocked by an unmerged one waited overnight. The owner asked for the factory to run on its own until the morning.

What makes most of this safe now:

- **No real personal data in production until G2** (ADR-016 decision 6, `ROADMAP.md` M4). A bad merge to auth or tenant data costs a revert, not a data breach.
- **Every high-risk PR already passes the same bar as a low-risk one** before the owner looks at it: the five required CI checks, the `reviewer` (high tier) clean on both `code-review` axes on the head commit, the preview smoke check, no open threads, and the merge queue testing it on the latest `main`. In practice the owner added such PRs to the queue without changes.

What must not change:

- **Agents can never loosen their own rules.** A PR that changes the guardrails (the merge gate, the risk list, `AGENTS.md`, the agent definitions, the hooks) or the decisions and product rules agents follow still needs the owner.
- **Legal and money stay with the owner.** A change to `docs/legal` can change what was promised to customers; billing and payments move real money (ADR-020).
- Agents never approve PRs, merge outside `pr.sh merge`, use `--admin` or enable auto-merge (ADR-016, ADR-018).

## Decision

Until G2, agents add a high-risk PR to the merge queue with `scripts/pr.sh merge` when the whole merge gate holds, unless the PR is **owner-only**. Owner-only PRs keep going to the owner, as today.

1. **Two kinds of high-risk.** Every path group in `scripts/high-risk-paths.txt` is owner-only unless the file names it as agent-queueable. A new group is owner-only by default, so the safe side is the default. A path can match rules of several groups (`docs/decisions/ADR-007-authentication.md` is `auth` and `product-docs`); every matching group counts, and the path is owner-only when any of them is.
   - **Agent-queueable** groups: `auth`, `tenant-data`, `health-notes`, `dependencies`, `infrastructure` (`dependencies` includes the native manifests: `libs.versions.toml`, `gradle-wrapper.properties` and `Package.resolved`, at any depth).
   - **Owner-only** groups: `guardrails`, `legal`, `billing`, `product-docs` (product docs and ADRs). **The boundary of the guardrails:** guarded are the rules agents follow (`AGENTS.md`, `CLAUDE.md`, `CODING_STANDARDS.md`, `.agents/`, `.claude/`, `.codex/`, `.github/`, `.githooks/`, `scripts/`, `docs/agents/`, `WORKFLOW.md`, `TESTING.md`) and the files that define, configure or skip a check: the root `package.json` (so it is owner-only although other `package.json` files are dependencies), configs that a nested folder can override, the lint rules, the drift checks, the contrast check and the CLIs that pick the checks, and the Android and Maestro files that wire or select checks. Other source inside packages, test helpers included, stays low and is covered by review. `scripts/high-risk-paths.txt` is the one place to read or change the list, with the reason for each rule in its comments.
   - **Accepted as not owner-only, on purpose:** the glossaries and `DESIGN.md`, a nested `package.json` or the root `pnpm-workspace.yaml` (dependency changes an agent may queue), `packages/design-tokens/src/native.ts` (the folders the drift check compares), `packages/design-tokens/tokens/contrast-pairs.json` (the pairs the contrast check tests; it changes with the tokens), `packages/design-tokens/src/source.ts` (it holds `minimumRatio`, the WCAG minima, next to the token loading that every token change touches; moving them into the guarded `contrast.ts` would make the two import each other), and `apps/ios/FivviPro.xcodeproj/project.pbxproj`, which carries every ordinary project change (new files and targets) next to the test target membership; review covers it. The Xcode scheme `FivviPro.xcscheme` is guarded, since no ordinary work touches it.
   - The file declares the agent-queueable groups on lines of their own, `@agent-queue <group>`. A declared group with no path rule, or a line in any other shape, is an error (fail closed), like a malformed rule today.
2. **Labels.** `owner-merge` keeps its meaning of "high-risk" and becomes agent-queueable: a spec that touches auth, tenant data or health notes still gets it, so its PRs pass the full gate and are recorded as high-risk. A new label, `owner-only`, on an issue or its parent spec makes every PR of it owner-only. `issue.sh create spec` gets `--label owner-only`; a spec that touches legal, money or the agents' own rules gets `owner-only` instead of `owner-merge` (`docs/agents/issue-tracker.md`). Only the owner removes `owner-only`.
3. **`scripts/risk.sh`** reports three levels: `low`, `high` (only agent-queueable reasons) and `owner` (at least one owner-only reason), each with its reasons. `--json` prints `{risk, reasons}` with `risk` one of the three. The pure decision stays in `scripts/risk.jq`.
4. **The merge gate** (`scripts/merge-gate.jq`) changes its first condition from "low-risk" to "not owner-only": `low` and `high` pass, `owner` fails with its reasons. Every other condition of ADR-016 and ADR-018 stays as it is (checks passed on the head commit, both axes clean on it, preview smoke-checked, no open threads, ready for review, not removed by the queue). For a `high` PR, `pr.sh merge` also records `**High-risk agent merge:** <sha>: <reasons>` in the PR body before it queues, so the owner can read afterwards what an agent merged and why it counted as high-risk.
5. **Phases.** `flow.sh status` shows a `high` PR whose gate holds as `ready-to-merge`, like a low-risk one; `in-review` is for owner-only PRs. `flow.sh next` lists, under "For the owner to read", the high-risk PRs agents merged in the last 7 days, so the owner can review them after the fact.
6. **It ends at G2.** Before the first real personal data enters production (pilot setup, `ROADMAP.md` M4), the owner removes the `@agent-queue` lines (or decides otherwise in a new ADR). This is a G2 exit criterion. After that every high-risk PR goes to the owner again, as in ADR-016.
7. **The processor agreement** promises in measure T12 that the owner approves every merge of a high-risk change. Version 0.3 of `docs/legal/verwerkersovereenkomst.md` (24 October 2026) changes T12, in Dutch and English, to: before the pull request two agents review the change locally (coding standards and specification); the owner approves every merge of a change to the agent rules, legal matters or money; until real personal data is processed in production, other changes, including authentication, tenant data, health notes and dependencies, merge after the required CI checks, the two agent reviews and a check of the preview; from then on the owner approves every merge of those high-risk changes too. Approving the PR of this ADR approves that wording.

8. **No fixed limit of three tickets in progress.** ADR-016 kept the parallel limit at three, and `scripts/flow.sh start` refuses a fourth worktree. With high-risk PRs waiting for the owner, those three slots filled with PRs nobody could move, and ready tickets waited. `flow.sh start` no longer has a default limit; an optional `FIVVI_MAX_TICKETS` (a positive integer) sets one for a session that wants it, and `--force` stays for that case. The orchestrator still starts no more agents at once than the tool's rate limits allow, and two tickets that change the same files are still built one after the other. The merge queue's `max_entries_to_build` (ADR-018 decision 1) stays 3: it limits checks running at once, not tickets, and changing it is a ruleset change the owner applies.

Rollout: this ADR, the script changes and their tests, `AGENTS.md`, the `work` skill, `WORKFLOW.md`, the issue-tracker doc, `ROADMAP.md` (§4.3 and the G2 exit criterion) and the agreement are one PR. It is owner-only (`docs/decisions`, `scripts/`, `docs/legal`), so the owner merges it; agents can't approve their own wider rights. After the merge the owner runs `scripts/github-settings.sh apply`, which creates the `owner-only` label (`.github/repo-settings.json`); until then `issue.sh create --label owner-only` fails on GitHub and no issue can carry it.

## Consequences

- **Positive:** the factory runs approved specs to `main` overnight; the owner approves specs, reads the "For the owner to read" list and handles owner-only PRs. Ticket chains (F001 #131–#138) no longer wait a night per link.
- **Negative:**
  - Until G2 an agent can merge an auth, tenant-isolation or migration change the owner never saw. The mitigations are the gate, the high-tier review, the merge queue on the latest `main`, the audit record in the PR body and the after-the-fact list. A wrong migration has to be fixed forward, since production deploys `main` (ADR-011).
  - Paths still decide risk (ADR-016): a file outside the owner-only names that changes money or legal behaviour is not owner-only. Specs that touch legal or money therefore get `owner-only` when they are created.
  - The guardrail split is only as good as `scripts/high-risk-paths.txt`. Because it lives in `scripts/` (owner-only), agents can't move a group across.
  - What the scripts cannot enforce: `issue.sh label` refuses to remove `owner-only` and `owner-merge`, but a plain `gh issue edit --remove-label` is unguarded, and a PR that is not linked to its issue (no `Closes #<n>`) does not inherit the issue's `owner-only`. The "For the owner to read" list shows only high-risk PRs an agent merged, so an unlinked PR of an owner-only spec that touches only low-risk paths never appears in it: a known gap, which only the owner reading the merged PRs closes.
- **Follow-ups:**
  - Before G2: remove the `@agent-queue` lines (decision 6), together with the production-release approval of ADR-016 decision 6.
  - Consider renaming `owner-merge` to `high-risk` once the old meaning has faded.

## Alternatives considered

| Option | Why not (now) |
|---|---|
| Keep ADR-016 as it is | Every PR of every approved spec waits for the owner; the factory can't run overnight. |
| Agents queue every high-risk PR | Agents could merge a change to their own guardrails, to legal promises or to payment code. |
| Agents queue high-risk PRs after a second, independent review | Adds time for every PR; the `reviewer` already runs on the high tier on both axes, and the merge queue retests on `main`. Worth revisiting at G2. |
| Remove `owner-merge` from the specs | Loses the record that the work is high-risk and the audit trail; the label should describe risk, and the rule should decide who queues. |
| Make it permanent | After G2 production holds real names and health notes; a wrong merge could be a data breach, so the owner approves again. |
