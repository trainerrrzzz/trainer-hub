# Releasing the native apps

How a build of **Fivvi Pro** (`apps/ios`, `apps/android`, app ID `app.fivvi.pro`) gets to testers, what the owner does and approves, and what the stores require before a public release (E017, [spec #169](https://github.com/fivvi-app/fivvi/issues/169)). Native apps have no over-the-air updates ([`ROADMAP.md`](../product/ROADMAP.md) R15): every fix for a tester is a new build, so building and shipping one is a single, repeatable step.

Status: the `release` environment, the secret scripts and this document are in place ([#189](https://github.com/fivvi-app/fivvi/issues/189)). The two release lanes (iOS to TestFlight, [#190](https://github.com/fivvi-app/fivvi/issues/190); Android to Play internal testing, [#191](https://github.com/fivvi-app/fivvi/issues/191)) and the release builds with their version and build number ([#188](https://github.com/fivvi-app/fivvi/issues/188)) come with their own tickets of #169; the sections below that depend on them say so. Where this document and the spec differ, the spec issue wins until the lanes are built; then fix this document.

## 1. Who does what

| | May | May not |
|---|---|---|
| **Owner** | Holds every account and secret, approves every release run, adds testers | |
| **Agent** | Change the lanes in a PR, start a run | Approve a run, read or ask for a secret, run `scripts/release-secrets.sh`, create an account |
| **Anyone else**, a fork's pull request included (the repo is public) | | Start a run or reach a secret |

Why this is safe: every release job runs in the GitHub environment **`release`**. The environment needs the owner's approval for each deployment and only deploys from `main` (`.github/environments/release.json`). Pull-request workflows and forks can't read its secrets. "An agent can't approve" is how the process is set up, not a rule GitHub enforces for the owner's token: agents work with the owner's admin `gh` token ([`docs/agents/tools.md`](../agents/tools.md#github)), so the environment turns off *Allow administrators to bypass* (`can_admins_bypass: false`) and every release job runs on `workflow_dispatch` only, never on `pull_request_target` (which runs with the base branch's secrets and code on a pull request's event). A secret never appears in the repo, a workflow log or an artifact: the scripts read it from a file outside the repo or a hidden prompt and pass it to `gh secret set` through a pipe, and the workflows must never echo one.

## 2. Set up once (the owner)

The order matters; the checklist in §8 has the account steps with what each unlocks.

1. **Apply the environment.** `scripts/github-settings.sh apply` (needs a token with admin rights on the repo; it is idempotent and also re-applies the ruleset, merge settings and labels). It creates `release` with you as the required reviewer and allows deployments from `main` only. Check it: `gh api repos/{owner}/{repo}/environments/release --jq '.protection_rules'`.
2. **Put the secrets in.** `scripts/release-secrets.sh` (run it yourself, in a terminal; never in an agent session). Values are never printed, never on a command line, never written to a file, and a key file inside the repo is refused.

   | Command | Secrets it sets | Where the values come from |
   |---|---|---|
   | `release-secrets.sh ios` | `IOS_DISTRIBUTION_CERTIFICATE` (base64 `.p12`), `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`, `IOS_PROVISIONING_PROFILE` (base64), `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_API_KEY` (the `.p8`) | The files from Apple's developer site (§8) and hidden prompts |
   | `release-secrets.sh android-keystore` | `ANDROID_UPLOAD_KEYSTORE` (base64), `ANDROID_UPLOAD_KEYSTORE_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS`, `ANDROID_UPLOAD_KEY_PASSWORD` | Makes the upload keystore (needs `keytool`, part of the JDK from `scripts/bootstrap.sh --api`) in `~/fivvi-release-keys/` unless `--dir` says otherwise, outside the repo; you choose its password at a hidden prompt |
   | `release-secrets.sh android` | The same four | A keystore you already have (`--keystore`) |
   | `release-secrets.sh play` | `PLAY_SERVICE_ACCOUNT_JSON` | The service-account key file (`--service-account`) |
   | `release-secrets.sh sentry` | `SENTRY_AUTH_TOKEN` | A hidden prompt; a token with only the scopes `project:releases` and `org:read` |
   | `release-secrets.sh list` | none | Prints which of the twelve are set, by name |

3. **Back up the upload keystore** and its password in your password manager. Play App Signing holds the app signing key; the upload key can be reset through Google if it is lost, but that takes time and a support request.

Renew by running the same command again; it replaces the value. The Apple Distribution certificate and the provisioning profile expire after a year ([decision 4](https://github.com/fivvi-app/fivvi/issues/169)): put a reminder in your calendar and run `release-secrets.sh ios` with the new files before they lapse, or the iOS lane fails at signing.

## 3. Starting a release run

The lanes ([#190](https://github.com/fivvi-app/fivvi/issues/190) for iOS, [#191](https://github.com/fivvi-app/fivvi/issues/191) for Android) are GitHub Actions workflows started by hand (`workflow_dispatch`) from `main`; a platform can be released alone.

1. Start the workflow for the platform from the Actions tab, or with `gh workflow run <workflow> --ref main` (the workflow names are set by the lane tickets [#190](https://github.com/fivvi-app/fivvi/issues/190) and [#191](https://github.com/fivvi-app/fivvi/issues/191)). An agent may do this too.
2. The run first checks that it is on `main`, then runs the native suites in both locales (`pnpm test:ios` on macOS, `pnpm test:android` and `pnpm test:maestro` on Linux), as [`TESTING.md §7`](TESTING.md#7-where-tests-run) requires. When a suite fails, nothing is uploaded.
3. **You approve.** The job waits in the `release` environment. GitHub emails you and shows *Review deployments*; check that the commit is the one you mean to ship, then approve. Nothing signs or uploads before that.
4. The run builds the Release configuration against the production address ([`ENVIRONMENTS.md`](ENVIRONMENTS.md#1-environments)), signs it, gives it the build number of the run, uploads it (TestFlight or the Play internal testing track) and uploads the crash symbols to Sentry.
5. Testers get it from the TestFlight app or the Play Store's internal-test link, usually within minutes (TestFlight first processes the build; App Store Connect emails you when it is done).

**Version and build number** (planned: the committed version and the build-number setting come with [#188](https://github.com/fivvi-app/fivvi/issues/188), the run-number scheme with the lanes [#190](https://github.com/fivvi-app/fivvi/issues/190) and [#191](https://github.com/fivvi-app/fivvi/issues/191); until they are built, a Release build keeps build number 1). Both apps will read the version (`0.1.0` for now) from one committed source. The build number will be the run number plus a fixed offset, higher than any earlier run (a re-run of a failed run gets a new one) and the same on both platforms for one run, so a bug report says the same number on iPhone and Android. Debug builds and CI test builds keep build number 1.

## 4. Adding testers (the owner)

- **iOS, internal testing:** add the person as a user in App Store Connect (*Users and Access*, role *Developer* or *Marketing* is enough), then add them to the internal group in TestFlight. Internal testers are limited to App Store Connect team members, and builds reach them without a review.
- **iOS, external testing** (testers outside the team, such as pilot trainers): needs *Beta App Review* of the first build, and with it a privacy policy URL and a demo account (§9). It is decided before the first pilot trainer joins ([spec decision 2](https://github.com/fivvi-app/fivvi/issues/169)).
- **Android:** add the email addresses to the internal testers list in Play Console (*Testing › Internal testing › Testers*), then send them the opt-in link. They must be signed in to the Play Store with that address.

Testers use production builds. Until pilot setup production has no data, and only allow-listed addresses can sign in ([F001](../product/FEATURES.md)).

## 5. Shipping a fix

A fix is a new run. Merge the change to `main`, start the lane, approve it, and testers receive a build with a higher number. There is nothing to patch on a phone and no way to push a change to an installed app. Until the new build reaches them, the trainer web app in the phone's browser is the fallback.

## 6. When an upload is rejected

Look at the error in the run's log first, then at App Store Connect (*TestFlight › the build*) or Play Console (*Release › the track*).

| Symptom | Cause | What to do |
|---|---|---|
| The lane fails at signing | Certificate or profile expired, or the profile doesn't match the bundle ID | Renew in Apple's developer site and run `release-secrets.sh ios` again; re-run the lane |
| App Store Connect: *bundle version already used* or Play: *version code already used* | A build number that isn't higher than an earlier upload | Start a new run: every run gets a higher number. If a build was uploaded by hand with a higher number, the offset in the lane has to be raised (a PR) |
| Authentication or `401` from the App Store Connect or Play API | A wrong or revoked API key, or a role that is too small (the App Store Connect key needs *App Manager*; the Play service account needs release rights for this app) | Fix it in the console and run the matching `release-secrets.sh` command again |
| Play: *you must upload the first bundle manually* | Google's API can't create an app's first release | Upload the bundle of a run by hand once (§8 Google) |
| Apple holds the build for export compliance | `ITSAppUsesNonExemptEncryption` is missing | The Release `Info.plist` will set it to `NO` (the app only uses HTTPS), with a test that checks it; both come with [#188](https://github.com/fivvi-app/fivvi/issues/188). Until then Apple asks the export-compliance question per build in App Store Connect; once the key and test exist, a hold means a change removed it: restore it |
| Beta App Review or Play review rejects the build | Missing privacy policy, demo account or declarations (§9) | Deliver the missing item, answer the reviewer, upload a new build if the app has to change |
| Crashes show unsymbolicated in Sentry | The symbol upload failed or the release name differs | Check the run's Sentry step and the `SENTRY_AUTH_TOKEN` scopes |

A rejected or broken upload never changes what testers already have. Never reuse a build number by hand to "replace" a build.

## 7. Costs

| Step | Cost | Who decides |
|---|---|---|
| Apple Developer Program (company membership) | Owner-reported as paid, unverified ([spec #169](https://github.com/fivvi-app/fivvi/issues/169)); the membership check in §8 confirms it and renewal depends on it | Owner |
| **Google Play Console enrollment** | **One-off US$25**, only if no verified account exists yet (the cost is stated in [spec #169](https://github.com/fivvi-app/fivvi/issues/169); [`ROADMAP.md §12`](../product/ROADMAP.md) has the distribution cost lines) | **Owner approves the spend before anything is enrolled** |
| GitHub Actions on the public repo (macOS included), TestFlight, Play internal testing, Sentry free plan | Free | |

## 8. Owner checklist

Only the owner does these. Agents never do them or ask for the secrets. Each step says what it unlocks.

**Apple**

| | Step | Unlocks |
|---|---|---|
| ☐ | Confirm the company Apple Developer Program membership is active and paid up, and that you are its Account Holder or Admin | Everything on iOS; an expired membership blocks every release |
| ☐ | Register the bundle ID `app.fivvi.pro` and create the app in App Store Connect: name *Fivvi Pro* (check that it is free), primary language Dutch, an SKU ([#148](https://github.com/fivvi-app/fivvi/issues/148)) | The identifier can't change after the first upload; the store name |
| ☐ | Accept any pending agreements in App Store Connect (the free-apps agreement is enough) | Uploads and TestFlight |
| ☐ | Create the Apple Distribution certificate and the App Store provisioning profile for the bundle ID | Signing in the iOS lane |
| ☐ | Create an App Store Connect API key with the *App Manager* role (not *Admin*) | The upload from the lane |
| ☐ | Run `scripts/release-secrets.sh ios` | The iOS lane can sign and upload |
| ☐ | Add yourself as an internal TestFlight tester (later the pilot trainers, §4) | Installing on your iPhone |

**Google**

| | Step | Unlocks |
|---|---|---|
| ☐ | Confirm whether a Google Play Console developer account exists and is verified. If not, enroll: **US$25 once, your approval as spend**. An organization account needs a D-U-N-S number; a personal account adds Play's closed-test rule before the public release (§9) | Everything on Android |
| ☐ | Create the app in Play Console: name *Fivvi Pro* (check that it is free), default language Dutch, free, an app, not a game ([#149](https://github.com/fivvi-app/fivvi/issues/149)) | The application ID and the store name |
| ☐ | Run `scripts/release-secrets.sh android-keystore`; back up the keystore and its password; enroll in Play App Signing | The upload key the lane signs with |
| ☐ | Upload the first App Bundle by hand in Play Console. Google's API can't create an app's first release; the Android lane makes that bundle as a run artifact, and it holds no secret | Every later release through the API |
| ☐ | Create a Google Cloud service account, grant it release rights for this app in Play Console, download its JSON key, run `scripts/release-secrets.sh play` | The lane can publish to the internal testing track |
| ☐ | Create the internal testers list (email addresses) in Play Console | Installing from the internal-test link (§4) |

**GitHub and Sentry**

| | Step | Unlocks |
|---|---|---|
| ☐ | `scripts/github-settings.sh apply` (or ask an agent to run it) | The `release` environment with your approval and `main`-only deployments |
| ☐ | Create a Sentry auth token for symbol uploads (scopes `project:releases` and `org:read` only), run `scripts/release-secrets.sh sentry` | Symbolicated crashes from tester builds |

## 9. Store requirements for the public release

Public App Store and Google Play listings are **not needed for go-live**; pilot trainers use TestFlight and Play internal testing ([`ROADMAP.md`](../product/ROADMAP.md) M8, M9). They are recorded here so later specs can plan for them. *Internal* is internal TestFlight and Play internal testing; *external* is external TestFlight (Beta App Review); *public* is the App Store and Play production listing. The stores change their rules: check the current store documentation when you reach a step.

| Requirement | Needed | Delivered by | Notes |
|---|---|---|---|
| **In-app account deletion** (Apple requires it for apps with account creation) | Public | Feature: [E014](../product/FEATURES.md) Privacy tooling, shown in *Profiel* ([TM-04](../design/information-architecture.md#51-structure), [IA §5.1](../design/information-architecture.md#51-structure)); not yet specified as tickets | The data side is [`retention-policy.md`](../legal/retention-policy.md) |
| **Google Play's web deletion link** (a URL where a user can ask for deletion without the app) | Public | Owner publishes a page; the request itself is handled by [E014](../product/FEATURES.md). No feature delivers the page yet: needs a spec before the public release | Entered in Play's data safety form |
| **App Store privacy details** ("nutrition label") | External (when App Store Connect asks) and public | Owner fills the form, matching [`docs/legal`](../legal/README.md) ([`sub-processors.md`](../legal/sub-processors.md), [`dpia-assessment.md`](../legal/dpia-assessment.md)); a spec for the app's data collection ([E014](../product/FEATURES.md) and the features that add data) keeps it true | What we tell Apple, Google and users must be the same |
| **Google Play data safety form** | Closed, open and production tracks; not internal testing | Owner, same sources and rule as the privacy details | Declared collection, sharing, encryption and deletion must match the app |
| **Privacy policy URL** | External and public | Owner publishes [`privacy-policy.nl.md`](../legal/privacy-policy.nl.md) and [`.en.md`](../legal/privacy-policy.en.md) (drafts; legal review and publication are open, [`ROADMAP.md`](../product/ROADMAP.md) §4.4) at a public address | Apple asks for it in the TestFlight test information and for the listing; Play asks for it in the app content declarations |
| **A demo account for App Review and Beta App Review** | External and public | Owner, with a decision: sign-in is by emailed code only and sign-up is closed ([F001](../product/FEATURES.md), [ADR-007](../decisions/ADR-007-authentication.md)). Options: a review mailbox whose codes the owner relays (they expire in 15 minutes), or a fixed code for one demo address in production only, which needs a new ADR. [Open question 3 of #169](https://github.com/fivvi-app/fivvi/issues/169) | Not needed for internal testing |
| **Age rating (Apple) and content rating (Google's questionnaire)** | Public (Apple asks before the first App Review submission; Play before the app can go to production) | Owner answers the questionnaires | |
| **Screenshots and listing texts in NL and EN** | Public. Earlier: TestFlight's *What to test* and Play's short description, minimal, in both languages | Listing: **open**, no spec plans the listings yet; the owner asks for one before the public release. Minimal texts: **open**, no ticket of #169 delivers them; the owner decides before the public release whether they become a ticket (strings would go in `packages/i18n`) | Screenshots use synthetic data only |
| **Play's target-API-level rule** (new apps and updates must target a recent Android API level, raised each year) | Every upload to the Play Console; check the deadline there each year | Android build configuration. **Open**: no ticket of #169 checks it; the owner decides before the public release whether a check becomes a ticket, and whoever bumps the SDK yearly keeps it | A build below the required level is rejected |
| **Play's closed-test rule for new personal developer accounts** (a closed test with a minimum number of testers for a minimum number of days before production access) | Public, only when the account is a personal one | Owner: run the closed test with the pilot trainers or the internal alpha testers in time. An organization account is exempt | Check the current numbers in Play Console. Decide personal or organization account before enrolling (§8) |

Related: [`TESTING.md §7`](TESTING.md#7-where-tests-run) (the full native suite before every release), [`ENVIRONMENTS.md`](ENVIRONMENTS.md) (the production address), [`OBSERVABILITY.md`](OBSERVABILITY.md) (Sentry and the release name), [`docs/agents/tools.md`](../agents/tools.md#what-needs-the-owner) (what stays with the owner).
