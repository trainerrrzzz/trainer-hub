# Fivvi Pro for iOS

The native iOS app (ADR-003): Swift 6 with strict concurrency, SwiftUI, iOS 17 and up, iPhone. For now it has one screen, *Hello*, which proves every layer is connected (E008, spec #34). It is the template for every later iOS screen.

```bash
scripts/bootstrap.sh --mobile   # once: checks Xcode and an iPhone simulator, installs the pinned SwiftLint
pnpm dev                        # the API, for running the app in the simulator
open apps/ios/FivviPro.xcodeproj
pnpm test:ios                   # what the iOS CI job runs
scripts/ios-device.sh nl        # the Debug app on your iPhone, in Dutch (A real iPhone, below)
```

## Layout

| Path | What |
|---|---|
| `FivviPro.xcodeproj` | Xcode project with folder-synchronized groups: a file added to one of the folders below is in its target, no project generator. Shared scheme `FivviPro` |
| `FivviPro/` | The app target. `App/` (entry point, configuration), `Hello/` (the screen and its view model), `Language/` (interface language), `Observability/` (crash and error reporting), `Strings/` (catalog lookup), `Theme/` (styles built from the design tokens) |
| `FivviProTests/` | Unit tests (XCTest), hosted in the app |
| `FivviProUITests/` | UI tests (XCUITest) |
| `FivviPro.xctestplan` | Two configurations, `nl` (region NL) and `en` (region GB), time zone Europe/Amsterdam. Text-dependent tests run in both, the locale-independent UI tests in `nl` only ([Tests](#tests); `TESTING.md §7.2`) |
| `Config/` | Per-configuration settings: `Debug.xcconfig` / `Release.xcconfig` and their Info.plist files |
| `lint/fixtures/` | Files that must fail SwiftLint, one per custom rule (not in any target) |
| `.build/` | Build output, resolved packages and SwiftLint (git-ignored) |

**Dependencies** (Swift packages, pinned in `FivviPro.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`): two local packages, the generated API client `FivviAPI` from [`packages/contract/swift`](../../packages/contract/README.md) and the design tokens `FivviDesignTokens` from [`packages/design-tokens/FivviDesignTokens`](../../packages/design-tokens/README.md#using-the-tokens-on-ios-and-android), and Apple's `swift-openapi-runtime` and `swift-openapi-urlsession` for its URLSession transport, plus `sentry-cocoa` for crash reporting ([Crash reporting](#crash-reporting)). Never hand-write API calls: change the contract and regenerate. `pnpm test:ios` fails on a remote package that isn't on its allowlist (`swift_packages` in `scripts/test-ios.sh`): the app has no analytics SDK.

**Strings:** `Localizable.xcstrings` and `InfoPlist.xcstrings` are referenced in place from [`packages/i18n/generated/ios`](../../packages/i18n/README.md#native-apps-e008), never copied or edited. The development region is `nl`; the localizations are `nl` and `en`. The display name under the icon, `CFBundleDisplayName`, comes from `app.name` through `InfoPlist.xcstrings`, and so does `CFBundleName`. Swift string extraction is off (`SWIFT_EMIT_LOC_STRINGS = NO`), but Xcode's string catalog sync (on a build in Xcode, and in `xcodebuild -exportLocalizations`) still adds every localizable Info.plist key a catalog lacks, `CFBundleName` among them, and rewrites the file. The generator writes those keys itself, so the sync leaves the generated catalogs unchanged; `pnpm test:ios` runs the sync and fails when it would change one. The Info.plists in `Config/` are in Xcode's own form (keys sorted, as `plutil -convert xml1` writes them), so Xcode doesn't reorder them; `pnpm test:ios` checks that too.

## A screen

`Hello/` is the pattern for every screen:

- A view model (`@Observable`, `@MainActor`) with a few states (`loading`, `loaded(greeting:)`, `failed`). It depends on the generated client's `APIProtocol`, which is the test seam: tests pass a stub, the app passes `Client` with `URLSessionTransport`. No hand-written wrapper.
- The view switches on the state and reads every text from `Catalog`, by `StringKey` or by a key the API sent. A key that isn't in the catalog is a failure, never a raw key on screen.
- Text uses Dynamic Type styles and wraps (`fixedSize(horizontal: false, vertical: true)` inside a `ScrollView`); buttons keep a 44 pt touch target; the screen's title has the header trait.
- Colours, text styles and spacing come from the design tokens ([Theme](#theme)).
- Accessibility identifiers name the elements for tests, with the same values as the Android test tags so one Maestro flow drives both apps: `hello.greeting`, `hello.loading`, `hello.error`, `hello.retry`.

## Theme

The app follows the E007 design tokens (ADR-015) in light and dark mode, from the generated `FivviDesignTokens` package, used in place:

- **Colours:** `Tokens.Colors` only, each an adaptive SwiftUI `Color` that follows the system appearance. A screen sits on `bgCanvas` with `textPrimary` text; the app's tint is `actionPrimaryBg`. A token colour pair a screen uses (text on a fill) is a contrast pair in `packages/design-tokens/tokens/contrast-pairs.json`.
- **Type:** the system font in the token's Dynamic Type style, `.font(.system(Tokens.TextStyle.body))`, with the style's weight from `packages/design-tokens/tokens/typography.json` (`display` and `label` are semibold); never a size.
- **Spacing and corners:** `Tokens.Spacing` and `Tokens.Radius`, with continuous corners.
- **Controls** stay native SwiftUI. `Theme/PrimaryActionStyle.swift` (`.buttonStyle(.primaryAction)`) is the filled primary action in `actionPrimaryBg` / `actionPrimaryBgPressed` with an `actionPrimaryFg` label.

The app follows the system's light or dark mode: nothing fixes its appearance (`UIUserInterfaceStyle` is unset, which `LaunchAppearanceTests` checks). `test_E008_AC6_usesTokenColoursInLightAndDark` launches the app in light and then dark mode and compares the screen's pixels (canvas, text, the retry button's fill and label) with the token colours resolved for that mode. It sets the mode with a Debug-only launch argument (`-UITestAppearance dark`, `Theme/LaunchAppearance.swift`) rather than `XCUIDevice.appearance`, which doesn't switch every simulator: an iOS 26.5 simulator stays light.

## Language

The app picks its interface language itself, by ADR-017's rule, and uses it for the screen and for the `locale` it sends to the API (`Language/InterfaceLanguage.swift`, mirroring `resolveInterfaceLanguage()` in `packages/i18n`):

1. The per-app language from iOS Settings (stored as `AppleLanguages` in the app's own defaults domain).
2. The first supported language in the device's preferred list (`Locale.preferredLanguages`): any `nl-*` is `nl-NL`, any `en-*` is `en`.
3. English.

`Catalog` reads that language's `nl.lproj` or `en.lproj` directly. iOS's own choice (`Bundle.preferredLocalizations`) can't decide it: the source language is Dutch, so a German-only phone would get Dutch. Format dates and numbers with `Catalog.formattingLocale`, which the hello screen puts in SwiftUI's environment: `en` formats as `en-GB` (`packages/i18n/README.md`).

## Configuration

| | Debug | Release |
|---|---|---|
| API base URL (`FIVVI_API_BASE_URL`) | `http://localhost:3000/api`, the local dev server as the simulator sees it | The production API over HTTPS, set in `Config/Release.xcconfig` |
| Plain HTTP | Allowed to local hosts only: App Transport Security's local-networking exception (`Config/Info-Debug.plist`) | Not allowed: `Config/Info.plist` has no App Transport Security exception; `pnpm test:ios` checks this |
| Sentry DSN (`FIVVI_SENTRY_DSN`) | Empty: no crash reporting; `pnpm test:ios` checks this | The Sentry `ios` project's DSN (EU region, `<org>.ingest.de.sentry.io`); `pnpm test:ios` checks this |
| Sentry environment (`FIVVI_SENTRY_ENVIRONMENT`) | `development` | `production` |

**`Config/Local.xcconfig`** (git-ignored, included last by `Debug.xcconfig`) holds your own Debug settings; never put them in a tracked file.

- **Since the Fivvi rename (21 October 2026)** its keys are `FIVVI_*`: rename any `TRAINER_HUB_*` key in your copy, and delete the old "Trainer Hub …" simulators.

| Setting | For |
|---|---|
| `FIVVI_API_BASE_URL` | A preview environment, or the dev server on your Mac from a phone on the LAN: `https:/$()/<preview-domain>/api` or `http:/$()/<your-mac>.local:3000/api` (`//` starts a comment in an xcconfig, hence `$()`). Without it a phone calls `localhost`, which is the phone itself |
| `DEVELOPMENT_TEAM` | Your Apple team ID, which signs a Debug build for a real iPhone ([A real iPhone](#a-real-iphone)) |
| `FIVVI_SENTRY_DSN` | Only for the manual crash reporting check ([Crash reporting](#crash-reporting)) |

Debug builds also accept `-FivviAPIBaseURL <url>` as a launch argument; the UI tests use it.

**Identifiers:** bundle ID `app.fivvi.pro` (provisional until the first store upload, E017). **Signing:** none in the repo. CI builds for the simulator without signing; a real-device Debug run signs with the `DEVELOPMENT_TEAM` in `Config/Local.xcconfig`. Don't choose a team under *Signing & Capabilities* in Xcode: that writes it into the project file.

## A real iPhone

`scripts/ios-device.sh [nl|en]` builds the Debug app, installs it on your iPhone and launches it; with `nl` or `en` it launches in that device language (`-AppleLanguages`). It uses the same Xcode as `pnpm test:ios` (`/Applications/Xcode.app` when `xcode-select` points to the Command Line Tools) and writes nothing outside `.build/`.

1. Once: pair the iPhone. Connect it with a cable, unlock it, tap *Trust*, and turn on Developer Mode (*Settings › Privacy & Security*). After that it also works over the same network.
2. Once: in `Config/Local.xcconfig`, set `DEVELOPMENT_TEAM = <your team ID>` and `FIVVI_API_BASE_URL` to an API the phone can reach (the table above). Run `pnpm dev` for the dev server on your Mac.
3. Unlock the phone and run `scripts/ios-device.sh nl`. It picks the paired iPhone from `xcrun devicectl list devices`; with several, set `IOS_DEVICE=<udid>`. The first launch of a build signed with a personal team asks you to trust the developer under *Settings › General › VPN & Device Management*.

Without a paired iPhone or a team, the script says what's missing; a locked phone fails the install or launch, and the script says to unlock it.

## Tests

`pnpm test:ios` (`scripts/test-ios.sh`) runs, in order, exactly what the `iOS` CI job runs:

1. SwiftLint with `--strict` on the app and its tests.
2. SwiftLint on each fixture in `lint/fixtures/`, which must fail on exactly the lines marked `// expect: <rule>`: `LiteralText.swift` (`no_literal_text`), `ColourLiteral.swift` (`no_colour_literal`) and `DirectSentry.swift` (`no_direct_sentry`).
3. That every UI test runs in at least one test-plan configuration (see "Which tests run in which locale" below), then the configurations: Debug's committed base URL is the local dev server (`http://localhost:3000/api`) and its Sentry DSN is empty; Release has an `https://…/api` base URL, no App Transport Security exception, a Sentry DSN in the EU region (`<org>.ingest.de.sentry.io`) and Sentry environment `production`. The Info.plists in `Config/` are in Xcode's form. Reading Release's settings takes one `xcodebuild -showBuildSettings` call, which resolves the Swift packages, so it uses the cached `.build/SourcePackages` (without it, it cloned them all again: 71 s on CI's first run).
4. The Swift packages in `Package.resolved` are all on the allowlist: no analytics SDK.
5. Xcode's string catalog sync (`xcodebuild -exportLocalizations`) leaves the generated catalogs unchanged. When it would change one, the step shows the change, restores the file and fails: make the generator write what Xcode adds ([Strings](#layout)).
6. One simulator build without signing (`build-for-testing`), then the test plan without building again, in **one** `test-without-building` run for both configurations (`nl` and `en`): the simulator is prepared and the app installed once, not once per locale. It runs on the newest iPhone simulator, or in a worktree on the worktree's own copy of it (`IOS_SIMULATOR="iPhone 17"` picks one by name; cleanup and `KEEP_DEVICE=1` in `TESTING.md §7.2`), also on CI (two simulators were slower on CI's 3-core runner); `IOS_PARALLEL=1` runs one run per locale at the same time on two simulators, the second a copy that is deleted afterwards. Results go to one bundle with both locales, `.build/TestResults-nl-en.xcresult` (with `IOS_PARALLEL=1`, `.build/TestResults-nl.xcresult` and `.build/TestResults-en.xcresult`). The run prints the duration of each step, the build timing summary (`.build/build-for-testing.log` has the whole log) and the ten slowest tests per locale, and puts them in the job summary on CI.

- **Unit tests** (`FivviProTests/`): the view model against `StubAPI`, a stub of `APIProtocol` that records the requested locale; the language rule with the same cases as `packages/i18n/src/locale.test.ts`; the configuration; the crash reporting scrubber and options (`ObservabilityTests`, `ObservabilityFieldTests`).
- **UI tests** (`FivviProUITests/`): the app against `StubServer`, an HTTP server in the test runner, so a test controls the answer (greeting, error, or holding it to keep the spinner on screen) and asserts the requested `locale`. `HelloScreen.launch` sets the device languages (`-AppleLanguages`), the per-app language (a Debug-only launch argument, because UI tests can't change iOS Settings), the text size and light or dark mode (a Debug-only launch argument). `ScreenColours` reads a screenshot's pixels in sRGB, for the theme test. `TouchTarget` checks the 44 pt minimum in whole device pixels, because XCTest reports pixel-aligned frames with floating-point error (`TouchTargetTests` covers it without launching the app). Tests wait for an element with `waitUntilExists(timeout:)` (`Polling`, checked every 50 ms), not `waitForExistence(timeout:)`: XCTest's takes about a second even when the element is already on screen, a fifth of a UI test run (`PollingTests`).
- **Which tests run in which locale** (E002 #105). The text-dependent tests run in `nl` **and** `en`: the greeting (`AC7_greetingIsHeading`, which also checks the greeting's text and the requested API locale), the error and retry text (`AC4_errorStateShowsRetry`, `AC4_unknownKeyShowsRetry`), the loading label (`AC5_loadingIndicatorHasLabel`) and the display name (`AC8_displayNameComesFromTheCatalog`), and so do the unit tests and `TouchTargetTests`, which take no time. The UI tests whose subject doesn't depend on the configuration's language run in `nl` only, because running them in `en` as well added minutes for no new proof: `AC3_unsupportedDeviceLanguageShowsEnglish`, `AC3_firstSupportedDeviceLanguageWins` and `AC3_perAppLanguageOverridesTheDevice` (they set the device or per-app languages themselves), `AC6_usesTokenColoursInLightAndDark` (token colours) and `AC7_largestTextSizeWraps` (layout; `nl` has the longer strings, so it is the harder case). A test plan can't select tests per configuration (`skippedTests` is per test target), so the `en` configuration lists the tests it skips in its `FIVVI_SKIP_TESTS` variable (`FivviPro.xctestplan`), and `HelloUITests` skips what it names (`TestPlanSkips`); the results show them as skipped. `pnpm test:ios` fails before building when a UI test is skipped in every configuration, or when the list names something that is not a `HelloUITests` test (renamed, deleted; only `HelloUITests` acts on the list), or when the plan's own `skippedTests` or `selectedTests` exist (Xcode writes them when a test is unticked; they apply to every configuration). To run a new test in one locale only, add it to that list; by default it runs in both.
- Expected copy is read from the generated catalog compiled into the test bundle (`TestCatalog`), never hard-coded. Each test-plan configuration also sets `FIVVI_TEST_LANGUAGE`; tests take the expected language from it, so a configuration whose language doesn't reach the app fails instead of testing the other language twice.
- Accessibility: `test_E008_AC7_largestTextSizeWraps` runs Xcode's accessibility audit (clipped text, Dynamic Type, hit regions) at the largest text size.

Name tests after the spec's acceptance criteria: `test_E008_AC4_retryLoadsGreeting` (`TESTING.md §5.1`).

## No hard-coded text

Every user-facing string comes from `packages/i18n` (`AGENTS.md`). SwiftLint's custom rule `no_literal_text` (`.swiftlint.yml`) fails on a string literal in `Text`, `Button`, `Label`, `Toggle`, `TextField`, `SecureField` or `Link`, and in `.navigationTitle` or an accessibility label, hint or value, and names the file and line. Pass a `String` from `Catalog` instead. The rule can't see literals passed through variables or other initialisers; review those by hand.

## No hard-coded colours

Every colour comes from the design tokens. SwiftLint's custom rule `no_colour_literal` (`.swiftlint.yml`) fails on a colour initialiser (`Color(red:green:blue:)`, `Color("Asset")`, `UIColor(…)`), a `#colorLiteral`, a system colour or style (`Color.red`, `UIColor.systemBackground`, `.background`) or its shorthand as an argument, value or result (`.foregroundStyle(.secondary)`, `.tint(.blue)`, `colors: [.red]`, `on ? .red : …`, `return .red`), and names the file and line. `Color.clear`, `.tint` and materials are allowed. Tests are excluded, because they resolve token colours to check the screen. Like `no_literal_text`, it can't see colours passed through variables; review those by hand.

## Crash reporting

Crashes, app hangs and watchdog terminations go to the Sentry `ios` project with sessions for the crash-free rate (E009, [OBSERVABILITY.md §1 "iOS"](../../docs/engineering/OBSERVABILITY.md#ios)). `Observability/` is the only code that talks to `sentry-cocoa`: `ErrorReporting.start()` at launch reads the DSN and environment from the build configuration and does nothing without a DSN, `ErrorReporting.capture(_:)` reports an error the app handled, and `Scrubber` applies the scrubbing rules in `beforeSend` and `beforeBreadcrumb`. SwiftLint's custom rule `no_direct_sentry` fails on `import Sentry` or `SentrySDK` anywhere else, apart from the tests of that module. Report through the module; never add an analytics SDK.

SwiftLint is pinned by version and SHA-256 in `scripts/_ios.sh` and downloaded to `.build/` on first use.

## Releasing

Builds for testers go through TestFlight; how a run is started and approved, how testers are added and what to do when an upload is rejected is in [`docs/engineering/RELEASE.md`](../../docs/engineering/RELEASE.md).
