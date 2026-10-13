/**
 * `npm run deps:verify` — prove every out-of-process dependency actually starts.
 *
 * This exists because of a real failure: `doctor` reported 0 failed while the
 * GitLab MCP server could not start at all. It was configured as `npx -y
 * @zereight/mcp-gitlab`, npx re-resolves against the npm registry on every
 * spawn, and this machine's npm traffic is blocked whenever the FortiClient VPN
 * is up — the same VPN GitLab itself requires. The session then sat with no
 * tools and burned its whole wall-clock timeout at ZERO turns.
 *
 * The lesson generalises: checking that a dependency is CONFIGURED is not the
 * same as checking that it RUNS. Everything here is spawned for real, and the
 * MCP server is spawned from the very config a session gets
 * (sessionMcpServers), so there is no second description of it to drift.
 *
 * `npm run doctor` imports sdkInfo() and probeGitlabMcp() from here for its
 * SDK section, so the two commands cannot disagree.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, runDir } from '../src/lib/config.js';
import type { Finding } from '../src/lib/repocheck.js';
import { setupHint } from '../src/lib/token.js';
import { sessionMcpServers } from '../src/ticket/session.js';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';

/**
 * Spawn an MCP stdio server the way a SESSION spawns it, and make it prove
 * itself by listing tools.
 *
 * Two things here were learned the hard way. The env is passed WHOLE rather
 * than merged over process.env, because that is the SDK's semantics and the
 * merge is what made this check lie: a server missing PATH dies with
 * `env: node: No such file or directory` inside a session while passing here.
 * And "alive after N ms" is not the bar — the failure that actually happened
 * was a server the SDK reported as `connected` that served ZERO tools, so the
 * handshake and a non-empty tools/list are the only evidence worth anything.
 */
export function probeStdioServer(
  cmd: string, args: string[], env: Record<string, string>, ms = 6000,
): Promise<{ ok: boolean; detail: string; tools: number }> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    let stdout = '';
    const child = spawn(cmd, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const done = (r: { ok: boolean; detail: string; tools: number }): void => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(r);
    };

    child.stdout?.on('data', (d) => { stdout += String(d); });

    const send = (o: unknown): void => {
      try { child.stdin?.write(`${JSON.stringify(o)}\n`); } catch { /* exit handler reports */ }
    };
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'oneshot-doctor', version: '1' },
      },
    });
    setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 1200);
    setTimeout(() => {
      const tools = stdout.split('\n').filter(Boolean).reduce((n, line) => {
        try {
          const m = JSON.parse(line) as { id?: number; result?: { tools?: unknown[] } };
          return m.id === 2 ? (m.result?.tools ?? []).length : n;
        } catch { return n; }
      }, 0);
      done(tools > 0
        ? { ok: true, detail: `${tools} tools`, tools }
        : {
          ok: false, tools: 0,
          detail: `handshake produced NO tools — a session would see the server as connected ` +
            `and hold none of its tools. ${stderr.trim().slice(0, 160)}`,
        });
    }, ms);

    child.stderr?.on('data', (d) => { stderr += String(d).slice(0, 400); });

    child.on('error', (err) => {
      done({ ok: false, tools: 0, detail: `spawn failed: ${err.message}` });
    });

    child.on('exit', (code) => {
      done({
        ok: false, tools: 0,
        detail: `exited early (code ${code}) ${stderr.trim().slice(0, 160)}`,
      });
    });
  });
}

/**
 * The GitLab MCP server exactly as a session gets it — sessionMcpServers(0)'s
 * command, args and env, token and API root included — spawned and asked for
 * its tools. iid 0 is never a real ticket; the shim creates state/runs/0/artifacts
 * as its cwd, which is removed again when this created it.
 */
export async function probeGitlabMcp(): Promise<Finding> {
  let server;
  try {
    server = sessionMcpServers(0).gitlab;
  } catch (err) {
    return { level: 'fail', label: 'GitLab MCP server not probed', detail: (err as Error).message };
  }
  if (!server) {
    return {
      level: 'fail', label: 'no GitLab MCP server',
      detail: `this desk resolves no GitLab token, so a session would hold no GitLab tools. ${setupHint().split('\n')[0]}`,
    };
  }
  const scratch = runDir(0);
  const existed = existsSync(scratch);
  try {
    const r = await probeStdioServer(server.command, server.args ?? [], server.env ?? {});
    const cmd = [server.command, ...(server.args ?? [])].join(' ').replaceAll(ROOT, '.');
    return r.ok
      ? { level: 'pass', label: 'GitLab MCP server serves tools', detail: `${r.detail} (${cmd})` }
      : { level: 'fail', label: 'GitLab MCP server serves NO tools', detail: r.detail };
  } finally {
    if (!existed) rmSync(scratch, { recursive: true, force: true });
  }
}

export interface SdkInfo {
  /** The installed @anthropic-ai/claude-agent-sdk version, or null when it is not installed. */
  sdkVersion: string | null;
  /** The Claude Code build the SDK bundles (its manifest.json `version`), or null. */
  cliVersion: string | null;
  /** The optional dependency that carries the native binary for this platform. */
  platformPackage: string;
  /** Whether that package's `claude` binary is on disk. */
  binaryPresent: boolean;
}

/**
 * Read off disk, never imported: the SDK's package.json is not in its
 * `exports` map (ERR_PACKAGE_PATH_NOT_EXPORTED), and manifest.json is data.
 */
export function sdkInfo(): SdkInfo {
  const dir = join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  const field = (file: string): string | null => {
    try {
      const v = (JSON.parse(readFileSync(join(dir, file), 'utf8')) as { version?: unknown }).version;
      return typeof v === 'string' ? v : null;
    } catch { return null; }
  };
  const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const binary = join(ROOT, 'node_modules', platformPackage, process.platform === 'win32' ? 'claude.exe' : 'claude');
  return {
    sdkVersion: field('package.json'),
    cliVersion: field('manifest.json'),
    platformPackage,
    binaryPresent: existsSync(binary),
  };
}

/** True when `version` (x.y.z) is at least `major.minor`. */
export function atLeast(version: string, major: number, minor: number): boolean {
  const [a, b] = version.split('.').map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a! > major || (a === major && b! >= minor);
}

async function main(): Promise<void> {
  let fails = 0;
  const say = (f: Finding): void => {
    const tag = f.level === 'pass' ? `${G}PASS${X}` : f.level === 'warn' ? `${Y}WARN${X}` : `${R}FAIL${X}`;
    if (f.level === 'fail') fails += 1;
    console.log(`  ${tag}  ${f.label}${f.detail ? ` ${D}${f.detail}${X}` : ''}`);
  };

  console.log('\nOneshot dependency probe');

  console.log('\nNode packages');
  const sdk = sdkInfo();
  for (const pkg of ['@anthropic-ai/claude-agent-sdk', sdk.platformPackage, '@zereight/mcp-gitlab', 'playwright']) {
    say(existsSync(join(ROOT, 'node_modules', pkg))
      ? { level: 'pass', label: pkg, detail: '' }
      : { level: 'fail', label: pkg, detail: 'not installed — run npm install with the VPN OFF' });
  }

  console.log('\nClaude Code (bundled with the SDK)');
  if (!sdk.cliVersion) say({ level: 'fail', label: 'bundled CLI version unreadable', detail: 'node_modules/@anthropic-ai/claude-agent-sdk/manifest.json' });
  else if (!atLeast(sdk.cliVersion, 2, 1)) say({ level: 'fail', label: `bundled CLI ${sdk.cliVersion} is older than 2.1`, detail: 'superpowers assumes 2.1 hook behaviour — npm install' });
  else say({ level: 'pass', label: `bundled CLI ${sdk.cliVersion}`, detail: `agent SDK ${sdk.sdkVersion ?? '?'}` });
  say(sdk.binaryPresent
    ? { level: 'pass', label: 'native binary present', detail: sdk.platformPackage }
    : { level: 'fail', label: 'native binary missing', detail: `${sdk.platformPackage} — npm install with the VPN OFF` });

  console.log('\nGitLab MCP server (spawned for real, as a session gets it)');
  say(await probeGitlabMcp());

  console.log('\nPlaywright (browser verification inside the session)');
  const pwBin = join(ROOT, 'node_modules', '.bin', 'playwright');
  const pw = spawnSync(pwBin, ['--version'], { encoding: 'utf8', cwd: ROOT, timeout: 30_000 });
  if (pw.status === 0) {
    say({ level: 'pass', label: pw.stdout.trim(), detail: '' });
    const cache = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright');
    say(existsSync(cache)
      ? { level: 'pass', label: 'browser cache present', detail: cache }
      : { level: 'warn', label: 'no browser cache', detail: 'run `npx playwright install chromium` with the VPN OFF' });
  } else {
    say({ level: 'warn', label: 'playwright not runnable', detail: 'the session cannot verify in a browser without it' });
  }

  console.log(`\n${fails ? R : G}${fails} failed${X}\n`);
  process.exit(fails ? 1 : 0);
}

if (process.argv[1]?.endsWith('verify-deps.ts')) {
  main().catch((err) => {
    console.error(`\nprobe crashed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
