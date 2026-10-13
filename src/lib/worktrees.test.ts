import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detachTrackedClaude, seedWorktree } from './worktrees.js';
import { assertComposed, ensureClaudeDir } from './claudedir.js';
import { SKILLS_ROOT } from './config.js';

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A checkout that COMMITS `.claude`, the way the work repo does. */
function repoWithCommittedClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oneshot-wt-'));
  git(['init', '-q', '-b', 'dev'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  mkdirSync(join(dir, '.claude', 'skills', 'frontend-accessibility'), { recursive: true });
  mkdirSync(join(dir, '.claude', 'rules'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'skills', 'frontend-accessibility', 'SKILL.md'), 'work repo copy\n');
  writeFileSync(join(dir, '.claude', 'rules', 'security.md'), 'work repo rules\n');
  writeFileSync(join(dir, 'README.md'), 'app\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'app with committed .claude'], dir);
  return dir;
}

test('the work repo\'s committed .claude is cleared so ours can take its place', () => {
  const dir = repoWithCommittedClaude();
  try {
    assert.ok(existsSync(join(dir, '.claude', 'skills', 'frontend-accessibility', 'SKILL.md')));

    detachTrackedClaude(dir);

    // Gone from the working tree, so ensureClaudeDir() composes onto a clean
    // slate instead of finding a real directory at every name and backing off.
    assert.ok(!existsSync(join(dir, '.claude')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git does not see the removal, so it cannot reach a commit or an MR diff', () => {
  const dir = repoWithCommittedClaude();
  try {
    detachTrackedClaude(dir);
    assert.equal(git(['status', '--porcelain'], dir), '');
    // Still in the index and still in HEAD — we shadow the checkout, we do not
    // delete the work repo's files.
    assert.match(git(['ls-files', '.claude'], dir), /skills\/frontend-accessibility\/SKILL\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second lease over the same worktree is a no-op', () => {
  const dir = repoWithCommittedClaude();
  try {
    detachTrackedClaude(dir);
    mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'ours.md'), 'composed by oneshot\n');

    detachTrackedClaude(dir);

    assert.equal(git(['status', '--porcelain'], dir), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a skill the work repo also ships still resolves to THIS repo\'s copy', () => {
  // The requirement in one assertion: a phase invokes the skill that lives
  // here, whatever the work repo happens to have committed under the same name.
  const dir = repoWithCommittedClaude();
  try {
    seedWorktree(dir);

    const entry = join(dir, '.claude', 'skills', 'frontend-accessibility');
    assert.equal(
      readlinkSync(entry),
      join(SKILLS_ROOT, 'skills', 'frontend-accessibility'),
      'the work repo\'s committed copy must not shadow ours',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seeding again — as a resumed run does — picks up a skill changed since', () => {
  const dir = repoWithCommittedClaude();
  try {
    seedWorktree(dir);
    // Whatever a first seed produced, a second must still leave the link
    // pointing here. This is the resume path: the worktree already exists, and
    // the files behind it may have moved on.
    seedWorktree(dir);

    const entry = join(dir, '.claude', 'skills', 'frontend-accessibility');
    assert.equal(readlinkSync(entry), join(SKILLS_ROOT, 'skills', 'frontend-accessibility'));
    assert.equal(git(['status', '--porcelain'], dir), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('what we compose stays out of git status in a LINKED worktree', () => {
  // The exclude git consults lives in the common dir, not in
  // .git/worktrees/<name>/. Writing the right file to the wrong path left every
  // composed symlink showing as untracked, one `git add -A` from an MR.
  const main = repoWithCommittedClaude();
  const linked = join(main, '..', `wt-${Date.now()}`);
  try {
    git(['worktree', 'add', '-q', '--detach', linked], main);

    seedWorktree(linked);

    assert.equal(git(['status', '--porcelain'], linked), '');
  } finally {
    try { git(['worktree', 'remove', '--force', linked], main); } catch { /* best effort */ }
    rmSync(main, { recursive: true, force: true });
    rmSync(linked, { recursive: true, force: true });
  }
});

test('a checkout that does not commit .claude is left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oneshot-wt-'));
  try {
    git(['init', '-q', '-b', 'dev'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    writeFileSync(join(dir, 'README.md'), 'app\n');
    git(['add', '-A'], dir);
    git(['commit', '-qm', 'app'], dir);
    mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'ours.md'), 'composed by oneshot\n');

    detachTrackedClaude(dir);

    assert.ok(existsSync(join(dir, '.claude', 'skills', 'ours.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------- what a Solo session may not see

test('planning-methodology and the approval-stopping agents are never composed', () => {
  // They stop and wait for a human to approve the plan; a Solo session has
  // nobody to wait for, and would idle out its budget.
  const dir = repoWithCommittedClaude();
  try {
    seedWorktree(dir);

    assert.ok(!existsSync(join(dir, '.claude', 'skills', 'planning-methodology')));
    const agents = join(dir, '.claude', 'agents');
    assert.ok(!lstatSync(agents).isSymbolicLink(), 'agents/ is composed per file, not linked whole');
    assert.ok(!existsSync(join(agents, 'planner-agent.md')));
    assert.ok(!existsSync(join(agents, 'orchestrator-agent.md')));
    for (const name of readdirSync(join(SKILLS_ROOT, 'agents'))) {
      if (name === 'planner-agent.md' || name === 'orchestrator-agent.md') continue;
      assert.equal(readlinkSync(join(agents, name)), join(SKILLS_ROOT, 'agents', name));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a worktree composed with a whole-dir agents link is recomposed per file', () => {
  // A worktree leased before agents were composed per file carries one symlink
  // to the whole directory, and with it the agents that stop for approval.
  const dir = repoWithCommittedClaude();
  try {
    detachTrackedClaude(dir);
    mkdirSync(join(dir, '.claude'), { recursive: true });
    symlinkSync(join(SKILLS_ROOT, 'agents'), join(dir, '.claude', 'agents'));

    ensureClaudeDir(dir);

    assert.ok(!lstatSync(join(dir, '.claude', 'agents')).isSymbolicLink());
    assert.ok(!existsSync(join(dir, '.claude', 'agents', 'planner-agent.md')));
    assert.ok(existsSync(join(SKILLS_ROOT, 'agents', 'planner-agent.md')), 'the source is never touched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertComposed is empty for a freshly composed worktree', () => {
  const dir = repoWithCommittedClaude();
  try {
    seedWorktree(dir);
    assert.deepEqual(assertComposed(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertComposed names a skill the work repo put back, and a recompose clears it', () => {
  // A session that runs `git checkout -- .` or `git stash` can lay the work
  // repo's committed .claude back down; its stale copy then shadows ours.
  const dir = repoWithCommittedClaude();
  try {
    seedWorktree(dir);
    rmSync(join(dir, '.claude', 'skills', 'frontend-accessibility'), { force: true });
    git(['update-index', '--no-skip-worktree', '.claude/skills/frontend-accessibility/SKILL.md'], dir);
    git(['checkout', '--', '.claude/skills/frontend-accessibility'], dir);
    symlinkSync('/nonexistent/skill', join(dir, '.claude', 'skills', 'dangling'));

    assert.deepEqual(assertComposed(dir).sort(), ['dangling', 'frontend-accessibility']);

    detachTrackedClaude(dir);
    ensureClaudeDir(dir);
    assert.deepEqual(assertComposed(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertComposed reports a worktree with no composed skills at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oneshot-wt-'));
  try {
    assert.deepEqual(assertComposed(dir), ['.claude/skills']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
