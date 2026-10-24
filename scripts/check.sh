#!/usr/bin/env bash
# shellcheck disable=SC2317,SC2329 # check() calls the check functions by name (code differs per shellcheck version)
# The checks pr.sh runs before every push. Run from the main checkout or any worktree.
#
#   check.sh          everything: hygiene, lint, types, unit tests, static checks, build, integration and e2e tests
#   check.sh --fast   skip the integration and e2e tests
#
# At the end it prints a table of the tests each suite passed, failed and skipped and writes it as JSON to
# .work/check-summary.json (git-ignored, in this checkout). Quote that summary in reports; don't retype counts
# from the output (scripts/test-summary.sh).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
source "$ROOT/scripts/_shellcheck.sh"

FAST=false
case "${1:-}" in
  --fast) FAST=true ;;
  "") ;;
  *) usage_of "$0" ;;
esac

cd "$ROOT"
# The pinned shellcheck (scripts/bootstrap.sh installs it) goes first on PATH, for this script and for turbo's lint:root.
use_pinned_shellcheck
warn_shellcheck_version
FAILED=0
SUMMARY_JSON="$ROOT/.work/check-summary.json"
# An early exit must not leave the summary of an earlier run behind.
rm -f "$SUMMARY_JSON"
# What every check printed, passed or failed: test-summary.sh reads the suites' counts from it.
LOG_DIR="$(mktemp -d)"
remove_log_dir() { rm -rf "$LOG_DIR"; }
on_exit remove_log_dir

# What a failed check shows. A turbo run is logged in full (the parser reads every task's counts), but only the output of
# the tasks that failed (named by "<package>#<task>:  ERROR") is shown, with turbo's footer; any other check shows all.
failure_output() {
  local prefixes
  prefixes="$(sed -nE 's/^([^[:space:]]+)#([^[:space:]]+):[[:space:]]+ERROR[[:space:]].*/\1:\2: /p' <<<"$1")"
  [ -n "$prefixes" ] || { printf '%s\n' "$1"; return; }
  awk 'NR == FNR { prefix[++n] = $0; next }
       footer || /^[^[:space:]]+#[^[:space:]]+:[[:space:]]+ERROR[[:space:]]/ { print; next }
       /^ *Tasks: / { footer = 1; print; next }
       { for (i = 1; i <= n; i++) if (index($0, prefix[i]) == 1) { print; break } }' <(printf '%s\n' "$prefixes") <(printf '%s\n' "$1")
}

check() {
  local name="$1" out rc=0
  shift
  out="$("$@" 2>&1)" || rc=$?
  printf '%s\n' "$out" >>"$LOG_DIR/output.log"
  if [ "$rc" = 0 ]; then
    echo "✓ $name"
  else
    echo "✗ $name"
    [ -z "$out" ] || { out="$(failure_output "$out")"; printf '    %s\n' "${out//$'\n'/$'\n'    }"; }
    FAILED=1
  fi
}

shell_files() { ls scripts/*.sh .githooks/*; }

syntax() {
  local f rc=0
  for f in $(shell_files); do bash -n "$f" || rc=1; done
  return "$rc"
}

shellcheck_all() {
  command -v shellcheck >/dev/null || { echo "shellcheck not found — run scripts/bootstrap.sh"; return 1; }
  # shellcheck disable=SC2046 # file names have no spaces
  shellcheck -x $(shell_files)
}

commit_messages() {
  local subject rc=0
  while IFS= read -r subject; do
    case "$subject" in Merge\ *|fixup!\ *|squash!\ *|amend!\ *|Revert\ *) continue ;; esac
    is_conventional "$subject" || { echo "not a Conventional Commit: $subject"; rc=1; }
  done < <(git log "origin/$(default_branch)..HEAD" --format=%s)
  return "$rc"
}

# Vendored skills are checked against upstream instead.
doc_links() {
  local file target rc=0
  while IFS= read -r file; do
    while IFS= read -r target; do
      target="${target%%#*}"
      [ -z "$target" ] || [ -e "$(dirname "$file")/$target" ] || { echo "$file: broken link $target"; rc=1; }
    done < <(grep -oE '\]\([^)[:space:]]+\)' "$file" | sed -E 's/^\]\((.*)\)$/\1/' | grep -vE '^[a-z]+:|^#|^<' || true)
  done < <(git ls-files '*.md' | while IFS= read -r f; do d="${f%/*}"; [ -f "$d/.upstream" ] || echo "$f"; done)
  return "$rc"
}

# The contract check regenerates the Swift and Kotlin clients (Swift toolchain, Java 17+). Only an API change can make
# them drift, so it runs only when this branch touches packages/api or packages/contract; CI runs it unless turbo has a cached result.
API_PATHS='^packages/(api|contract)/'
touches_api() {
  local files
  files="$(git diff --name-only "origin/$(default_branch)...HEAD"; git status --porcelain | cut -c4-)"
  grep -E "$API_PATHS" <<<"$files" >/dev/null
}

turbo_checks() {
  local contract=--filter=!@fivvi/contract
  ! touches_api || contract=""
  pnpm turbo run lint typecheck test format:check build --output-logs=full \
    && pnpm turbo run check ${contract:+"$contract"} --output-logs=errors-only
}

# Local Postgres for the integration tests and the e2e servers' databases (apps/web/e2e/serve.ts).
local_postgres() {
  docker info >/dev/null 2>&1 || { echo "Docker is not running — start it (Postgres for integration and e2e tests)"; return 1; }
  [ -f packages/database/.env ] || cp packages/database/.env.example packages/database/.env
  pnpm db:up >/dev/null
}

test_database_url() { sed -n 's/^DATABASE_URL=//p' packages/database/.env; }

integration_tests() {
  local_postgres || return 1
  TEST_DATABASE_URL="$(test_database_url)" pnpm turbo run test:integration --output-logs=full
}

e2e_tests() {
  local_postgres || return 1
  TEST_DATABASE_URL="$(test_database_url)" E2E_PORT="$(e2e_port "$ROOT")" \
    pnpm turbo run test:e2e --output-logs=full
}

api_prerequisites() {
  local missing=""
  java_ok || use_brew_java || missing="$missing java(17+)"
  command -v swift >/dev/null || missing="$missing swift"
  [ -z "$missing" ] || { echo "missing:$missing — run scripts/bootstrap.sh --api"; return 1; }
}

check "shell syntax" syntax
check "shellcheck" shellcheck_all
check "vendored skills" "$ROOT/scripts/skills.sh" check
check "agent definitions" "$ROOT/scripts/agents.sh" check
check "commit messages" commit_messages
check "commit emails" "$ROOT/scripts/emails.sh" commits
check "file emails" "$ROOT/scripts/emails.sh" files
check "file secrets" "$ROOT/scripts/secrets.sh" files
check "doc links" doc_links
if [ ! -d node_modules ]; then
  echo "✗ workspace: no node_modules — run scripts/bootstrap.sh"
  exit 1
fi
if touches_api; then
  java_ok || use_brew_java || true
  check "API tools for the contract check" api_prerequisites
  check "lint, types, unit tests, static checks (with the contract), build" turbo_checks
else
  check "lint, types, unit tests, static checks, build (no API change: contract check left to CI)" turbo_checks
fi
if ! $FAST; then
  check "integration tests" integration_tests
  check "e2e tests (port $(e2e_port "$ROOT"))" e2e_tests
fi

# The suites of the workspace that turbo runs tests for: the root and every package with a test script. One that left no
# output (turbo stops after the first failure) is listed as not-run.
expected_suites() {
  local file
  echo "//:test:root"
  for file in apps/*/package.json packages/*/package.json; do
    [ -f "$file" ] || continue
    jq -r '.name as $name | (.scripts // {}) | keys[] | select(. == "test" or . == "test:integration" or . == "test:e2e") | "\($name):\(.)"' "$file"
  done
}

# The suites' counts, after the checks so that a failed run shows them too.
test_kinds=(--run unit)
for kind in integration e2e; do
  if $FAST; then test_kinds+=(--skip "$kind"); else test_kinds+=(--run "$kind"); fi
done
while IFS= read -r suite; do test_kinds+=(--expect "$suite"); done < <(expected_suites)
echo
"$ROOT/scripts/test-summary.sh" --json "$SUMMARY_JSON" "${test_kinds[@]}" "$LOG_DIR/output.log" \
  || { echo "✗ test summary"; FAILED=1; }

exit "$FAILED"
