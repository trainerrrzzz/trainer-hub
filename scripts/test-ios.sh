#!/usr/bin/env bash
# The iOS app's checks, the same steps as the `iOS` CI job (E008). `pnpm test:ios` runs this.
#
#   test-ios.sh   SwiftLint and its fixtures (literal text, colours, direct Sentry calls), the Debug and Release
#                 configurations (Release's API address over HTTPS and not a placeholder, its Sentry DSN in the EU
#                 region, no export compliance question, the version both apps share, the final bundle ID, Info.plists
#                 in Xcode's form), the Swift package
#                 allowlist, that every UI test runs in at least one test-plan configuration, that Xcode's string
#                 catalog sync leaves the generated catalogs unchanged, then one build-for-testing and one run of the
#                 unit and UI tests in nl and en without building again (one result bundle, both locales), on the newest
#                 iPhone simulator, in a worktree its own copy (IOS_SIMULATOR="iPhone 17" picks one by name). Both
#                 locales run on one simulator, also on CI (two simulators were slower on CI's 3-core runner);
#                 IOS_PARALLEL=1 runs one run per locale at the same time on two. Prints the durations of its steps, the
#                 build timing summary and the slowest tests per locale (also in the job summary on CI). Shuts down the
#                 simulators it booted when it ends, unless KEEP_DEVICE=1
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
source "$ROOT/scripts/_ios.sh"
[ $# -eq 0 ] || usage_of "$0"

need_cmd jq
use_xcode || die "Xcode not found — run scripts/bootstrap.sh --mobile"
install_swiftlint || die "could not install SwiftLint — run scripts/bootstrap.sh --mobile"
cd "$IOS_DIR"

# Every line of a fixture marked `// expect: <rule>` must fail SwiftLint with that rule, naming the file and line; no
# other line may fail with it.
lint_fixture() {
  local fixture=$1 rule=$2 out expected actual
  if out="$("$SWIFTLINT" lint --strict --quiet "$fixture" 2>&1)"; then
    echo "SwiftLint passed $fixture, which breaks $rule"
    return 1
  fi
  expected="$(grep -n "// expect: $rule\$" "$fixture" | cut -d: -f1)"
  actual="$(grep "($rule)" <<<"$out" | grep -oE "$(basename "$fixture"):[0-9]+" | cut -d: -f2 | sort -nu)"
  [ "$expected" = "$actual" ] && return
  echo "$fixture: expected $rule on lines $(echo "$expected" | xargs), got $(echo "$actual" | xargs):"
  echo "$out"
  return 1
}

# Debug's committed defaults are the local dev server and no Sentry DSN, so Debug builds, tests and CI send nothing to
# Sentry (a developer's Config/Local.xcconfig may override both; CI has none).
debug_configuration() {
  local url dsn
  url="$(sed -nE 's/^FIVVI_API_BASE_URL = //p' Config/Debug.xcconfig)"
  # shellcheck disable=SC2016 # the xcconfig's literal `$()`, which keeps `//` from starting a comment
  [ "$url" = 'http:/$()/localhost:3000/api' ] \
    || { echo "Config/Debug.xcconfig: base URL is not the local dev server: $url"; return 1; }
  # Every setting of the DSN, also indented or conditional (`FIVVI_SENTRY_DSN[sdk=…] = …`), must be empty.
  dsn="$(sed -nE 's/^[[:space:]]*FIVVI_SENTRY_DSN[^=]*=[[:space:]]*//p' Config/Debug.xcconfig | tr -d '[:space:]')"
  [ -z "$dsn" ] \
    || { echo "Config/Debug.xcconfig: FIVVI_SENTRY_DSN must stay empty; set it in Local.xcconfig"; return 1; }
}

# E017 AC5: the production API over HTTPS, on a real host: a dotted name, not the reserved `.invalid` placeholder, with
# the `/api` mount.
production_base_url() {
  local url=$1 host
  [[ "$url" =~ ^https://([A-Za-z0-9-]+\.)+[A-Za-z0-9-]+/api/?$ ]] || return 1
  host="${url#https://}"
  [[ "${host%%/*}" != *.invalid ]]
}

# production_base_url must refuse an empty, a plain-HTTP, a `.invalid` and a host-less address, and take the real one.
production_base_url_fixtures() {
  local url rc=0
  for url in "" "http://production.fivvi.app/api" "https://production.fivvi.invalid/api" "https:///api" "https://localhost/api"; do
    ! production_base_url "$url" || { echo "E017 AC5: production_base_url accepted '$url'"; rc=1; }
  done
  production_base_url "https://production.fivvi.app/api" || { echo "E017 AC5: production_base_url refused a real address"; rc=1; }
  return "$rc"
}

# The settings an Xcode configuration of the app resolves to, with any build settings given after it (as `xcodebuild`
# takes them on its command line). It resolves the Swift packages, so it uses the cached .build/SourcePackages like the
# build does (without it, it cloned them all again: 71 s of CI's first run, #105). Reading the xcconfig instead would not
# show what the project's configuration really resolves to.
build_settings() {
  local configuration=$1
  shift
  xcodebuild -project FivviPro.xcodeproj -target FivviPro -configuration "$configuration" -showBuildSettings \
    -clonedSourcePackagesDirPath .build/SourcePackages "$@"
}

# A setting's value in the target's block of the output. Xcode first echoes the settings given on the command line
# ("Build settings from command line:"), which says nothing about what the target resolves to, so only the block "Build
# settings for action build and target FivviPro:" counts.
setting_of() {
  awk -v key="$1" '
    /^Build settings for action build and target FivviPro:/ { in_target = 1; next }
    /^Build settings / { in_target = 0 }
    in_target && $1 == key && $2 == "=" { sub(/^[[:space:]]*[^[:space:]]+ = /, ""); print; exit }
  ' <<<"$2"
}

# The one place that reads apps/Version.xcconfig here: a setting of the file both apps take their version from.
shared_setting() {
  sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*([^[:space:]]+)[[:space:]]*\$/\1/p" "$ROOT/apps/Version.xcconfig"
}

# E017 AC4 and AC8: a configuration resolves the version of apps/Version.xcconfig (the one Android reads), the default
# build number 1 and the bundle ID that apps/ios/README.md records as final.
version_and_identifier() {
  local settings=$1 shared default recorded id version number rc=0
  shared="$(shared_setting MARKETING_VERSION)"
  default="$(shared_setting CURRENT_PROJECT_VERSION)"
  version="$(setting_of MARKETING_VERSION "$settings")"
  number="$(setting_of CURRENT_PROJECT_VERSION "$settings")"
  id="$(setting_of PRODUCT_BUNDLE_IDENTIFIER "$settings")"
  # shellcheck disable=SC2016 # the backticks are the README's Markdown, not a command substitution
  recorded="$(sed -nE 's/.*bundle ID `([^`]+)` \(final.*/\1/p' README.md)"
  [[ "$shared" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "apps/Version.xcconfig: MARKETING_VERSION is not <major>.<minor>.<patch>: '$shared'"; rc=1; }
  [ "$version" = "$shared" ] \
    || { echo "E017 AC4: the app's version is '$version', not '$shared' of apps/Version.xcconfig, which Android reads"; rc=1; }
  [ "$default" = 1 ] && [ "$number" = "$default" ] \
    || { echo "E017 AC4: the default build number is '$number' ('$default' in apps/Version.xcconfig), not 1"; rc=1; }
  [ -n "$recorded" ] && [ "$id" = "$recorded" ] \
    || { echo "E017 AC8: bundle ID '$id' is not the final ID the README records: '$recorded'"; rc=1; }
  return "$rc"
}

# E017 AC4: a release run passes its build number from outside (`xcodebuild CURRENT_PROJECT_VERSION=<n>`); a number other
# than the default must come through to the Release configuration (it is CFBundleVersion).
build_number_from_outside() {
  local number
  number="$(setting_of CURRENT_PROJECT_VERSION "$(build_settings Release CURRENT_PROJECT_VERSION=42)")"
  [ "$number" = 42 ] \
    || { echo "E017 AC4: CURRENT_PROJECT_VERSION=42 on the command line resolves to '$number', not 42"; return 1; }
}

# Release talks HTTPS to the production API only: no App Transport Security exception in its Info.plist, and the app
# declares that it uses no non-exempt encryption, so App Store Connect asks no export compliance question per build
# (E017 AC1). It reports to the Sentry `ios` project in the EU region: its DSN's host is `<org>.ingest.de.sentry.io`.
release_configuration() {
  local settings url dsn plist
  settings="$(build_settings Release)"
  url="$(setting_of FIVVI_API_BASE_URL "$settings")"
  dsn="$(setting_of FIVVI_SENTRY_DSN "$settings")"
  plist="$(setting_of INFOPLIST_FILE "$settings")"
  production_base_url "$url" || { echo "E017 AC5: Release base URL is not https://<real host>/api: '$url'"; return 1; }
  [[ "$dsn" =~ ^https://[^@/]+@[a-z0-9]+\.ingest\.de\.sentry\.io/[0-9]+$ ]] \
    || { echo "Release Sentry DSN is not https://<key>@<org>.ingest.de.sentry.io/<project> (EU region): $dsn"; return 1; }
  grep -qE '^ *FIVVI_SENTRY_ENVIRONMENT = production$' <<<"$settings" \
    || { echo "Release does not report to Sentry as environment production"; return 1; }
  if plutil -extract NSAppTransportSecurity raw -o - "$plist" >/dev/null 2>&1; then
    echo "$plist has NSAppTransportSecurity: plain HTTP is for Debug only"
    return 1
  fi
  [ "$(plutil -extract ITSAppUsesNonExemptEncryption raw -o - "$plist" 2>/dev/null)" = false ] \
    || { echo "E017 AC1: $plist must set ITSAppUsesNonExemptEncryption to NO (HTTPS only, no own encryption)"; return 1; }
  version_and_identifier "$settings"
}

# Every remote Swift package the app resolves is on this list. The app has no analytics SDK (PostHog or other): product
# events are captured server-side (E009, OBSERVABILITY.md §1 "iOS"). Adding a package means adding it here, in review.
swift_packages() {
  local allowed resolved unexpected
  allowed='sentry-cocoa swift-collections swift-http-types swift-openapi-runtime swift-openapi-urlsession'
  resolved="$(jq -er '.pins[].identity' FivviPro.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved)" \
    || { echo "could not read the Swift packages from Package.resolved"; return 1; }
  unexpected="$(grep -vxF -f <(tr ' ' '\n' <<<"$allowed") <<<"$resolved" || true)"
  [ -z "$unexpected" ] || { echo "Swift packages not on the allowlist in scripts/test-ios.sh: $unexpected"; return 1; }
}

# Which UI tests each configuration of the test plan skips (FIVVI_SKIP_TESTS, see TestPlanSkips.swift), as
# `<configuration> <Class/test_name>` lines.
plan_skips() {
  jq -r '.configurations[] | .name as $config
    | (.options.environmentVariableEntries // [])[] | select(.key == "FIVVI_SKIP_TESTS") | .value
    | split(",")[] | gsub("^\\s+|\\s+$"; "") | select(. != "") | "\($config) \(.)"' FivviPro.xctestplan | sort -u
}

# `Class/test_name` of every test of the UI test target.
ui_tests() {
  find FivviProUITests -name '*.swift' -exec awk '
    FNR == 1 { class = "" }
    /^[[:space:]]*((private|fileprivate|internal|public|open|final)[[:space:]]+)*class[[:space:]]+[A-Za-z0-9_]+/ \
      && !/class[[:space:]]+(func|var|let)[[:space:]]/ {
      name = $0; sub(/^.*class[[:space:]]+/, "", name); sub(/[^A-Za-z0-9_].*$/, "", name); class = name }
    /^[[:space:]]*func[[:space:]]+test[A-Za-z0-9_]*\(/ {
      name = $0; sub(/^.*func[[:space:]]+/, "", name); sub(/\(.*$/, "", name); print class "/" name }' {} + | sort -u
}

# The text-dependent UI tests run in every configuration (nl and en); the others the test plan skips in some of them
# (apps/ios/README.md, "Which tests run in which locale"). A UI test the plan skips in every configuration would run
# nowhere, and a name that is no UI test (renamed, deleted) is a skip that does nothing. Only HelloUITests acts on the
# list. The plan's own `skippedTests` and `selectedTests`, which Xcode writes when a test is unticked, apply to every
# configuration, so they are refused: a test would run in no configuration without this check seeing it.
test_plan_coverage() {
  local tests skips configs rc=0 test skip filtered
  filtered="$(jq -r '.testTargets[] | .target.name as $target | ["skippedTests", "selectedTests"][] as $key
    | select((.[$key] // []) | length > 0) | "\($target) \($key)"' FivviPro.xctestplan)"
  while read -r skip; do
    [ -n "$skip" ] || continue
    echo "FivviPro.xctestplan: ${skip% *} has ${skip#* }, which applies to every configuration; skip tests per configuration in FIVVI_SKIP_TESTS"
    rc=1
  done <<<"$filtered"
  tests="$(ui_tests)"
  skips="$(plan_skips)"
  configs="$(jq '.configurations | length' FivviPro.xctestplan)"
  [ -n "$tests" ] || { echo "found no UI tests in FivviProUITests"; return 1; }
  while read -r skip; do
    [ -n "$skip" ] || continue
    grep -qxF "$skip" <<<"$tests" || { echo "FivviPro.xctestplan skips $skip, which is not a UI test"; rc=1; continue; }
    [[ "$skip" == HelloUITests/* ]] \
      || { echo "FivviPro.xctestplan skips $skip, but only HelloUITests acts on FIVVI_SKIP_TESTS"; rc=1; }
  done <<<"$(cut -d' ' -f2 <<<"$skips" | sort -u)"
  for test in $tests; do
    [ "$(grep -cE " $test\$" <<<"$skips")" -lt "$configs" ] \
      || { echo "$test is skipped in every configuration of FivviPro.xctestplan: it runs in no configuration"; rc=1; }
  done
  return "$rc"
}

# Xcode rewrites a property list in its own form, keys sorted (plutil's), when it touches one; commit them that way
# (#95).
plists_in_xcode_form() {
  local plist rc=0
  for plist in Config/*.plist; do
    plutil -convert xml1 -o - "$plist" | cmp -s - "$plist" \
      || { echo "$plist is not in Xcode's form; run: plutil -convert xml1 apps/ios/$plist"; rc=1; }
  done
  return "$rc"
}

# Xcode's string catalog sync, which every Xcode build and -exportLocalizations run, adds the strings a catalog lacks
# (Info.plist keys such as CFBundleName) and rewrites it. The generated catalogs must already have them, or a build
# changes tracked files (#95). A catalog the sync changed is restored, also when the run is interrupted.
CATALOGS=("$ROOT"/packages/i18n/generated/ios/*.xcstrings)
CATALOGS_BEFORE=.build/catalogs-before

# Puts the catalogs back as they were and shows what the sync changed; fails if it changed any.
restore_catalogs() {
  local catalog saved rc=0
  for catalog in "${CATALOGS[@]}"; do
    saved="$CATALOGS_BEFORE/$(basename "$catalog")"
    cmp -s "$saved" "$catalog" && continue
    echo "Xcode's catalog sync changes ${catalog#"$ROOT"/}: generate what it adds (packages/i18n/src/tools/xcstrings.ts)"
    diff -u "$saved" "$catalog" || true
    cp "$saved" "$catalog"
    rc=1
  done
  return "$rc"
}

catalog_sync() {
  local rc=0
  rm -rf "$CATALOGS_BEFORE"
  mkdir -p "$CATALOGS_BEFORE"
  cp "${CATALOGS[@]}" "$CATALOGS_BEFORE/"
  on_exit 'restore_catalogs || true'
  xcodebuild -exportLocalizations -project FivviPro.xcodeproj -scheme FivviPro \
    -localizationPath .build/Localizations -exportLanguage nl -exportLanguage en \
    -clonedSourcePackagesDirPath .build/SourcePackages -derivedDataPath .build/DerivedData -quiet \
    || { echo "xcodebuild -exportLocalizations failed"; rc=1; }
  ON_EXIT=""
  restore_catalogs || rc=1
  return "$rc"
}

step "SwiftLint"
"$SWIFTLINT" lint --strict --quiet
step "SwiftLint rejects literal text, colours and direct Sentry calls (lint/fixtures)"
lint_fixture lint/fixtures/LiteralText.swift no_literal_text
lint_fixture lint/fixtures/ColourLiteral.swift no_colour_literal
lint_fixture lint/fixtures/DirectSentry.swift no_direct_sentry
step "Every UI test runs in at least one test-plan configuration"
test_plan_coverage
step "Debug and Release configurations"
debug_configuration
production_base_url_fixtures
release_configuration
version_and_identifier "$(build_settings Debug)"
build_number_from_outside
plists_in_xcode_form
step "Swift packages (no analytics SDK)"
swift_packages
step "Xcode's string catalog sync leaves the generated catalogs unchanged"
catalog_sync

LOCALES="nl en"
BUILD_ARGS=(-project FivviPro.xcodeproj -scheme FivviPro -testPlan FivviPro
  -clonedSourcePackagesDirPath .build/SourcePackages -derivedDataPath .build/DerivedData)

# Builds the app and its tests once, for the simulator $1; the build log goes to .build/build-for-testing.log and its
# timing summary to the output and the job summary. Build/Products is restored from CI's cache, so an .xctestrun left
# by an earlier build (a renamed scheme or test plan) is deleted first: afterwards exactly this build's one remains.
PRODUCTS=.build/DerivedData/Build/Products
XCTESTRUN=""
build_for_testing() {
  local log=.build/build-for-testing.log timing found
  rm -f "$PRODUCTS"/*.xctestrun
  if ! xcodebuild build-for-testing "${BUILD_ARGS[@]}" -destination "id=$1" -showBuildTimingSummary CODE_SIGNING_ALLOWED=NO >"$log" 2>&1; then
    tail -n 300 "$log"
    return 1
  fi
  found="$(find "$PRODUCTS" -maxdepth 1 -name '*.xctestrun')"
  { [ -n "$found" ] && [ "$(wc -l <<<"$found")" -eq 1 ]; } \
    || { echo "expected exactly one .xctestrun in $PRODUCTS after build-for-testing, found: $(tr '\n' ' ' <<<"${found:-none}")"; return 1; }
  XCTESTRUN="$found"
  timing="$(sed -n '/^Build Timing Summary/,$p' "$log" | head -n 40)"
  [ -z "$timing" ] || { echo "$timing"; summary "### iOS build timing" "" '```' "$timing" '```' ""; }
}

# Runs the test plan on simulator $1 without building, both configurations (nl and en) in one run: the simulator is
# prepared and the app installed once, and the one result bundle has each locale's results. With a locale in $2, runs
# only that locale's configuration, into a bundle of its own.
RESULTS=.build/TestResults-nl-en.xcresult
run_tests() {
  local only=() bundle=$RESULTS
  if [ -n "${2:-}" ]; then
    only=(-only-test-configuration "$2")
    bundle=".build/TestResults-$2.xcresult"
  fi
  xcodebuild test-without-building -xctestrun "$XCTESTRUN" -destination "id=$1" ${only[@]+"${only[@]}"} \
    -resultBundlePath "$bundle" -quiet
}

# Runs nl on simulator $1 and en on simulator $2 at the same time, each with its output in a log, shown when it ends.
test_locales_in_parallel() {
  local status=0 nl_pid en_pid locale
  run_tests "$1" nl >.build/test-nl.log 2>&1 &
  nl_pid=$!
  run_tests "$2" en >.build/test-en.log 2>&1 &
  en_pid=$!
  wait "$nl_pid" || status=1
  wait "$en_pid" || status=1
  for locale in $LOCALES; do
    echo "::group::Tests in $locale"
    cat ".build/test-$locale.log"
    echo "::endgroup::"
  done
  return $status
}

# What the report needs to know when the run ends: the simulators to shut down and delete.
ios_cleanup() {
  report_steps || true
  stop_simulator || true
  delete_extra_simulator
}

udid="$(ios_simulator)"
[ -n "$udid" ] || die "no iPhone simulator${IOS_SIMULATOR:+ named $IOS_SIMULATOR} — run scripts/bootstrap.sh --mobile"
# on_exit holds one command: catalog_sync's restore ran and cleared it above, so this doesn't replace a live one.
on_exit 'ios_cleanup'
parallel=false
[ "${IOS_PARALLEL:-0}" != 1 ] || parallel=true
if $parallel; then create_extra_simulator || die "could not create a second simulator"; fi
extra="$EXTRA_SIMULATOR"

# The simulators boot while the app builds.
mkdir -p .build
rm -rf .build/TestResults*.xcresult
start_boot "$udid"
[ -z "$extra" ] || start_boot "$extra"
step "Build for testing (simulator $udid)"
build_for_testing "$udid"
await_boots || die "a simulator did not boot"
tests=0
if $parallel; then
  step "Unit and UI tests in nl and en at the same time (simulators $udid and $extra)"
  test_locales_in_parallel "$udid" "$extra" || tests=1
else
  step "Unit and UI tests in nl and en (simulator $udid)"
  run_tests "$udid" || tests=1
fi
for locale in $LOCALES; do
  bundle="$RESULTS"
  ! $parallel || bundle=".build/TestResults-$locale.xcresult"
  rows="$(slowest_tests "$bundle" 10 "$locale")"
  [ -z "$rows" ] || {
    echo "Slowest tests in $locale (seconds):"
    echo "$rows" | sed 's/^| /  /; s/ | / /; s/ |$//'
    summary "### Slowest iOS tests in $locale" "" "| Test | Seconds |" "|---|--:|" "$rows" ""
  }
done
[ "$tests" = 0 ] || exit 1
echo "✓ iOS"
