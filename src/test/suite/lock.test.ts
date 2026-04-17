import * as assert from 'assert';
import { describe, it, before, after } from 'mocha';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { getPerf } from './perfReporter';

/**
 * Lock-file behavior is currently inlined in extension.ts (readLock/writeLock/removeLock).
 * This suite emulates the on-disk contract so that when the lock module is extracted
 * (see optimization.md "Refactoring") we can swap to importing it directly.
 */
describe('Feature: debug session lock-file contract', function () {
  const perf = getPerf();
  let lockDir: string;
  let lockFile: string;

  before(async function () {
    lockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dpd-lock-'));
    lockFile = path.join(lockDir, 'debug-session.lock');
  });

  after(async function () {
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  });

  it('write and read round-trip preserves payload', async function () {
    const payload = {
      pid: 12345,
      port: 5678,
      workspaceId: 'abc',
      workspaceName: 'test-workspace',
      timestamp: new Date().toISOString(),
    };

    await perf.measure('lock write', async () => {
      await fs.writeFile(lockFile, JSON.stringify(payload), 'utf-8');
    }, { group: 'lock' });

    const round = JSON.parse(
      await perf.measure('lock read', async () =>
        fs.readFile(lockFile, 'utf-8'),
      { group: 'lock' }),
    );
    assert.deepStrictEqual(round, payload);
  });

  it('remove is idempotent', async function () {
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
