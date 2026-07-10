import * as assert from 'assert';
import { describe, it, before, after } from 'mocha';
import { execFile, spawn } from 'child_process';
import { once } from 'events';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  BootstrapNotLoadedError,
  BootstrapRuntimeVersionError,
  DebugEngineConflictError,
  DebugpyInjector,
  BOOTSTRAP_VERSION,
} from '../../debugpyInjector';
import { getPerf } from './perfReporter';
import { findSystemPython, projectRoot } from './testHelpers';

const execFileAsync = promisify(execFile);

describe('Feature: debugpy injector bootstrap lifecycle', function () {
  const perf = getPerf();
  const injector = new DebugpyInjector();
  const vendored = path.join(projectRoot(), 'vendor', 'python');
  let tmpDir: string;
  let sitePackages: string;

  before(async function () {
    injector.setBundledDebugpyPath(vendored);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dpd-inj-'));
    sitePackages = path.join(tmpDir, 'site-packages');
    await fs.mkdir(sitePackages, { recursive: true });
  });

  after(async function () {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('installs bootstrap and tracer assets into a fake site-packages', async function () {
    await perf.measure('installBootstrap', async () => {
      await injector.installBootstrap(sitePackages);
    }, { group: 'injector' });

    await assert.doesNotReject(fs.access(path.join(sitePackages, 'django_process_debugger.pth')));
    await assert.doesNotReject(fs.access(path.join(sitePackages, '_django_debug_bootstrap.py')));
    await assert.doesNotReject(fs.access(path.join(sitePackages, '_django_debug_tracer.py')));
  });

  it('isBootstrapInstalled returns true after install', async function () {
    const installed = await perf.measure('isBootstrapInstalled', async () =>
      injector.isBootstrapInstalled(sitePackages),
    { group: 'injector' });
    assert.strictEqual(installed, true);
  });

  it('isBootstrapUpToDate returns true for current version', async function () {
    const upToDate = await perf.measure('isBootstrapUpToDate', async () =>
      injector.isBootstrapUpToDate(sitePackages),
    { group: 'injector' });
    assert.strictEqual(upToDate, true);
  });

  it('isBootstrapUpToDate detects an older version', async function () {
    const modPath = path.join(sitePackages, '_django_debug_bootstrap.py');
    const original = await fs.readFile(modPath, 'utf-8');
    await fs.writeFile(modPath, original.replace(BOOTSTRAP_VERSION, '1970.01.01'));
    try {
      const upToDate = await injector.isBootstrapUpToDate(sitePackages);
      assert.strictEqual(upToDate, false);
    } finally {
      await fs.writeFile(modPath, original);
    }
  });

  it('keeps legacy installs detectable but marks a missing tracer as outdated', async function () {
    const tracerPath = path.join(sitePackages, '_django_debug_tracer.py');
    const original = await fs.readFile(tracerPath);
    await fs.unlink(tracerPath);
    try {
      assert.strictEqual(await injector.isBootstrapInstalled(sitePackages), true);
      assert.strictEqual(await injector.isBootstrapUpToDate(sitePackages), false);
    } finally {
      await fs.writeFile(tracerPath, original);
    }
  });

  it('isBootstrapUpToDate detects tracer asset drift', async function () {
    const tracerPath = path.join(sitePackages, '_django_debug_tracer.py');
    const original = await fs.readFile(tracerPath);
    await fs.appendFile(tracerPath, '\n# stale test copy\n');
    try {
      assert.strictEqual(await injector.isBootstrapUpToDate(sitePackages), false);
    } finally {
      await fs.writeFile(tracerPath, original);
    }
  });

  it('generated bootstrap supports versioned and legacy activation requests', async function () {
    const content = await fs.readFile(
      path.join(sitePackages, '_django_debug_bootstrap.py'),
      'utf-8',
    );
    assert.ok(content.includes('int(_request_content)'), 'legacy integer request parser missing');
    assert.ok(content.includes('unsupported activation request version'));
    assert.ok(content.includes('.experimental.active'));
    assert.ok(content.includes('_experimental_tracer.start("127.0.0.1", _port)'));
    assert.ok(content.includes('owns this PID until restart'));
    assert.ok(content.includes('register_at_fork'));
  });

  it('keeps legacy active records debugpy-only and isolates tagged engines', function () {
    const parseActiveFile = (injector as unknown as {
      parseActiveFile(
        content: string,
        engine?: 'debugpy' | 'experimental',
      ): { host?: string; port: number } | null;
    }).parseActiveFile.bind(injector);

    assert.deepStrictEqual(parseActiveFile('5678', 'debugpy'), { port: 5678 });
    assert.strictEqual(parseActiveFile('5678', 'experimental'), null);

    const legacyJson = JSON.stringify({ host: '127.0.0.1', port: 5679 });
    assert.deepStrictEqual(parseActiveFile(legacyJson, 'debugpy'), {
      host: '127.0.0.1',
      port: 5679,
    });
    assert.strictEqual(parseActiveFile(legacyJson, 'experimental'), null);

    const experimentalJson = JSON.stringify({
      version: 1,
      engine: 'experimental',
      host: '127.0.0.1',
      port: 5680,
    });
    assert.strictEqual(parseActiveFile(experimentalJson, 'debugpy'), null);
    assert.deepStrictEqual(parseActiveFile(experimentalJson, 'experimental'), {
      host: '127.0.0.1',
      port: 5680,
    });
  });

  it('generated bootstrap and tracer assets are syntactically valid Python', async function () {
    this.timeout(15_000);
    const python = await findSystemPython();
    if (!python) { this.skip(); return; }

    const modPath = path.join(sitePackages, '_django_debug_bootstrap.py');
    const tracerPath = path.join(sitePackages, '_django_debug_tracer.py');
    await perf.measure('python -m py_compile bootstrap', async () => {
      await execFileAsync(python, ['-m', 'py_compile', modPath, tracerPath], { timeout: 10_000 });
    }, { group: 'injector' });
  });

  it('resolveSitePackages works on the system python', async function () {
    this.timeout(15_000);
    const python = await findSystemPython();
    if (!python) { this.skip(); return; }

    const resolved = await perf.measure('resolveSitePackages', async () =>
      injector.resolveSitePackages(python),
    { group: 'injector' });

    assert.ok(resolved.length > 0, 'site-packages should not be empty');
    assert.ok(resolved.includes('site-packages') || resolved.includes('lib'),
      `unexpected site-packages: ${resolved}`);
  });

  it('resolvePythonForPid returns a path for the current process', async function () {
    this.timeout(10_000);
    const resolved = await perf.measure('resolvePythonForPid (self)', async () =>
      injector.resolvePythonForPid(process.pid),
    { group: 'injector' });

    assert.ok(resolved.length > 0);
  });

  it('getActivePort returns null when bootstrap has not activated', async function () {
    const result = await injector.getActivePort(999_999);
    assert.strictEqual(result, null);
  });

  it('BootstrapNotLoadedError reports the signal that was sent', function () {
    const err = new BootstrapNotLoadedError(1234, 5678, 'SIGUSR2');
    assert.ok(err.message.includes('Sent SIGUSR2 to PID 1234'));
  });

  it('BootstrapNotLoadedError identifies the selected engine', function () {
    const err = new BootstrapNotLoadedError(1234, 5678, 'SIGUSR1', 'experimental');
    assert.ok(err.message.includes('experimental did not start listening'));
  });

  it('DebugEngineConflictError requires a restart before switching engines', function () {
    const err = new DebugEngineConflictError(
      1234,
      'experimental',
      'debugpy',
      { host: '127.0.0.1', port: 5678 },
    );
    assert.ok(err.message.includes('debugpy is already active'));
    assert.ok(err.message.includes('Restart the target process'));
  });

  it('activateEndpoint refuses to start a second engine in the same process', async function () {
    const conflictInjector = new DebugpyInjector();
    conflictInjector.getActiveEndpoint = async (_pid, engine = 'debugpy') =>
      engine === 'debugpy' ? { host: '127.0.0.1', port: 5678 } : null;

    await assert.rejects(
      conflictInjector.activateEndpoint(process.pid, 5679, 'experimental'),
      (err: unknown) => err instanceof DebugEngineConflictError &&
        err.requestedEngine === 'experimental' && err.activeEngine === 'debugpy',
    );
  });

  it('BootstrapRuntimeVersionError explains that the target must restart', function () {
    const err = new BootstrapRuntimeVersionError(1234, null, BOOTSTRAP_VERSION);
    assert.ok(err.message.includes('Restart the target process after setup'));
  });

  it('accepts bootstrap runtime state inherited from a parent process', async function () {
    this.timeout(10_000);

    const stateDir = '/tmp/django-process-debugger';
    const statePath = path.join(stateDir, `${process.pid}.bootstrap.json`);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      stdio: 'ignore',
    });

    try {
      assert.ok(child.pid, 'child pid should be available');
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        statePath,
        JSON.stringify({ version: BOOTSTRAP_VERSION, pid: process.pid }),
        'utf-8',
      );

      const state = await (injector as unknown as {
        getLoadedBootstrapState(pid: number): Promise<{ pid: number; version: string } | null>;
      }).getLoadedBootstrapState(child.pid);

      assert.deepStrictEqual(state, { pid: process.pid, version: BOOTSTRAP_VERSION });
    } finally {
      await fs.unlink(statePath).catch(() => {});
      if (child.pid && !child.killed) {
        child.kill();
      }
      if (child.exitCode === null) {
        await once(child, 'exit').catch(() => {});
      }
    }
  });

  it('reads optional engine capabilities from bootstrap runtime state', async function () {
    const stateDir = '/tmp/django-process-debugger';
    const statePath = path.join(stateDir, `${process.pid}.bootstrap.json`);
    try {
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        statePath,
        JSON.stringify({
          version: BOOTSTRAP_VERSION,
          pid: process.pid,
          engines: ['debugpy', 'experimental', 'unknown'],
          activationVersion: 1,
        }),
        'utf-8',
      );

      const state = await (injector as unknown as {
        readBootstrapState(pid: number): Promise<{
          pid: number;
          version: string;
          engines?: string[];
          activationVersion?: number;
        } | null>;
      }).readBootstrapState(process.pid);

      assert.deepStrictEqual(state, {
        pid: process.pid,
        version: BOOTSTRAP_VERSION,
        engines: ['debugpy', 'experimental'],
        activationVersion: 1,
      });
    } finally {
      await fs.unlink(statePath).catch(() => {});
    }
  });

  it('uninstallBootstrap removes bootstrap and tracer files', async function () {
    await injector.uninstallBootstrap(sitePackages);
    await assert.rejects(fs.access(path.join(sitePackages, 'django_process_debugger.pth')));
    await assert.rejects(fs.access(path.join(sitePackages, '_django_debug_bootstrap.py')));
    await assert.rejects(fs.access(path.join(sitePackages, '_django_debug_tracer.py')));
  });
});
