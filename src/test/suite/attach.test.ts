import * as assert from 'assert';
import { describe, it, before, after } from 'mocha';
import { ChildProcess, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as net from 'net';
import * as fs from 'fs/promises';
import {
  BOOTSTRAP_VERSION,
  DebugEngineConflictError,
  DebugpyInjector,
} from '../../debugpyInjector';
import { getPerf } from './perfReporter';
import {
  allocateLoopbackPort,
  findSystemPython,
  createTempVenv,
  spawnFakeRunserver,
  SpawnedProcess,
  projectRoot,
  sleep,
} from './testHelpers';

const execFileAsync = promisify(execFile);

/**
 * Full end-to-end attach flow:
 *   1. Create a throw-away venv so we never touch the developer's site-packages.
 *   2. Install the bootstrap there via DebugpyInjector.installBootstrap().
 *   3. Spawn the fake manage.py through that venv's python so the bootstrap
 *      loads automatically via the .pth file on startup.
 *   4. Call injector.activate(pid, port) through the PID-owned private control
 *      socket and make debugpy listen on `port`.
 *   5. Verify the TCP listener is up.
 *
 * Skipped gracefully if no system python3 is available.
 */
describe('Feature: end-to-end attach flow', function () {
  const perf = getPerf();
  const injector = new DebugpyInjector();
  let venv: Awaited<ReturnType<typeof createTempVenv>> = null;
  let server: SpawnedProcess | null = null;
  let experimentalServer: SpawnedProcess | null = null;
  let serverPort = 0;
  let debugPort = 0;
  let experimentalServerPort = 0;
  let experimentalDebugPort = 0;

  before(async function () {
    this.timeout(60_000);
    const basePython = await findSystemPython();
    if (!basePython) { this.skip(); return; }

    venv = await createTempVenv(basePython);
    if (!venv) { this.skip(); return; }

    injector.setBundledDebugpyPath(path.join(projectRoot(), 'vendor', 'python'));

    await perf.measure('installBootstrap (e2e venv)', async () => {
      await injector.installBootstrap(venv!.sitePackages);
    }, { group: 'attach-e2e' });

    // Sanity check: the venv python can import the bootstrap module
    try {
      await execFileAsync(venv.python, ['-c', 'import _django_debug_bootstrap'], { timeout: 10_000 });
    } catch (err) {
      console.error('[attach-e2e] bootstrap import failed — skipping live attach:', err);
      this.skip();
      return;
    }

    [serverPort, experimentalServerPort] = await Promise.all([
      allocateLoopbackPort(),
      allocateLoopbackPort(),
    ]);
    server = await perf.measure('spawn fake runserver', async () =>
      spawnFakeRunserver(venv!.python, serverPort),
    { group: 'attach-e2e' });
    experimentalServer = await spawnFakeRunserver(venv.python, experimentalServerPort);

    // Give the bootstrap's private activation socket a moment to publish.
    await sleep(200);

    // The live bootstrap publishes sys.executable, so macOS ps/lsof resolving a
    // venv symlink to its base interpreter must no longer skip attach coverage.
    const resolved = await injector.resolvePythonForPid(server.pid);
    const resolvable = await canImportBootstrap(resolved);
    assert.strictEqual(
      resolvable,
      true,
      `target-published Python "${resolved}" must import the installed bootstrap`,
    );
  });

  after(async function () {
    this.timeout(15_000);
    if (server) {
      await server.stop();
    }
    if (experimentalServer) {
      await experimentalServer.stop();
    }
    if (venv) {
      await venv.cleanup();
    }
  });

  it('activate() makes debugpy listen on the requested port', async function () {
    if (!server || !venv) { this.skip(); return; }
    this.timeout(20_000);

    debugPort = await allocateLoopbackPort();
    const actualPort = await perf.measure('injector.activate (full)', async () =>
      injector.activate(server!.pid, debugPort),
    { group: 'attach-e2e', meta: { pid: server.pid, requested: debugPort } });

    assert.strictEqual(actualPort, debugPort, 'activate should return the requested port');

    const endpoint = await injector.getActiveEndpoint(server.pid);
    assert.ok(endpoint, 'debugpy active endpoint should be discoverable');
    assert.strictEqual(endpoint.port, debugPort);
    assert.strictEqual(endpoint.authToken, undefined);

    const listening = await isPortListening(endpoint.port, endpoint.host);
    assert.strictEqual(listening, true, `debugpy should be listening on ${endpoint.host}:${debugPort}`);
  });

  it('activateEndpoint() starts the independent experimental tracer through the bootstrap', async function () {
    if (!experimentalServer || !venv) { this.skip(); return; }
    this.timeout(20_000);

    experimentalDebugPort = await allocateLoopbackPort();
    const endpoint = await perf.measure('injector.activate (experimental)', async () =>
      injector.activateEndpoint(experimentalServer!.pid, experimentalDebugPort, 'experimental'),
    { group: 'attach-e2e', meta: { pid: experimentalServer.pid, requested: experimentalDebugPort } });

    assert.strictEqual(endpoint.port, experimentalDebugPort);
    assert.match(endpoint.authToken ?? '', /^[0-9a-f]{64}$/);
    assert.strictEqual(
      await injector.getActiveEndpoint(experimentalServer.pid, 'debugpy'),
      null,
      'experimental activation must not publish a debugpy marker',
    );
    const active = await injector.getActiveEndpoint(experimentalServer.pid, 'experimental');
    assert.ok(active, 'experimental endpoint should be discoverable by its own engine');
    assert.strictEqual(active.port, experimentalDebugPort);
    assert.strictEqual(active.authToken, endpoint.authToken);
    const activePath = path.join(
      '/tmp/django-process-debugger',
      `${experimentalServer.pid}.experimental.active`,
    );
    assert.strictEqual((await fs.stat(activePath)).mode & 0o777, 0o600);

    const alternatePort = await allocateLoopbackPort();
    const reused = await injector.activateEndpoint(
      experimentalServer.pid,
      alternatePort,
      'experimental',
    );
    assert.strictEqual(reused.port, endpoint.port);
    assert.strictEqual(reused.authToken, endpoint.authToken);
  });

  it('does not switch an experimental PID to debugpy without a target restart', async function () {
    if (!experimentalServer || !venv) { this.skip(); return; }
    this.timeout(10_000);

    const alternatePort = await allocateLoopbackPort();
    await assert.rejects(
      injector.activateEndpoint(experimentalServer.pid, alternatePort, 'debugpy'),
      (error: unknown) => error instanceof DebugEngineConflictError
        && error.activeEngine === 'experimental'
        && error.requestedEngine === 'debugpy',
    );
  });

  it('activate() is idempotent — second call reuses the same port', async function () {
    if (!server) { this.skip(); return; }
    this.timeout(10_000);

    const alternatePort = await allocateLoopbackPort();
    const secondPort = await perf.measure('injector.activate (idempotent)', async () =>
      injector.activate(server!.pid, alternatePort),
    { group: 'attach-e2e' });

    assert.strictEqual(secondPort, debugPort,
      'second activate should return the already-active port, not the new one');
  });

  it('getActivePort reflects the active state', async function () {
    if (!server) { this.skip(); return; }
    const port = await injector.getActivePort(server.pid);
    assert.strictEqual(port, debugPort);
  });

  it('getActiveEndpoint reflects the active host and port', async function () {
    if (!server) { this.skip(); return; }
    const endpoint = await injector.getActiveEndpoint(server.pid);
    assert.ok(endpoint);
    assert.ok(endpoint.host.length > 0);
    assert.strictEqual(endpoint.port, debugPort);
  });

  it('resolveDebuggablePid resolves to the server pid', async function () {
    if (!server) { this.skip(); return; }
    this.timeout(10_000);
    const { DjangoProcessFinder } = await import('../../processFinder');
    const finder = new DjangoProcessFinder();
    const resolved = await perf.measure('resolveDebuggablePid (e2e)', async () =>
      finder.resolveDebuggablePid(server!.pid),
    { group: 'attach-e2e' });
    assert.strictEqual(resolved.pid, server.pid);
  });

  it('does not reuse an active file when a different PID has that port open on another host', async function () {
    const child = await startChildTcpListener();
    const synthetic = await publishSyntheticActiveRecord(
      process.pid,
      '127.250.250.250',
      child.port,
    );

    try {
      const endpoint = await injector.getActiveEndpoint(process.pid);
      assert.strictEqual(endpoint, null);
      await assert.rejects(fs.access(synthetic.activeFile));
    } finally {
      await synthetic.cleanup();
      child.stop();
    }
  });

  it('resolves an active endpoint through a PID-owned loopback alias', async function () {
    const listener = net.createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => resolve());
    });

    const address = listener.address();
    assert.ok(address && typeof address === 'object');
    const synthetic = await publishSyntheticActiveRecord(
      process.pid,
      '127.250.250.250',
      address.port,
    );

    try {
      const endpoint = await injector.getActiveEndpoint(process.pid);
      assert.ok(endpoint);
      assert.strictEqual(endpoint.port, address.port);
      assert.strictEqual(endpoint.host, '127.0.0.1');
    } finally {
      await synthetic.cleanup();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });
});

async function publishSyntheticActiveRecord(
  pid: number,
  recordedHost: string,
  port: number,
): Promise<{ activeFile: string; cleanup(): Promise<void> }> {
  const artifactDirectory = '/tmp/django-process-debugger';
  const runtimeId = 'a1'.repeat(32);
  const activeFile = path.join(artifactDirectory, `${pid}.active`);
  const bootstrapStateFile = path.join(artifactDirectory, `${pid}.bootstrap.json`);
  await fs.mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(bootstrapStateFile, JSON.stringify({
    pid,
    version: BOOTSTRAP_VERSION,
    activationVersion: 2,
    runtimeId,
    controlSocket: path.join(artifactDirectory, `${pid}.control.sock`),
  }), { encoding: 'utf-8', mode: 0o600 });
  await fs.writeFile(activeFile, JSON.stringify({
    version: 3,
    engine: 'debugpy',
    host: recordedHost,
    port,
    pid,
    runtimeId,
    bootstrapVersion: BOOTSTRAP_VERSION,
  }), { encoding: 'utf-8', mode: 0o600 });
  return {
    activeFile,
    cleanup: async () => {
      await Promise.all([
        fs.unlink(activeFile).catch(() => {}),
        fs.unlink(bootstrapStateFile).catch(() => {}),
      ]);
    },
  };
}

async function startChildTcpListener(): Promise<{ port: number; stop(): void }> {
  const script = [
    'const net = require("net");',
    'const server = net.createServer();',
    'server.listen(0, "127.0.0.1", () => { console.log(server.address().port); });',
    'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
    'setInterval(() => {}, 1000);',
  ].join('\n');

  const child: ChildProcess = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const port = await new Promise<number>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`child listener did not start. stderr=${stderr}`));
    }, 5_000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = stdout.match(/(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(parseInt(match[1], 10));
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code, signal) => {
      if (!stdout.match(/(\d+)/)) {
        clearTimeout(timer);
        reject(new Error(`child listener exited before port was reported: code=${code} signal=${signal} stderr=${stderr}`));
      }
    });
  });

  return {
    port,
    stop: () => {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    },
  };
}

async function canImportBootstrap(pythonPath: string): Promise<boolean> {
  try {
    await execFileAsync(pythonPath, ['-c', 'import _django_debug_bootstrap'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function isPortListening(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (result: boolean) => {
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(2_000);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}
