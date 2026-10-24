// A stand-in for the gh CLI, so the scripts' I/O can be tested without network. Each call is matched against rules
// ({match: regex on the space-joined arguments, out: string or JSON, status}); the first match answers. `--jq` is
// applied with jq like gh does. Every call is logged, with the content of an `--input` file and, for `secret set`, the
// value piped to its stdin.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GH = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const line = args.join(' ');
const at = (flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const input = at('--input');
const body = input === undefined ? undefined : readFileSync(input === '-' ? 0 : input, 'utf8');
const stdin = args[0] === 'secret' && args[1] === 'set' && input === undefined ? readFileSync(0, 'utf8') : undefined;
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, input: body, stdin }) + '\\n');
const rule = JSON.parse(readFileSync(process.env.FAKE_GH_RULES, 'utf8')).find((r) => new RegExp(r.match).test(line));
if (!rule) { process.stderr.write('fake gh: no rule for: ' + line + '\\n'); process.exit(1); }
let out = rule.out === undefined ? '' : typeof rule.out === 'string' ? rule.out : JSON.stringify(rule.out);
const jq = at('--jq') ?? at('-q');
if (jq !== undefined) out = execFileSync('jq', ['-r', jq], { input: out, encoding: 'utf8' });
else if (out !== '' && !out.endsWith('\\n')) out += '\\n';
process.stdout.write(out);
process.exit(rule.status ?? 0);
`;

export function fakeGh() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  writeFileSync(join(dir, 'gh'), GH);
  chmodSync(join(dir, 'gh'), 0o755);
  const rulesFile = join(dir, 'rules.json');
  const logFile = join(dir, 'calls.log');
  return {
    env: (rules) => {
      writeFileSync(rulesFile, JSON.stringify(rules));
      writeFileSync(logFile, '');
      return {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        FAKE_GH_RULES: rulesFile,
        FAKE_GH_LOG: logFile,
      };
    },
    calls: () =>
      readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((entry) => JSON.parse(entry)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
