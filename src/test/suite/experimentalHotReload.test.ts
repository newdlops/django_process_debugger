import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import { DebugpyInjector } from '../../debugpyInjector';
import {
  createTempVenv,
  findSystemPython,
  projectRoot,
  spawnFakeRunserver,
  type SpawnedProcess,
} from './testHelpers';

const PORT_FILE_DIR = '/tmp/django-process-debugger';

type ExperimentalActiveRecord = {
  version?: unknown;
  pid?: unknown;
  engine?: unknown;
  host?: unknown;
  port?: unknown;
};

async function waitForJsonFile(
  filePath: string,
  timeoutMs: number,
): Promise<ExperimentalActiveRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as ExperimentalActiveRecord;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for JSON file: ${filePath}`);
}

async function waitForTextFile(filePath: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for text file: ${filePath}`);
}

async function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (connected: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(1_000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

describe('Feature: experimental bootstrap hot reload', function () {
  it('reloads a loaded module on an untraced watcher thread', async function () {
    this.timeout(90_000);
    if (process.platform === 'win32') {
      this.skip();
      return;
    }

    const basePython = await findSystemPython();
    if (!basePython) {
      this.skip();
      return;
    }

    const venv = await createTempVenv(basePython);
    if (!venv) {
      this.skip();
      return;
    }

    const injector = new DebugpyInjector();
    injector.setBundledDebugpyPath(path.join(projectRoot(), 'vendor', 'python'));

    const markerFile = path.join(
      os.tmpdir(),
      `dpd-experimental-hot-reload-${process.pid}-${Date.now()}.txt`,
    );
    const probeFile = path.join(
      projectRoot(),
      'src',
      'test',
      'fixtures',
      'sampleapp',
      'hot_reload_probe.py',
    );
    const serverPort = 49_886;
    let server: SpawnedProcess | null = null;
    let pidFiles: string[] = [];

    try {
      await injector.installBootstrap(venv.sitePackages);
      server = await spawnFakeRunserver(venv.python, serverPort, {
        env: {
          DPD_EXPERIMENTAL_HOT_RELOAD_PROBE: markerFile,
        },
      });

      const pid = server.pid;
      const portFile = path.join(PORT_FILE_DIR, `${pid}.port`);
      const debugpyActiveFile = path.join(PORT_FILE_DIR, `${pid}.active`);
      const experimentalActiveFile = path.join(
        PORT_FILE_DIR,
        `${pid}.experimental.active`,
      );
      const bootstrapStateFile = path.join(
        PORT_FILE_DIR,
        `${pid}.bootstrap.json`,
      );
      pidFiles = [
        portFile,
        debugpyActiveFile,
        experimentalActiveFile,
        path.join(PORT_FILE_DIR, `${pid}.reload`),
        path.join(PORT_FILE_DIR, `${pid}.reload.processing`),
        path.join(PORT_FILE_DIR, `${pid}.reload.result`),
        bootstrapStateFile,
      ];

      // READY is printed after the env-gated import, so this proves the module
      // was loaded before the experimental engine and its watcher start.
      assert.strictEqual((await waitForTextFile(markerFile, 3_000)).trim(), 'untraced');
      const bootstrapState = await waitForJsonFile(bootstrapStateFile, 3_000);
      assert.strictEqual(bootstrapState.pid, pid);
      await fs.unlink(markerFile);
      for (const filePath of pidFiles) {
        if (filePath === bootstrapStateFile) { continue; }
        await fs.unlink(filePath).catch(() => {});
      }

      await fs.mkdir(PORT_FILE_DIR, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        portFile,
        JSON.stringify({ version: 1, engine: 'experimental', port: 0 }),
        { encoding: 'utf-8', mode: 0o600 },
      );
      process.kill(pid, 'SIGUSR1');

      const active = await waitForJsonFile(experimentalActiveFile, 10_000);
      assert.strictEqual(active.engine, 'experimental');
      assert.strictEqual(typeof active.host, 'string');
      assert.strictEqual(typeof active.port, 'number');
      const host = String(active.host);
      const port = Number(active.port);
      assert.ok(Number.isInteger(port) && port > 0, `invalid active port: ${active.port}`);
      assert.strictEqual(await canConnect(host, port), true);
      await assert.rejects(
        fs.access(debugpyActiveFile),
        'experimental activation must not publish a debugpy active marker',
      );

      const requestId = await injector.requestHotReload(pid, [probeFile]);
      assert.ok(requestId);
      const results = await injector.pollReloadResult(
        pid,
        8_000,
        20,
        requestId ?? undefined,
      );
      assert.ok(results, 'experimental bootstrap watcher did not publish a reload result');
      assert.ok(
        results.some((line) => line.startsWith('OK:sampleapp.hot_reload_probe')),
        `expected probe module reload, got ${JSON.stringify(results)}`,
      );

      assert.strictEqual(
        (await waitForTextFile(markerFile, 3_000)).trim(),
        'untraced',
        'experimental reload watcher must opt out of the native sys.settrace hook',
      );
      assert.strictEqual(await canConnect(host, port), true);
      process.kill(pid, 0);
    } finally {
      if (server) {
        await server.stop();
      }
      for (const filePath of pidFiles) {
        await fs.unlink(filePath).catch(() => {});
      }
      await fs.unlink(markerFile).catch(() => {});
      await venv.cleanup();
    }
  });
});
