#!/usr/bin/env bash
# Which native CI jobs (iOS, Android) a change needs, for CI's "Detect changes" job (.github/workflows/ci.yml). A
# script, so the decision is tested (scripts/test/scripts.test.mjs) instead of living untested in the workflow.
#
#   native-jobs.sh [--event <github event>] [--run-native]
#       reads the changed paths on stdin and prints ios=true|false and android=true|false (the format of
#       $GITHUB_OUTPUT), with the reason on stderr. A job runs when its project exists and a path it depends on
#       changed, on a push to main too: main then writes the caches (Gradle, the AVD snapshot, DerivedData) that every PR
#       reads. A push that touches no such path (docs, ci.yml, _lib.sh) runs neither.
#       --event workflow_dispatch and --run-native (the PR's run-native label) run both, whatever changed.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

usage() { usage_of "$0"; }

# Each native job: the app, its generated inputs (client, string catalogs, design tokens), the version both apps share
# (apps/Version.xcconfig) and its own scripts. Shared
# files (.github/workflows/ci.yml, scripts/_lib.sh, this list) don't run them on their own. Android also runs the
# Maestro flows in e2e/maestro.
IOS_PATHS='^(apps/ios|packages/contract|packages/i18n/generated/ios|packages/design-tokens/FivviDesignTokens)/|^apps/Version\.xcconfig$|^scripts/(test-ios|_ios)\.sh$'
ANDROID_PATHS='^(apps/android|packages/contract|packages/i18n/generated/android|packages/design-tokens/kotlin|e2e/maestro)/|^apps/Version\.xcconfig$|^scripts/(android|_android|maestro)\.sh$'

EVENT=""
FORCE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --event) EVENT="${2:?}"; shift ;;
    --run-native) FORCE=true ;;
    *) usage ;;
  esac
  shift
done
[ "$EVENT" != workflow_dispatch ] || FORCE=true
CHANGED="$(cat)"

# decide <job> <project dir> <path regex>
decide() {
  local run=false
  if [ ! -d "$ROOT/$2" ]; then
    echo "$1: $2 does not exist yet, skipping." >&2
  elif $FORCE; then
    run=true
    echo "$1: run on demand (workflow_dispatch or the run-native label), running." >&2
  elif grep -qE "$3" <<<"$CHANGED"; then
    run=true
    echo "$1: relevant changes, running." >&2
  else
    echo "$1: no relevant changes, skipping." >&2
  fi
  echo "$1=$run"
}

decide ios apps/ios "$IOS_PATHS"
decide android apps/android "$ANDROID_PATHS"
