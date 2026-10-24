# Fivvi Pro for Android

The native Android app (E008, ADR-003): Kotlin, Jetpack Compose and Material 3, Android 8.0 (API 26) and up. For now it has one screen, Hello, which is the template for every later screen.

## Run it

```bash
scripts/bootstrap.sh --mobile   # once: JDK, Android SDK, the `fivvi` emulator, Maestro
pnpm test:android               # what CI runs: ktlint, the release Sentry DSN, build, unit tests, Compose UI tests
pnpm test:maestro               # the local stack + e2e/maestro flows on the emulator, in nl-NL and en
scripts/android.sh emulator     # boot the emulator and leave it running for repeated runs
```

The scripts give the emulator `EMULATOR_BOOT_TIMEOUT` seconds to boot (default 300). If it exits or doesn't boot in time, they fail with the end of `build/emulator.log` and the emulator's acceleration check. Every boot is cold on your machine. On CI (`AVD_SNAPSHOT=1`) the first cold boot saves a snapshot of the booted emulator, the AVD with it is cached, and later runs load the snapshot in seconds; a snapshot that doesn't load within `SNAPSHOT_BOOT_TIMEOUT` seconds (default 90) is deleted and the emulator boots cold. `scripts/android.sh avd-key` prints what the cache is keyed by.

To try the app against your local web server (`pnpm dev`, port 3000), run `./gradlew installDebug` from this folder with the emulator running. Commands are in `TESTING.md §7.1`.

## Layout

| Path | What |
|---|---|
| `app/` | The app. `hello/` holds the screen: `HelloViewModel` (states `Loading`, `Loaded`, `Failed`) and `HelloScreen`; `theme/` holds `FivviTheme`; `observability/` holds crash reporting |
| `api/` | Compiles the generated Kotlin client in `packages/contract/kotlin/generated` in place (Retrofit, OkHttp, kotlinx.serialization). Never edit it here |
| `design-tokens/` | Compiles the generated Kotlin design tokens in `packages/design-tokens/kotlin/generated` in place (package `app.fivvi.designtokens`). Never edit them here |
| `lint/` | ktlint rules (`fivvi:no-literal-text`, `fivvi:no-colour-literal`, `fivvi:no-sentry-outside-observability`) and `fixtures/` that prove them |
| `gradle/libs.versions.toml` | Every dependency version |

## Rules

- **Strings** come only from `packages/i18n`: the app's resources include `packages/i18n/generated/android` in place (`values/` is nl-NL, `values-en/` English). The app label is `app.name`. `ktlintCheck` fails on a string literal in a Compose `Text` and names the file and line.
- **Language** (ADR-017, spec #34): the OS per-app language (API 33+, offered for `nl` and `en` by `res/xml/locales_config.xml`), else the first supported device language in order, else English. `MainActivity` applies it to the resources and the view model sends it to the API. Android's own resource match is never the input: the default resources are Dutch.
- **API** through the generated `app.fivvi.api` client only. The view model depends on the generated `HelloApi` interface, which tests replace with `FakeHelloApi` (`app/src/testShared`).
- **Since the Fivvi rename (21 October 2026)** the Gradle properties are `fivvi.*`: rename any `trainerhub.*` in `~/.gradle/gradle.properties` or your `-P` flags, and delete the old `trainer-hub` AVD and `~/.config/trainer-hub` (the scripts create `fivvi` and `~/.config/fivvi`).
- **Base URL** per build type, from `gradle.properties`: debug `fivvi.apiBaseUrl` (the local server as `10.0.2.2` from the emulator; override with `-Pfivvi.apiBaseUrl=https://<preview>/api/`), release `fivvi.releaseApiBaseUrl` (HTTPS only, or the release build fails). Plain HTTP is allowed only in debug (`src/debug`, network security config).
- **Test tags** are shared with the iOS accessibility identifiers and the Maestro flows: `hello.greeting`, `hello.loading`, `hello.error`, `hello.retry` (`HelloTags`). The app exposes them as resource ids, so Maestro finds them.
- **Theme** (ADR-015): wrap screens in `FivviTheme`. It takes the generated `LightColorScheme` or `DarkColorScheme` as the system's mode is, and `TokenShapes`; text keeps Material 3's type scale in Roboto, so use `MaterialTheme.typography` with the token names (`title1`, `body`), never a font size. No dynamic colour (Material You). Colours come from `MaterialTheme.colorScheme`; for what Material doesn't cover (sessions, status), from `LightTokenColors` or `DarkTokenColors` for the same mode. No screen needs those yet: the first one adds them to `FivviTheme`, so screens don't each pick the mode. Spacing comes from `Spacing`. `ktlintCheck` fails on a hard-coded colour (`Color(…)`, `Color.Red`, `colorResource`, Material's own or dynamic colour schemes) and names the file and line.
- **Crash reporting** (E009): only `observability/` calls the Sentry SDK (`Observability`); `ktlintCheck` fails on Sentry anywhere else. It is off without a DSN, and debug builds have none unless you pass `-Pfivvi.sentryDsn=…`. Release builds carry the `android` project's DSN (`fivvi.releaseSentryDsn`); `checkReleaseSentryDsn` fails `pnpm test:android` and every release build unless its host is in the EU region (`<org>.ingest.de.sentry.io`). No analytics SDK in the app: `checkNoAnalyticsSdk` fails the build. Details in [`OBSERVABILITY.md`](../../docs/engineering/OBSERVABILITY.md) §1 "Android".

## Behind a company proxy

Some TLS-inspecting proxies (e.g. Zscaler) break Java downloads. The scripts handle the two cases seen so far:

- Java doesn't trust the proxy's CA: on macOS, `scripts/_android.sh` builds `~/.config/fivvi/java-cacerts` from the JDK's CAs plus the System keychain and sets `JAVA_TOOL_OPTIONS` for its own commands. Run Gradle through the scripts, or set the same option yourself.
- The proxy blocks jars on `repo.maven.apache.org`: `settings.gradle.kts` uses Maven Central's `repo1.maven.org` host instead.

## Releasing

Builds for testers go through Play internal testing; how a run is started and approved, how testers are added and what to do when an upload is rejected is in [`docs/engineering/RELEASE.md`](../../docs/engineering/RELEASE.md).
