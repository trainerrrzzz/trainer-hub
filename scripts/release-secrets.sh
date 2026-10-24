#!/usr/bin/env bash
# The owner's script to put the release secrets of E017 into the GitHub environment `release` (docs/engineering/RELEASE.md).
# Agents don't run it: it asks for keys, passwords and tokens. A value is never printed, never put on a command line and
# never written to a file: it is read from a file you name or from a hidden prompt and piped to `gh secret set`. Files
# inside the repository are refused, so a key can't end up in a commit.
#
#   release-secrets.sh list                                   which release secrets are set (names only)
#   release-secrets.sh ios [--certificate F] [--profile F] [--api-key F]
#                                                             Apple Distribution certificate (.p12) and its password,
#                                                             App Store provisioning profile, App Store Connect API key
#                                                             (.p8, key ID, issuer ID)
#   release-secrets.sh android-keystore [--dir DIR]           make the upload keystore in DIR (default ~/fivvi-release-keys,
#                                                             outside the repo), then set its secrets
#   release-secrets.sh android [--keystore F]                 the secrets of an upload keystore you already have
#   release-secrets.sh play [--service-account F]             the Google Play service-account JSON key
#   release-secrets.sh sentry                                 the Sentry auth token (releases and artifacts only)
#
# A file you don't give as an option is asked for (its path is not secret). Run scripts/github-settings.sh apply first, so
# the environment exists.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

usage() { usage_of "$0"; }

ENVIRONMENT=release
# Every secret of the environment, which command sets it, and what it is.
SECRETS="IOS_DISTRIBUTION_CERTIFICATE ios Apple Distribution certificate (.p12, base64)
IOS_DISTRIBUTION_CERTIFICATE_PASSWORD ios Password of the certificate
IOS_PROVISIONING_PROFILE ios App Store provisioning profile (base64)
APP_STORE_CONNECT_KEY_ID ios App Store Connect API key ID
APP_STORE_CONNECT_ISSUER_ID ios App Store Connect issuer ID
APP_STORE_CONNECT_API_KEY ios App Store Connect API key (.p8)
ANDROID_UPLOAD_KEYSTORE android Upload keystore (base64)
ANDROID_UPLOAD_KEYSTORE_PASSWORD android Keystore password
ANDROID_UPLOAD_KEY_ALIAS android Alias of the upload key
ANDROID_UPLOAD_KEY_PASSWORD android Password of the upload key
PLAY_SERVICE_ACCOUNT_JSON play Google Play service-account key (JSON)
SENTRY_AUTH_TOKEN sentry Sentry auth token for symbol uploads"
# GitHub allows 48 KB per secret.
MAX_SECRET_BYTES=49152

need_cmd gh
REPO="$(repo_slug)"

# Absolute path of a file or directory that may not exist yet, with the symlinks of its existing part resolved, a symlink
# in the last place included (a link to a key inside the repository is a key inside the repository).
absolute() {
  local path="$1" tail="" tilde='~' hops=0 target
  case "$path" in "$tilde") path="$HOME" ;; "$tilde"/*) path="$HOME/${path#"$tilde"/}" ;; esac
  case "$path" in /*) ;; *) path="$PWD/$path" ;; esac
  while :; do
    while [ ! -e "$path" ] && [ ! -L "$path" ]; do
      tail="/$(basename "$path")$tail"
      path="$(dirname "$path")"
    done
    [ -L "$path" ] && [ ! -d "$path" ] || break
    hops=$((hops + 1))
    [ "$hops" -le 20 ] || die "too many symbolic links: $1"
    target="$(readlink "$path")"
    case "$target" in /*) path="$target" ;; *) path="$(dirname "$path")/$target" ;; esac
  done
  if [ -d "$path" ]; then echo "$(cd "$path" && pwd -P)$tail"; else echo "$(cd "$(dirname "$path")" && pwd -P)/$(basename "$path")$tail"; fi
}

die_if_in_repo() {
  case "$(absolute "$1")/" in
    "$MAIN_ROOT"/* | "$ROOT"/*) die "$1 is inside the repository: keep keys and certificates outside it, so they can't be committed" ;;
  esac
}

# Asks for the path of a file (visible: a path is not secret) unless it came as an option; sets FILE.
ask_file() {
  local given="$1" label="$2"
  FILE="$given"
  if [ -z "$FILE" ]; then
    printf '%s (path): ' "$label" >&2
    IFS= read -r FILE || true
  fi
  [ -n "$FILE" ] || die "no file for: $label"
  FILE="$(absolute "$FILE")"
  die_if_in_repo "$FILE"
  [ -f "$FILE" ] && [ -r "$FILE" ] || die "not a readable file: $FILE"
  [ -s "$FILE" ] || die "empty file: $FILE"
}

# Reads a value without echoing it; sets VALUE.
ask_secret() {
  printf '%s: ' "$1" >&2
  IFS= read -rs VALUE || true
  printf '\n' >&2
  [ -n "$VALUE" ] || die "no value for: $1"
}

# Reads the value from stdin and stores it as the secret $1. gh reads a piped value and prints nothing of it.
store() {
  gh secret set "$1" --env "$ENVIRONMENT" --repo "$REPO" >/dev/null \
    || die "could not set $1 in the environment $ENVIRONMENT (does it exist? scripts/github-settings.sh apply)"
  echo "✅ $1"
}

store_value() { printf '%s' "$VALUE" | store "$1"; VALUE=""; }

store_text_file() {
  [ "$(wc -c <"$FILE")" -le "$MAX_SECRET_BYTES" ] || die "$FILE is larger than GitHub's 48 KB limit for a secret"
  store "$1" <"$FILE"
}

store_binary_file() {
  [ $(( $(wc -c <"$FILE") * 4 / 3 + 4 )) -le "$MAX_SECRET_BYTES" ] || die "$FILE is too large for a secret once encoded (limit 48 KB)"
  base64 <"$FILE" | tr -d '\n' | store "$1"
}

parse_options() {
  # Sets OPT_<NAME> for each --name given; the allowed names come first, then the arguments.
  local allowed="$1" arg name
  shift
  while [ $# -gt 0 ]; do
    arg="$1"
    name="${arg#--}"
    case " $allowed " in *" $name "*) ;; *) usage ;; esac
    [ $# -ge 2 ] || usage
    printf -v "OPT_${name//-/_}" '%s' "$2"
    shift 2
  done
}

do_list() {
  local set_names name command description
  set_names="$(gh secret list --env "$ENVIRONMENT" --repo "$REPO" --json name --jq '.[].name')"
  while read -r name command description; do
    if grep -qxF -- "$name" <<<"$set_names"; then echo "✅ $name"; else echo "⬜ $name   scripts/release-secrets.sh $command   ($description)"; fi
  done <<<"$SECRETS"
}

do_ios() {
  OPT_certificate="" OPT_profile="" OPT_api_key=""
  parse_options "certificate profile api-key" "$@"
  ask_file "$OPT_certificate" "Apple Distribution certificate (.p12)"
  local certificate="$FILE"
  ask_file "$OPT_profile" "App Store provisioning profile (.mobileprovision)"
  local profile="$FILE"
  ask_file "$OPT_api_key" "App Store Connect API key (AuthKey_<key id>.p8)"
  grep -q 'BEGIN PRIVATE KEY' "$FILE" || die "$FILE is not an App Store Connect .p8 key"
  local api_key="$FILE"
  ask_secret "Password of the certificate"
  local certificate_password="$VALUE"
  ask_secret "App Store Connect key ID"
  local key_id="$VALUE"
  ask_secret "App Store Connect issuer ID"
  local issuer_id="$VALUE"
  FILE="$certificate"; store_binary_file IOS_DISTRIBUTION_CERTIFICATE
  VALUE="$certificate_password"; store_value IOS_DISTRIBUTION_CERTIFICATE_PASSWORD
  FILE="$profile"; store_binary_file IOS_PROVISIONING_PROFILE
  VALUE="$key_id"; store_value APP_STORE_CONNECT_KEY_ID
  VALUE="$issuer_id"; store_value APP_STORE_CONNECT_ISSUER_ID
  FILE="$api_key"; store_text_file APP_STORE_CONNECT_API_KEY
}

store_keystore() {
  local keystore="$1" alias="$2" store_password="$3" key_password="$4"
  FILE="$keystore"; store_binary_file ANDROID_UPLOAD_KEYSTORE
  VALUE="$store_password"; store_value ANDROID_UPLOAD_KEYSTORE_PASSWORD
  VALUE="$alias"; store_value ANDROID_UPLOAD_KEY_ALIAS
  VALUE="$key_password"; store_value ANDROID_UPLOAD_KEY_PASSWORD
}

do_android() {
  OPT_keystore=""
  parse_options "keystore" "$@"
  ask_file "$OPT_keystore" "Upload keystore (.p12 or .jks)"
  local keystore="$FILE"
  ask_secret "Keystore password"
  local store_password="$VALUE"
  ask_secret "Alias of the upload key"
  local alias="$VALUE"
  ask_secret "Password of the upload key"
  store_keystore "$keystore" "$alias" "$store_password" "$VALUE"
}

do_android_keystore() {
  OPT_dir="$HOME/fivvi-release-keys"
  parse_options "dir" "$@"
  local keystore password again alias=upload
  keystore="$(absolute "$OPT_dir")/fivvi-pro-upload.p12"
  die_if_in_repo "$keystore"
  [ ! -e "$keystore" ] || die "$keystore exists already: use 'android --keystore' for it, or move it away"
  command -v keytool >/dev/null || use_brew_java || true
  need_cmd keytool
  echo "Choose a password for the new upload keystore. Keep it in your password manager with the backup of the file." >&2
  ask_secret "New keystore password (also the key password)"
  password="$VALUE"
  ask_secret "Again"
  again="$VALUE"
  [ "$password" = "$again" ] || die "the passwords differ"
  # A new directory is private; an existing one is left as it is.
  [ -d "$(dirname "$keystore")" ] || (umask 077 && mkdir -p "$(dirname "$keystore")")
  # The password reaches keytool through its environment, not its command line.
  (umask 077 && FIVVI_KEYSTORE_PASSWORD="$password" keytool -genkeypair -keystore "$keystore" -storetype PKCS12 \
    -alias "$alias" -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Fivvi Pro upload key, O=Fivvi" \
    -storepass:env FIVVI_KEYSTORE_PASSWORD -keypass:env FIVVI_KEYSTORE_PASSWORD >/dev/null)
  echo "🔑 upload keystore: $keystore (back it up now, with its password)"
  store_keystore "$keystore" "$alias" "$password" "$password"
}

do_play() {
  OPT_service_account=""
  parse_options "service-account" "$@"
  ask_file "$OPT_service_account" "Google Play service-account key (.json)"
  jq -e '.type == "service_account" and (.private_key | type == "string")' "$FILE" >/dev/null 2>&1 \
    || die "$FILE is not a service-account key"
  store_text_file PLAY_SERVICE_ACCOUNT_JSON
}

do_sentry() {
  ask_secret "Sentry auth token (scopes: project:releases and org:read only)"
  store_value SENTRY_AUTH_TOKEN
}

command="${1:-}"
[ $# -eq 0 ] || shift
case "$command" in
  list) [ $# -eq 0 ] || usage; do_list ;;
  ios) need_cmd base64; do_ios "$@" ;;
  android) need_cmd base64; do_android "$@" ;;
  android-keystore) need_cmd base64; do_android_keystore "$@" ;;
  play) need_cmd jq; do_play "$@" ;;
  sentry) [ $# -eq 0 ] || usage; do_sentry ;;
  *) usage ;;
esac
