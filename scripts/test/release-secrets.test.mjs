// E017 AC7: the owner's secret-setup script (scripts/release-secrets.sh), run against a fake gh and synthetic files. Every
// value is a made-up sentinel the tests can look for anywhere it must not appear; the ones a scanner could take for real secrets
// are built from parts, so no secret scanner takes them for real ones.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { fakeGh } from './fake-gh.mjs';

const ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/release-secrets.sh');

const SENTINEL = {
  certificate: 'P12-BYTES-sentinel-7f3a\u0001\u0002binary',
  certificateAnswer: ['cert', 'answer', 'sentinel', '91c4'].join('-'),
  profile: 'PROFILE-BYTES-sentinel-2b8d',
  apiKey: [
    '-----BEGIN ',
    'PRIVATE KEY-----\nMIGTAgEAsentinel5e17\n-----END PRIVATE KEY-----\n',
  ].join(''),
  keyId: 'KEYID-sentinel-X1',
  issuerId: 'ISSUER-sentinel-00aa-bb',
  keystore: 'KEYSTORE-BYTES-sentinel-c0de',
  keystoreAnswer: ['store', 'answer', 'sentinel', '4d2e'].join('-'),
  alias: 'alias-sentinel-upload',
  keyAnswer: ['key', 'answer', 'sentinel', '8a8a'].join('-'),
  serviceAccount: JSON.stringify({
    type: 'service_account',
    private_key: 'PLAY-KEY-sentinel-6b6b',
  }),
  sentryValue: `sntry${'s'}_${['value', 'sentinel', '3c3c', 'f00d'].join('-')}`,
};
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

const gh = fakeGh();
let work;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'release-secrets-'));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));
after(() => gh.cleanup());

const file = (name, content) => {
  const path = join(work, name);
  writeFileSync(path, content);
  return path;
};

// A keytool that writes a fixed synthetic keystore and records how it was called.
const fakeKeytool = () => {
  const bin = join(work, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const log = join(work, 'keytool.log');
  writeFileSync(
    join(bin, 'keytool'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
printf 'PASSWORD_IN_ENV=%s\\n' "$FIVVI_KEYSTORE_PASSWORD" >> "${log}"
while [ $# -gt 0 ]; do [ "$1" = -keystore ] && printf '%s' '${SENTINEL.keystore}' > "$2"; shift; done
`,
  );
  chmodSync(join(bin, 'keytool'), 0o755);
  return { bin, log };
};

const run = (args, stdin = '', { rules = [], extraPath = '' } = {}) => {
  const env = gh.env([...rules, { match: '^secret set ', out: '' }]);
  if (extraPath) env.PATH = `${extraPath}:${env.PATH}`;
  const result = spawnSync(SCRIPT, args, { encoding: 'utf8', env, input: stdin });
  return { ...result, calls: gh.calls() };
};
const sets = (calls) =>
  Object.fromEntries(
    calls
      .filter((call) => call.args[0] === 'secret' && call.args[1] === 'set')
      .map((call) => [call.args[2], call.stdin]),
  );
const repoStatus = () =>
  execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
const everything = (result) =>
  result.stdout + result.stderr + JSON.stringify(result.calls.map((call) => call.args));

const noValueLeaks = (result, values) => {
  for (const value of values) {
    for (const form of [value, b64(value)]) {
      assert.ok(
        !everything(result).includes(form),
        `leaked in output or arguments: ${form.slice(0, 12)}…`,
      );
    }
  }
};

describe('E017 AC7: release-secrets.sh ios', () => {
  const ios = (stdin = '') => {
    const args = [
      'ios',
      '--certificate',
      file('dist.p12', SENTINEL.certificate),
      '--profile',
      file('app.mobileprovision', SENTINEL.profile),
      '--api-key',
      file('AuthKey_X.p8', SENTINEL.apiKey),
    ];
    return run(args, stdin);
  };
  const answers = `${SENTINEL.certificateAnswer}\n${SENTINEL.keyId}\n${SENTINEL.issuerId}\n`;

  it('sets the six iOS secrets in the release environment, files base64 where binary', () => {
    const before = repoStatus();
    const result = ios(answers);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(sets(result.calls), {
      IOS_DISTRIBUTION_CERTIFICATE: b64(SENTINEL.certificate),
      IOS_DISTRIBUTION_CERTIFICATE_PASSWORD: SENTINEL.certificateAnswer,
      IOS_PROVISIONING_PROFILE: b64(SENTINEL.profile),
      APP_STORE_CONNECT_KEY_ID: SENTINEL.keyId,
      APP_STORE_CONNECT_ISSUER_ID: SENTINEL.issuerId,
      APP_STORE_CONNECT_API_KEY: SENTINEL.apiKey,
    });
    for (const call of result.calls) {
      assert.ok(call.args.includes('--env') && call.args.includes('release'));
    }
    assert.equal(repoStatus(), before, 'the repo is unchanged');
  });

  it('prints no value to stdout or stderr and passes none as a command-line argument', () => {
    const result = ios(answers);
    assert.equal(result.status, 0, result.stderr);
    noValueLeaks(result, [
      SENTINEL.certificate,
      SENTINEL.certificateAnswer,
      SENTINEL.profile,
      SENTINEL.apiKey,
      SENTINEL.keyId,
      SENTINEL.issuerId,
    ]);
    assert.match(result.stdout, /IOS_DISTRIBUTION_CERTIFICATE_PASSWORD/);
  });

  it('asks for a file path it was not given', () => {
    const args = [
      'ios',
      '--profile',
      file('p.mobileprovision', SENTINEL.profile),
      '--api-key',
      file('k.p8', SENTINEL.apiKey),
    ];
    const result = run(args, `${file('c.p12', SENTINEL.certificate)}\n${answers}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(sets(result.calls).IOS_DISTRIBUTION_CERTIFICATE, b64(SENTINEL.certificate));
  });

  it('refuses a key file inside the repository, and sets nothing', () => {
    const inRepo = join(ROOT, 'scripts', 'test-key-do-not-create.p12');
    const result = run(
      [
        'ios',
        '--certificate',
        inRepo,
        '--profile',
        file('p', 'x'),
        '--api-key',
        file('k.p8', SENTINEL.apiKey),
      ],
      answers,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /inside the repository/);
    assert.deepEqual(sets(result.calls), {});
  });

  it('refuses a symbolic link to a file in the repository, and sets nothing', () => {
    const link = join(work, 'innocent-looking.p12');
    symlinkSync(join(ROOT, 'package.json'), link);
    const chained = join(work, 'chained.p12');
    symlinkSync(link, chained);
    for (const certificate of [link, chained]) {
      const result = run(
        [
          'ios',
          '--certificate',
          certificate,
          '--profile',
          file('p', 'x'),
          '--api-key',
          file('k.p8', SENTINEL.apiKey),
        ],
        answers,
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /inside the repository/);
      assert.deepEqual(sets(result.calls), {});
    }
  });

  it('refuses a file in the repository that exists (a key left in a checkout)', () => {
    const result = run(
      [
        'ios',
        '--certificate',
        join(ROOT, 'package.json'),
        '--profile',
        file('p', 'x'),
        '--api-key',
        file('k.p8', SENTINEL.apiKey),
      ],
      answers,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /inside the repository/);
    assert.deepEqual(sets(result.calls), {});
  });

  it('stops before setting anything when the .p8 is not a private key', () => {
    const result = run(
      [
        'ios',
        '--certificate',
        file('c', 'x'),
        '--profile',
        file('p', 'x'),
        '--api-key',
        file('k.p8', 'not a key'),
      ],
      answers,
    );
    assert.notEqual(result.status, 0);
    assert.deepEqual(sets(result.calls), {});
  });

  it('stops when a hidden answer is empty', () => {
    const result = ios(`${SENTINEL.certificateAnswer}\n\n`);
    assert.notEqual(result.status, 0);
    assert.deepEqual(sets(result.calls), {});
  });

  it('says how to fix a missing environment without printing a value', () => {
    const result = run(
      [
        'ios',
        '--certificate',
        file('c', SENTINEL.certificate),
        '--profile',
        file('p', SENTINEL.profile),
        '--api-key',
        file('k.p8', SENTINEL.apiKey),
      ],
      answers,
      { rules: [{ match: '^secret set ', status: 1 }] },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /github-settings\.sh apply/);
    noValueLeaks(result, [SENTINEL.certificate, SENTINEL.certificateAnswer]);
  });
});

describe('E017 AC7: release-secrets.sh android, play and sentry', () => {
  it('sets the four keystore secrets from a keystore you have', () => {
    const before = repoStatus();
    const result = run(
      ['android', '--keystore', file('upload.p12', SENTINEL.keystore)],
      `${SENTINEL.keystoreAnswer}\n${SENTINEL.alias}\n${SENTINEL.keyAnswer}\n`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(sets(result.calls), {
      ANDROID_UPLOAD_KEYSTORE: b64(SENTINEL.keystore),
      ANDROID_UPLOAD_KEYSTORE_PASSWORD: SENTINEL.keystoreAnswer,
      ANDROID_UPLOAD_KEY_ALIAS: SENTINEL.alias,
      ANDROID_UPLOAD_KEY_PASSWORD: SENTINEL.keyAnswer,
    });
    noValueLeaks(result, [
      SENTINEL.keystore,
      SENTINEL.keystoreAnswer,
      SENTINEL.alias,
      SENTINEL.keyAnswer,
    ]);
    assert.equal(repoStatus(), before);
  });

  it('sets the Play service-account key, and refuses a file that is not one', () => {
    const before = repoStatus();
    const ok = run(['play', '--service-account', file('sa.json', SENTINEL.serviceAccount)]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(sets(ok.calls), { PLAY_SERVICE_ACCOUNT_JSON: SENTINEL.serviceAccount });
    noValueLeaks(ok, [SENTINEL.serviceAccount, 'PLAY-KEY-sentinel-6b6b']);

    const bad = run(['play', '--service-account', file('other.json', '{"hello":"world"}')]);
    assert.notEqual(bad.status, 0);
    assert.deepEqual(sets(bad.calls), {});
    assert.equal(repoStatus(), before);
  });

  it('sets the Sentry token from a hidden prompt, asking for the scopes the document names', () => {
    const before = repoStatus();
    const result = run(['sentry'], `${SENTINEL.sentryValue}\n`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(sets(result.calls), { SENTRY_AUTH_TOKEN: SENTINEL.sentryValue });
    noValueLeaks(result, [SENTINEL.sentryValue]);
    assert.match(result.stderr, /project:releases and org:read/);
    assert.match(
      readFileSync(join(ROOT, 'docs/engineering/RELEASE.md'), 'utf8'),
      /`project:releases` and `org:read`/,
    );
    assert.equal(repoStatus(), before);
  });

  it('rejects an unknown command and an unknown option', () => {
    assert.notEqual(run(['nope']).status, 0);
    assert.notEqual(run(['sentry', '--token', 'x']).status, 0);
    assert.notEqual(run(['android', '--password', 'x']).status, 0);
  });
});

describe('E017 AC7: release-secrets.sh android-keystore', () => {
  const generate = (stdin, extra = []) => {
    const keytool = fakeKeytool();
    const dir = join(work, 'keys');
    const result = run(['android-keystore', '--dir', dir, ...extra], stdin, {
      extraPath: keytool.bin,
    });
    return { result, dir, keytool };
  };
  const answers = `${SENTINEL.keystoreAnswer}\n${SENTINEL.keystoreAnswer}\n`;

  it('makes the keystore outside the repo, readable by the owner only, and sets its secrets', () => {
    const before = repoStatus();
    const { result, dir } = generate(answers);
    assert.equal(result.status, 0, result.stderr);
    const keystore = join(dir, 'fivvi-pro-upload.p12');
    assert.equal(readFileSync(keystore, 'utf8'), SENTINEL.keystore);
    assert.equal(statSync(dir).mode & 0o077, 0, 'directory is private');
    assert.equal(statSync(keystore).mode & 0o077, 0, 'keystore file is private');
    assert.deepEqual(sets(result.calls), {
      ANDROID_UPLOAD_KEYSTORE: b64(SENTINEL.keystore),
      ANDROID_UPLOAD_KEYSTORE_PASSWORD: SENTINEL.keystoreAnswer,
      ANDROID_UPLOAD_KEY_ALIAS: 'upload',
      ANDROID_UPLOAD_KEY_PASSWORD: SENTINEL.keystoreAnswer,
    });
    assert.match(result.stdout, new RegExp(keystore.replaceAll('.', '\\.')));
    assert.equal(repoStatus(), before);
  });

  it('gives keytool the password through its environment, never its command line or the output', () => {
    const { result, keytool } = generate(answers);
    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(keytool.log, 'utf8');
    assert.ok(
      !log.split('\n')[0].includes(SENTINEL.keystoreAnswer),
      'password not on the command line',
    );
    assert.match(log, new RegExp(`PASSWORD_IN_ENV=${SENTINEL.keystoreAnswer}`));
    noValueLeaks(result, [SENTINEL.keystore, SENTINEL.keystoreAnswer]);
  });

  it('leaves the mode of a directory that exists already as it is', () => {
    const dir = join(work, 'keys');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const keytool = fakeKeytool();
    const result = run(['android-keystore', '--dir', dir], answers, { extraPath: keytool.bin });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(statSync(dir).mode & 0o777, 0o755);
    assert.equal(statSync(join(dir, 'fivvi-pro-upload.p12')).mode & 0o077, 0);
  });

  it('refuses a directory inside the repository and creates nothing there', () => {
    const inRepo = join(ROOT, 'release-keys-do-not-create');
    const keytool = fakeKeytool();
    const result = run(['android-keystore', '--dir', inRepo], answers, {
      extraPath: keytool.bin,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /inside the repository/);
    assert.ok(!existsSync(inRepo));
    assert.deepEqual(sets(result.calls), {});
  });

  it('refuses to overwrite a keystore and when the two passwords differ', () => {
    const first = generate(answers);
    assert.equal(first.result.status, 0, first.result.stderr);
    const again = run(['android-keystore', '--dir', first.dir], answers, {
      extraPath: first.keytool.bin,
    });
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /exists already/);
    assert.equal(readFileSync(join(first.dir, 'fivvi-pro-upload.p12'), 'utf8'), SENTINEL.keystore);

    const other = join(work, 'other');
    const mismatch = run(['android-keystore', '--dir', other], 'one\ntwo\n', {
      extraPath: first.keytool.bin,
    });
    assert.notEqual(mismatch.status, 0);
    assert.ok(!existsSync(other));
  });
});

describe('E017 AC7: release-secrets.sh list', () => {
  it('names the secrets that are set and the ones still missing, with the command that sets each', () => {
    const result = run(['list'], '', {
      rules: [
        {
          match: '^secret list ',
          out: [{ name: 'SENTRY_AUTH_TOKEN' }, { name: 'IOS_PROVISIONING_PROFILE' }],
        },
      ],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /✅ SENTRY_AUTH_TOKEN/);
    assert.match(result.stdout, /✅ IOS_PROVISIONING_PROFILE/);
    assert.match(result.stdout, /⬜ PLAY_SERVICE_ACCOUNT_JSON +scripts\/release-secrets\.sh play/);
    assert.match(
      result.stdout,
      /⬜ ANDROID_UPLOAD_KEYSTORE +scripts\/release-secrets\.sh android\b/,
    );
  });
});
