// PreToolUse guard shared by Claude Code and GitHub Copilot (CLI and VS Code Copilot sessions),
// configured in .claude/settings.json. It blocks file edits on `main` and hand-edits of generated
// files (AGENTS.md, WORKFLOW.md §4). Exit code 2 blocks the tool call in both tools.
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const PROTECTED_BRANCHES = new Set(['main']);

const CONTRACT = 'pnpm generate:contract';
const TOKENS = 'pnpm --filter @fivvi/design-tokens generate';
const AGENT_DEFINITIONS = 'scripts/agents.sh sync';
const APP_ICON = 'pnpm app-icon';
export const GENERATED_PATHS = [
  ['.claude/agents/', AGENT_DEFINITIONS],
  ['.github/agents/', AGENT_DEFINITIONS],
  ['.codex/agents/', AGENT_DEFINITIONS],
  ['packages/contract/openapi.json', CONTRACT],
  ['packages/contract/src/generated/', CONTRACT],
  ['packages/contract/swift/Sources/FivviAPI/Generated/', CONTRACT],
  ['packages/contract/kotlin/generated/', CONTRACT],
  ['packages/i18n/generated/', 'pnpm --filter @fivvi/i18n generate'],
  ['packages/design-tokens/generated/', TOKENS],
  ['packages/design-tokens/FivviDesignTokens/Sources/FivviDesignTokens/Generated/', TOKENS],
  ['packages/design-tokens/kotlin/generated/', TOKENS],
  ['packages/database/migrations/meta/', 'pnpm db:generate --name <what>'],
  ['apps/ios/FivviPro/Assets.xcassets/AppIcon.appiconset/', APP_ICON],
  ['apps/ios/FivviPro/Assets.xcassets/Contents.json', APP_ICON],
  ['apps/android/app/src/main/ic_launcher-playstore.png', APP_ICON],
  ['apps/android/app/src/main/res/drawable/ic_launcher_background.xml', APP_ICON],
  ['apps/android/app/src/main/res/drawable/ic_launcher_foreground.xml', APP_ICON],
  ['apps/android/app/src/main/res/drawable/ic_launcher_monochrome.xml', APP_ICON],
  ['apps/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml', APP_ICON],
];

const PATCH_FILE_LINE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;

/** A skill vendored by scripts/skills.sh has a .upstream marker; ours (work) doesn't. */
const isVendoredSkill = (root, name) => existsSync(join(root, '.agents/skills', name, '.upstream'));

/** File paths a tool call writes to. Claude: file_path / notebook_path; Copilot: path or a patch. */
export function targetPaths(toolInput) {
  const patches = [];
  const paths = [];
  if (typeof toolInput === 'string') {
    patches.push(toolInput);
  } else if (toolInput && typeof toolInput === 'object') {
    // Copilot maps str_replace_editor to Edit, including its read-only `view` command.
    if (toolInput.command === 'view') return [];
    for (const key of ['file_path', 'notebook_path', 'path']) {
      if (typeof toolInput[key] === 'string') paths.push(toolInput[key]);
    }
    for (const key of ['input', 'patch']) {
      if (typeof toolInput[key] === 'string') patches.push(toolInput[key]);
    }
  }
  for (const patch of patches) {
    for (const match of patch.matchAll(PATCH_FILE_LINE)) paths.push(match[1].trim());
  }
  return paths;
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** The path with symlinks resolved, also when the file or its folder doesn't exist yet. */
function realPath(path) {
  let existing = path;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    existing = parent;
  }
  return join(realpathSync(existing), relative(existing, path));
}

function existingFolder(path) {
  let folder = dirname(path);
  while (!existsSync(folder)) folder = dirname(folder);
  return folder;
}

export function commonGitDir(cwd) {
  return git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
}

/**
 * Why writing `filePath` is not allowed, or null when it is. Only files in a checkout (main
 * checkout or worktree) of the repository whose git directory is `repoGitDir` are guarded.
 */
export function denialReason(filePath, repoGitDir) {
  const file = realPath(filePath);
  const folder = existingFolder(file);
  if (commonGitDir(folder) !== repoGitDir) return null;
  const root = git(folder, ['rev-parse', '--show-toplevel']);
  if (!root) return null;
  const path = relative(root, file).split(sep).join('/');
  if (path.startsWith('../')) return null;

  for (const [prefix, command] of GENERATED_PATHS) {
    if (path === prefix || (prefix.endsWith('/') && path.startsWith(prefix))) {
      return `${path} is generated. Don't edit it by hand: change the source, run \`${command}\` and commit the output.`;
    }
  }

  const skill = /^\.agents\/skills\/([^/]+)\//.exec(path)?.[1];
  if (skill && isVendoredSkill(root, skill)) {
    return `${path} is a vendored skill (mattpocock/skills, pinned in .agents/skills.yaml). Don't edit it by hand: adapt the behaviour in AGENTS.md or docs/agents/, or update the pin with \`scripts/skills.sh update\`.`;
  }

  const branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch && PROTECTED_BRANCHES.has(branch)) {
    const ignored = git(root, ['check-ignore', '--quiet', '--', path]) !== null;
    if (ignored) return null;
    return `${root} is on \`${branch}\`. Never edit on main: create a branch and worktree first (\`git worktree add .worktrees/<slug> -b <type>/<slug>\`, docs/engineering/WORKFLOW.md §3) and edit the files there.`;
  }
  return null;
}

/** The denial message for one PreToolUse payload (Claude Code or Copilot), or null to allow. */
export function evaluate(payload, repoGitDir) {
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  const reasons = targetPaths(payload.tool_input ?? payload.toolArgs)
    .map((path) => denialReason(isAbsolute(path) ? path : resolve(cwd, path), repoGitDir))
    .filter((reason) => reason !== null);
  return reasons.length === 0 ? null : [...new Set(reasons)].join('\n');
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let reason;
  try {
    reason = evaluate(JSON.parse(input), commonGitDir(import.meta.dirname));
  } catch (error) {
    // A broken guard must not block every edit; CI still catches generated-file drift.
    process.stderr.write(`guard-edits: skipped (${error.message})\n`);
    return;
  }
  if (reason === null) return;

  process.stdout.write(
    JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason }),
  );
  process.stderr.write(`${reason}\n`);
  process.exitCode = 2;
}

if (import.meta.main) await main();
