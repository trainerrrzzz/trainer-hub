import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { commonGitDir, evaluate, targetPaths } from './guard-edits.mjs';

const SCRIPT = join(import.meta.dirname, 'guard-edits.mjs');

describe('agent edit guard', () => {
  let base;
  let main;
  let worktree;
  let gitDir;

  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
  const claudeEdit = (file_path) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path },
  });

  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'guard-edits-')));
    main = join(base, 'repo');
    mkdirSync(join(main, 'packages/i18n/generated'), { recursive: true });
    writeFileSync(join(main, '.gitignore'), '.env\n.worktrees/\n');
    writeFileSync(join(main, 'AGENTS.md'), 'rules\n');
    writeFileSync(join(main, 'packages/i18n/generated/strings.xml'), '<resources/>\n');
    mkdirSync(join(main, '.agents/skills/tdd'), { recursive: true });
    mkdirSync(join(main, '.agents/skills/work'), { recursive: true });
    writeFileSync(join(main, '.agents/skills/tdd/SKILL.md'), 'vendored\n');
    writeFileSync(
      join(main, '.agents/skills/tdd/.upstream'),
      'https://github.com/mattpocock/skills\n',
    );
    writeFileSync(join(main, '.agents/skills/work/SKILL.md'), 'local\n');
    mkdirSync(join(main, '.claude'));
    symlinkSync('../.agents/skills', join(main, '.claude/skills'));
    git(main, 'init', '--quiet', '--initial-branch=main');
    git(main, 'add', '.');
    git(
      main,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--quiet',
      '-m',
      'init',
    );
    worktree = join(main, '.worktrees/feature');
    git(main, 'worktree', 'add', '--quiet', worktree, '-b', 'docs/feature');
    gitDir = commonGitDir(main);
  });

  after(() => rmSync(base, { recursive: true, force: true }));

  it('blocks edits in a checkout on main', () => {
    assert.match(evaluate(claudeEdit(join(main, 'AGENTS.md')), gitDir), /is on `main`/);
    assert.match(
      evaluate(claudeEdit(join(main, 'docs/new-folder/new.md')), gitDir),
      /is on `main`/,
    );
  });

  it('allows git-ignored files on main, such as a local .env', () => {
    assert.equal(evaluate(claudeEdit(join(main, '.env')), gitDir), null);
  });

  it('allows edits in a worktree on a feature branch', () => {
    assert.equal(evaluate(claudeEdit(join(worktree, 'AGENTS.md')), gitDir), null);
  });

  it('blocks hand-edits of generated files on any branch', () => {
    const reason = evaluate(
      claudeEdit(join(worktree, 'packages/i18n/generated/strings.xml')),
      gitDir,
    );
    assert.match(reason, /is generated/);
    assert.match(reason, /pnpm --filter @fivvi\/i18n generate/);

    for (const file of [
      'packages/design-tokens/generated/web/tokens.css',
      'packages/design-tokens/FivviDesignTokens/Sources/FivviDesignTokens/Generated/Colors.swift',
      'packages/design-tokens/kotlin/generated/app/fivvi/designtokens/Colors.kt',
    ]) {
      assert.match(
        evaluate(claudeEdit(join(worktree, file)), gitDir) ?? '',
        /pnpm --filter @fivvi\/design-tokens generate/,
        file,
      );
    }
    assert.equal(
      evaluate(
        claudeEdit(join(worktree, 'packages/design-tokens/FivviDesignTokens/Package.swift')),
        gitDir,
      ),
      null,
    );
  });

  it('blocks hand-edits of the generated app icon files and allows the rest of the apps', () => {
    for (const file of [
      'apps/ios/FivviPro/Assets.xcassets/Contents.json',
      'apps/ios/FivviPro/Assets.xcassets/AppIcon.appiconset/Contents.json',
      'apps/ios/FivviPro/Assets.xcassets/AppIcon.appiconset/AppIcon.png',
      'apps/android/app/src/main/ic_launcher-playstore.png',
      'apps/android/app/src/main/res/drawable/ic_launcher_background.xml',
      'apps/android/app/src/main/res/drawable/ic_launcher_foreground.xml',
      'apps/android/app/src/main/res/drawable/ic_launcher_monochrome.xml',
      'apps/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
    ]) {
      const reason = evaluate(claudeEdit(join(worktree, file)), gitDir) ?? '';
      assert.match(reason, /is generated/, file);
      assert.match(reason, /pnpm app-icon/, file);
    }
    for (const file of [
      'apps/android/app/src/main/AndroidManifest.xml',
      'apps/android/app/src/main/res/xml/network_security_config.xml',
      'apps/ios/FivviPro/FivviProApp.swift',
      'apps/ios/FivviPro/Assets.xcassets/AccentColor.colorset/Contents.json',
      'scripts/app-icon.mjs',
    ]) {
      assert.equal(evaluate(claudeEdit(join(worktree, file)), gitDir), null, file);
    }
  });

  it('blocks hand-edits of vendored skills, also through the .claude/skills symlink', () => {
    assert.match(
      evaluate(claudeEdit(join(worktree, '.agents/skills/tdd/SKILL.md')), gitDir),
      /vendored skill/,
    );
    assert.match(
      evaluate(claudeEdit(join(worktree, '.claude/skills/tdd/SKILL.md')), gitDir),
      /vendored skill/,
    );
  });

  it('allows edits of local skills that are not vendored', () => {
    assert.equal(
      evaluate(claudeEdit(join(worktree, '.agents/skills/work/SKILL.md')), gitDir),
      null,
    );
  });

  it('blocks hand-edits of the generated agent definitions and allows their source', () => {
    for (const file of [
      '.claude/agents/builder.md',
      '.github/agents/builder.agent.md',
      '.codex/agents/builder.toml',
    ]) {
      const reason = evaluate(claudeEdit(join(worktree, file)), gitDir) ?? '';
      assert.match(reason, /is generated/, file);
      assert.match(reason, /scripts\/agents\.sh sync/, file);
    }
    for (const file of [
      '.agents/agents/builder.md',
      '.agents/agents/tiers.json',
      '.codex/config.toml',
      '.github/instructions/docs.instructions.md',
    ]) {
      assert.equal(evaluate(claudeEdit(join(worktree, file)), gitDir), null, file);
    }
  });

  it('ignores files outside the repository', () => {
    assert.equal(evaluate(claudeEdit(join(base, 'elsewhere.txt')), gitDir), null);
  });

  it('resolves relative Copilot paths against the session cwd', () => {
    const payload = { cwd: main, toolName: 'edit', toolArgs: { path: 'AGENTS.md' } };
    assert.match(evaluate(payload, gitDir), /is on `main`/);
  });

  it('reads the paths of Claude, Copilot and patch tool inputs', () => {
    assert.deepEqual(targetPaths({ file_path: '/a' }), ['/a']);
    assert.deepEqual(targetPaths({ notebook_path: '/b.ipynb' }), ['/b.ipynb']);
    assert.deepEqual(targetPaths({ path: 'c.ts', file_text: '' }), ['c.ts']);
    const patch = '*** Begin Patch\n*** Update File: d.ts\n@@\n*** Add File: e.ts\n*** End Patch';
    assert.deepEqual(targetPaths({ input: patch }), ['d.ts', 'e.ts']);
    assert.deepEqual(targetPaths(patch), ['d.ts', 'e.ts']);
    assert.deepEqual(targetPaths(undefined), []);
    assert.deepEqual(targetPaths({ command: 'view', path: 'f.md' }), []);
    assert.deepEqual(targetPaths({ command: 'str_replace', path: 'g.md' }), ['g.md']);
  });

  it('exits 2 with the reason when run as a hook, and 0 when the edit is fine', () => {
    const run = (payload) =>
      spawnSync('node', [SCRIPT], { input: JSON.stringify(payload), encoding: 'utf8' });
    const generated = run(
      claudeEdit(join(import.meta.dirname, '../../packages/i18n/generated/x.xml')),
    );
    assert.equal(generated.status, 2);
    assert.match(generated.stderr, /is generated/);
    assert.equal(JSON.parse(generated.stdout).permissionDecision, 'deny');

    const allowed = run(claudeEdit(join(base, 'elsewhere.txt')));
    assert.equal(allowed.status, 0);
    assert.equal(allowed.stdout, '');
  });

  it('lets the edit through when the payload is unreadable', () => {
    const result = spawnSync('node', [SCRIPT], { input: 'not json', encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /skipped/);
  });
});
