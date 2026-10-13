/**
 * The `.claude` directory a phase session can actually read.
 *
 * Sessions are spawned with `settingSources: ['project']`, so the only place a
 * skill, agent or rule can come from is a `.claude` directory in the session's
 * cwd. Worktree phases had one — seed() symlinked the whole of the context
 * repo's `.claude` into the worktree — but conductor-cwd phases (recall, qa,
 * demo, document, memorize) run in the Oneshot repo root, which had no
 * `.claude` at all. Every skill their prompts named silently failed to resolve:
 * the recorded run-5 transcripts show the recall session listing eight built-in
 * slash commands and not one project skill, while the worktree sessions listed
 * forty-two. Nothing errored. The phase did the work from the prompt alone and
 * the loss was invisible from outside.
 *
 * A whole-dir symlink cannot fix that, because the pipeline skills
 * (local-browser-verify, ui-evidence-pack, self-remediation) describe THIS
 * system and live in THIS repo — a fresh
 * clone has to carry them, and writing them into the context repo would make
 * Oneshot's own method something you have to remember to install next to it. So
 * `.claude` is composed instead: a real directory whose `skills/` holds one
 * symlink per skill, taken from the context repo first and topped up from
 * `skills/` here.
 *
 * Context-repo-first is the collision rule. If the ERP repo ever ships a skill
 * under one of these names, that copy wins — it is the one humans maintain and
 * the one an interactive session on this machine would get. Oneshot only fills
 * gaps, and a name that appears on both sides is a signal to delete ours, not
 * to shadow theirs.
 *
 * `settings.json` is deliberately not linked. It carries the context repo's own
 * hook wiring and permission set; Oneshot supplies its guards through the SDK's
 * `hooks` option so they travel with this repo and apply at every cwd. A
 * second, unversioned guard configuration arriving through project settings is
 * precisely the thing nobody can reason about after an incident.
 */
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ROOT, SKILLS_ROOT } from './config.js';
import { log } from './log.js';

/**
 * Subdirectories taken whole from the context repo — no Oneshot equivalent
 * exists. `agents/` is not one of them: it is composed per file so that
 * EXCLUDED_AGENTS can apply (see linkAgents()).
 */
const LINKED_SUBDIRS = ['rules'] as const;

/**
 * Context-repo skills that must not reach a phase, and why each one is here.
 *
 * Taking the context repo wholesale is the right default: a skill the humans
 * maintain is a skill a phase should have, and an allowlist would silently rot
 * every time someone adds one. But wholesale means a skill arrives because it
 * EXISTS, never because anybody decided a phase should have it — so a skill
 * whose preconditions this machine cannot meet still gets enumerated by the
 * harness, still advertises itself by description, and still costs a phase the
 * turns it takes to find out.
 *
 * The bar for adding a name is deliberately narrow. Not "unlikely to be
 * useful" — a phase can ignore those for free. It is "cannot work here, and
 * discovering that is not free".
 */
const EXCLUDED_SKILLS = new Map<string, string>([
  ['graphify-knowledge-graph',
    'reads a pre-built graph from graphify-out/, which exists in neither the context repo ' +
    'nor the work repo; the sandbox ships graphify-manifest.json as an explicit stub and the ' +
    'real bundle only arrives via the interactive /get-graphify command, which nothing here ' +
    'runs. Research spent its whole turn budget establishing that absence twice.'],
  ['planning-methodology',
    'stops and waits for a human to approve the plan. A Solo session plans with ' +
    'superpowers writing-plans and has nobody to wait for, so it would idle out its budget.'],
]);

/**
 * Context-repo agents a Solo session must not delegate to, by name (the file
 * is `<name>.md`). Both stop for a human's approval before going on — the
 * planner after its plan, the orchestrator between the agents it dispatches —
 * and nobody is watching a Solo session to give it.
 */
const EXCLUDED_AGENTS = new Set(['planner-agent', 'orchestrator-agent']);

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/** Follows symlinks deliberately: a linked skill directory must count as one. */
function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/**
 * Point `at` at `target`, replacing a stale or dangling link.
 *
 * Self-healing matters more than it looks: the seed repo gets renamed, a skill
 * gets deleted upstream, a worktree outlives a config change. A dangling
 * symlink under `skills/` is not inert — the harness enumerates the directory,
 * so one broken entry is a per-session error on a path nobody is watching.
 * A real file or directory left there by a human is never touched.
 */
function relink(at: string, target: string): void {
  if (isSymlink(at)) {
    let current = '';
    try { current = readlinkSync(at); } catch { current = ''; }
    if (current === target && existsSync(at)) return;
    rmSync(at, { force: true });
  } else if (existsSync(at)) {
    return;
  }
  symlinkSync(target, at);
}

function pruneDangling(dir: string): void {
  for (const name of readdirSync(dir)) {
    const entry = join(dir, name);
    if (isSymlink(entry) && !existsSync(entry)) rmSync(entry, { force: true });
  }
}

/**
 * Remove links this repo used to compose and has since excluded.
 *
 * Skipping an excluded name in linkSkills() only stops NEW links; a worktree
 * composed before the exclusion existed keeps its old one, and so does the
 * conductor root. Without this the exclusion would apply to fresh worktrees
 * only and the change would look like it had not worked.
 *
 * A real directory under this name is left alone — that is a human's file, and
 * an exclusion list is not a licence to delete one.
 */
function unlinkExcluded(dir: string): void {
  for (const [name, why] of EXCLUDED_SKILLS) {
    const entry = join(dir, name);
    if (!isSymlink(entry)) continue;
    rmSync(entry, { force: true });
    log.info(`unlinked excluded skill ${name}`, { why });
  }
}

/**
 * Compose `into` as a real directory holding one link per agent file under
 * `from`, minus EXCLUDED_AGENTS.
 *
 * A whole-dir link at `into` is what this repo composed before agents were
 * taken per file, so it is replaced; a link to an excluded agent is removed for
 * the same reason unlinkExcluded() removes skills. A real file is a human's and
 * is left alone, as everywhere in this file.
 */
function linkAgents(from: string, into: string): void {
  if (!isDirectory(from)) return;
  if (isSymlink(into)) rmSync(into, { force: true });
  mkdirSync(into, { recursive: true });
  pruneDangling(into);
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const entry = join(into, name);
    if (EXCLUDED_AGENTS.has(name.replace(/\.md$/, ''))) {
      if (isSymlink(entry)) rmSync(entry, { force: true });
      continue;
    }
    relink(entry, join(from, name));
  }
}

/** Link every skill directory under `from` whose name is not already claimed. */
function linkSkills(from: string, into: string, claimed: Set<string>): void {
  if (!isDirectory(from)) return;
  for (const name of readdirSync(from)) {
    if (name.startsWith('.') || claimed.has(name) || EXCLUDED_SKILLS.has(name)) continue;
    const src = join(from, name);
    if (!isDirectory(src)) continue;
    claimed.add(name);
    relink(join(into, name), src);
  }
}

/**
 * Build (or repair) `<repoRoot>/.claude` and report what it seeded.
 *
 * Returns repo-relative paths so the caller can keep them out of `git status`;
 * the conductor root ignores the return value because `/.claude/` is already in
 * .gitignore there.
 *
 * Idempotent by construction — every step is a relink or a mkdir -p, so calling
 * it on every worktree lease and every conductor boot costs nothing and quietly
 * repairs whatever drifted. An existing whole-dir `.claude` SYMLINK is left
 * exactly as it is: worktrees created before this function existed are still
 * running phases, and replacing the thing they resolve skills through mid-run
 * would break them to fix a problem they do not have.
 */
export function ensureClaudeDir(repoRoot: string): string[] {
  const dotClaude = join(repoRoot, '.claude');
  if (isSymlink(dotClaude)) return ['.claude'];

  const contextSkills = join(SKILLS_ROOT, 'skills');
  const oneshotSkills = join(ROOT, 'skills');
  if (!isDirectory(contextSkills) && !isDirectory(oneshotSkills)) {
    log.warn('no skills to seed — phases will run on their prompts alone', { SKILLS_ROOT });
    return [];
  }

  try {
    const skills = join(dotClaude, 'skills');
    mkdirSync(skills, { recursive: true });
    pruneDangling(skills);
    unlinkExcluded(skills);

    for (const sub of LINKED_SUBDIRS) {
      const src = join(SKILLS_ROOT, sub);
      if (isDirectory(src)) relink(join(dotClaude, sub), src);
    }
    linkAgents(join(SKILLS_ROOT, 'agents'), join(dotClaude, 'agents'));

    const claimed = new Set<string>();
    linkSkills(contextSkills, skills, claimed);
    linkSkills(oneshotSkills, skills, claimed);
    return ['.claude'];
  } catch (err) {
    // A phase without skills still runs; a conductor that cannot boot does not.
    log.warn('could not compose .claude — skills may not resolve', {
      repoRoot, error: (err as Error).message,
    });
    return [];
  }
}

/**
 * The `.claude/skills` entries that are NOT this composition — empty when the
 * worktree resolves every skill through a link into SKILLS_ROOT or this repo.
 *
 * A session runs for hours inside the worktree, and the work repo COMMITS
 * `.claude/`: one `git checkout -- .`, `git stash` or `reset --hard` lays the
 * work repo's copies back down as real directories, and from then on every
 * name the work repo ships resolves its older file. relink() backs off from a
 * real directory, so ensureClaudeDir() alone cannot notice. The caller checks
 * this before every attempt and, when it is non-empty, detaches the tracked
 * `.claude` again and recomposes.
 *
 * A dangling link counts too (the harness enumerates the directory, and a
 * broken entry errors), and so does a missing `skills/` — nothing is composed.
 */
export function assertComposed(repoRoot: string): string[] {
  const skills = join(repoRoot, '.claude', 'skills');
  if (!isDirectory(skills)) return ['.claude/skills'];
  const ours = new Set([join(SKILLS_ROOT, 'skills'), join(ROOT, 'skills')]);
  const foreign: string[] = [];
  for (const name of readdirSync(skills)) {
    if (name.startsWith('.')) continue;
    const entry = join(skills, name);
    let target = '';
    try { target = isSymlink(entry) ? resolve(dirname(entry), readlinkSync(entry)) : ''; } catch { target = ''; }
    if (!target || !ours.has(dirname(target)) || !existsSync(entry)) foreign.push(name);
  }
  return foreign;
}
