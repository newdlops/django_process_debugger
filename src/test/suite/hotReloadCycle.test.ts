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
 * Full write-request → Python reload → result-file cycle, with deep-reload
 * semantics matching the production bootstrap (`_deep_reload_module`).
 *
 * The hot_reload_harness.py fixture replicates the exact .reload/.reload.result
 * contract and the class-method in-place patching logic from the bootstrap.
 * The sampleapp fixtures capture references in the same shapes a real Django
 * or ASGI app does (URL conf dict, saved class, module indirection, async
 * coroutine) so each test demonstrates a specific reload scenario.
 */

interface Harness {
  child: ChildProcess;
  pid: number;
  call: (expr: string, timeoutMs?: number) => Promise<string>;
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
      if (pending.length > 0) {
        pending.shift()!(line);
      } else {
        stdoutQueue.push(line);
      }
      idx = stdoutBuf.indexOf('\n');
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[harness stderr pid=${child.pid}] ${chunk}`);
  });

  const readLine = (timeoutMs: number): Promise<string> => new Promise((resolve, reject) => {
    if (stdoutQueue.length > 0) {
      resolve(stdoutQueue.shift()!);
      return;
    }
    const timer = setTimeout(() => {
      const idx = pending.indexOf(resolver);
      if (idx >= 0) { pending.splice(idx, 1); }
      reject(new Error(`harness: no stdout line within ${timeoutMs}ms`));
    }, timeoutMs);
    const resolver = (line: string) => { clearTimeout(timer); resolve(line); };
    pending.push(resolver);
  });

  // Wait for READY.
  let pid = 0;
  const readyDeadline = Date.now() + 10_000;
  while (Date.now() < readyDeadline) {
    const line = await readLine(readyDeadline - Date.now());
    const m = line.match(/READY pid=(\d+)/);
    if (m) { pid = parseInt(m[1], 10); break; }
  }
  if (pid === 0) {
    throw new Error('harness: READY never seen');
  }

  const call = async (expr: string, timeoutMs = 3_000): Promise<string> => {
    child.stdin!.write(`CALL ${expr}\n`);
    const line = await readLine(timeoutMs);
    if (line.startsWith('OUT:')) { return line.slice(4); }
    if (line.startsWith('ERR:')) { throw new Error(`harness eval ${expr}: ${line.slice(4)}`); }
    throw new Error(`harness: unexpected line: ${line}`);
  };

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) { return; }
    child.stdin?.end();
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 2_000);
      child.on('exit', () => { clearTimeout(t); resolve(); });
    });
  };

  return { child, pid, call, stop };
}

async function pollForResult(pid: number, timeoutMs: number): Promise<string[] | null> {
  const injector = new DebugpyInjector();
  const resultFile = path.join(PORT_FILE_DIR, `${pid}.reload.result`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.access(resultFile);
      return await injector.readReloadResult(pid);
    } catch { /* not yet */ }
    await sleep(20);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Basic cycle: OK / SKIP / ERR / batch / latency
// (carries the original "Feature: hot reload full cycle" coverage)
// ---------------------------------------------------------------------------

describe('Feature: hot reload full cycle (harness)', function () {
  const perf = getPerf();
  const injector = new DebugpyInjector();
  const appDir = fixturesDir();
  const viewsPath = path.join(appDir, 'sampleapp', 'views.py');
  const modelsPath = path.join(appDir, 'sampleapp', 'models.py');
  const originalViews = fsSync.readFileSync(viewsPath, 'utf-8');
  const originalModels = fsSync.readFileSync(modelsPath, 'utf-8');

  let python: string | null;
  let harness: Harness | null = null;

  before(async function () {
    this.timeout(30_000);
    python = await findSystemPython();
    if (!python) { this.skip(); return; }

    await fs.mkdir(PORT_FILE_DIR, { recursive: true });
    harness = await startHarness(python, appDir, [
      'sampleapp.views',
      'sampleapp.models',
    ]);
  });

  after(async function () {
    this.timeout(10_000);
    await fs.writeFile(viewsPath, originalViews, 'utf-8');
    await fs.writeFile(modelsPath, originalModels, 'utf-8');
    if (harness) { await harness.stop(); }
    if (harness) {
      await fs.unlink(path.join(PORT_FILE_DIR, `${harness.pid}.reload`)).catch(() => {});
      await fs.unlink(path.join(PORT_FILE_DIR, `${harness.pid}.reload.result`)).catch(() => {});
    }
  });

  beforeEach(async function () {
    if (!harness) { this.skip(); return; }
    await fs.writeFile(viewsPath, originalViews, 'utf-8');
    await fs.writeFile(modelsPath, originalModels, 'utf-8');
    await fs.unlink(path.join(PORT_FILE_DIR, `${harness.pid}.reload`)).catch(() => {});
    await fs.unlink(path.join(PORT_FILE_DIR, `${harness.pid}.reload.result`)).catch(() => {});
  });

  it('reloads a modified module and reports OK', async function () {
    if (!harness) { this.skip(); return; }
    this.timeout(15_000);

    await fs.writeFile(viewsPath, originalViews.replace("'hello v1'", "'hello v2'"), 'utf-8');

    const result = await perf.measure('hot reload cycle (OK)', async () => {
      await injector.requestHotReload(harness!.pid, [viewsPath]);
      return pollForResult(harness!.pid, 3_000);
    }, { group: 'hotReload-e2e' });

    assert.ok(result, 'expected a result within 3s');
    assert.ok(
      result.some((r) => r.startsWith('OK:sampleapp.views')),
      `expected OK:sampleapp.views, got ${JSON.stringify(result)}`,
    );
  });

  it('reports SKIP for files not loaded as modules', async function () {
    if (!harness) { this.skip(); return; }
    this.timeout(10_000);

    const bogus = path.join(appDir, 'sampleapp', 'not_imported.py');
    await fs.writeFile(bogus, '# unreferenced\n', 'utf-8');
    try {
      const result = await perf.measure('hot reload cycle (SKIP)', async () => {
        await injector.requestHotReload(harness!.pid, [bogus]);
        return pollForResult(harness!.pid, 3_000);
      }, { group: 'hotReload-e2e' });

      assert.ok(result);
      assert.strictEqual(result.length, 1);
      assert.ok(result[0].startsWith('SKIP:'), `expected SKIP, got ${result[0]}`);
    } finally {
      await fs.unlink(bogus).catch(() => {});
    }
  });

  it('reports ERR when the reloaded module has a SyntaxError', async function () {
    if (!harness) { this.skip(); return; }
    this.timeout(10_000);

    await fs.writeFile(viewsPath, "def greet(:  # SyntaxError\n    return 'x'\n", 'utf-8');

    const result = await perf.measure('hot reload cycle (ERR)', async () => {
      await injector.requestHotReload(harness!.pid, [viewsPath]);
      return pollForResult(harness!.pid, 3_000);
    }, { group: 'hotReload-e2e' });

    assert.ok(result);
    assert.strictEqual(result.length, 1);
    assert.ok(result[0].startsWith('ERR:sampleapp.views'),
      `expected ERR:sampleapp.views, got ${result[0]}`);
  });

  it('reloads multiple files in a single request', async function () {
    if (!harness) { this.skip(); return; }
    this.timeout(15_000);

    await fs.writeFile(viewsPath, originalViews.replace("'hello v1'", "'hello v3'"), 'utf-8');
    await fs.writeFile(modelsPath, originalModels.replace("'v1'", "'v3'"), 'utf-8');

    const result = await perf.measure('hot reload cycle (batch 2)', async () => {
      await injector.requestHotReload(harness!.pid, [viewsPath, modelsPath]);
      return pollForResult(harness!.pid, 3_000);
    }, { group: 'hotReload-e2e' });

    assert.ok(result);
    const ok = result.filter((r) => r.startsWith('OK:'));
    assert.strictEqual(ok.length, 2, `expected 2 OK lines, got ${JSON.stringify(result)}`);
    assert.ok(ok.some((r) => r.startsWith('OK:sampleapp.views')));
    assert.ok(ok.some((r) => r.startsWith('OK:sampleapp.models')));
  });

  it('consumes the request file within the watcher poll interval', async function () {
    if (!harness) { this.skip(); return; }
    this.timeout(5_000);

    const reloadFile = path.join(PORT_FILE_DIR, `${harness.pid}.reload`);

    await perf.measure('hot reload cycle (file unlink latency)', async () => {
      await injector.requestHotReload(harness!.pid, [viewsPath]);
      const start = Date.now();
      while (Date.now() - start < 2_000) {
        try { await fs.access(reloadFile); } catch { return; }
        await sleep(20);
      }
      throw new Error('request file was never consumed');
    }, { group: 'hotReload-e2e' });
  });

  it('full edit → result round-trip latency is under 500ms', async function () {
    if (!harness) { this.skip(); return; }
    this.timeout(10_000);

    await fs.writeFile(viewsPath, originalViews.replace("'hello v1'", "'hello v4'"), 'utf-8');

    const t0 = Date.now();
    await injector.requestHotReload(harness.pid, [viewsPath]);
    const result = await pollForResult(harness.pid, 2_000);
    const elapsed = Date.now() - t0;

    perf.measure('hot reload cycle (e2e latency)', async () => elapsed,
      { group: 'hotReload-e2e', meta: { elapsedMs: elapsed } });
    await Promise.resolve();

    assert.ok(result, 'no result');
    assert.ok(result.some((r) => r.startsWith('OK:sampleapp.views')));
    assert.ok(elapsed < 500, `hot reload round-trip too slow: ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// Reference semantics — mirrors Django/ASGI capture patterns. Each case
// documents a SCENARIO with explicit "works" / "does NOT work" expectations.
// ---------------------------------------------------------------------------

describe('Feature: hot reload reference semantics (Django/ASGI scenarios)', function () {
  const perf = getPerf();
  const injector = new DebugpyInjector();
  const appDir = fixturesDir();
  const viewsPath = path.join(appDir, 'sampleapp', 'views.py');
  const urlsPath = path.join(appDir, 'sampleapp', 'urls.py');
  const originalViews = fsSync.readFileSync(viewsPath, 'utf-8');

  let python: string | null;
  let harness: Harness | null = null;

  before(async function () {
    this.timeout(30_000);
    python = await findSystemPython();
    if (!python) { this.skip(); return; }

    await fs.mkdir(PORT_FILE_DIR, { recursive: true });
    harness = await startHarness(python, appDir, [
      'sampleapp.views',
      'sampleapp.urls',
    ]);
  });

  after(async function () {
    this.timeout(10_000);
    await fs.writeFile(viewsPath, originalViews, 'utf-8');
    if (harness) { await harness.stop(); }
  });

  beforeEach(async function () {
    if (!harness) { this.skip(); return; }
    // Reset disk AND in-memory state so test order doesn't matter. Reload
    // BOTH modules — reloading urls.py re-captures the fresh references
    // (URLCONF dict, SAVED_CLASS) from the reset views.py.
    await fs.writeFile(viewsPath, originalViews, 'utf-8');
    await injector.requestHotReload(harness.pid, [viewsPath, urlsPath]);
    await pollForResult(harness.pid, 3_000);
  });

  it('WORKS: class method deep-reload propagates to externally held class refs', async function () {
    if (!harness) { this.skip(); return; }
    this.timeout(15_000);

    const before = await harness.call('urls.call_saved_class()');
    assert.strictEqual(before, "'IndexView.get v1'");

    // Edit the method body so deep-reload must patch __code__ in place.
    await fs.writeFile(
      viewsPath,
      originalViews.replace("'IndexView.get v1'", "'IndexView.get v2'"),
      'utf-8',
    );

    const result = await perf.measure('hot reload cycle (class patch)', async () => {
      await injector.requestHotReload(harness!.pid, [viewsPath]);
      return pollForResult(harness!.pid, 3_000);
    }, { group: 'hotReload-e2e' });

    assert.ok(result, 'expected a result');
    const okLine = result.find((r) => r.startsWith('OK:sampleapp.views'));
    assert.ok(okLine, `no OK line, got ${JSON.stringify(result)}`);
    assert.ok(
      okLine.includes('patched: ') && okLine.includes('IndexView.get'),
      `expected "patched: IndexView.get" in OK line, got: ${okLine}`,
    );

    // urls.SAVED_CLASS points to the OLD class object (captured before reload).
    // Its .get method is the SAME function object we held before reload, whose
    // __code__ has been swapped in place by deep-reload.
    const afterSaved = await harness.call('urls.call_saved_class()');
    assert.strictEqual(afterSaved, "'IndexView.get v2'",
      'externally held class ref should see new method body via in-place __code__ patch');
  });

  it('WORKS: module-indirected function call sees updated code', async function () {
    if (!harness) { this.skip(); return; }
    this.timeout(15_000);

    const before = await harness.call('urls.call_module_fn()');
    assert.strictEqual(before, "'direct v1'");

    await fs.writeFile(
      viewsPath,
      originalViews.replace("'direct v1'", "'direct indirect'"),
      'utf-8',
    );
    await injector.requestHotReload(harness.pid, [viewsPath]);
    const result = await pollForResult(harness.pid, 3_000);
    assert.ok(result?.some((r) => r.startsWith('OK:sampleapp.views')));

    // MODULE.greet() re-resolves `greet` through the reloaded views module,
    // so it picks up the new function.
    const after = await harness.call('urls.call_module_fn()');
    assert.strictEqual(after, "'direct indirect'",
      'module.greet() re-looks-up greet, so it binds to the reloaded function');
  });

  it('WORKS: top-level function captured in dict sees new code (production bootstrap patches __code__ on the original object)', async function () {
    if (!harness) { this.skip(); return; }
    this.timeout(15_000);

    // This is the Django URL-conf case: URLCONF = {'/': greet} captured the
    // original greet function object. The production bootstrap keeps a
    // reference to every ORIGINAL module-level function at first reload and
    // patches its __code__ in place on every subsequent reload, so callers
    // holding the same function object (like our URLCONF dict) run the
    // new body without needing urls.py to be touched.
    //
    // NOTE: this used to be documented as a LIMITATION of plain importlib.
    // reload — it still is, but the bootstrap adds a layer on top that
    // solves it for module-level functions. See
    // `_original_mod_funcs` in makeBootstrapScript.
    const before = await harness.call('urls.call_urlconf()');
    assert.strictEqual(before, "'direct v1'");

    await fs.writeFile(
      viewsPath,
      originalViews.replace("'direct v1'", "'direct via-code-patch'"),
      'utf-8',
    );
    await injector.requestHotReload(harness.pid, [viewsPath]);
    const result = await pollForResult(harness.pid, 3_000);
    assert.ok(result?.some((r) => r.startsWith('OK:sampleapp.views')));

    const afterViewsOnly = await harness.call('urls.call_urlconf()');
    assert.strictEqual(afterViewsOnly, "'direct via-code-patch'",
      'URLCONF dict holds the ORIGINAL greet object; bootstrap patches that object in place');
  });

  it('LIMITATION: top-level constants rebound but prior by-value copies are stale', async function () {
    if (!harness) { this.skip(); return; }
    this.timeout(10_000);

    // Capture the constant's string value NOW (stored as a separate object).
    await harness.call('globals().__setitem__("saved_greeting", views.GREETING)');
    const before = await harness.call('saved_greeting');
    assert.strictEqual(before, "'hello v1'");

    await fs.writeFile(
      viewsPath,
      originalViews.replace("'hello v1'", "'hello changed'"),
      'utf-8',
    );
    await injector.requestHotReload(harness.pid, [viewsPath]);
    await pollForResult(harness.pid, 3_000);

    const reboundViaModule = await harness.call('views.GREETING');
    assert.strictEqual(reboundViaModule, "'hello changed'",
      'accessing via the module attribute sees the rebind');

    const staleCopy = await harness.call('saved_greeting');
    assert.strictEqual(staleCopy, "'hello v1'",
      'the previously captured string is by-value and cannot be retroactively updated');
  });

  it('ASGI: async handler — next call sees new code, captured coroutine does not', async function () {
    if (!harness) { this.skip(); return; }
    this.timeout(15_000);

    // In uvicorn/daphne, a coroutine can already be in-flight when reload
    // happens. Its compiled code object is fixed at the moment the coroutine
    // was created — reload of the source file cannot retroactively change it.
    await harness.call('globals().__setitem__("captured_coro", views.handle())');

    await fs.writeFile(
      viewsPath,
      originalViews.replace("'handle v1'", "'handle v2'"),
      'utf-8',
    );
    await injector.requestHotReload(harness.pid, [viewsPath]);
    const result = await pollForResult(harness.pid, 3_000);
    assert.ok(result?.some((r) => r.startsWith('OK:sampleapp.views')));

    const runNew = `__import__('asyncio').new_event_loop().run_until_complete(views.handle())`;
    const newResult = await harness.call(runNew);
    assert.strictEqual(newResult, "'handle v2'",
      'a fresh views.handle() call creates a coroutine from the reloaded body');

    const runOld = `__import__('asyncio').new_event_loop().run_until_complete(captured_coro)`;
    const oldResult = await harness.call(runOld);
    assert.strictEqual(oldResult, "'handle v1'",
      'captured coroutine runs the compiled function it was created from — reload cannot retroactively change it');
  });
});

// ---------------------------------------------------------------------------
// Worker isolation — the uvicorn/gunicorn multi-worker story.
// Reloading one worker process must not affect another (and vice versa).
// ---------------------------------------------------------------------------

describe('Feature: hot reload multi-worker isolation', function () {
  const perf = getPerf();
  const injector = new DebugpyInjector();
  const appDir = fixturesDir();
  const viewsPath = path.join(appDir, 'sampleapp', 'views.py');
  const originalViews = fsSync.readFileSync(viewsPath, 'utf-8');

  let python: string | null;
  let workerA: Harness | null = null;
  let workerB: Harness | null = null;

  before(async function () {
    this.timeout(45_000);
    python = await findSystemPython();
    if (!python) { this.skip(); return; }

    await fs.mkdir(PORT_FILE_DIR, { recursive: true });
    workerA = await startHarness(python, appDir, ['sampleapp.views']);
    workerB = await startHarness(python, appDir, ['sampleapp.views']);
  });

  after(async function () {
    this.timeout(15_000);
    await fs.writeFile(viewsPath, originalViews, 'utf-8');
    if (workerA) { await workerA.stop(); }
    if (workerB) { await workerB.stop(); }
  });

  it('reloads exactly the worker addressed by pid', async function () {
    if (!workerA || !workerB) { this.skip(); return; }
    this.timeout(15_000);

    const beforeA = await workerA.call('views.greet()');
    const beforeB = await workerB.call('views.greet()');
    assert.strictEqual(beforeA, "'direct v1'");
    assert.strictEqual(beforeB, "'direct v1'");

    await fs.writeFile(
      viewsPath,
      originalViews.replace("'direct v1'", "'direct workerA-only'"),
      'utf-8',
    );

    // Address only worker A.
    const result = await perf.measure('hot reload cycle (worker A only)', async () => {
      await injector.requestHotReload(workerA!.pid, [viewsPath]);
      return pollForResult(workerA!.pid, 3_000);
    }, { group: 'hotReload-e2e' });
    assert.ok(result?.some((r) => r.startsWith('OK:sampleapp.views')));

    const afterA = await workerA.call('views.greet()');
    const afterB = await workerB.call('views.greet()');

    assert.strictEqual(afterA, "'direct workerA-only'",
      'targeted worker must see the new code');
    assert.strictEqual(afterB, "'direct v1'",
      'untargeted worker must NOT change — each process has its own import state');

    // Production UX implication: in a multi-worker deployment
    // (uvicorn --workers N, gunicorn, daphne workers, celery multi-worker),
    // hot-reloading via signal/file only affects the worker the user attached
    // to. Other workers still serve old code. See optimization.md
    // "hot reload scenarios" matrix.
  });

  it('requesting reload for an unattached worker pid does NOT cross-contaminate', async function () {
    if (!workerA || !workerB) { this.skip(); return; }
    this.timeout(10_000);

    // Write a reload request for a pid that doesn't have a harness.
    const bogusPid = 999_999;
    await injector.requestHotReload(bogusPid, [viewsPath]);

    // Neither worker should consume it.
    await sleep(300);

    const reloadFile = path.join(PORT_FILE_DIR, `${bogusPid}.reload`);
    let stillThere = false;
    try { await fs.access(reloadFile); stillThere = true; } catch { /* consumed or missing */ }
    assert.strictEqual(stillThere, true,
      'the bogus-pid reload file should still be there since no harness watches it');

    await fs.unlink(reloadFile).catch(() => {});
  });
});
