import * as assert from 'assert';
import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import { DebugpyInjector } from '../../debugpyInjector';
import {
  allocateLoopbackPort,
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
  authToken?: unknown;
};

type HotReloadLifecycleState = {
  pid?: unknown;
  receiverCount?: unknown;
  debuggerReceiverCount?: unknown;
  applicationReceiverPresent?: unknown;
  triggerIsOriginal?: unknown;
  triggerReferencesOriginal?: unknown;
  watcherThreadCount?: unknown;
  connectCount?: unknown;
  disconnectCount?: unknown;
};

const delay = (milliseconds: number): Promise<void> => new Promise(
  (resolve) => setTimeout(resolve, milliseconds),
);

async function waitForJsonFile<T>(
  filePath: string,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      await delay(25);
    }
  }
  throw new Error(`Timed out waiting for JSON file: ${filePath}`);
}

function lifecycleMatches(
  state: HotReloadLifecycleState,
  pid: number,
  active: boolean,
): boolean {
  return state.pid === pid
    && state.receiverCount === (active ? 2 : 1)
    && state.debuggerReceiverCount === (active ? 1 : 0)
    && state.applicationReceiverPresent === true
    && state.triggerIsOriginal === !active
    && state.triggerReferencesOriginal === active
    && state.watcherThreadCount === (active ? 1 : 0);
}

async function waitForLifecycleState(
  filePath: string,
  pid: number,
  active: boolean,
  description: string,
  timeoutMs: number = 5_000,
): Promise<HotReloadLifecycleState> {
  const deadline = Date.now() + timeoutMs;
  let lastState: HotReloadLifecycleState | null = null;
  while (Date.now() < deadline) {
    try {
      lastState = JSON.parse(
        await fs.readFile(filePath, 'utf-8'),
      ) as HotReloadLifecycleState;
      if (lifecycleMatches(lastState, pid, active)) {
        return lastState;
      }
    } catch {
      // The fixture publishes state atomically; wait for the next snapshot.
    }
    await delay(25);
  }
  throw new Error(
    `Timed out waiting for ${description}: ${JSON.stringify(lastState)}`,
  );
}

async function waitForTextFile(filePath: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      await delay(25);
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
  it('starts, renews, expires, and restores hot reload through real leases', async function () {
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
    const lifecycleStateFile = path.join(
      os.tmpdir(),
      `dpd-experimental-hot-reload-lifecycle-${process.pid}-${Date.now()}.json`,
    );
    const probeFile = path.join(
      projectRoot(),
      'src',
      'test',
      'fixtures',
      'sampleapp',
      'hot_reload_probe.py',
    );
    const serverPort = await allocateLoopbackPort();
    const releasedLeaseId = randomBytes(32).toString('hex');
    const expiredLeaseId = randomBytes(32).toString('hex');
    const renewedLeaseId = randomBytes(32).toString('hex');
    let server: SpawnedProcess | null = null;
    let pidFiles: string[] = [];

    try {
      await injector.installBootstrap(venv.sitePackages);
      server = await spawnFakeRunserver(venv.python, serverPort, {
        env: {
          DPD_EXPERIMENTAL_HOT_RELOAD_PROBE: markerFile,
          DPD_EXPERIMENTAL_HOT_RELOAD_LIFECYCLE_STATE: lifecycleStateFile,
        },
      });

      const pid = server.pid;
      const controlSocketFile = path.join(PORT_FILE_DIR, `${pid}.control.sock`);
      const debugpyActiveFile = path.join(PORT_FILE_DIR, `${pid}.active`);
      const experimentalActiveFile = path.join(
        PORT_FILE_DIR,
        `${pid}.experimental.active`,
      );
      const bootstrapStateFile = path.join(
        PORT_FILE_DIR,
        `${pid}.bootstrap.json`,
      );
      const reloadFile = path.join(PORT_FILE_DIR, `${pid}.reload`);
      const reloadProcessingFile = `${reloadFile}.processing`;
      const reloadResultFile = path.join(PORT_FILE_DIR, `${pid}.reload.result`);
      const leaseFile = (leaseId: string): string => path.join(
        PORT_FILE_DIR,
        `${pid}.hot-reload.${leaseId}.lease`,
      );
      pidFiles = [
        controlSocketFile,
        debugpyActiveFile,
        experimentalActiveFile,
        reloadFile,
        reloadProcessingFile,
        reloadResultFile,
        leaseFile(releasedLeaseId),
        leaseFile(expiredLeaseId),
        leaseFile(renewedLeaseId),
        bootstrapStateFile,
      ];

      const clearReloadArtifacts = async (): Promise<void> => {
        for (const filePath of [reloadFile, reloadProcessingFile, reloadResultFile]) {
          await fs.unlink(filePath).catch(() => {});
        }
      };
      const reloadProbe = async (leaseId: string): Promise<void> => {
        await clearReloadArtifacts();
        await fs.unlink(markerFile).catch(() => {});
        const requestId = await injector.requestHotReload(pid, [probeFile], leaseId);
        assert.ok(requestId);
        const results = await injector.pollReloadResult(
          pid,
          8_000,
          20,
          requestId ?? undefined,
          undefined,
          leaseId,
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
      };
      const assertLeaseCannotProcessReload = async (
        leaseId: string,
        reason: string,
      ): Promise<void> => {
        await clearReloadArtifacts();
        await fs.unlink(markerFile).catch(() => {});
        const requestId = await injector.requestHotReload(pid, [probeFile], leaseId);
        assert.ok(requestId);
        await delay(700);
        assert.strictEqual(
          await injector.isReloadPending(pid, requestId ?? undefined, leaseId),
          true,
          `${reason}: watcher consumed a request without a live lease`,
        );
        assert.strictEqual(
          await injector.readReloadResult(pid, requestId ?? undefined, leaseId),
          null,
          `${reason}: watcher published a result without a live lease`,
        );
        await assert.rejects(
          fs.access(markerFile),
          `${reason}: probe module was reloaded without a live lease`,
        );
        await clearReloadArtifacts();
      };

      // READY is printed after the env-gated import, so this proves the module
      // was loaded before the experimental engine and its watcher start.
      assert.strictEqual((await waitForTextFile(markerFile, 3_000)).trim(), 'untraced');
      const bootstrapState = await waitForJsonFile<ExperimentalActiveRecord>(
        bootstrapStateFile,
        3_000,
      );
      assert.strictEqual(bootstrapState.pid, pid);
      const initialLifecycle = await waitForLifecycleState(
        lifecycleStateFile,
        pid,
        false,
        'initial inactive lifecycle',
      );
      assert.strictEqual(initialLifecycle.connectCount, 1);
      assert.strictEqual(initialLifecycle.disconnectCount, 0);
      await fs.unlink(markerFile);
      for (const filePath of pidFiles) {
        if (filePath === bootstrapStateFile || filePath === controlSocketFile) { continue; }
        await fs.unlink(filePath).catch(() => {});
      }

      const activatedEndpoint = await injector.activateEndpoint(pid, 0, 'experimental');

      const active = await waitForJsonFile<ExperimentalActiveRecord>(
        experimentalActiveFile,
        10_000,
      );
      assert.strictEqual(active.engine, 'experimental');
      assert.strictEqual(typeof active.host, 'string');
      assert.strictEqual(typeof active.port, 'number');
      const host = String(active.host);
      const port = Number(active.port);
      assert.ok(Number.isInteger(port) && port > 0, `invalid active port: ${active.port}`);
      assert.strictEqual(activatedEndpoint.host, host);
      assert.strictEqual(activatedEndpoint.port, port);
      assert.match(activatedEndpoint.authToken ?? '', /^[0-9a-f]{64}$/);
      assert.strictEqual(active.authToken, activatedEndpoint.authToken);
      assert.strictEqual(await canConnect(host, port), true);
      await assert.rejects(
        fs.access(debugpyActiveFile),
        'experimental activation must not publish a debugpy active marker',
      );

      // Engine activation alone must not install Django hooks or start a watcher.
      await delay(400);
      const activationOnlyLifecycle = await waitForLifecycleState(
        lifecycleStateFile,
        pid,
        false,
        'activation-only lifecycle to remain inactive',
      );
      assert.strictEqual(activationOnlyLifecycle.connectCount, 1);
      assert.strictEqual(activationOnlyLifecycle.disconnectCount, 0);

      // Acquiring the first lease installs exactly one reversible hook pair and
      // starts the target-side watcher. A correlated v3 request now succeeds.
      await injector.acquireHotReloadLease(pid, releasedLeaseId, 5_000);
      const acquiredLifecycle = await waitForLifecycleState(
        lifecycleStateFile,
        pid,
        true,
        'lease-acquired lifecycle',
      );
      assert.strictEqual(acquiredLifecycle.connectCount, 2);
      assert.strictEqual(acquiredLifecycle.disconnectCount, 0);
      await reloadProbe(releasedLeaseId);

      // Release is filesystem-only; the real watcher observes it, exits, and
      // restores both the original trigger identity and the application receiver.
      await injector.releaseHotReloadLease(pid, releasedLeaseId);
      const releasedLifecycle = await waitForLifecycleState(
        lifecycleStateFile,
        pid,
        false,
        'released lifecycle',
      );
      assert.strictEqual(releasedLifecycle.connectCount, 2);
      assert.strictEqual(releasedLifecycle.disconnectCount, 1);
      await assertLeaseCannotProcessReload(releasedLeaseId, 'released lease');

      // A lease that is not renewed expires through the target's real 300ms
      // lifecycle poll, which must stop the watcher and restore both Django hooks.
      await injector.acquireHotReloadLease(pid, expiredLeaseId, 1_200);
      await waitForLifecycleState(
        lifecycleStateFile,
        pid,
        true,
        'short lease acquisition',
      );
      const expiredLifecycle = await waitForLifecycleState(
        lifecycleStateFile,
        pid,
        false,
        'short lease expiry',
        4_000,
      );
      assert.strictEqual(expiredLifecycle.connectCount, 3);
      assert.strictEqual(expiredLifecycle.disconnectCount, 2);
      await assertLeaseCannotProcessReload(expiredLeaseId, 'expired lease');

      // Renewal only replaces the private lease file. Prove that it keeps the
      // existing watcher alive beyond the original mtime + TTL boundary.
      const renewalTtlMs = 3_000;
      await injector.acquireHotReloadLease(pid, renewedLeaseId, renewalTtlMs);
      await waitForLifecycleState(
        lifecycleStateFile,
        pid,
        true,
        'renewable lease acquisition',
      );
      const originalLeaseStat = await fs.stat(leaseFile(renewedLeaseId));
      await delay(1_200);
      await injector.renewHotReloadLease(pid, renewedLeaseId, renewalTtlMs);
      const renewedLeaseStat = await fs.stat(leaseFile(renewedLeaseId));
      assert.ok(
        renewedLeaseStat.mtimeMs > originalLeaseStat.mtimeMs,
        'renewal must replace the lease with a newer mtime',
      );
      const afterOriginalExpiryMs = (
        originalLeaseStat.mtimeMs + renewalTtlMs + 200 - Date.now()
      );
      if (afterOriginalExpiryMs > 0) {
        await delay(afterOriginalExpiryMs);
      }
      const renewedLifecycle = await waitForLifecycleState(
        lifecycleStateFile,
        pid,
        true,
        'renewed lease beyond its original expiry',
      );
      assert.strictEqual(renewedLifecycle.connectCount, 4);
      assert.strictEqual(renewedLifecycle.disconnectCount, 2);
      await reloadProbe(renewedLeaseId);
      await injector.releaseHotReloadLease(pid, renewedLeaseId);
      const finalLifecycle = await waitForLifecycleState(
        lifecycleStateFile,
        pid,
        false,
        'final hook restoration',
      );
      assert.strictEqual(finalLifecycle.connectCount, 4);
      assert.strictEqual(finalLifecycle.disconnectCount, 3);

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
      await fs.unlink(lifecycleStateFile).catch(() => {});
      await fs.unlink(`${lifecycleStateFile}.tmp`).catch(() => {});
      await venv.cleanup();
    }
  });
});
