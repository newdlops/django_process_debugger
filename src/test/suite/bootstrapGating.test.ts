import * as assert from 'assert';
import { describe, it, before, after } from 'mocha';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DebugpyInjector } from '../../debugpyInjector';
import { getPerf } from './perfReporter';
import {
  createTempVenv,
  findSystemPython,
  projectRoot,
  spawnFakeRunserver,
  SpawnedProcess,
} from './testHelpers';

const execFileAsync = promisify(execFile);

/**
 * The bootstrap .pth file runs on EVERY Python startup in the target venv —
 * including pip, pytest, language servers, build scripts, etc. So the gating
 * check (`_is_target_process`) MUST be:
 *   (a) cheap (sub-millisecond), because every Python invocation pays for it;
 *   (b) correct (no false positives on tool argvs, no false negatives on servers).
 *
 * Perf numbers feed optimization.md's "bootstrap fast-path" item.
 */
describe('Feature: bootstrap gating on non-target processes', function () {
  const perf = getPerf();
  const injector = new DebugpyInjector();
  const bootstrapLog = '/tmp/django-process-debugger/bootstrap.log';
  let venv: Awaited<ReturnType<typeof createTempVenv>> = null;
  let basePython: string | null = null;

  before(async function () {
    this.timeout(60_000);
    basePython = await findSystemPython();
    if (!basePython) { this.skip(); return; }

    venv = await createTempVenv(basePython);
    if (!venv) { this.skip(); return; }

    injector.setBundledDebugpyPath(path.join(projectRoot(), 'vendor', 'python'));
    await injector.installBootstrap(venv.sitePackages);

    // Truncate so deltas per-test are clean.
    await fs.writeFile(bootstrapLog, '').catch(() => {});
  });

  after(async function () {
    this.timeout(10_000);
    if (venv) { await venv.cleanup(); }
  });

  it('non-target argv ("pass") is a no-op in the bootstrap log', async function () {
    if (!venv) { this.skip(); return; }
    this.timeout(15_000);

    const snapshot = await readLogSafe(bootstrapLog);
    await perf.measure('python -c pass (bootstrap installed)', async () =>
      execFileAsync(venv!.python, ['-c', 'pass'], { timeout: 10_000 }),
    { group: 'bootstrap-gating' });

    const after = await readLogSafe(bootstrapLog);
    assert.strictEqual(
      stripBefore(after, snapshot),
      '',
      'bootstrap must not log anything for non-target processes',
    );
  });

  it('cold-start overhead is < 200ms for non-target processes', async function () {
    if (!venv || !basePython) { this.skip(); return; }
    this.timeout(30_000);

    // Baseline: the base python (no bootstrap) vs the venv python (bootstrap installed).
    // We want the delta to be small — if the gating check is slow, the delta grows.
    const base = await timeSamples(basePython, 5);
    const boot = await timeSamples(venv.python, 5);

    perf.measure('python -c pass (no bootstrap, median)', async () => base.median,
      { group: 'bootstrap-gating', meta: { samples: base.all } });
    perf.measure('python -c pass (with bootstrap, median)', async () => boot.median,
      { group: 'bootstrap-gating', meta: { samples: boot.all, deltaMs: boot.median - base.median } });
    await Promise.resolve();

    assert.ok(
      boot.median - base.median < 200,
      `bootstrap added ${boot.median - base.median}ms to cold start (base=${base.median}, boot=${boot.median}ms)`,
    );
  });

  it('target argv ("manage.py runserver") triggers bootstrap log entry', async function () {
    if (!venv) { this.skip(); return; }
    this.timeout(15_000);

    const snapshot = await readLogSafe(bootstrapLog);

    // Spawn the real fake manage.py — its argv matches the "manage.py runserver"
    // pattern, so _is_target_process() returns True and the bootstrap records a
    // "Bootstrap module loaded" line.
    let server: SpawnedProcess | null = null;
    const gatingPort = 49_883;
    try {
      server = await spawnFakeRunserver(venv.python, gatingPort);
      // Give the bootstrap's _dbg_log a moment to flush.
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      if (server) { await server.stop(); }
    }

    const after = await readLogSafe(bootstrapLog);
    const delta = stripBefore(after, snapshot);
    assert.ok(
      delta.includes('Bootstrap module loaded'),
      `expected bootstrap log entry for target argv, got:\n${delta || '(empty)'}`,
    );
    assert.ok(
      delta.includes('SIGUSR1+SIGUSR2 handlers installed'),
      `expected signal handlers to be installed, got:\n${delta || '(empty)'}`,
    );
  });
});

async function timeSamples(python: string, n: number): Promise<{ median: number; all: number[] }> {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = Date.now();
    await execFileAsync(python, ['-c', 'pass'], { timeout: 10_000 });
    samples.push(Date.now() - t);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return { median: sorted[Math.floor(n / 2)], all: samples };
}

async function readLogSafe(p: string): Promise<string> {
  try { return await fs.readFile(p, 'utf-8'); }
  catch { return ''; }
}

function stripBefore(after: string, before: string): string {
  if (after.startsWith(before)) { return after.slice(before.length); }
  return after;
}
