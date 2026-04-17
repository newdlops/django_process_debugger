import * as assert from 'assert';
import { describe, it, before, after, beforeEach } from 'mocha';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { DebugpyInjector } from '../../debugpyInjector';
import { getPerf } from './perfReporter';
import { findSystemPython, fixturesDir } from './testHelpers';

const PORT_FILE_DIR = '/tmp/django-process-debugger';

/**
 * Tests for three production bugs found by analyzing log.txt from a real
 * Django + graphene-django ASGI server debugging session:
 *
 *   (1) Breakpoint deadlock — while debugpy had allThreadsStopped=true, the
 *       Python reload-watcher thread was frozen. The extension's fixed 1s
 *       wait in flushHotReload() timed out, so reload requests silently
 *       disappeared from the UI even though the .reload file stayed queued
 *       on disk (log.txt:311 request has no matching "Results:" line).
 *
 *   (2) Decorator closures keep pre-reload code — every GraphQL resolver in
 *       the user's code is wrapped by @company_owner_required / @login_required
 *       etc. Patching only the wrapper's __code__ doesn't change the wrapper's
 *       closure, which still points at the pre-reload inner function. The
 *       reload reported OK but behavior was stale.
 *
 *   (3) Imported symbols polluted the patched list — `TypedDict`, `cast`,
 *       `company_owner_required`, `ItemNotFound`, `TypedField` etc. all
 *       appeared in the (patched: ...) line because _deep_reload_module
 *       scanned the whole module dict without filtering __module__.
 *
 * These tests drive the harness in the same shapes, confirming each fix.
 */

interface Harness {
  child: ChildProcess;
  pid: number;
  call: (expr: string, timeoutMs?: number) => Promise<string>;
  sendCommand: (cmd: string, timeoutMs?: number) => Promise<string>;
  stop: () => Promise<void>;
}

async function startHarness(python: string, appDir: string, modules: string[]): Promise<Harness> {
  const harnessPath = path.join(appDir, 'hot_reload_harness.py');
  const child = spawn(python, [harnessPath, appDir, ...modules], {
    cwd: appDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });

  const stdoutQueue: string[] = [];
  const pending: Array<(line: string) => void> = [];
  let stdoutBuf = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    let idx = stdoutBuf.indexOf('\n');
    while (idx >= 0) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (pending.length > 0) { pending.shift()!(line); }
      else { stdoutQueue.push(line); }
      idx = stdoutBuf.indexOf('\n');
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[harness stderr pid=${child.pid}] ${chunk}`);
  });

  const readLine = (timeoutMs: number): Promise<string> => new Promise((resolve, reject) => {
    if (stdoutQueue.length > 0) { resolve(stdoutQueue.shift()!); return; }
    const timer = setTimeout(() => {
      const idx = pending.indexOf(resolver);
      if (idx >= 0) { pending.splice(idx, 1); }
      reject(new Error(`harness: no stdout line within ${timeoutMs}ms`));
    }, timeoutMs);
    const resolver = (line: string) => { clearTimeout(timer); resolve(line); };
    pending.push(resolver);
  });

  let pid = 0;
  const readyDeadline = Date.now() + 10_000;
  while (Date.now() < readyDeadline) {
    const line = await readLine(readyDeadline - Date.now());
    const m = line.match(/READY pid=(\d+)/);
    if (m) { pid = parseInt(m[1], 10); break; }
  }
  if (pid === 0) { throw new Error('harness: READY never seen'); }

  const sendCommand = async (cmd: string, timeoutMs = 3_000): Promise<string> => {
    child.stdin!.write(`${cmd}\n`);
    const line = await readLine(timeoutMs);
    if (line.startsWith('OUT:')) { return line.slice(4); }
    if (line.startsWith('ERR:')) { throw new Error(`harness ${cmd}: ${line.slice(4)}`); }
    throw new Error(`harness: unexpected line: ${line}`);
  };
  const call = (expr: string, timeoutMs = 3_000) => sendCommand(`CALL ${expr}`, timeoutMs);

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) { return; }
    child.stdin?.end();
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 2_000);
      child.on('exit', () => { clearTimeout(t); resolve(); });
    });
  };

  return { child, pid, call, sendCommand, stop };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Bug 1: Breakpoint deadlock — reload queued when watcher can't run.
// ---------------------------------------------------------------------------

describe('Feature: hot reload breakpoint-deadlock recovery (log.txt bug #1)', function () {
  const perf = getPerf();
  const injector = new DebugpyInjector();
  const appDir = fixturesDir();
  const viewsPath = path.join(appDir, 'sampleapp', 'views.py');
  const originalViews = fsSync.readFileSync(viewsPath, 'utf-8');

  let python: string | null;
  let harness: Harness | null = null;

  before(async function () {
    this.timeout(30_000);
    python = await findSystemPython();
    if (!python) { this.skip(); return; }

    await fs.mkdir(PORT_FILE_DIR, { recursive: true });
    harness = await startHarness(python, appDir, ['sampleapp.views']);
  });

  after(async function () {
    this.timeout(10_000);
    await fs.writeFile(viewsPath, originalViews, 'utf-8');
    if (harness) {
      // Make sure watcher is not paused before shutdown.
      await harness.sendCommand('RESUME_WATCHER').catch(() => {});
      await harness.stop();
    }
  });

  beforeEach(async function () {
    if (!harness) { this.skip(); return; }
    await harness.sendCommand('RESUME_WATCHER').catch(() => {});
    await fs.writeFile(viewsPath, originalViews, 'utf-8');
    await fs.unlink(path.join(PORT_FILE_DIR, `${harness.pid}.reload`)).catch(() => {});
    await fs.unlink(path.join(PORT_FILE_DIR, `${harness.pid}.reload.result`)).catch(() => {});
  });

  it('short poll returns null when watcher is frozen (reproduces the 1s-timeout bug)', async function () {
    if (!harness) { this.skip(); return; }
    this.timeout(10_000);

    await harness.sendCommand('PAUSE_WATCHER');
    await fs.writeFile(viewsPath, originalViews.replace("'hello v1'", "'frozen'"), 'utf-8');
    await injector.requestHotReload(harness.pid, [viewsPath]);

    // Old behavior (1s fixed wait) would fall through here with no result.
    const earlyResult = await injector.pollReloadResult(harness.pid, 1_000);
    assert.strictEqual(earlyResult, null,
      'with watcher paused, no result should arrive within 1s');

    const stillPending = await injector.isReloadPending(harness.pid);
    assert.strictEqual(stillPending, true,
      'the .reload request file must remain on disk — this is how the extension knows the reload is queued rather than lost');
  });

  it('long poll delivers the result once the watcher resumes', async function () {
    if (!harness) { this.skip(); return; }
    this.timeout(15_000);

    await harness.sendCommand('PAUSE_WATCHER');
    await fs.writeFile(viewsPath, originalViews.replace("'hello v1'", "'unfrozen'"), 'utf-8');
    await injector.requestHotReload(harness.pid, [viewsPath]);

    // Start a long-poll in the background — the fix makes the extension do
    // this after the short poll sees a pending request + paused session.
    const pollPromise = perf.measure('reload cycle (queued then resumed)', async () =>
      injector.pollReloadResult(harness!.pid, 10_000),
    { group: 'hotReload-prod-bugs' });

    // Simulate the user clicking Continue a moment later.
    await sleep(300);
    await harness.sendCommand('RESUME_WATCHER');

    const results = await pollPromise;
    assert.ok(results, 'expected result after RESUME_WATCHER');
    assert.ok(
      results.some((r) => r.startsWith('OK:sampleapp.views')),
      `expected OK line, got ${JSON.stringify(results)}`,
    );
  });

  it('reload request file is cleared after the watcher consumes it', async function () {
    if (!harness) { this.skip(); return; }
    this.timeout(10_000);

    await fs.writeFile(viewsPath, originalViews.replace("'hello v1'", "'post-resume'"), 'utf-8');
    await injector.requestHotReload(harness.pid, [viewsPath]);
    const results = await injector.pollReloadResult(harness.pid, 3_000);
    assert.ok(results, 'result should arrive');

    const pending = await injector.isReloadPending(harness.pid);
    assert.strictEqual(pending, false,
      'the request file must be removed once the watcher has processed it');
  });
});

// ---------------------------------------------------------------------------
// Bug 2: Decorator closures keep pre-reload code.
// ---------------------------------------------------------------------------

describe('Feature: decorator-wrapped method reload via __wrapped__ chain (log.txt bug #2)', function () {
  const perf = getPerf();
  const injector = new DebugpyInjector();
  const appDir = fixturesDir();
  const decoratedPath = path.join(appDir, 'sampleapp', 'decorated.py');
  const originalDecorated = fsSync.readFileSync(decoratedPath, 'utf-8');

  let python: string | null;
  let harness: Harness | null = null;

  before(async function () {
    this.timeout(30_000);
    python = await findSystemPython();
    if (!python) { this.skip(); return; }

    await fs.mkdir(PORT_FILE_DIR, { recursive: true });
    harness = await startHarness(python, appDir, ['sampleapp.decorated']);
  });

  after(async function () {
    this.timeout(10_000);
    await fs.writeFile(decoratedPath, originalDecorated, 'utf-8');
    if (harness) { await harness.stop(); }
  });

  beforeEach(async function () {
    if (!harness) { this.skip(); return; }
    await fs.writeFile(decoratedPath, originalDecorated, 'utf-8');
    await injector.requestHotReload(harness.pid, [decoratedPath]);
    await injector.pollReloadResult(harness.pid, 3_000);
  });

  it('decorated top-level function: reload propagates through the wrapper closure', async function () {
    if (!harness) { this.skip(); return; }
    this.timeout(15_000);

    // Capture the wrapper reference BEFORE reload, mirroring what Django's
    // URL resolver / graphene-django's schema does with resolver functions.
    await harness.call('globals().__setitem__("saved_wrapper", decorated.top_level)');
    assert.strictEqual(await harness.call('saved_wrapper()'), "'top v1'");

    await fs.writeFile(
      decoratedPath,
      originalDecorated.replace("'top v1'", "'top v2-via-closure'"),
      'utf-8',
    );
    const results = await perf.measure('decorator unwrap reload', async () => {
      await injector.requestHotReload(harness!.pid, [decoratedPath]);
      return injector.pollReloadResult(harness!.pid, 3_000);
    }, { group: 'hotReload-prod-bugs' });

    assert.ok(results, 'expected reload result');
    const okLine = results.find((r) => r.startsWith('OK:sampleapp.decorated'));
    assert.ok(okLine, `no OK line: ${JSON.stringify(results)}`);

    // The fix makes _deep_reload_module follow __wrapped__ and patch the
    // innermost function. The patched list should reflect the unwrap step.
    assert.ok(
      okLine.includes('top_level') && okLine.includes('unwrapped'),
      `expected "(+N unwrapped)" suffix for top_level, got: ${okLine}`,
    );

    // The saved wrapper — held externally — now delegates to the patched
    // inner function and returns new code.
    const afterWrapper = await harness.call('saved_wrapper()');
    assert.strictEqual(afterWrapper, "'top v2-via-closure'",
      'BEFORE the fix this returned "top v1" because the wrapper closure captured the old inner function. With __wrapped__ unwrap, the inner is patched in place.');
  });

  it('decorated class method: reload propagates to externally held instance', async function () {
    if (!harness) { this.skip(); return; }
    this.timeout(15_000);

    // Instance captured before reload — simulates Django holding a
    // class-based view or graphene holding a resolver map.
    await harness.call('globals().__setitem__("saved_view", decorated.DecoratedView())');
    assert.strictEqual(await harness.call('saved_view.render()'), "'render v1'");

    await fs.writeFile(
      decoratedPath,
      originalDecorated.replace("'render v1'", "'render v2-via-closure'"),
      'utf-8',
    );
    await injector.requestHotReload(harness.pid, [decoratedPath]);
    const results = await injector.pollReloadResult(harness.pid, 3_000);

    const okLine = results?.find((r) => r.startsWith('OK:sampleapp.decorated'));
    assert.ok(okLine, `no OK line: ${JSON.stringify(results)}`);
    assert.ok(
      okLine.includes('DecoratedView.render') && okLine.includes('unwrapped'),
      `expected DecoratedView.render unwrap in patched list, got: ${okLine}`,
    );

    const after = await harness.call('saved_view.render()');
    assert.strictEqual(after, "'render v2-via-closure'",
      'externally held instance should see new code through the wrapper');
  });
});

// ---------------------------------------------------------------------------
// Bug 3: Imported symbols show up as "patched" (misleading log).
// ---------------------------------------------------------------------------

describe('Feature: deep-reload skips imported symbols (log.txt bug #3)', function () {
  const injector = new DebugpyInjector();
  const appDir = fixturesDir();
  const modPath = path.join(appDir, 'sampleapp', 'imports_from_elsewhere.py');
  const originalMod = fsSync.readFileSync(modPath, 'utf-8');

  let python: string | null;
  let harness: Harness | null = null;

  before(async function () {
    this.timeout(30_000);
    python = await findSystemPython();
    if (!python) { this.skip(); return; }

    await fs.mkdir(PORT_FILE_DIR, { recursive: true });
    harness = await startHarness(python, appDir, ['sampleapp.imports_from_elsewhere']);
  });

  after(async function () {
    this.timeout(10_000);
    await fs.writeFile(modPath, originalMod, 'utf-8');
    if (harness) { await harness.stop(); }
  });

  it('patched list only contains symbols defined in THIS module', async function () {
    if (!harness) { this.skip(); return; }
    this.timeout(15_000);

    await fs.writeFile(modPath, originalMod.replace("'my v1'", "'my v2'"), 'utf-8');
    await injector.requestHotReload(harness.pid, [modPath]);
    const results = await injector.pollReloadResult(harness.pid, 3_000);

    const okLine = results?.find((r) => r.startsWith('OK:sampleapp.imports_from_elsewhere'));
    assert.ok(okLine, `no OK line: ${JSON.stringify(results)}`);

    // Parse the patched list out of "OK:name (patched: a, b, c)".
    const match = okLine.match(/\(patched: (.+?)\)$/);
    const patched = match ? match[1].split(/,\s*/).map((s) => s.replace(/\s*\(\+\d+ unwrapped\)$/, '')) : [];

    // Must include locally-defined things.
    assert.ok(patched.includes('my_function'),
      `expected my_function in patched list, got: ${JSON.stringify(patched)}`);
    assert.ok(patched.some((p) => p.startsWith('MyOwnClass.')),
      `expected MyOwnClass.* in patched list, got: ${JSON.stringify(patched)}`);

    // Must NOT include imports. These are the exact leaks seen in log.txt's
    // real result file (TypedDict, cast, company_owner_required, etc).
    const leaked = ['TypedDict', 'cast', 'decorate', 'DecoratedView']
      .filter((name) => patched.some((p) => p === name || p.startsWith(`${name}.`)));
    assert.deepStrictEqual(leaked, [],
      `imported symbols must NOT appear in the patched list — they are still in the log output, which was the source of confusion in the real log.txt`);
  });
});
