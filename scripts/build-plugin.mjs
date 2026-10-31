#!/usr/bin/env node
/**
 * Build the Claude Code plugin form of this skill into dist-plugin/.
 *
 *   npm run build:plugin
 *
 * The plugin ships no node_modules and runs no build on the user's machine:
 * bitbucket-mcp's CLI is bundled (esbuild, all deps inlined) into
 * skills/bitbucket-devops/bin/bitbucket-cli.mjs. SKILL.md and docs/ are
 * copied with install paths (~/.claude/skills/bitbucket-devops/...) rewritten
 * to ${CLAUDE_SKILL_DIR}, which Claude Code substitutes in SKILL.md. The
 * source SKILL.md stays as-is for the install.sh route.
 *
 * Every rewrite must match; a source edit that breaks one fails the build
 * instead of shipping a plugin with stale paths.
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MCP_DIR = join(ROOT, 'bitbucket-mcp');
const OUT = join(ROOT, 'dist-plugin');
const SKILL_OUT = join(OUT, 'skills', 'bitbucket-devops');
const NODE_TARGET = 'node18'; // bitbucket-mcp engines.node >=18

const pkg = JSON.parse(fs.readFileSync(join(ROOT, 'package.json'), 'utf-8'));

const DOCS = ['REFERENCE.md', 'PATTERNS.md', 'TROUBLESHOOTING.md', 'GIT_OPERATIONS.md'];

function fail(msg) {
  console.error(`build:plugin: ${msg}`);
  process.exit(1);
}

/** Apply [from, to] rewrites; each must occur at least once. */
function rewrite(text, rules, file) {
  for (const [from, to] of rules) {
    const hit = typeof from === 'string' ? text.includes(from) : from.test(text);
    if (!hit) fail(`${file}: expected text not found: ${from}`);
    text = typeof from === 'string' ? text.split(from).join(to) : text.replace(from, to);
  }
  return text;
}

// Applied to SKILL.md and docs/ after the file-specific rules. Commands get the
// path quoted: the substituted directory can contain spaces (Windows profiles).
const CLI_SRC = /~\/\.claude\/skills\/bitbucket-devops\/bitbucket-mcp\/dist\/index-cli\.js/;
const PATH_RULES = [
  [new RegExp(`node ${CLI_SRC.source}`, 'g'), 'node "${CLAUDE_SKILL_DIR}/bin/bitbucket-cli.mjs"'],
  [/node ~\/\.claude\/skills\/bitbucket-devops\/(\S+)/g, 'node "${CLAUDE_SKILL_DIR}/$1"'],
  [new RegExp(CLI_SRC.source, 'g'), '${CLAUDE_SKILL_DIR}/bin/bitbucket-cli.mjs'],
  [/~\/\.claude\/skills\/bitbucket-devops\//g, '${CLAUDE_SKILL_DIR}/'],
];

const SKILL_RULES = [
  [
    /\*\*Note on paths:\*\*[^\n]*\n/,
    '**Note on paths:** This skill is installed as a Claude Code plugin. Its directory is `${CLAUDE_SKILL_DIR}`; ' +
      'run every command below exactly as written. The files under `docs/` write the same directory as ' +
      '`${CLAUDE_SKILL_DIR}` too - when you run a command copied from them, replace it with `${CLAUDE_SKILL_DIR}` as shown here.\n',
  ],
  // The source points Tier 3 at a bitbucket-mcp/docs/ folder that is not shipped.
  [
    /\*\*Documentation:\*\* `~\/\.claude\/skills\/bitbucket-devops\/bitbucket-mcp\/docs\/`\n(- `[^\n]*\n)+/,
    '**Documentation:** [docs/REFERENCE.md](docs/REFERENCE.md) (Tier 3 section) and the public Bitbucket Cloud API spec at https://api.bitbucket.org/swagger.json\n',
  ],
  ['- Git (for submodule management)\n', ''],
  [
    '**Note:** No MCP server required - bitbucket-mcp is used as a library via git submodule.',
    '**Note:** No MCP server required - the bitbucket-mcp CLI is bundled into `bin/bitbucket-cli.mjs`.',
  ],
  ['The skill directory is located at: `~/.claude/skills/bitbucket-devops/`', 'The skill directory is located at: `${CLAUDE_SKILL_DIR}`'],
  [
    /3\. \*\*Skill level\*\*: `~\/\.claude\/skills\/bitbucket-devops\/credentials\.json`\n/,
    '\nWhen a user needs to set up credentials, point them at `~/.bitbucket-credentials` (copy `${CLAUDE_SKILL_DIR}/credentials.json.template` there). ' +
      'Never save credentials inside the skill directory: it is replaced on every plugin update.\n',
  ],
];

const DOC_RULES = {
  'REFERENCE.md': [
    [
      '1. Read API documentation from `~/.claude/skills/bitbucket-devops/docs/bitbucket-api/`',
      '1. Read the Bitbucket Cloud API spec: https://api.bitbucket.org/swagger.json',
    ],
  ],
  'PATTERNS.md': [
    ['cat ~/.claude/skills/bitbucket-devops/credentials.json | grep workspace', 'grep workspace ~/.bitbucket-credentials'],
  ],
};

// 1. Submodule deps (needed only to bundle; nothing is shipped from node_modules).
if (!fs.existsSync(join(MCP_DIR, 'package.json'))) {
  fail('bitbucket-mcp submodule missing - run: git submodule update --init');
}
execSync('npm ci --no-audit --no-fund', { cwd: MCP_DIR, stdio: 'inherit' });

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(join(SKILL_OUT, 'bin'), { recursive: true });
fs.mkdirSync(join(SKILL_OUT, 'lib'), { recursive: true });
fs.mkdirSync(join(SKILL_OUT, 'docs'), { recursive: true });
fs.mkdirSync(join(OUT, '.claude-plugin'), { recursive: true });

// 2. Bundle the CLI from TypeScript source into one self-contained ESM file.
await build({
  entryPoints: [join(MCP_DIR, 'src', 'index-cli.ts')],
  outfile: join(SKILL_OUT, 'bin', 'bitbucket-cli.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: NODE_TARGET,
  // CJS deps (winston, axios internals) call require(); give ESM output one.
  banner: { js: "import { createRequire as __bbCreateRequire } from 'module'; const require = __bbCreateRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});

// 3. Runtime files.
fs.copyFileSync(join(ROOT, 'lib', 'helpers.js'), join(SKILL_OUT, 'lib', 'helpers.js'));
fs.copyFileSync(join(ROOT, 'credentials.json.template'), join(SKILL_OUT, 'credentials.json.template'));
// helpers.js is ESM; Node 18 needs "type": "module" to load it. No lockfile, so
// Claude Code's plugin dependency install never runs.
fs.writeFileSync(join(SKILL_OUT, 'package.json'), JSON.stringify({ private: true, type: 'module' }, null, 2) + '\n');

const skill = fs.readFileSync(join(ROOT, 'SKILL.md'), 'utf-8');
fs.writeFileSync(join(SKILL_OUT, 'SKILL.md'), rewrite(rewrite(skill, SKILL_RULES, 'SKILL.md'), PATH_RULES, 'SKILL.md'));

for (const doc of DOCS) {
  let text = fs.readFileSync(join(ROOT, 'docs', doc), 'utf-8');
  if (DOC_RULES[doc]) text = rewrite(text, DOC_RULES[doc], doc);
  // Not every doc has install paths, so the path rules are optional here.
  for (const [from, to] of PATH_RULES) text = text.replace(from, to);
  fs.writeFileSync(join(SKILL_OUT, 'docs', doc), text);
}

// 4. Manifest.
const manifest = {
  name: 'bitbucket-devops',
  version: pkg.version,
  description:
    'Bitbucket Cloud pipelines, pull requests and deployments from Claude Code: check status, analyse failures, download logs, trigger builds. Requires Node.js 18+.',
  author: { name: 'Apra Labs', url: 'https://apralabs.com' },
  homepage: 'https://github.com/Apra-Labs/bitbucket-devops-skill',
  repository: 'https://github.com/Apra-Labs/bitbucket-devops-skill',
  license: pkg.license,
  keywords: ['bitbucket', 'devops', 'pipelines', 'ci-cd', 'pull-requests', 'deployments'],
};
fs.writeFileSync(join(OUT, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');

// 5. No install path may survive in what ships.
for (const file of fs.readdirSync(OUT, { recursive: true })) {
  const full = join(OUT, file);
  if (fs.statSync(full).isFile() && /\.claude[\\/]skills/.test(fs.readFileSync(full, 'utf-8'))) {
    fail(`hardcoded skills path left in dist-plugin/${file}`);
  }
}

console.log(`build:plugin: wrote dist-plugin/ (bitbucket-devops ${pkg.version})`);
