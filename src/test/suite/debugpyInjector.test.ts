import * as assert from 'assert';
import { describe, it, before, after } from 'mocha';
import { execFile, spawn } from 'child_process';
import { once } from 'events';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import {
  BootstrapControlChannelError,
  BootstrapNotLoadedError,
  BootstrapRuntimeIdentityError,
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

  it('generated bootstrap uses a private authenticated activation socket', async function () {
    const content = await fs.readFile(
      path.join(sitePackages, '_django_debug_bootstrap.py'),
      'utf-8',
    );
    assert.ok(content.includes('unsupported activation request version'));
    assert.ok(content.includes('activation runtime identity mismatch'));
    assert.ok(content.includes('_socket.AF_UNIX'));
    assert.ok(content.includes('activationVersion": 2'));
    assert.ok(content.includes('"pythonExecutable": _sys.executable'));
    assert.ok(content.includes('"runtimeId": _runtime_id'));
    assert.ok(content.includes('"version": 3'));
    assert.ok(content.includes('"pid": _pid'));
    assert.ok(content.includes('"bootstrapVersion": "' + BOOTSTRAP_VERSION + '"'));
    assert.ok(content.includes('.experimental.active'));
    assert.ok(content.includes(
      '_experimental_tracer.start("127.0.0.1", _port, auth_token=_auth_token)',
    ));
    assert.ok(content.includes('owns this PID until restart'));
    assert.ok(content.includes('register_at_fork'));
    assert.ok(content.includes(
      'if isinstance(_request, dict) and _request.get("version") == 3:',
    ));
    assert.ok(content.includes('if not _hot_reload_lease_is_live(_lease_id):'));
    assert.ok(content.includes(
      'raise ValueError("Hot reload request requires an active v3 lease")',
    ));
    assert.ok(!content.includes('_signal.signal('), 'fatal process signals must not be installed');
    assert.ok(!content.includes('SIGUSR1'));
    assert.ok(!content.includes('SIGUSR2'));
  });

  it('accepts only v3 active records bound to the current runtime identity', function () {
    const parseActiveFile = (injector as unknown as {
      parseActiveFile(
        content: string,
        engine: 'debugpy' | 'experimental',
        pid: number,
        runtimeId: string,
      ): { host?: string; port: number; authToken?: string } | null;
    }).parseActiveFile.bind(injector);
    const pid = 12_345;
    const runtimeId = 'a'.repeat(64);
    const currentRecord = (engine: 'debugpy' | 'experimental') => ({
      version: 3,
      engine,
      host: '127.0.0.1',
      port: engine === 'debugpy' ? 5678 : 5680,
      pid,
      runtimeId,
      bootstrapVersion: BOOTSTRAP_VERSION,
      ...(engine === 'experimental' ? { authToken: 'c'.repeat(64) } : {}),
    });

    assert.deepStrictEqual(
      parseActiveFile(JSON.stringify(currentRecord('debugpy')), 'debugpy', pid, runtimeId),
      {
      host: '127.0.0.1',
        port: 5678,
      },
    );
    assert.deepStrictEqual(
      parseActiveFile(JSON.stringify(currentRecord('experimental')), 'experimental', pid, runtimeId),
      {
        host: '127.0.0.1',
        port: 5680,
        authToken: 'c'.repeat(64),
      },
    );

    for (const engine of ['debugpy', 'experimental'] as const) {
      const valid = currentRecord(engine);
      const invalidRecords = [
        String(valid.port),
        JSON.stringify({ host: valid.host, port: valid.port }),
        JSON.stringify({ ...valid, version: 2 }),
        JSON.stringify({ ...valid, pid: pid + 1 }),
        JSON.stringify({ ...valid, runtimeId: 'b'.repeat(64) }),
        JSON.stringify({ ...valid, bootstrapVersion: '1970.01.01' }),
        JSON.stringify({ ...valid, engine: engine === 'debugpy' ? 'experimental' : 'debugpy' }),
        ...(engine === 'experimental'
          ? [JSON.stringify({ ...valid, authToken: 'not-a-token' })]
          : []),
      ];
      for (const record of invalidRecords) {
        assert.strictEqual(parseActiveFile(record, engine, pid, runtimeId), null);
      }
    }
  });

  it('getActiveEndpoint removes legacy and mismatched records before listener lookup', async function () {
    const stateDir = '/tmp/django-process-debugger';
    const debugpyActivePath = path.join(stateDir, `${process.pid}.active`);
    const experimentalActivePath = path.join(stateDir, `${process.pid}.experimental.active`);
    const runtimeId = 'd'.repeat(64);
    const endpointInjector = new DebugpyInjector();
    const internals = endpointInjector as unknown as {
      getLoadedBootstrapState(pid: number): Promise<{
        pid: number;
        version: string;
        activationVersion: number;
        runtimeId: string;
        controlSocket: string;
      } | null>;
      findListeningEndpoint(
        port: number,
        pid?: number,
        host?: string,
      ): Promise<{ host: string; port: number } | null>;
    };
    let listenerLookups = 0;
    internals.getLoadedBootstrapState = async (pid: number) => ({
      pid,
      version: BOOTSTRAP_VERSION,
      activationVersion: 2,
      runtimeId,
      controlSocket: path.join(stateDir, `${pid}.control.sock`),
    });
    internals.findListeningEndpoint = async () => {
      listenerLookups += 1;
      return { host: '127.0.0.1', port: 5678 };
    };

    try {
      await fs.mkdir(stateDir, { recursive: true });
      for (const [engine, activePath, port] of [
        ['debugpy', debugpyActivePath, 5678],
        ['experimental', experimentalActivePath, 5680],
      ] as const) {
        const valid = {
          version: 3,
          engine,
          host: '127.0.0.1',
          port,
          pid: process.pid,
          runtimeId,
          bootstrapVersion: BOOTSTRAP_VERSION,
          ...(engine === 'experimental' ? { authToken: 'e'.repeat(64) } : {}),
        };
        const invalidRecords = [
          String(port),
          JSON.stringify({ ...valid, version: 2 }),
          JSON.stringify({ ...valid, pid: process.pid + 1 }),
          JSON.stringify({ ...valid, runtimeId: 'f'.repeat(64) }),
          JSON.stringify({ ...valid, bootstrapVersion: '1970.01.01' }),
        ];
        for (const record of invalidRecords) {
          await fs.writeFile(activePath, record, 'utf-8');
          assert.strictEqual(await endpointInjector.getActiveEndpoint(process.pid, engine), null);
          await assert.rejects(
            fs.access(activePath),
            (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
          );
        }
      }
      assert.strictEqual(listenerLookups, 0);
    } finally {
      await fs.unlink(debugpyActivePath).catch(() => {});
      await fs.unlink(experimentalActivePath).catch(() => {});
    }
  });

  it('activateEndpoint reattaches both engines only from a current identity record', async function () {
    const stateDir = '/tmp/django-process-debugger';
    const activePaths = {
      debugpy: path.join(stateDir, `${process.pid}.active`),
      experimental: path.join(stateDir, `${process.pid}.experimental.active`),
    };
    const runtimeId = '1'.repeat(64);
    const reattachInjector = new DebugpyInjector();
    const internals = reattachInjector as unknown as {
      getLoadedBootstrapState(pid: number): Promise<{
        pid: number;
        version: string;
        activationVersion: number;
        runtimeId: string;
        controlSocket: string;
      } | null>;
      findListeningEndpoint(
        port: number,
        pid?: number,
        host?: string,
      ): Promise<{ host: string; port: number } | null>;
      sendControlRequest(
        socketPath: string,
        request: Record<string, unknown>,
        pid: number,
      ): Promise<void>;
    };
    let bootstrapVerifications = 0;
    let controlRequests = 0;
    internals.getLoadedBootstrapState = async (pid: number) => ({
      pid,
      version: BOOTSTRAP_VERSION,
      activationVersion: 2,
      runtimeId,
      controlSocket: path.join(stateDir, `${pid}.control.sock`),
    });
    internals.findListeningEndpoint = async (port, ownerPid, host) => {
      assert.strictEqual(host, '127.0.0.1');
      if (port === 5678) {
        assert.strictEqual(ownerPid, undefined, 'debugpy listener belongs to its adapter child');
      } else {
        assert.strictEqual(ownerPid, process.pid, 'experimental listener must belong to target PID');
      }
      return { host: '127.0.0.1', port };
    };
    internals.sendControlRequest = async () => { controlRequests += 1; };
    reattachInjector.verifyBootstrapLoaded = async () => {
      bootstrapVerifications += 1;
      return true;
    };

    try {
      await fs.mkdir(stateDir, { recursive: true });
      await fs.unlink(activePaths.debugpy).catch(() => {});
      await fs.unlink(activePaths.experimental).catch(() => {});
      for (const [engine, port] of [
        ['debugpy', 5678],
        ['experimental', 5680],
      ] as const) {
        const authToken = engine === 'experimental' ? '2'.repeat(64) : undefined;
        await fs.writeFile(activePaths[engine], JSON.stringify({
          version: 3,
          engine,
          host: '127.0.0.1',
          port,
          pid: process.pid,
          runtimeId,
          bootstrapVersion: BOOTSTRAP_VERSION,
          ...(authToken ? { authToken } : {}),
        }), 'utf-8');

        const endpoint = await reattachInjector.activateEndpoint(process.pid, port + 100, engine);
        assert.deepStrictEqual(endpoint, {
          host: '127.0.0.1',
          port,
          ...(authToken ? { authToken } : {}),
        });
        await fs.unlink(activePaths[engine]);
      }
      assert.strictEqual(bootstrapVerifications, 0);
      assert.strictEqual(controlRequests, 0);
    } finally {
      await fs.unlink(activePaths.debugpy).catch(() => {});
      await fs.unlink(activePaths.experimental).catch(() => {});
    }
  });

  it('activateEndpoint never short-circuits through a mismatched live record', async function () {
    const stateDir = '/tmp/django-process-debugger';
    const activePaths = {
      debugpy: path.join(stateDir, `${process.pid}.active`),
      experimental: path.join(stateDir, `${process.pid}.experimental.active`),
    };
    const runtimeId = '3'.repeat(64);
    const activationInjector = new DebugpyInjector();
    const internals = activationInjector as unknown as {
      getLoadedBootstrapState(pid: number): Promise<{
        pid: number;
        version: string;
        activationVersion: number;
        pythonExecutable: string;
        runtimeId: string;
        controlSocket: string;
      } | null>;
      findListeningEndpoint(
        port: number,
        pid?: number,
        host?: string,
      ): Promise<{ host: string; port: number } | null>;
      sendControlRequest(
        socketPath: string,
        request: Record<string, unknown>,
        pid: number,
      ): Promise<void>;
    };
    const controlAttempt = new Error('current runtime activation attempted');
    let listenerLookups = 0;
    let controlRequests = 0;
    internals.getLoadedBootstrapState = async (pid: number) => ({
      pid,
      version: BOOTSTRAP_VERSION,
      activationVersion: 2,
      pythonExecutable: process.execPath,
      runtimeId,
      controlSocket: path.join(stateDir, `${pid}.control.sock`),
    });
    internals.findListeningEndpoint = async () => {
      listenerLookups += 1;
      return { host: '127.0.0.1', port: 5678 };
    };
    internals.sendControlRequest = async () => {
      controlRequests += 1;
      throw controlAttempt;
    };
    activationInjector.verifyBootstrapLoaded = async () => true;

    try {
      await fs.mkdir(stateDir, { recursive: true });
      await fs.unlink(activePaths.debugpy).catch(() => {});
      await fs.unlink(activePaths.experimental).catch(() => {});
      for (const [engine, port] of [
        ['debugpy', 5678],
        ['experimental', 5680],
      ] as const) {
        await fs.writeFile(activePaths[engine], JSON.stringify({
          version: 3,
          engine,
          host: '127.0.0.1',
          port,
          pid: process.pid,
          runtimeId: '4'.repeat(64),
          bootstrapVersion: BOOTSTRAP_VERSION,
          ...(engine === 'experimental' ? { authToken: '5'.repeat(64) } : {}),
        }), 'utf-8');
        await assert.rejects(
          activationInjector.activateEndpoint(process.pid, port + 100, engine),
          (error: unknown) => error === controlAttempt,
        );
      }
      assert.strictEqual(listenerLookups, 0);
      assert.strictEqual(controlRequests, 2);
    } finally {
      await fs.unlink(activePaths.debugpy).catch(() => {});
      await fs.unlink(activePaths.experimental).catch(() => {});
    }
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

  it('BootstrapNotLoadedError identifies the selected engine', function () {
    const err = new BootstrapNotLoadedError(1234, 5678, 'experimental');
    assert.ok(err.message.includes('private activation request'));
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

  it('does not treat an ancestor state as proof after a child exec', async function () {
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

      assert.strictEqual(state, null);
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

  it('publishes a fresh direct runtime identity and control socket after Python fork', async function () {
    this.timeout(20_000);
    if (process.platform === 'win32') { this.skip(); return; }
    const python = await findSystemPython();
    if (!python) { this.skip(); return; }

    const script = String.raw`
import json
import importlib.util
import os
import sys
import time

sys.orig_argv = [sys.executable, "manage.py", "runserver"]
bootstrap_path = os.path.join(sys.argv[1], "_django_debug_bootstrap.py")
spec = importlib.util.spec_from_file_location(
    "_django_debug_bootstrap_fork_test",
    bootstrap_path,
)
bootstrap = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bootstrap
spec.loader.exec_module(bootstrap)

child_pid = os.fork()
if child_pid == 0:
    time.sleep(15)
    os._exit(0)

print(json.dumps({"parent": os.getpid(), "child": child_pid}), flush=True)
os.waitpid(child_pid, 0)
`;
    const forkHost = spawn(python, ['-c', script, sitePackages], {
      env: {
        ...process.env,
        PORT_MANAGER_HOOK: '0',
        PORT_MANAGER_HOOK_DISABLED: '1',
        DYLD_INSERT_LIBRARIES: undefined,
        LD_PRELOAD: undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let parentPid: number | undefined;
    let childPid: number | undefined;

    try {
      const published = await new Promise<{ parent: number; child: number }>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(
          () => reject(new Error('fork bootstrap did not publish child PID')),
          5_000,
        );
        forkHost.stdout?.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          const newline = output.indexOf('\n');
          if (newline < 0) { return; }
          clearTimeout(timer);
          try {
            resolve(JSON.parse(output.slice(0, newline)) as { parent: number; child: number });
          } catch (error) {
            reject(error);
          }
        });
        forkHost.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        forkHost.once('exit', (code, signal) => {
          clearTimeout(timer);
          reject(new Error(`fork bootstrap exited early: code=${code} signal=${signal}`));
        });
      });
      parentPid = published.parent;
      childPid = published.child;
      assert.strictEqual(parentPid, forkHost.pid);

      const stateDir = '/tmp/django-process-debugger';
      const parentStatePath = path.join(stateDir, `${parentPid}.bootstrap.json`);
      const childStatePath = path.join(stateDir, `${childPid}.bootstrap.json`);
      const childSocketPath = path.join(stateDir, `${childPid}.control.sock`);
      const deadline = Date.now() + 5_000;
      let parentState: Record<string, unknown> | undefined;
      let childState: Record<string, unknown> | undefined;
      while (Date.now() < deadline) {
        try {
          parentState = JSON.parse(await fs.readFile(parentStatePath, 'utf-8')) as Record<string, unknown>;
          childState = JSON.parse(await fs.readFile(childStatePath, 'utf-8')) as Record<string, unknown>;
          if ((await fs.stat(childSocketPath)).isSocket()) { break; }
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }

      assert.strictEqual(childState?.pid, childPid);
      assert.strictEqual(childState?.controlSocket, childSocketPath);
      assert.match(String(childState?.runtimeId), /^[0-9a-f]{64}$/);
      assert.notStrictEqual(childState?.runtimeId, parentState?.runtimeId);
      assert.strictEqual(childState?.pythonExecutable, parentState?.pythonExecutable);
      assert.strictEqual((await fs.stat(childSocketPath)).isSocket(), true);
    } finally {
      if (childPid) {
        try { process.kill(childPid, 'SIGTERM'); } catch { /* already exited */ }
      }
      if (forkHost.pid && forkHost.exitCode === null) {
        forkHost.kill('SIGTERM');
      }
      if (forkHost.exitCode === null) {
        await once(forkHost, 'exit').catch(() => {});
      }
      for (const pid of [parentPid, childPid]) {
        if (!pid) { continue; }
        await fs.unlink(`/tmp/django-process-debugger/${pid}.bootstrap.json`).catch(() => {});
        await fs.unlink(`/tmp/django-process-debugger/${pid}.control.sock`).catch(() => {});
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
          activationVersion: 2,
          pythonExecutable: '/tmp/example-venv/bin/python',
          runtimeId: 'a'.repeat(64),
          controlSocket: `/tmp/django-process-debugger/${process.pid}.control.sock`,
        }),
        'utf-8',
      );

      const state = await (injector as unknown as {
        readBootstrapState(pid: number): Promise<{
          pid: number;
          version: string;
          engines?: string[];
          activationVersion?: number;
          pythonExecutable?: string;
          runtimeId?: string;
          controlSocket?: string;
        } | null>;
      }).readBootstrapState(process.pid);

      assert.deepStrictEqual(state, {
        pid: process.pid,
        version: BOOTSTRAP_VERSION,
        engines: ['debugpy', 'experimental'],
        activationVersion: 2,
        pythonExecutable: '/tmp/example-venv/bin/python',
        runtimeId: 'a'.repeat(64),
        controlSocket: `/tmp/django-process-debugger/${process.pid}.control.sock`,
      });
    } finally {
      await fs.unlink(statePath).catch(() => {});
    }
  });

  it('prefers the exact Python executable published by the target runtime', async function () {
    const stateDir = '/tmp/django-process-debugger';
    const statePath = path.join(stateDir, `${process.pid}.bootstrap.json`);
    const publishedPython = '/tmp/dpd-example-venv/bin/python';
    try {
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        statePath,
        JSON.stringify({
          version: BOOTSTRAP_VERSION,
          pid: process.pid,
          pythonExecutable: publishedPython,
        }),
        'utf-8',
      );

      assert.strictEqual(await injector.resolvePythonForPid(process.pid), publishedPython);
    } finally {
      await fs.unlink(statePath).catch(() => {});
    }
  });

  it('fails closed when current bootstrap state omits its runtime identity', async function () {
    const stateDir = '/tmp/django-process-debugger';
    const statePath = path.join(stateDir, `${process.pid}.bootstrap.json`);
    const identityInjector = new DebugpyInjector();
    identityInjector.getActiveEndpoint = async () => null;

    try {
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        statePath,
        JSON.stringify({
          version: BOOTSTRAP_VERSION,
          pid: process.pid,
          engines: ['debugpy', 'experimental'],
          activationVersion: 2,
          pythonExecutable: process.execPath,
        }),
        'utf-8',
      );

      await assert.rejects(
        identityInjector.activateEndpoint(process.pid, 49_990, 'experimental'),
        (error: unknown) => error instanceof BootstrapRuntimeIdentityError,
      );
    } finally {
      await fs.unlink(statePath).catch(() => {});
    }
  });

  it('uses a stale-safe control connection and never falls back to a process signal', async function () {
    const stateDir = '/tmp/django-process-debugger';
    const statePath = path.join(stateDir, `${process.pid}.bootstrap.json`);
    const socketPath = path.join(stateDir, `${process.pid}.control.sock`);
    const legacyPortPath = path.join(stateDir, `${process.pid}.port`);
    const controlInjector = new DebugpyInjector();
    controlInjector.getActiveEndpoint = async () => null;
    let verifiedPython: string | undefined;
    controlInjector.verifyBootstrapLoaded = async (pythonExecutable: string) => {
      verifiedPython = pythonExecutable;
      return true;
    };

    try {
      await fs.mkdir(stateDir, { recursive: true });
      await fs.unlink(socketPath).catch(() => {});
      await fs.unlink(legacyPortPath).catch(() => {});
      await fs.writeFile(
        statePath,
        JSON.stringify({
          version: BOOTSTRAP_VERSION,
          pid: process.pid,
          engines: ['debugpy', 'experimental'],
          activationVersion: 2,
          pythonExecutable: '/tmp/dpd-exact-runtime/bin/python',
          runtimeId: 'b'.repeat(64),
          controlSocket: socketPath,
        }),
        'utf-8',
      );

      await assert.rejects(
        controlInjector.activateEndpoint(process.pid, 49_991, 'experimental'),
        (error: unknown) => error instanceof BootstrapControlChannelError &&
          error.message.includes('no process signal was sent'),
      );
      assert.strictEqual(verifiedPython, '/tmp/dpd-exact-runtime/bin/python');
      await assert.rejects(fs.access(legacyPortPath));
    } finally {
      await fs.unlink(statePath).catch(() => {});
      await fs.unlink(socketPath).catch(() => {});
      await fs.unlink(legacyPortPath).catch(() => {});
    }
  });

  it('requires a current bootstrap control identity before publishing a hot-reload lease', async function () {
    const stateDir = '/tmp/django-process-debugger';
    const statePath = path.join(stateDir, `${process.pid}.bootstrap.json`);
    const leaseId = 'd'.repeat(64);
    const leasePath = path.join(stateDir, `${process.pid}.hot-reload.${leaseId}.lease`);

    try {
      await fs.mkdir(stateDir, { recursive: true });
      await fs.unlink(leasePath).catch(() => {});
      await fs.writeFile(
        statePath,
        JSON.stringify({
          version: BOOTSTRAP_VERSION,
          pid: process.pid,
          engines: ['debugpy', 'experimental'],
          activationVersion: 2,
          pythonExecutable: process.execPath,
        }),
        'utf-8',
      );

      await assert.rejects(
        injector.acquireHotReloadLease(process.pid, leaseId, 1_000),
        (error: unknown) => error instanceof BootstrapRuntimeIdentityError,
      );
      await assert.rejects(
        fs.access(leasePath),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
      );
    } finally {
      await fs.unlink(statePath).catch(() => {});
      await fs.unlink(leasePath).catch(() => {});
    }
  });

  it('removes the published lease when the authenticated control request is rejected', async function () {
    if (process.platform === 'win32') { this.skip(); return; }
    const stateDir = '/tmp/django-process-debugger';
    const statePath = path.join(stateDir, `${process.pid}.bootstrap.json`);
    const socketPath = path.join(stateDir, `${process.pid}.control.sock`);
    const runtimeId = 'e'.repeat(64);
    const leaseId = 'f'.repeat(64);
    const leasePath = path.join(stateDir, `${process.pid}.hot-reload.${leaseId}.lease`);
    let receivedRequest: Record<string, unknown> | undefined;
    let leaseModeAtRequest: number | undefined;
    let handlerError: unknown;
    const server = net.createServer((socket) => {
      let content = '';
      let handled = false;
      socket.setEncoding('utf-8');
      socket.on('data', (chunk: string) => {
        content += chunk;
        if (handled || !content.includes('\n')) { return; }
        handled = true;
        void (async () => {
          try {
            receivedRequest = JSON.parse(content.split('\n', 1)[0]) as Record<string, unknown>;
            leaseModeAtRequest = (await fs.stat(leasePath)).mode & 0o777;
          } catch (error) {
            handlerError = error;
          } finally {
            socket.end('rejected\n');
          }
        })();
      });
    });

    try {
      await fs.mkdir(stateDir, { recursive: true });
      await fs.unlink(socketPath).catch(() => {});
      await fs.unlink(leasePath).catch(() => {});
      await fs.writeFile(
        statePath,
        JSON.stringify({
          version: BOOTSTRAP_VERSION,
          pid: process.pid,
          engines: ['debugpy', 'experimental'],
          activationVersion: 2,
          pythonExecutable: process.execPath,
          runtimeId,
          controlSocket: socketPath,
        }),
        'utf-8',
      );
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(socketPath, () => {
          server.off('error', onError);
          resolve();
        });
      });

      await assert.rejects(
        injector.acquireHotReloadLease(process.pid, leaseId, 1_000),
        (error: unknown) => error instanceof BootstrapControlChannelError
          && error.message.includes('target rejected the control request'),
      );
      assert.ifError(handlerError);
      assert.deepStrictEqual(receivedRequest, {
        version: 2,
        runtimeId,
        action: 'hotReloadLease',
        leaseId,
        ttlMs: 1_000,
      });
      assert.strictEqual(leaseModeAtRequest, 0o600);
      await assert.rejects(
        fs.access(leasePath),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
      );
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await fs.unlink(statePath).catch(() => {});
      await fs.unlink(socketPath).catch(() => {});
      await fs.unlink(leasePath).catch(() => {});
    }
  });

  it('uninstallBootstrap removes bootstrap and tracer files', async function () {
    await injector.uninstallBootstrap(sitePackages);
    await assert.rejects(fs.access(path.join(sitePackages, 'django_process_debugger.pth')));
    await assert.rejects(fs.access(path.join(sitePackages, '_django_debug_bootstrap.py')));
    await assert.rejects(fs.access(path.join(sitePackages, '_django_debug_tracer.py')));
  });
});
