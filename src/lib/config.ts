/**
 * Config loading, path resolution, and the scrubbed environment handed to
 * every phase session.
 *
 * The env-building half of this file is the most safety-critical code in the
 * repo. The Agent SDK's `env` option REPLACES the subprocess environment
 * rather than merging into it, which is precisely what makes it a control: a
 * variable reaches a session only if it is written here. That is how
 * ANTHROPIC_API_KEY is kept out — in headless/SDK mode Claude Code never
 * prompts about a detected key, it silently uses it, and a subscription fleet
 * becomes a metered API bill with no signal that anything changed.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { config as loadDotenv } from 'dotenv';
import { deskUsername } from './identity.js';
import {
  LEGACY_SELECTOR_KEYS, REPO_URL_VAR, SKIP_REPO_CHECK_VAR, expandPath as expandPathFrom, readEnv,
  repoCheckOverride, resolvePath, resolveTarget, scopedEnvName, spellings,
  type GitlabRepo, type ResolvedPath,
} from './repourl.cjs';

export const ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

loadDotenv({ path: join(ROOT, '.env'), quiet: true });

/**
 * Read an env var, accepting the legacy ONELOOP_ spelling for any ONESHOT_
 * name so an existing One Loop .env keeps working. ONESHOT_ wins.
 *
 * The rule itself lives in repourl.cjs, which scripts/app.cjs loads too — so a
 * variable cannot count as set here and unset there.
 */
export function envOr(name: string, fallback = ''): string {
  return readEnv(process.env, name, fallback);
}

export function envFlag(name: string): boolean {
  const v = envOr(name).toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/**
 * Expand a leading `~` and resolve relative paths against the repo root — by
 * the same function scripts/app.cjs uses, so a path in .env means one directory
 * to both.
 */
export function expandPath(p: string): string {
  return expandPathFrom(p, ROOT);
}

// --------------------------------------------------------------- config files

/**
 * config/project.json: everything about the project that GITLAB_REPO_URL does
 * not say. The project itself is never read from here — that is gitlabRepo().
 */
export interface ProjectConfig {
  labels: { entry: string; exit: string; inReview: string; blocked: string };
  preserveLabels: string[];
  branches: { base: string; protected: string[]; prefix: string };
  merge: { mode: 'auto' | 'manual' };
  bugReproduction: boolean;
  hookPack?: string;
  seed: { links: string[]; copies: string[] };
}

let projectCache: ProjectConfig | null = null;
export function projectConfig(): ProjectConfig {
  if (projectCache) return projectCache;
  const raw = JSON.parse(readFileSync(join(ROOT, 'config', 'project.json'), 'utf8')) as Record<string, unknown>;
  const labels = raw.labels as Record<string, string>;
  for (const k of ['entry', 'exit', 'inReview', 'blocked']) {
    if (!labels?.[k]) throw new Error(`config/project.json labels.${k} is required`);
  }
  const branches = raw.branches as Record<string, unknown>;
  const merge = (raw.merge as { mode?: string } | undefined) ?? {};
  const seed = (raw.seed as { links?: string[]; copies?: string[] } | undefined) ?? {};
  projectCache = {
    labels: { entry: labels.entry!, exit: labels.exit!, inReview: labels.inReview!, blocked: labels.blocked! },
    preserveLabels: (raw.preserveLabels as string[] | undefined) ?? [],
    branches: {
      base: String(branches?.base ?? 'dev'),
      protected: (branches?.protected as string[] | undefined) ?? ['dev', 'master', 'main'],
      prefix: String(branches?.prefix ?? 'oneshot'),
    },
    merge: { mode: merge.mode === 'manual' ? 'manual' : 'auto' },
    bugReproduction: raw.bugReproduction !== false,
    hookPack: typeof raw.hookPack === 'string' && raw.hookPack ? raw.hookPack : undefined,
    seed: { links: seed.links ?? [], copies: seed.copies ?? [] },
  };
  return projectCache;
}

export interface RequiredLabel { name: string; why: string }

/** Every label the conductor acts on by name, with what depends on it. Doctor checks each exists. */
export function requiredLabels(cfg: ProjectConfig = projectConfig()): RequiredLabel[] {
  return [
    { name: cfg.labels.entry, why: 'the scan picks up tickets carrying it' },
    { name: cfg.labels.exit, why: 'applied when the MR is merged' },
    { name: cfg.labels.inReview, why: 'applied when the MR is open but not merged' },
    { name: cfg.labels.blocked, why: 'applied when a run stops and needs a person' },
  ];
}

/** project.json `merge.mode`, unless ONESHOT_MERGE says `auto` or `manual`. */
export function mergeMode(): 'auto' | 'manual' {
  const o = envOr('ONESHOT_MERGE', '').trim().toLowerCase();
  if (o === 'auto' || o === 'manual') return o;
  return projectConfig().merge.mode;
}

/**
 * The project and the paths derived from it, resolved once at load by the same
 * function scripts/app.cjs calls (repourl.cjs, resolveTarget). Never throws: a
 * missing or invalid GITLAB_REPO_URL leaves the name empty and is reported when
 * the project is first needed — loudly at boot and in doctor — rather than on
 * import, which tests and tooling do on machines that have not set it.
 */
export type ResolvedTarget = ReturnType<typeof resolveTarget>;
export const TARGET: ResolvedTarget = resolveTarget(process.env, ROOT);

/**
 * The target name: the last path segment of GITLAB_REPO_URL, lower-cased —
 * `erp` for `https://<host>/group/erp`. Empty when the URL is unset or invalid.
 *
 * It names nothing on its own any more; it is the handle the derived defaults
 * (~/Documents/<name>, ~/Documents/<name>-wt) and the scoped path variables are
 * keyed by, and what name-keyed features compare against. ONESHOT_PROJECT used
 * to set it and now only gets checked against it (repocheck.ts identityFindings).
 */
export const PROJECT_TARGET: string = TARGET.name;

/**
 * The project GITLAB_REPO_URL names — the same read, at load, that every path
 * above came from, so one process cannot hold two answers. Throws, naming the
 * variable and an example, when it is unset or not a GitLab project URL; only
 * asking throws, never importing.
 */
export function gitlabRepo(): GitlabRepo {
  if (!TARGET.repo) throw new Error(TARGET.error ?? `${REPO_URL_VAR} is not set`);
  return TARGET.repo;
}

/** gitlabRepo() for a caller that has to decide how loudly to fail. Never throws. */
export function repoIdentity(): { repo: GitlabRepo | null; error: string | null } {
  return { repo: TARGET.repo, error: TARGET.error };
}

// ------------------------------------------------------------------ session

/** The model the ticket session runs on. */
export function sessionModel(): string { return envOr('ONESHOT_MODEL', 'claude-opus-5-5'); }

/** The session's turn cap, wall-clock timeout and idle watchdog; 0 is a value, not unset. */
export function sessionCaps(): { maxTurns: number; timeoutMin: number; idleMin: number } {
  const n = (name: string, d: number): number => { const v = Number(envOr(name, '')); return Number.isFinite(v) && envOr(name, '') !== '' ? v : d; };
  return { maxTurns: n('ONESHOT_MAX_TURNS', 600), timeoutMin: n('ONESHOT_TIMEOUT_MIN', 240), idleMin: n('ONESHOT_IDLE_MIN', 15) };
}

/** The one port the ticket's app runs on; there is no pool. */
export function appPort(): number { return Number(envOr('ONESHOT_PORT', '8000')) || 8000; }

/**
 * The superpowers plugin directory the session loads: ONESHOT_SUPERPOWERS_PATH,
 * else the installPath Claude Code recorded in ~/.claude/plugins/installed_plugins.json,
 * else null (boot refuses). `home` is a parameter only so a test can point it elsewhere.
 */
export function superpowersPath(home: string = homedir()): string | null {
  const fromEnv = envOr('ONESHOT_SUPERPOWERS_PATH', '').trim();
  if (fromEnv) return expandPath(fromEnv);
  const registry = join(home, '.claude', 'plugins', 'installed_plugins.json');
  if (!existsSync(registry)) return null;
  try {
    const reg = JSON.parse(readFileSync(registry, 'utf8')) as { plugins?: Record<string, Array<{ installPath?: string }>> };
    for (const [key, entries] of Object.entries(reg.plugins ?? {})) {
      if (!key.startsWith('superpowers@')) continue;
      const p = entries.find((e) => e.installPath)?.installPath;
      if (p) return p;
    }
  } catch { /* unreadable registry → null */ }
  return null;
}

// ------------------------------------------------------------------ paths

export const DRY_RUN = envFlag('DRY_RUN');

/**
 * The GitLab username this desk claims ASSIGNED tickets as.
 *
 * Not configuration. It is whoever this desk's GitLab token belongs to, resolved
 * once at boot by asking GitLab (src/lib/identity.ts), so the account that claims
 * a ticket is always the account that will comment, push and merge on it. A
 * function rather than a const because a const would be captured at module
 * load, which is before boot has asked.
 */
export function gitlabUsername(): string { return deskUsername(); }

/** The conductor's tick cadence — how often `src/index.ts` scans for claimable tickets. */
export const TICK_MS = 60_000;

/**
 * Where the guard hooks find this checkout: hooks/_common.cjs derives state/,
 * config/ and .env from `$ONESHOT_HOME`. Always ROOT — a dry run shares it.
 */
export const ONESHOT_HOME: string = ROOT;

export const STATE = join(ONESHOT_HOME, 'state');
export const RUNS = join(STATE, 'runs');
/** Where a finished run's whole directory goes when its ticket is run again. */
export const RUNS_ARCHIVE = join(STATE, 'runs-archive');
export const PAUSE = join(STATE, 'PAUSE');
export const PAUSE_QUOTA = join(STATE, 'PAUSE-QUOTA');
export const PAUSE_NETWORK = join(STATE, 'PAUSE-NETWORK');
/** Holds the running conductor's pid, so a second one refuses to start. */
export const PID_FILE = join(STATE, 'conductor.pid');

/**
 * The clone of GITLAB_REPO_URL that per-ticket worktrees are cut from:
 * ONESHOT_<NAME>_WORK_REPO, else WORK_REPO, else ~/Documents/<name>.
 *
 * A plain WORK_REPO wins over the derived default like any other env var, so a
 * line left over from another project WOULD point the conductor at the wrong
 * clone — which is why boot and doctor refuse a WORK_REPO whose origin is not
 * GITLAB_REPO_URL (src/lib/repocheck.ts). That check, not an override rule, is
 * what keeps the URL the single source of truth. '' when nothing supplies a
 * path; boot refuses that too, before any git command could run in the cwd.
 */
export const WORK_REPO = TARGET.workRepo.path;
export const CONTEXT_REPO = expandPath(envOr('CONTEXT_REPO', '~/Documents/erp'));
// Skills, agents and rules are vendored into this repo under `context/` (a
// committed snapshot of the ERP context repo's `.claude`, which also stays in
// GitLab), so the loop is self-contained: a fresh clone carries them and
// claudedir composes `.claude` from links that resolve without a local ERP
// checkout. Override with ONESHOT_SKILLS_ROOT to point at a live `.claude`
// (e.g. `~/Documents/erp/.claude`) when a machine's interactive edits should
// win over the vendored copy.
export const SKILLS_ROOT = expandPath(envOr('ONESHOT_SKILLS_ROOT', join(ROOT, 'context')));
/**
 * Where leased worktrees live: ONESHOT_<NAME>_WT_ROOT, else WT_ROOT, else
 * ~/Documents/<name>-wt. Per project by default because worktrees are named by
 * ticket iid, so one root shared by two projects would collide issue 100 with
 * issue 100.
 */
export const WT_ROOT = TARGET.wtRoot.path;

function seedPath(): ResolvedPath {
  return resolvePath(process.env, {
    name: PROJECT_TARGET, envName: 'ONESHOT_SEED_FROM', fallback: '', root: ROOT,
  });
}

/**
 * The installed clone a leased worktree borrows node_modules, venv and
 * staticfiles from. Empty means seeding is switched off, which costs `npm ci`
 * minutes per worktree — so it stays a function with no default rather than
 * quietly becoming WORK_REPO.
 */
export function seedFrom(): string {
  return seedPath().path;
}

function csv(name: string, fallback: string[]): string[] {
  const v = envOr(name, '').trim();
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : fallback;
}

/**
 * What a worktree symlinks and copies from the seed: ONESHOT_SEED_LINKS /
 * ONESHOT_SEED_COPIES, else project.json `seed`. The one place the defaults
 * live — the session gets the resolved lists through projectSessionEnv().
 */
export function seedLinks(): string[] { return csv('ONESHOT_SEED_LINKS', projectConfig().seed.links); }
export function seedCopies(): string[] { return csv('ONESHOT_SEED_COPIES', projectConfig().seed.copies); }

/**
 * Which variable supplied each project path — the scoped ONESHOT_<NAME>_<VAR>,
 * the plain one, or the default derived from GITLAB_REPO_URL — for doctor to
 * say, since a path nobody can trace to a line in .env is a path nobody fixes.
 */
export function pathSources(): Record<'WORK_REPO' | 'WT_ROOT' | 'ONESHOT_SEED_FROM', ResolvedPath> {
  return { WORK_REPO: TARGET.workRepo, WT_ROOT: TARGET.wtRoot, ONESHOT_SEED_FROM: seedPath() };
}

/**
 * The project, and the paths the conductor resolved for it, as a session's
 * environment — merged over BASE_ENV by the session runner.
 *
 * A session's environment is an allowlist, and scripts/app.cjs inside one has
 * no conductor to inherit from: it loads ONESHOT_HOME/.env and resolves the
 * project again. Resolving is shared (repourl.cjs), but the INPUTS were not —
 * a GITLAB_REPO_URL exported in the shell, or a WORK_REPO that differs from
 * .env, reached the conductor and not the session, so the session's
 * `app.cjs ensure` could refuse with "GITLAB_REPO_URL is not set", or seed and
 * check out another project's clone. Handing over the resolved values makes the
 * session resolve exactly what the conductor did.
 *
 * Every other spelling that could outrank them — the scoped
 * ONESHOT_<NAME>_<VAR>, the ONELOOP_ forms, the legacy selectors the conductor
 * has already judged — is set to '' rather than left out: dotenv only fills a
 * key that is ABSENT, and repourl.cjs reads '' as unset. The seed is the one
 * app.cjs would resolve itself — the conductor's, else WORK_REPO — and the seed
 * lists are the resolved seedLinks()/seedCopies(), so app.cjs reads env only.
 *
 * ONESHOT_SKIP_REPO_CHECK is handed over the same way: '1' when the conductor
 * booted with it on, '' otherwise, both spellings. Exported only in the shell
 * it would otherwise let boot through while every session's `app.cjs ensure`
 * refused the same origin — and a line in ONESHOT_HOME/.env may not switch it
 * on or off behind the conductor's back.
 */
export function projectSessionEnv(): Record<string, string> {
  const { repo } = repoIdentity();
  if (!repo) return {};
  const env: Record<string, string> = {
    [REPO_URL_VAR]: repo.url,
    WORK_REPO,
    WT_ROOT,
    ONESHOT_SEED_FROM: seedFrom() || WORK_REPO,
    ONELOOP_SEED_FROM: '',
    ONESHOT_SEED_LINKS: seedLinks().join(','),
    ONESHOT_SEED_COPIES: seedCopies().join(','),
  };
  for (const v of ['WORK_REPO', 'WT_ROOT', 'ONESHOT_SEED_FROM']) {
    const scoped = scopedEnvName(PROJECT_TARGET, v);
    if (scoped) for (const k of spellings(scoped)) env[k] = '';
  }
  for (const k of LEGACY_SELECTOR_KEYS) env[k] = '';
  for (const k of spellings(SKIP_REPO_CHECK_VAR)) env[k] = '';
  if (repoCheckOverride(process.env)) env[SKIP_REPO_CHECK_VAR] = '1';
  return env;
}

export function runDir(iid: number): string { return join(RUNS, String(iid)); }
export function artifactDir(iid: number): string { return join(runDir(iid), 'artifacts'); }
export function transcriptDir(iid: number): string { return join(runDir(iid), 'transcripts'); }

// -------------------------------------------------------------- session env

/**
 * Credential variables that must NEVER reach a session.
 *
 * Deleted, not blanked: an EMPTY ANTHROPIC_API_KEY still occupies its slot in
 * Claude Code's credential precedence and still outranks subscription OAuth.
 */
const AUTH_VARS_NEVER_FORWARDED = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

/**
 * The subset whose mere presence is a billing risk.
 *
 * ANTHROPIC_BASE_URL is deliberately NOT here. Claude Code sets it to the
 * canonical endpoint for its own process, so treating any value as a problem
 * fires on a completely healthy machine. It only matters when it points
 * somewhere other than Anthropic — that is a proxy, and worth saying so.
 */
const CREDENTIAL_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

const CANONICAL_API_HOSTS = ['api.anthropic.com'];

/**
 * Identity variables the OAuth keychain lookup needs. Not secrets — without
 * them the macOS keychain cannot resolve the login and a subscription session
 * fails to authenticate at all.
 */
const IDENTITY_VARS = ['USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'XDG_RUNTIME_DIR'] as const;

function defaultSessionPath(): string {
  const parts = (process.env.PATH ?? '').split(':').filter(Boolean);
  const nodeDir = dirname(process.execPath);
  if (nodeDir && !parts.includes(nodeDir)) parts.unshift(nodeDir);
  for (const fallback of ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']) {
    if (!parts.includes(fallback)) parts.push(fallback);
  }
  return parts.join(':');
}

function buildBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: envOr('ONESHOT_SESSION_PATH', defaultSessionPath()),
    HOME: process.env.HOME ?? homedir(),
    LANG: 'en_US.UTF-8',
    ONESHOT_HOME,
  };

  // Committer identity travels in the environment rather than in a config file.
  // `git config user.name` inside a worktree writes the SHARED .git/config, so
  // several worktrees being created at once contend for one lock and most of
  // them lose. Nothing needs a file: git reads these four variables directly,
  // they are per-session by construction, and a worktree that is deleted takes
  // no configuration with it.
  const gitAuthor = envOr('ONESHOT_GIT_AUTHOR_NAME', 'Oneshot');
  const gitEmail = envOr('ONESHOT_GIT_AUTHOR_EMAIL');
  env.GIT_AUTHOR_NAME = gitAuthor;
  env.GIT_COMMITTER_NAME = gitAuthor;
  if (gitEmail) {
    env.GIT_AUTHOR_EMAIL = gitEmail;
    env.GIT_COMMITTER_EMAIL = gitEmail;
  }

  for (const v of IDENTITY_VARS) {
    const val = process.env[v];
    if (typeof val === 'string' && val !== '') env[v] = val;
  }

  // The 1M context window consumes purchased usage credits even when
  // subscription allowance remains — that is a real charge, unlike everything
  // else here.
  if (!envFlag('ONESHOT_ALLOW_1M_CONTEXT')) env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1';

  // Only for a headless box with no interactive login. Subscription credential.
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof oauth === 'string' && oauth.trim() !== '') env.CLAUDE_CODE_OAUTH_TOKEN = oauth;

  for (const v of AUTH_VARS_NEVER_FORWARDED) delete env[v];
  return env;
}

/**
 * The auth-and-identity half of the session environment. The session runner
 * composes the rest over it — `{ ...BASE_ENV, ...projectSessionEnv(), ...identity }` —
 * which keeps this constant about one thing: keeping metered-billing
 * credentials out of sessions.
 */
export const BASE_ENV: Record<string, string> = buildBaseEnv();

export interface AuthReport {
  clean: boolean;
  credential: string;
  /** Would bill to an API key. Fails `doctor`. */
  problems: string[];
  /** Worth knowing, not a billing risk. Warns only. */
  notes: string[];
}

/**
 * Report which credential a session will actually use.
 *
 * Reports variable NAMES only, never values. `apiKeyHelper` is a NOTE rather
 * than a problem: the ticket session loads `settingSources: ['project']` only
 * (src/ticket/session.ts), so a helper configured at user level never runs for
 * it. It is still worth saying, because it does run for the operator's own
 * interactive sessions on the same machine — the thing this audit is really
 * about is nobody discovering a metered bill by accident.
 */
export function auditAuth(): AuthReport {
  const problems: string[] = [];
  const notes: string[] = [];

  for (const v of CREDENTIAL_VARS) {
    if (typeof process.env[v] === 'string' && process.env[v] !== '') {
      problems.push(
        `${v} is set in this shell. It is stripped from session env, so Oneshot is ` +
        'unaffected, but an interactive session on this machine may be billing to an API key.',
      );
    }
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (baseUrl) {
    try {
      const host = new URL(baseUrl).hostname;
      if (!CANONICAL_API_HOSTS.includes(host)) {
        notes.push(
          `ANTHROPIC_BASE_URL points at ${host}, not Anthropic. Sessions are routed ` +
          'through a proxy. It is stripped from session env, so Oneshot goes direct.',
        );
      }
    } catch {
      notes.push(`ANTHROPIC_BASE_URL is set but unparseable: ${baseUrl}`);
    }
  }

  const settingsPath = join(homedir(), '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, 'utf8')) as { apiKeyHelper?: unknown };
      if (s.apiKeyHelper) {
        notes.push(
          'apiKeyHelper is configured in ~/.claude/settings.json. Phase sessions load ' +
          'project settings only, so it does NOT run for them — but it does run for ' +
          'interactive sessions here, and its key outranks subscription OAuth.',
        );
      }
    } catch { /* unreadable settings is not an auth problem */ }
  }

  const credential = BASE_ENV.CLAUDE_CODE_OAUTH_TOKEN
    ? 'CLAUDE_CODE_OAUTH_TOKEN (subscription)'
    : 'keychain OAuth from `claude login` (subscription)';

  return { clean: problems.length === 0, credential, problems, notes };
}
