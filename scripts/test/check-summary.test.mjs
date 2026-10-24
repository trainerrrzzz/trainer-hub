import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';

const SCRIPTS = join(import.meta.dirname, '..');

// What turbo prints for a task: every line behind "<package>:<task>: ".
const task = (name, ...lines) => lines.map((line) => `${name}: ${line}`);
const vitest = (pkg, task_, summary) =>
  task(
    `@fivvi/${pkg}:${task_}`,
    '$ vitest run',
    ' ✓ test/a.test.ts (3 tests) 10ms',
    '',
    ' Test Files  1 passed (1)',
    `      Tests  ${summary}`,
    '   Start at  13:20:00',
    '   Duration  693ms (import 74%, tests 3%)',
  );
const node = (pass, fail, skipped) =>
  task(
    '//:test:root',
    '  ✔ does a thing (1.2ms)',
    `ℹ tests ${pass + fail + skipped}`,
    'ℹ suites 4',
    `ℹ pass ${pass}`,
    `ℹ fail ${fail}`,
    'ℹ cancelled 0',
    `ℹ skipped ${skipped}`,
    'ℹ todo 0',
  );
const playwright = (...lines) => task('@fivvi/web:test:e2e', 'Running 15 tests', ...lines);
const failed = (name) => [
  `@fivvi/${name}: [ELIFECYCLE] Test failed. See above for more details.`,
  `@fivvi/${name.replace(':', '#')}:  ERROR  command (/x/y) pnpm run test exited (1)`,
];

const suite = (name, kind, status, passed, failed_, skipped) => ({
  name,
  kind,
  status,
  passed,
  failed: failed_,
  skipped,
});

describe('E002 #112 test-summary.sh', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'test-summary-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  let n = 0;
  const summarize = (lines, ...args) => {
    const log = join(dir, `${n++}.log`);
    const json = join(dir, `${n}.json`);
    writeFileSync(log, `${lines.join('\n')}\n`);
    const result = spawnSync(join(SCRIPTS, 'test-summary.sh'), ['--json', json, ...args, log], {
      encoding: 'utf8',
    });
    return { ...result, json: existsSync(json) ? JSON.parse(readFileSync(json, 'utf8')) : null };
  };

  it('E002 #112 AC1: counts what each unit suite passed, failed and skipped, in the JSON and in a table', () => {
    const result = summarize(
      [
        ...vitest('ui', 'test', '33 passed (33)'),
        ...node(260, 0, 2),
        ...vitest('api', 'test', '29 passed (29)'),
      ],
      '--run',
      'unit',
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.json, {
      suites: [
        suite('root', 'unit', 'pass', 260, 0, 2),
        suite('api', 'unit', 'pass', 29, 0, 0),
        suite('ui', 'unit', 'pass', 33, 0, 0),
      ],
      total: { passed: 322, failed: 0, skipped: 2 },
    });
    assert.match(result.stdout, /root\s+pass\s+260\s+0\s+2\n/);
    assert.match(result.stdout, /ui\s+pass\s+33\s+0\s+0\n/);
  });

  it('E002 #112 AC1: reports a failing suite with its failures, next to the suites that passed', () => {
    const result = summarize(
      [
        ...vitest('ui', 'test', '1 failed | 34 passed | 1 skipped (36)'),
        ...failed('ui:test'),
        ...vitest('api', 'test', '29 passed (29)'),
      ],
      '--run',
      'unit',
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.json.suites, [
      suite('api', 'unit', 'pass', 29, 0, 0),
      suite('ui', 'unit', 'fail', 34, 1, 1),
    ]);
    assert.deepEqual(result.json.total, { passed: 63, failed: 1, skipped: 1 });
    assert.match(result.stdout, /ui\s+fail\s+34\s+1\s+1\n/);
  });

  it('E002 #112 AC1: reports a suite that failed before it printed counts as failed, with no counts', () => {
    const result = summarize(
      [...task('@fivvi/ui:test', '$ vitest run'), ...failed('ui:test')],
      '--run',
      'unit',
    );
    assert.deepEqual(result.json.suites, [
      { name: 'ui', kind: 'unit', status: 'fail', passed: null, failed: null, skipped: null },
    ]);
    assert.match(result.stdout, /ui\s+fail\s+-\s+-\s+-\n/);
  });

  it('E002 #112 AC1: counts node:test cancelled tests as failed and todo tests as skipped', () => {
    const result = summarize(
      task(
        '//:test:root',
        'ℹ tests 10',
        'ℹ pass 6',
        'ℹ fail 1',
        'ℹ cancelled 2',
        'ℹ skipped 0',
        'ℹ todo 1',
      ),
      '--run',
      'unit',
    );
    assert.deepEqual(result.json.suites, [suite('root', 'unit', 'fail', 6, 3, 1)]);
  });

  it('E002 #112 AC1: keeps integration and e2e suites apart from the unit suite of the same package', () => {
    const result = summarize(
      [
        ...vitest('api', 'test', '29 passed (29)'),
        ...vitest('api', 'test:integration', '12 passed (12)'),
        ...vitest('database', 'test:integration', '1 failed | 8 passed (9)'),
        ...playwright('  1 skipped', '  2 flaky', '  12 passed (3.2s)'),
      ],
      '--run',
      'unit',
      '--run',
      'integration',
      '--run',
      'e2e',
    );
    assert.deepEqual(result.json.suites, [
      suite('api', 'unit', 'pass', 29, 0, 0),
      suite('api integration', 'integration', 'pass', 12, 0, 0),
      suite('database integration', 'integration', 'fail', 8, 1, 0),
      suite('web e2e', 'e2e', 'pass', 14, 0, 1),
    ]);
    assert.deepEqual(result.json.total, { passed: 63, failed: 1, skipped: 1 });
  });

  it('E002 #112 AC1: counts failed Playwright tests', () => {
    const result = summarize(
      playwright('  2 failed', '    [chromium] › a.spec.ts:3:1 › one', '  13 passed (4s)'),
      '--run',
      'e2e',
    );
    assert.deepEqual(result.json.suites, [suite('web e2e', 'e2e', 'fail', 13, 2, 0)]);
  });

  it('E002 #112 AC1: lists the kinds it was told to skip as skipped, without counts', () => {
    const result = summarize(
      vitest('ui', 'test', '33 passed (33)'),
      '--run',
      'unit',
      '--skip',
      'integration',
      '--skip',
      'e2e',
    );
    assert.deepEqual(result.json.suites, [
      suite('ui', 'unit', 'pass', 33, 0, 0),
      {
        name: 'integration',
        kind: 'integration',
        status: 'skipped',
        passed: null,
        failed: null,
        skipped: null,
      },
      { name: 'e2e', kind: 'e2e', status: 'skipped', passed: null, failed: null, skipped: null },
    ]);
    assert.deepEqual(result.json.total, { passed: 33, failed: 0, skipped: 0 });
    assert.match(result.stdout, /integration\s+skipped\s+-\s+-\s+-\n/);
  });

  it('E002 #112 AC1: reports a kind that ran but printed no counts as having no results', () => {
    const result = summarize(['Docker is not running — start it'], '--run', 'integration');
    assert.deepEqual(result.json.suites, [
      {
        name: 'integration',
        kind: 'integration',
        status: 'no-results',
        passed: null,
        failed: null,
        skipped: null,
      },
    ]);
  });

  it('E002 #112 AC1: lists expected suites with no output as not-run, unless their kind was skipped', () => {
    const result = summarize(
      vitest('ui', 'test', '33 passed (33)'),
      '--run',
      'unit',
      '--skip',
      'integration',
      '--expect',
      '@fivvi/ui:test',
      '--expect',
      '@fivvi/api:test',
      '--expect',
      '@fivvi/api:test:integration',
    );
    assert.deepEqual(
      result.json.suites.map(({ name, status }) => [name, status]),
      [
        ['api', 'not-run'],
        ['ui', 'pass'],
        ['integration', 'skipped'],
      ],
    );
  });

  const cancelled = (pkg) =>
    task(
      `@fivvi/${pkg}:test`,
      'cache miss, executing 5edc6df4868ce48f',
      '$ vitest run',
      '',
      ' RUN  v5.0.1 /x/y',
    );

  it('E002 #112 AC1: lists a task that started and was cancelled, with no counts and no error, as not-run', () => {
    const result = summarize(
      [...vitest('ui', 'test', '33 passed (33)'), ...cancelled('api')],
      '--run',
      'unit',
    );
    assert.deepEqual(result.json.suites, [
      { name: 'api', kind: 'unit', status: 'not-run', passed: null, failed: null, skipped: null },
      suite('ui', 'unit', 'pass', 33, 0, 0),
    ]);
  });

  it('E002 #112 AC1: ignores colours and the output of other tasks', () => {
    const result = summarize(
      [
        '@fivvi/ui:lint: Checked 9 files in 4ms. No fixes applied.',
        ...vitest('ui', 'test', '\u001b[32m33 passed\u001b[39m (33)').map((line) =>
          line.replace('      Tests', '\u001b[2m      Tests\u001b[22m'),
        ),
      ],
      '--run',
      'unit',
    );
    assert.deepEqual(result.json.suites, [suite('ui', 'unit', 'pass', 33, 0, 0)]);
  });

  it('E002 #112 AC1: exits non-zero, with no JSON, on an unknown option', () => {
    const json = join(dir, 'unknown-option.json');
    const result = spawnSync(join(SCRIPTS, 'test-summary.sh'), ['--json', json, '--nope'], {
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.ok(!existsSync(json), 'no JSON is written');
  });
});

describe('E002 #112 check.sh prints and writes the test summary', () => {
  let base;
  const bin = () => join(base, 'bin');
  const repo = () => join(base, 'repo');

  const write = (path, text, mode) => {
    writeFileSync(path, text);
    if (mode) chmodSync(path, mode);
  };

  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'check-summary-')));
    mkdirSync(bin());
    // The fake runners: pnpm answers each turbo run with the canned log and exit code of the scenario.
    write(
      join(bin(), 'pnpm'),
      `#!/usr/bin/env bash
case "$*" in
  *"run lint"*) name=unit ;;
  *"test:integration"*) name=integration ;;
  *"test:e2e"*) name=e2e ;;
  *) exit 0 ;;
esac
[ ! -f "$FAKE_RUNS/$name.log" ] || cat "$FAKE_RUNS/$name.log"
exit "$(cat "$FAKE_RUNS/$name.exit" 2>/dev/null || echo 0)"
`,
      0o755,
    );
    for (const fake of ['docker', 'shellcheck'])
      write(join(bin(), fake), '#!/bin/sh\nexit 0\n', 0o755);

    mkdirSync(join(repo(), 'scripts'), { recursive: true });
    mkdirSync(join(repo(), '.githooks'));
    mkdirSync(join(repo(), 'node_modules'));
    mkdirSync(join(repo(), 'packages/database'), { recursive: true });
    // The workspace whose suites check.sh expects: the root, api (unit and integration), ui (unit) and web (e2e).
    const workspace = {
      'packages/api': { test: 'vitest run', 'test:integration': 'vitest run' },
      'packages/ui': { test: 'vitest run' },
      'apps/web': { 'test:e2e': 'playwright test', lint: 'biome lint' },
    };
    for (const [dir, scripts] of Object.entries(workspace)) {
      mkdirSync(join(repo(), dir), { recursive: true });
      const name = `@fivvi/${dir.split('/')[1]}`;
      write(join(repo(), dir, 'package.json'), JSON.stringify({ name, scripts }));
    }
    for (const file of [
      'check.sh',
      '_lib.sh',
      '_shellcheck.sh',
      'test-summary.sh',
      'test-summary.jq',
    ]) {
      copyFileSync(join(SCRIPTS, file), join(repo(), 'scripts', file));
    }
    // The other checks are not under test here.
    for (const other of ['skills', 'agents', 'emails', 'secrets']) {
      write(join(repo(), 'scripts', `${other}.sh`), '#!/usr/bin/env bash\nexit 0\n', 0o755);
    }
    write(join(repo(), '.githooks/pre-push'), '#!/usr/bin/env bash\nexit 0\n', 0o755);
    write(join(repo(), 'packages/database/.env'), 'DATABASE_URL=postgres://test\n');
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo()], { env: gitEnv() });
    git('add', '.');
    git('commit', '--quiet', '-m', 'chore(E002): fake repo');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  // No identity or config of the machine: not the git identity, not HOME's config.
  const gitEnv = () => ({
    PATH: process.env.PATH,
    HOME: base,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@users.noreply.github.com',
  });
  const git = (...args) =>
    execFileSync('git', ['-C', repo(), ...args], { encoding: 'utf8', env: gitEnv() });

  let n = 0;
  const check = (runs, args = [], setup = () => {}) => {
    const dir = join(base, `runs-${n++}`);
    mkdirSync(dir);
    for (const [name, { lines, exit = 0 }] of Object.entries(runs)) {
      write(join(dir, `${name}.log`), `${lines.join('\n')}\n`);
      write(join(dir, `${name}.exit`), `${exit}\n`);
    }
    rmSync(join(repo(), '.work'), { recursive: true, force: true });
    setup();
    const result = spawnSync(join(repo(), 'scripts/check.sh'), args, {
      encoding: 'utf8',
      cwd: repo(),
      env: { ...gitEnv(), PATH: `${bin()}:${process.env.PATH}`, FAKE_RUNS: dir },
    });
    const file = join(repo(), '.work/check-summary.json');
    return { ...result, summary: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null };
  };

  const unit = () => ({
    lines: [
      ...node(260, 0, 0),
      ...vitest('api', 'test', '29 passed (29)'),
      ...vitest('ui', 'test', '33 passed (33)'),
    ],
  });
  const integration = {
    lines: vitest('api', 'test:integration', '12 passed (12)'),
  };
  const e2e = { lines: playwright('  15 passed (3.2s)') };

  it('E002 #112 AC1: prints a table and writes the JSON when every suite passes', () => {
    const result = check({ unit: unit(), integration, e2e });
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(result.summary, {
      suites: [
        suite('root', 'unit', 'pass', 260, 0, 0),
        suite('api', 'unit', 'pass', 29, 0, 0),
        suite('ui', 'unit', 'pass', 33, 0, 0),
        suite('api integration', 'integration', 'pass', 12, 0, 0),
        suite('web e2e', 'e2e', 'pass', 15, 0, 0),
      ],
      total: { passed: 349, failed: 0, skipped: 0 },
    });
    assert.match(result.stdout, /root\s+pass\s+260\s+0\s+0\n/);
    assert.match(result.stdout, /web e2e\s+pass\s+15\s+0\s+0\n/);
    assert.ok(
      result.stdout.indexOf('web e2e') > result.stdout.indexOf('✓ e2e tests'),
      'the table comes after the checks',
    );
  });

  const failingUnit = {
    lines: [
      ...node(260, 0, 0),
      ...task('@fivvi/api:test', 'PASSING-API-OUTPUT', ' Tests  29 passed (29)'),
      ...task(
        '@fivvi/ui:test',
        'FAILING-UI-OUTPUT',
        ' Tests  1 failed | 34 passed (35)',
        '[ELIFECYCLE] Test failed. See above for more details.',
      ),
      '@fivvi/ui#test:  ERROR  command (/x/ui) pnpm run test exited (1)',
      '',
      ' Tasks:    3 successful, 4 total',
      'Failed:    @fivvi/ui#test',
    ],
    exit: 1,
  };

  it('E002 #112 AC1: writes the summary of a failing run, and check.sh still fails', () => {
    const result = check({ unit: failingUnit, integration, e2e });
    assert.equal(result.status, 1);
    assert.deepEqual(
      result.summary.suites.filter((s) => s.status === 'fail'),
      [suite('ui', 'unit', 'fail', 34, 1, 0)],
    );
    assert.match(result.stdout, /ui\s+fail\s+34\s+1\s+0\n/);
  });

  it('E002 #112 AC1: shows the output of a failing task, and not of the tasks that passed', () => {
    const result = check({ unit: failingUnit, integration, e2e });
    assert.match(result.stdout, /✗ lint, types, unit tests/);
    assert.match(result.stdout, /FAILING-UI-OUTPUT/);
    assert.match(result.stdout, /ui#test:\s+ERROR/);
    assert.match(result.stdout, /Failed:\s+@fivvi\/ui#test/);
    assert.doesNotMatch(result.stdout, /PASSING-API-OUTPUT/);
    assert.doesNotMatch(result.stdout, /ℹ pass 260/);
    // The parser still read the passing suites from the log it did not print.
    assert.deepEqual(
      result.summary.suites.find((s) => s.name === 'api'),
      suite('api', 'unit', 'pass', 29, 0, 0),
    );
  });

  it('E002 #112 AC1: shows the output of a failing root test run', () => {
    const rootFails = {
      lines: [
        ...task('//:test:root', 'FAILING-ROOT-OUTPUT', 'ℹ pass 5', 'ℹ fail 1'),
        '//#test:root:  ERROR  command (/x) pnpm run test:root exited (1)',
        ' Tasks:    1 successful, 2 total',
      ],
      exit: 1,
    };
    const result = check({ unit: rootFails, integration, e2e });
    assert.match(result.stdout, /FAILING-ROOT-OUTPUT/);
    assert.match(result.stdout, /Tasks:\s+1 successful/);
  });

  it('E002 #112 AC1: lists the suites turbo did not run after a failure as not-run', () => {
    const rootFails = {
      lines: [
        ...task('//:test:root', 'ℹ pass 5', 'ℹ fail 1', 'ℹ skipped 0'),
        '//#test:root:  ERROR  command (/x) pnpm run test:root exited (1)',
      ],
      exit: 1,
    };
    const result = check({ unit: rootFails, integration, e2e });
    assert.deepEqual(
      result.summary.suites.map(({ name, status }) => [name, status]),
      [
        ['root', 'fail'],
        ['api', 'not-run'],
        ['ui', 'not-run'],
        ['api integration', 'pass'],
        ['web e2e', 'pass'],
      ],
    );
    assert.match(result.stdout, /api\s+not-run\s+-\s+-\s+-\n/);
  });

  it('E002 #112 AC1: lists the tasks turbo started and then cancelled after a failure as not-run', () => {
    const cancelledApi = task(
      '@fivvi/api:test',
      'cache miss, executing 5edc6df4868ce48f',
      '$ vitest run',
      ' RUN  v5.0.1 /x/api',
    );
    const uiFails = {
      lines: [
        ...cancelledApi,
        ...task('@fivvi/ui:test', ' Tests  1 failed | 34 passed (35)'),
        '@fivvi/ui#test:  ERROR  command (/x/ui) pnpm run test exited (1)',
      ],
      exit: 1,
    };
    const result = check({ unit: uiFails, integration, e2e });
    assert.deepEqual(
      result.summary.suites
        .filter((s) => s.kind === 'unit')
        .map(({ name, status }) => [name, status]),
      [
        ['root', 'not-run'],
        ['api', 'not-run'],
        ['ui', 'fail'],
      ],
    );
    assert.match(result.stdout, /api\s+not-run\s+-\s+-\s+-\n/);
    assert.doesNotMatch(result.stdout, /no-results/);
  });

  it('E002 #112 AC1: leaves no stale summary when check.sh stops early', () => {
    const stale = join(repo(), '.work/check-summary.json');
    const result = check({}, [], () => {
      mkdirSync(join(repo(), '.work'), { recursive: true });
      write(stale, '{"stale":true}\n');
      rmSync(join(repo(), 'node_modules'), { recursive: true });
    });
    mkdirSync(join(repo(), 'node_modules'));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /no node_modules/);
    assert.ok(!existsSync(stale), 'the summary of the earlier run is gone');
  });

  it('E002 #112 AC1: lists the integration and e2e suites as skipped with --fast', () => {
    const result = check({ unit: unit() }, ['--fast']);
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(
      result.summary.suites.map(({ name, status }) => [name, status]),
      [
        ['root', 'pass'],
        ['api', 'pass'],
        ['ui', 'pass'],
        ['integration', 'skipped'],
        ['e2e', 'skipped'],
      ],
    );
    assert.match(result.stdout, /e2e\s+skipped\s+-\s+-\s+-\n/);
  });

  describe('E002 #109 the pinned shellcheck (scripts/_shellcheck.sh)', () => {
    const PINNED = execFileSync(
      'bash',
      [
        '-c',
        `source "${SCRIPTS}/_lib.sh"; source "${SCRIPTS}/_shellcheck.sh"; echo "$SHELLCHECK_VERSION"`,
      ],
      { encoding: 'utf8' },
    ).trim();
    const log = () => join(base, 'shellcheck.log');

    // A shellcheck that reports `version`, records who it is when run on files, and passes.
    const fakeShellcheck = (path, version, who) =>
      write(
        path,
        `#!/bin/sh\ncase "$1" in --version) printf 'version: ${version}\\n' ;; *) echo ${who} >> "${log()}" ;; esac\n`,
        0o755,
      );
    const WARNING = /shellcheck 0\.9\.0 found, CI runs /;

    afterEach(() => {
      rmSync(join(repo(), '.tools'), { recursive: true, force: true });
      rmSync(log(), { force: true });
      write(join(bin(), 'shellcheck'), '#!/bin/sh\nexit 0\n', 0o755);
    });

    it('warns about a different local version, names the fix, and still passes', () => {
      const result = check({ unit: unit(), integration, e2e }, [], () =>
        fakeShellcheck(join(bin(), 'shellcheck'), '0.9.0', 'system'),
      );
      assert.equal(result.status, 0, result.stdout);
      assert.match(result.stdout, WARNING);
      assert.match(result.stdout, new RegExp(`CI runs ${PINNED.replaceAll('.', '\\.')}`));
      assert.match(result.stdout, /run: scripts\/bootstrap\.sh/);
      assert.match(result.stdout, /✓ shellcheck\n/);
    });

    it('is silent when the local version is the pinned one', () => {
      const result = check({ unit: unit(), integration, e2e }, [], () =>
        fakeShellcheck(join(bin(), 'shellcheck'), PINNED, 'system'),
      );
      assert.equal(result.status, 0, result.stdout);
      assert.doesNotMatch(result.stdout, /⚠️/);
    });

    it('runs the pinned binary from the tools directory in place of the one on PATH, without a warning', () => {
      const result = check({ unit: unit(), integration, e2e }, [], () => {
        fakeShellcheck(join(bin(), 'shellcheck'), '0.9.0', 'system');
        mkdirSync(join(repo(), '.tools', `shellcheck-${PINNED}`), { recursive: true });
        fakeShellcheck(
          join(repo(), '.tools', `shellcheck-${PINNED}`, 'shellcheck'),
          PINNED,
          'pinned',
        );
      });
      assert.equal(result.status, 0, result.stdout);
      assert.doesNotMatch(result.stdout, /⚠️/);
      assert.equal(readFileSync(log(), 'utf8').trim(), 'pinned');
    });
  });

  it('E002 #112 AC1: is git-ignored: the summary goes to .work/', () => {
    assert.match(readFileSync(join(SCRIPTS, '../.gitignore'), 'utf8'), /^\.work\/$/m);
  });

  it('E002 #112 AC2: tells builders to quote the summary, with a row as check.sh prints it', () => {
    const build = readFileSync(join(SCRIPTS, '../docs/agents/build.md'), 'utf8');
    assert.match(build, /Quote that summary/);
    assert.match(build, /\.work\/check-summary\.json/);
    const example = build.match(/`(root +pass +\d+ +\d+ +\d+)`/);
    assert.ok(example, 'build.md shows a row of the table');
    // The same row, to the column, as check.sh prints it (the counts differ).
    const digits = (text) => text.replace(/\d/g, '9');
    const printed = check({ unit: unit(), integration, e2e }).stdout.split('\n');
    assert.ok(printed.some((line) => digits(line) === digits(example[1])));
  });
});
