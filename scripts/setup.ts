/**
 * `npm run setup` — interactive first-run wizard.
 *
 * `npm start` calls this automatically when there is no .env, so a fresh clone
 * is `npm install && npm start` and nothing else. Four questions:
 *
 *   GITLAB_REPO_URL     no default — the one fact the machine cannot guess; the
 *                       prompt repeats until it gets a valid URL
 *   GITLAB_TOKEN        defaults to the one ~/.claude.json already holds
 *   WORK_REPO           defaults to an existing clone, else ~/Documents/<name>
 *   ONESHOT_TEST_LOGIN  Enter to skip
 *
 * Everything else derives from the URL (WT_ROOT) or has a default in
 * .env.example and config/project.json. The answer for WORK_REPO is checked:
 * that it exists, and that its origin is the project the URL names.
 *
 * Secrets are written to .env at mode 600 and never echoed back. A reconfigure
 * copies the .env it started from to .env.bak-<timestamp> (also mode 600)
 * before writing, so a wrong answer costs nothing that cannot be copied back.
 */
import { createInterface } from 'node:readline/promises';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { backupFile, legacyLines, pinPath, readKey, removeLegacySelectors, setKey } from '../src/lib/envfile.js';
import { originFinding } from '../src/lib/repocheck.js';
import { EXAMPLE_URL, defaultWorkRepo, defaultWtRoot, expandPath, parseRepoUrl, type GitlabRepo } from '../src/lib/repourl.cjs';

const ROOT = join(import.meta.dirname, '..');
const ENV = join(ROOT, '.env');
const EXAMPLE = join(ROOT, '.env.example');

const G = '\x1b[32m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function ask(label: string, opts: { default?: string; secret?: boolean; hint?: string } = {}) {
  const def = opts.default ? ` ${D}[${opts.secret ? '••••' : opts.default}]${X}` : '';
  if (opts.hint) console.log(`  ${D}${opts.hint}${X}`);
  const answer = (await rl.question(`  ${label}${def}: `)).trim();
  return answer || opts.default || '';
}

/** Reuse a credential the machine already has rather than making them paste it again. */
function existingGitlabToken(): string {
  try {
    const d = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as Record<string, any>;
    const t = d?.mcpServers?.gitlab?.env?.GITLAB_PERSONAL_ACCESS_TOKEN;
    return typeof t === 'string' ? t : '';
  } catch { return ''; }
}

function detectRepo(name: string): string {
  for (const base of [join(homedir(), 'Documents'), homedir()]) {
    const p = join(base, name);
    if (existsSync(join(p, '.git'))) return p;
  }
  return '';
}

async function main(): Promise<void> {
  console.log(`\n${B}Oneshot Solo setup${X}\n`);

  const reconfigure = existsSync(ENV);
  if (reconfigure) {
    const overwrite = await ask('.env already exists. Reconfigure it? (y/N)', { default: 'N' });
    if (!/^y/i.test(overwrite)) { console.log('  Keeping it.\n'); rl.close(); return; }
  }
  let body = readFileSync(reconfigure ? ENV : EXAMPLE, 'utf8');

  console.log(`${B}GitLab${X}`);
  // First, because everything else is derived from it: the API, the token page,
  // and the default location of the clone asked for below.
  let repo: GitlabRepo | null = null;
  while (!repo) {
    const url = await ask('GITLAB_REPO_URL', {
      hint: `The project Oneshot works on, as its web or clone URL — e.g. ${EXAMPLE_URL}`,
    });
    try {
      repo = parseRepoUrl(url);
    } catch (err) {
      console.log(`  ${Y}${(err as Error).message}${X}`);
    }
  }
  body = setKey(body, 'GITLAB_REPO_URL', repo.url);

  // A reconfigure keeps the old .env, so the lines that used to select the
  // project may still be in it. They select nothing now, and one that
  // disagrees with the URL just given refuses boot.
  const legacy = legacyLines(body);
  if (legacy.length) {
    console.log(`  ${Y}${legacy.join(', ')} ${legacy.length === 1 ? 'is' : 'are'} left from before GITLAB_REPO_URL `
      + `and select${legacy.length === 1 ? 's' : ''} nothing now.${X}`);
    const drop = await ask('Remove them from .env? (Y/n)', { default: 'Y' });
    if (/^y/i.test(drop)) body = removeLegacySelectors(body);
  }

  const found = existingGitlabToken();
  if (found) console.log(`  ${G}Found a GitLab token in ~/.claude.json — press Enter to reuse it.${X}`);
  const glToken = await ask('GITLAB_TOKEN', {
    default: found, secret: true,
    hint: found ? '' : 'Personal access token, scope api — or Enter, then `npm run token:set` to keep it outside the repo.',
  });
  body = setKey(body, 'GITLAB_TOKEN', glToken);

  console.log(`\n${B}Your clone${X}`);
  const derived = defaultWorkRepo(repo.name);
  const work = await ask('WORK_REPO', {
    default: detectRepo(repo.name) || derived,
    hint: `Your clone of ${repo.project}. Worktrees are cut from it and seeded from it; its origin must be that project.`,
  });
  // Pinned only when the answer differs from what GITLAB_REPO_URL derives, and
  // an old line REMOVED when it does not: a reconfigure starts from the
  // existing .env, where a WORK_REPO from the previous project would otherwise
  // outrank the answer just given.
  body = pinPath(body, { envName: 'WORK_REPO', name: repo.name, answer: work, derived, root: ROOT });
  const workDir = expandPath(work, ROOT);
  if (!existsSync(workDir)) {
    console.log(`  ${Y}${workDir} does not exist yet — clone it before \`npm start\`:  git clone <clone url> ${workDir}${X}`);
  } else {
    const judged = originFinding('WORK_REPO', workDir, { GITLAB_REPO_URL: repo.url });
    if (judged && judged.level !== 'pass') console.log(`  ${Y}${judged.label}: ${judged.detail}${X}`);
    else console.log(`  ${G}${workDir} is a clone of ${repo.project}.${X}`);
  }

  // Not asked: worktrees go to ~/Documents/<name>-wt, one directory per project
  // since they are named by ticket iid. A WT_ROOT line left from another
  // project would outrank that, so a reconfigure removes it.
  const derivedWt = defaultWtRoot(repo.name);
  const oldWt = readKey(body, 'WT_ROOT');
  body = pinPath(body, { envName: 'WT_ROOT', name: repo.name, answer: derivedWt, derived: derivedWt, root: ROOT });
  if (oldWt && expandPath(oldWt, ROOT) !== expandPath(derivedWt, ROOT)) {
    console.log(`  ${D}WT_ROOT=${oldWt} removed — worktrees go to ${derivedWt}, derived from the URL.${X}`);
  }

  console.log(`\n${B}Browser verification${X} ${D}(optional — Enter to skip)${X}`);
  const login = await ask('ONESHOT_TEST_LOGIN', {
    default: readKey(body, 'ONESHOT_TEST_LOGIN') ?? '', secret: true,
    hint: 'email:password of the managed test account the session logs in with.',
  });
  body = setKey(body, 'ONESHOT_TEST_LOGIN', login);

  // Written once, at the end: a wizard abandoned half-way leaves no .env, so
  // the next `npm start` asks again instead of booting on a template.
  const backup = reconfigure ? backupFile(ENV) : '';
  writeFileSync(ENV, body, { mode: 0o600 });
  chmodSync(ENV, 0o600);
  console.log(`\n${G}Wrote .env (mode 600, gitignored).${X}`);
  if (backup) console.log(`  ${D}The previous .env is saved as ${backup} (mode 600) — delete it once this one works.${X}`);

  rl.close();
  console.log(`\n${G}Done.${X} Next: ${B}npm run doctor${X} to check everything, then ${B}npm start${X}.\n`);
}

main().catch((err) => {
  rl.close();
  console.error(`\nsetup failed: ${(err as Error).message}\n`);
  process.exit(1);
});
