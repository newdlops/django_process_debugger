import * as assert from 'assert';
import { describe, it, before, after } from 'mocha';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { getPerf } from './perfReporter';
import { normalizeDebugEngine } from '../../debugEngine';

/**
 * Lock-file behavior is currently inlined in extension.ts (readLock/writeLock/removeLock).
 * This suite emulates the on-disk contract so that when the lock module is extracted
 * (see optimization.md "Refactoring") we can swap to importing it directly.
 */
describe('Feature: debug session lock-file contract', function () {
  const perf = getPerf();
  let lockDir: string;
  let legacyLockFile: string;

  function lockFileForPid(pid: number): string {
    return path.join(lockDir, `debug-session.${pid}.lock`);
  }

  async function readLockForPid(pid: number): Promise<Record<string, unknown> | null> {
    try {
      const data = await fs.readFile(lockFileForPid(pid), 'utf-8');
      return JSON.parse(data);
    } catch {
      // Backward compatibility: the legacy global lock only applies to its own PID.
      try {
        const legacy = JSON.parse(await fs.readFile(legacyLockFile, 'utf-8'));
        return legacy.pid === pid ? legacy : null;
      } catch {
        return null;
      }
    }
  }

  before(async function () {
    lockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dpd-lock-'));
    legacyLockFile = path.join(lockDir, 'debug-session.lock');
  });

  after(async function () {
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  });

  it('PID-scoped write and read round-trip preserves payload', async function () {
    const payload = {
      pid: 12345,
      port: 5678,
      engine: 'experimental',
      workspaceId: 'abc',
      workspaceName: 'test-workspace',
      timestamp: new Date().toISOString(),
    };

    await perf.measure('lock write', async () => {
      await fs.writeFile(lockFileForPid(payload.pid), JSON.stringify(payload), 'utf-8');
    }, { group: 'lock' });

    const round = await perf.measure('lock read', async () =>
      readLockForPid(payload.pid),
    { group: 'lock' });
    assert.deepStrictEqual(round, payload);
  });

  it('keeps one PID-scoped lock across both engines and defaults legacy locks to debugpy', async function () {
    const pid = 33333;
    const lockFile = lockFileForPid(pid);
    const legacyPayload = {
      pid,
      port: 5678,
      workspaceId: 'legacy',
      workspaceName: 'legacy-workspace',
      timestamp: new Date().toISOString(),
    };
    await fs.writeFile(lockFile, JSON.stringify(legacyPayload), 'utf-8');

    const legacy = await readLockForPid(pid);
    assert.ok(legacy);
    assert.strictEqual(normalizeDebugEngine(legacy.engine), 'debugpy');

    const experimentalPayload = { ...legacyPayload, engine: 'experimental' };
    await fs.writeFile(lockFile, JSON.stringify(experimentalPayload), 'utf-8');
    assert.strictEqual(lockFileForPid(pid), lockFile, 'engine selection must not create a second lock path');
    assert.deepStrictEqual(await readLockForPid(pid), experimentalPayload);
  });

  it('legacy global lock is ignored for a different target PID', async function () {
    const payload = {
      pid: 11111,
      port: 5678,
      workspaceId: 'abc',
      workspaceName: 'test-workspace',
      timestamp: new Date().toISOString(),
    };

    await fs.writeFile(legacyLockFile, JSON.stringify(payload), 'utf-8');

    assert.deepStrictEqual(await readLockForPid(payload.pid), payload);
    assert.strictEqual(await readLockForPid(22222), null);
  });

  it('remove is idempotent', async function () {
    const lockFile = lockFileForPid(12345);
    await fs.unlink(lockFile).catch(() => {});
    await fs.unlink(lockFile).catch(() => {});
    await assert.rejects(fs.access(lockFile));
  });

  it('stale-lock detection: missing pid must be treated as stale', function () {
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        // NOTE: extension.ts treats ANY error (ENOENT, EPERM) as stale.
        // That means a lock held by another user's process is also considered stale —
        // see optimization.md for the discussion.
        return false;
      }
    };
    assert.strictEqual(isAlive(process.pid), true, 'our own pid must be alive');
    assert.strictEqual(isAlive(2 ** 22 - 1), false, 'very large pid should be dead');
  });
});
