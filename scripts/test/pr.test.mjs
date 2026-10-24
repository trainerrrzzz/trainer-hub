import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fakeGh } from './fake-gh.mjs';

const SCRIPTS = join(import.meta.dirname, '..');
const HEAD = 'c'.repeat(40);
const CI = ['Detect changes', 'Checks (Linux)', 'E2E (Linux)', 'iOS', 'Android'];

const NO_PREVIEW = `**Railway preview smoke check:** on \`${HEAD}\`: no preview for this PR (it touches no Railway watch pattern).`;
// GitHub's combined status of a commit; Railway posts `fivvi - web` also when it skips the deploy.
const SKIPPED = 'No deployment needed - watched paths not modified';
const statuses = (...entries) => ({
  total_count: entries.length,
  statuses: entries.map(([context, state, description]) => ({ context, state, description })),
});
const WEB_SKIPPED = statuses(
  ['fivvi - cron', 'success', SKIPPED],
  ['fivvi - web', 'success', SKIPPED],
);
const WEB_DEPLOYED = statuses(['fivvi - web', 'success', 'Deployment succeeded']);
const STATUS = `^api repos/[^ ]+/commits/${HEAD}/status`;
const threads = (nodes, hasNextPage = false) => ({
  data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage }, nodes } } } },
});

const checkRun = (name, conclusion = 'SUCCESS', status = 'COMPLETED') => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
});

// The merge queue facts of a PR (scripts/pr.sh queue_state): the state of the PR, whether its base branch has a merge
// queue, whether it is in the queue, whether GitHub turned on auto-merge, and the last queue event on its timeline.
const BEFORE_REMOVAL = '2026-10-19T09:00:00Z';
const REMOVAL = '2026-10-19T10:00:00Z';
const AFTER_REMOVAL = '2026-10-19T11:00:00Z';
const removedAt = (createdAt) => ({
  __typename: 'RemovedFromMergeQueueEvent',
  reason: 'Merge group failed',
  createdAt,
});
const REMOVED = removedAt(REMOVAL);
const ADDED = { __typename: 'AddedToMergeQueueEvent' };
const PR_ID = 'PR_kwDOtrainer60';
const queueFacts = ({
  state = 'OPEN',
  queueEnabled = true,
  queued = false,
  position = 1,
  auto = false,
  events = [],
  body = '',
  head = HEAD,
  committed = BEFORE_REMOVAL,
} = {}) => ({
  data: {
    repository: {
      pullRequest: {
        id: PR_ID,
        state,
        isMergeQueueEnabled: queueEnabled,
        headRefOid: head,
        commits: { nodes: [{ commit: { committedDate: committed } }] },
        body,
        isInMergeQueue: queued,
        mergeQueueEntry: queued ? { state: 'QUEUED', position } : null,
        autoMergeRequest: auto ? { enabledAt: '2026-10-19T10:00:00Z' } : null,
        timelineItems: { nodes: events },
      },
    },
  },
});
const QUEUE = '^api graphql [\\s\\S]*isInMergeQueue';
const ENQUEUE = '^api graphql [\\s\\S]*enqueuePullRequest';

const github = ({
  files = ['apps/web/page.tsx'],
  body,
  queue = queueFacts({ queued: true }),
  status = statuses(),
  rollup = CI.map((name) => checkRun(name)),
} = {}) => [
  { match: '^pr list ', out: [{ number: 60 }] },
  { match: '^api repos/[^ ]+/pulls/60/files', out: files.map((filename) => ({ filename })) },
  {
    match: '^pr view 60 .*--json headRefName,closingIssuesReferences',
    out: {
      headRefName: 'feature/57-hold-a-spot',
      closingIssuesReferences: [{ number: 57 }],
      changedFiles: files.length,
    },
  },
  {
    match: '^pr view 60 ',
    out: {
      number: 60,
      state: 'OPEN',
      isDraft: false,
      baseRefName: 'main',
      headRefName: 'feature/57-hold-a-spot',
      headRefOid: HEAD,
      body:
        body ??
        `Closes #57\n\n**Self-review:** standards and spec reviewers clean on \`${HEAD}\` ✅\n\n${NO_PREVIEW}`,
      statusCheckRollup: rollup,
    },
  },
  { match: '^issue view 57 ', out: { number: 57, labels: [], parent: null } },
  { match: QUEUE, out: queue },
  { match: ENQUEUE, out: { data: { enqueuePullRequest: { mergeQueueEntry: { position: 1 } } } } },
  { match: '^api graphql ', out: threads([]) },
  { match: STATUS, out: status },
  { match: '^pr edit 60 ', out: '' },
  { match: '^pr merge 60 ', out: '' },
  { match: '^pr ready 60 ', out: '' },
  { match: '^api --method DELETE ', out: '' },
];

describe('pr.sh merge', () => {
  const gh = fakeGh();
  after(() => gh.cleanup());

  const merge = (rules) => {
    const result = spawnSync(join(SCRIPTS, 'pr.sh'), ['merge'], {
      encoding: 'utf8',
      env: gh.env(rules),
    });
    const bodies = gh
      .calls()
      .filter((call) => call.args[1] === 'edit')
      .map((call) => call.args[call.args.indexOf('--body') + 1]);
    return { ...result, bodies, calls: gh.calls().map((call) => call.args.join(' ')) };
  };

  it('E002 #119: adds the PR to the merge queue, once every condition holds, and says so', () => {
    const result = merge(github());
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /✓ not owner-only/);
    assert.ok(
      result.calls.some(
        (call) =>
          new RegExp(ENQUEUE).test(call) &&
          call.includes(`id=${PR_ID}`) &&
          call.includes(`head=${HEAD}`),
      ),
      result.calls.join('\n'),
    );
    // gh pr merge asks for auto-merge on a merge queue branch, whatever the flags, which the repo forbids.
    assert.ok(!result.calls.some((call) => /^pr merge/.test(call)), result.calls.join('\n'));
    assert.match(result.stdout, /✅ PR #60 added to the merge queue \(position 1\)/);
    assert.match(result.stdout, /scripts\/flow\.sh finish 57/);
  });

  it('E002 #119: leaves the branch to flow.sh finish: deleting the head branch of a queued PR would close it', () => {
    const result = merge(github());
    assert.ok(!result.calls.some((call) => /--method DELETE/.test(call)), result.calls.join('\n'));
  });

  it('E002 #119: records the commit it queued in the PR body, which flow.sh reads to tell a removal from a stale one', () => {
    const result = merge(github());
    assert.deepEqual(result.bodies, [
      `Closes #57\n\n**Self-review:** standards and spec reviewers clean on \`${HEAD}\` ✅\n\n${NO_PREVIEW}\n\n**Merge queue:** added to the merge queue on \`${HEAD}\``,
    ]);
  });

  it('E002 #119: never uses auto-merge or the admin bypass', () => {
    for (const rules of [
      github(),
      github({ queue: queueFacts({ state: 'MERGED', queueEnabled: false }) }),
      github({ files: ['packages/database/migrations/0004.sql'] }),
    ]) {
      const result = merge(rules);
      assert.ok(!result.calls.some((call) => /--auto|--admin/.test(call)), result.calls.join('\n'));
    }
  });

  it('E002 #119: does not ask whether the branch is behind main: the queue tests it on the latest main', () => {
    const result = merge(github());
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.calls.some((call) => /compare/.test(call)), result.calls.join('\n'));
  });

  it('E002 #119, ADR-021: refuses an owner-only PR and queues nothing: the owner adds it to the queue', () => {
    const result = merge(github({ files: ['docs/legal/verwerkersovereenkomst.md'] }));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /✗ not owner-only: owner-only: docs\/legal\//);
    assert.ok(!result.calls.some((call) => /^pr merge/.test(call)), result.calls.join('\n'));
    assert.ok(
      !result.calls.some((call) => new RegExp(ENQUEUE).test(call)),
      result.calls.join('\n'),
    );
    assert.ok(result.bodies.every((body) => !body.includes('High-risk agent merge')));
  });

  it('ADR-021: refuses a PR whose ticket is labelled owner-only, also on safe paths', () => {
    const result = merge([
      {
        match: '^issue view 57 ',
        out: { number: 57, labels: [{ name: 'owner-only' }], parent: null },
      },
      ...github(),
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /✗ not owner-only: owner-only: #57 is labelled owner-only/);
    assert.ok(
      !result.calls.some((call) => new RegExp(ENQUEUE).test(call)),
      result.calls.join('\n'),
    );
  });

  describe('ADR-021: a high-risk PR', () => {
    const MIGRATION = 'packages/database/migrations/0004.sql';
    const REASON = `${MIGRATION}: tenant-data (/packages/database)`;
    const BODY = `Closes #57\n\n**Self-review:** standards and spec reviewers clean on \`${HEAD}\` ✅\n\n${NO_PREVIEW}`;

    it('is queued by the agent, and recorded in the PR body with its head commit and reasons before it is queued', () => {
      const result = merge(github({ files: [MIGRATION] }));
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.stdout,
        /✓ not owner-only: high-risk, agent-queueable: packages\/database/,
      );
      const record = `**High-risk agent merge:** \`${HEAD}\`: ${REASON}`;
      assert.deepEqual(result.bodies, [
        `${BODY}\n\n${record}`,
        // The fake PR keeps its first body, so each edit shows only its own record added to it.
        `${BODY}\n\n**Merge queue:** added to the merge queue on \`${HEAD}\``,
      ]);
      const recorded = result.calls.findIndex((call) => /^pr edit/.test(call));
      const queued = result.calls.findIndex((call) => new RegExp(ENQUEUE).test(call));
      assert.ok(recorded >= 0 && queued > recorded, result.calls.join('\n'));
    });

    it('lists every reason in the record, separated by semicolons', () => {
      const result = merge(github({ files: ['apps/web/package.json', MIGRATION] }));
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.bodies[0],
        new RegExp(
          `\\*\\*High-risk agent merge:\\*\\* \`${HEAD}\`: apps/web/package\\.json: dependencies \\(package\\.json\\); ${MIGRATION.replace(/\./g, '\\.')}: tenant-data \\(/packages/database\\)$`,
        ),
      );
    });

    it('is recorded also for the owner-merge label', () => {
      const result = merge([
        {
          match: '^issue view 57 ',
          out: { number: 57, labels: [{ name: 'owner-merge' }], parent: null },
        },
        ...github(),
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.bodies[0],
        /\*\*High-risk agent merge:\*\* `c{40}`: #57 is labelled owner-merge$/,
      );
    });

    it('is not queued when the record cannot be written', () => {
      const result = merge([
        { match: '^pr edit 60 ', out: 'nope', status: 1 },
        ...github({ files: [MIGRATION] }),
      ]);
      assert.equal(result.status, 1);
      assert.ok(
        !result.calls.some((call) => new RegExp(ENQUEUE).test(call)),
        result.calls.join('\n'),
      );
      assert.ok(!result.calls.some((call) => /^pr merge/.test(call)), result.calls.join('\n'));
    });

    it('still queues nothing, and records no merge, when another condition fails', () => {
      const result = merge(github({ files: [MIGRATION], body: '' }));
      assert.equal(result.status, 1);
      assert.match(result.stdout, /✗ self-review clean/);
      assert.ok(result.bodies.every((body) => !body.includes('High-risk agent merge')));
      assert.ok(
        !result.calls.some((call) => new RegExp(ENQUEUE).test(call)),
        result.calls.join('\n'),
      );
    });

    it('is recorded and squash-merged on a branch without a merge queue', () => {
      const result = merge(
        github({ files: [MIGRATION], queue: queueFacts({ state: 'MERGED', queueEnabled: false }) }),
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.bodies.length, 1);
      assert.match(result.bodies[0], /\*\*High-risk agent merge:\*\*/);
    });

    it('a low-risk PR gets no such record', () => {
      const result = merge(github());
      assert.ok(result.bodies.every((body) => !body.includes('High-risk agent merge')));
    });
  });

  it('E002 #119: squash-merges at once when the branch has no merge queue (not applied yet), and deletes the branch', () => {
    const result = merge(github({ queue: queueFacts({ state: 'MERGED', queueEnabled: false }) }));
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.calls.some((call) =>
        new RegExp(`^pr merge 60 --repo [^ ]+ --squash --match-head-commit ${HEAD}$`).test(call),
      ),
      result.calls.join('\n'),
    );
    assert.ok(
      !result.calls.some((call) => new RegExp(ENQUEUE).test(call)),
      result.calls.join('\n'),
    );
    assert.match(result.stdout, /✅ PR #60 squash-merged/);
    assert.ok(
      result.calls.some((call) =>
        /^api --method DELETE repos\/[^ ]+\/git\/refs\/heads\/feature\/57-hold-a-spot$/.test(call),
      ),
    );
    assert.deepEqual(result.bodies, []);
  });

  it('E002 #119: turns auto-merge off again when it is on and the PR is not queued, and fails', () => {
    const result = merge(github({ queue: queueFacts({ auto: true }) }));
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /auto-merge is on for PR #60, which is not in the merge queue; turned it off/,
    );
    assert.ok(
      result.calls.some((call) => /^pr merge 60 --repo [^ ]+ --disable-auto$/.test(call)),
      result.calls.join('\n'),
    );
    assert.deepEqual(result.bodies, []);
  });

  it('E002 #119: says auto-merge is still on when it could not turn it off, never that it is off', () => {
    const result = merge([
      { match: '^pr merge 60 .*--disable-auto', out: 'nope', status: 1 },
      ...github({ queue: queueFacts({ auto: true }) }),
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /auto-merge is still on: turn it off on GitHub/);
    assert.doesNotMatch(result.stderr, /turned it off/);
    assert.deepEqual(result.bodies, []);
  });

  it('E002 #119: refuses a head commit the merge queue already removed, and queues nothing', () => {
    const result = merge(github({ queue: queueFacts({ events: [ADDED, REMOVED] }) }));
    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /✗ not removed from the queue: GitHub removed .* from the merge queue/,
    );
    assert.match(result.stderr, /not removed from the queue; nothing queued/);
    assert.ok(!result.calls.some((call) => /^pr merge/.test(call)), result.calls.join('\n'));
  });

  it('E002 #119: queues a commit pushed after a removal', () => {
    const result = merge(
      github({ queue: queueFacts({ queued: true, events: [REMOVED], committed: AFTER_REMOVAL }) }),
    );
    assert.equal(result.status, 0, result.stderr);
  });

  it('E002 #119: fails when the PR is neither queued nor merged after GitHub took it', () => {
    const result = merge(github({ queue: queueFacts() }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /neither in the merge queue nor merged/);
    assert.deepEqual(result.bodies, []);
  });

  it("E002: fails and records nothing when GitHub can't add the PR to the queue", () => {
    const result = merge([{ match: ENQUEUE, out: 'not allowed', status: 1 }, ...github()]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not add PR #60 to the merge queue: not allowed/);
    assert.deepEqual(result.bodies, []);
  });

  it("E002: fails and records nothing when gh can't squash-merge a PR on a branch without a merge queue", () => {
    const result = merge([
      { match: '^pr merge 60 ', out: 'not allowed', status: 1 },
      ...github({ queue: queueFacts({ queueEnabled: false }) }),
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /merge failed: not allowed/);
    assert.deepEqual(result.bodies, []);
  });

  it('queues nothing and says why when a condition fails', () => {
    const result = merge(github({ files: ['scripts/pr.sh'], body: '' }));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /✗ not owner-only: owner-only: scripts\/pr\.sh: guardrails/);
    assert.match(result.stdout, /✗ self-review clean: no self-review record/);
    assert.match(result.stderr, /PR #60 stays for the owner: not owner-only, self-review clean/);
    assert.ok(!result.calls.some((call) => /^pr merge|--method DELETE/.test(call)));
  });

  it('records the refusal and its reasons for the head commit, so the owner decides', () => {
    const result = merge(github({ body: `Closes #57\n\n${NO_PREVIEW}` }));
    assert.equal(result.status, 1);
    assert.deepEqual(result.bodies, [
      `Closes #57\n\n${NO_PREVIEW}\n\n**Merge gate:** refused on \`${HEAD}\`: self-review clean (no self-review record in the PR body)`,
    ]);
  });

  const refuses = (rules, reason) => {
    const result = merge(rules);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, reason);
    assert.match(result.stderr, /nothing queued/);
    assert.ok(!result.calls.some((call) => /^pr merge|--method DELETE|^pr edit/.test(call)));
  };

  it("queues nothing when the PR's risk can't be read", () => {
    for (const match of ['^api repos/[^ ]+/pulls/60/files', '^issue view 57 ']) {
      refuses([{ match, out: '', status: 1 }, ...github()], /could not decide the risk of PR #60/);
    }
  });

  it("queues nothing when the review threads can't all be read", () => {
    refuses(
      [{ match: '^api graphql ', out: '', status: 1 }, ...github()],
      /could not read the review threads/,
    );
    refuses(
      [{ match: '^api graphql ', out: threads([], true) }, ...github()],
      /more than 100 review threads/,
    );
  });

  it('queues nothing when GitHub lists fewer files than the PR changes', () => {
    const rules = github();
    rules[2].out.changedFiles = 3001;
    refuses(rules, /could not decide the risk of PR #60/);
  });

  it('queues a PR without a preview when Railway skipped the deploy', () => {
    const result = merge(github({ status: WEB_SKIPPED }));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /✓ preview smoke-checked: no preview/);
  });

  it('refuses a "no preview" record when Railway deployed a preview', () => {
    const result = merge(github({ status: WEB_DEPLOYED }));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /✗ preview smoke-checked: the PR has a preview/);
    assert.ok(!result.calls.some((call) => /^pr merge|--method DELETE/.test(call)));
  });

  it("queues nothing when it can't read the head commit's statuses", () => {
    refuses([{ match: STATUS, out: '', status: 1 }, ...github()], /could not read the statuses/);
    refuses(
      [{ match: STATUS, out: { total_count: 31, statuses: [] } }, ...github()],
      /could not read the statuses/,
    );
  });
});

describe('pr.sh reviewed', () => {
  const gh = fakeGh();
  let repo;
  const git = (...args) =>
    execFileSync(
      'git',
      ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
      {
        encoding: 'utf8',
      },
    ).trim();

  before(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pr-reviewed-')));
    execFileSync('git', ['init', '--quiet', '--initial-branch=feature/57-hold-a-spot', repo]);
    cpSync(SCRIPTS, join(repo, 'scripts'), { recursive: true });
    git('add', '.');
    git('commit', '--quiet', '-m', 'feat(F031): hold a spot');
    git('remote', 'add', 'origin', 'https://github.com/example/fivvi.git');
  });
  after(() => {
    gh.cleanup();
    rmSync(repo, { recursive: true, force: true });
  });

  const OLD_RECORD = `**Self-review:** standards and spec reviewers clean on \`${'b'.repeat(40)}\` ✅`;
  const reviewed = (prHead, body = { out: { body: `Closes #57\n\n${OLD_RECORD}` } }) => {
    const result = spawnSync(join(repo, 'scripts/pr.sh'), ['reviewed'], {
      cwd: repo,
      encoding: 'utf8',
      env: gh.env([
        { match: '^pr list ', out: [{ number: 60 }] },
        { match: '^pr view 60 .*--json headRefOid', out: { headRefOid: prHead } },
        { match: '^pr view 60 .*--json body', ...body },
        { match: '^pr edit 60 ', out: '' },
      ]),
    });
    const edits = gh.calls().filter((call) => call.args[1] === 'edit');
    const bodies = edits.map((call) => call.args[call.args.indexOf('--body') + 1]);
    return { ...result, edits, bodies };
  };

  it('replaces the record with one for the head commit', () => {
    const head = git('rev-parse', 'HEAD');
    const result = reviewed(head);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.bodies, [
      `Closes #57\n\n**Self-review:** standards and spec reviewers clean on \`${head}\` ✅`,
    ]);
  });

  it('writes only the record when the body held nothing else', () => {
    const head = git('rev-parse', 'HEAD');
    const result = reviewed(head, { out: { body: OLD_RECORD } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.bodies, [
      `**Self-review:** standards and spec reviewers clean on \`${head}\` ✅`,
    ]);
  });

  it("leaves the body alone when it can't read it", () => {
    const result = reviewed(git('rev-parse', 'HEAD'), { out: '', status: 1 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not read the body of PR #60/);
    assert.deepEqual(result.edits, []);
  });

  it('refuses when the local commit is not the PR head', () => {
    const result = reviewed('d'.repeat(40));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not the PR head ddddddd/);
    assert.deepEqual(result.edits, []);
  });
});

const PROJECT = '5ac2d844-191a-4671-9632-50b66817f648';
const deployment = (status, commitHash = HEAD) => ({
  id: `d-${status}`,
  status,
  meta: { commitHash },
});
const OTHER = 'b'.repeat(40);
// What the fake `railway` lists before and after a redeploy, newest deployment first.
const RAILWAY = {
  deployed: { before: [deployment('SUCCESS')] },
  skipped: {
    before: [deployment('SKIPPED'), deployment('SUCCESS', OTHER)],
    after: [deployment('SUCCESS'), deployment('SKIPPED'), deployment('SUCCESS', OTHER)],
  },
  'no deployment': {
    before: [deployment('SUCCESS', OTHER)],
    after: [deployment('SUCCESS'), deployment('SUCCESS', OTHER)],
  },
  'redeploy fails': {
    before: [deployment('SKIPPED')],
    after: [deployment('FAILED'), deployment('SKIPPED')],
  },
};

// A stand-in for the railway CLI: logs its arguments, lists `before` until a redeploy ran and `after` since.
function fakeRailway() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-railway-'));
  writeFileSync(
    join(dir, 'railway'),
    `#!/bin/sh
echo "$*" >> "$FAKE_RAILWAY_LOG"
case "$1 $2" in
  "whoami ") [ "$FAKE_RAILWAY_LOGGED_IN" = 0 ] && { echo "Unauthorized" >&2; exit 1; }; echo "Logged in as Test" ;;
  "deployment list") if [ -f "$FAKE_RAILWAY_LOG.redeployed" ]; then echo "$FAKE_RAILWAY_AFTER"; else echo "$FAKE_RAILWAY_BEFORE"; fi ;;
  "deployment redeploy") touch "$FAKE_RAILWAY_LOG.redeployed" ;;
  *) echo "fake railway: unexpected: $*" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(join(dir, 'railway'), 0o755);
  // A PATH without any railway, for a machine that hasn't the CLI: only the tools pr.sh needs, linked.
  const tools = join(dir, 'tools');
  mkdirSync(tools);
  for (const tool of ['jq', 'node', 'git']) {
    symlinkSync(execFileSync('which', [tool], { encoding: 'utf8' }).trim(), join(tools, tool));
  }
  const log = join(dir, 'railway.log');
  return {
    // The environment for one run: `mode` is a RAILWAY key, 'missing' (no CLI) or 'logged out'.
    env: (base, mode) => {
      const [first] = base.PATH.split(':');
      const state = RAILWAY[mode] ?? RAILWAY.deployed;
      writeFileSync(log, '');
      rmSync(`${log}.redeployed`, { force: true });
      return {
        ...base,
        PATH: mode === 'missing' ? `${first}:${tools}:/usr/bin:/bin` : `${dir}:${base.PATH}`,
        FAKE_RAILWAY_LOG: log,
        FAKE_RAILWAY_LOGGED_IN: mode === 'logged out' ? '0' : '1',
        FAKE_RAILWAY_BEFORE: JSON.stringify(state.before),
        FAKE_RAILWAY_AFTER: JSON.stringify(state.after ?? state.before),
      };
    },
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('pr.sh smoke', () => {
  const gh = fakeGh();
  // A stand-in for curl: logs the URL and answers like a healthy preview.
  const bin = mkdtempSync(join(tmpdir(), 'fake-curl-'));
  writeFileSync(
    join(bin, 'curl'),
    '#!/bin/sh\necho "$*" >> "$FAKE_CURL_LOG"\necho \'{"status":"ok"}\'\n',
  );
  chmodSync(join(bin, 'curl'), 0o755);
  const curlLog = join(bin, 'curl.log');
  const railway = fakeRailway();
  after(() => {
    gh.cleanup();
    railway.cleanup();
    rmSync(bin, { recursive: true, force: true });
  });

  // `mode`: what the fake railway reports for the PR's environment, see RAILWAY; or 'missing' / 'logged out'.
  const smoke = (status, args = [], mode = 'deployed') => {
    writeFileSync(curlLog, '');
    const env = railway.env(
      gh.env([
        { match: '^pr list ', out: [{ number: 60 }] },
        { match: '^pr view 60 .*--json headRefOid', out: { headRefOid: HEAD } },
        { match: STATUS, ...status },
        { match: '^pr view 60 .*--json body', out: { body: 'Closes #57' } },
        { match: '^pr edit 60 ', out: '' },
      ]),
      mode,
    );
    const result = spawnSync(join(SCRIPTS, 'pr.sh'), ['smoke', ...args], {
      encoding: 'utf8',
      env: { ...env, PATH: `${bin}:${env.PATH}`, FAKE_CURL_LOG: curlLog },
    });
    const bodies = gh
      .calls()
      .filter((call) => call.args[1] === 'edit')
      .map((call) => call.args[call.args.indexOf('--body') + 1]);
    return {
      ...result,
      bodies,
      curls: readFileSync(curlLog, 'utf8').split('\n').filter(Boolean),
      railway: railway.calls(),
    };
  };

  it('records that the PR has no preview when Railway posted no preview status', () => {
    const result = smoke({ out: statuses() });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.bodies, [`Closes #57\n\n${NO_PREVIEW}`]);
    assert.deepEqual(result.curls, []);
  });

  it('records that the PR has no preview right away when Railway skipped the deploy', () => {
    const result = smoke({ out: WEB_SKIPPED });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.bodies, [`Closes #57\n\n${NO_PREVIEW}`]);
    assert.deepEqual(result.curls, []);
  });

  it("checks the preview's health when Railway deployed one", () => {
    const result = smoke({ out: WEB_DEPLOYED });
    assert.equal(result.status, 0, result.stderr);
    const url = 'https://web-fivvi-pr-60.up.railway.app/api/v1/health';
    assert.ok(result.curls.length > 0 && result.curls.every((args) => args.endsWith(url)));
    assert.deepEqual(result.bodies, [
      `Closes #57\n\n**Railway preview smoke check:** on \`${HEAD}\`: \`curl -fsS ${url}\` → \`{"status":"ok"}\` ✅`,
    ]);
  });

  it('records nothing while the preview is still deploying', () => {
    const deploying = statuses(['fivvi - web', 'pending', 'Deployment in progress']);
    const result = smoke({ out: deploying }, ['--timeout', '0']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /still deploying/);
    assert.deepEqual(result.bodies, []);
    assert.deepEqual(result.curls, []);
  });

  it("records nothing when it can't read the head commit's statuses", () => {
    for (const status of [{ out: '', status: 1 }, { out: { total_count: 31, statuses: [] } }]) {
      const result = smoke(status);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /could not read the statuses of [0-9a-f]{7}/);
      assert.deepEqual(result.bodies, []);
      assert.deepEqual(result.curls, []);
    }
  });

  const WEB_URL = 'https://web-fivvi-pr-60.up.railway.app/api/v1/health';
  const REDEPLOY = `deployment redeploy -p ${PROJECT} -e fivvi-pr-60 -s web --from-source -y`;
  const LIST = `deployment list -p ${PROJECT} -e fivvi-pr-60 -s web --json`;

  it('E002 #107 AC3: asks railway nothing when there is no preview', () => {
    const result = smoke({ out: WEB_SKIPPED });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.railway, []);
  });

  it('E002 #107 AC3: redeploys nothing when the head commit has a deployment', () => {
    const result = smoke({ out: WEB_DEPLOYED });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.railway.includes(LIST), result.railway.join('\n'));
    assert.ok(!result.railway.some((call) => call.includes('redeploy')));
  });

  for (const mode of ['skipped', 'no deployment']) {
    it(`E002 #107 AC3: redeploys the PR preview from source when its deployment for the head commit is ${mode === 'skipped' ? 'skipped' : 'missing'}, then smoke-checks it`, () => {
      const result = smoke({ out: WEB_DEPLOYED }, [], mode);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        result.railway.filter((call) => call.startsWith('deployment redeploy')).length,
        1,
      );
      assert.ok(result.railway.includes(REDEPLOY), result.railway.join('\n'));
      assert.ok(result.curls.length > 0 && result.curls.every((args) => args.endsWith(WEB_URL)));
      assert.deepEqual(result.bodies, [
        `Closes #57\n\n**Railway preview smoke check:** on \`${HEAD}\`: \`curl -fsS ${WEB_URL}\` → \`{"status":"ok"}\` ✅`,
      ]);
    });
  }

  it('E002 #107 AC3: redeploys a preview whose deploy never started while Railway still reports it pending', () => {
    const pending = statuses(['fivvi - web', 'pending', 'Waiting for CI']);
    const result = smoke({ out: pending }, [], 'skipped');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.railway.includes(REDEPLOY), result.railway.join('\n'));
  });

  it('E002 #107 AC3: touches only the PR environment of the PR: never production or development', () => {
    for (const mode of ['deployed', 'skipped', 'no deployment']) {
      const result = smoke({ out: WEB_DEPLOYED }, [], mode);
      const deployments = result.railway.filter((call) => call.startsWith('deployment'));
      assert.ok(deployments.length > 0);
      for (const call of deployments) {
        assert.match(call, new RegExp(`-p ${PROJECT} -e fivvi-pr-60 -s web( |$)`), call);
        assert.doesNotMatch(call, /production|development/);
      }
    }
  });

  const FAILED_DEPLOY = statuses(['fivvi - web', 'failure', 'Deployment failed']);

  for (const mode of ['missing', 'logged out']) {
    it(`E002 #107 AC3: smoke-checks a deployed preview with curl when the railway CLI is ${mode === 'missing' ? 'missing' : 'logged out'}`, () => {
      const result = smoke({ out: WEB_DEPLOYED }, [], mode);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.curls.length > 0 && result.curls.every((args) => args.endsWith(WEB_URL)));
      assert.equal(result.bodies.length, 1);
      assert.ok(!result.railway.some((call) => call.startsWith('deployment')));
    });

    it(`E002 #107 AC3: fails at once with a hint when the preview did not deploy and the railway CLI is ${mode === 'missing' ? 'missing' : 'logged out'}`, () => {
      const result = smoke({ out: FAILED_DEPLOY }, ['--timeout', '15'], mode);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Railway CLI/);
      assert.match(result.stderr, /railway login/);
      assert.match(result.stderr, /fivvi-pr-60/);
      assert.ok(!result.railway.some((call) => call.startsWith('deployment')));
      assert.deepEqual(result.bodies, []);
      assert.deepEqual(result.curls, []);
    });

    it(`E002 #107 AC3: says in the timeout message that a pending preview may be skipped when the railway CLI is ${mode === 'missing' ? 'missing' : 'logged out'}`, () => {
      const pending = statuses(['fivvi - web', 'pending', 'Waiting for CI']);
      const result = smoke({ out: pending }, ['--timeout', '0'], mode);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /still deploying/);
      assert.match(result.stderr, /Railway CLI/);
      assert.deepEqual(result.bodies, []);
    });
  }

  it('E002 #107 AC3: records nothing when the redeployed preview fails to deploy', () => {
    const result = smoke({ out: WEB_DEPLOYED }, [], 'redeploy fails');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAILED/);
    assert.deepEqual(result.bodies, []);
    assert.deepEqual(result.curls, []);
  });
});

describe('pr.sh refusal', () => {
  const gh = fakeGh();
  after(() => gh.cleanup());

  const refusal = (rule) =>
    spawnSync(join(SCRIPTS, 'pr.sh'), ['refusal', '60'], {
      encoding: 'utf8',
      env: gh.env([{ match: '^pr view 60 .*--json body', ...rule }]),
    });

  it('prints the last refusal of the merge gate with its commit and reasons', () => {
    const old = `**Merge gate:** refused on \`${'b'.repeat(40)}\`: up to date (2 commits behind main)`;
    const last = `**Merge gate:** refused on \`${HEAD}\`: self-review clean (no self-review record in the PR body)`;
    const result = refusal({ out: { body: `Closes #57\r\n\r\n${old}\n\n${last}` } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      sha: HEAD,
      reasons: 'self-review clean (no self-review record in the PR body)',
    });
  });

  it('reads a Merge gate line without "refused on" by its commit and reasons', () => {
    const result = refusal({
      out: { body: `**Merge gate:** \`${HEAD}\`: up to date (2 commits behind main)` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      sha: HEAD,
      reasons: 'up to date (2 commits behind main)',
    });
  });

  it('prints the whole Merge gate line with a null commit when the line names no commit', () => {
    const line =
      '**Merge gate:** refused: self-review clean (no self-review record in the PR body)';
    const result = refusal({ out: { body: `Closes #57\n\n${line}` } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { sha: null, reasons: line });
  });

  it('prints null without a refusal, and fails when it cannot read the PR', () => {
    assert.equal(refusal({ out: { body: 'Closes #57' } }).stdout, 'null\n');
    const failed = refusal({ out: '', status: 1 });
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    assert.match(failed.stderr, /could not read the body of PR #60/);
  });
});

describe('E002 #119 pr.sh queue', () => {
  const gh = fakeGh();
  after(() => gh.cleanup());

  const OLD = 'b'.repeat(40);
  const queued = (sha) => `**Merge queue:** added to the merge queue on \`${sha}\``;
  const queue = (facts) => {
    const result = spawnSync(join(SCRIPTS, 'pr.sh'), ['queue', '60'], {
      encoding: 'utf8',
      env: gh.env([{ match: QUEUE, out: facts }]),
    });
    return { ...result, json: result.status === 0 ? JSON.parse(result.stdout) : null };
  };

  it('says the PR is queued, with its position', () => {
    const result = queue(queueFacts({ queued: true, position: 2, events: [ADDED] }));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.json, { state: 'queued', position: 2, reason: null });
  });

  it('says the PR was removed from the queue, and why, while it is still on the commit that was queued', () => {
    const result = queue(queueFacts({ events: [ADDED, REMOVED], body: queued(HEAD) }));
    assert.deepEqual(result.json, {
      state: 'removed',
      position: null,
      reason: 'Merge group failed',
    });
  });

  it('says it was removed also when the owner queued it, so no record names the commit', () => {
    assert.equal(queue(queueFacts({ events: [ADDED, REMOVED] })).json.state, 'removed');
  });

  it('forgets a removal once the branch has a new head commit: the push makes it stale', () => {
    const result = queue(
      queueFacts({ events: [REMOVED], body: queued(OLD), committed: AFTER_REMOVAL }),
    );
    assert.deepEqual(result.json, { state: null, position: null, reason: null });
  });

  it('E002 #119: compares times as instants, not as text: a commit date with an offset', () => {
    // 11:30+02:00 is 09:30Z, before the removal at 10:00Z: removed. As text it would sort after the removal.
    const before = queue(queueFacts({ events: [REMOVED], committed: '2026-10-19T11:30:00+02:00' }));
    assert.equal(before.json.state, 'removed');
    // 12:30+02:00 is 10:30Z, after the removal: stale. Fractional seconds are accepted too.
    const after = queue(
      queueFacts({ events: [REMOVED], committed: '2026-10-19T12:30:00.250+02:00' }),
    );
    assert.equal(after.json.state, null);
  });

  it('E002 #119: shows the removal of a later commit the owner queued, although the record still names the first', () => {
    // A was queued by the agent and removed; B was pushed (stale), and the owner queued B, who removed it again.
    const second = removedAt('2026-10-19T12:00:00Z');
    const result = queue(
      queueFacts({
        events: [ADDED, REMOVED, ADDED, second],
        body: queued(OLD),
        committed: AFTER_REMOVAL,
      }),
    );
    assert.deepEqual(result.json, {
      state: 'removed',
      position: null,
      reason: 'Merge group failed',
    });
  });

  it('says nothing for a PR that was never queued, one that is queued again, or one that is merged', () => {
    assert.equal(queue(queueFacts()).json.state, null);
    assert.equal(
      queue(queueFacts({ queued: true, events: [REMOVED, ADDED] })).json.state,
      'queued',
    );
    assert.equal(queue(queueFacts({ state: 'MERGED', events: [ADDED] })).json.state, null);
  });

  it('shows the queue state in pr.sh status', () => {
    const status = (facts) =>
      spawnSync(join(SCRIPTS, 'pr.sh'), ['status'], {
        encoding: 'utf8',
        env: gh.env([
          { match: '^pr list ', out: [{ number: 60 }] },
          {
            match: '^pr view 60 ',
            out: {
              number: 60,
              title: 'Hold a spot',
              state: 'OPEN',
              isDraft: false,
              reviewDecision: '',
              mergeStateStatus: 'CLEAN',
              url: 'https://github.com/o/r/pull/60',
              statusCheckRollup: [],
            },
          },
          { match: QUEUE, out: facts },
          { match: '^api graphql ', out: threads([]) },
        ]),
      });
    assert.match(
      status(queueFacts({ queued: true, position: 3 })).stdout,
      /^Merge queue: queued \(position 3\)$/m,
    );
    assert.match(
      status(queueFacts({ events: [REMOVED] })).stdout,
      /^Merge queue: removed \(Merge group failed\)/m,
    );
    assert.match(status(queueFacts()).stdout, /^Merge queue: not queued$/m);
  });

  it("fails when it can't read the PR, and takes only a PR number", () => {
    const failed = spawnSync(join(SCRIPTS, 'pr.sh'), ['queue', '60'], {
      encoding: 'utf8',
      env: gh.env([{ match: QUEUE, out: '', status: 1 }]),
    });
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    assert.match(failed.stderr, /could not read the merge queue state of PR #60/);
    const bad = spawnSync(join(SCRIPTS, 'pr.sh'), ['queue', 'x'], {
      encoding: 'utf8',
      env: gh.env([]),
    });
    assert.notEqual(bad.status, 0);
  });
});

describe('pr.sh create: which local check runs before the push', () => {
  const gh = fakeGh();
  let base;
  let remote;
  let repo;
  let log;
  const git = (...args) =>
    execFileSync(
      'git',
      ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
      { encoding: 'utf8' },
    ).trim();

  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'pr-create-')));
    repo = join(base, 'repo');
    log = join(base, 'check.log');
    remote = join(base, 'remote.git');
    execFileSync('git', ['init', '--quiet', '--bare', remote]);
    execFileSync('git', ['init', '--quiet', '--initial-branch=feature/57-hold-a-spot', repo]);
    cpSync(SCRIPTS, join(repo, 'scripts'), { recursive: true });
    writeFileSync(
      join(repo, 'scripts/check.sh'),
      `#!/usr/bin/env bash\necho "check.sh $*" >> "${log}"\nexit "\${FAKE_CHECK_EXIT:-0}"\n`,
    );
    chmodSync(join(repo, 'scripts/check.sh'), 0o755);
    git('add', '.');
    git('commit', '--quiet', '-m', 'feat(F031): hold a spot');
    git('remote', 'add', 'origin', 'https://github.com/example/fivvi.git');
    git('config', `url.${remote}.pushInsteadOf`, 'https://github.com/example/fivvi.git');
  });
  after(() => {
    gh.cleanup();
    rmSync(base, { recursive: true, force: true });
  });

  const create = (existing, args = [], env = {}) => {
    writeFileSync(log, '');
    const result = spawnSync(join(repo, 'scripts/pr.sh'), ['create', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...gh.env([
          { match: '^pr list ', out: existing ? [{ number: 60 }] : [] },
          { match: '^issue view 57 ', out: { title: 'Hold a spot' } },
          { match: '^pr create ', out: 'https://github.com/example/fivvi/pull/60' },
          { match: '^pr edit ', out: '' },
          { match: '^pr view 60 ', out: { url: 'https://github.com/example/fivvi/pull/60' } },
        ]),
        ...env,
      },
    });
    return { ...result, checks: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
  };

  it('runs the full check on the first push, when there is no PR yet', () => {
    const result = create(false);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.checks, ['check.sh']);
    assert.match(result.stdout, /full checks: first push/);
  });

  it('runs the fast check on a follow-up push, when the PR exists, and says why', () => {
    const result = create(true);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.checks, ['check.sh --fast']);
    assert.match(result.stdout, /fast checks: follow-up push to PR #60/);
    assert.match(result.stdout, /CI runs the full gate/);
  });

  it('runs the full check on a follow-up push with --full', () => {
    const result = create(true, ['--full']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.checks, ['check.sh']);
    assert.match(result.stdout, /full checks: --full/);
  });

  it('does not push when the chosen check fails', () => {
    const pushed = git('ls-remote', remote);
    git('commit', '--quiet', '--allow-empty', '-m', 'fix(F031): hold longer');
    const result = create(true, [], { FAKE_CHECK_EXIT: '1' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /checks failed/);
    assert.equal(git('ls-remote', remote), pushed);
  });

  it('runs no check with --no-check', () => {
    const result = create(true, ['--no-check']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.checks, []);
  });
});

describe('E002 #107 pr.sh ready', () => {
  const gh = fakeGh();
  after(() => gh.cleanup());

  const ready = (options) => {
    const result = spawnSync(join(SCRIPTS, 'pr.sh'), ['ready'], {
      encoding: 'utf8',
      env: gh.env(github(options)),
    });
    return { ...result, calls: gh.calls().map((call) => call.args.join(' ')) };
  };
  const refuses = (options, ...reasons) => {
    const result = ready(options);
    assert.equal(result.status, 1, result.stdout);
    for (const reason of reasons) assert.match(result.stderr, reason);
    assert.ok(!result.calls.some((call) => /^pr ready/.test(call)), 'marked the PR ready');
  };
  const SMOKED = `**Railway preview smoke check:** on \`${HEAD}\`: \`curl -fsS https://x/api/v1/health\` → \`{"status":"ok"}\` ✅`;
  const REVIEWED = `**Self-review:** standards and spec reviewers clean on \`${HEAD}\` ✅`;

  it('E002 #107 AC1: marks the draft ready when every check passed, the review and the smoke are recorded for the head', () => {
    const result = ready();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.calls.some((call) => /^pr ready 60 /.test(call)));
    assert.match(result.stdout, /PR #60 ready for review/);
  });

  it('E002 #107 AC1: accepts a recorded smoke check of a preview that exists', () => {
    const result = ready({ status: WEB_DEPLOYED, body: `${REVIEWED}\n\n${SMOKED}` });
    assert.equal(result.status, 0, result.stderr);
  });

  it('E002 #107 AC1: refuses on a failing check and names it', () => {
    const rollup = CI.map((name) => checkRun(name, name === 'iOS' ? 'FAILURE' : 'SUCCESS'));
    refuses({ rollup }, /checks passed \(failing: iOS\)/);
  });

  it('E002 #107 AC1: refuses on a pending check and names it', () => {
    const rollup = CI.map((name) =>
      name === 'E2E (Linux)' ? checkRun(name, null, 'IN_PROGRESS') : checkRun(name),
    );
    refuses({ rollup }, /checks passed \(pending: E2E \(Linux\)\)/);
  });

  it('E002 #107 AC1: refuses on a missing check and names it', () => {
    const rollup = CI.filter((name) => name !== 'Android').map((name) => checkRun(name));
    refuses({ rollup }, /checks passed \(missing: Android\)/);
  });

  it('E002 #107 AC1: refuses without a review record, and names it', () => {
    refuses({ body: `Closes #57\n\n${NO_PREVIEW}` }, /self-review clean \(no self-review record/);
  });

  it('E002 #107 AC1: refuses when the review was recorded for an older commit', () => {
    const old = `**Self-review:** standards and spec reviewers clean on \`${'b'.repeat(40)}\` ✅`;
    refuses(
      { body: `Closes #57\n\n${old}\n\n${NO_PREVIEW}` },
      /self-review clean \(the self-review record is for bbbbbbb, not the head ccccccc\)/,
    );
  });

  it('E002 #107 AC1: refuses without a smoke record, and names it', () => {
    refuses({ body: `Closes #57\n\n${REVIEWED}` }, /preview smoke-checked \(no smoke check record/);
  });

  it('E002 #107 AC1: names every missing piece at once', () => {
    const rollup = CI.map((name) => checkRun(name, name === 'iOS' ? 'FAILURE' : 'SUCCESS'));
    refuses(
      { rollup, body: 'Closes #57' },
      /checks passed \(failing: iOS\)/,
      /self-review clean/,
      /preview smoke-checked/,
    );
  });

  it("E002 #107 AC1: refuses when the head commit's statuses can't be read", () => {
    const result = spawnSync(join(SCRIPTS, 'pr.sh'), ['ready'], {
      encoding: 'utf8',
      env: gh.env([{ match: STATUS, out: '', status: 1 }, ...github()]),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not read the statuses/);
    assert.ok(!gh.calls().some((call) => call.args[1] === 'ready'));
  });

  it("E002 #107 AC1: doesn't need the rest of the merge gate: a high-risk PR or open threads", () => {
    const result = ready({ files: ['packages/database/migrations/0004.sql'] });
    assert.equal(result.status, 0, result.stderr);
  });
});

describe('E002 #107 pr.sh ship', () => {
  const gh = fakeGh();
  const railway = fakeRailway();
  const bin = mkdtempSync(join(tmpdir(), 'fake-curl-'));
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\necho \'{"status":"ok"}\'\n');
  chmodSync(join(bin, 'curl'), 0o755);
  after(() => {
    gh.cleanup();
    railway.cleanup();
    rmSync(bin, { recursive: true, force: true });
  });

  const step = (name, started, completed) => ({
    name,
    started_at: `2026-10-19T10:${started}Z`,
    completed_at: `2026-10-19T10:${completed}Z`,
  });
  const JOBS = {
    jobs: [
      { name: 'Checks (Linux)', steps: [step('Lint', '00:00', '00:30')] },
      {
        name: 'iOS',
        steps: [step('Set up job', '00:00', '00:02'), step('Build and test', '00:02', '24:32')],
      },
      { name: 'Android', steps: [step('Emulator tests', '00:00', '12:05')] },
    ],
  };
  const checks = (names, bucket = 'pass') => names.map((name) => ({ name, bucket }));

  const ship = ({
    ci = checks(CI),
    run = ['completed', 'success'],
    args = [],
    jobs = JOBS,
    ghFirst = [], // fake-gh rules checked before the defaults below
    ...options
  } = {}) => {
    const env = railway.env(
      gh.env([
        ...ghFirst,
        { match: '^pr checks ', out: ci },
        { match: '^run list ', out: [{ status: run[0], conclusion: run[1], databaseId: 555 }] },
        { match: '^api repos/[^ ]+/actions/runs/555/jobs', out: jobs },
        ...github(options),
      ]),
      'deployed',
    );
    const result = spawnSync(join(SCRIPTS, 'pr.sh'), ['ship', ...args], {
      encoding: 'utf8',
      env: { ...env, PATH: `${bin}:${env.PATH}` },
    });
    const calls = gh.calls().map((call) => call.args.join(' '));
    const at = (pattern) => calls.findIndex((call) => pattern.test(call));
    return { ...result, calls, at };
  };

  it('E002 #107 AC2: runs wait, smoke and ready in order and records nothing else', () => {
    const result = ship({
      body: `Closes #57\n\n**Self-review:** standards and spec reviewers clean on \`${HEAD}\` ✅\n\n${NO_PREVIEW}`,
    });
    assert.equal(result.status, 0, result.stderr);
    const [wait, smoke, ready] = [/^pr checks /, /^pr edit 60 /, /^pr ready 60 /].map(result.at);
    assert.ok(wait >= 0 && wait < smoke && smoke < ready, result.calls.join('\n'));
    const edits = result.calls.filter((call) => call.startsWith('pr edit'));
    assert.equal(edits.length, 1, 'only the smoke record');
    assert.ok(edits[0].includes('Railway preview smoke check'));
    assert.match(result.stdout, /PR #60 ready for review/);
  });

  it('E002 #107 AC2: stops at a failed wait with its exit code, and runs neither smoke nor ready', () => {
    const result = ship({ ci: checks(['iOS'], 'fail') });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /checks failed: iOS/);
    assert.ok(!result.calls.some((call) => /^pr edit|^pr ready/.test(call)));
  });

  it('E002 #107 AC2: passes on the exit code 2 of a wait that timed out', () => {
    const result = ship({
      ci: checks(CI, 'pending'),
      run: ['in_progress', ''],
      args: ['--timeout', '0'],
    });
    assert.equal(result.status, 2, result.stderr);
    assert.ok(!result.calls.some((call) => /^pr edit|^pr ready/.test(call)));
  });

  it('E002 #107 AC2: stops at a failed smoke with its exit code, and does not mark the PR ready', () => {
    const result = ship({ status: { total_count: 31, statuses: [] } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not read the statuses/);
    assert.ok(!result.calls.some((call) => /^pr ready/.test(call)));
  });

  it('E002 #107 AC2: stops at a refused ready with its exit code', () => {
    const result = ship({ body: 'Closes #57' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /self-review clean/);
    assert.ok(!result.calls.some((call) => /^pr ready/.test(call)));
  });

  it('E002 #107 AC2: waits up to 45 minutes when iOS or Android run, 20 otherwise', () => {
    const native = ship();
    assert.match(native.stdout, /up to 45 min/);
    const rollup = ['Detect changes', 'Checks (Linux)', 'E2E (Linux)'].map((name) =>
      checkRun(name),
    );
    const linux = ship({ ci: checks(['Detect changes', 'Checks (Linux)', 'E2E (Linux)']), rollup });
    assert.match(linux.stdout, /up to 20 min/);
    assert.doesNotMatch(linux.stdout, /up to 45 min/);
  });

  it('E002 #107 AC2: keeps the 20-minute wait when the native jobs are skipped, as they are in most PRs', () => {
    const ci = [
      ...checks(['Detect changes', 'Checks (Linux)', 'E2E (Linux)']),
      ...checks(['iOS', 'Android'], 'skipping'),
    ];
    const result = ship({ ci });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /up to 20 min/);
    assert.doesNotMatch(result.stdout, /up to 45 min/);
  });

  it('E002 #107 AC2: lets --timeout choose the wait', () => {
    const result = ship({ args: ['--timeout', '7'] });
    assert.match(result.stdout, /up to 7 min/);
  });

  it('E002 #107 AC2: prints the step durations of the native jobs at the end, and none of the others', () => {
    const result = ship();
    assert.equal(result.status, 0, result.stderr);
    const out = result.stdout.slice(result.stdout.indexOf('Step durations'));
    assert.match(out, /Step durations: iOS/);
    assert.match(out, /24 min 30 s +Build and test/);
    assert.match(out, /Step durations: Android/);
    assert.match(out, /12 min 5 s +Emulator tests/);
    assert.doesNotMatch(out, /Lint/);
  });

  it('E002 #107 AC2: prints the durations also when a step failed, and prints none when no native job ran', () => {
    const failed = ship({ ci: checks(['iOS'], 'fail') });
    assert.match(failed.stdout, /Step durations: iOS/);
    const none = ship({ jobs: { jobs: [JOBS.jobs[0]] } });
    assert.equal(none.status, 0, none.stderr);
    assert.doesNotMatch(none.stdout, /Step durations/);
  });

  it('E002 #121 AC1: prints no duration block for native jobs that were skipped, and not an empty 0 min 0 s one', () => {
    const skipped = (name) => ({ name, status: 'completed', conclusion: 'skipped', steps: [] });
    const ci = [
      ...checks(['Detect changes', 'Checks (Linux)', 'E2E (Linux)']),
      ...checks(['iOS', 'Android'], 'skipping'),
    ];
    const result = ship({ ci, jobs: { jobs: [JOBS.jobs[0], skipped('iOS'), skipped('Android')] } });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Step durations/);
    assert.doesNotMatch(result.stdout, /0 min 0 s/);
  });

  it('E002 #121 AC2: prints the durations of the native job that ran, and none for the one that was skipped', () => {
    const android = { name: 'Android', status: 'completed', conclusion: 'skipped', steps: [] };
    const result = ship({ jobs: { jobs: [JOBS.jobs[0], JOBS.jobs[1], android] } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Step durations: iOS/);
    assert.match(result.stdout, /24 min 30 s +Build and test/);
    assert.doesNotMatch(result.stdout, /Step durations: Android/);
  });

  it('E002 #107 AC2: says so, in one line, for a native job cancelled before its first step, and stays silent for a skipped one', () => {
    const job = (name, conclusion) => ({ name, status: 'completed', conclusion, steps: [] });
    const result = ship({ jobs: { jobs: [job('iOS', 'cancelled'), job('Android', 'skipped')] } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Step durations: iOS: no step timings \(cancelled\)$/m);
    assert.doesNotMatch(result.stdout, /Step durations: Android/);
    assert.doesNotMatch(result.stdout, /0 min 0 s/);
  });

  it('E002 #107 AC2: names the missing CI run on stderr instead of staying silent, and still ships', () => {
    const result = ship({ ghFirst: [{ match: '^run list .*--json databaseId', out: '[]' }] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /no CI run for .*; no step durations/);
    assert.doesNotMatch(result.stdout, /Step durations/);
  });

  it('E002 #107 AC2: names the failed run list on stderr', () => {
    const result = ship({
      ghFirst: [{ match: '^run list .*--json databaseId', out: '', status: 1 }],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /could not list the CI runs; no step durations/);
  });

  it('E002 #107 AC2: names jobs that are not JSON on stderr', () => {
    const result = ship({ jobs: '<html>rate limited</html>' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /could not parse the jobs of CI run 555; no step durations/);
    assert.doesNotMatch(result.stdout, /Step durations/);
  });

  it("E002 #107 AC2: says on stderr when a step's timestamp can't be read, and keeps what was printed", () => {
    const broken = { name: 'Android', steps: [step('Emulator tests', '00:00', '12:05')] };
    broken.steps.push({ name: 'Broken', started_at: 'soon', completed_at: 'later' });
    const result = ship({ jobs: { jobs: [JOBS.jobs[1], broken] } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Step durations: iOS/);
    assert.match(
      result.stderr,
      /could not read a step's timestamps; step durations may be cut off/,
    );
  });

  it("E002 #107 AC2: doesn't fail the ship when the durations can't be read", () => {
    const result = ship({ jobs: '' });
    assert.equal(result.status, 0, result.stderr);
  });

  it('E002 #107 AC2: takes no unknown argument', () => {
    const result = ship({ args: ['--body-file', '-'] });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pr\.sh ship \[--timeout <minutes>\]/);
    assert.ok(!result.calls.some((call) => /^pr (checks|edit|ready)/.test(call)));
  });
});
