#!/usr/bin/env bash
# The Android app's toolchain and tests (E008). CI runs the same commands (.github/workflows/ci.yml, job Android).
#
#   android.sh setup      install or check the JDK, the Android SDK, the emulator and its image, and Maestro
#                         (scripts/bootstrap.sh --mobile runs this)
#   android.sh test       ktlint with the literal-text, colour and Sentry checks, the release API address (HTTPS, not a
#                         placeholder; the check must also reject an empty, plain-HTTP and .invalid one) and Sentry DSN
#                         (EU region), build, unit tests (nl-NL and en; BuildInfoTest once more with build number 42),
#                         and the Compose UI tests on an emulator, booted for the run when none is connected
#                         (pnpm test:android)
#   android.sh emulator   boot the emulator headless and leave it running, so test and maestro.sh reuse it. With
#                         AVD_SNAPSHOT=1 (CI) it boots from a saved snapshot, or cold when there is none or it
#                         doesn't load, and then saves one
#   android.sh stop       stop the emulator and wait for it to exit (CI, before it saves the AVD cache), within
#                         EMULATOR_STOP_TIMEOUT seconds (30)
#   android.sh avd-key    the cache key suffix for CI's cached AVD: system image, emulator and AVD settings
#
# When test ends, also on failure or Ctrl-C, it kills the emulator it booted and stops its Gradle daemons; KEEP_DEVICE=1
# leaves them running for the next run.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
source "$(dirname "${BASH_SOURCE[0]}")/_android.sh"

usage() { usage_of "$0"; }

MISSING=""
missing() { echo "⚠️  $*"; MISSING="$MISSING
  - $*"; }

setup_java() {
  if java_ok || use_brew_java; then return; fi
  if command -v brew >/dev/null && brew install openjdk@21 && use_brew_java; then return; fi
  missing "Java 17+ — install it: brew install openjdk@21 (macOS) or a JDK 21 package (Linux)"
  return 1
}

# sdkmanager: from the SDK itself, else Homebrew's command-line tools (which install the SDK's own copy).
find_sdkmanager() {
  local home="$1" brew_tools
  if [ -x "$home/cmdline-tools/latest/bin/sdkmanager" ]; then echo "$home/cmdline-tools/latest/bin/sdkmanager"; return; fi
  if command -v brew >/dev/null; then
    brew list --cask android-commandlinetools >/dev/null 2>&1 || brew install --cask android-commandlinetools >&2 || return 1
    brew_tools="$(brew --prefix)/share/android-commandlinetools/cmdline-tools/latest/bin/sdkmanager"
    [ -x "$brew_tools" ] && { echo "$brew_tools"; return; }
  fi
  return 1
}

setup_sdk() {
  local home sdkmanager image tools="" had_home="${ANDROID_HOME:-}"
  home="$(android_home)"
  sdkmanager="$(find_sdkmanager "$home")" || {
    missing "the Android SDK command-line tools — install them: brew install --cask android-commandlinetools (macOS), or Android Studio"
    return 1
  }
  # Reinstalling over an existing cmdline-tools;latest only adds a latest-2 copy next to it.
  [ -x "$home/cmdline-tools/latest/bin/avdmanager" ] || tools="cmdline-tools;latest"
  image="$(system_image)"
  ANDROID_AVD_HOME="$(android_avd_home)"
  export ANDROID_HOME="$home" ANDROID_AVD_HOME PATH="$home/emulator:$PATH"
  mkdir -p "$home" "$ANDROID_AVD_HOME"
  echo "Android SDK in $home, emulators in $ANDROID_AVD_HOME"
  yes | "$sdkmanager" --sdk_root="$home" --licenses >/dev/null 2>&1 || true
  # shellcheck disable=SC2086 # tools and SDK_PACKAGES are space-separated package ids without spaces
  "$sdkmanager" --sdk_root="$home" $tools $SDK_PACKAGES "$image" >/dev/null || {
    missing "Android SDK packages: $tools $SDK_PACKAGES $image"
    return 1
  }
  if ! avd_exists; then
    echo no | "$home/cmdline-tools/latest/bin/avdmanager" create avd \
      --name "$AVD_NAME" --package "$image" --device pixel_7 >/dev/null \
      || { missing "the emulator '$AVD_NAME' (avdmanager create avd)"; return 1; }
    avd_exists || { missing "the emulator '$AVD_NAME': created, but the emulator can't find it in $ANDROID_AVD_HOME (emulator -list-avds: $(avd_list))"; return 1; }
  fi
  configure_avd || { missing "the emulator '$AVD_NAME': no config.ini in $ANDROID_AVD_HOME/$AVD_NAME.avd"; return 1; }
  echo "✓ Android SDK, emulator '$AVD_NAME' ($image; $AVD_SETTINGS)"
  [ -n "$had_home" ] || echo "  Add to your shell profile: export ANDROID_HOME=\"$home\""
}

install_maestro() {
  local zip="$MAESTRO_HOME/maestro-$MAESTRO_VERSION.zip" unpacked="$MAESTRO_HOME/unpacked"
  mkdir -p "$MAESTRO_HOME"
  curl -fsSL -o "$zip" "https://github.com/mobile-dev-inc/maestro/releases/download/cli-$MAESTRO_VERSION/maestro.zip" || return 1
  rm -rf "${MAESTRO_HOME:?}/bin" "${MAESTRO_HOME:?}/lib" "$unpacked"
  unzip -q "$zip" -d "$unpacked" || return 1
  cp -R "$unpacked/maestro/." "$MAESTRO_HOME/"
  rm -rf "$unpacked" "$zip"
}

setup_maestro() {
  if [ "$("$MAESTRO_HOME/bin/maestro" --version 2>/dev/null | tail -1)" != "$MAESTRO_VERSION" ]; then
    install_maestro || { missing "Maestro $MAESTRO_VERSION — see https://docs.maestro.dev"; return 1; }
  fi
  echo "✓ Maestro $MAESTRO_VERSION in $MAESTRO_HOME/bin"
}

cmd_setup() {
  [ $# -eq 0 ] || usage
  if setup_java; then
    echo "✓ Java: $(java -version 2>&1 | head -1)"
    java_trust_keychain
    setup_sdk || true
  fi
  setup_maestro || true
  if [ -n "$MISSING" ]; then
    echo "Android toolchain incomplete; missing:$MISSING"
    return 1
  fi
}

# E017 AC5: checkReleaseApiBaseUrl must fail, with its own message, on an empty, a plain-HTTP, a `.invalid` and a wrongly
# mounted (`/apix`) address.
release_url_check_rejects_bad_addresses() {
  local url out
  for url in "" "http://production.fivvi.app/api/" "https://production.fivvi.invalid/api/" "https://production.fivvi.app/apix"; do
    if out="$(gradle --quiet checkReleaseApiBaseUrl "-Pfivvi.releaseApiBaseUrl=$url" 2>&1)"; then
      die "checkReleaseApiBaseUrl accepted fivvi.releaseApiBaseUrl='$url'"
    fi
    grep -q "Set fivvi.releaseApiBaseUrl" <<<"$out" \
      || die "checkReleaseApiBaseUrl failed for '$url', but not with its message:"$'\n'"$out"
  done
}

cmd_test() {
  [ $# -eq 0 ] || usage
  android_env
  on_exit stop_android
  gradle ktlintCheck :lint-rules:test checkReleaseApiBaseUrl checkReleaseSentryDsn assembleDebug testDebugUnitTest
  release_url_check_rejects_bad_addresses
  # E017 AC4: a build number passed from outside (-Pfivvi.buildNumber, as a release run does) becomes the versionCode.
  gradle testDebugUnitTest --tests app.fivvi.pro.BuildInfoTest -Pfivvi.buildNumber=42
  start_emulator
  gradle connectedDebugAndroidTest
}

cmd_emulator() {
  [ $# -eq 0 ] || usage
  android_env
  start_emulator
  echo "✓ $(adb devices | sed -n 2p)"
}

cmd_stop() {
  [ $# -eq 0 ] || usage
  android_env
  stop_emulator_and_wait
}

cmd_avd_key() {
  [ $# -eq 0 ] || usage
  avd_key || die "the system image or the emulator isn't installed in $(android_home); run android.sh setup"
}

case "${1:-}" in
  avd-key) shift; cmd_avd_key "$@" ;;
  setup) shift; cmd_setup "$@" ;;
  test) shift; cmd_test "$@" ;;
  emulator) shift; cmd_emulator "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  *) usage ;;
esac
