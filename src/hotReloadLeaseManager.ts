import { randomBytes } from 'crypto';

const DEFAULT_TTL_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const LEASE_PATTERN = /^[0-9a-f]{64}$/;

/** Transport boundary implemented by the process-side hot-reload protocol. */
export interface HotReloadLeaseTransport {
  acquireLease(pid: number, lease: string, ttlMs: number): Promise<void>;
  renewLease(pid: number, lease: string, ttlMs: number): Promise<void>;
  releaseLease(pid: number, lease: string): Promise<void>;
}

/** Injectable one-shot timer used to make lease expiry deterministic in tests. */
export interface HotReloadLeaseTimer {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface HotReloadLeaseManagerOptions {
  enabled?: boolean;
  ttlMs?: number;
  heartbeatMs?: number;
  timer?: HotReloadLeaseTimer;
  createLease?: () => string;
  onError?: (error: unknown, operation: 'acquire' | 'renew' | 'release', pid: number) => void;
  onStateChange?: () => void;
}

export interface HotReloadLeaseState {
  pid: number;
  generation: number;
  ownerCount: number;
  status: 'acquiring' | 'active';
  expiresAt?: number;
}

export interface HotReloadLeaseManagerState {
  enabled: boolean;
  disposed: boolean;
  sessions: ReadonlyArray<{ sessionId: string; pid: number }>;
  leases: ReadonlyArray<HotReloadLeaseState>;
}

/** Internal active-token view used to authorize reload requests. */
export interface HotReloadActiveLease {
  pid: number;
  leaseId: string;
  ownerSessionIds: ReadonlyArray<string>;
  expiresAt: number;
}

interface LeaseRecord {
  readonly pid: number;
  readonly generation: number;
  readonly lease: string;
  acquired: boolean;
  active: boolean;
  retired: boolean;
  expiresAt?: number;
  timerHandle?: unknown;
  operation: Promise<void>;
  ready: Promise<void>;
  acquireFailed: boolean;
  acquireError?: unknown;
  releasePromise?: Promise<void>;
}

const SYSTEM_TIMER: HotReloadLeaseTimer = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * Coordinates process-scoped hot-reload leases without depending on VS Code.
 *
 * Sessions that target the same PID share one random lease. A lease is acquired
 * for the first owner and released after the last owner leaves. Every async
 * start is generation-checked, so a late acquire can only release its stale
 * lease and can never resurrect a stopped session.
 */
export class HotReloadLeaseManager {
  private readonly sessions = new Map<string, number>();
  private readonly sessionGenerations = new Map<string, number>();
  private readonly ownersByPid = new Map<number, Set<string>>();
  private readonly leasesByPid = new Map<number, LeaseRecord>();
  private readonly pidGenerations = new Map<number, number>();
  private readonly ttlMs: number;
  private readonly heartbeatMs: number;
  private readonly timer: HotReloadLeaseTimer;
  private readonly createLease: () => string;
  private readonly onError?: HotReloadLeaseManagerOptions['onError'];
  private readonly onStateChange?: HotReloadLeaseManagerOptions['onStateChange'];
  private enabled: boolean;
  private disposed = false;

  constructor(
    private readonly transport: HotReloadLeaseTransport,
    options: HotReloadLeaseManagerOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError('ttlMs must be a positive finite number');
    }
    if (
      !Number.isFinite(this.heartbeatMs)
      || this.heartbeatMs <= 0
      || this.heartbeatMs >= this.ttlMs
    ) {
      throw new RangeError('heartbeatMs must be positive and less than ttlMs');
    }
    this.enabled = options.enabled ?? true;
    this.timer = options.timer ?? SYSTEM_TIMER;
    this.createLease = options.createLease ?? (() => randomBytes(32).toString('hex'));
    this.onError = options.onError;
    this.onStateChange = options.onStateChange;
  }

  /** Register or move a debug session to a target PID. */
  async registerSession(sessionId: string, pid: number): Promise<void> {
    this.assertUsable();
    this.validateSessionId(sessionId);
    this.validatePid(pid);

    const sessionGeneration = this.nextSessionGeneration(sessionId);
    const previousPid = this.sessions.get(sessionId);
    if (previousPid === pid) {
      if (this.enabled) {
        await this.ensureLease(pid);
      }
      return;
    }

    if (previousPid !== undefined) {
      await this.detachOwner(sessionId, previousPid);
      if (!this.isCurrentSessionGeneration(sessionId, sessionGeneration)) {
        return;
      }
    }

    if (this.disposed || !this.isCurrentSessionGeneration(sessionId, sessionGeneration)) {
      return;
    }
    this.sessions.set(sessionId, pid);
    const owners = this.ownersByPid.get(pid) ?? new Set<string>();
    owners.add(sessionId);
    this.ownersByPid.set(pid, owners);
    this.notifyStateChange();
    if (this.enabled) {
      await this.ensureLease(pid);
    }
  }

  /** Remove one session owner; the shared PID lease survives other owners. */
  async unregisterSession(sessionId: string): Promise<void> {
    this.validateSessionId(sessionId);
    this.nextSessionGeneration(sessionId);
    const pid = this.sessions.get(sessionId);
    if (pid !== undefined) {
      await this.detachOwner(sessionId, pid);
    }
  }

  /** Enable or disable leases while retaining the registered session set. */
  async setEnabled(enabled: boolean): Promise<void> {
    this.assertUsable();
    if (typeOfBoolean(enabled) === false) {
      throw new TypeError('enabled must be a boolean');
    }
    this.enabled = enabled;
    this.notifyStateChange();
    if (!enabled) {
      const releases = [...this.leasesByPid.values()].map((record) =>
        this.retireLease(record)
      );
      await Promise.allSettled(releases);
      return;
    }
    await this.reconcile();
  }

  /** Retry any desired PID that currently has no live/acquiring lease. */
  async reconcile(): Promise<void> {
    this.assertUsable();
    if (!this.enabled) {
      return;
    }
    const starts = [...this.ownersByPid.entries()]
      .filter(([, owners]) => owners.size > 0)
      .map(([pid]) => this.ensureLease(pid));
    await Promise.all(starts);
  }

  /** Return a token-free state snapshot suitable for status UI and tests. */
  getState(): HotReloadLeaseManagerState {
    const sessions = [...this.sessions.entries()]
      .map(([sessionId, pid]) => ({ sessionId, pid }))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    const leases = [...this.leasesByPid.values()]
      .filter((record) => !record.retired)
      .map((record): HotReloadLeaseState => ({
        pid: record.pid,
        generation: record.generation,
        ownerCount: this.ownersByPid.get(record.pid)?.size ?? 0,
        status: record.active ? 'active' : 'acquiring',
        ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
      }))
      .sort((left, right) => left.pid - right.pid);
    return {
      enabled: this.enabled,
      disposed: this.disposed,
      sessions,
      leases,
    };
  }

  /**
   * Return only fully acquired, unexpired lease generations. Unlike getState(),
   * this internal transport view includes the capability token needed by a v3
   * reload request and must never be logged or displayed.
   */
  getActiveLeases(): ReadonlyArray<HotReloadActiveLease> {
    const now = this.timer.now();
    return [...this.leasesByPid.values()]
      .filter((record) =>
        record.active
        && !record.retired
        && record.expiresAt !== undefined
        && record.expiresAt > now
        && this.isRecordDesired(record)
      )
      .map((record) => ({
        pid: record.pid,
        leaseId: record.lease,
        ownerSessionIds: [...(this.ownersByPid.get(record.pid) ?? [])].sort(),
        expiresAt: record.expiresAt as number,
      }))
      .sort((left, right) => left.pid - right.pid);
  }

  /** Release every lease. Release failures are reported but never rethrown. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.enabled = false;
    for (const sessionId of this.sessions.keys()) {
      this.nextSessionGeneration(sessionId);
    }
    this.sessions.clear();
    this.ownersByPid.clear();
    this.notifyStateChange();
    const releases = [...this.leasesByPid.values()].map((record) =>
      this.retireLease(record)
    );
    await Promise.allSettled(releases);
  }

  private async detachOwner(sessionId: string, pid: number): Promise<void> {
    if (this.sessions.get(sessionId) === pid) {
      this.sessions.delete(sessionId);
    }
    const owners = this.ownersByPid.get(pid);
    owners?.delete(sessionId);
    this.notifyStateChange();
    if (owners && owners.size > 0) {
      return;
    }
    this.ownersByPid.delete(pid);
    const record = this.leasesByPid.get(pid);
    if (record) {
      await this.retireLease(record);
    }
  }

  private ensureLease(pid: number): Promise<void> {
    if (!this.isPidDesired(pid)) {
      return Promise.resolve();
    }
    const existing = this.leasesByPid.get(pid);
    if (existing && !existing.retired) {
      return existing.ready;
    }

    const lease = this.createLease().toLowerCase();
    if (!LEASE_PATTERN.test(lease)) {
      throw new TypeError('createLease must return exactly 64 lowercase hexadecimal characters');
    }
    const generation = (this.pidGenerations.get(pid) ?? 0) + 1;
    this.pidGenerations.set(pid, generation);
    const record: LeaseRecord = {
      pid,
      generation,
      lease,
      acquired: false,
      active: false,
      retired: false,
      operation: Promise.resolve(),
      ready: Promise.resolve(),
      acquireFailed: false,
    };
    this.leasesByPid.set(pid, record);
    this.notifyStateChange();

    record.operation = Promise.resolve()
      .then(() => this.transport.acquireLease(pid, lease, this.ttlMs))
      .then(
        () => { record.acquired = true; },
        (error: unknown) => {
          record.acquireFailed = true;
          record.acquireError = error;
        },
      );
    record.ready = record.operation.then(async () => {
      if (record.acquireFailed) {
        if (this.leasesByPid.get(pid) === record) {
          this.leasesByPid.delete(pid);
        }
        this.notifyStateChange();
        this.reportError(record.acquireError, 'acquire', pid);
        throw record.acquireError;
      }
      if (!this.isRecordDesired(record)) {
        await this.retireLease(record);
        return;
      }
      record.active = true;
      record.expiresAt = this.timer.now() + this.ttlMs;
      this.notifyStateChange();
      this.scheduleHeartbeat(record);
    });
    return record.ready;
  }

  private scheduleHeartbeat(record: LeaseRecord): void {
    if (!this.isRecordDesired(record) || record.expiresAt === undefined) {
      return;
    }
    if (record.timerHandle !== undefined) {
      this.timer.clearTimeout(record.timerHandle);
    }
    const untilExpiry = Math.max(1, record.expiresAt - this.timer.now());
    const delay = Math.min(this.heartbeatMs, untilExpiry);
    record.timerHandle = this.timer.setTimeout(() => {
      record.timerHandle = undefined;
      void this.heartbeat(record);
    }, delay);
  }

  private async heartbeat(record: LeaseRecord): Promise<void> {
    if (!this.isRecordDesired(record)) {
      return;
    }
    if (record.expiresAt === undefined || this.timer.now() >= record.expiresAt) {
      await this.restartExpiredLease(record);
      return;
    }

    let renewError: unknown;
    let renewed = false;
    record.operation = record.operation.then(async () => {
      if (!this.isRecordDesired(record)) {
        return;
      }
      try {
        await this.transport.renewLease(record.pid, record.lease, this.ttlMs);
        renewed = true;
      } catch (error) {
        renewError = error;
      }
    });
    await record.operation;

    if (!this.isRecordDesired(record)) {
      return;
    }
    if (renewed) {
      record.expiresAt = this.timer.now() + this.ttlMs;
      this.scheduleHeartbeat(record);
      return;
    }
    this.reportError(renewError, 'renew', record.pid);
    if (record.expiresAt === undefined || this.timer.now() >= record.expiresAt) {
      await this.restartExpiredLease(record);
    } else {
      this.scheduleHeartbeat(record);
    }
  }

  private async restartExpiredLease(record: LeaseRecord): Promise<void> {
    const pid = record.pid;
    await this.retireLease(record);
    if (this.isPidDesired(pid)) {
      try {
        await this.ensureLease(pid);
      } catch {
        // ensureLease already reports acquire failures. A later reconcile can retry.
      }
    }
  }

  private retireLease(record: LeaseRecord): Promise<void> {
    if (record.releasePromise) {
      return record.releasePromise;
    }
    record.retired = true;
    record.active = false;
    if (record.timerHandle !== undefined) {
      this.timer.clearTimeout(record.timerHandle);
      record.timerHandle = undefined;
    }
    if (this.leasesByPid.get(record.pid) === record) {
      this.leasesByPid.delete(record.pid);
    }
    this.notifyStateChange();

    record.releasePromise = record.operation.then(async () => {
      if (!record.acquired) {
        return;
      }
      try {
        await this.transport.releaseLease(record.pid, record.lease);
      } catch (error) {
        this.reportError(error, 'release', record.pid);
      }
    });
    return record.releasePromise;
  }

  private isRecordDesired(record: LeaseRecord): boolean {
    return (
      !record.retired
      && this.leasesByPid.get(record.pid) === record
      && this.pidGenerations.get(record.pid) === record.generation
      && this.isPidDesired(record.pid)
    );
  }

  private isPidDesired(pid: number): boolean {
    return (
      !this.disposed
      && this.enabled
      && (this.ownersByPid.get(pid)?.size ?? 0) > 0
    );
  }

  private nextSessionGeneration(sessionId: string): number {
    const generation = (this.sessionGenerations.get(sessionId) ?? 0) + 1;
    this.sessionGenerations.set(sessionId, generation);
    return generation;
  }

  private isCurrentSessionGeneration(sessionId: string, generation: number): boolean {
    return this.sessionGenerations.get(sessionId) === generation;
  }

  private reportError(
    error: unknown,
    operation: 'acquire' | 'renew' | 'release',
    pid: number,
  ): void {
    try {
      this.onError?.(error, operation, pid);
    } catch {
      // Diagnostics must not break lease cleanup.
    }
  }

  private notifyStateChange(): void {
    try {
      this.onStateChange?.();
    } catch {
      // UI observers must not break lease ownership or cleanup.
    }
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new Error('HotReloadLeaseManager is disposed');
    }
  }

  private validateSessionId(sessionId: string): void {
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new TypeError('sessionId must be a non-empty string');
    }
  }

  private validatePid(pid: number): void {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new TypeError('pid must be a positive integer');
    }
  }
}

function typeOfBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}
