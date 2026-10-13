/**
 * The quota park: what the conductor does when a session hits a real
 * subscription usage limit.
 *
 * The rolling 5-hour and 7-day windows of a Max subscription are hard external
 * limits, shared with the operator's own interactive sessions. Once one is hit,
 * every further session dies against the same wall until the stated reset, so
 * the conductor parks itself in state/PAUSE-QUOTA with an expiry and stands down
 * until it passes.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { PAUSE_QUOTA, STATE } from './config.js';
import { log } from './log.js';

/**
 * How long to park when no reset time is known. Session and Opus limits reset
 * inside a 5-hour window, so an hour and then a re-check is cheap. A weekly
 * limit resets at a fixed per-account time that cannot be known from here, so
 * it takes the longer default and re-checks every 6 hours rather than sleeping
 * for a week.
 */
const PAUSE_DEFAULT_MIN = 60;
const PAUSE_MAX_MIN = 360;

/**
 * Strings Claude Code emits when a SUBSCRIPTION limit is genuinely hit. These
 * are not retryable errors — the CLI blocks until the stated reset.
 *
 * Deliberately NOT matched: 529/overloaded and "temporarily limiting requests
 * (not your usage limit)". Those are transient server pressure; parking the
 * whole system for an hour over one is a self-inflicted outage.
 */
const LIMIT_PATTERNS: RegExp[] = [
  /you've hit your (session|usage) limit/i,
  /hit the (session|weekly|opus) limit/i,
  /usage limit reached/i,
  /resets\s+(at\s+)?\d{1,2}(:\d{2})?\s*(am|pm)/i,
  /rate[_ ]limit[_ ]error/i,
];

const NOT_A_LIMIT: RegExp[] = [
  /not your usage limit/i,
  /overloaded/i,
  /529/,
];

export function looksLikeUsageLimit(text: string): boolean {
  if (!text) return false;
  if (NOT_A_LIMIT.some((rx) => rx.test(text))) return false;
  return LIMIT_PATTERNS.some((rx) => rx.test(text));
}

/** Parse "resets 3:45pm" into an epoch ms — the next such time, today or tomorrow. */
export function parseResetMs(text: string): number | null {
  const m = /resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? '0');
  const meridiem = (m[3] ?? '').toLowerCase();
  if (meridiem === 'pm' && hour !== 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime();
}

/**
 * When the machine's own quota park ends (epoch ms), or null when it is not in
 * force.
 *
 * The park is self-clearing, and that self-clearing is entirely carried by
 * `until` inside the file. So a file that cannot be parsed — truncated by a
 * crash mid-write, hand-edited, or half-synced — has no expiry, and treating it
 * as a park meant the conductor stood down FOREVER while logging one ordinary
 * "parked" line a minute. That is the worst shape a failure can take here:
 * indistinguishable from working correctly.
 *
 * A corrupt park is therefore removed and refused. Nothing is lost by doing so:
 * a real limit re-parks on the next session that hits one. state/PAUSE — the
 * human kill switch — is a different file and is never touched here.
 */
export function quotaParked(): number | null {
  if (!existsSync(PAUSE_QUOTA)) return null;
  try {
    const p = JSON.parse(readFileSync(PAUSE_QUOTA, 'utf8')) as { until?: number };
    if (typeof p.until !== 'number' || !Number.isFinite(p.until)) {
      throw new Error('no usable "until" field');
    }
    if (Date.now() >= p.until) {
      rmSync(PAUSE_QUOTA, { force: true });
      log.ok('Quota park expired — resuming');
      return null;
    }
    return p.until;
  } catch (err) {
    log.error(`${PAUSE_QUOTA} is unreadable and has no expiry — removing it and resuming`, {
      error: (err as Error).message,
    });
    try {
      rmSync(PAUSE_QUOTA, { force: true });
    } catch (rmErr) {
      log.error('could not remove the corrupt park file — delete it by hand', {
        error: (rmErr as Error).message,
      });
    }
    return null;
  }
}

/**
 * Park after a real usage limit: until `resetMs` when the caller was told it,
 * else the reset time `reason` states, else a default. A `resetMs` that is not
 * in the future is ignored rather than trusted — a park that has already
 * expired would send the next session straight back into the wall.
 *
 * Written to its own file, never state/PAUSE: nothing automatic may ever create
 * or clear the human kill switch.
 */
export function parkForQuota(reason: string, resetMs?: number): void {
  const now = Date.now();
  const told = resetMs !== undefined && Number.isFinite(resetMs) && resetMs > now ? resetMs : null;
  const parsed = told ?? parseResetMs(reason);
  const fallbackMin = /weekly/i.test(reason) ? PAUSE_MAX_MIN : PAUSE_DEFAULT_MIN;
  const until = parsed ?? now + fallbackMin * 60_000;
  // Clamp to 7 days so a mis-parsed reset time cannot strand the system.
  const clamped = Math.min(until, now + 7 * 86_400_000);

  mkdirSync(STATE, { recursive: true });
  writeFileSync(PAUSE_QUOTA, JSON.stringify({
    reason: reason.slice(0, 300) || 'subscription usage limit',
    parsed_reset: parsed,
    until: clamped,
    at: now,
  }, null, 2));
  log.error(`Subscription limit hit — parked until ${new Date(clamped).toLocaleTimeString()}`);
}
