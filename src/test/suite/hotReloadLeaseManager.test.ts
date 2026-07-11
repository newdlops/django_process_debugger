import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
  HotReloadLeaseManager,
  HotReloadLeaseTimer,
  HotReloadLeaseTransport,
} from '../../hotReloadLeaseManager';

interface LeaseCall {
  pid: number;
  lease: string;
  ttlMs?: number;
}

class FakeTransport implements HotReloadLeaseTransport {
  readonly acquired: LeaseCall[] = [];
  readonly renewed: LeaseCall[] = [];
  readonly released: LeaseCall[] = [];
  acquireImpl: (call: LeaseCall) => Promise<void> = async () => {};
  renewImpl: (call: LeaseCall) => Promise<void> = async () => {};
  releaseImpl: (call: LeaseCall) => Promise<void> = async () => {};

  async acquireLease(pid: number, lease: string, ttlMs: number): Promise<void> {
    const call = { pid, lease, ttlMs };
    this.acquired.push(call);
    await this.acquireImpl(call);
  }

  async renewLease(pid: number, lease: string, ttlMs: number): Promise<void> {
    const call = { pid, lease, ttlMs };
    this.renewed.push(call);
    await this.renewImpl(call);
  }

  async releaseLease(pid: number, lease: string): Promise<void> {
    const call = { pid, lease };
    this.released.push(call);
    await this.releaseImpl(call);
  }
}

class FakeClock implements HotReloadLeaseTimer {
  private current = 0;
  private nextHandle = 1;
  private readonly entries = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle++;
    this.entries.set(handle, { at: this.current + delayMs, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') {
      this.entries.delete(handle);
    }
  }

  pendingCount(): number {
    return this.entries.size;
  }

  async advanceBy(delayMs: number): Promise<void> {
    const target = this.current + delayMs;
    while (true) {
      const due = [...this.entries.entries()]
        .filter(([, entry]) => entry.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) {
        break;
      }
      this.current = due[1].at;
      this.entries.delete(due[0]);
      due[1].callback();
      await flushAsync();
    }
    this.current = target;
    await flushAsync();
  }
}

function leaseFactory(): () => string {
  let sequence = 0;
  return () => (++sequence).toString(16).padStart(64, '0');
}

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: unknown): void } {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe('Feature: hot reload expiring lease coordinator', function () {
  it('shares one 64-hex lease between sessions that own the same PID', async function () {
    const transport = new FakeTransport();
    const manager = new HotReloadLeaseManager(transport, { createLease: leaseFactory() });

    await manager.registerSession('session-a', 101);
    await manager.registerSession('session-b', 101);

    assert.strictEqual(transport.acquired.length, 1);
    assert.match(transport.acquired[0].lease, /^[0-9a-f]{64}$/);
    assert.deepStrictEqual(manager.getActiveLeases(), [{
      pid: 101,
      leaseId: transport.acquired[0].lease,
      ownerSessionIds: ['session-a', 'session-b'],
      expiresAt: manager.getActiveLeases()[0].expiresAt,
    }]);
    assert.deepStrictEqual(manager.getState().leases, [{
      pid: 101,
      generation: 1,
      ownerCount: 2,
      status: 'active',
      expiresAt: manager.getState().leases[0].expiresAt,
    }]);

    await manager.unregisterSession('session-a');
    assert.strictEqual(transport.released.length, 0, 'the second owner still needs the lease');
    assert.deepStrictEqual(manager.getActiveLeases()[0].ownerSessionIds, ['session-b']);
    await manager.unregisterSession('session-b');
    assert.deepStrictEqual(transport.released, [{ pid: 101, lease: transport.acquired[0].lease }]);
    assert.deepStrictEqual(manager.getActiveLeases(), []);
    await manager.dispose();
  });

  it('keeps different PIDs independent', async function () {
    const transport = new FakeTransport();
    const manager = new HotReloadLeaseManager(transport, { createLease: leaseFactory() });

    await Promise.all([
      manager.registerSession('session-a', 201),
      manager.registerSession('session-b', 202),
    ]);

    assert.deepStrictEqual(transport.acquired.map((call) => call.pid).sort(), [201, 202]);
    assert.notStrictEqual(transport.acquired[0].lease, transport.acquired[1].lease);
    await manager.dispose();
    assert.deepStrictEqual(transport.released.map((call) => call.pid).sort(), [201, 202]);
  });

  it('retains session owners while disabled and uses a fresh lease after re-enable', async function () {
    const transport = new FakeTransport();
    const manager = new HotReloadLeaseManager(transport, {
      enabled: false,
      createLease: leaseFactory(),
    });

    await manager.registerSession('session-a', 301);
    assert.strictEqual(transport.acquired.length, 0);
    await manager.setEnabled(true);
    const firstLease = transport.acquired[0].lease;
    await manager.setEnabled(false);
    assert.strictEqual(transport.released[0].lease, firstLease);
    assert.deepStrictEqual(manager.getState().sessions, [{ sessionId: 'session-a', pid: 301 }]);

    await manager.setEnabled(true);
    assert.strictEqual(transport.acquired.length, 2);
    assert.notStrictEqual(transport.acquired[1].lease, firstLease);
    await manager.dispose();
  });

  it('renews a live lease on the injected heartbeat clock', async function () {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const manager = new HotReloadLeaseManager(transport, {
      ttlMs: 1_000,
      heartbeatMs: 250,
      timer: clock,
      createLease: leaseFactory(),
    });

    await manager.registerSession('session-a', 401);
    await clock.advanceBy(249);
    assert.strictEqual(transport.renewed.length, 0);
    await clock.advanceBy(1);
    assert.strictEqual(transport.renewed.length, 1);
    assert.strictEqual(transport.renewed[0].lease, transport.acquired[0].lease);
    await clock.advanceBy(250);
    assert.strictEqual(transport.renewed.length, 2);
    await manager.dispose();
  });

  it('replaces an expired lease after repeated renewal failures', async function () {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const errors: Array<{ operation: string; pid: number }> = [];
    transport.renewImpl = async () => { throw new Error('renew failed'); };
    const manager = new HotReloadLeaseManager(transport, {
      ttlMs: 400,
      heartbeatMs: 100,
      timer: clock,
      createLease: leaseFactory(),
      onError: (_error, operation, pid) => errors.push({ operation, pid }),
    });

    await manager.registerSession('session-a', 501);
    const firstLease = transport.acquired[0].lease;
    await clock.advanceBy(400);

    assert.ok(errors.some((entry) => entry.operation === 'renew' && entry.pid === 501));
    assert.strictEqual(transport.acquired.length, 2, 'expiry should acquire a replacement lease');
    assert.notStrictEqual(transport.acquired[1].lease, firstLease);
    assert.ok(transport.released.some((call) => call.lease === firstLease));
    await manager.dispose();
  });

  it('releases a late acquire instead of resurrecting a stopped session', async function () {
    const transport = new FakeTransport();
    const pendingAcquire = deferred();
    transport.acquireImpl = async () => pendingAcquire.promise;
    const manager = new HotReloadLeaseManager(transport, { createLease: leaseFactory() });

    const starting = manager.registerSession('session-a', 601);
    await flushAsync();
    assert.strictEqual(transport.acquired.length, 1);
    const stopping = manager.unregisterSession('session-a');
    pendingAcquire.resolve();
    await Promise.all([starting, stopping]);

    assert.strictEqual(transport.released.length, 1);
    assert.strictEqual(transport.released[0].lease, transport.acquired[0].lease);
    assert.deepStrictEqual(manager.getState().leases, []);
    assert.deepStrictEqual(manager.getState().sessions, []);
    await manager.dispose();
  });

  it('keeps a new generation active when an older acquire completes late', async function () {
    const transport = new FakeTransport();
    const firstAcquire = deferred();
    let acquireIndex = 0;
    transport.acquireImpl = async () => {
      acquireIndex += 1;
      if (acquireIndex === 1) {
        await firstAcquire.promise;
      }
    };
    const manager = new HotReloadLeaseManager(transport, { createLease: leaseFactory() });

    const oldStart = manager.registerSession('session-a', 701);
    await flushAsync();
    const oldStop = manager.unregisterSession('session-a');
    const newStart = manager.registerSession('session-a', 701);
    await flushAsync();
    assert.strictEqual(transport.acquired.length, 2);
    const newLease = transport.acquired[1].lease;

    firstAcquire.resolve();
    await Promise.all([oldStart, oldStop, newStart]);
    assert.ok(transport.released.some((call) => call.lease === transport.acquired[0].lease));
    assert.ok(!transport.released.some((call) => call.lease === newLease));
    assert.strictEqual(manager.getState().leases[0].generation, 2);
    await manager.dispose();
  });

  it('does not complete a session move after a concurrent stop invalidates it', async function () {
    const transport = new FakeTransport();
    const releaseGate = deferred();
    transport.releaseImpl = async (call) => {
      if (call.pid === 801) {
        await releaseGate.promise;
      }
    };
    const manager = new HotReloadLeaseManager(transport, { createLease: leaseFactory() });
    await manager.registerSession('session-a', 801);

    const moving = manager.registerSession('session-a', 802);
    await flushAsync();
    const stopping = manager.unregisterSession('session-a');
    releaseGate.resolve();
    await Promise.all([moving, stopping]);

    assert.ok(!transport.acquired.some((call) => call.pid === 802));
    assert.deepStrictEqual(manager.getState().sessions, []);
    await manager.dispose();
  });

  it('dispose releases all owners best-effort and clears heartbeat timers', async function () {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const releaseErrors: number[] = [];
    transport.releaseImpl = async (call) => {
      if (call.pid === 901) {
        throw new Error('release failed');
      }
    };
    const manager = new HotReloadLeaseManager(transport, {
      ttlMs: 1_000,
      heartbeatMs: 250,
      timer: clock,
      createLease: leaseFactory(),
      onError: (_error, operation, pid) => {
        if (operation === 'release') { releaseErrors.push(pid); }
      },
    });
    await manager.registerSession('session-a', 901);
    await manager.registerSession('session-b', 902);
    assert.strictEqual(clock.pendingCount(), 2);

    await assert.doesNotReject(manager.dispose());
    assert.deepStrictEqual(transport.released.map((call) => call.pid).sort(), [901, 902]);
    assert.deepStrictEqual(releaseErrors, [901]);
    assert.strictEqual(clock.pendingCount(), 0);
    assert.strictEqual(manager.getState().disposed, true);
    await assert.rejects(manager.registerSession('late-session', 903), /disposed/);
  });
});
