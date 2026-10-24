#!/usr/bin/env bash
# Keep keys and tokens out of this public repo (E017 AC7). Dependency-free, over tracked and new files (not ignored ones).
#
#   secrets.sh files     no file named *.p12, *.pfx, *.p8, *.jks, *.keystore or *.mobileprovision, and no private-key
#                        block (PEM), AWS access key ID, GitHub, Slack or Sentry token inside a file
#
# Findings name the file and line, never the value. A file that has to stay is listed with a reason in
# scripts/secret-allowlist.txt (it lifts both checks for that path).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

ALLOWLIST="$ROOT/scripts/secret-allowlist.txt"
KEY_FILE_NAME_RE='\.(p12|pfx|p8|jks|keystore|mobileprovision)$'
# One pattern per kind of key material; each is written so that it does not match its own source text.
KINDS=("PEM private key" "AWS access key ID" "GitHub token" "Slack token" "Sentry auth token")
PATTERNS=(
  '-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY'
  '(^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}([^A-Za-z0-9]|$)'
  '(^|[^A-Za-z0-9_])(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})'
  '(^|[^A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}'
  '(^|[^A-Za-z0-9_])sntry[su]_[A-Za-z0-9+/=_-]{20,}'
)

# The allowlist, read once: path globs in ALLOWED, each with a reason after "|". An entry without one is itself a finding.
ALLOWED=()
allowlist_problems=0
load_allowlist() {
  local line glob reason n=0
  while IFS= read -r line; do
    n=$((n + 1))
    line="${line%%#*}"
    [[ "$line" == *[![:space:]]* ]] || continue
    glob="${line%%|*}"
    reason="${line#*|}"
    [ "$reason" != "$line" ] || reason=""
    glob="$(echo "$glob" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
    if [ -z "$(echo "$reason" | tr -d '[:space:]')" ]; then
      echo "scripts/secret-allowlist.txt:$n: entry without a reason (glob | why it is not a secret)" >&2
      allowlist_problems=1
    else
      ALLOWED+=("$glob")
    fi
  done <"$ALLOWLIST"
}

path_allowed() {
  local entry
  for entry in ${ALLOWED[@]+"${ALLOWED[@]}"}; do
    # shellcheck disable=SC2254 # the entry is a glob on purpose
    case "$1" in $entry) return 0 ;; esac
  done
  return 1
}

files() {
  local rc=0 path name i line last rest status LIST HITS
  # git ls-files is relative to the working directory: always scan the whole repo.
  cd "$ROOT"
  load_allowlist
  rc=$allowlist_problems
  # The files to read, listed once (NUL-separated, as ./path so that a file named "-" is not read as stdin). Only regular
  # files inside the repo: a deleted or dangling path would make grep fail, and a symlink could lead out of the repo.
  LIST="$(mktemp)"
  HITS="$(mktemp)"
  on_exit "rm -f '$LIST' '$HITS'"
  while IFS= read -r -d '' path; do
    { [ ! -f "$path" ] || [ -L "$path" ]; } || printf './%s\0' "$path" >>"$LIST"
    path_allowed "$path" && continue
    name="$(printf '%s' "${path##*/}" | tr '[:upper:]' '[:lower:]')"
    if [[ "$name" =~ $KEY_FILE_NAME_RE ]]; then
      echo "$path: key or certificate file in the repo" >&2
      rc=1
    fi
  done < <(git ls-files -z --cached --others --exclude-standard)
  for i in "${!PATTERNS[@]}"; do
    last=""
    # grep status 1 is "no match" and fine; any other status means a file was not read, which must not pass silently.
    # "--" keeps a file named like an option (-rfoo.txt) from being read as one.
    status=0
    # shellcheck disable=SC2016 # $0 and $@ are for the inner shell on purpose
    xargs -0 sh -c 'grep -IHnoE --null -e "$0" -- "$@"; [ $? -le 1 ]' "${PATTERNS[$i]}" <"$LIST" >"$HITS" || status=$?
    if [ "$status" != 0 ]; then
      echo "secrets.sh: grep failed (${KINDS[$i]}), so the files were not all checked" >&2
      rc=1
    fi
    # grep --null ends the path with a NUL, so a ":" in a path is safe; the rest is "line:match", and the match is never printed.
    while IFS= read -r -d '' path && IFS= read -r rest; do
      path="${path#./}"
      line="${rest%%:*}"
      [ "$path:$line" != "$last" ] || continue
      last="$path:$line"
      path_allowed "$path" && continue
      echo "$path:$line: ${KINDS[$i]}" >&2
      rc=1
    done <"$HITS"
  done
  [ "$rc" = 0 ] || echo "  fix: keep keys, certificates and tokens out of the repo (docs/engineering/RELEASE.md); scripts/secret-allowlist.txt lists the files that are fine, each with a reason" >&2
  return "$rc"
}

case "${1:-}" in
  files) [ $# -eq 1 ] || usage_of "$0"; files ;;
  *) usage_of "$0" ;;
esac
