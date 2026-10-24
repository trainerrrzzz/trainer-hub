import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const SCRIPTS = join(import.meta.dirname, '..');
const lib = (expression) =>
  execFileSync('bash', ['-c', `source "${SCRIPTS}/_lib.sh"; ${expression}`], {
    encoding: 'utf8',
  }).trim();
const succeeds = (expression) =>
  spawnSync('bash', ['-c', `source "${SCRIPTS}/_lib.sh"; ${expression}`]).status === 0;

describe('naming rules', () => {
  it('accepts ticket and plain branches, rejects others', () => {
    for (const name of [
      'feature/57-hold-a-spot',
      'fix/12-hold-expiry',
      'chore/ci-cache',
      'docs/roadmap',
    ]) {
      assert.ok(succeeds(`is_branch_name ${name}`), name);
    }
    for (const name of ['feature/F031-open-gym', 'feat/57-x', 'feature/57_Hold', 'main']) {
      assert.ok(!succeeds(`is_branch_name ${name}`), name);
    }
  });

  it('reads the issue number from a ticket branch', () => {
    assert.equal(lib('branch_issue feature/57-hold-a-spot'), '57');
    assert.equal(lib('branch_issue docs/roadmap'), '');
  });

  it('accepts Conventional Commits with an ID scope', () => {
    for (const subject of [
      'feat(F031): hold a spot',
      'fix: keep the hold',
      'docs(E006): record the check',
      'feat!: drop v0',
    ]) {
      assert.ok(succeeds(`is_conventional "${subject}"`), subject);
    }
    for (const subject of [
      'Add a thing',
      'feat:missing space',
      'feature(F031): wrong type',
      `feat: ${'x'.repeat(100)}`,
    ]) {
      assert.ok(!succeeds(`is_conventional "${subject}"`), subject);
    }
  });

  it('turns issue titles into branch slugs', () => {
    assert.equal(
      lib('slugify "[F031] Hold a spot while verifying!"'),
      'hold-a-spot-while-verifying',
    );
  });

  it('gives each worktree a stable e2e port, and the main checkout 3100', () => {
    const port = Number(lib('e2e_port /tmp/a'));
    assert.equal(Number(lib('e2e_port /tmp/a')), port);
    assert.ok(port >= 3200 && port < 3900);
    assert.equal(lib('e2e_port "$MAIN_ROOT"'), '3100');
  });
});

describe('iOS toolchain (_ios.sh)', () => {
  it('fails loudly when DEVELOPER_DIR is set but not a usable Xcode, instead of using another Xcode', () => {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `source "${SCRIPTS}/_lib.sh"; source "${SCRIPTS}/_ios.sh"; use_xcode; echo "status=$? dir=$DEVELOPER_DIR"`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, DEVELOPER_DIR: '/nonexistent/Xcode_0.0.app/Contents/Developer' },
      },
    );
    assert.match(
      result.stdout,
      /status=1 dir=\/nonexistent\/Xcode_0\.0\.app\/Contents\/Developer$/m,
    );
    assert.match(
      result.stderr,
      /DEVELOPER_DIR=\/nonexistent\/Xcode_0\.0\.app\/Contents\/Developer is not a usable Xcode/,
    );
  });
});

describe('CI path filters (scripts/native-jobs.sh, run by ci.yml)', () => {
  // The native jobs scripts/native-jobs.sh runs for the changed paths on stdin, as {ios, android}.
  const nativeJobs = (paths, args = []) => {
    const result = spawnSync(join(SCRIPTS, 'native-jobs.sh'), args, {
      input: paths.join('\n'),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return {
      ...Object.fromEntries(
        result.stdout
          .trim()
          .split('\n')
          .map((line) => line.split('=')),
      ),
      log: result.stderr,
    };
  };
  const runs = (job, path) => nativeJobs([path])[job] === 'true';

  it('E008 AC9: the iOS job runs for the app and its generated inputs, including the Swift design tokens', () => {
    for (const path of [
      'apps/ios/FivviPro/Hello/HelloView.swift',
      'apps/Version.xcconfig',
      'packages/contract/swift/Sources/FivviAPI/Generated/Client.swift',
      'packages/i18n/generated/ios/Localizable.xcstrings',
      'packages/design-tokens/FivviDesignTokens/Package.swift',
      'packages/design-tokens/FivviDesignTokens/Sources/FivviDesignTokens/Generated/Colors.swift',
      'scripts/test-ios.sh',
      'scripts/_ios.sh',
    ]) {
      assert.ok(runs('ios', path), path);
    }
    for (const path of [
      'docs/product/FEATURES.md',
      'packages/design-tokens/generated/web/tokens.css',
      'packages/design-tokens/kotlin/generated/app/fivvi/designtokens/Colors.kt',
      'packages/i18n/generated/android/values/strings.xml',
    ]) {
      assert.ok(!runs('ios', path), path);
    }
  });

  it('E008 AC9: the Android job runs for the app and its generated inputs, including the Kotlin design tokens', () => {
    for (const path of [
      'apps/android/app/src/main/kotlin/app/fivvi/pro/MainActivity.kt',
      'apps/Version.xcconfig',
      'packages/contract/kotlin/generated/app/fivvi/api/apis/HelloApi.kt',
      'packages/i18n/generated/android/values/strings.xml',
      'packages/design-tokens/kotlin/generated/app/fivvi/designtokens/Colors.kt',
      'e2e/maestro/hello.yaml',
      'scripts/android.sh',
      'scripts/_android.sh',
      'scripts/maestro.sh',
    ]) {
      assert.ok(runs('android', path), path);
    }
    for (const path of [
      'docs/product/FEATURES.md',
      'packages/design-tokens/generated/web/tokens.css',
      'packages/design-tokens/FivviDesignTokens/Sources/FivviDesignTokens/Generated/Colors.swift',
      'packages/i18n/generated/ios/Localizable.xcstrings',
    ]) {
      assert.ok(!runs('android', path), path);
    }
  });

  it('E002 #91: shared files (ci.yml, _lib.sh, this list) run neither native job on their own', () => {
    const jobs = nativeJobs([
      '.github/workflows/ci.yml',
      'scripts/_lib.sh',
      'scripts/native-jobs.sh',
    ]);
    assert.equal(jobs.ios, 'false');
    assert.equal(jobs.android, 'false');
  });

  it('E002 #91: a push to main runs a native job only when its own paths changed, so main warms the caches', () => {
    const ios = nativeJobs(['apps/ios/FivviPro/App.swift'], ['--event', 'push']);
    assert.equal(ios.ios, 'true');
    assert.equal(ios.android, 'false');
    const android = nativeJobs(['apps/android/app/build.gradle.kts'], ['--event', 'push']);
    assert.equal(android.ios, 'false');
    assert.equal(android.android, 'true');
    const contract = nativeJobs(['packages/contract/openapi.json'], ['--event', 'push']);
    assert.equal(contract.ios, 'true');
    assert.equal(contract.android, 'true');
  });

  it('E002 #91: a push to main that touches no native path, or only ci.yml and _lib.sh, runs neither native job', () => {
    for (const paths of [
      ['docs/product/FEATURES.md'],
      ['.github/workflows/ci.yml', 'scripts/_lib.sh', 'scripts/native-jobs.sh'],
    ]) {
      const jobs = nativeJobs(paths, ['--event', 'push']);
      assert.equal(jobs.ios, 'false', paths.join(' '));
      assert.equal(jobs.android, 'false', paths.join(' '));
      assert.match(jobs.log, /no relevant changes/);
    }
  });

  it('E002 #91: workflow_dispatch and the run-native label run both native jobs, whatever changed', () => {
    for (const args of [
      ['--event', 'workflow_dispatch'],
      ['--event', 'pull_request', '--run-native'],
    ]) {
      const jobs = nativeJobs(['docs/product/FEATURES.md'], args);
      assert.equal(jobs.ios, 'true', args.join(' '));
      assert.equal(jobs.android, 'true', args.join(' '));
    }
    const pr = nativeJobs(['docs/product/FEATURES.md'], ['--event', 'pull_request']);
    assert.equal(pr.ios, 'false');
    assert.equal(pr.android, 'false');
  });

  const ci = () => readFileSync(join(SCRIPTS, '../.github/workflows/ci.yml'), 'utf8');

  it('E002 #91: the job names stay, and ci.yml has no path list of its own', () => {
    assert.match(ci(), /^ {2}workflow_dispatch:/m);
    assert.doesNotMatch(ci(), /^ +decide /m);
    assert.deepEqual(
      [...ci().matchAll(/^ {4}name: (.+)$/gm)].map((match) => match[1]),
      ['Detect changes', 'Checks (Linux)', 'E2E (Linux)', 'iOS', 'Android'],
    );
  });

  // Runs the `Filter paths` step of the Detect changes job as it is in ci.yml, in a repo whose last commit changed
  // `changed`, with the event and label the workflow would pass; returns what it writes to $GITHUB_OUTPUT.
  // `earlier` are paths changed by a commit before it, in the same group: a merge queue group holds the commits of
  // every queued PR on top of its base commit (the event's base_sha).
  const detectChanges = ({
    event,
    label = false,
    changed = ['docs/product/FEATURES.md'],
    earlier = [],
    noMergeBase = false,
  }) => {
    const lines = ci().split('\n');
    const start = lines.findIndex((line) => line.includes('name: Filter paths'));
    const run = lines.findIndex((line, i) => i > start && /^ +run: \|$/.test(line));
    const body = [];
    for (const line of lines.slice(run + 1)) {
      if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break;
      body.push(line.slice(10));
    }
    const env = (name) => ci().match(new RegExp(`^ +${name}: (.+)$`, 'm'))[1];
    const expression = (inner) => `\${{ ${inner} }}`;
    assert.equal(env('EVENT'), expression('github.event_name'));
    assert.equal(
      env('RUN_NATIVE'),
      expression("contains(github.event.pull_request.labels.*.name, 'run-native')"),
    );
    assert.equal(env('MERGE_BASE'), expression('github.event.merge_group.base_sha'));

    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'detect-')));
    try {
      const git = (...args) =>
        execFileSync(
          'git',
          ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
          { encoding: 'utf8' },
        );
      git('init', '--quiet', '--initial-branch=main');
      cpSync(SCRIPTS, join(repo, 'scripts'), { recursive: true });
      for (const dir of ['apps/ios', 'apps/android'])
        mkdirSync(join(repo, dir), { recursive: true });
      writeFileSync(join(repo, 'apps/ios/.keep'), '');
      writeFileSync(join(repo, 'apps/android/.keep'), '');
      git('add', '.');
      git('commit', '--quiet', '-m', 'chore: base');
      if (earlier.length > 0) {
        for (const path of earlier) {
          mkdirSync(join(repo, path, '..'), { recursive: true });
          writeFileSync(join(repo, path), 'earlier\n');
        }
        git('add', '.');
        git('commit', '--quiet', '-m', 'chore: earlier');
      }
      for (const path of changed) {
        mkdirSync(join(repo, path, '..'), { recursive: true });
        writeFileSync(join(repo, path), 'changed\n');
      }
      git('add', '.');
      git('commit', '--quiet', '-m', 'chore: change');
      const before = event === 'push' ? git('rev-parse', 'HEAD~1').trim() : '';
      const mergeBase =
        event === 'merge_group' && !noMergeBase
          ? git('rev-parse', earlier.length > 0 ? 'HEAD~2' : 'HEAD~1').trim()
          : '';
      const output = join(repo, '..', `${basename(repo)}.out`);
      writeFileSync(output, '');
      const result = spawnSync('bash', ['-c', body.join('\n')], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: repo,
          EVENT: event,
          BEFORE: before,
          MERGE_BASE: mergeBase,
          RUN_NATIVE: String(label),
          GITHUB_OUTPUT: output,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const outputs = Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .map((line) => line.split('=')),
      );
      rmSync(output);
      return outputs;
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  };

  it("E002 #119: a merge group is compared with the queue's base commit, so native jobs skip when no native path changed", () => {
    assert.deepEqual(detectChanges({ event: 'merge_group' }), { ios: 'false', android: 'false' });
    assert.deepEqual(
      detectChanges({ event: 'merge_group', changed: ['.github/workflows/ci.yml'] }),
      { ios: 'false', android: 'false' },
    );
  });

  it('E002 #119: a merge group runs a native job when a native path changed in it', () => {
    assert.deepEqual(detectChanges({ event: 'merge_group', changed: ['apps/ios/App.swift'] }), {
      ios: 'true',
      android: 'false',
    });
    assert.deepEqual(detectChanges({ event: 'merge_group', changed: ['apps/android/App.kt'] }), {
      ios: 'false',
      android: 'true',
    });
  });

  it("E002 #119: a merge group with several queued PRs looks at every commit since the base, not only the last one's", () => {
    assert.deepEqual(
      detectChanges({
        event: 'merge_group',
        earlier: ['apps/ios/App.swift'],
        changed: ['docs/product/FEATURES.md'],
      }),
      { ios: 'true', android: 'false' },
    );
  });

  it('E002 #119: a merge group without a base commit treats every path as changed', () => {
    assert.deepEqual(detectChanges({ event: 'merge_group', noMergeBase: true }), {
      ios: 'true',
      android: 'true',
    });
  });

  it('E002 #91: ci.yml passes the event and the run-native label to scripts/native-jobs.sh', () => {
    assert.deepEqual(detectChanges({ event: 'pull_request' }), { ios: 'false', android: 'false' });
    assert.deepEqual(detectChanges({ event: 'pull_request', label: true }), {
      ios: 'true',
      android: 'true',
    });
    assert.deepEqual(detectChanges({ event: 'workflow_dispatch' }), {
      ios: 'true',
      android: 'true',
    });
    assert.deepEqual(
      detectChanges({ event: 'push', changed: ['apps/ios/App.swift', 'apps/android/App.kt'] }),
      { ios: 'true', android: 'true' },
    );
    assert.deepEqual(detectChanges({ event: 'push', changed: ['apps/ios/App.swift'] }), {
      ios: 'true',
      android: 'false',
    });
    assert.deepEqual(detectChanges({ event: 'push' }), { ios: 'false', android: 'false' });
    assert.deepEqual(detectChanges({ event: 'push', changed: ['.github/workflows/ci.yml'] }), {
      ios: 'false',
      android: 'false',
    });
    assert.deepEqual(detectChanges({ event: 'pull_request', changed: ['apps/ios/App.swift'] }), {
      ios: 'true',
      android: 'false',
    });
    assert.deepEqual(
      detectChanges({ event: 'pull_request', changed: ['.github/workflows/ci.yml'] }),
      {
        ios: 'false',
        android: 'false',
      },
    );
  });
});

describe('E002 #119 CI on the merge queue (merge_group)', () => {
  const ci = readFileSync(join(SCRIPTS, '../.github/workflows/ci.yml'), 'utf8');

  it('runs on merge_group, for main only, so the required checks report on the queue branch', () => {
    assert.match(
      ci,
      /^ {2}merge_group:\n {4}types: \[checks_requested\]\n {4}branches: \[main\]$/m,
    );
  });

  it('never cancels a merge group run: only a new push to a PR cancels the run it replaces', () => {
    assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  });
});

describe('E002 #91 the native jobs in ci.yml', () => {
  const ci = readFileSync(join(SCRIPTS, '../.github/workflows/ci.yml'), 'utf8');
  const ios = ci.slice(ci.indexOf('\n  ios:\n'), ci.indexOf('\n  android:\n'));
  const android = ci.slice(ci.indexOf('\n  android:\n'));

  it('caches the iOS DerivedData and Swift packages by Package.resolved, Xcode version and runner OS', () => {
    assert.match(ios, /apps\/ios\/\.build\/DerivedData/);
    assert.match(ios, /apps\/ios\/\.build\/SourcePackages/);
    const key = ios.match(/^ +key: (ios-build-.+)$/m)?.[1] ?? '';
    assert.match(key, /runner\.os/);
    assert.match(key, /steps\.xcode\.outputs\.version/);
    assert.match(key, /hashFiles\('apps\/ios\/.*Package\.resolved'\)/);
    assert.match(
      ios,
      /restore-keys: \|\n +ios-build-\$\{\{ runner\.os \}\}-\$\{\{ steps\.xcode\.outputs\.version \}\}-\n/,
    );
  });

  it('runs the iOS tests through scripts/test-ios.sh and uploads the result bundles on failure', () => {
    assert.match(ios, /run: scripts\/test-ios\.sh/);
    assert.match(ios, /if: failure\(\)[\s\S]*apps\/ios\/\.build\/TestResults-\*\.xcresult/);
  });

  it('caches the AVD with its snapshot, boots with snapshots on and stops the emulator before the cache is saved', () => {
    assert.match(android, /android\.sh avd-key/);
    assert.match(
      android,
      /path: ~\/\.android\/avd\n +key: avd-v2-\$\{\{ runner\.os \}\}-\$\{\{ steps\.avd\.outputs\.key \}\}/,
    );
    const boot = android.slice(android.indexOf('name: Boot the emulator'));
    assert.match(boot.slice(0, boot.indexOf('- name:', 10)), /AVD_SNAPSHOT: '1'/);
    const order = [
      'name: Cache the emulator',
      'name: Boot the emulator',
      'name: Stop the emulator',
    ].map((name) => android.indexOf(name));
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
    );
    assert.ok(order.every((index) => index > 0));
    assert.match(
      android,
      /name: Stop the emulator\n +if: always\(\)\n +run: scripts\/android\.sh stop\n/,
    );
  });

  it('prints the step durations of both native jobs in the job summary', () => {
    for (const section of [ios, android]) {
      assert.match(section, /actions: read/);
      assert.match(
        section,
        /if: always\(\)\n +continue-on-error: true\n +env:\n +GH_TOKEN: \$\{\{ github\.token \}\}\n +run: scripts\/step-timings\.sh/,
      );
    }
  });
});

describe('iOS local Swift packages (apps/ios)', () => {
  it('E008 #57: every local package the Xcode project links has its own package identity', () => {
    // Xcode names a local package by its directory name, case-insensitively: two local packages whose
    // directories share a name (the design tokens and the API client were both `swift`) can't both link.
    const root = join(SCRIPTS, '..');
    const ios = join(root, 'apps/ios');
    const project = readFileSync(join(ios, 'FivviPro.xcodeproj/project.pbxproj'), 'utf8');
    const packages = [
      ...project.matchAll(/isa = XCLocalSwiftPackageReference;\s*relativePath = "?([^";]+)"?;/g),
    ].map(([, dir]) => join(ios, dir));
    for (const dir of ['packages/contract/swift', 'packages/design-tokens/FivviDesignTokens']) {
      assert.ok(packages.includes(join(root, dir)), `the app links ${dir}`);
    }
    for (const dir of packages) {
      assert.ok(existsSync(join(dir, 'Package.swift')), `${dir} has a Package.swift`);
    }
    const identities = packages.map((dir) => basename(dir).toLowerCase());
    assert.deepEqual([...new Set(identities)], identities, `package identities: ${identities}`);
  });
});

describe('usage', () => {
  it('prints the commands of every script, never its code', () => {
    for (const script of [
      'flow',
      'issue',
      'wt',
      'pr',
      'skills',
      'agents',
      'codex-agent',
      'risk',
      'github-settings',
      'emails',
      'android',
      'maestro',
    ]) {
      const result = spawnSync(join(SCRIPTS, `${script}.sh`), [], { encoding: 'utf8' });
      assert.equal(result.status, 1, script);
      assert.match(result.stderr, new RegExp(`${script}\\.sh [\\w<]`), script);
      assert.doesNotMatch(result.stderr, /set -euo|source /, script);
    }
  });
});

const script = (path, body) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
};

// A fake Android SDK in its own folder per test. Its tools find AVDs the way the real ones do: avdmanager
// (cmdline-tools) in ANDROID_AVD_HOME or ~/.android/avd, the emulator in ANDROID_AVD_HOME or, when XDG_CONFIG_HOME is
// set (GitHub's Ubuntu runners), under that. sdkmanager logs its arguments and installs cmdline-tools when asked; without
// them in the SDK, setup takes sdkmanager from (fake) Homebrew.
describe('android.sh setup', () => {
  const dirs = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const fakeSdk = ({ cmdlineTools = true, emulatorFindsAvds = true } = {}) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'android-setup-')));
    dirs.push(base);
    const home = join(base, 'home');
    const sdk = join(base, 'sdk');
    const log = join(base, 'sdkmanager.log');
    const avdmanager = `dir="\${ANDROID_AVD_HOME:-$HOME/.android/avd}"
while [ $# -gt 0 ]; do [ "$1" = --name ] && name="$2"; shift; done
mkdir -p "$dir/$name.avd" && touch "$dir/$name.ini"
printf "%s\\n" "disk.dataPartition.path=<temp>" "disk.dataPartition.size=6G" "hw.cpu.ncore=4" >"$dir/$name.avd/config.ini"`;
    const sdkmanager = `echo "$*" >>"${log}"
for arg; do case "$arg" in --sdk_root=*) root="\${arg#--sdk_root=}" ;; esac; done
case " $* " in *" cmdline-tools;latest "*)
  mkdir -p "$root/cmdline-tools/latest/bin" && printf '%s\\n' '#!/usr/bin/env bash' '${avdmanager.replaceAll("'", "'\\''")}' >"$root/cmdline-tools/latest/bin/avdmanager"
  chmod +x "$root/cmdline-tools/latest/bin/avdmanager" ;;
esac`;
    mkdirSync(join(sdk, 'platform-tools'), { recursive: true });
    mkdirSync(join(base, 'jdk'));
    if (cmdlineTools) {
      script(join(sdk, 'cmdline-tools/latest/bin/sdkmanager'), sdkmanager);
      script(join(sdk, 'cmdline-tools/latest/bin/avdmanager'), avdmanager);
    }
    script(
      join(base, 'brew/share/android-commandlinetools/cmdline-tools/latest/bin/sdkmanager'),
      sdkmanager,
    );
    script(join(base, 'bin/brew'), `[ "$1" = --prefix ] && echo "${join(base, 'brew')}"; exit 0`);
    script(
      join(sdk, 'emulator/emulator'),
      emulatorFindsAvds
        ? `dir="\${ANDROID_AVD_HOME:-\${XDG_CONFIG_HOME:+$XDG_CONFIG_HOME/.android/avd}}"
[ "$1" = -list-avds ] && for f in "\${dir:-$HOME/.android/avd}"/*.ini; do [ -e "$f" ] && basename "$f" .ini; done
exit 0`
        : 'exit 0',
    );
    script(join(base, 'bin/java'), 'echo "openjdk version \\"21\\"" >&2');
    script(join(home, '.maestro/bin/maestro'), 'echo 2.11.0');
    const env = {
      PATH: `${join(base, 'bin')}:${process.env.PATH}`,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      ANDROID_HOME: sdk,
      JAVA_HOME: join(base, 'jdk'),
    };
    const setup = () =>
      spawnSync(join(SCRIPTS, 'android.sh'), ['setup'], { encoding: 'utf8', env });
    const installed = () => readFileSync(log, 'utf8');
    const config = join(home, '.android/avd/fivvi.avd/config.ini');
    return { env, setup, installed, config };
  };

  it('creates an AVD that the emulator finds in later steps, also with XDG_CONFIG_HOME set', () => {
    const { env, setup } = fakeSdk();
    const result = setup();
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const found = spawnSync(
      'bash',
      [
        '-c',
        `source "${SCRIPTS}/_lib.sh"; source "${SCRIPTS}/_android.sh"; android_env; avd_exists`,
      ],
      { encoding: 'utf8', env },
    );
    assert.equal(found.status, 0, found.stdout + found.stderr);
  });

  it('fails when the emulator still cannot find the AVD it created', () => {
    const result = fakeSdk({ emulatorFindsAvds: false }).setup();

    assert.equal(result.status, 1);
    assert.match(result.stdout, /created, but the emulator can't find it/);
  });

  // GitHub's runners have 2 cores; the device profile asks for 4. The data partition stays as the emulator wants it:
  // it creates 6 GB on the first boot whatever config.ini or -partition-size say (CI frees disk space for it).
  it('gives the AVD 2 cores, keeping its other settings', () => {
    const { setup, config } = fakeSdk();

    assert.equal(setup().status, 0);

    assert.deepEqual(readFileSync(config, 'utf8').split('\n').filter(Boolean).sort(), [
      'disk.dataPartition.path=<temp>',
      'disk.dataPartition.size=6G',
      'hw.cpu.ncore=2',
    ]);
  });

  it('sets the cores of an AVD created before, on every setup', () => {
    const { setup, config } = fakeSdk();
    assert.equal(setup().status, 0);
    writeFileSync(
      config,
      'disk.dataPartition.size = 6442450944\nhw.cpu.ncore = 4\nhw.ramSize=2G\n',
    );

    assert.equal(setup().status, 0);

    assert.deepEqual(readFileSync(config, 'utf8').split('\n').filter(Boolean).sort(), [
      'disk.dataPartition.size = 6442450944',
      'hw.cpu.ncore=2',
      'hw.ramSize=2G',
    ]);
  });

  it('installs cmdline-tools only when the SDK has none', () => {
    const present = fakeSdk();
    assert.equal(present.setup().status, 0);
    assert.doesNotMatch(present.installed(), /cmdline-tools;latest/);

    const absent = fakeSdk({ cmdlineTools: false });
    const result = absent.setup();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(absent.installed(), /cmdline-tools;latest/);
  });
});

// The boot wait against a fake emulator, adb and sleep (no real waiting: sleep returns at once and logs each call).
// FAKE_EMULATOR picks what the emulator does: `exit` (fails at once, as without KVM), `hang` (runs but never boots) or
// `boot`. It records its pid, so a test can check it was stopped.
describe('android.sh emulator', () => {
  const dirs = [];
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  after(() => {
    for (const dir of dirs) {
      const pidFile = join(dir, 'state/pid');
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8'));
        if (alive(pid)) process.kill(pid);
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const boot = (mode, extraEnv = {}, { snapshot = false } = {}) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'android-emulator-')));
    dirs.push(base);
    const state = join(base, 'state');
    const sdk = join(base, 'sdk');
    mkdirSync(state);
    mkdirSync(join(base, 'jdk'));
    script(join(base, 'bin/java'), 'echo "openjdk version \\"21\\"" >&2');
    script(join(base, 'bin/sleep'), `echo "$*" >>"${join(state, 'sleeps')}"`);
    const snapshots = join(base, 'home/.android/avd/fivvi.avd/snapshots/default_boot');
    if (snapshot) {
      mkdirSync(snapshots, { recursive: true });
      writeFileSync(join(snapshots, 'snapshot.pb'), '');
    }
    script(
      join(sdk, 'platform-tools/adb'),
      `echo "$*" >>"${join(state, 'adb.log')}"
stop_fake() {
  rm -f "${state}/booted" "${state}/stopping"
  [ ! -e "${state}/pid" ] || kill "$(cat "${state}/pid")" 2>/dev/null || true
  for _ in $(seq 100); do kill -0 "$(cat "${state}/pid" 2>/dev/null)" 2>/dev/null || break; /bin/sleep 0.05; done
}
case "$1 $2 $3" in
  "emu avd snapshot") mkdir -p "${snapshots}" && touch "${snapshots}/snapshot.pb" ;;
  "get-state "*) [ -e "${state}/booted" ] && echo device || exit 1 ;;
  "shell getprop sys.boot_completed") [ -e "${state}/booted" ] && echo 1 || exit 1 ;;
  "emu kill"*) case "$FAKE_STOP" in
    hang) ;; # the emulator ignores it
    slow) touch "${state}/stopping" ;; # it exits after a few polls
    *) stop_fake ;;
  esac ;;
  "devices "*)
    if [ -e "${state}/stopping" ]; then
      n=$(($(cat "${state}/polls" 2>/dev/null || echo 0) + 1)); echo $n >"${state}/polls"
      [ $n -lt 3 ] || stop_fake
    fi
    printf 'List of devices attached\\n'
    [ ! -e "${state}/booted" ] || printf 'emulator-5554\\tdevice\\n' ;;
esac
exit 0`,
    );
    script(
      join(sdk, 'emulator/emulator'),
      `case "$1" in
  -list-avds) echo fivvi ;;
  -accel-check) echo 'accel: KVM (fake) is installed and usable' ;;
  *) echo $$ >"${state}/pid"
     echo "$*" >>"${state}/emulator.log"
     mode="$FAKE_EMULATOR"
     # FAKE_SNAPSHOT: what the emulator does when it is asked to load a snapshot.
     case " $* " in *" -snapshot "*) [ -z "$FAKE_SNAPSHOT" ] || mode="$FAKE_SNAPSHOT" ;; esac
     case "$mode" in
       exit) echo 'FATAL | x86_64 emulation currently requires hardware acceleration!'; exit 1 ;;
       hang) echo 'INFO | booting (fake)'; exec /bin/sleep 60 ;;
       boot) echo 'INFO | booted (fake)'; touch "${state}/booted"; exec /bin/sleep 60 ;;
     esac ;;
esac`,
    );
    const env = {
      PATH: `${join(base, 'bin')}:${process.env.PATH}`,
      HOME: join(base, 'home'),
      ANDROID_HOME: sdk,
      JAVA_HOME: join(base, 'jdk'),
      EMULATOR_LOG: join(base, 'emulator.log'),
      FAKE_EMULATOR: mode,
      ...extraEnv,
    };
    const result = spawnSync(join(SCRIPTS, 'android.sh'), ['emulator'], { encoding: 'utf8', env });
    const read = (file) =>
      existsSync(join(state, file)) ? readFileSync(join(state, file), 'utf8') : '';
    const sleeps = read('sleeps').split('\n').filter(Boolean);
    const launches = read('emulator.log').split('\n').filter(Boolean);
    const adb = read('adb.log').split('\n').filter(Boolean);
    const stop = (stopEnv = {}) =>
      spawnSync(join(SCRIPTS, 'android.sh'), ['stop'], {
        encoding: 'utf8',
        env: { ...env, ...stopEnv },
      });
    return {
      ...result,
      stop,
      read,
      pid: Number(read('pid')),
      sleeps,
      launches,
      adb,
      snapshotSaved: existsSync(join(snapshots, 'snapshot.pb')),
    };
  };

  it('fails at once with the emulator log and the acceleration check when the emulator exits', () => {
    const result = boot('exit');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /the emulator exited while booting/);
    assert.match(result.stderr, /x86_64 emulation currently requires hardware acceleration/);
    assert.match(result.stderr, /KVM \(fake\) is installed and usable/);
    assert.match(result.stderr, /Free space for the emulator \(.*\.android\/avd\):\n.*Filesystem/);
  });

  it('gives up after EMULATOR_BOOT_TIMEOUT, shows the log and stops the emulator', () => {
    const result = boot('hang', { EMULATOR_BOOT_TIMEOUT: '4' });

    assert.equal(result.status, 1);
    assert.deepEqual(result.sleeps, ['2', '2'], 'polls every 2 s until 4 s have passed');
    assert.match(result.stderr, /the emulator didn't boot in 4s/);
    assert.match(result.stderr, /booting \(fake\)/);
    assert.ok(result.pid > 0 && !alive(result.pid), 'the emulator was stopped');
  });

  it('waits for the boot and leaves the emulator running', () => {
    const result = boot('boot');

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /emulator-5554\tdevice/);
    assert.ok(alive(result.pid), 'the emulator keeps running for the next steps');
  });

  describe('E002 #91 android.sh stop (CI, before the AVD cache is saved)', () => {
    const startedEmulator = (extraEnv = {}) => {
      const started = boot('boot', extraEnv);
      assert.equal(started.status, 0, started.stdout + started.stderr);
      assert.ok(alive(started.pid), 'the emulator runs');
      return started;
    };

    it('stops the emulator that an earlier android.sh emulator left running, and returns once it has exited', () => {
      const started = startedEmulator();

      const result = started.stop();

      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(!alive(started.pid), 'the emulator has exited');
      assert.match(result.stdout, /Emulator stopped/);
    });

    it('waits for the exit instead of sleeping a fixed time', () => {
      const started = startedEmulator();
      const before = started.read('sleeps').split('\n').filter(Boolean).length;

      const result = started.stop({ FAKE_STOP: 'slow' });

      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(!alive(started.pid), 'the emulator has exited');
      const polls = started.read('sleeps').split('\n').filter(Boolean).length - before;
      assert.ok(polls >= 1, 'it polled until the emulator was gone');
    });

    it('fails with a clear error when the emulator is still running after EMULATOR_STOP_TIMEOUT', () => {
      const started = startedEmulator();

      const result = started.stop({ FAKE_STOP: 'hang', EMULATOR_STOP_TIMEOUT: '4' });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /the emulator didn't exit in 4s/);
    });

    it('does nothing when no emulator is running', () => {
      const started = startedEmulator();
      assert.equal(started.stop().status, 0);

      const result = started.stop();

      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /No emulator running/);
    });
  });

  describe('E002 #91 snapshot boot (AVD_SNAPSHOT=1, set by CI)', () => {
    const withSnapshots = { AVD_SNAPSHOT: '1' };

    it('boots cold without snapshots by default, as it does locally, and saves nothing', () => {
      const result = boot('boot', {}, { snapshot: true });

      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.launches.length, 1);
      assert.match(result.launches[0], /(^| )-no-snapshot( |$)/);
      assert.doesNotMatch(result.launches[0], /-snapshot default_boot/);
      assert.deepEqual(
        result.adb.filter((call) => call.startsWith('emu')),
        [],
      );
    });

    it('boots from the cached snapshot and saves nothing', () => {
      const result = boot('boot', withSnapshots, { snapshot: true });

      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.launches.length, 1);
      assert.match(result.launches[0], /^-avd fivvi -snapshot default_boot -no-snapshot-save /);
      assert.match(result.stdout, /Emulator booted from its snapshot in \d+s/);
      assert.deepEqual(
        result.adb.filter((call) => call.startsWith('emu')),
        [],
      );
    });

    it('boots cold without a snapshot, then saves one for the cache', () => {
      const result = boot('boot', withSnapshots);

      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.launches.length, 1);
      assert.match(result.launches[0], /^-avd fivvi -no-snapshot-load -no-snapshot-save /);
      assert.match(result.stdout, /Emulator booted cold in \d+s/);
      assert.ok(result.adb.includes('emu avd snapshot save default_boot'), result.adb.join('\n'));
      assert.ok(result.snapshotSaved);
    });

    for (const [name, snapshotBehaviour, extraEnv] of [
      ['crashes the emulator', 'exit', {}],
      ['does not boot in SNAPSHOT_BOOT_TIMEOUT', 'hang', { SNAPSHOT_BOOT_TIMEOUT: '4' }],
    ]) {
      it(`falls back to a cold boot and replaces the snapshot when it ${name}`, () => {
        const result = boot(
          'boot',
          { ...withSnapshots, FAKE_SNAPSHOT: snapshotBehaviour, ...extraEnv },
          { snapshot: true },
        );

        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(result.launches.length, 2, result.launches.join('\n'));
        assert.match(result.launches[0], /-snapshot default_boot/);
        assert.match(result.launches[1], /-no-snapshot-load/);
        assert.match(result.stdout, /::warning::The emulator snapshot didn't load/);
        assert.match(result.stdout, /Emulator booted cold in \d+s/);
        assert.ok(result.adb.includes('emu avd snapshot save default_boot'));
      });
    }

    it('still fails with the emulator log when the cold boot fails too', () => {
      const result = boot('exit', withSnapshots, { snapshot: true });

      assert.equal(result.status, 1);
      assert.equal(result.launches.length, 2);
      assert.match(result.stderr, /the emulator exited while booting/);
    });
  });
});

// The cache key of CI's cached AVD (E002 #91): it changes with whatever makes a snapshot stop loading.
describe('E002 #91 android.sh avd-key', () => {
  const dirs = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const key = ({ emulator = '35.4.9', image = '14', missing = false } = {}) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'android-key-')));
    dirs.push(base);
    const sdk = join(base, 'sdk');
    mkdirSync(join(sdk, 'platform-tools'), { recursive: true });
    mkdirSync(join(base, 'jdk'));
    script(join(base, 'bin/java'), 'echo "openjdk version \\"21\\"" >&2');
    if (!missing) {
      mkdirSync(join(sdk, 'emulator'));
      writeFileSync(join(sdk, 'emulator/source.properties'), `Pkg.Revision=${emulator}\n`);
      for (const abi of ['x86_64', 'arm64-v8a']) {
        const dir = join(sdk, 'system-images/android-35/google_apis', abi);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'source.properties'), `Pkg.Revision=${image}\n`);
      }
    }
    return spawnSync(join(SCRIPTS, 'android.sh'), ['avd-key'], {
      encoding: 'utf8',
      env: {
        PATH: `${join(base, 'bin')}:${process.env.PATH}`,
        HOME: join(base, 'home'),
        ANDROID_HOME: sdk,
        JAVA_HOME: join(base, 'jdk'),
      },
    });
  };

  it('names the system image, its revision, the emulator revision and the settings', () => {
    const result = key();

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout.trim(),
      /^system-images-android-35-google_apis-(x86_64|arm64-v8a)-r14-emulator35\.4\.9-\d+$/,
    );
  });

  it('changes with the emulator and with the system image', () => {
    const keys = [key(), key({ emulator: '36.1.2' }), key({ image: '15' })].map((r) => r.stdout);

    assert.equal(new Set(keys).size, 3, keys.join(''));
  });

  it('fails when the emulator or the system image is not installed', () => {
    const result = key({ missing: true });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /isn't installed/);
  });
});

// A fake `xcrun simctl` that keeps each simulator as a JSON file in <state>/devices and logs its arguments.
const fakeSimctl = (
  state,
) => `# xcresulttool prints the canned test results FAKE_XCRESULT names (nothing without it).
if [ "$1" = xcresulttool ]; then [ -z "$FAKE_XCRESULT" ] || cat "$FAKE_XCRESULT"; exit 0; fi
[ "$1" = simctl ] || exit 1
shift
echo "$*" >>"${state}/xcrun.log"
devices="${state}/devices"
set_state() { jq --arg s "$2" '.state = $s' "$devices/$1" >"$devices/$1.partial" && mv "$devices/$1.partial" "$devices/$1"; }
case "$1" in
  list) cat "$devices"/* 2>/dev/null | jq -s 'reduce .[] as $d ({}; .[$d.runtime] += [$d | del(.runtime)]) | {devices: .}' ;;
  create) udid="SIM-$RANDOM$RANDOM"
    jq -n --arg u "$udid" --arg n "$2" --arg t "$3" --arg r "$4" \\
      '{udid: $u, name: $n, deviceTypeIdentifier: $t, runtime: $r, state: "Shutdown"}' >"$devices/$udid"
    echo "$udid" ;;
  bootstatus) set_state "$2" Booted ;;
  shutdown) set_state "$2" Shutdown ;;
  delete) rm "$devices/$2" ;;
  spawn) case "$*" in *"defaults export"*) touch "\${@: -1}" ;; esac ;;
esac
exit 0`;

const iPhone = (udid, model, runtime, state = 'Shutdown') => ({
  udid,
  name: model,
  state,
  deviceTypeIdentifier: `com.apple.CoreSimulator.SimDeviceType.${model.replaceAll(' ', '-')}`,
  runtime: `com.apple.CoreSimulator.SimRuntime.iOS-${runtime}`,
});

// The native test commands in a copy of the repo with fake toolchains: simctl above, an emulator that records its pid,
// and an xcodebuild, gradlew, adb and Maestro that log their arguments. FAKE_RESULT makes each command's last step
// pass, fail or hang (until a Ctrl-C to the whole process group, as in a terminal), so a test can check what the
// command leaves running.
describe('E008 #71 native test commands clean up after themselves', () => {
  const dirs = [];
  const pids = [];
  const running = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  after(() => {
    for (const pid of pids) if (running(pid)) process.kill(pid);
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const checkout = ({ simulatorBooted = false, emulatorRunning = false } = {}) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'native-')));
    dirs.push(base);
    const repo = join(base, 'repo');
    const state = join(base, 'state');
    const bin = join(base, 'bin');
    const sdk = join(base, 'sdk');
    const home = join(base, 'home');
    const outcome = `case "$FAKE_RESULT" in
  fail) exit 1 ;;
  hang) exec perl -e 'open my $f, ">", shift; close $f; sleep 30' "${state}/running" ;;
esac`;
    mkdirSync(join(state, 'devices'), { recursive: true });
    for (const device of [
      iPhone('IPHONE-17', 'iPhone 17', '26-5'),
      iPhone('IPHONE-18', 'iPhone 18 Pro', '27-0', simulatorBooted ? 'Booted' : 'Shutdown'),
    ]) {
      writeFileSync(join(state, 'devices', device.udid), JSON.stringify(device));
    }
    if (emulatorRunning) writeFileSync(join(state, 'booted'), '');

    execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo]);
    cpSync(SCRIPTS, join(repo, 'scripts'), { recursive: true });
    for (const path of [
      'apps/ios/lint',
      'apps/ios/Config',
      'apps/ios/README.md',
      'apps/Version.xcconfig',
      'apps/ios/FivviPro.xctestplan',
      'apps/ios/FivviProUITests',
      'apps/ios/FivviPro.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
      'packages/i18n/nl-NL.json',
      'packages/i18n/en.json',
      'packages/i18n/generated/ios',
    ]) {
      cpSync(join(SCRIPTS, '..', path), join(repo, path), { recursive: true });
    }
    // The web server maestro.sh starts: it runs until it's stopped.
    mkdirSync(join(repo, 'apps/web/.next/standalone/apps/web'), { recursive: true });
    writeFileSync(
      join(repo, 'apps/web/.next/standalone/apps/web/server.js'),
      'setInterval(() => {}, 1000);\n',
    );
    mkdirSync(join(repo, 'packages/database'));
    writeFileSync(join(repo, 'packages/database/.env'), '');
    const swiftlint = readFileSync(join(SCRIPTS, '_ios.sh'), 'utf8').match(
      /^SWIFTLINT_VERSION=(\S+)/m,
    )[1];
    // SwiftLint flags exactly the fixture lines marked `// expect: <rule>`, as the real rules must.
    script(
      join(repo, `apps/ios/.build/swiftlint-${swiftlint}/swiftlint`),
      `for arg; do case "$arg" in *.swift)
  grep -n '// expect: [a-z_]*$' "$arg" | while IFS=: read -r line text; do echo "$arg:$line:1: error: (\${text##*expect: })"; done
  exit 2 ;; esac; done`,
    );
    script(
      join(repo, 'apps/android/gradlew'),
      `echo "$*" >>"${state}/gradle.log"
case "$*" in
  *checkReleaseApiBaseUrl*-Pfivvi.releaseApiBaseUrl=*) [ "$FAKE_URL_CHECK" = accept ] || { echo 'Set fivvi.releaseApiBaseUrl (fake)'; exit 1; } ;;
  *connectedDebugAndroidTest*) ${outcome} ;;
esac`,
    );
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--quiet',
      '-m',
      'chore: init',
    ]);

    script(join(bin, 'xcrun'), fakeSimctl(state));
    // build-for-testing leaves the .xctestrun file that test-without-building runs; FAKE_BUILD=fail makes it fail.
    // FAKE_CATALOG_SYNC=add: `-exportLocalizations` adds an entry to InfoPlist.xcstrings and drops its final newline,
    // as Xcode's sync does; FAKE_EXPORT=fail: it then fails; FAKE_EXPORT=hang: it then runs until interrupted.
    script(
      join(bin, 'xcodebuild'),
      `echo "$*" >>"${state}/xcodebuild.log"
case "$*" in
  -exportLocalizations*) [ "$FAKE_CATALOG_SYNC" != add ] || {
      catalog="${repo}/packages/i18n/generated/ios/InfoPlist.xcstrings"
      printf '%s' "$(sed 's/"strings" : {/"strings" : { "CFBundleName" : {},/' "$catalog")" >"$catalog"; }
    [ "$FAKE_EXPORT" != hang ] || exec perl -e 'open my $f, ">", shift; close $f; sleep 30' "${state}/running"
    [ "$FAKE_EXPORT" != fail ] || exit 70 ;;
  *-showBuildSettings*)
    # FAKE_VERSION: the version the project resolves instead of the one of apps/Version.xcconfig. A build setting passed
    # on the command line (CURRENT_PROJECT_VERSION=42) is echoed first, as Xcode does ("Build settings from command
    # line:"), and overrides the file's in the target's block, unless FAKE_IGNORE_OVERRIDE is set (the target then
    # resolves the default and only the echo says 42).
    echoed=''
    number="$(sed -nE 's/^CURRENT_PROJECT_VERSION = //p' ${repo}/apps/Version.xcconfig)"
    case "$*" in *\\ CURRENT_PROJECT_VERSION=*)
      echoed="Build settings from command line:\\n    CURRENT_PROJECT_VERSION = $(sed -E 's/.* CURRENT_PROJECT_VERSION=([^ ]*).*/\\1/' <<<"$*")\\n\\n"
      [ -n "$FAKE_IGNORE_OVERRIDE" ] || number="$(sed -E 's/.* CURRENT_PROJECT_VERSION=([^ ]*).*/\\1/' <<<"$*")" ;; esac
    printf '%bBuild settings for action build and target FivviPro:\\n    FIVVI_API_BASE_URL = %s\\n    INFOPLIST_FILE = Info.plist\\n    FIVVI_SENTRY_DSN = https://public@o0.ingest.de.sentry.io/1\\n    FIVVI_SENTRY_ENVIRONMENT = production\\n    MARKETING_VERSION = %s\\n    CURRENT_PROJECT_VERSION = %s\\n    PRODUCT_BUNDLE_IDENTIFIER = app.fivvi.pro\\n' "$echoed" "\${FAKE_BASE_URL-https://example.test/api}" "\${FAKE_VERSION:-$(sed -nE 's/^MARKETING_VERSION = //p' ${repo}/apps/Version.xcconfig)}" "$number" ;;
  build-for-testing\\ *) [ "$FAKE_BUILD" != fail ] || { echo 'error: build failed (fake)'; exit 1; }
    mkdir -p .build/DerivedData/Build/Products
    # FAKE_XCTESTRUN: none (the build leaves no .xctestrun) or two (it leaves two).
    [ "$FAKE_XCTESTRUN" = none ] || touch .build/DerivedData/Build/Products/FivviPro.xctestrun
    [ "$FAKE_XCTESTRUN" != two ] || touch .build/DerivedData/Build/Products/Other.xctestrun
    printf 'Build Timing Summary\\n\\nSwiftCompile (1 task) | 1.000 seconds\\n\\n** TEST BUILD SUCCEEDED **\\n' ;;
  test-without-building\\ *) ${outcome} ;;
esac
exit 0`,
    );
    // The committed Info.plists are in plutil's (Xcode's) form, unless FAKE_PLIST_FORM=other; no ATS exception for
    // Release.
    script(
      join(bin, 'plutil'),
      `[ "$1" = -extract ] && [ "$2" = ITSAppUsesNonExemptEncryption ] && [ "$FAKE_ENCRYPTION" != missing ] && { echo false; exit 0; }
[ "$1" = -convert ] || exit 1
if [ "$FAKE_PLIST_FORM" = other ]; then sed 1d "\${@: -1}"; else cat "\${@: -1}"; fi`,
    );
    script(join(bin, 'java'), 'echo "openjdk version \\"21\\"" >&2');
    for (const tool of ['sleep', 'docker', 'pnpm']) script(join(bin, tool), 'exit 0');
    // calls.log has the curl, adb and Maestro calls in the order they ran. FAKE_HELLO=fail: GET /api/v1/hello fails.
    script(
      join(bin, 'curl'),
      `echo "curl $*" >>"${state}/calls.log"
case "$*" in *"/api/v1/hello"*) [ "$FAKE_HELLO" != fail ] || exit 22 ;; esac
exit 0`,
    );
    script(
      join(home, '.maestro/bin/maestro'),
      `echo "$*" >>"${state}/maestro.log"
echo "maestro $*" >>"${state}/calls.log"
case " $* " in *" test "*) ${outcome} ;; esac`,
    );
    script(
      join(sdk, 'platform-tools/adb'),
      `echo "$*" >>"${state}/adb.log"
echo "adb $*" >>"${state}/calls.log"
case "$*" in
  get-state) [ -e "${state}/booted" ] && echo device || exit 1 ;;
  "shell getprop sys.boot_completed") [ -e "${state}/booted" ] && echo 1 || exit 1 ;;
  "shell getprop persist.sys.locale") echo en-US ;;
  "shell settings get global hide_error_dialogs") echo null ;;
  "emu kill") kill "$(cat "${state}/pid")"; rm -f "${state}/booted" ;;
esac
exit 0`,
    );
    script(
      join(sdk, 'emulator/emulator'),
      `case "$1" in
  -list-avds) echo fivvi ;;
  -accel-check) ;;
  *) echo $$ >"${state}/pid"; touch "${state}/booted"; exec /bin/sleep 60 ;;
esac`,
    );
    mkdirSync(join(base, 'jdk'));

    const run = (command, args, extraEnv = {}, { cwd = repo, interrupt = false } = {}) =>
      new Promise((resolve) => {
        const child = spawn(join(cwd, command), args, {
          cwd,
          detached: true,
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            HOME: home,
            ANDROID_HOME: sdk,
            JAVA_HOME: join(base, 'jdk'),
            EMULATOR_LOG: join(base, 'emulator.log'),
            E2E_PORT: '3999',
            ...extraEnv,
          },
        });
        let output = '';
        child.stdout.on('data', (data) => {
          output += data;
        });
        child.stderr.on('data', (data) => {
          output += data;
        });
        const ctrlC = setInterval(() => {
          if (interrupt && existsSync(join(state, 'running'))) {
            clearInterval(ctrlC);
            process.kill(-child.pid, 'SIGINT');
          }
        }, 50);
        child.on('close', (status) => {
          clearInterval(ctrlC);
          rmSync(join(state, 'running'), { force: true });
          if (existsSync(join(state, 'pid'))) pids.push(Number(readFileSync(join(state, 'pid'))));
          resolve({ status, output });
        });
      });
    const log = (name) =>
      existsSync(join(state, `${name}.log`))
        ? readFileSync(join(state, `${name}.log`), 'utf8')
            .split('\n')
            .filter(Boolean)
        : [];
    const simulators = () =>
      readdirSync(join(state, 'devices')).map((udid) =>
        JSON.parse(readFileSync(join(state, 'devices', udid), 'utf8')),
      );
    const simulator = (udid) => simulators().find((device) => device.udid === udid);
    const emulator = () => ({
      booted: existsSync(join(state, 'booted')),
      pid: existsSync(join(state, 'pid')) ? Number(readFileSync(join(state, 'pid'))) : 0,
    });
    const worktree = (branch) => {
      const path = join(repo, '.worktrees', branch.replace('/', '-'));
      execFileSync('git', ['-C', repo, 'worktree', 'add', '--quiet', '-b', branch, path]);
      return path;
    };
    return { repo, run, log, simulators, simulator, emulator, worktree };
  };

  const endings = [
    ['passes', 'pass', 0],
    ['fails', 'fail', 1],
    ['is interrupted (Ctrl-C)', 'hang', 130],
  ];
  const testedOn = (xcodebuildOrMaestro) =>
    xcodebuildOrMaestro
      .find((line) => / test(-without-building)? /.test(` ${line} `))
      ?.match(/(?:id=|--device )(\S+)/)?.[1];

  for (const [name, command, args, testLog] of [
    ['pnpm test:ios', 'scripts/test-ios.sh', [], 'xcodebuild'],
    ['maestro.sh ios', 'scripts/maestro.sh', ['ios'], 'maestro'],
  ]) {
    for (const [ending, result, status] of endings) {
      it(`AC1: ${name} shuts down the simulator it booted when it ${ending}`, async () => {
        const fake = checkout();

        const run = await fake.run(
          command,
          args,
          { FAKE_RESULT: result },
          {
            interrupt: result === 'hang',
          },
        );

        assert.equal(run.status, status, run.output);
        assert.equal(
          testedOn(fake.log(testLog)),
          'IPHONE-18',
          'the main checkout uses the newest iPhone',
        );
        assert.equal(fake.simulator('IPHONE-18').state, 'Shutdown');
      });
    }

    it(`AC1: ${name} leaves a simulator that was already booted running`, async () => {
      const fake = checkout({ simulatorBooted: true });

      const run = await fake.run(command, args);

      assert.equal(run.status, 0, run.output);
      assert.equal(fake.simulator('IPHONE-18').state, 'Booted');
    });
  }

  it('AC4: KEEP_DEVICE=1 leaves the simulator pnpm test:ios booted running', async () => {
    const fake = checkout();

    const run = await fake.run('scripts/test-ios.sh', [], { KEEP_DEVICE: '1' });

    assert.equal(run.status, 0, run.output);
    assert.equal(fake.simulator('IPHONE-18').state, 'Booted');
  });

  describe('E002 #91 pnpm test:ios builds once and tests nl and en without building', () => {
    const configs = (fake) =>
      fake
        .log('xcodebuild')
        .filter((line) => line.startsWith('test-without-building '))
        .map((line) => line.match(/-only-test-configuration (\S+)/)?.[1] ?? 'all');
    const commands = (fake) =>
      fake
        .log('xcodebuild')
        .map((line) => line.split(' ')[0])
        .filter((command) => !command.startsWith('-'));

    it('runs build-for-testing once, then one test-without-building for nl and en on one simulator', async () => {
      const fake = checkout();

      const run = await fake.run('scripts/test-ios.sh');

      assert.equal(run.status, 0, run.output);
      assert.deepEqual(commands(fake), ['build-for-testing', 'test-without-building']);
      assert.deepEqual(configs(fake), ['all'], 'both configurations of the test plan in one run');
      const [build] = fake
        .log('xcodebuild')
        .filter((line) => line.startsWith('build-for-testing '));
      assert.match(build, /-showBuildTimingSummary/);
      assert.match(build, /-derivedDataPath \.build\/DerivedData/);
      assert.equal(fake.simulators().length, 2, 'no second simulator');
      assert.match(run.output, /Build Timing Summary/);
    });

    it('keeps one result bundle with both locales and prints the steps with their durations', async () => {
      const fake = checkout();

      const run = await fake.run('scripts/test-ios.sh');

      const bundles = fake
        .log('xcodebuild')
        .filter((line) => line.startsWith('test-without-building '))
        .map((line) => line.match(/-resultBundlePath (\S+)/)?.[1]);
      assert.deepEqual(bundles, ['.build/TestResults-nl-en.xcresult']);
      assert.match(run.output, /Step durations:\n( +\d+ s {2}.+\n)+ +\d+ s {2}Total/);
      assert.match(run.output, /\d+ s {2}Build for testing/);
      assert.match(run.output, /\d+ s {2}Unit and UI tests in nl and en/);
    });

    it('writes the step durations and the build timing to the job summary on GitHub Actions', async () => {
      const fake = checkout();
      const summary = join(fake.repo, '..', 'summary.md');

      const run = await fake.run('scripts/test-ios.sh', [], { GITHUB_STEP_SUMMARY: summary });

      assert.equal(run.status, 0, run.output);
      const written = readFileSync(summary, 'utf8');
      assert.match(written, /### iOS build timing/);
      assert.match(written, /SwiftCompile \(1 task\)/);
      assert.match(
        written,
        /### iOS steps\n\n\| Step \| Duration \|\n\|---\|--:\|\n\| SwiftLint \| \d+ s \|/,
      );
      assert.match(written, /\| \*\*Total\*\* \| \*\*\d+ s\*\* \|/);
    });

    it('does not test when the build fails, and still shuts the simulator down', async () => {
      const fake = checkout();

      const run = await fake.run('scripts/test-ios.sh', [], { FAKE_BUILD: 'fail' });

      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /error: build failed \(fake\)/);
      assert.deepEqual(configs(fake), []);
      assert.equal(fake.simulator('IPHONE-18').state, 'Shutdown');
    });

    it('deletes an .xctestrun restored from the cache before building, and tests with the new one', async () => {
      const fake = checkout();
      const products = join(fake.repo, 'apps/ios/.build/DerivedData/Build/Products');
      mkdirSync(products, { recursive: true });
      writeFileSync(join(products, 'OldScheme.xctestrun'), '');

      const run = await fake.run('scripts/test-ios.sh');

      assert.equal(run.status, 0, run.output);
      assert.ok(!existsSync(join(products, 'OldScheme.xctestrun')), 'the stale file is gone');
      const tests = fake
        .log('xcodebuild')
        .filter((line) => line.startsWith('test-without-building '));
      assert.equal(tests.length, 1);
      for (const line of tests) {
        assert.match(
          line,
          /-xctestrun \.build\/DerivedData\/Build\/Products\/FivviPro\.xctestrun /,
        );
      }
    });

    for (const [name, mode, found] of [
      ['no .xctestrun', 'none', /found: none/],
      ['more than one .xctestrun', 'two', /found: .*Other\.xctestrun/],
    ]) {
      it(`fails before testing when the build leaves ${name}`, async () => {
        const fake = checkout();

        const run = await fake.run('scripts/test-ios.sh', [], { FAKE_XCTESTRUN: mode });

        assert.equal(run.status, 1, run.output);
        assert.match(run.output, /expected exactly one \.xctestrun/);
        assert.match(run.output, found);
        assert.deepEqual(configs(fake), []);
        assert.equal(fake.simulator('IPHONE-18').state, 'Shutdown');
      });
    }

    it('fails when the tests fail, after the one run of both locales', async () => {
      const fake = checkout();

      const run = await fake.run('scripts/test-ios.sh', [], { FAKE_RESULT: 'fail' });

      assert.equal(run.status, 1, run.output);
      assert.deepEqual(configs(fake), ['all']);
    });

    it('IOS_PARALLEL=1 tests nl and en at the same time on two simulators, and deletes the second', async () => {
      const fake = checkout();

      const run = await fake.run('scripts/test-ios.sh', [], { IOS_PARALLEL: '1' });

      assert.equal(run.status, 0, run.output);
      const tests = fake
        .log('xcodebuild')
        .filter((line) => line.startsWith('test-without-building '));
      assert.deepEqual(configs(fake).sort(), ['en', 'nl']);
      assert.deepEqual(tests.map((line) => line.match(/-resultBundlePath (\S+)/)?.[1]).sort(), [
        '.build/TestResults-en.xcresult',
        '.build/TestResults-nl.xcresult',
      ]);
      assert.ok(tests.some((line) => testedOn([line]) === 'IPHONE-18'));
      assert.notEqual(testedOn([tests[0]]), testedOn([tests[1]]), 'one simulator each');
      assert.equal(fake.simulators().length, 2, 'the second simulator is deleted');
      assert.equal(fake.simulator('IPHONE-18').state, 'Shutdown');
      assert.match(run.output, /::group::Tests in nl/);
    });

    for (const [name, env] of [
      ['CI', { CI: 'true' }],
      ['IOS_PARALLEL=0 on CI', { CI: 'true', IOS_PARALLEL: '0' }],
    ]) {
      it(`${name}: tests nl and en in one run on one simulator`, async () => {
        const fake = checkout();

        const run = await fake.run('scripts/test-ios.sh', [], env);

        assert.equal(run.status, 0, run.output);
        assert.equal(fake.simulators().length, 2);
        assert.deepEqual(configs(fake), ['all']);
      });
    }

    it('fails when one locale fails in parallel, with both outputs shown', async () => {
      const fake = checkout();

      const run = await fake.run('scripts/test-ios.sh', [], {
        IOS_PARALLEL: '1',
        FAKE_RESULT: 'fail',
      });

      assert.equal(run.status, 1, run.output);
      assert.equal(configs(fake).length, 2);
      assert.equal(fake.simulators().length, 2, 'the second simulator is deleted');
    });
  });

  describe('E002 #105 faster iOS tests without losing coverage', () => {
    const commands = (fake) =>
      fake
        .log('xcodebuild')
        .map((line) => line.split(' ')[0])
        .filter((command) => /^(build-for-testing|test-without-building)$/.test(command));
    const planPath = (fake) => join(fake.repo, 'apps/ios/FivviPro.xctestplan');
    const skipList = (config) =>
      config.options.environmentVariableEntries.find((entry) => entry.key === 'FIVVI_SKIP_TESTS');
    // Rewrites the test plan in the fake checkout: `edit` gets the plan's configurations by name.
    const editPlan = (fake, edit) => {
      const plan = JSON.parse(readFileSync(planPath(fake), 'utf8'));
      edit(Object.fromEntries(plan.configurations.map((config) => [config.name, config])));
      writeFileSync(planPath(fake), JSON.stringify(plan));
    };

    it('C: the configuration checks make one -showBuildSettings call per configuration and one for the build number, into the cached Swift packages', async () => {
      const fake = checkout();

      const run = await fake.run('scripts/test-ios.sh');

      assert.equal(run.status, 0, run.output);
      const calls = fake.log('xcodebuild').filter((line) => line.includes('-showBuildSettings'));
      assert.equal(calls.length, 3);
      assert.ok(calls.some((call) => call.includes('-configuration Release')));
      assert.ok(calls.some((call) => call.includes('-configuration Debug')));
      assert.ok(
        calls.some((call) => call.includes('CURRENT_PROJECT_VERSION=42')),
        'a build number passed from outside',
      );
      for (const call of calls) {
        assert.match(call, /-clonedSourcePackagesDirPath \.build\/SourcePackages/);
      }
    });

    it('D: nl runs every UI test and en skips only the locale-independent ones', () => {
      const plan = JSON.parse(
        readFileSync(join(SCRIPTS, '../apps/ios/FivviPro.xctestplan'), 'utf8'),
      );
      const [nl, en] = ['nl', 'en'].map((name) => plan.configurations.find((c) => c.name === name));

      assert.equal(skipList(nl), undefined);
      assert.deepEqual(skipList(en).value.split(',').sort(), [
        'HelloUITests/test_E008_AC3_firstSupportedDeviceLanguageWins',
        'HelloUITests/test_E008_AC3_perAppLanguageOverridesTheDevice',
        'HelloUITests/test_E008_AC3_unsupportedDeviceLanguageShowsEnglish',
        'HelloUITests/test_E008_AC6_usesTokenColoursInLightAndDark',
        'HelloUITests/test_E008_AC7_largestTextSizeWraps',
      ]);
    });

    it('D: fails before building when a UI test is skipped in every configuration', async () => {
      const fake = checkout();
      editPlan(fake, ({ nl }) => {
        nl.options.environmentVariableEntries.push({
          key: 'FIVVI_SKIP_TESTS',
          value: 'HelloUITests/test_E008_AC6_usesTokenColoursInLightAndDark',
        });
      });

      const run = await fake.run('scripts/test-ios.sh');

      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /HelloUITests\/test_E008_AC6_usesTokenColoursInLightAndDark/);
      assert.match(run.output, /runs in no configuration/);
      assert.deepEqual(commands(fake), []);
    });

    it('D: fails when a configuration skips a test that no UI test class has', async () => {
      const fake = checkout();
      editPlan(fake, ({ en }) => {
        skipList(en).value += ',HelloUITests/test_E008_AC9_renamedAway';
      });

      const run = await fake.run('scripts/test-ios.sh');

      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /HelloUITests\/test_E008_AC9_renamedAway/);
      assert.match(run.output, /is not a UI test/);
      assert.deepEqual(commands(fake), []);
    });

    for (const key of ['skippedTests', 'selectedTests']) {
      it(`D: fails when a test target of the plan has ${key}, which Xcode writes and which applies to every configuration`, async () => {
        const fake = checkout();
        const plan = JSON.parse(readFileSync(planPath(fake), 'utf8'));
        plan.testTargets[1][key] = ['HelloUITests/test_E008_AC8_displayNameComesFromTheCatalog'];
        writeFileSync(planPath(fake), JSON.stringify(plan));

        const run = await fake.run('scripts/test-ios.sh');

        assert.equal(run.status, 1, run.output);
        assert.match(run.output, new RegExp(`${key}.*FIVVI_SKIP_TESTS`));
        assert.deepEqual(commands(fake), []);
      });
    }

    it('D: fails when the skip list names a test of a class other than HelloUITests, which would not skip it', async () => {
      const fake = checkout();
      editPlan(fake, ({ en }) => {
        skipList(en).value += ',TouchTargetTests/test_E008_AC4_44PointsMeetsTheTarget';
      });

      const run = await fake.run('scripts/test-ios.sh');

      assert.equal(run.status, 1, run.output);
      assert.match(
        run.output,
        /TouchTargetTests\/test_E008_AC4_44PointsMeetsTheTarget.*only HelloUITests/,
      );
      assert.deepEqual(commands(fake), []);
    });

    it('D: finds the tests of a private final class and of a second class in the same target', async () => {
      const fake = checkout();
      const extra = join(fake.repo, 'apps/ios/FivviProUITests/ExtraTests.swift');
      writeFileSync(
        extra,
        'private final class Helper {\n    class func test_notATest() {}\n}\nprivate final class ExtraTests: XCTestCase {\n    func test_E002_extra() {}\n}\n',
      );
      editPlan(fake, ({ en }) => {
        skipList(en).value += ',ExtraTests/test_E002_extra';
      });

      const run = await fake.run('scripts/test-ios.sh');

      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /ExtraTests\/test_E002_extra.*only HelloUITests/);
      assert.doesNotMatch(run.output, /not a UI test/);
    });

    it('D: a class does not leak into the next file: a test outside any class is not a UI test, whatever order the files are read in', async () => {
      const fake = checkout();
      const dir = join(fake.repo, 'apps/ios/FivviProUITests');
      rmSync(dir, { recursive: true });
      mkdirSync(dir);
      // Each file has a free function, then the class: whichever file is read second would give its free function the
      // first file's class without the per-file reset.
      for (const name of ['freeA', 'freeB']) {
        writeFileSync(
          join(dir, `${name}.swift`),
          `func test_${name}() {}\nfinal class HelloUITests: XCTestCase {}\n`,
        );
      }
      editPlan(fake, ({ nl, en }) => {
        nl.options.environmentVariableEntries = nl.options.environmentVariableEntries.filter(
          (entry) => entry.key !== 'FIVVI_SKIP_TESTS',
        );
        skipList(en).value = 'HelloUITests/test_freeA,HelloUITests/test_freeB';
      });

      const run = await fake.run('scripts/test-ios.sh');

      assert.equal(run.status, 1, run.output);
      for (const name of ['freeA', 'freeB'])
        assert.match(run.output, new RegExp(`HelloUITests/test_${name}, which is not a UI test`));
    });

    it('A: reports the slowest tests of each locale from the one result bundle', async () => {
      const fake = checkout();
      const result = join(fake.repo, '..', 'results.json');
      const test = (name, nl, en) => ({
        nodeType: 'Test Case',
        nodeIdentifier: name,
        durationInSeconds: (nl + en) / 2,
        children: [
          { nodeType: 'Test Plan Configuration', name: 'en', durationInSeconds: en },
          { nodeType: 'Test Plan Configuration', name: 'nl', durationInSeconds: nl },
        ],
      });
      writeFileSync(
        result,
        JSON.stringify({
          testNodes: [
            test('HelloUITests/test_slowInNl()', 30, 2),
            test('HelloUITests/test_slowInEn()', 3, 20),
          ],
        }),
      );
      const summary = join(fake.repo, '..', 'summary.md');

      const run = await fake.run('scripts/test-ios.sh', [], {
        FAKE_XCRESULT: result,
        GITHUB_STEP_SUMMARY: summary,
      });

      assert.equal(run.status, 0, run.output);
      assert.match(
        run.output,
        /Slowest tests in nl \(seconds\):\n +HelloUITests\/test_slowInNl\(\) 30\n +HelloUITests\/test_slowInEn\(\) 3\n/,
      );
      assert.match(
        run.output,
        /Slowest tests in en \(seconds\):\n +HelloUITests\/test_slowInEn\(\) 20\n +HelloUITests\/test_slowInNl\(\) 2\n/,
      );
      const written = readFileSync(summary, 'utf8');
      assert.match(written, /### Slowest iOS tests in nl/);
      assert.match(written, /### Slowest iOS tests in en/);
    });

    it('A: a bundle of one locale (IOS_PARALLEL=1) is reported for that locale', async () => {
      const fake = checkout();
      const result = join(fake.repo, '..', 'results.json');
      writeFileSync(
        result,
        JSON.stringify({
          testNodes: [
            {
              nodeType: 'Test Case',
              nodeIdentifier: 'HelloUITests/test_one()',
              durationInSeconds: 7,
            },
          ],
        }),
      );

      const run = await fake.run('scripts/test-ios.sh', [], {
        IOS_PARALLEL: '1',
        FAKE_XCRESULT: result,
      });

      assert.equal(run.status, 0, run.output);
      assert.match(
        run.output,
        /Slowest tests in nl \(seconds\):\n +HelloUITests\/test_one\(\) 7\n/,
      );
      assert.match(
        run.output,
        /Slowest tests in en \(seconds\):\n +HelloUITests\/test_one\(\) 7\n/,
      );
    });
  });

  it('AC3: pnpm test:ios runs a worktree on its own simulator, named after it and created on first use', async () => {
    const fake = checkout();
    const worktree = fake.worktree('feature/9-own-simulator');
    const own = () =>
      fake.simulators().filter((device) => device.name === 'Fivvi feature-9-own-simulator');

    const first = await fake.run('scripts/test-ios.sh', [], {}, { cwd: worktree });
    const second = await fake.run('scripts/test-ios.sh', [], {}, { cwd: worktree });

    assert.equal(first.status, 0, first.output);
    assert.equal(second.status, 0, second.output);
    assert.equal(own().length, 1, 'created once, then reused');
    const [simulator] = own();
    assert.deepEqual(
      [simulator.deviceTypeIdentifier, simulator.runtime],
      [fake.simulator('IPHONE-18').deviceTypeIdentifier, fake.simulator('IPHONE-18').runtime],
      'a copy of the newest iPhone',
    );
    const destinations = fake
      .log('xcodebuild')
      .filter((line) => line.startsWith('test-without-building '));
    assert.deepEqual(
      destinations.map((line) => testedOn([line])),
      Array(2).fill(simulator.udid),
      'nl and en in one run, on each of the two runs',
    );
    assert.equal(simulator.state, 'Shutdown');
    assert.ok(
      fake.log('xcrun').every((line) => !line.includes('IPHONE-18')),
      'the shared simulator is never touched',
    );
  });

  it("#95: pnpm test:ios fails when Xcode's catalog sync would change a generated catalog, and restores it", async () => {
    const fake = checkout();
    const catalog = join(fake.repo, 'packages/i18n/generated/ios/InfoPlist.xcstrings');
    const committed = readFileSync(catalog, 'utf8');

    const run = await fake.run('scripts/test-ios.sh', [], { FAKE_CATALOG_SYNC: 'add' });

    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /packages\/i18n\/generated\/ios\/InfoPlist\.xcstrings/);
    assert.match(run.output, /CFBundleName/);
    assert.equal(readFileSync(catalog, 'utf8'), committed);
    assert.ok(
      !fake
        .log('xcodebuild')
        .some((line) => /^(build-for-testing|test-without-building) /.test(line)),
      'nothing built or tested',
    );
  });

  it("#95: pnpm test:ios fails when a Config Info.plist is not in Xcode's form", async () => {
    const fake = checkout();

    const run = await fake.run('scripts/test-ios.sh', [], { FAKE_PLIST_FORM: 'other' });

    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /Config\/Info-Debug\.plist is not in Xcode's form/);
    assert.match(run.output, /Config\/Info\.plist is not in Xcode's form/);
    assert.ok(
      !fake
        .log('xcodebuild')
        .some((line) => /^(build-for-testing|test-without-building) /.test(line)),
      'nothing built or tested',
    );
  });

  for (const [name, url] of [
    ['empty', ''],
    ['plain HTTP', 'http://production.fivvi.app/api'],
    ['the .invalid placeholder', 'https://production.fivvi.invalid/api'],
  ]) {
    it(`E017 AC5: Release base URL is HTTPS and not .invalid: pnpm test:ios fails on one that is ${name}`, async () => {
      const fake = checkout();

      const run = await fake.run('scripts/test-ios.sh', [], { FAKE_BASE_URL: url });

      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /E017 AC5: Release base URL is not https:\/\/<real host>\/api/);
      assert.ok(
        !fake
          .log('xcodebuild')
          .some((line) => /^(build-for-testing|test-without-building) /.test(line)),
        'nothing built or tested',
      );
    });
  }

  it('E017 AC1: Release declares no non-exempt encryption: pnpm test:ios fails when it does not', async () => {
    const fake = checkout();

    const run = await fake.run('scripts/test-ios.sh', [], { FAKE_ENCRYPTION: 'missing' });

    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /E017 AC1: .* must set ITSAppUsesNonExemptEncryption to NO/);
  });

  it('E017 AC8: bundle and application ID match the recorded final ID: pnpm test:ios fails when the README does not record the bundle ID', async () => {
    const fake = checkout();
    const readme = join(fake.repo, 'apps/ios/README.md');
    writeFileSync(
      readme,
      readFileSync(readme, 'utf8').replace(
        'bundle ID `app.fivvi.pro` (final',
        'bundle ID `app.fivvi.pro` (provisional',
      ),
    );

    const run = await fake.run('scripts/test-ios.sh');

    assert.equal(run.status, 1, run.output);
    assert.match(
      run.output,
      /E017 AC8: bundle ID 'app\.fivvi\.pro' is not the final ID the README records/,
    );
  });

  it('E017 AC4: both platforms read the same version: pnpm test:ios fails when the app resolves another one', async () => {
    const fake = checkout();

    const run = await fake.run('scripts/test-ios.sh', [], { FAKE_VERSION: '9.9.9' });

    assert.equal(run.status, 1, run.output);
    assert.match(
      run.output,
      /E017 AC4: the app's version is '9\.9\.9', not '0\.1\.0' of apps\/Version\.xcconfig/,
    );
    assert.ok(
      !fake
        .log('xcodebuild')
        .some((line) => /^(build-for-testing|test-without-building) /.test(line)),
      'nothing built or tested',
    );
  });

  it('E017 AC4: pnpm test:ios fails when the version of apps/Version.xcconfig is not <major>.<minor>.<patch>', async () => {
    const fake = checkout();
    const file = join(fake.repo, 'apps/Version.xcconfig');
    writeFileSync(file, readFileSync(file, 'utf8').replace('0.1.0', '0.1'));

    const run = await fake.run('scripts/test-ios.sh', [], { FAKE_VERSION: '0.1' });

    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /MARKETING_VERSION is not <major>\.<minor>\.<patch>: '0\.1'/);
  });

  it('E017 AC4: pnpm test:ios fails when the default build number is not 1', async () => {
    const fake = checkout();
    const file = join(fake.repo, 'apps/Version.xcconfig');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        'CURRENT_PROJECT_VERSION = 1',
        'CURRENT_PROJECT_VERSION = 7',
      ),
    );

    const run = await fake.run('scripts/test-ios.sh');

    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /E017 AC4: the default build number is '7'.*not 1/);
  });

  it('E017 AC4: pnpm test:ios fails when a build number passed from outside does not come through', async () => {
    const fake = checkout();

    const run = await fake.run('scripts/test-ios.sh', [], { FAKE_IGNORE_OVERRIDE: '1' });

    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /E017 AC4: CURRENT_PROJECT_VERSION=42 .* resolves to '1', not 42/);
  });

  it('E017 AC4: pnpm test:android also runs BuildInfoTest with a build number passed from outside', async () => {
    const fake = checkout();

    const run = await fake.run('scripts/android.sh', ['test']);

    assert.equal(run.status, 0, run.output);
    assert.ok(
      fake
        .log('gradle')
        .some(
          (line) =>
            line.includes('testDebugUnitTest') &&
            line.includes('--tests app.fivvi.pro.BuildInfoTest') &&
            line.includes('-Pfivvi.buildNumber=42'),
        ),
    );
  });

  it('E017 AC5: Release base URL is HTTPS and not .invalid: pnpm test:android fails when checkReleaseApiBaseUrl accepts a bad address', async () => {
    const fake = checkout();

    const run = await fake.run('scripts/android.sh', ['test'], { FAKE_URL_CHECK: 'accept' });

    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /checkReleaseApiBaseUrl accepted fivvi\.releaseApiBaseUrl=''/);
  });

  it("#95: pnpm test:ios restores the catalogs when Xcode's sync changes them and then fails", async () => {
    const fake = checkout();
    const catalog = join(fake.repo, 'packages/i18n/generated/ios/InfoPlist.xcstrings');
    const committed = readFileSync(catalog, 'utf8');

    const run = await fake.run('scripts/test-ios.sh', [], {
      FAKE_CATALOG_SYNC: 'add',
      FAKE_EXPORT: 'fail',
    });

    assert.equal(run.status, 1, run.output);
    assert.equal(readFileSync(catalog, 'utf8'), committed);
  });

  it("#95: pnpm test:ios restores the catalogs when it is interrupted (Ctrl-C) during Xcode's sync", async () => {
    const fake = checkout();
    const catalog = join(fake.repo, 'packages/i18n/generated/ios/InfoPlist.xcstrings');
    const committed = readFileSync(catalog, 'utf8');

    const run = await fake.run(
      'scripts/test-ios.sh',
      [],
      { FAKE_CATALOG_SYNC: 'add', FAKE_EXPORT: 'hang' },
      { interrupt: true },
    );

    assert.equal(run.status, 130, run.output);
    assert.equal(readFileSync(catalog, 'utf8'), committed);
  });

  it('#95: pnpm test:ios lets Xcode sync the catalogs before the build and the tests and passes when nothing changes', async () => {
    const fake = checkout();

    const run = await fake.run('scripts/test-ios.sh', []);

    assert.equal(run.status, 0, run.output);
    const calls = fake.log('xcodebuild');
    const sync = calls.findIndex((line) => line.startsWith('-exportLocalizations '));
    assert.ok(
      sync >= 0 && sync < calls.findIndex((line) => line.startsWith('build-for-testing ')),
      calls.join('\n'),
    );
  });

  it('AC3: IOS_SIMULATOR overrides the worktree simulator', async () => {
    const fake = checkout();
    const worktree = fake.worktree('feature/9-own-simulator');

    const run = await fake.run(
      'scripts/test-ios.sh',
      [],
      { IOS_SIMULATOR: 'iPhone 17' },
      { cwd: worktree },
    );

    assert.equal(run.status, 0, run.output);
    assert.equal(testedOn(fake.log('xcodebuild')), 'IPHONE-17');
    assert.equal(fake.simulators().length, 2, 'no simulator created');
    assert.equal(fake.simulator('IPHONE-17').state, 'Shutdown');
  });

  const gradleDaemonsStopped = (fake) => {
    const calls = fake.log('gradle');
    const registry = calls[0]?.match(/-Dorg\.gradle\.daemon\.registry\.base=(\S+)/)?.[1] ?? '';
    assert.ok(
      registry.startsWith(`${fake.repo}/`),
      `the daemons have a registry of their own, in this checkout: ${calls[0]}`,
    );
    assert.ok(
      calls.every((call) => call.includes(`-Dorg.gradle.daemon.registry.base=${registry} `)),
      calls.join('\n'),
    );
    assert.match(calls.at(-1), /(^| )--stop( |$)/, 'the daemons are stopped last');
  };

  for (const [name, command, args] of [
    ['pnpm test:android', 'scripts/android.sh', ['test']],
    ['pnpm test:maestro', 'scripts/maestro.sh', ['android']],
  ]) {
    for (const [ending, result, status] of endings) {
      it(`AC2: ${name} kills the emulator it started and stops its Gradle daemons when it ${ending}`, async () => {
        const fake = checkout();

        const run = await fake.run(
          command,
          args,
          { FAKE_RESULT: result },
          {
            interrupt: result === 'hang',
          },
        );

        assert.equal(run.status, status, run.output);
        const { pid, booted } = fake.emulator();
        assert.ok(pid > 0, 'the emulator was started');
        assert.ok(fake.log('adb').includes('emu kill'));
        assert.ok(!booted && !running(pid), 'the emulator is gone');
        gradleDaemonsStopped(fake);
      });
    }

    it(`AC2: ${name} leaves an emulator that was already running, and still stops its Gradle daemons`, async () => {
      const fake = checkout({ emulatorRunning: true });

      const run = await fake.run(command, args);

      assert.equal(run.status, 0, run.output);
      assert.ok(!fake.log('adb').includes('emu kill'));
      assert.ok(fake.emulator().booted);
      gradleDaemonsStopped(fake);
    });
  }

  it('AC4: KEEP_DEVICE=1 leaves the emulator and the Gradle daemons pnpm test:android started running', async () => {
    const fake = checkout();

    const run = await fake.run('scripts/android.sh', ['test'], { KEEP_DEVICE: '1' });

    assert.equal(run.status, 0, run.output);
    assert.ok(!fake.log('adb').includes('emu kill'));
    assert.ok(running(fake.emulator().pid));
    assert.ok(fake.log('gradle').every((call) => !/(^| )--stop( |$)/.test(call)));
  });

  // #89: the first locale's flow didn't see the greeting within its 20 s. The app's first screen calls
  // GET /api/v1/hello?locale=<its language>, and the flow started while Android was still busy after the framework
  // restart that sets the device language (System UI stopped responding and its dialog covered the app).
  const isFlow = (call) => / test /.test(` ${call} `) && call.startsWith('maestro ');
  const hello = (locale) => `http://127.0.0.1:3999/api/v1/hello?locale=${locale}`;

  for (const [name, args] of [
    ['maestro.sh android', ['android']],
    ['maestro.sh ios', ['ios']],
  ]) {
    it(`#89: ${name} warms up GET /api/v1/hello in nl-NL and en before the first flow`, async () => {
      const fake = checkout();

      const run = await fake.run('scripts/maestro.sh', args);

      assert.equal(run.status, 0, run.output);
      const calls = fake.log('calls');
      const firstFlow = calls.findIndex(isFlow);
      const health = calls.findIndex((call) => call.includes('/api/v1/health'));
      assert.ok(firstFlow > 0, calls.join('\n'));
      for (const locale of ['nl-NL', 'en']) {
        const warmUp = calls.findIndex(
          (call) => call.startsWith('curl ') && call.includes(` ${hello(locale)}`),
        );
        assert.ok(
          health < warmUp && warmUp < firstFlow,
          `GET ${hello(locale)} after the health check, before the first flow:\n${calls.join('\n')}`,
        );
      }
    });

    it(`#89: ${name} runs no flow when GET /api/v1/hello fails`, async () => {
      const fake = checkout({ emulatorRunning: true, simulatorBooted: true });

      const run = await fake.run('scripts/maestro.sh', args, { FAKE_HELLO: 'fail' });

      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /\/api\/v1\/hello\?locale=nl-NL/);
      assert.ok(!fake.log('calls').some(isFlow), fake.log('calls').join('\n'));
    });
  }

  it('#89: maestro.sh android waits for Android to deliver its broadcasts after each language change, before the flow', async () => {
    const fake = checkout();

    const run = await fake.run('scripts/maestro.sh', ['android']);

    assert.equal(run.status, 0, run.output);
    const steps = fake
      .log('calls')
      .map((call) => {
        if (isFlow(call)) return `flow ${call.match(/android-(\S+)\.xml/)[1]}`;
        if (/setprop persist\.sys\.locale \S+;/.test(call))
          return `language ${call.match(/persist\.sys\.locale ([^;]+);/)[1]}`;
        if (call === 'adb shell am wait-for-broadcast-idle') return 'settled';
        return '';
      })
      .filter(Boolean);
    assert.deepEqual(steps, [
      'language nl-NL',
      'settled',
      'flow nl-NL',
      'language en',
      'settled',
      'flow en',
    ]);
  });

  it("#89: maestro.sh android hides Android's error dialogs for the flows, then restores the setting", async () => {
    const fake = checkout({ emulatorRunning: true });

    const run = await fake.run('scripts/maestro.sh', ['android']);

    assert.equal(run.status, 0, run.output);
    const calls = fake.log('calls');
    const hidden = calls.indexOf('adb shell settings put global hide_error_dialogs 1');
    const restored = calls.lastIndexOf('adb shell settings delete global hide_error_dialogs');
    const firstLanguage = calls.findIndex((call) =>
      call.includes('setprop persist.sys.locale nl-NL;'),
    );
    const ownLanguage = calls.findIndex((call) =>
      call.includes('setprop persist.sys.locale en-US;'),
    );
    assert.ok(
      hidden >= 0 && hidden < firstLanguage,
      `hidden before the first flow and its framework restart:\n${calls.join('\n')}`,
    );
    assert.ok(
      ownLanguage > calls.findLastIndex(isFlow) && restored > ownLanguage,
      `the setting the device had (none) is back, after its language's framework restart:\n${calls.join('\n')}`,
    );
  });
});

// ios-device.sh in a copy of the repo with a fake Xcode: `devicectl list devices` reports <state>/devices.json,
// `xcodebuild build` writes the app with an Info.plist, and every call is logged. FAKE_LOCKED=install|launch makes that
// devicectl step fail the way it does on a locked iPhone.
describe('E008 #95 ios-device.sh runs the Debug app on a real iPhone', () => {
  const dirs = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  // devicectl's layout; `legacy` is the one an older Xcode writes, whose fields newer ones deprecate.
  const device = (
    udid,
    name,
    { reality = 'physical', type = 'iPhone', paired = true, legacy = false } = {},
  ) => {
    const hardware = { udid, reality, deviceType: type, platform: 'iOS' };
    const connection = { pairingState: paired ? 'paired' : 'unpaired' };
    return legacy
      ? {
          identifier: `CORE-${udid}`,
          deviceProperties: { name },
          hardwareProperties: hardware,
          connectionProperties: connection,
        }
      : { identifier: `CORE-${udid}`, properties: { hardware, connection, state: { name } } };
  };
  const phone = device('PHONE-1', 'Test iPhone');
  const others = [
    device('SIM-1', 'iPhone 18 Pro', { reality: 'simulated' }),
    device('IPAD-1', 'Test iPad', { type: 'iPad' }),
    device('PHONE-9', 'Unpaired iPhone', { paired: false }),
  ];
  const localXcconfig =
    'DEVELOPMENT_TEAM = TEAM000001\nFIVVI_API_BASE_URL = http:/$()/mac.local:3000/api\n';

  const checkout = ({ devices = [phone, ...others], local = localXcconfig } = {}) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'ios-device-')));
    dirs.push(base);
    const repo = join(base, 'repo');
    const state = join(base, 'state');
    const bin = join(base, 'bin');
    mkdirSync(state);
    writeFileSync(join(state, 'devices.json'), JSON.stringify({ result: { devices } }));

    execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo]);
    cpSync(SCRIPTS, join(repo, 'scripts'), { recursive: true });
    for (const path of [
      'apps/ios/.gitignore',
      'apps/ios/Config/Debug.xcconfig',
      'apps/ios/Config/Info-Debug.plist',
      'packages/i18n/generated/ios',
    ]) {
      cpSync(join(SCRIPTS, '..', path), join(repo, path), { recursive: true });
    }
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--quiet',
      '-m',
      'chore: init',
    ]);
    if (local !== null) writeFileSync(join(repo, 'apps/ios/Config/Local.xcconfig'), local);

    const locked = (step) =>
      `[ "$FAKE_LOCKED" != ${step} ] || { echo "ERROR: The device was not, or could not be, unlocked. (com.apple.dt.CoreDeviceError error 4000.)" >&2; exit 1; }`;
    script(
      join(bin, 'xcrun'),
      `echo "$*" >>"${state}/xcrun.log"
case "$1 $2" in
  "devicectl list") [ "$FAKE_LIST" != fail ] || { echo "ERROR: CoreDevice service unavailable" >&2; exit 1; }
    cat "${state}/devices.json" ;;
  "devicectl device") case "$3" in install) ${locked('install')} ;; process) ${locked('launch')} ;; esac ;;
esac
exit 0`,
    );
    script(
      join(bin, 'xcodebuild'),
      `echo "$*" >>"${state}/xcodebuild.log"
data=""
while [ $# -gt 0 ]; do
  case "$1" in
    -derivedDataPath) data="$2"; shift ;;
    build) app="$data/Build/Products/Debug-iphoneos/FivviPro.app"; mkdir -p "$app"
      echo '<plist><dict><key>CFBundleIdentifier</key><string>test.fivvi.pro</string></dict></plist>' >"$app/Info.plist" ;;
  esac
  shift
done
exit 0`,
    );
    script(
      join(bin, 'plutil'),
      `[ "$1" = -extract ] || exit 1
sed -nE "s#.*<key>$2</key><string>([^<]*)</string>.*#\\1#p" "\${@: -1}"`,
    );

    const run = (args = [], extraEnv = {}) => {
      const result = spawnSync(join(repo, 'scripts/ios-device.sh'), args, {
        cwd: repo,
        encoding: 'utf8',
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: base, ...extraEnv },
      });
      return { status: result.status, output: result.stdout + result.stderr };
    };
    const log = (name) =>
      existsSync(join(state, `${name}.log`))
        ? readFileSync(join(state, `${name}.log`), 'utf8')
            .split('\n')
            .filter(Boolean)
        : [];
    const builds = () => log('xcodebuild').filter((line) => / build$/.test(line));
    const devicectl = () =>
      log('xcrun')
        .filter((line) => line.startsWith('devicectl device '))
        .map((line) => line.replace(`${repo}/`, ''));
    const status = () =>
      execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
    const localFile = () => readFileSync(join(repo, 'apps/ios/Config/Local.xcconfig'), 'utf8');
    return { run, builds, devicectl, status, localFile };
  };

  const app = 'apps/ios/.build/DerivedData/Build/Products/Debug-iphoneos/FivviPro.app';

  it('AC1: builds the Debug app for the paired iPhone, signed through Local.xcconfig, then installs and launches it', () => {
    const fake = checkout();

    const run = fake.run();

    assert.equal(run.status, 0, run.output);
    const [build, ...more] = fake.builds();
    assert.deepEqual(more, [], 'one build');
    assert.match(build, / -configuration Debug /);
    assert.match(build, / -destination id=PHONE-1 /);
    assert.match(build, / -allowProvisioningUpdates /);
    assert.doesNotMatch(
      build,
      /CODE_SIGN|DEVELOPMENT_TEAM|FIVVI_API_BASE_URL/,
      'all from Local.xcconfig',
    );
    assert.deepEqual(fake.devicectl(), [
      `devicectl device install app --device PHONE-1 ${app}`,
      'devicectl device process launch --device PHONE-1 --terminate-existing test.fivvi.pro',
    ]);
    assert.match(run.output, /Test iPhone/);
    assert.match(run.output, /http:\/\/mac\.local:3000\/api/);
  });

  // What Xcode itself may write on a build (the catalog sync) is pnpm test:ios's catalog_sync check.
  it("AC1: the script's own steps write no tracked file and leave Local.xcconfig alone", () => {
    const fake = checkout();

    const run = fake.run(['nl']);

    assert.equal(run.status, 0, run.output);
    assert.equal(fake.status(), '');
    assert.equal(fake.localFile(), localXcconfig);
  });

  for (const language of ['nl', 'en']) {
    it(`AC1: launches the app with the device language ${language} (-AppleLanguages)`, () => {
      const fake = checkout();

      const run = fake.run([language]);

      assert.equal(run.status, 0, run.output);
      assert.equal(
        fake.devicectl().at(-1),
        `devicectl device process launch --device PHONE-1 --terminate-existing test.fivvi.pro -- -AppleLanguages (${language})`,
      );
    });
  }

  it('AC1: IOS_DEVICE picks one of several paired iPhones; without it the script names them', () => {
    const second = device('PHONE-2', 'Second iPhone');
    const fake = checkout({ devices: [phone, second, ...others] });

    const unpicked = fake.run();
    const picked = fake.run([], { IOS_DEVICE: 'PHONE-2' });

    assert.equal(unpicked.status, 1);
    assert.match(unpicked.output, /IOS_DEVICE=/);
    assert.match(unpicked.output, /PHONE-1 Test iPhone/);
    assert.match(unpicked.output, /PHONE-2 Second iPhone/);
    assert.equal(picked.status, 0, picked.output);
    assert.equal(fake.builds().length, 1, 'only the picked run builds');
    assert.match(fake.builds()[0], / -destination id=PHONE-2 /);
  });

  it("AC1: finds the iPhone in an older Xcode's devicectl layout too", () => {
    const fake = checkout({
      devices: [device('PHONE-3', 'Old iPhone', { legacy: true }), ...others],
    });

    const run = fake.run();

    assert.equal(run.status, 0, run.output);
    assert.match(fake.builds()[0], / -destination id=PHONE-3 /);
    assert.match(run.output, /Old iPhone/);
  });

  it('AC1: fails when IOS_DEVICE is not a paired iPhone', () => {
    const fake = checkout();

    const run = fake.run([], { IOS_DEVICE: 'PHONE-9' });

    assert.equal(run.status, 1);
    assert.match(run.output, /IOS_DEVICE=PHONE-9 is not a paired iPhone/);
    assert.deepEqual(fake.builds(), []);
  });

  it('AC1: without a paired iPhone it explains how to connect one, and builds nothing', () => {
    const fake = checkout({ devices: others });

    const run = fake.run();

    assert.equal(run.status, 1);
    assert.match(run.output, /no paired iPhone/);
    assert.match(run.output, /cable/);
    assert.match(run.output, /Developer Mode/);
    assert.deepEqual(fake.builds(), []);
  });

  it('says so when devicectl itself fails to list the devices, and builds nothing', () => {
    const fake = checkout();

    const run = fake.run([], { FAKE_LIST: 'fail' });

    assert.equal(run.status, 1);
    assert.match(run.output, /CoreDevice service unavailable/);
    assert.match(run.output, /devicectl list devices failed/);
    assert.deepEqual(fake.builds(), []);
  });

  for (const [name, local] of [
    ['no Local.xcconfig', null],
    [
      'no DEVELOPMENT_TEAM in Local.xcconfig',
      'FIVVI_API_BASE_URL = http:/$()/mac.local:3000/api\n',
    ],
  ]) {
    it(`AC1: with ${name} it explains that a signing team is missing, and builds nothing`, () => {
      const fake = checkout({ local });

      const run = fake.run();

      assert.equal(run.status, 1);
      assert.match(run.output, /DEVELOPMENT_TEAM/);
      assert.match(run.output, /apps\/ios\/Config\/Local\.xcconfig/);
      assert.deepEqual(fake.builds(), []);
      assert.deepEqual(fake.devicectl(), []);
    });
  }

  it("AC1: warns when Local.xcconfig has no API base URL, since the phone's localhost is the phone", () => {
    const fake = checkout({ local: 'DEVELOPMENT_TEAM = TEAM000001\n' });

    const run = fake.run();

    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /FIVVI_API_BASE_URL/);
    assert.match(run.output, /localhost/);
  });

  for (const step of ['install', 'launch']) {
    it(`AC1: says to unlock the iPhone when it is locked at ${step}`, () => {
      const fake = checkout();

      const run = fake.run([], { FAKE_LOCKED: step });

      assert.equal(run.status, 1);
      assert.match(run.output, /could not be, unlocked/);
      assert.match(run.output, /unlock Test iPhone and run scripts\/ios-device\.sh again/);
    });
  }

  it('prints its usage for an unknown argument', () => {
    const run = checkout().run(['de']);

    assert.equal(run.status, 1);
    assert.match(run.output, /ios-device\.sh \[nl\|en\]/);
    assert.doesNotMatch(run.output, /set -euo|source /);
  });
});

// Maestro names each flow's report folder after the flow (its `name`, else the file name), and CI uploads those
// folders: actions/upload-artifact rejects paths with " : < > | * ? \ or line breaks. Maestro turns / into _.
describe('Maestro flows', () => {
  const flows = join(SCRIPTS, '../e2e/maestro');

  it('have names that upload-artifact accepts as paths', () => {
    const files = readdirSync(flows).filter(
      (file) => /\.ya?ml$/.test(file) && file !== 'config.yaml',
    );
    assert.ok(files.length > 0, 'no flows found');
    for (const file of files) {
      const header = readFileSync(join(flows, file), 'utf8').split(/^---$/m)[0];
      const name = header.match(/^name:\s*["']?(.*?)["']?\s*$/m)?.[1] ?? file;
      assert.doesNotMatch(name, /[":<>|*?\\\r\n]/, `${file}: flow name "${name}"`);
    }
  });

  // #89: the flake is fixed in maestro.sh, not by waiting longer or asserting less: the hello flow still fails when the
  // greeting doesn't appear within 20 s, and then checks its text.
  it('#89: hello waits at most 20 s for the greeting and requires it', () => {
    const steps = readFileSync(join(flows, 'hello.yaml'), 'utf8').split(/^---$/m)[1];
    assert.doesNotMatch(steps, /optional:\s*true/);
    const wait = steps.match(
      /- extendedWaitUntil:\n\s+visible:\n\s+id: hello\\\.greeting\n\s+timeout: (\d+)\n/,
    );
    assert.ok(wait, steps);
    assert.ok(Number(wait[1]) <= 20000, `timeout ${wait[1]} ms`);
    assert.match(
      steps.slice(wait.index),
      /- assertVisible:\n\s+id: hello\\\.greeting\n\s+text: \$\{HELLO_TITLE\}\n/,
    );
  });
});

describe('commit-msg hook', () => {
  const hook = join(SCRIPTS, '../.githooks/commit-msg');
  const run = (message) => {
    const dir = mkdtempSync(join(tmpdir(), 'commit-msg-'));
    const file = join(dir, 'MSG');
    writeFileSync(file, `${message}\n\n# comment\n`);
    // The hook also checks who is committing; give it a known noreply identity, whatever the machine has.
    const result = spawnSync(hook, [file], {
      cwd: SCRIPTS,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Octo',
        GIT_AUTHOR_EMAIL: '42+octocat@users.noreply.github.com',
        GIT_COMMITTER_NAME: 'Octo',
        GIT_COMMITTER_EMAIL: '42+octocat@users.noreply.github.com',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
    rmSync(dir, { recursive: true, force: true });
    return result;
  };

  it('accepts Conventional Commits and merges, rejects the rest', () => {
    assert.equal(run('feat(F031): hold a spot').status, 0);
    assert.equal(run('Merge branch main').status, 0);
    const bad = run('Hold a spot');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Conventional Commit/);
  });
});

describe('wt.sh done', () => {
  let base;
  let repo;
  let bin;

  const git = (cwd, ...args) =>
    execFileSync(
      'git',
      ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
      {
        encoding: 'utf8',
      },
    ).trim();

  const fakeGh = (state, headRefOid) => {
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env bash\necho '${JSON.stringify([{ number: 60, state, headRefOid }])}' | jq -r "\${@: -1}"\n`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
  };
  const done = (...args) =>
    spawnSync(join(repo, 'scripts/wt.sh'), ['done', 'feature/57-hold', ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });

  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'wt-done-')));
    const origin = join(base, 'origin.git');
    repo = join(base, 'repo');
    bin = join(base, 'bin');
    mkdirSync(bin);
    // The worktree's own simulator (pnpm test:ios), booted, next to the shared one.
    mkdirSync(join(base, 'state/devices'), { recursive: true });
    for (const device of [
      iPhone('OWN', 'Fivvi feature-57-hold', '27-0', 'Booted'),
      iPhone('SHARED', 'iPhone 18 Pro', '27-0', 'Booted'),
    ]) {
      writeFileSync(join(base, 'state/devices', device.udid), JSON.stringify(device));
    }
    writeFileSync(join(bin, 'xcrun'), `#!/usr/bin/env bash\n${fakeSimctl(join(base, 'state'))}\n`);
    writeFileSync(join(bin, 'xcodebuild'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(bin, 'xcrun'), 0o755);
    chmodSync(join(bin, 'xcodebuild'), 0o755);
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo]);
    cpSync(SCRIPTS, join(repo, 'scripts'), { recursive: true });
    writeFileSync(join(repo, 'README.md'), 'test\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'chore: init');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '--quiet', '-u', 'origin', 'main');
    git(
      repo,
      'worktree',
      'add',
      '--quiet',
      '-b',
      'feature/57-hold',
      join(repo, '.worktrees/feature-57-hold'),
    );
    writeFileSync(join(repo, '.worktrees/feature-57-hold/hold.txt'), 'hold\n');
    git(join(repo, '.worktrees/feature-57-hold'), 'add', '.');
    git(join(repo, '.worktrees/feature-57-hold'), 'commit', '--quiet', '-m', 'feat(F031): hold');
    git(
      join(repo, '.worktrees/feature-57-hold'),
      'push',
      '--quiet',
      '-u',
      'origin',
      'feature/57-hold',
    );
  });

  after(() => rmSync(base, { recursive: true, force: true }));

  it('refuses while the PR is not merged', () => {
    fakeGh('OPEN', git(repo, 'rev-parse', 'feature/57-hold'));
    const result = done();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PR #60 is OPEN, not merged/);
  });

  it('refuses when the local branch has commits that are not in the PR', () => {
    fakeGh('MERGED', git(repo, 'rev-parse', 'main'));
    const result = done();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /commits that are not in PR #60/);
  });

  it('accepts a local branch that is behind the PR head (GitHub updated the branch)', () => {
    const worktree = join(repo, '.worktrees/feature-57-hold');
    writeFileSync(join(worktree, 'update.txt'), 'merged main in on GitHub\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '--quiet', '-m', 'chore: update branch');
    git(worktree, 'push', '--quiet', 'origin', 'feature/57-hold');
    const prHead = git(worktree, 'rev-parse', 'HEAD');
    git(worktree, 'reset', '--quiet', '--hard', 'HEAD~1');
    fakeGh('MERGED', prHead);
    const result = done('--check');
    assert.equal(result.status, 0, result.stderr);
    git(worktree, 'reset', '--quiet', '--hard', prHead);
  });

  it('accepts a local head whose tree is the PR head tree after "Update branch" (E002 #108)', () => {
    const worktree = join(repo, '.worktrees/feature-57-hold');
    const original = git(worktree, 'rev-parse', 'HEAD');
    // main moves on; the local branch merges it (the commit pnpm flow made), and GitHub's "Update branch"
    // makes another merge commit with the same parents and the same files.
    writeFileSync(join(repo, 'main-news.txt'), 'news\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'chore: main moves on');
    git(repo, 'push', '--quiet', 'origin', 'main');
    git(worktree, 'merge', '--quiet', '--no-ff', '-m', 'chore: merge main', 'main');
    const local = git(worktree, 'rev-parse', 'HEAD');
    const [, first, second] = git(worktree, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ');
    const prHead = git(
      worktree,
      'commit-tree',
      `${local}^{tree}`,
      '-p',
      first,
      '-p',
      second,
      '-m',
      "Merge branch 'main' into feature/57-hold",
    );
    assert.notEqual(prHead, local);
    fakeGh('MERGED', prHead);
    const result = done('--check');
    git(worktree, 'reset', '--quiet', '--hard', original);
    assert.equal(result.status, 0, result.stderr);
  });

  it('accepts a rewritten local head whose tree is a PR commit before the PR head (E002 #108)', () => {
    const worktree = join(repo, '.worktrees/feature-57-hold');
    const original = git(worktree, 'rev-parse', 'HEAD');
    writeFileSync(join(worktree, 'step-1.txt'), 'one\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '--quiet', '-m', 'feat(F031): step 1');
    const step = git(worktree, 'rev-parse', 'HEAD');
    writeFileSync(join(worktree, 'step-2.txt'), 'two\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '--quiet', '-m', 'feat(F031): step 2');
    const prHead = git(worktree, 'rev-parse', 'HEAD');
    // The local branch was rewritten (e.g. a rebase): same tree as step 1, a different commit, not an ancestor of the PR head.
    const rewritten = git(
      worktree,
      'commit-tree',
      `${step}^{tree}`,
      '-p',
      original,
      '-m',
      'feat(F031): step 1 (rewritten)',
    );
    git(worktree, 'reset', '--quiet', '--hard', rewritten);
    fakeGh('MERGED', prHead);
    const result = done('--check');
    git(worktree, 'reset', '--quiet', '--hard', original);
    assert.equal(result.status, 0, result.stderr);
  });

  it('still refuses a local commit whose tree is not in the PR (E002 #108)', () => {
    const worktree = join(repo, '.worktrees/feature-57-hold');
    const prHead = git(worktree, 'rev-parse', 'HEAD');
    writeFileSync(join(worktree, 'local-only.txt'), 'not in the PR\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '--quiet', '-m', 'feat(F031): local only');
    fakeGh('MERGED', prHead);
    const result = done('--check');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /commits that are not in PR #60/);
    git(worktree, 'reset', '--quiet', '--hard', prHead);
  });

  it('removes the worktree, both branches and the worktree simulator once merged (E008 #71 AC3)', () => {
    const simulators = () => readdirSync(join(base, 'state/devices')).sort();
    fakeGh('MERGED', git(repo, 'rev-parse', 'feature/57-hold'));
    assert.equal(done('--check').status, 0);
    assert.ok(existsSync(join(repo, '.worktrees/feature-57-hold')), '--check changes nothing');
    assert.deepEqual(simulators(), ['OWN', 'SHARED'], '--check changes nothing');

    const result = done();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(join(repo, '.worktrees/feature-57-hold')));
    assert.equal(git(repo, 'branch', '--list', 'feature/57-hold'), '');
    assert.equal(git(repo, 'ls-remote', '--heads', 'origin', 'feature/57-hold'), '');
    assert.deepEqual(simulators(), ['SHARED']);
    assert.match(result.stdout, /deleted simulator 'Fivvi feature-57-hold'/);
  });
});
