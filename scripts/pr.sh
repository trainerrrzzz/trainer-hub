#!/usr/bin/env bash
# Pull requests for the current worktree's branch. Run inside the worktree.
#
#   pr.sh check                                   run scripts/check.sh (create runs it too)
#   pr.sh create [--title <t>] [--body-file <f|->] [--ready] [--full] [--no-check]
#                                                 check, push, then open a draft PR (or update the open one, changing only
#                                                 what you pass); a new PR's title defaults to the issue title, its body
#                                                 gets "Closes #<issue>". The first push runs the full scripts/check.sh;
#                                                 a follow-up push (the PR exists) runs check.sh --fast, as CI runs the
#                                                 full gate on every commit; --full forces the full run
#   pr.sh ready                                   mark the draft ready for review, only when for the head commit every
#                                                 CI check passed (the merge gate's rule), the clean review is recorded
#                                                 (pr.sh reviewed) and so is the smoke check (pr.sh smoke); else names
#                                                 what is missing
#   pr.sh ship [--timeout <minutes>]              wait, smoke and ready in order, stopping at the first failure with its
#                                                 exit code; records nothing itself (run pr.sh reviewed before it); then
#                                                 prints the step durations of the native jobs (iOS, Android) that ran
#   pr.sh status                                  state, review, checks and open threads
#   pr.sh wait [--timeout <minutes>]              wait for CI: exit 0 passed, 1 failed, 2 still running at the timeout
#                                                 (default 20 minutes, 45 once an iOS or Android check exists)
#   pr.sh threads                                 open review threads with their ids
#   pr.sh reply <thread-id> (--body <md>|--body-file <f|->) [--resolve]
#   pr.sh smoke [--timeout <minutes>]             smoke-check the Railway preview and record the result for the PR's head
#                                                 commit in the PR body; the head has a preview when Railway's
#                                                 `<project> - web` status on it is not a skipped deploy (preview_of). A
#                                                 preview without a deployment of the head commit (Railway skipped it after
#                                                 a failed first CI run) is redeployed with the railway CLI, only in the
#                                                 PR's own environment, <project>-pr-<n>. Without
#                                                 the CLI, a preview whose status is success is only
#                                                 health-checked; otherwise smoke fails with a hint
#   pr.sh reviewed                                record in the PR body that both reviewers (standards and spec) found
#                                                 nothing to fix on the PR's head commit; local HEAD must be that commit
#   pr.sh merge                                   add a low-risk or high-risk (agent-queueable) PR to the merge queue
#                                                 (ADR-018, ADR-021), which squash-merges it after testing it on the
#                                                 latest main, only when every condition of the merge gate holds
#                                                 (ADR-016); a high-risk PR is first recorded in the PR body with its
#                                                 reasons; an owner-only PR is never queued; otherwise queue
#                                                 nothing, record the refusal for the head commit in the PR body, print
#                                                 why and exit 1: the PR stays for the owner. Never --auto or --admin;
#                                                 the queued commit is recorded in the PR body
#   pr.sh refusal <pr>                            the last refusal recorded in the PR body as {sha, reasons}, or null
#   pr.sh queue <pr>                              the merge queue state as {state, position, reason}: state is "queued",
#                                                 "removed" (GitHub took the PR out of the queue, reason says why, and no
#                                                 commit was pushed after that) or null
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

usage() { usage_of "$0"; }

need_cmd gh
need_cmd jq
REPO="$(repo_slug)"
OWNER="${REPO%%/*}"
NAME="${REPO#*/}"
BRANCH="$(git branch --show-current)"
# The records pr.sh writes in the PR body (read back by scripts/records.jq); scripts/merge-gate.jq gets the marks from
# here, and scripts/flow.sh reads refusals with pr.sh refusal.
SMOKE_MARK="Railway preview smoke check"
REVIEW_MARK="Self-review"
REFUSAL_MARK="Merge gate"
NO_PREVIEW="no preview for this PR"
# Railway: the project (named fivvi), the web service of its preview, and the only environments pr.sh smoke may touch,
# `<project>-pr-<n>` (preview_env). Railway names the commit status of the web preview `<project> - <service>`.
RAILWAY_PROJECT_ID="5ac2d844-191a-4671-9632-50b66817f648"
RAILWAY_PROJECT_NAME="fivvi"
RAILWAY_SERVICE="web"
# Railway's commit status for the web preview, and how its description starts when Railway skipped the deploy because
# the PR touches no watch pattern (the status is then green, but there is no preview).
PREVIEW_CHECK="$RAILWAY_PROJECT_NAME - $RAILWAY_SERVICE"
PREVIEW_SKIPPED="No deployment needed"
# How long wait waits for CI, in minutes: the cold iOS run took 24.5 min, so the jobs of the native apps get longer.
WAIT_MINUTES=20
WAIT_MINUTES_NATIVE=45
NATIVE_JOBS=(iOS Android)

open_pr() { gh pr list --repo "$REPO" --head "$BRANCH" --state open --json number --jq '.[0].number // empty'; }
current_pr() {
  local pr
  pr="$(open_pr)"
  [ -n "$pr" ] || die "no open PR for branch '$BRANCH' — run scripts/pr.sh create"
  echo "$pr"
}

# run_check [--fast] [<why>]: scripts/check.sh in the given mode, announcing which mode ran and why.
run_check() {
  local flag="" mode=full
  if [ "${1:-}" = --fast ]; then flag=--fast; mode=fast; shift; fi
  echo "🔎 ${mode} checks${1:+: $1}"
  (cd "$(git rev-parse --show-toplevel)" && scripts/check.sh ${flag:+"$flag"}) || die "checks failed — fix them before opening or updating a PR"
}

cmd_check() {
  [ $# -eq 0 ] || usage
  run_check "scripts/check.sh"
}

cmd_create() {
  local title="" body="" body_set=false draft=true check=true full=false issue existing
  while [ $# -gt 0 ]; do
    case "$1" in
      --title) title="${2:?}"; shift ;;
      --body-file) body="$(read_body "${2:?}")"; body_set=true; shift ;;
      --ready) draft=false ;;
      --full) full=true ;;
      --no-check) check=false ;;
      *) usage ;;
    esac
    shift
  done

  [ "$BRANCH" != "$(default_branch)" ] || die "on the default branch — work in a worktree (scripts/flow.sh start or scripts/wt.sh add)"
  is_branch_name "$BRANCH" || die "branch '$BRANCH' must be <type>/<issue>-<slug> or <type>/<slug>"
  [ -z "$(git status --porcelain)" ] || die "uncommitted changes"
  issue="$(branch_issue "$BRANCH")"
  existing="$(open_pr)"
  if [ -z "$title" ] && [ -z "$existing" ]; then
    [ -n "$issue" ] || die "branch has no issue number: pass --title"
    title="$(gh issue view "$issue" --repo "$REPO" --json title --jq .title)"
  fi
  if [ -n "$issue" ] && ! grep -qiE "^(closes|fixes|resolves) #$issue([^0-9]|$)" <<<"$body"; then
    body="${body:+$body$'\n\n'}Closes #$issue"
  fi

  if $check; then
    if $full; then run_check "--full"
    elif [ -z "$existing" ]; then run_check "first push of the branch"
    else run_check --fast "follow-up push to PR #$existing; CI runs the full gate (integration, e2e) on this commit; --full runs it here too"
    fi
  fi
  local out
  out="$(git push --quiet -u origin HEAD 2>&1)" || { echo "$out" >&2; die "push failed"; }

  if [ -n "$existing" ]; then
    local args=()
    [ -z "$title" ] || args+=(--title "$title")
    ! $body_set || args+=(--body "$body")
    [ "${#args[@]}" -eq 0 ] || gh pr edit "$existing" --repo "$REPO" "${args[@]}" >/dev/null
    echo "↻ pushed to PR #$existing: $(gh pr view "$existing" --repo "$REPO" --json url --jq .url)"
    return
  fi
  local args=(--repo "$REPO" --base "$(default_branch)" --head "$BRANCH" --title "$title" --body "$body")
  ! $draft || args+=(--draft)
  echo "✅ PR $(gh pr create "${args[@]}") ($($draft && echo draft || echo ready))"
}

# Conditions of the merge gate that must hold before a draft is published (decided by scripts/merge-gate.jq, so there is
# one rule): the checks passed on the head commit, the clean review and the smoke check are recorded for it.
READY_CONDITIONS=("checks passed" "self-review clean" "preview smoke-checked")

cmd_ready() {
  [ $# -eq 0 ] || usage
  local pr facts decision missing out
  pr="$(current_pr)"
  facts="$(pr_facts "$pr")" || exit 1
  # The facts of the other conditions (risk, threads) are not asked here: their conditions are not read.
  decision="$(jq -c --arg review_mark "$REVIEW_MARK" --arg smoke_mark "$SMOKE_MARK" --arg no_preview "$NO_PREVIEW" \
    -f "$ROOT/scripts/merge-gate.jq" <<<"$(jq '. + {risk: {risk: "low", reasons: []}, threads: 0}' <<<"$facts")")" \
    || die "could not decide whether PR #$pr is ready; nothing changed"
  missing="$(jq -r --argjson names "$(printf '%s\n' "${READY_CONDITIONS[@]}" | jq -R . | jq -sc .)" '
    [.conditions[] | select(.name | IN($names[])) | select(.ok | not) | "\(.name) (\(.detail))"] | join("; ")' <<<"$decision")"
  [ -z "$missing" ] || die "PR #$pr is not ready for review: $missing"
  out="$(gh pr ready "$pr" --repo "$REPO" 2>&1)" || die "$out"
  echo "✅ PR #$pr ready for review"
}

# The native jobs' steps with their durations, from the CI run of the PR's head commit. Best effort: never fails, and
# says on stderr why it printed nothing or less. A skipped job prints nothing (#121); a native job that ended without a
# timed step (cancelled, timed out) prints one line saying so.
native_durations() {
  local head run jobs out
  head="$(head_of "$1" 2>/dev/null)" || { echo "could not read the head of PR #$1; no step durations" >&2; return 0; }
  run="$(gh run list --repo "$REPO" --workflow CI --commit "$head" --limit 1 --json databaseId \
    --jq '.[0].databaseId // empty' 2>/dev/null)" || { echo "could not list the CI runs; no step durations" >&2; return 0; }
  [ -n "$run" ] || { echo "no CI run for ${head:0:7}; no step durations" >&2; return 0; }
  jobs="$(gh api "repos/$REPO/actions/runs/$run/jobs?per_page=100" 2>/dev/null)" \
    || { echo "could not read the jobs of CI run $run; no step durations" >&2; return 0; }
  jq -e . >/dev/null 2>&1 <<<"$jobs" \
    || { echo "could not parse the jobs of CI run $run; no step durations" >&2; return 0; }
  out="$(jq -r --argjson native "$(printf '%s\n' "${NATIVE_JOBS[@]}" | jq -R . | jq -sc .)" '
    def seconds: (.completed_at | fromdateiso8601) - (.started_at | fromdateiso8601);
    def clock: "\(. / 60 | floor) min \(. % 60) s";
    .jobs[]? | select(.name | IN($native[])) | . as $job
    | [(.steps // [])[] | select(.started_at != null and .completed_at != null)] as $steps
    | if ($steps | length) > 0 then
        "", "Step durations: \($job.name)",
        ($steps[] | "  \(seconds | clock)  \(.name)"),
        "  \([$steps[] | seconds] | add // 0 | clock)  Total"
      elif $job.conclusion == "skipped" then empty
      else "", "Step durations: \($job.name): no step timings (\($job.conclusion // $job.status // "unknown"))"
      end' <<<"$jobs" 2>/dev/null)" \
    || { [ -z "$out" ] || echo "$out"; echo "could not read a step's timestamps; step durations may be cut off" >&2; return 0; }
  [ -z "$out" ] || echo "$out"
}

# wait, smoke, ready in order, each as its own pr.sh run so a failing step (set -e inside it) ends it with its own exit
# code, which ship returns at once. Records nothing itself: pr.sh reviewed stays the reviewer's verdict to record.
cmd_ship() {
  local pr rc=0 step
  { [ $# -eq 0 ] || { [ $# -eq 2 ] && [ "$1" = --timeout ]; }; } || usage
  pr="$(current_pr)"
  for step in wait smoke ready; do
    echo "▶ pr.sh $step"
    if [ "$step" = wait ]; then "$0" wait "$@" || rc=$?; else "$0" "$step" || rc=$?; fi
    [ "$rc" -eq 0 ] || break
  done
  native_durations "$pr"
  return "$rc"
}

# Dies when the threads can't all be read: more than 100 counts as unknown, never as resolved.
unresolved_threads() {
  local out
  # shellcheck disable=SC2016 # GraphQL variables, not shell
  out="$(gh api graphql -F owner="$OWNER" -F name="$NAME" -F n="$1" -f query='
    query($owner: String!, $name: String!, $n: Int!) {
      repository(owner: $owner, name: $name) { pullRequest(number: $n) { reviewThreads(first: 100) {
        pageInfo { hasNextPage } nodes {
        id isResolved path line comments(first: 50) { nodes { author { login } body createdAt } } } } } }
    }')" || die "could not read the review threads of PR #$1"
  out="$(jq '.data.repository.pullRequest.reviewThreads' <<<"$out")" || die "could not read the review threads of PR #$1"
  [ "$(jq -r '.pageInfo.hasNextPage' <<<"$out")" = false ] \
    || die "PR #$1 has more than 100 review threads (or their count is unknown): resolve them on GitHub"
  jq '[.nodes[] | select(.isResolved | not)]' <<<"$out"
}

cmd_status() {
  [ $# -eq 0 ] || usage
  local pr
  pr="$(current_pr)"
  gh pr view "$pr" --repo "$REPO" --json number,title,state,isDraft,reviewDecision,mergeStateStatus,url,statusCheckRollup \
    | jq -r --argjson threads "$(unresolved_threads "$pr" | jq length)" '
      "PR #\(.number) \(.state)\(if .isDraft then " (draft)" else "" end) — \(.title)",
      "URL: \(.url)",
      def value(f): [f[] | select(. != null and . != "")] | first // "?";
      "Review: \(value([.reviewDecision]) | if . == "?" then "none" else . end) · merge state: \(.mergeStateStatus)",
      "Checks: \([.statusCheckRollup[]? | "\(.name // .context): \(value([.conclusion, .state, .status]))"] | join("; "))",
      "Open threads: \($threads)"'
  queue_state "$pr" | jq -r 'if .merged then "Merge queue: merged"
    elif .queued then "Merge queue: queued (position \(.position))"
    elif .removed then "Merge queue: removed (\(.reason // "no reason given")); look at the merge_group run of its queue branch"
    else "Merge queue: not queued" end'
}

# Waits for the CI workflow run of the PR's head commit (.github/workflows/ci.yml), not for whatever checks exist yet:
# right after a push, the jobs behind "Detect changes" don't exist, so "nothing pending" is not "passed". The timeout is
# $WAIT_MINUTES, or $WAIT_MINUTES_NATIVE once a native job (iOS, Android) is among the checks and not skipped (they are
# required checks, so they exist, skipped, in most PRs); --timeout fixes it.
cmd_wait() {
  local timeout="" limit="$WAIT_MINUTES" pr head start run checks failed native job
  while [ $# -gt 0 ]; do
    case "$1" in
      --timeout) timeout="${2:?}"; shift ;;
      *) usage ;;
    esac
    shift
  done
  pr="$(current_pr)"
  head="$(gh pr view "$pr" --repo "$REPO" --json headRefOid --jq .headRefOid)"
  start="$(date +%s)"
  [ -z "$timeout" ] || limit="$timeout"
  echo "⏳ PR #$pr: waiting up to $limit min for CI on ${head:0:7}"
  while :; do
    run="$(gh run list --repo "$REPO" --workflow CI --commit "$head" --limit 1 --json status,conclusion \
      --jq '.[0] // {} | "\(.status // "") \(.conclusion // "")"')"
    checks="$(gh pr checks "$pr" --repo "$REPO" --json name,bucket 2>/dev/null || true)"
    failed="$(jq -r '[.[]? | select(.bucket == "fail" or .bucket == "cancel") | .name] | join(", ")' <<<"${checks:-[]}" 2>/dev/null || true)"
    if [ -z "$timeout" ] && [ "$limit" -lt "$WAIT_MINUTES_NATIVE" ]; then
      native=""
      for job in "${NATIVE_JOBS[@]}"; do
        ! jq -e --arg job "$job" 'any(.[]?; .name == $job and .bucket != "skipping")' <<<"${checks:-[]}" >/dev/null 2>&1 || native="${native:+$native, }$job"
      done
      if [ -n "$native" ]; then
        limit="$WAIT_MINUTES_NATIVE"
        echo "⏳ $native run: waiting up to $limit min for CI"
      fi
    fi
    if [ -n "$failed" ]; then echo "✗ PR #$pr checks failed: $failed"; return 1; fi
    case "$run" in
      "completed success") echo "✓ PR #$pr: CI passed on ${head:0:7}"; return 0 ;;
      completed\ *) echo "✗ PR #$pr: CI ${run#completed } on ${head:0:7}"; return 1 ;;
    esac
    if [ "$(date +%s)" -ge $(( start + limit * 60 )) ]; then
      run="${run% *}"
      echo "⏱ PR #$pr: CI ${run:-not started} after $limit min"
      return 2
    fi
    sleep 30
  done
}

cmd_threads() {
  [ $# -eq 0 ] || usage
  unresolved_threads "$(current_pr)" | jq -r '
    if length == 0 then "No open threads." else .[] |
      "### Thread \(.id) · \(.path // "general")\(if .line then ":\(.line)" else "" end)",
      (.comments.nodes[] | "**\(.author.login)** (\(.createdAt[:16])): \(.body)"),
      ""
    end'
}

cmd_reply() {
  [ $# -ge 1 ] || usage
  local thread="$1" body="" resolve=false
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --body) body="${2:?}"; shift ;;
      --body-file) body="$(read_body "${2:?}")"; shift ;;
      --resolve) resolve=true ;;
      *) usage ;;
    esac
    shift
  done
  [ -n "$body" ] || die "empty reply"
  # shellcheck disable=SC2016 # GraphQL variables, not shell
  gh api graphql -F thread="$thread" -F body="$body" -f query='
    mutation($thread: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) { comment { id } }
    }' >/dev/null
  if $resolve; then
    # shellcheck disable=SC2016 # GraphQL variables, not shell
    gh api graphql -F thread="$thread" -f query='
      mutation($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { thread { isResolved } } }' >/dev/null
  fi
  echo "💬 replied to thread $thread$($resolve && echo " (resolved)")"
}

head_of() { gh pr view "$1" --repo "$REPO" --json headRefOid --jq .headRefOid; }

# Whether commit $1 has a Railway preview, the one definition pr.sh smoke and the merge gate use: yes, no, or pending
# (Railway is still deploying). Yes when the latest $PREVIEW_CHECK status on the commit is not a skipped deploy; no when
# there is no such status or Railway skipped the deploy. Dies when the statuses can't all be read: never a guessed "no".
preview_of() {
  local sha="$1"
  web_status_of "$sha" | jq -r --arg skipped "$PREVIEW_SKIPPED" '
    if . == null then "no"
    elif .state == "pending" then "pending"
    elif (.description // "") | startswith($skipped) then "no"
    else "yes" end'
}

# The latest $PREVIEW_CHECK status of commit $1 as JSON, or null when there is none. Dies when the statuses can't all
# be read.
web_status_of() {
  local sha="$1" combined
  combined="$(gh api "repos/$REPO/commits/$sha/status?per_page=100")" \
    || die "could not read the statuses of ${sha:0:7}"
  # The combined status holds the latest status per context; more contexts than one page means some are unread.
  jq -c --arg check "$PREVIEW_CHECK" '
    if (.statuses | type) != "array" or .total_count != (.statuses | length) then error("unread statuses")
    else [.statuses[] | select(.context == $check)] | first end' <<<"$combined" 2>/dev/null \
    || die "could not read the statuses of ${sha:0:7}"
}

# Records a result in the PR body as one line, **<mark>:** …, replacing the previous one. scripts/merge-gate.jq reads it.
record() {
  local pr="$1" mark="$2" line="$3" body
  body="$(gh pr view "$pr" --repo "$REPO" --json body --jq .body)" \
    || die "could not read the body of PR #$pr; nothing recorded"
  # grep exits 1 when no line is left (the body was only the old record); that's fine, a failure (2) isn't.
  body="$(grep -v "^\*\*$mark:\*\*" <<<"$body")" || [ $? -eq 1 ] || die "could not update the body of PR #$pr"
  # Checked here: a caller that runs record under `||` has errexit off, and would print the line as recorded.
  gh pr edit "$pr" --repo "$REPO" --body "${body:+$body$'\n\n'}$line" >/dev/null \
    || die "could not update the body of PR #$pr; nothing recorded"
  echo "📝 $line"
}

# The name of the Railway environment of PR $1, `<project>-pr-<n>`: the only one pr.sh smoke may touch. It is built
# from the PR number and the project name alone, never taken from an argument, so production and development are out
# of reach.
preview_env() {
  [[ "$1" =~ ^[0-9]+$ ]] || die "not a PR number: '$1'"
  echo "$RAILWAY_PROJECT_NAME-pr-$1"
}

# The Railway CLI against the web service of the PR's own preview environment (preview_env).
# <list|redeploy>: the deployments as JSON, or redeploy from the branch's latest commit.
railway_preview() {
  local pr="$1" action="$2" env
  env="$(preview_env "$pr")" || exit 1
  case "$action" in
    list) railway deployment list -p "$RAILWAY_PROJECT_ID" -e "$env" -s "$RAILWAY_SERVICE" --json ;;
    redeploy) railway deployment redeploy -p "$RAILWAY_PROJECT_ID" -e "$env" -s "$RAILWAY_SERVICE" --from-source -y ;;
    *) die "unknown railway action '$action'" ;;
  esac
}

railway_ready() { command -v railway >/dev/null && railway whoami >/dev/null 2>&1; }

# What to do when only the Railway CLI could tell, or fix, whether the PR's preview was deployed for the head commit.
railway_hint_text() {
  echo "needs the Railway CLI (not installed or not logged in): install it and run 'railway login', or redeploy the preview in the Railway dashboard ($(preview_env "$1") → $RAILWAY_SERVICE → Redeploy)"
}
railway_hint() { die "the preview of PR #$1 $(railway_hint_text "$1"); nothing recorded"; }

# The state of the PR preview's deployment of commit $2: none (no deployment of it), skipped (Railway skipped it, as
# after a failed first CI run: it is never deployed by a later green run), or the status of the latest other one.
head_deployment() {
  local out
  out="$(railway_preview "$1" list)" || die "could not list the deployments of $(preview_env "$1"); nothing recorded"
  jq -r --arg sha "$2" '[.[] | select(.meta.commitHash == $sha)] as $mine
    | if $mine == [] then "none"
      elif any($mine[]; .status != "SKIPPED") then ([$mine[] | select(.status != "SKIPPED")] | first | .status)
      else "skipped" end' <<<"$out" || die "could not read the deployments of $(preview_env "$1"); nothing recorded"
}

# Redeploys the preview from the branch's latest commit, then waits (within $3) until it is deployed.
redeploy_preview() {
  local pr="$1" head="$2" deadline="$3" out state
  echo "↻ no deployment of ${head:0:7} in $(preview_env "$pr"): redeploying it from source"
  out="$(railway_preview "$pr" redeploy 2>&1)" || die "redeploy of $(preview_env "$pr") failed: $out"
  while :; do
    state="$(head_deployment "$pr" "$head")"
    case "$state" in
      SUCCESS) return 0 ;;
      FAILED|CRASHED|REMOVED) die "the redeployed preview of ${head:0:7} is $state; nothing recorded" ;;
    esac
    [ "$(date +%s)" -lt "$deadline" ] || die "the redeployed preview of ${head:0:7} is still $state after the timeout; nothing recorded"
    sleep 20
  done
}

# The preview exists only when the PR touches a Railway watch pattern (docs/engineering/ENVIRONMENTS.md); preview_of
# decides. While Railway is still deploying, it waits (within the timeout) before it decides. A preview Railway skipped
# for the head commit (it waits for CI, and a failed first run means it is never deployed) is redeployed.
cmd_smoke() {
  local timeout=15 pr head preview url deadline result line redeploy=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --timeout) timeout="${2:?}"; shift ;;
      *) usage ;;
    esac
    shift
  done
  pr="$(current_pr)"
  head="$(head_of "$pr")" || die "could not read the head commit of PR #$pr; nothing recorded"
  deadline=$(( $(date +%s) + timeout * 60 ))
  while :; do
    preview="$(preview_of "$head")" || die "nothing recorded on PR #$pr"
    case "$preview" in
      yes)
        # With the CLI, find a skipped deployment and redeploy it. Without it, a successful status is trusted and the
        # health check decides; a failed one is a deploy that only the CLI (or the dashboard) can redo.
        if railway_ready; then
          case "$(head_deployment "$pr" "$head")" in none|skipped) redeploy=true ;; esac
        elif [ "$(web_status_of "$head" | jq -r '.state // ""')" != success ]; then
          railway_hint "$pr"
        fi
        break ;;
      pending)
        # Still deploying, unless Railway skipped this commit and waits for nothing; without the CLI, just wait.
        if railway_ready && [ "$(head_deployment "$pr" "$head")" = skipped ]; then redeploy=true; break; fi ;;
      *) break ;;
    esac
    [ "$(date +%s)" -lt "$deadline" ] \
      || die "the preview of ${head:0:7} is still deploying after $timeout min; nothing recorded$(
        railway_ready || echo ". Railway may have skipped it (failed first CI run): it $(railway_hint_text "$pr")")"
    sleep 20
  done
  ! $redeploy || redeploy_preview "$pr" "$head" "$deadline"
  if [ "$preview" = no ]; then
    line="**$SMOKE_MARK:** on \`$head\`: $NO_PREVIEW (it touches no Railway watch pattern)."
  else
    url="https://$RAILWAY_SERVICE-$(preview_env "$pr").up.railway.app/api/v1/health"
    until result="$(curl -fsS --max-time 20 "$url" 2>/dev/null)" && jq -e '.status == "ok"' <<<"$result" >/dev/null; do
      [ "$(date +%s)" -lt "$deadline" ] || die "preview not healthy after $timeout min: $url (${result:-no response})"
      sleep 20
    done
    line="**$SMOKE_MARK:** on \`$head\`: \`curl -fsS $url\` → \`${result}\` ✅"
  fi
  record "$pr" "$SMOKE_MARK" "$line"
}

# Run only when both reviewers report no must-fix or should-fix finding. A later push makes the record stale.
cmd_reviewed() {
  [ $# -eq 0 ] || usage
  local pr head local_head
  pr="$(current_pr)"
  [ -z "$(git status --porcelain)" ] || die "uncommitted changes: the reviewers did not see what is on the PR"
  head="$(head_of "$pr")"
  local_head="$(git rev-parse HEAD)"
  [ "$local_head" = "$head" ] \
    || die "local HEAD ${local_head:0:7} is not the PR head ${head:0:7}: push with scripts/pr.sh create, then review again"
  record "$pr" "$REVIEW_MARK" "**$REVIEW_MARK:** standards and spec reviewers clean on \`$head\` ✅"
}

# The facts of scripts/merge-gate.jq that pr.sh ready reads too: the PR, its checks on the head commit, the required
# checks and whether the head has a preview. Required checks come from .github/rulesets/main.json in this worktree, the
# file scripts/github-settings.sh applies to GitHub. Dies when a fact can't be read, so nobody decides on a guess.
pr_facts() {
  local pr="$1" view head preview required
  view="$(gh pr view "$pr" --repo "$REPO" --json number,state,isDraft,baseRefName,headRefName,headRefOid,body,statusCheckRollup)" \
    || die "could not read PR #$pr"
  head="$(jq -r .headRefOid <<<"$view")" || die "could not read PR #$pr"
  preview="$(preview_of "$head")" || exit 1
  required="$(jq '[.rules[] | select(.type == "required_status_checks")
    | .parameters.required_status_checks[].context]' "$ROOT/.github/rulesets/main.json")" \
    || die "could not read the required checks from .github/rulesets/main.json"
  jq --arg base "$(default_branch)" --argjson required "$required" --arg preview "$preview" '{
    head: .headRefOid, branch: .headRefName, default_branch: $base,
    pr: {number, state, draft: .isDraft, base: .baseRefName, body: (.body // "")},
    required: $required, checks: (.statusCheckRollup // []), preview: $preview}' <<<"$view"
}

# All the facts of the merge gate: pr_facts and what only a merge needs (threads, risk, whether the queue removed it, and
# for pr.sh merge the PR's node ID and whether its base branch has a merge queue). Not whether the branch is behind
# main: the merge queue tests every PR on the latest main (ADR-018).
merge_facts() {
  local pr="$1" facts threads risk queue
  facts="$(pr_facts "$pr")" || exit 1
  threads="$(unresolved_threads "$pr")" || exit 1
  risk="$("$ROOT/scripts/risk.sh" "$pr" --json)" || die "could not decide the risk of PR #$pr"
  queue="$(queue_state "$pr")" || exit 1
  jq --argjson threads "$(jq length <<<"$threads")" --argjson risk "$risk" --argjson queue "$queue" \
    '. + {risk: $risk, threads: $threads, queue_removed: $queue.removed, pr_id: $queue.id,
      queue_enabled: $queue.queue_enabled}' <<<"$facts"
}

# Where a PR is in the merge queue, from GitHub, as JSON {id, queue_enabled, merged, queued, position, auto_merge, removed,
# reason}: id is the PR's node ID, queue_enabled whether its base branch has a merge queue. A PR
# is removed when the queue took it out (its last queue event on the timeline) after the head commit was made: a commit
# pushed after the removal makes it stale, and a later removal (the owner queued the new commit) counts again. This reads
# the event's time and the head commit's committedDate, not the **Merge queue:** record, which names only what an agent
# queued. A commit pushed while the PR is queued makes GitHub remove it, with the removal after that commit's
# committedDate: it shows as removed and the gate refuses it (fails closed); the owner decides.
# Times are compared as UTC instants (GitHub's dates have a Z or an offset), not as text.
queue_state() {
  local out
  # shellcheck disable=SC2016 # GraphQL variables, not shell
  out="$(gh api graphql -F owner="$OWNER" -F name="$NAME" -F n="$1" -f query='
    query($owner: String!, $name: String!, $n: Int!) {
      repository(owner: $owner, name: $name) { pullRequest(number: $n) {
        id state isMergeQueueEnabled headRefOid body commits(last: 1) { nodes { commit { committedDate } } } isInMergeQueue mergeQueueEntry { state position } autoMergeRequest { enabledAt }
        timelineItems(last: 1, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) {
          nodes { __typename ... on RemovedFromMergeQueueEvent { reason createdAt } } } } }
    }')" || die "could not read the merge queue state of PR #$1"
  jq '
    def instant: capture("^(?<t>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\\.[0-9]+)?(?<z>Z|[+-][0-9]{2}:[0-9]{2})$")
      | (.t + "Z" | fromdateiso8601)
        - (if .z == "Z" then 0
           else (if .z[0:1] == "-" then -1 else 1 end) * ((.z[1:3] | tonumber) * 3600 + (.z[4:6] | tonumber) * 60) end);
    .data.repository.pullRequest as $p
    | if $p == null then error("no such PR") else . end
    | ($p.timelineItems.nodes | last) as $last
    | ($p.commits.nodes | last | .commit.committedDate | instant) as $committed
    | {id: $p.id, queue_enabled: $p.isMergeQueueEnabled, merged: ($p.state == "MERGED"), queued: $p.isInMergeQueue, position: $p.mergeQueueEntry.position,
       auto_merge: ($p.autoMergeRequest != null),
       removed: ($p.state == "OPEN" and ($p.isInMergeQueue | not)
         and $last.__typename == "RemovedFromMergeQueueEvent" and ($last.createdAt | instant) >= $committed),
       reason: $last.reason}
    | .reason = (if .removed then .reason else null end)' <<<"$out" \
    || die "could not read the merge queue state of PR #$1"
}

cmd_queue() {
  { [ $# -eq 1 ] && [[ "$1" =~ ^[0-9]+$ ]]; } || usage
  queue_state "$1" | jq -c '{state: (if .queued then "queued" elif .removed then "removed" else null end),
    position: (if .queued then .position else null end), reason}'
}

# Adds a low-risk or high-risk (agent-queueable) PR that passes the whole merge gate to the merge queue, which tests it
# on top of the latest main and squash-merges it (ADR-018). On a branch with a merge queue, `gh pr merge` always asks
# for auto-merge (whatever the flags), which the repo doesn't allow and agents never use, so the PR is enqueued with
# GraphQL's enqueuePullRequest. A branch without a queue is squash-merged with `gh pr merge`. Should auto-merge ever be
# on afterwards, turn it off again.
cmd_merge() {
  [ $# -eq 0 ] || usage
  local pr facts decision head branch issue out failed state attempt reasons
  pr="$(current_pr)"
  if ! facts="$(merge_facts "$pr")" || [ -z "$facts" ]; then
    die "could not read the facts of PR #$pr; nothing queued"
  fi
  decision="$(jq -c --arg review_mark "$REVIEW_MARK" --arg smoke_mark "$SMOKE_MARK" --arg no_preview "$NO_PREVIEW" \
    -f "$ROOT/scripts/merge-gate.jq" <<<"$facts")" \
    || die "could not decide the merge gate of PR #$pr; nothing queued"
  jq -r '.conditions[] | "\(if .ok then "✓" else "✗" end) \(.name): \(.detail)"' <<<"$decision"
  head="$(jq -r .head <<<"$facts")"
  if ! jq -e .merge <<<"$decision" >/dev/null; then
    failed="$(jq -r '[.conditions[] | select(.ok | not) | .name] | join(", ")' <<<"$decision")"
    # A refusal for the head commit makes the PR wait on the owner (flow.sh); a new push makes it stale.
    record "$pr" "$REFUSAL_MARK" "**$REFUSAL_MARK:** refused on \`$head\`: $(jq -r \
      '[.conditions[] | select(.ok | not) | "\(.name) (\(.detail))"] | join("; ")' <<<"$decision")"
    die "PR #$pr stays for the owner: $failed; nothing queued"
  fi

  # The owner reads afterwards what an agent merged and why it counted as high-risk (ADR-021): record it before
  # queueing, and queue nothing when it can't be recorded (record dies).
  if [ "$(jq -r .risk.risk <<<"$facts")" = high ]; then
    reasons="$(jq -r '.risk.reasons | join("; ")' <<<"$facts")" \
      || die "could not read the risk reasons of PR #$pr; nothing queued"
    record "$pr" "$HIGH_RISK_MARK" "**$HIGH_RISK_MARK:** \`$head\`: $reasons"
  fi

  branch="$(jq -r .branch <<<"$facts")"
  issue="$(branch_issue "$branch")"
  if jq -e .queue_enabled <<<"$facts" >/dev/null; then
    # shellcheck disable=SC2016 # GraphQL variables, not shell
    out="$(gh api graphql -f id="$(jq -r .pr_id <<<"$facts")" -f head="$head" -f query='
      mutation($id: ID!, $head: GitObjectID!) {
        enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $head}) { mergeQueueEntry { position } }
      }' 2>&1)" || die "could not add PR #$pr to the merge queue: $out"
  else
    out="$(gh pr merge "$pr" --repo "$REPO" --squash --match-head-commit "$head" 2>&1)" || die "merge failed: $out"
  fi
  # The queue answers at once; look a few times in case GitHub is slow to show it.
  for attempt in 1 2 3; do
    state="$(queue_state "$pr")" || die "GitHub took PR #$pr, but its state can't be read: check it on GitHub"
    if jq -e .merged <<<"$state" >/dev/null; then
      # No merge queue on the branch (the ruleset isn't applied yet): GitHub merged it at once.
      echo "✅ PR #$pr squash-merged"
      if gh api --method DELETE "repos/$REPO/git/refs/heads/$branch" >/dev/null 2>&1; then
        echo "🗑  deleted '$branch' on GitHub"
      else
        echo "⚠  could not delete '$branch' on GitHub; flow.sh finish removes it"
      fi
      echo "Next: scripts/flow.sh finish ${issue:-<issue>} from the main checkout"
      return 0
    elif jq -e .queued <<<"$state" >/dev/null; then
      # The record is the audit trail of what an agent queued (removals are read from the timeline). The branch stays:
      # deleting the head branch of a queued PR closes it; flow.sh finish removes it after the merge.
      (record "$pr" "$QUEUE_MARK" "**$QUEUE_MARK:** added to the merge queue on \`$head\`") \
        || echo "⚠  could not record the queued commit in the PR body"
      echo "✅ PR #$pr added to the merge queue (position $(jq -r .position <<<"$state"))"
      echo "GitHub tests it on the latest $(default_branch) and squash-merges it when the checks pass; if it removes the PR, flow.sh status shows why."
      echo "Next: scripts/flow.sh status ${issue:-<issue>}; once GitHub merged it, scripts/flow.sh finish ${issue:-<issue>} from the main checkout"
      return 0
    elif jq -e .auto_merge <<<"$state" >/dev/null; then
      gh pr merge "$pr" --repo "$REPO" --disable-auto >/dev/null 2>&1 \
        || die "auto-merge is on for PR #$pr, which is not in the merge queue, and auto-merge is still on: turn it off on GitHub; nothing queued"
      die "auto-merge is on for PR #$pr, which is not in the merge queue; turned it off, nothing queued"
    fi
    [ "$attempt" -eq 3 ] || sleep 2
  done
  die "GitHub took PR #$pr, but it is neither in the merge queue nor merged: check it on GitHub"
}

cmd_refusal() {
  { [ $# -eq 1 ] && [[ "$1" =~ ^[0-9]+$ ]]; } || usage
  local body
  body="$(gh pr view "$1" --repo "$REPO" --json body --jq .body)" || die "could not read the body of PR #$1"
  jq -n -L "$ROOT/scripts" --arg mark "$REFUSAL_MARK" --arg body "$body" 'include "records";
    $body | record($mark)
    | if . == null then null else {sha: record_sha, reasons: (record_reasons // .)} end'
}

case "${1:-}" in
  check)   shift; cmd_check "$@" ;;
  create)  shift; cmd_create "$@" ;;
  ready)   shift; cmd_ready "$@" ;;
  status)  shift; cmd_status "$@" ;;
  wait)    shift; cmd_wait "$@" ;;
  threads) shift; cmd_threads "$@" ;;
  reply)   shift; cmd_reply "$@" ;;
  smoke)   shift; cmd_smoke "$@" ;;
  reviewed) shift; cmd_reviewed "$@" ;;
  merge)   shift; cmd_merge "$@" ;;
  refusal) shift; cmd_refusal "$@" ;;
  queue)   shift; cmd_queue "$@" ;;
  ship)    shift; cmd_ship "$@" ;;
  *)       usage ;;
esac
