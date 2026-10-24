// E017 AC7: no key material in the repo. scripts/secrets.sh files refuses key files by name and private keys and
// well-known tokens by content, in tracked and new files. Every fixture is built from parts, so this file passes the check.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
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
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const SCRIPTS = join(import.meta.dirname, '..');
const ROOT = join(SCRIPTS, '..');

const dashes = '-----';
const pem = (kind = '') =>
  `${dashes}BEGIN ${kind}PRIVATE KEY${dashes}\nMIGTAgEAsentinel\n${dashes}END ${kind}PRIVATE KEY${dashes}\n`;
const awsKey = `AK${'IA'}${'0123456789ABCDEF'}`;
const githubToken = `gh${'p'}_${'a1B2c3D4e5F6'.repeat(3)}`;
const slackToken = `xo${'xb'}-123456789012-abcdefghijkl`;
const sentryOrgToken = `sntry${'s'}_${'a1b2c3d4'.repeat(5)}`;
const sentryUserToken = `sntry${'u'}_${'0123456789abcdef'.repeat(4)}`;

const makeRepo = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'secrets-')));
  const git = (...args) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Octo',
        GIT_AUTHOR_EMAIL: '42+octocat@users.noreply.github.com',
        GIT_COMMITTER_NAME: 'Octo',
        GIT_COMMITTER_EMAIL: '42+octocat@users.noreply.github.com',
      },
    }).trim();
  const run = (args = ['files'], cwd = dir) =>
    spawnSync(join(dir, 'scripts/secrets.sh'), args, { cwd, encoding: 'utf8' });
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', dir]);
  cpSync(SCRIPTS, join(dir, 'scripts'), { recursive: true });
  git('add', '.');
  git('commit', '--quiet', '-m', 'chore(E017): base');
  return { dir, git, run, write };
};

const output = (result) => result.stdout + result.stderr;

describe('E017 AC7 secrets.sh files', () => {
  let repo;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => rmSync(repo.dir, { recursive: true, force: true }));

  it('passes for a repo without key material, public certificates and key-like words included', () => {
    repo.write(
      'docs/ok.md',
      `Use ${dashes}BEGIN CERTIFICATE${dashes} for public certificates.\nThe private key never enters the repo.\nPRIVATE KEY in prose, ghp_ and AKIA alone, a key-id AKIA-123.\n`,
    );
    repo.git('add', '.');
    const result = repo.run();
    assert.equal(result.status, 0, output(result));
  });

  for (const kind of ['', 'RSA ', 'EC ', 'OPENSSH ', 'ENCRYPTED ', 'DSA ']) {
    it(`fails on a ${kind || 'plain '}PEM private key block, naming file and line but not the key`, () => {
      repo.write('config/notes.txt', `one\n${pem(kind)}`);
      repo.git('add', '.');
      const result = repo.run();
      assert.equal(result.status, 1, output(result));
      assert.match(output(result), /config\/notes\.txt:2.*private key/i);
      assert.ok(!output(result).includes('MIGTAgEAsentinel'));
    });
  }

  for (const [name, token] of [
    ['an AWS access key ID', awsKey],
    ['a GitHub token', githubToken],
    ['a Slack token', slackToken],
    ['a Sentry organization auth token', sentryOrgToken],
    ['a Sentry user auth token', sentryUserToken],
  ]) {
    it(`fails on ${name} in a file, without printing it`, () => {
      repo.write('src/config.ts', `export const x = '${token}';\n`);
      repo.git('add', '.');
      const result = repo.run();
      assert.equal(result.status, 1, output(result));
      assert.match(output(result), /src\/config\.ts:1/);
      assert.ok(!output(result).includes(token));
    });
  }

  for (const extension of [
    'p12',
    'p8',
    'jks',
    'keystore',
    'mobileprovision',
    'pfx',
    'P12',
    'PFX',
  ]) {
    it(`fails on a tracked *.${extension} file, whatever it holds`, () => {
      repo.write(`apps/ios/signing/dist.${extension}`, 'binary-ish');
      repo.git('add', '-f', '.');
      const result = repo.run();
      assert.equal(result.status, 1, output(result));
      assert.match(output(result), new RegExp(`apps/ios/signing/dist\\.${extension}`));
    });
  }

  it('also fails on a new file that is not tracked yet, but not on an ignored one', () => {
    repo.write('.gitignore', 'ignored/\n*.p12\n');
    repo.write('ignored/x.txt', pem());
    repo.write('upload.p12', 'x');
    assert.equal(repo.run().status, 0);
    repo.write('new.txt', pem());
    const result = repo.run();
    assert.equal(result.status, 1);
    assert.match(output(result), /new\.txt:1/);
    assert.doesNotMatch(output(result), /ignored|upload\.p12/);
  });

  it('reads a file named like an option as a file, so it cannot switch the content checks off', () => {
    repo.write('-rfoo.txt', 'harmless\n');
    repo.write('config/key.txt', pem());
    repo.git('add', '.');
    const result = repo.run();
    assert.equal(result.status, 1, output(result));
    assert.match(output(result), /config\/key\.txt:1.*private key/i);
  });

  it('reads a file named exactly "-" as a file, not as standard input', () => {
    repo.write('-', pem());
    repo.git('add', '.');
    const result = repo.run();
    assert.equal(result.status, 1, output(result));
    assert.match(output(result), /^-:1: .*private key/im);
  });

  it('does not read a symlink that points out of the repo', () => {
    const outside = join(repo.dir, '..', `${repo.dir.split('/').pop()}-outside.txt`);
    writeFileSync(outside, pem());
    try {
      symlinkSync(outside, join(repo.dir, 'link.txt'));
      repo.git('add', '.');
      const result = repo.run();
      assert.equal(result.status, 0, output(result));
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('does not take a name that only ends like a key file for one', () => {
    repo.write('docs/p12.md', 'x');
    repo.write('docs/keystore-notes.txt', 'x');
    repo.write('docs/my.p12.md', 'x');
    assert.equal(repo.run().status, 0);
  });

  it('lets an allowlisted path through, but only with a reason', () => {
    repo.write('fixtures/dummy.p12', 'x');
    repo.write('fixtures/key.txt', pem());
    assert.equal(repo.run().status, 1);
    writeFileSync(
      join(repo.dir, 'scripts/secret-allowlist.txt'),
      'fixtures/*.p12 | synthetic empty file for a parser test\n',
      { flag: 'a' },
    );
    const partial = repo.run();
    assert.equal(partial.status, 1);
    assert.match(output(partial), /fixtures\/key\.txt:1/);
    assert.doesNotMatch(output(partial), /dummy\.p12/);
    writeFileSync(
      join(repo.dir, 'scripts/secret-allowlist.txt'),
      'fixtures/key.txt | a made-up key for the parser test\n',
      { flag: 'a' },
    );
    assert.equal(repo.run().status, 0, output(repo.run()));
  });

  it('names a path containing a colon whole, with its line, and lets an allowlist entry for it apply', () => {
    repo.write('docs/we:ird.txt', `one\n${pem()}`);
    repo.write('docs/ok:name.p12', 'x');
    repo.git('add', '-f', '.');
    const result = repo.run();
    assert.equal(result.status, 1, output(result));
    assert.match(output(result), /^docs\/we:ird\.txt:2: .*private key/im);
    assert.match(output(result), /^docs\/ok:name\.p12: key or certificate file/m);
    writeFileSync(
      join(repo.dir, 'scripts/secret-allowlist.txt'),
      'docs/we:ird.txt | a made-up key for the parser test\ndocs/ok:name.p12 | empty file for a parser test\n',
      { flag: 'a' },
    );
    assert.equal(repo.run().status, 0, output(repo.run()));
  });

  it('scans the whole repo when it runs from a subdirectory', () => {
    repo.write('docs/key.txt', pem());
    repo.write('src/app/index.ts', 'export {};\n');
    repo.git('add', '.');
    const result = repo.run(['files'], join(repo.dir, 'src/app'));
    assert.equal(result.status, 1, output(result));
    assert.match(output(result), /^docs\/key\.txt:1: /m);
  });

  it('fails on an allowlist entry without a reason', () => {
    repo.write('fixtures/dummy.p12', 'x');
    writeFileSync(join(repo.dir, 'scripts/secret-allowlist.txt'), 'fixtures/*.p12\n', {
      flag: 'a',
    });
    const result = repo.run();
    assert.equal(result.status, 1);
    assert.match(output(result), /secret-allowlist\.txt.*reason/);
  });

  it('prints its usage and fails for an unknown command', () => {
    const result = repo.run(['nope']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /secrets\.sh files/);
  });
});

describe('E017 AC7 the repo itself', () => {
  it('has no key material in its tracked and new files', () => {
    const result = spawnSync(join(ROOT, 'scripts/secrets.sh'), ['files'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, output(result));
  });

  it('is checked by scripts/check.sh next to the email checks', () => {
    const check = readFileSync(join(SCRIPTS, 'check.sh'), 'utf8');
    assert.match(check, /^check "file secrets" "\$ROOT\/scripts\/secrets\.sh" files$/m);
  });

  it('keeps key files out of git with .gitignore', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n');
    for (const pattern of ['*.p12', '*.p8', '*.jks', '*.keystore', '*.mobileprovision', '*.pfx']) {
      assert.ok(ignore.includes(pattern), pattern);
    }
  });
});
