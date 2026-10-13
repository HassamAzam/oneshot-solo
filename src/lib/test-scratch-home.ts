/**
 * A throwaway state/ for a test file: import it FIRST, before anything that
 * imports config.ts.
 *
 * config.ts computes STATE — and RUNS, RUNS_ARCHIVE, the PAUSE files and the
 * pid file from it — once, when it loads, from ONESHOT_STATE_DIR. Setting that
 * variable here, to a fresh mkdtemp dir, therefore only works if this module
 * runs before config.ts does; ES modules evaluate in import order, so it must
 * be the first import that reaches config (after test-project-env.ts, which
 * also imports nothing). Imported later, it changes nothing and the test writes
 * into this checkout's live state/, which the dashboard and `npm run status`
 * read.
 *
 * Each test file runs in its own process under `node --test`, so each gets its
 * own directory; it is removed when the process exits.
 *
 * Imports nothing from config, which is the point.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'oneshot-state-'));
process.env.ONESHOT_STATE_DIR = dir;
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
