/**
 * `npm run doctor [-- --no-probe]` — everything that must be true before a real ticket runs.
 *
 * Checks are ordered cheapest-first and each is independent, so a failure
 * early does not hide the rest. Exit 1 on any FAIL; WARN never fails the run.
 *
 * The last section is the decisive one: a real one-turn session, spawned from
 * the same queryOptions() a run uses, whose init frame must list the
 * superpowers plugin and whose SessionStart hook must inject its intro. It
 * spends one turn on the operator's subscription; `--no-probe` skips it.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { accessSync, constants, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import {
  BASE_ENV, ROOT, STATE, WORK_REPO, WT_ROOT, auditAuth, envOr, mergeMode, pathSources, projectConfig,
  repoIdentity, requiredLabels, runDir, seedCopies, seedFrom, seedLinks, sessionCaps, sessionModel, superpowersPath,
  type ProjectConfig,
} from '../src/lib/config.js';
import { ping, getBranch, listLabels } from '../src/lib/gitlab.js';
import {
  checkoutFindings, identityFindings, relaxRepoChecks, repoCheckOverrideNotice, type Finding,
} from '../src/lib/repocheck.js';
import { checkIdentity, claudeAccountEmail } from '../src/lib/identity.js';
import { envDrift } from '../src/lib/envdrift.js';
import { resolveToken, setupHint } from '../src/lib/token.js';
import { packManifest } from '../src/ticket/hooks.js';
import { queryOptions, sessionEnv, type SessionInput } from '../src/ticket/session.js';
import { atLeast, probeGitlabMcp, sdkInfo } from './verify-deps.js';

let fails = 0;
let warns = 0;

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m';

function pass(label: string, detail = ''): void {
  console.log(`  ${G}PASS${X}  ${label}${detail ? ` ${D}${detail}${X}` : ''}`);
}
function warn(label: string, detail = ''): void {
  warns += 1;
  console.log(`  ${Y}WARN${X}  ${label}${detail ? ` ${D}${detail}${X}` : ''}`);
}
function fail(label: string, detail = ''): void {
  fails += 1;
  console.log(`  ${R}FAIL${X}  ${label}${detail ? ` ${D}${detail}${X}` : ''}`);
}
function section(name: string): void { console.log(`\n${name}`); }
function report(f: Finding): void {
  if (f.level === 'fail') fail(f.label, f.detail);
  else if (f.level === 'warn') warn(f.label, f.detail);
  else pass(f.label, f.detail);
}

/** What the superpowers SessionStart hook injects, and what ONESHOT_SUPERPOWERS_INJECT appends instead. */
const INTRO_MARK = 'You have superpowers';

/**
 * What the probe session's frames say about the plugin.
 *
 * `hookFired` is read off the SessionStart `hook_response` frames when the CLI
 * emits any (SDK 0.3.x always emits them for SessionStart): one of them must
 * carry the intro, because a SessionStart response from a pack hook proves
 * nothing about superpowers. A CLI that emits none falls back to the intro
 * appearing in any frame at all.
 */
export function probeVerdict(frames: unknown[]): { pluginLoaded: boolean; skillsNamespaced: boolean; hookFired: boolean; cliVersion: string | null } {
  const sp = superpowersPath() ?? '';
  let pluginLoaded = false, skillsNamespaced = false, cliVersion: string | null = null;
  let sessionStartResponses = 0, introInResponse = false, introAnywhere = false;
  for (const f of frames as Array<Record<string, unknown>>) {
    if (!f || typeof f !== 'object') continue;
    if (f.type === 'system' && f.subtype === 'init') {
      const plugins = (f.plugins as Array<{ path?: string; name?: string }> | undefined) ?? [];
      pluginLoaded = plugins.some((p) => (sp && p.path === sp) || p.name === 'superpowers');
      skillsNamespaced = ((f.skills as string[] | undefined) ?? []).some((s) => s.startsWith('superpowers:'));
      cliVersion = typeof f.claude_code_version === 'string' ? f.claude_code_version : cliVersion;
    }
    if (f.type === 'system' && f.subtype === 'hook_response' && f.hook_event === 'SessionStart') {
      sessionStartResponses += 1;
      if (`${f.output ?? ''}${f.stdout ?? ''}`.includes(INTRO_MARK)) introInResponse = true;
    }
    if (JSON.stringify(f).includes(INTRO_MARK)) introAnywhere = true;
  }
  return { pluginLoaded, skillsNamespaced, hookFired: sessionStartResponses ? introInResponse : introAnywhere, cliVersion };
}

/** The synthetic run the probe and the env assertions use. iid 0 is never a real ticket. */
function probeInput(): SessionInput {
  return {
    iid: 0, runId: 'r-doctor-probe', lap: 0, worktree: ROOT, branch: 'oneshot/ticket-0-probe', port: 0, previousAttempt: false,
    ticket: { iid: 0, title: 'doctor probe', description: null, labels: [], notes: [], documents: [], externalDocs: [] },
  };
}

/** Long enough for a cold plugin load and the MCP spawn; a probe that is still silent after this is wedged. */
const PROBE_TIMEOUT_MS = 180_000;

/**
 * One real session with a run's own options, minus the result schema, capped
 * at one turn and run in this checkout. Never throws: an error comes back with
 * whatever frames and stderr arrived first.
 */
async function runProbe(): Promise<{ frames: unknown[]; stderr: string; error?: string }> {
  const input = probeInput();
  const abortController = new AbortController();
  const frames: unknown[] = [];
  let stderr = '';
  // The MCP shim makes state/runs/0/artifacts its cwd; leave no run dir behind.
  const scratch = runDir(0);
  const existed = existsSync(scratch);
  const killer = setTimeout(() => abortController.abort(), PROBE_TIMEOUT_MS);
  try {
    const { outputFormat: _schema, ...options } = queryOptions(input, {
      env: sessionEnv(input), abortController, stderr: (t: string) => { stderr = (stderr + t).slice(-2000); },
    });
    const q = query({ prompt: 'Reply with the single word ok.', options: { ...options, maxTurns: 1, cwd: ROOT } });
    for await (const m of q) frames.push(m);
    return { frames, stderr };
  } catch (err) {
    const why = abortController.signal.aborted ? `no result within ${PROBE_TIMEOUT_MS / 60_000}m` : (err as Error).message;
    return { frames, stderr, error: why };
  } finally {
    clearTimeout(killer);
    if (!existed) rmSync(scratch, { recursive: true, force: true });
  }
}

/** The existing directory a path would be created under, when it is writable; null otherwise. */
function writableAncestor(dir: string): string | null {
  let d = dir;
  while (!existsSync(d)) {
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  try { accessSync(d, constants.W_OK); return d; } catch { return null; }
}

/**
 * The core guards src/ticket/hooks.ts registers, read from its source: that
 * list is the one that runs, so a second copy here could only go stale.
 */
function coreGuards(): string[] {
  const src = readFileSync(join(ROOT, 'src', 'ticket', 'hooks.ts'), 'utf8');
  return [...new Set([...src.matchAll(/core\('([\w-]+\.cjs)'\)/g)].map((m) => m[1]!))];
}

async function main(): Promise<void> {
  const noProbe = process.argv.includes('--no-probe');
  console.log('\nOneshot Solo doctor');

  // ------------------------------------------------------------------ auth
  section('Claude auth');
  const auth = auditAuth();
  if (auth.clean) pass('no metered-billing credential in this shell', auth.credential);
  else for (const p of auth.problems) fail('auth', p);
  for (const n of auth.notes) warn('auth', n);
  if (BASE_ENV.CLAUDE_CODE_OAUTH_TOKEN) {
    pass('signed in', 'CLAUDE_CODE_OAUTH_TOKEN (headless subscription token)');
  } else {
    const email = claudeAccountEmail();
    if (email) pass('signed in to Claude', email);
    else fail('not signed in to Claude', 'no oauthAccount in ~/.claude.json — run `claude login`');
  }

  // --------------------------------------------------------------- config
  section('Config');
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) {
    warn('no .env', 'run `npm run setup`');
  } else {
    const d = envDrift(readFileSync(envFile, 'utf8'), readFileSync(join(ROOT, '.env.example'), 'utf8'));
    if (d.stale.length) warn('.env sets retired keys', `${d.stale.join(', ')} — Solo reads none of them; delete those lines`);
    if (d.placeholders.length) warn('.env still holds placeholders', d.placeholders.map((p) => p.key).join(', '));
    if (!d.stale.length && !d.placeholders.length) {
      pass('.env against .env.example', d.missing.length
        ? `${d.missing.length} optional key(s) unset, defaults apply: ${d.missing.map((m) => m.key).join(', ')}`
        : 'every template key present');
    }
  }

  let cfg: ProjectConfig | null = null;
  try {
    cfg = projectConfig();
    pass('config/project.json', `labels "${cfg.labels.entry}" in -> "${cfg.labels.exit}" / "${cfg.labels.inReview}" / `
      + `"${cfg.labels.blocked}"; base ${cfg.branches.base}; hook pack ${cfg.hookPack ?? 'none'}`);
    const mode = mergeMode();
    pass(`merge ${mode}`, mode === 'auto'
      ? 'the conductor merges when the gate passes (`Loop` is the consent)'
      : 'runs stop at the MR, labelled "' + cfg.labels.inReview + '"');
  } catch (err) {
    fail('config/project.json does not load', (err as Error).message);
  }

  const caps = sessionCaps();
  pass('session', `model ${sessionModel()}, ${caps.maxTurns} turns, ${caps.timeoutMin}m timeout, ${caps.idleMin}m idle watchdog`);
  if (caps.maxTurns < 1 || caps.timeoutMin <= 0) fail('session caps cannot run a session', 'ONESHOT_MAX_TURNS and ONESHOT_TIMEOUT_MIN must be positive');
  if (caps.idleMin <= 0) warn('idle watchdog off', 'ONESHOT_IDLE_MIN=0 — a silent stream runs out the whole timeout');

  pass('state', STATE);
  if (envOr('ONESHOT_STATE_DIR')) {
    warn('ONESHOT_STATE_DIR is set', 'a test-only override: the guard hooks (hooks/_common.cjs) still read '
      + `${join(ROOT, 'state')}, so a PAUSE file under ${STATE} would not brake a session — unset it`);
  }

  // Each path says which variable put it there: a surprising directory is only
  // fixable if the line that chose it is named.
  const sources = pathSources();
  const origin = (name: keyof typeof sources): string => {
    const src = sources[name];
    if (src.source === 'scoped') return `from ${src.key} — the per-project spelling, still honoured`;
    if (src.source === 'plain') return `from ${src.key}`;
    return 'derived from GITLAB_REPO_URL';
  };
  // A path that did not resolve is failed under Paths, not printed here.
  if (WT_ROOT) pass('worktrees', `${WT_ROOT} (${origin('WT_ROOT')})`);
  const seed = seedFrom() || WORK_REPO;
  if (seed) pass('seed', `${seed} (${seedFrom() ? origin('ONESHOT_SEED_FROM') : 'WORK_REPO; ONESHOT_SEED_FROM unset'})`);

  // ---------------------------------------------------------------- paths
  section('Paths');
  // ONESHOT_SKIP_REPO_CHECK turns every repo-check FAIL below into a WARN;
  // said on every run, so the override cannot quietly outlive the problem.
  const override = repoCheckOverrideNotice();
  if (override) warn('repo checks overridden', override);
  for (const f of relaxRepoChecks(identityFindings())) report(f);
  const repo = repoIdentity().repo;

  if (!WORK_REPO) fail('WORK_REPO', 'no path — set GITLAB_REPO_URL (default ~/Documents/<name>) or WORK_REPO');
  else if (existsSync(WORK_REPO)) pass('WORK_REPO', `${WORK_REPO} (${origin('WORK_REPO')})`);
  else fail('WORK_REPO', `${WORK_REPO} does not exist — clone the project there, or set WORK_REPO`);

  // A clone of some other project would cut every worktree from the wrong code
  // while tickets and MRs went to the right one. The same call boot makes.
  if (repo) for (const f of relaxRepoChecks(checkoutFindings({ workRepo: WORK_REPO, seed: seedFrom(), sources }))) report(f);

  if (!WT_ROOT) {
    fail('WT_ROOT', 'no path — set GITLAB_REPO_URL (default ~/Documents/<name>-wt) or WT_ROOT');
  } else if (existsSync(WT_ROOT)) {
    if (!statSync(WT_ROOT).isDirectory()) fail('WT_ROOT is not a directory', WT_ROOT);
    else if (writableAncestor(WT_ROOT) !== WT_ROOT) fail('WT_ROOT is not writable', WT_ROOT);
    else pass('WT_ROOT writable', WT_ROOT);
  } else {
    const under = writableAncestor(WT_ROOT);
    if (under) pass('WT_ROOT will be created on first run', `${WT_ROOT} (under ${under})`);
    else fail('WT_ROOT cannot be created', `${WT_ROOT} — no writable parent directory`);
  }

  // Read when a worktree is leased, not at boot: an absent entry is silent
  // until the app will not start mid-session. This pulls it forward.
  if (!seed || !existsSync(seed)) {
    warn('no seed repo', `${seed || '(no path)'} — a leased worktree gets no node_modules/venv, so the app cannot run in it`);
  } else if (cfg) {
    const links = seedLinks();
    const copies = seedCopies();
    const missing = [...links, ...copies].filter((rel) => !existsSync(join(seed, rel)));
    if (missing.length) warn('seed entries missing from the seed repo', `${missing.join(', ')} under ${seed} — every worktree will lack them`);
    else pass('seed entries present', `${links.length} linked, ${copies.length} copied from ${seed}`);
  }

  // --------------------------------------------------------------- gitlab
  section('GitLab');
  const token = resolveToken();
  if (!token.token) {
    fail('no GitLab token for this desk', setupHint().split('\n')[0]);
  } else if (!repo || !cfg) {
    warn('GitLab not checked', 'there is no project to ask about until GITLAB_REPO_URL and config/project.json load (above)');
  } else {
    const p = await ping();
    if (p.ok) {
      pass('reachable + authenticated', `${repo.project}, project id ${p.data?.id}`);

      // Who is this desk? The token answers, and the token also does the work,
      // so there is no second fact that can disagree with it.
      const idc = await checkIdentity();
      if (!idc.token) {
        fail('this desk has no usable GitLab token', 'every ASSIGNED ticket is skipped — run `npm run token:set`');
      } else if (idc.token.source.shared && idc.claudeUsername !== idc.token.username && !idc.token.bot) {
        fail(`acting as ${idc.token.username}, but this desk is signed in as ${idc.claudeUsername ?? 'nobody'}`,
          'that is somebody else\'s credential doing your work — run `npm run token:set`');
      } else if (idc.token.source.shared) {
        pass('acts as itself', `${idc.token.username}, token from .env`);
        warn('token lives in .env', '.env has leaked into a run transcript before — `npm run token:set` moves it outside the repo');
      } else if (idc.token.bot) {
        pass('acts as a bot', `${idc.token.username} — cannot be mistaken for a reviewer`);
      } else {
        pass('acts as itself', `${idc.token.username}, token from ${idc.token.source.where}`);
      }
      if (idc.warning && !idc.token?.source.shared) warn('identity', idc.warning.split('\n')[0] ?? '');

      // Each branch is fetched by name: a listing returns one page of 100, and
      // a project with more branches than that hides the base off the page.
      const wanted = [...new Set([cfg.branches.base, ...cfg.branches.protected])];
      const branch = new Map(await Promise.all(wanted.map(async (n) => [n, await getBranch(n)] as const)));
      const base = branch.get(cfg.branches.base);
      if (base?.ok && base.data) pass('base branch exists', cfg.branches.base);
      else if (base?.status === 404) fail('base branch missing', cfg.branches.base);
      else warn('base branch not checked', base?.error ?? `HTTP ${base?.status ?? '?'}`);
      for (const prot of cfg.branches.protected) {
        const found = branch.get(prot);
        if (found?.status === 404) { warn(`protected branch '${prot}' not found`, 'listed in config but absent'); continue; }
        if (!found?.ok || !found.data) { warn(`protected branch '${prot}' not checked`, found?.error ?? `HTTP ${found?.status ?? '?'}`); continue; }
        if (!found.data.protected) fail(`'${prot}' is NOT protected on GitLab`, 'server-side protection is the real guarantee');
        else pass(`'${prot}' protected`);
      }

      // Every label the conductor acts on is matched by NAME, and nothing
      // raises when a name does not match: a swap writes a label the board
      // never shows. A configured label absent from the project is a typo no
      // run will ever report. Asked for by name: one unfiltered page of 100
      // does not reach every label of a project that defines hundreds.
      const needed = requiredLabels(cfg);
      const found = await Promise.all(needed.map(async (l) => [l, await listLabels(l.name)] as const));
      const unverified = found.filter(([, r]) => !r.ok || !r.data);
      const absent = found.filter(([l, r]) => r.ok && r.data && !r.data.some((d) => d.name === l.name)).map(([l]) => l);
      for (const [l, r] of unverified) warn(`label '${l.name}' not verified`, `could not list project labels (${r.kind} HTTP ${r.status})`);
      if (!absent.length && !unverified.length) pass('every configured label exists on the project', needed.map((l) => l.name).join(', '));
      for (const { name, why } of absent) {
        fail(`label '${name}' does not exist on the project`, `${why} — it will never match, and nothing will say so`);
      }
    } else if (p.kind === 'auth') {
      fail('GitLab refused the token', `HTTP ${p.status} — needs scope 'api'`);
    } else if (p.kind === 'network') {
      fail('GitLab unreachable', 'VPN down? that subnet is FortiClient-gated');
    } else {
      fail('GitLab error', `${p.kind} HTTP ${p.status}`);
    }
  }

  // ---------------------------------------------------------------- hooks
  section('Guardrails');
  // Guards are passed to the SDK in-process (src/ticket/hooks.ts): nothing to
  // install, nothing in settings.json to check. What matters is that the .cjs
  // files exist and still enforce what they claim to.
  const core = coreGuards();
  const missingCore = ['_common.cjs', ...core].filter((g) => !existsSync(join(ROOT, 'hooks', g)));
  if (!core.length) fail('no core guard registrations found', 'src/ticket/hooks.ts');
  else if (missingCore.length) fail('core guard scripts missing', missingCore.join(', '));
  else pass(`${core.length} core guards present`, core.map((g) => g.replace(/\.cjs$/, '')).join(', '));

  const pack = cfg?.hookPack;
  if (!pack) {
    pass('no hook pack', 'config/project.json hookPack is unset — core guards only');
  } else {
    try {
      const hooks = packManifest(pack);
      const absent = hooks.filter((h) => !existsSync(join(ROOT, 'hooks', 'packs', pack, h.script))).map((h) => h.script);
      if (absent.length) fail(`hook pack '${pack}' names missing scripts`, absent.join(', '));
      else pass(`hook pack '${pack}'`, `${hooks.length} hooks, every script present`);
    } catch (err) {
      fail(`hook pack '${pack}' does not load`, (err as Error).message);
    }
  }

  const verify = spawnSync('bash', [join(ROOT, 'scripts', 'verify-hooks.sh')], { encoding: 'utf8', cwd: ROOT });
  const last = (verify.stdout ?? '').trim().split('\n').pop()?.replace(/\x1b\[[0-9;]*m/g, '') ?? '';
  if (verify.status === 0) pass('guard test suite', last);
  else fail('guard test suite failed', `${last} — run: npm run hooks:verify`);

  // hooks/_common.cjs exits 0 without ONESHOT_PHASE, so a session env without
  // it runs every guard as a no-op. And the env is an allowlist: no API key,
  // no GitLab token (that reaches only the MCP server).
  const env = sessionEnv(probeInput());
  if (env.ONESHOT_PHASE === 'ticket') pass('session env sets ONESHOT_PHASE=ticket', 'every guard is a no-op without it');
  else fail('session env lacks ONESHOT_PHASE=ticket', 'every guard would exit 0 and allow everything');
  const credentialKey = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_\w+|GITLAB_TOKEN|GITLAB_PERSONAL_ACCESS_TOKEN|ONESHOT_GITLAB_TOKEN)$/;
  const leaked = Object.keys(env).filter((k) => credentialKey.test(k));
  if (token.token.length >= 8 && Object.values(env).some((v) => v.includes(token.token))) leaked.push('the GitLab token value');
  if (leaked.length) fail('session env carries a credential', leaked.join(', '));
  else pass('session env holds no API key or GitLab token');

  // ------------------------------------------------------------------ sdk
  section('SDK');
  const sdk = sdkInfo();
  if (!sdk.sdkVersion) fail('agent SDK not installed', 'npm install with the VPN OFF');
  if (!sdk.cliVersion) fail('bundled Claude Code version unreadable', 'node_modules/@anthropic-ai/claude-agent-sdk/manifest.json');
  else if (!atLeast(sdk.cliVersion, 2, 1)) fail(`bundled Claude Code ${sdk.cliVersion} is older than 2.1`, 'superpowers assumes 2.1 hook behaviour — npm install');
  else pass(`bundled Claude Code ${sdk.cliVersion}`, `agent SDK ${sdk.sdkVersion ?? '?'}`);
  if (sdk.binaryPresent) pass('native binary present', sdk.platformPackage);
  else fail('native binary missing', `${sdk.platformPackage} — npm install with the VPN OFF`);
  report(await probeGitlabMcp());

  // ---------------------------------------------------------- superpowers
  section(`Superpowers ${D}(the probe is a real 1-turn session on your subscription; --no-probe skips it)${X}`);
  const sp = superpowersPath();
  const spUsable = !!sp && existsSync(join(sp, 'skills', 'brainstorming', 'SKILL.md'));
  if (!sp) fail('superpowers not installed', '`claude plugin install superpowers`, or set ONESHOT_SUPERPOWERS_PATH');
  else if (!spUsable) fail('superpowers dir has no skills/brainstorming/SKILL.md', `${sp} — set ONESHOT_SUPERPOWERS_PATH or fix the plugin dir`);
  else pass('plugin dir', `${sp}${envOr('ONESHOT_SUPERPOWERS_PATH') ? ' (from ONESHOT_SUPERPOWERS_PATH)' : ''}`);
  const inject = envOr('ONESHOT_SUPERPOWERS_INJECT') === '1';
  if (inject && sp && !existsSync(join(sp, 'skills', 'using-superpowers', 'SKILL.md'))) {
    fail('ONESHOT_SUPERPOWERS_INJECT=1 but there is no intro to inject', `${sp}/skills/using-superpowers/SKILL.md is missing`);
  }

  if (noProbe) {
    console.log(`  ${D}SKIP  probe session (--no-probe)${X}`);
  } else if (spUsable) {
    const probe = await runProbe();
    const v = probeVerdict(probe.frames);
    const init = (probe.frames as Array<Record<string, unknown>>).find((f) => f?.type === 'system' && f.subtype === 'init');
    const result = (probe.frames as Array<Record<string, unknown>>).find((f) => f?.type === 'result');
    if (probe.error || !result) {
      fail('probe session did not finish', `${probe.error ?? 'no result frame'}${probe.stderr ? ` — ${probe.stderr.trim().slice(-300)}` : ''}`);
    }
    if (init) {
      const errs = ((init.plugin_errors as Array<{ plugin?: string; type?: string; message?: string }> | undefined) ?? [])
        .map((e) => `${e.plugin ?? '?'}: ${e.type ?? '?'} ${e.message ?? ''}`.trim());
      if (v.pluginLoaded) pass('plugin loaded', 'the init frame lists superpowers');
      else fail('plugin did not load', `set ONESHOT_SUPERPOWERS_PATH or fix the plugin dir${errs.length ? ` — ${errs.join('; ')}` : ''}`);
      if (v.skillsNamespaced) pass('skills namespaced', 'superpowers:* skills are in the session');
      else warn('no superpowers:* skill in the session', 'the prompt names superpowers:brainstorming and superpowers:writing-plans');
      if (v.hookFired && inject) {
        warn('SessionStart hook fired AND ONESHOT_SUPERPOWERS_INJECT=1', 'the intro reaches the session twice — remove ONESHOT_SUPERPOWERS_INJECT from .env');
      } else if (v.hookFired) {
        pass('SessionStart hook fired', `"${INTRO_MARK}" was injected`);
      } else if (inject) {
        pass('SessionStart hook did not fire; fallback on', 'ONESHOT_SUPERPOWERS_INJECT=1 appends the intro to the system prompt');
      } else {
        warn('SessionStart hook did not fire', 'add ONESHOT_SUPERPOWERS_INJECT=1 to .env — the intro will be appended to the system prompt instead');
      }
      pass('session CLI', `claude ${v.cliVersion ?? '?'}${result ? `, result ${String(result.subtype)} in ${String(result.num_turns)} turn(s)` : ''}`);
    } else if (!probe.error && result) {
      fail('plugin not verified', 'the probe session emitted no system/init frame');
    }
  }

  // -------------------------------------------------------------- verdict
  console.log(`\n${fails ? R : G}${fails} failed${X}, ${Y}${warns} warnings${X}\n`);
  process.exit(fails ? 1 : 0);
}

if (process.argv[1]?.endsWith('doctor.ts')) {
  main().catch((err) => {
    console.error(`\n${R}doctor crashed${X}: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
