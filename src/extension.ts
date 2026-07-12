import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { preflightCleanAll, runCleanAll, type CleanAllScope } from './cleanAll';
import { DjangoProcess, DjangoProcessFinder } from './processFinder';
import {
  DebugpyInjector,
  BootstrapNotLoadedError,
  BootstrapNotInstalledError,
  BootstrapRuntimeVersionError,
  BOOTSTRAP_VERSION,
  HOT_RELOAD_LEASE_HEARTBEAT_MS,
  HOT_RELOAD_LEASE_TTL_MS,
  isValidExperimentalAuthToken,
  type DebugpyEndpoint,
} from './debugpyInjector';
import { DebugpyManager, DebugpyProvisioningInfo } from './debugpyManager';
import { log, logError, getLogger } from './logger';
import { shouldIgnoreForHotReload } from './hotReloadFilter';
import { HotReloadLeaseManager } from './hotReloadLeaseManager';
import { TcpListeningEndpoint, formatEndpoint } from './listeningEndpoint';
import { summarizeDapMessage } from './dapLogging';
import {
  processQuickPickDescription,
  processQuickPickDetail,
  selectGroupedDisplayCwd,
} from './processQuickPickDisplay';
import {
  DEBUG_SESSION_AUTH_TOKEN_KEY,
  DEBUG_SESSION_LOCK_TOKEN_KEY,
  DebugSessionLockGuard,
  DebugSessionLockTarget,
  DjangoDebugSessionFactory,
  ensureDebugSessionLockToken,
} from './debugSession';
import {
  DEFAULT_DEBUG_ENGINE,
  DebugEngine,
  debugEngineDisplayName,
  normalizeDebugEngine,
  supportsHotReload,
} from './debugEngine';
import {
  DJANGO_PROCESS_DEBUGGER_PUBLIC_API,
  SETUP_COMMAND_ID,
  STATUS_COMMAND_ID,
  type DjangoProcessDebuggerPublicApiV1,
} from './publicApi';
import {
  RuntimeCandidate,
  SetupProfile,
  buildSavedProfileCandidate,
  clearSetupProfile,
  createSetupProfile,
  discoverRuntimeCandidates,
  formatPreflightForConfirmation,
  getSetupProfile,
  inspectRuntimePreflight,
  isProfileStillInstalled,
  saveSetupProfile,
} from './runtimeSetup';
import { setupMcpWorkspace } from './mcp/setup';
import { diagnoseMcpWorkspace, type McpWorkspaceDiagnostics } from './mcp/diagnostics';
import { McpVerificationError, verifyMcpWorkspace } from './mcp/verification';
import { DjangoMcpDebugController } from './mcp/debugController';
import { startMcpWindowHost, type StartedMcpWindowHost } from './mcp/windowHost';
import {
  createMcpWindowId,
  defaultMcpRegistryDir,
  McpWindowIdCollisionError,
  type McpWorkspaceFolderManifest,
} from './mcp/windowRegistry';
import type { McpTransportBackend } from './mcp/transport';

const LOCK_DIR = '/tmp/django-process-debugger';
const LEGACY_LOCK_FILE = path.join(LOCK_DIR, 'debug-session.lock');
const PENDING_LOCK_TTL_MS = 30_000;
const MCP_WINDOW_ID_VARIABLE = 'DJANGO_PROCESS_DEBUGGER_WINDOW_ID';
const MCP_REGISTRY_DIR_VARIABLE = 'DJANGO_PROCESS_DEBUGGER_MCP_REGISTRY_DIR';
let activeHotReloadShutdown: (() => Promise<void>) | undefined;
let activeMcpShutdown: (() => Promise<void>) | undefined;

export function mcpToolRequiresEvaluatePermission(name: string, args: unknown): boolean {
  if (name === 'django_expression_inspect') {
    return true;
  }
  if (name !== 'django_breakpoints_update'
    || typeof args !== 'object'
    || args === null
    || !Array.isArray((args as { breakpoints?: unknown }).breakpoints)) {
    return false;
  }
  return ((args as { breakpoints: unknown[] }).breakpoints).some((breakpoint) =>
    typeof breakpoint === 'object'
    && breakpoint !== null
    && (typeof (breakpoint as { condition?: unknown }).condition === 'string'
      || typeof (breakpoint as { logMessage?: unknown }).logMessage === 'string'));
}

function configureMcpWindowEnvironment(
  collection: vscode.EnvironmentVariableCollection,
): string {
  collection.persistent = true;
  // Keep terminal-launched clients on the exact registry used by the window
  // host. IDE-launched clients use the same deterministic default directly.
  collection.replace(MCP_REGISTRY_DIR_VARIABLE, defaultMcpRegistryDir());
  // Never reuse a cached id from a previous extension host. Environment
  // collections persist across window reloads and two windows for the same
  // workspace can begin with the same cached value. A fresh id keeps new
  // terminals window-local; terminals retaining an old id go through the
  // bridge's fail-closed stale-id discovery path.
  const created = createMcpWindowId();
  collection.replace(MCP_WINDOW_ID_VARIABLE, created);
  return created;
}

interface LockInfo {
  pid: number;
  host?: string;
  port: number;
  engine?: DebugEngine;
  sessionId?: string;
  ownerToken?: string;
  ownerExtensionPid?: number;
  phase?: 'pending' | 'active';
  workspaceId: string;
  workspaceName: string;
  timestamp: string;
}

function lockFileForPid(pid: number): string {
  return path.join(LOCK_DIR, `debug-session.${pid}.lock`);
}

function readLockFile(lockFile: string): LockInfo | null {
  try {
    const data = fs.readFileSync(lockFile, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function readLockForPid(pid: number): LockInfo | null {
  const pidLock = readLockFile(lockFileForPid(pid));
  if (pidLock) {
    return pidLock;
  }

  // Backward compatibility for older builds that wrote a single global lock.
  const legacyLock = readLockFile(LEGACY_LOCK_FILE);
  return legacyLock?.pid === pid ? legacyLock : null;
}

function writeLock(info: LockInfo): void {
  fs.mkdirSync(LOCK_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(LOCK_DIR, 0o700); } catch { /* best effort */ }

  const lockFile = lockFileForPid(info.pid);
  const tempFile = `${lockFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(info), {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(tempFile, lockFile);
  } finally {
    try { fs.unlinkSync(tempFile); } catch { /* already renamed or never created */ }
  }

  // Do not leave a stale global lock that can block a different worker PID.
  const legacyLock = readLockFile(LEGACY_LOCK_FILE);
  if (legacyLock?.pid === info.pid) {
    try { fs.unlinkSync(LEGACY_LOCK_FILE); } catch { /* ignore */ }
  }
}

function createLockExclusive(info: LockInfo): boolean {
  fs.mkdirSync(LOCK_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(LOCK_DIR, 0o700); } catch { /* best effort */ }

  const lockFile = lockFileForPid(info.pid);
  let fd: number | undefined;
  try {
    fd = fs.openSync(lockFile, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(info), 'utf-8');
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      return false;
    }
    if (fd !== undefined) {
      try { fs.unlinkSync(lockFile); } catch { /* ignore partial claim cleanup */ }
    }
    throw err;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function removeLock(pid: number): void {
  try { fs.unlinkSync(lockFileForPid(pid)); } catch { /* ignore */ }
  const legacyLock = readLockFile(LEGACY_LOCK_FILE);
  if (legacyLock?.pid === pid) {
    try { fs.unlinkSync(LEGACY_LOCK_FILE); } catch { /* ignore */ }
  }
}

function getWorkspaceId(): string {
  // Use a combination that's unique per VS Code window
  return process.pid + '-' + (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'unknown');
}

function getWorkspaceName(): string {
  return vscode.workspace.workspaceFolders?.[0]?.name ?? 'Unknown Workspace';
}

function targetPidFromSession(session: vscode.DebugSession): number | undefined {
  const configuredPid = session.configuration.pid;
  if (typeof configuredPid === 'number' && Number.isInteger(configuredPid) && configuredPid > 0) {
    return configuredPid;
  }

  const match = session.name.match(/\(PID:\s*(\d+)\)/);
  if (!match) {
    return undefined;
  }
  const pid = parseInt(match[1], 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function getConfiguredDebugEngine(): DebugEngine {
  const raw = vscode.workspace
    .getConfiguration('djangoProcessDebugger')
    .get<unknown>('engine', DEFAULT_DEBUG_ENGINE);
  const engine = normalizeDebugEngine(raw);
  if (raw !== engine) {
    log(`[Engine] Unknown configured engine ${JSON.stringify(raw)}; falling back to ${engine}`);
  }
  return engine;
}

function targetEngineFromSession(session: vscode.DebugSession): DebugEngine {
  return normalizeDebugEngine(session.configuration.engine ?? getConfiguredDebugEngine());
}

export function activate(context: vscode.ExtensionContext): DjangoProcessDebuggerPublicApiV1 {
  log('Extension activating...');

  const processFinder = new DjangoProcessFinder();
  const injector = new DebugpyInjector();
  const debugpyManager = new DebugpyManager(context);
  const hotReloadLifecycleTokens = new Map<string, symbol>();
  const hotReloadTokenBySession = new WeakMap<vscode.DebugSession, symbol>();
  const hotReloadReleasesBySession = new Map<
    string,
    { lifecycleToken?: symbol; promise: Promise<void> }
  >();
  const hotReloadLeaseManager = new HotReloadLeaseManager({
    acquireLease: (pid, leaseId, ttlMs) =>
      injector.acquireHotReloadLease(pid, leaseId, ttlMs),
    renewLease: (pid, leaseId, ttlMs) =>
      injector.renewHotReloadLease(pid, leaseId, ttlMs),
    releaseLease: (pid, leaseId) =>
      injector.releaseHotReloadLease(pid, leaseId),
  }, {
    enabled: vscode.workspace
      .getConfiguration('djangoProcessDebugger')
      .get<boolean>('hotReload', true),
    ttlMs: HOT_RELOAD_LEASE_TTL_MS,
    heartbeatMs: HOT_RELOAD_LEASE_HEARTBEAT_MS,
    onError: (error, operation, pid) => {
      logError('[HotReload] Lease ' + operation + ' failed for PID=' + pid, error);
      queueMicrotask(() => reconcileHotReloadState());
    },
    onStateChange: () => {
      queueMicrotask(() => reconcileHotReloadState());
    },
  });

  let mcpWindowId = configureMcpWindowEnvironment(context.environmentVariableCollection);
  const mcpController = new DjangoMcpDebugController({
    processFinder,
    windowId: mcpWindowId,
    getWorkspaceFolders: () => vscode.workspace.workspaceFolders,
    getEngine: getConfiguredDebugEngine,
    getJustMyCode: () => vscode.workspace
      .getConfiguration('djangoProcessDebugger')
      .get<boolean>('justMyCode', true),
    getRedirectOutput: () => vscode.workspace
      .getConfiguration('djangoProcessDebugger')
      .get<boolean>('redirectOutput', true),
    getRuntimeStatus: async () => {
      const profile = await getSetupProfile(context);
      return {
        configuredEngine: getConfiguredDebugEngine(),
        setup: profile
          ? {
            configured: true,
            pythonPath: profile.pythonPath,
            pythonVersion: profile.pythonVersion,
            bootstrapVersion: profile.bootstrapVersion,
            lastSetupAt: profile.lastSetupAt,
          }
          : { configured: false },
        hotReload: hotReloadLeaseManager.getState(),
        mcpPolicy: {
          allowControl: vscode.workspace
            .getConfiguration('djangoProcessDebugger')
            .get<boolean>('mcp.allowControl', true),
          allowEvaluate: vscode.workspace
            .getConfiguration('djangoProcessDebugger')
            .get<boolean>('mcp.allowEvaluate', false),
        },
      };
    },
  });

  function ensureHotReloadLifecycleToken(session: vscode.DebugSession): symbol {
    let token = hotReloadTokenBySession.get(session);
    if (!token) {
      token = Symbol(session.id);
      hotReloadTokenBySession.set(session, token);
    }
    hotReloadLifecycleTokens.set(session.id, token);
    return token;
  }

  interface InMemorySessionClaim {
    sessionId: string;
    ownerToken: string;
  }
  const claimedSessionsByPid = new Map<number, InMemorySessionClaim>();

  function isTargetProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  interface ClaimGuardInfo {
    ownerExtensionPid?: number;
    ownerToken?: string;
    timestamp: string;
  }

  function claimGuardFileForPid(pid: number): string {
    return path.join(LOCK_DIR, `debug-session.${pid}.claim`);
  }

  function readClaimGuard(pid: number): ClaimGuardInfo | null {
    const guardFile = claimGuardFileForPid(pid);
    try {
      return JSON.parse(fs.readFileSync(guardFile, 'utf-8')) as ClaimGuardInfo;
    } catch {
      try {
        const stat = fs.statSync(guardFile);
        return { timestamp: stat.mtime.toISOString() };
      } catch {
        return null;
      }
    }
  }

  async function acquirePidClaimGuard(pid: number): Promise<() => void> {
    fs.mkdirSync(LOCK_DIR, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(LOCK_DIR, 0o700); } catch { /* best effort */ }

    const guardFile = claimGuardFileForPid(pid);
    const ownerToken = `claim:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const guardInfo: ClaimGuardInfo = {
      ownerExtensionPid: process.pid,
      ownerToken,
      timestamp: new Date().toISOString(),
    };

    for (let attempt = 0; attempt < 500; attempt++) {
      let fd: number | undefined;
      let guardCreated = false;
      try {
        fd = fs.openSync(guardFile, 'wx', 0o600);
        guardCreated = true;
        fs.writeFileSync(fd, JSON.stringify(guardInfo), 'utf-8');
        fs.closeSync(fd);
        fd = undefined;
        return () => {
          const current = readClaimGuard(pid);
          if (current?.ownerToken === ownerToken) {
            try { fs.unlinkSync(guardFile); } catch { /* ignore */ }
          }
        };
      } catch (err) {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch { /* ignore */ }
        }
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          if (guardCreated) {
            try { fs.unlinkSync(guardFile); } catch { /* ignore partial guard */ }
          }
          throw err;
        }
      }

      const observed = readClaimGuard(pid);
      const timestamp = observed ? Date.parse(observed.timestamp) : Number.NaN;
      const ownerDead = typeof observed?.ownerExtensionPid === 'number'
        && !isTargetProcessAlive(observed.ownerExtensionPid);
      const guardOwnerMissing = observed?.ownerExtensionPid === undefined
        && Number.isFinite(timestamp)
        && Date.now() - timestamp > 1_000;
      const guardExpired = Number.isFinite(timestamp)
        && Date.now() - timestamp > 120_000;
      if (observed && (ownerDead || guardOwnerMissing || guardExpired)) {
        // Re-read the token immediately before cleanup so a contender that has
        // already replaced the stale guard is not removed by an old snapshot.
        const current = readClaimGuard(pid);
        if (current?.ownerToken === observed.ownerToken) {
          try { fs.unlinkSync(guardFile); } catch { /* another contender won */ }
        }
        continue;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`Timed out acquiring the PID ${pid} debug-session claim guard.`);
  }

  async function isPidLockLive(info: LockInfo): Promise<boolean> {
    if (!isTargetProcessAlive(info.pid)) {
      return false;
    }

    const inMemoryClaim = claimedSessionsByPid.get(info.pid);
    if (inMemoryClaim
      && inMemoryClaim.sessionId === info.sessionId
      && inMemoryClaim.ownerToken === info.ownerToken) {
      return true;
    }

    if (info.phase === 'pending') {
      const timestamp = Date.parse(info.timestamp);
      return Number.isFinite(timestamp)
        && Date.now() - timestamp >= 0
        && Date.now() - timestamp <= PENDING_LOCK_TTL_MS;
    }

    // A Python engine listener can intentionally outlive its VS Code client.
    // New-format active locks therefore belong to the extension host, not just
    // the persistent listener. Legacy locks fall back to the old port probe.
    if (typeof info.ownerExtensionPid === 'number') {
      return isTargetProcessAlive(info.ownerExtensionPid);
    }

    try {
      return await injector.isPortListeningPublic(info.port, info.host);
    } catch {
      return false;
    }
  }

  function lockInfoForTarget(
    session: vscode.DebugSession,
    target: DebugSessionLockTarget,
    phase: LockInfo['phase'],
  ): LockInfo {
    return {
      pid: target.pid,
      engine: target.engine,
      sessionId: session.id,
      ownerToken: target.ownerToken,
      ownerExtensionPid: process.pid,
      phase,
      host: target.host,
      port: target.port,
      workspaceId: getWorkspaceId(),
      workspaceName: getWorkspaceName(),
      timestamp: new Date().toISOString(),
    };
  }

  type LockReservation =
    | { acquired: true; previous: LockInfo | null }
    | { acquired: false; conflict: LockInfo | null };

  async function reservePidLock(info: LockInfo): Promise<LockReservation> {
    const releaseClaimGuard = await acquirePidClaimGuard(info.pid);
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        const existingLock = readLockForPid(info.pid);
        if (existingLock) {
          const sameOwner = existingLock.workspaceId === info.workspaceId
            && ((typeof existingLock.ownerToken === 'string'
                && existingLock.ownerToken === info.ownerToken)
              || (typeof existingLock.sessionId === 'string'
                && existingLock.sessionId === info.sessionId));
          if (sameOwner) {
            writeLock(info);
            return { acquired: true, previous: existingLock };
          }
          if (await isPidLockLive(existingLock)) {
            return { acquired: false, conflict: existingLock };
          }

          log(`[DebugSession] Removing stale lock before claiming PID=${info.pid}`);
          removeLock(info.pid);
          continue;
        }

        // `wx` protects the lock contract even from older extension builds
        // that do not participate in the per-PID claim guard.
        if (createLockExclusive(info)) {
          return { acquired: true, previous: null };
        }
      }

      return { acquired: false, conflict: readLockForPid(info.pid) };
    } finally {
      releaseClaimGuard();
    }
  }

  async function removeStalePidLock(pid: number): Promise<void> {
    const releaseClaimGuard = await acquirePidClaimGuard(pid);
    try {
      const current = readLockForPid(pid);
      if (current && !await isPidLockLive(current)) {
        removeLock(pid);
      }
    } finally {
      releaseClaimGuard();
    }
  }

  async function removePidLockIf(
    pid: number,
    matches: (current: LockInfo) => boolean,
  ): Promise<boolean> {
    const releaseClaimGuard = await acquirePidClaimGuard(pid);
    try {
      const current = readLockForPid(pid);
      if (!current || !matches(current)) {
        return false;
      }
      removeLock(pid);
      return true;
    } finally {
      releaseClaimGuard();
    }
  }

  async function updatePidLockIf(
    pid: number,
    matches: (current: LockInfo) => boolean,
    next: LockInfo,
  ): Promise<boolean> {
    const releaseClaimGuard = await acquirePidClaimGuard(pid);
    try {
      const current = readLockForPid(pid);
      if (!current || !matches(current)) {
        return false;
      }
      writeLock(next);
      return true;
    } finally {
      releaseClaimGuard();
    }
  }

  const sessionLockGuard: DebugSessionLockGuard = {
    async claim(session, target) {
      const previousClaim = claimedSessionsByPid.get(target.pid);
      const claimMatches = previousClaim
        && (previousClaim.sessionId === session.id
          || previousClaim.ownerToken === target.ownerToken);
      const restorableClaim = claimMatches ? previousClaim : undefined;

      if (previousClaim && !claimMatches) {
        if (isTargetProcessAlive(target.pid)) {
          return {
            allowed: false,
            message: `Cannot attach to PID ${target.pid}: another debug session in this VS Code window already owns it. Stop that session first.`,
          };
        }
        claimedSessionsByPid.delete(target.pid);
      }

      const reservation = await reservePidLock(lockInfoForTarget(session, target, 'pending'));
      if (!reservation.acquired) {
        const existingLock = reservation.conflict;
        const lockedEngine = normalizeDebugEngine(existingLock?.engine);
        return {
          allowed: false,
          message: existingLock
            ? `Cannot attach: a debug session is already active in workspace ` +
              `"${existingLock.workspaceName}" (PID ${existingLock.pid}, engine ${lockedEngine}, ` +
              `${existingLock.host ? `${existingLock.host}:` : 'port '}${existingLock.port}). ` +
              `Stop the existing session first.`
            : `Cannot attach to PID ${target.pid}: another VS Code window is claiming it. Try again after stopping that session.`,
        };
      }

      const restorableLock = reservation.previous;
      claimedSessionsByPid.set(target.pid, {
        sessionId: session.id,
        ownerToken: target.ownerToken,
      });

      return {
        allowed: true,
        async release() {
          const releaseClaimGuard = await acquirePidClaimGuard(target.pid);
          try {
            const currentLock = readLockForPid(target.pid);
            if (currentLock?.sessionId === session.id
              && currentLock.ownerToken === target.ownerToken) {
              if (restorableLock) {
                writeLock(restorableLock);
              } else {
                removeLock(target.pid);
              }
            }

            const currentClaim = claimedSessionsByPid.get(target.pid);
            if (currentClaim?.sessionId === session.id
              && currentClaim.ownerToken === target.ownerToken) {
              if (restorableClaim) {
                claimedSessionsByPid.set(target.pid, restorableClaim);
              } else {
                claimedSessionsByPid.delete(target.pid);
              }
            }
          } finally {
            releaseClaimGuard();
          }
        },
      };
    },
  };

  // Register our own debug adapter factory.
  // This connects directly to debugpy's DAP server via TCP —
  // no dependency on ms-python.python or ms-python.debugpy extensions.
  // Debug adapter: connects directly to debugpy's DAP server via TCP
  const factory = vscode.debug.registerDebugAdapterDescriptorFactory(
    'django-process',
    new DjangoDebugSessionFactory(injector, getConfiguredDebugEngine, sessionLockGuard),
  );

  // Sessions currently paused at a breakpoint. Some adapters report a
  // thread-local stop while others suspend every Python thread.
  const pausedSessions = new Set<string>();
  interface DapEvent { type?: string; event?: string; body?: { allThreadsStopped?: boolean } }

  // DAP message tracker for debugging the debug protocol itself
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory(
    'django-process',
    {
      createDebugAdapterTracker(session: vscode.DebugSession) {
        const hotReloadLifecycleToken = ensureHotReloadLifecycleToken(session);
        return {
          onWillStartSession() {
            log(`[DAP] Session starting`);
          },
          onWillReceiveMessage(message: unknown) {
            log(`[DAP] -> send: ${summarizeDapMessage(message)}`);
          },
          onDidSendMessage(message: unknown) {
            mcpController.handleDapMessage(session, message);
            const msg = message as DapEvent;
            if (msg?.type === 'event') {
              if (msg.event === 'stopped') {
                pausedSessions.add(session.id);
                log('[HotReload] Session ' + session.id + ' paused');
              } else if (msg.event === 'continued') {
                pausedSessions.delete(session.id);
                log(`[HotReload] Session ${session.id} resumed`);
              } else if (msg.event === 'terminated' || msg.event === 'exited') {
                pausedSessions.delete(session.id);
                effectiveSessionEngines.delete(session.id);
                void revokeHotReloadSession(session.id, hotReloadLifecycleToken);
              }
            }
            log(`[DAP] <- recv: ${summarizeDapMessage(message)}`);
          },
          onError(error: Error) {
            logError(`[DAP] Error`, error);
          },
          onExit(code: number | undefined, signal: string | undefined) {
            pausedSessions.delete(session.id);
            effectiveSessionEngines.delete(session.id);
            void revokeHotReloadSession(session.id, hotReloadLifecycleToken);
            log(`[DAP] Exit: code=${code} signal=${signal}`);
          },
        };
      },
    }
  );

  interface RuntimeQuickPickItem extends vscode.QuickPickItem {
    action?: 'browse';
    candidate?: RuntimeCandidate;
  }

  interface StatusQuickPickItem extends vscode.QuickPickItem {
    action?: 'setup' | 'logs' | 'reinstall';
  }

  interface AttachQuickPickItem extends vscode.QuickPickItem {
    process: DjangoProcess;
    resolvedPid: number;
    endpoint?: TcpListeningEndpoint;
    groupedPids: number[];
  }

  interface AttachCandidate {
    process: DjangoProcess;
    resolvedPid: number;
    endpoint?: TcpListeningEndpoint;
    isWorker?: boolean;
  }

  function makeRuntimeCandidate(
    pythonPath: string,
    sourceKind: RuntimeCandidate['sourceKind'],
    sourceLabel: string,
    displayLabel: string,
    displayDescription: string,
    displayDetail: string,
    process?: DjangoProcess,
  ): RuntimeCandidate {
    return {
      pythonPath,
      resolvedPythonPath: pythonPath,
      sourceKind,
      sourceLabel,
      displayLabel,
      displayDescription,
      displayDetail,
      sortOrder: 0,
      isRecommended: true,
      process,
    };
  }

  async function ensureDebugpy(pythonPath?: string): Promise<DebugpyProvisioningInfo> {
    const info = await debugpyManager.ensureInstalled(pythonPath);
    injector.setBundledDebugpyPath(info.path);
    return info;
  }

  async function browseForPythonCandidate(): Promise<RuntimeCandidate | undefined> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      title: 'Select Python Interpreter',
      openLabel: 'Select Python',
    });
    if (!uris || uris.length === 0) {
      return undefined;
    }

    const pythonPath = uris[0].fsPath;
    log(`User browsed python: ${pythonPath}`);
    return makeRuntimeCandidate(
      pythonPath,
      'browse',
      'Browsed interpreter',
      `$(file-directory) ${path.basename(pythonPath)}`,
      'Manually selected interpreter',
      pythonPath,
    );
  }

  async function selectSetupRuntime(
    presetCandidate?: RuntimeCandidate,
  ): Promise<{ candidate: RuntimeCandidate; preflight: Awaited<ReturnType<typeof inspectRuntimePreflight>> } | undefined> {
    let candidate = presetCandidate;

    if (!candidate) {
      const savedProfile = await getSetupProfile(context);
      const items: RuntimeQuickPickItem[] = [];

      if (savedProfile) {
        items.push({
          label: buildSavedProfileCandidate(savedProfile).displayLabel,
          description: buildSavedProfileCandidate(savedProfile).displayDescription,
          detail: buildSavedProfileCandidate(savedProfile).displayDetail,
          candidate: buildSavedProfileCandidate(savedProfile),
        });
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      }

      const discovered = await discoverRuntimeCandidates(processFinder, injector);
      for (const discoveredCandidate of discovered) {
        items.push({
          label: discoveredCandidate.displayLabel,
          description: discoveredCandidate.displayDescription,
          detail: discoveredCandidate.displayDetail,
          candidate: discoveredCandidate,
        });
      }

      if (items.length > 0) {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      }
      items.push({
        label: '$(file-directory) Browse...',
        description: 'Manually select a Python executable',
        action: 'browse',
        alwaysShow: true,
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select the Python runtime that will run Django or Celery',
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (!selected) {
        return undefined;
      }

      if (selected.action === 'browse') {
        candidate = await browseForPythonCandidate();
      } else {
        candidate = selected.candidate;
      }
    }

    if (!candidate) {
      return undefined;
    }

    const preflight = await inspectRuntimePreflight(
      candidate.pythonPath,
      vscode.workspace.workspaceFolders,
      injector,
      debugpyManager,
    );
    log(`[Setup] Preflight for ${candidate.pythonPath}\n${formatPreflightForConfirmation(preflight)}`);

    if (preflight.errors.length > 0) {
      const choice = await vscode.window.showErrorMessage(
        `Setup blocked for ${candidate.pythonPath}: ${preflight.errors[0]}`,
        'Show Logs',
      );
      if (choice === 'Show Logs') {
        getLogger().show();
      }
      return undefined;
    }

    if (preflight.warnings.length > 0) {
      const choice = await vscode.window.showWarningMessage(
        `Setup warning for ${candidate.pythonPath}: ${preflight.warnings[0]}`,
        { modal: true },
        'Continue',
        'Show Logs',
      );
      if (choice === 'Show Logs') {
        getLogger().show();
        return undefined;
      }
      if (choice !== 'Continue') {
        return undefined;
      }
    }

    return { candidate, preflight };
  }

  async function installSetupForRuntime(
    reason: string,
    presetCandidate?: RuntimeCandidate,
  ): Promise<SetupProfile | undefined> {
    const selection = await selectSetupRuntime(presetCandidate);
    if (!selection) {
      return undefined;
    }

    let debugpyInfo: DebugpyProvisioningInfo | undefined;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Preparing Django Process Debugger runtime...',
        },
        async (progress) => {
          progress.report({ message: 'Preparing debugger backends...' });
          debugpyInfo = await ensureDebugpy(selection.preflight.resolvedPythonPath);
          progress.report({ message: `Installing bootstrap into ${selection.preflight.sitePackages}...` });
          await injector.installBootstrap(selection.preflight.sitePackages);
        },
      );

      if (!debugpyInfo) {
        throw new Error('Bundled debugpy was not prepared.');
      }

      const profile = createSetupProfile(selection.candidate, selection.preflight, debugpyInfo, reason);
      await saveSetupProfile(context, profile);
      return profile;
    } catch (err) {
      logError('[Setup] Failed', err);
      const msg = err instanceof Error ? err.message : String(err);
      const choice = await vscode.window.showErrorMessage(`Setup failed: ${msg}`, 'Show Logs');
      if (choice === 'Show Logs') {
        getLogger().show();
      }
      return undefined;
    }
  }

  async function showSetupStatus(): Promise<void> {
    const engine = getConfiguredDebugEngine();
    const profile = await getSetupProfile(context);
    const debugpyInfo = await debugpyManager.getProvisioningInfo();
    const bootstrapInstalled = profile
      ? await isProfileStillInstalled(profile, injector)
      : false;

    const items: StatusQuickPickItem[] = [];
    items.push({
      label: engine === 'experimental'
        ? '$(beaker) Experimental Native Tracer'
        : '$(debug-alt) debugpy',
      description: engine === 'experimental' ? 'Experimental opt-in' : 'Stable default',
      detail: engine === 'experimental'
        ? 'Limited feature set. Restart an already-activated target before switching engines.'
        : 'Full-featured stable backend.',
    });

    if (profile) {
      items.push({
        label: '$(checklist) Configured Runtime',
        description: profile.pythonPath,
        detail: `${profile.sourceLabel} • Python ${profile.pythonVersion} • setup ${profile.lastSetupAt}`,
      });
      items.push({
        label: bootstrapInstalled ? '$(check) Bootstrap Installed' : '$(warning) Bootstrap Missing',
        description: profile.sitePackages,
        detail: `Bootstrap version ${profile.bootstrapVersion}`,
      });
    } else {
      items.push({
        label: '$(circle-slash) No Runtime Configured',
        description: 'Run setup to install the bootstrap into a Python runtime',
      });
    }

    items.push({
      label: '$(debug-alt) Bundled debugpy',
      description: `${debugpyInfo.source}${debugpyInfo.version ? ` ${debugpyInfo.version}` : ''}`,
      detail: engine === 'experimental'
        ? `Stable fallback • ${debugpyInfo.path}`
        : debugpyInfo.path,
    });

    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: 'Run Setup', action: 'setup' });
    items.push({ label: 'Reinstall Bundled debugpy', action: 'reinstall' });
    items.push({ label: 'Open Logs', action: 'logs' });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Django Process Debugger setup status',
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (!selected?.action) {
      return;
    }

    if (selected.action === 'setup') {
      await vscode.commands.executeCommand(SETUP_COMMAND_ID);
    } else if (selected.action === 'reinstall') {
      await vscode.commands.executeCommand('djangoProcessDebugger.reinstallDebugpy');
    } else if (selected.action === 'logs') {
      getLogger().show();
    }
  }

  // Command: Setup
  const setupCmd = vscode.commands.registerCommand(
    SETUP_COMMAND_ID,
    async () => {
      log('Command: setup');
      const profile = await installSetupForRuntime('manual-setup');
      if (!profile) {
        return;
      }

      vscode.window.showInformationMessage(
        `Debug bootstrap installed into ${profile.pythonPath}. Restart your Django/Celery process, then use "Attach to Django Process".`
      );
    }
  );

  // Command: Show setup status
  const statusCmd = vscode.commands.registerCommand(
    STATUS_COMMAND_ID,
    async () => {
      log('Command: showSetupStatus');
      await showSetupStatus();
    }
  );


  // Command: Attach to process
  const attachCmd = vscode.commands.registerCommand(
    'djangoProcessDebugger.attachToProcess',
    async () => {
      const engine = getConfiguredDebugEngine();
      const engineName = debugEngineDisplayName(engine);
      log(`Command: attachToProcess (engine=${engine})`);

      const processes = await processFinder.findDjangoProcesses();
      log(`Found ${processes.length} Django process(es)`);
      if (processes.length === 0) {
        vscode.window.showWarningMessage(
          'No running Django processes found. Start a Django server first.'
        );
        return;
      }

      const endpointsForProcess = (processInfo: DjangoProcess): TcpListeningEndpoint[] => {
        if (processInfo.endpoints?.length) {
          return processInfo.endpoints;
        }
        return processInfo.host && processInfo.port
          ? [{ host: processInfo.host, port: processInfo.port }]
          : [];
      };

      const attachCandidateGroups: Array<{
        process: DjangoProcess;
        resolvedPid: number;
        endpoints: TcpListeningEndpoint[];
        isWorker?: boolean;
      }> = (await Promise.all(processes.map(async (processInfo) => {
        try {
          const resolved = await processFinder.resolveDebuggablePid(processInfo.pid);
          const resolvedProcess = processes.find((p) => p.pid === resolved.pid);
          const endpoints = endpointsForProcess(resolvedProcess ?? processInfo);
          const fallbackEndpoints = endpointsForProcess(processInfo);
          const workerPids = (processInfo.workerPids ?? []).filter((pid) => pid !== resolved.pid);
          const targetPids = workerPids.length > 0
            ? [...new Set(workerPids)]
            : [resolved.pid];
          return targetPids.map((targetPid) => ({
            process: processInfo,
            resolvedPid: targetPid,
            endpoints: endpoints.length > 0 ? endpoints : fallbackEndpoints,
            isWorker: targetPid !== resolved.pid,
          }));
        } catch (err) {
          logError(`[Attach] Failed to resolve debuggable PID for ${processInfo.pid}`, err);
          const fallbackPids = processInfo.workerPids?.length
            ? [...new Set(processInfo.workerPids)]
            : [processInfo.pid];
          return fallbackPids.map((fallbackPid) => ({
            process: processInfo,
            resolvedPid: fallbackPid,
            endpoints: endpointsForProcess(processInfo),
            isWorker: fallbackPid !== processInfo.pid,
          }));
        }
      }))).flat();
      const attachCandidates: AttachCandidate[] = attachCandidateGroups.flatMap((candidate): AttachCandidate[] =>
        candidate.endpoints.length > 0
          ? candidate.endpoints.map((endpoint) => ({ ...candidate, endpoint }))
          : [{ ...candidate, endpoint: undefined }],
      );

      const attachGroups = new Map<string, AttachCandidate[]>();
      for (const candidate of attachCandidates) {
        if (candidate.process.type === 'django' && !candidate.endpoint) {
          log(`[Attach] Skipping PID=${candidate.process.pid}: no Django host:port endpoint detected`);
          continue;
        }
        const key = candidate.process.type === 'django'
          ? `django-${candidate.endpoint!.port}-${candidate.endpoint!.host}${candidate.isWorker ? `-worker-${candidate.resolvedPid}` : ''}`
          : `celery-${candidate.resolvedPid}`;
        const group = attachGroups.get(key) ?? [];
        group.push(candidate);
        attachGroups.set(key, group);
      }

      const items: AttachQuickPickItem[] = await Promise.all([...attachGroups.values()].map(async (group) => {
        const representative = group.find((candidate) => candidate.process.pid === candidate.resolvedPid) ?? group[0];
        const displayCwd = selectGroupedDisplayCwd(
          representative.resolvedPid,
          representative.process.cwd,
          group.map((candidate) => ({
            resolvedPid: candidate.resolvedPid,
            cwd: candidate.process.cwd,
          })),
        );
        const displayProcess = displayCwd
          ? { ...representative.process, cwd: displayCwd }
          : representative.process;
        const isWorkerGroup = group.some((candidate) => candidate.isWorker);
        const icon = representative.process.type === 'celery' || isWorkerGroup ? '$(server-process)' : '$(globe)';
        const typeLabel = representative.process.type === 'celery'
          ? isWorkerGroup ? 'Celery Child' : 'Celery Worker'
          : isWorkerGroup
            ? 'Django Worker'
            : 'Django Server';
        const groupedPids = [...new Set(group.flatMap((candidate) => [
          candidate.process.pid,
          candidate.resolvedPid,
        ]))].sort((a, b) => a - b);
        const workerPids = representative.process.workerPids ?? [];
        const activeCheckPids = isWorkerGroup
          ? [representative.resolvedPid]
          : [...new Set([representative.resolvedPid, ...groupedPids])];
        let activeEndpoint: TcpListeningEndpoint | null = null;
        for (const activeCheckPid of activeCheckPids) {
          activeEndpoint = await injector.getActiveEndpoint(activeCheckPid, engine);
          if (activeEndpoint) { break; }
        }
        const portStatus = activeEndpoint
          ? `$(debug-alt) ${engineName} active on ${formatEndpoint(activeEndpoint)}`
          : `$(circle-slash) ${engineName} not attached`;
        const endpointLabel = representative.endpoint
          ? `Port: ${representative.endpoint.port} | Host: ${representative.endpoint.host}`
          : `PID: ${representative.resolvedPid}`;
        const pidLabel = isWorkerGroup
          ? `Worker PID: ${representative.resolvedPid} | Owner PID: ${representative.process.pid}`
          : groupedPids.length > 1
          ? `PIDs: ${groupedPids.join(', ')}`
          : `PID: ${groupedPids[0]}`;
        const detail = processQuickPickDetail(displayCwd, [
          `Python: ${representative.process.pythonPath}`,
          portStatus,
          representative.process.processGroupId ? `PGID: ${representative.process.processGroupId}` : undefined,
          workerPids.length > 0 ? `Workers: ${workerPids.join(', ')}` : undefined,
        ]);

        return {
          label: `${icon} [${typeLabel}] ${endpointLabel}`,
          description: processQuickPickDescription(displayCwd, pidLabel),
          detail,
          process: displayProcess,
          resolvedPid: representative.resolvedPid,
          endpoint: representative.endpoint,
          groupedPids,
        };
      }));

      if (items.length === 0) {
        vscode.window.showWarningMessage(
          'No attachable Django processes found with a host:port listener.'
        );
        return;
      }

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Select a Django process to attach ${engineName}`,
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (!selected) {
        log('User cancelled process selection');
        return;
      }

      const pid = selected.resolvedPid;
      const resolvedPythonPath = await injector.resolvePythonForPid(pid);
      const targetProcess: DjangoProcess = {
        ...selected.process,
        pid,
        pythonPath: resolvedPythonPath,
        host: selected.endpoint?.host ?? selected.process.host,
        port: selected.endpoint?.port ?? selected.process.port,
      };
      const targetRuntime = makeRuntimeCandidate(
        resolvedPythonPath,
        'running-process',
        `Attach target runtime (PID ${pid})`,
        `$(play) ${path.basename(resolvedPythonPath)}`,
        `Attach target runtime (PID ${pid})`,
        `${resolvedPythonPath}\n${selected.process.command}`,
        targetProcess,
      );
      const port = await findFreePort();
      log(`Selected PID=${selected.process.pid} → attach target PID=${pid} (${resolvedPythonPath}, engine=${engine})`);

      // Keep a single debug session per target PID, regardless of engine or window.
      const existingLock = readLockForPid(pid);
      if (existingLock) {
        const lockValid = await isPidLockLive(existingLock);

        if (lockValid) {
          const lockedEngine = normalizeDebugEngine(existingLock.engine);
          log(
            `Active ${lockedEngine} debug session detected from workspace ` +
            `"${existingLock.workspaceName}" (PID ${existingLock.pid})`
          );
          vscode.window.showErrorMessage(
            `Cannot attach: a debug session is already active in workspace "${existingLock.workspaceName}" ` +
            `(PID ${existingLock.pid}, engine ${lockedEngine}, ` +
            `${existingLock.host ? `${existingLock.host}:` : 'port '}${existingLock.port}). ` +
            `Stop the existing session first.`
          );
          return;
        } else {
          log(`Found stale lock file for PID=${pid}, removing atomically`);
          await removeStalePidLock(pid);
        }
      }

      try {
        const sitePackages = await injector.resolveSitePackages(resolvedPythonPath);
        const bootstrapInstalled = await injector.isBootstrapInstalled(sitePackages);
        if (!bootstrapInstalled) {
          const choice = await vscode.window.showWarningMessage(
            `This runtime is not set up yet: ${resolvedPythonPath}`,
            'Install for Next Restart',
            'Show Status',
            'Cancel',
          );
          if (choice === 'Install for Next Restart') {
            const profile = await installSetupForRuntime('attach-self-heal', targetRuntime);
            if (profile) {
              vscode.window.showInformationMessage(
                `Bootstrap installed into ${profile.pythonPath}. Restart the target process, then attach again.`
              );
            }
          } else if (choice === 'Show Status') {
            await showSetupStatus();
          }
          return;
        }

        // Auto-update bootstrap if version is outdated
        const bootstrapUpToDate = await injector.isBootstrapUpToDate(sitePackages);
        if (!bootstrapUpToDate) {
          log(`[Attach] Bootstrap outdated in ${sitePackages}, auto-updating...`);
          try {
            await ensureDebugpy(resolvedPythonPath);
            await injector.installBootstrap(sitePackages);
            log(`[Attach] Bootstrap auto-updated. Note: takes effect on next Django restart.`);
            vscode.window.showInformationMessage(
              `Debugger bootstrap updated to v${BOOTSTRAP_VERSION}. Restart the Django server to load the new engine support.`
            );
          } catch (updateErr) {
            logError('[Attach] Bootstrap auto-update failed', updateErr);
          }
        }
      } catch (err) {
        logError(`[Attach] Failed to inspect runtime ${resolvedPythonPath}`, err);
      }

      if (engine === 'debugpy') {
        try {
          await ensureDebugpy(resolvedPythonPath);
        } catch (err) {
          logError('Failed to prepare bundled debugpy', err);
          const choice = await vscode.window.showErrorMessage(
            'Failed to prepare bundled debugpy.',
            'Run Setup',
            'Show Status',
            'Show Logs',
          );
          if (choice === 'Run Setup') {
            await vscode.commands.executeCommand(SETUP_COMMAND_ID);
          } else if (choice === 'Show Status') {
            await showSetupStatus();
          } else if (choice === 'Show Logs') {
            getLogger().show();
          }
          return;
        }
      }

      let debugEndpoint: DebugpyEndpoint;
      try {
        debugEndpoint = await injector.activateEndpoint(pid, port, engine);
        if (debugEndpoint.port !== port) {
          log(`${engineName} was already active on ${formatEndpoint(debugEndpoint)}, reusing`);
        }
        log(`${engineName} activated for PID=${pid} on ${formatEndpoint(debugEndpoint)}`);
      } catch (err) {
        logError(`Attach failed for PID=${pid}`, err);

        if (err instanceof BootstrapNotInstalledError) {
          const choice = await vscode.window.showErrorMessage(
            `Debug bootstrap is not installed in the target runtime: ${resolvedPythonPath}`,
            'Install for Next Restart',
            'Show Status',
            'Show Logs',
          );
          if (choice === 'Install for Next Restart') {
            const profile = await installSetupForRuntime('attach-missing-bootstrap', targetRuntime);
            if (profile) {
              vscode.window.showInformationMessage(
                `Bootstrap installed into ${profile.pythonPath}. Restart the target process, then attach again.`
              );
            }
          } else if (choice === 'Show Status') {
            await showSetupStatus();
          } else if (choice === 'Show Logs') {
            getLogger().show();
          }
        } else if (err instanceof BootstrapNotLoadedError) {
          const choice = await vscode.window.showErrorMessage(
            `Bootstrap is installed in ${resolvedPythonPath}, but PID ${pid} started before it was loaded. Restart the target process and try again.`,
            'Show Status',
            'Show Logs',
          );
          if (choice === 'Show Status') {
            await showSetupStatus();
          } else if (choice === 'Show Logs') {
            getLogger().show();
          }
        } else if (err instanceof BootstrapRuntimeVersionError) {
          const choice = await vscode.window.showErrorMessage(
            err.message,
            'Show Status',
            'Show Logs',
          );
          if (choice === 'Show Status') {
            await showSetupStatus();
          } else if (choice === 'Show Logs') {
            getLogger().show();
          }
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          const choice = await vscode.window.showErrorMessage(
            `Debugger attach failed: ${msg}`,
            'Show Status',
            'Show Logs',
          );
          if (choice === 'Show Status') {
            await showSetupStatus();
          } else if (choice === 'Show Logs') {
            getLogger().show();
          }
        }
        return;
      }

      log(`Starting debug session for PID=${pid}`);

      // Use our own debug type — connects directly to the selected engine's DAP server.
      const justMyCode = vscode.workspace.getConfiguration('djangoProcessDebugger').get<boolean>('justMyCode', true);
      const processType = selected.process.type;
      const sessionLabel = processType === 'celery' ? 'Celery Worker' : 'Django';
      const redirectOutput = vscode.workspace.getConfiguration('djangoProcessDebugger').get<boolean>('redirectOutput', true);
      const ownerToken = `attach:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const debugConfig: vscode.DebugConfiguration = {
        type: 'django-process',
        request: 'attach',
        name: `${sessionLabel} (PID: ${pid})`,
        pid,
        engine,
        host: debugEndpoint.host,
        port: debugEndpoint.port,
        justMyCode,
        redirectOutput,
      };
      debugConfig[DEBUG_SESSION_LOCK_TOKEN_KEY] = ownerToken;
      if (engine === 'experimental') {
        if (!isValidExperimentalAuthToken(debugEndpoint.authToken)) {
          vscode.window.showErrorMessage(
            'Experimental tracer did not publish a valid DAP authentication credential. ' +
            'Restart the target process after updating the bootstrap.'
          );
          return;
        }
        debugConfig[DEBUG_SESSION_AUTH_TOKEN_KEY] = debugEndpoint.authToken;
      }

      log(
        `Debug config: type=django-process request=attach pid=${pid} engine=${engine} ` +
        `endpoint=${formatEndpoint(debugEndpoint)} justMyCode=${justMyCode} redirectOutput=${redirectOutput}`
      );

      // Claim atomically immediately before starting: activation/setup can take
      // long enough for a direct launch.json session to reserve this PID.
      const provisionalReservation = await reservePidLock({
        pid,
        engine,
        ownerToken,
        ownerExtensionPid: process.pid,
        phase: 'pending',
        host: debugEndpoint.host,
        port: debugEndpoint.port,
        workspaceId: getWorkspaceId(),
        workspaceName: getWorkspaceName(),
        timestamp: new Date().toISOString(),
      });
      if (!provisionalReservation.acquired) {
        const lockedEngine = normalizeDebugEngine(provisionalReservation.conflict?.engine);
        vscode.window.showErrorMessage(
          `Cannot attach: PID ${pid} was claimed by another ${lockedEngine} debug session while preparing the target. ` +
          `Stop that session first.`
        );
        return;
      }

      const started = await vscode.debug.startDebugging(undefined, debugConfig);
      log(`Debug session started: ${started}`);

      if (started) {
        vscode.window.showInformationMessage(
          `$(debug-alt) ${sessionLabel} (PID: ${pid}) attached with ${engineName} on ${formatEndpoint(debugEndpoint)}`
        );
      } else {
        await removePidLockIf(pid, (failedLock) => failedLock.ownerToken === ownerToken);
        vscode.window.showErrorMessage(
          'Failed to start debug session. Check logs for details.',
          'Show Logs',
        ).then((c) => { if (c === 'Show Logs') { getLogger().show(); } });
      }
    }
  );

  // Command: Kill Django/Celery process
  const killCmd = vscode.commands.registerCommand(
    'djangoProcessDebugger.killProcess',
    async () => {
      log('Command: killProcess');

      const processes = await processFinder.findDjangoProcesses();
      if (processes.length === 0) {
        vscode.window.showWarningMessage('No running Django/Celery processes found.');
        return;
      }

      const items = processes.map((p) => {
        const icon = p.type === 'celery' ? '$(server-process)' : '$(globe)';
        const typeLabel = p.type === 'celery' ? 'Celery Worker' : 'Django Server';
        const portLabel = p.port ? ` | Port: ${p.port}` : '';
        const workerLabel = p.workerPids?.length ? `Workers: ${p.workerPids.join(', ')}` : undefined;
        return {
          label: `${icon} [${typeLabel}] PID: ${p.pid}${portLabel}`,
          description: processQuickPickDescription(p.cwd, p.command),
          detail: processQuickPickDetail(p.cwd, [
            `Python: ${p.pythonPath}`,
            workerLabel,
          ]),
          process: p,
        };
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a process to kill',
        canPickMany: true,
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (!selected || selected.length === 0) {
        log('User cancelled process kill');
        return;
      }

      for (const item of selected) {
        const pid = item.process.pid;
        try {
          process.kill(pid, 'SIGTERM');
          log(`Sent SIGTERM to PID=${pid}`);
        } catch (err) {
          logError(`Failed to kill PID=${pid}`, err);
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Failed to kill PID ${pid}: ${msg}`);
        }
      }

      const pids = selected.map((s) => s.process.pid).join(', ');
      vscode.window.showInformationMessage(`Sent SIGTERM to PID: ${pids}`);
    }
  );

  // Command: Reinstall debugpy
  const reinstallCmd = vscode.commands.registerCommand(
    'djangoProcessDebugger.reinstallDebugpy',
    async () => {
      log('Command: reinstallDebugpy');

      try {
        let debugpyInfo: DebugpyProvisioningInfo | undefined;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Reinstalling debugpy...' },
          async () => {
            try {
              debugpyInfo = await debugpyManager.reinstall();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (!msg.includes('No vendored debugpy bundle found')) {
                throw err;
              }

              const selected = await selectSetupRuntime();
              if (!selected) {
                return;
              }
              debugpyInfo = await debugpyManager.reinstall(selected.preflight.resolvedPythonPath);
            }

            if (!debugpyInfo) {
              return;
            }
            injector.setBundledDebugpyPath(debugpyInfo.path);
          },
        );
        if (!debugpyInfo) {
          return;
        }
        vscode.window.showInformationMessage(
          `Bundled debugpy reinstalled from ${debugpyInfo.source}${debugpyInfo.version ? ` ${debugpyInfo.version}` : ''}.`
        );
      } catch (err) {
        logError('[Reinstall] Failed', err);
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Reinstall failed: ${msg}`, 'Show Logs').then((c) => {
          if (c === 'Show Logs') { getLogger().show(); }
        });
      }
    }
  );

  // Command: scoped cleanup for this workspace's saved runtime
  const cleanLsCmd = vscode.commands.registerCommand(
    'djangoProcessDebugger.cleanPythonLanguageServer',
    async () => {
      log('Command: cleanThisWorkspace');
      const activeSessions = hotReloadLeaseManager.getState().sessions;
      const liveClaims = [...claimedSessionsByPid.keys()].filter(isTargetProcessAlive);
      if (activeSessions.length > 0 || liveClaims.length > 0) {
        await vscode.window.showWarningMessage(
          'Stop this workspace\'s Django Process Debugger sessions before cleaning its runtime.',
          { modal: true },
        );
        return;
      }

      const profile = await getSetupProfile(context);
      const staleOwnedPids = [...claimedSessionsByPid.keys()]
        .filter((pid) => !isTargetProcessAlive(pid));
      const scope: CleanAllScope = {
        runtimes: profile
          ? [{ sitePackages: profile.sitePackages, label: profile.pythonPath }]
          : [],
        targetPids: staleOwnedPids,
      };
      const preflight = await preflightCleanAll(scope);
      if (!preflight.safe) {
        log(`[Clean] Safety preflight blocked cleanup: ${preflight.summary}`);
        for (const issue of preflight.issues) {
          log(`[Clean] ${issue.code}: ${issue.target} — ${issue.message}`);
        }
        const choice = await vscode.window.showErrorMessage(
          `Workspace cleanup was blocked by ${preflight.counts.issues} safety check(s).`,
          'Show Logs',
        );
        if (choice === 'Show Logs') { getLogger().show(); }
        return;
      }

      const detail = [
        profile
          ? `Managed runtime: ${profile.pythonPath}\nsite-packages: ${profile.sitePackages}`
          : 'No saved runtime profile is present.',
        staleOwnedPids.length > 0
          ? `Stale artifacts owned by this window: PID ${staleOwnedPids.join(', ')}`
          : 'No stale PID artifacts owned by this window were found.',
        preflight.summary,
        '',
        'No Python process will be stopped. Other runtimes, language-server caches, '
          + 'Python signatures, and shared debugpy storage will not be touched.',
      ].join('\n');
      const confirmed = await vscode.window.showWarningMessage(
        'Clean Django Process Debugger support for this workspace?',
        { modal: true, detail },
        'Clean This Workspace',
      );
      if (confirmed !== 'Clean This Workspace') {
        return;
      }

      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Cleaning this workspace\'s Django debugger support...',
        },
        async () => runCleanAll(scope),
      );
      log(`[Clean] ${result.summary}`);
      for (const item of result.items) {
        if (item.status === 'removed') {
          log(`[Clean] Removed ${item.category}: ${item.path}`);
        } else if (item.status === 'failed') {
          log(`[Clean] Failed ${item.category}: ${item.path} — ${item.error ?? 'unknown error'}`);
        }
      }

      if (!result.ok) {
        const choice = await vscode.window.showErrorMessage(
          `Workspace cleanup was incomplete: ${result.summary}`,
          'Show Logs',
        );
        if (choice === 'Show Logs') { getLogger().show(); }
        return;
      }

      await clearSetupProfile(context);
      for (const pid of staleOwnedPids) {
        claimedSessionsByPid.delete(pid);
      }
      const choice = await vscode.window.showInformationMessage(
        `Workspace debugger support cleaned (${result.counts.removed} managed item(s)). `
          + 'No Python process was stopped. Restart a running Django/Celery process to unload '
          + 'a bootstrap that was already imported.',
        'Show Logs',
      );
      if (choice === 'Show Logs') { getLogger().show(); }
    }
  );

  const mcpBridgeModulePath = context.asAbsolutePath(path.join('out', 'mcp', 'stdioBridge.js'));

  async function selectMcpWorkspaceFolder(
    placeHolder: string,
  ): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file');
    if (folders.length === 0) {
      void vscode.window.showErrorMessage(
        'Open a local workspace folder before using the Django debugger MCP commands.'
      );
      return undefined;
    }
    if (folders.length === 1) {
      return folders[0];
    }
    const selected = await vscode.window.showQuickPick(
      folders.map((folder) => ({
        label: folder.name,
        description: folder.uri.fsPath,
        folder,
      })),
      { placeHolder, matchOnDescription: true },
    );
    return selected?.folder;
  }

  function requireTrustedMcpWorkspace(): boolean {
    if (vscode.workspace.isTrusted) {
      return true;
    }
    void vscode.window.showErrorMessage(
      'Trust this workspace before executing or repairing Django debugger MCP project files.'
    );
    return false;
  }

  async function diagnoseMcpFolder(
    folder: vscode.WorkspaceFolder,
  ): Promise<McpWorkspaceDiagnostics> {
    const result = await diagnoseMcpWorkspace({
      workspaceRoot: folder.uri.fsPath,
      bridgeModulePath: mcpBridgeModulePath,
      windowId: mcpWindowId,
      registryDir: defaultMcpRegistryDir(),
    });
    log(`[MCP Status] ${folder.name}\n${JSON.stringify(result, null, 2)}`);
    return result;
  }

  async function installOrRepairMcpFolder(
    folder: vscode.WorkspaceFolder,
    operation: 'installed' | 'repaired',
  ): Promise<boolean> {
    if (!requireTrustedMcpWorkspace()) {
      return false;
    }
    try {
      const result = await setupMcpWorkspace({
        workspaceRoot: folder.uri.fsPath,
        bridgeModulePath: mcpBridgeModulePath,
      });
      log(`[MCP] ${operation} workspace bridge at ${result.launcherPath}`);
      void vscode.window.showInformationMessage(
        `Django debugger MCP ${operation} for ${folder.name}. Restart or reconnect Claude/Codex after configuration changes.`
      );
      return true;
    } catch (error) {
      logError(`[MCP] Workspace ${operation} failed`, error);
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Could not ${operation === 'installed' ? 'install' : 'repair'} Django debugger MCP: ${message}`);
      return false;
    }
  }

  async function verifyMcpFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    if (!requireTrustedMcpWorkspace()) {
      return;
    }
    let diagnostics: McpWorkspaceDiagnostics | undefined;
    try {
      diagnostics = await diagnoseMcpFolder(folder);
      if (!diagnostics.installed || diagnostics.repairNeeded) {
        const choice = await vscode.window.showWarningMessage(
          diagnostics.installed
            ? `Django debugger MCP project files are stale or modified for ${folder.name}. Repair them before verification.`
            : `Django debugger MCP is not fully installed for ${folder.name}.`,
          'Repair MCP',
          'Show Logs',
        );
        if (choice === 'Repair MCP') {
          if (!await installOrRepairMcpFolder(folder, 'repaired')) {
            return;
          }
          diagnostics = await diagnoseMcpFolder(folder);
          if (!diagnostics.installed || diagnostics.repairNeeded) {
            throw new Error('MCP project files are still not current after repair.');
          }
        } else if (choice === 'Show Logs') {
          getLogger().show();
          return;
        } else {
          return;
        }
      }
      const verified = await verifyMcpWorkspace({
        workspaceRoot: folder.uri.fsPath,
        launcherPath: diagnostics.paths.launcher,
        windowId: mcpWindowId,
        registryDir: defaultMcpRegistryDir(),
      });
      log(`[MCP Verify] ${folder.name}\n${JSON.stringify(verified, null, 2)}`);
      const choice = await vscode.window.showInformationMessage(
        `Django debugger MCP verified for ${folder.name}: ${verified.toolNames.length} tools, protocol ${verified.protocolVersion}, ${verified.elapsedMs}ms.`,
        'Show Logs',
      );
      if (choice === 'Show Logs') {
        getLogger().show();
      }
    } catch (error) {
      logError('[MCP Verify] End-to-end verification failed', error);
      const message = error instanceof Error ? error.message : String(error);
      const repairable = diagnostics?.repairNeeded === true
        || (error instanceof McpVerificationError
          && (error.code === 'UNSAFE_LAUNCHER' || error.code === 'UNSAFE_RUNTIME'));
      const choice = await vscode.window.showErrorMessage(
        `Django debugger MCP verification failed: ${message}${repairable
          ? ''
          : ' Check that this trusted workspace is open and the MCP endpoint is enabled in its VS Code window.'}`,
        ...(repairable ? ['Repair MCP', 'Show Logs'] : ['Show Logs']),
      );
      if (choice === 'Repair MCP') {
        await installOrRepairMcpFolder(folder, 'repaired');
      } else if (choice === 'Show Logs') {
        getLogger().show();
      }
    }
  }

  const installMcpCmd = vscode.commands.registerCommand(
    'djangoProcessDebugger.installMcp',
    async () => {
      const folder = await selectMcpWorkspaceFolder(
        'Select the project root where Claude/Codex MCP configuration should be installed',
      );
      if (folder) {
        await installOrRepairMcpFolder(folder, 'installed');
      }
    },
  );
  const repairMcpCmd = vscode.commands.registerCommand(
    'djangoProcessDebugger.repairMcp',
    async () => {
      const folder = await selectMcpWorkspaceFolder('Select the MCP project to repair');
      if (folder) {
        await installOrRepairMcpFolder(folder, 'repaired');
      }
    },
  );
  const verifyMcpCmd = vscode.commands.registerCommand(
    'djangoProcessDebugger.verifyMcp',
    async () => {
      const folder = await selectMcpWorkspaceFolder('Select the MCP project to verify');
      if (folder) {
        await verifyMcpFolder(folder);
      }
    },
  );
  const mcpStatusCmd = vscode.commands.registerCommand(
    'djangoProcessDebugger.showMcpStatus',
    async () => {
      const folder = await selectMcpWorkspaceFolder('Select the MCP project to inspect');
      if (!folder) {
        return;
      }
      try {
        const result = await diagnoseMcpFolder(folder);
        const issueCodes = result.issues.slice(0, 3).map((issue) => issue.code).join(', ');
        const summary = result.verified
          ? `Django debugger MCP is installed, current, and healthy for ${folder.name}.`
          : `Django debugger MCP needs attention for ${folder.name}${issueCodes ? `: ${issueCodes}` : '.'}`;
        const actions = result.repairNeeded
          ? ['Repair MCP', 'Verify Connection', 'Show Logs']
          : ['Verify Connection', 'Show Logs'];
        const choice = await vscode.window.showInformationMessage(summary, ...actions);
        if (choice === 'Repair MCP') {
          await installOrRepairMcpFolder(folder, 'repaired');
        } else if (choice === 'Verify Connection') {
          await verifyMcpFolder(folder);
        } else if (choice === 'Show Logs') {
          getLogger().show();
        }
      } catch (error) {
        logError('[MCP Status] Diagnostics failed', error);
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Could not inspect Django debugger MCP: ${message}`);
      }
    },
  );

  // ── Hot Reload: session/PID lease lifecycle and file coordination ──
  interface HotReloadPidBatch {
    pid: number;
    leaseId: string;
    generation: number;
    pendingFiles: Set<string>;
    inFlightFiles: Set<string>;
    abortController: AbortController;
    flushChain: Promise<void>;
  }

  let hotReloadWatcher: vscode.FileSystemWatcher | undefined;
  let hotReloadDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let hotReloadBatchGeneration = 0;
  let hotReloadLocallyDisposed = false;
  let hotReloadShutdownPromise: Promise<void> | undefined;
  const hotReloadBatches = new Map<number, HotReloadPidBatch>();
  const hotReloadBacklogs = new Map<number, Set<string>>();
  const effectiveSessionEngines = new Map<string, DebugEngine>();
  const hotReloadStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

  function activeLeaseForPid(pid: number, leaseId?: string) {
    return hotReloadLeaseManager.getActiveLeases().find((lease) =>
      lease.pid === pid && (leaseId === undefined || lease.leaseId === leaseId)
    );
  }

  function abortHotReloadBatch(batch: HotReloadPidBatch): void {
    const state = hotReloadLeaseManager.getState();
    const shouldPreserve = (
      !hotReloadLocallyDisposed
      && state.enabled
      && state.sessions.some((session) => session.pid === batch.pid)
    );
    if (shouldPreserve) {
      const backlog = hotReloadBacklogs.get(batch.pid) ?? new Set<string>();
      for (const filePath of batch.pendingFiles) {
        backlog.add(filePath);
      }
      for (const filePath of batch.inFlightFiles) {
        backlog.add(filePath);
      }
      hotReloadBacklogs.set(batch.pid, backlog);
    }
    batch.generation += 1;
    batch.abortController.abort();
    batch.pendingFiles.clear();
    batch.inFlightFiles.clear();
    if (hotReloadBatches.get(batch.pid) === batch) {
      hotReloadBatches.delete(batch.pid);
    }
  }

  function getOrCreateHotReloadBatch(
    pid: number,
    leaseId: string,
  ): HotReloadPidBatch {
    const existing = hotReloadBatches.get(pid);
    if (existing?.leaseId === leaseId && !existing.abortController.signal.aborted) {
      return existing;
    }
    if (existing) {
      abortHotReloadBatch(existing);
    }
    const batch: HotReloadPidBatch = {
      pid,
      leaseId,
      generation: ++hotReloadBatchGeneration,
      pendingFiles: new Set<string>(),
      inFlightFiles: new Set<string>(),
      abortController: new AbortController(),
      flushChain: Promise.resolve(),
    };
    hotReloadBatches.set(pid, batch);
    return batch;
  }

  function addHotReloadBacklog(pid: number, filePath: string): void {
    const backlog = hotReloadBacklogs.get(pid) ?? new Set<string>();
    backlog.add(filePath);
    hotReloadBacklogs.set(pid, backlog);
  }

  function flushAvailableHotReloadBacklogs(): void {
    for (const lease of hotReloadLeaseManager.getActiveLeases()) {
      const backlog = hotReloadBacklogs.get(lease.pid);
      if (!backlog || backlog.size === 0) {
        continue;
      }
      const batch = getOrCreateHotReloadBatch(lease.pid, lease.leaseId);
      for (const filePath of backlog) {
        batch.pendingFiles.add(filePath);
      }
      hotReloadBacklogs.delete(lease.pid);
      scheduleHotReloadFlush(batch);
    }
  }

  function updateHotReloadStatus(): void {
    if (hotReloadLocallyDisposed || !hotReloadWatcher) {
      hotReloadStatusItem.hide();
      return;
    }
    const state = hotReloadLeaseManager.getState();
    const desiredPids = [...new Set(state.sessions.map((session) => session.pid))].sort(
      (left, right) => left - right
    );
    const activePids = hotReloadLeaseManager.getActiveLeases().map((lease) => lease.pid);
    if (activePids.length === desiredPids.length && desiredPids.length > 0) {
      hotReloadStatusItem.text = desiredPids.length === 1
        ? '$(flame) Hot Reload'
        : '$(flame) Hot Reload (' + desiredPids.length + ' targets)';
      hotReloadStatusItem.tooltip = 'Hot reload active for PID'
        + (desiredPids.length === 1 ? ' ' : 's ')
        + desiredPids.join(', ')
        + '. Django autoreload is suppressed only while these session leases are live.';
    } else {
      hotReloadStatusItem.text = '$(clock) Hot Reload — connecting';
      hotReloadStatusItem.tooltip = 'Active leases: ' + activePids.length
        + '/' + desiredPids.length + '. Debugging remains available while hot reload reconnects.';
    }
    hotReloadStatusItem.show();
  }

  function disposeWorkspaceHotReloadWatcher(): void {
    if (hotReloadDebounceTimer) {
      clearTimeout(hotReloadDebounceTimer);
      hotReloadDebounceTimer = undefined;
    }
    for (const batch of [...hotReloadBatches.values()]) {
      abortHotReloadBatch(batch);
    }
    hotReloadBacklogs.clear();
    if (hotReloadWatcher) {
      hotReloadWatcher.dispose();
      hotReloadWatcher = undefined;
      log('[HotReload] Workspace watcher stopped');
    }
    hotReloadStatusItem.hide();
  }

  function reconcileHotReloadState(): void {
    if (hotReloadLocallyDisposed) {
      return;
    }
    const state = hotReloadLeaseManager.getState();
    const shouldWatch = state.enabled && state.sessions.length > 0;
    if (shouldWatch && !hotReloadWatcher) {
      hotReloadWatcher = vscode.workspace.createFileSystemWatcher('**/*.py');
      hotReloadWatcher.onDidChange(onPyFileChanged);
      hotReloadWatcher.onDidCreate(onPyFileChanged);
      log('[HotReload] Workspace watcher started');
    } else if (!shouldWatch) {
      disposeWorkspaceHotReloadWatcher();
      return;
    }

    const desiredPids = new Set(state.sessions.map((session) => session.pid));
    for (const pid of hotReloadBacklogs.keys()) {
      if (!desiredPids.has(pid)) {
        hotReloadBacklogs.delete(pid);
      }
    }
    const activeByPid = new Map(
      hotReloadLeaseManager.getActiveLeases().map((lease) => [lease.pid, lease.leaseId])
    );
    for (const batch of [...hotReloadBatches.values()]) {
      if (activeByPid.get(batch.pid) !== batch.leaseId) {
        abortHotReloadBatch(batch);
      }
    }
    if (!hotReloadDebounceTimer) {
      flushAvailableHotReloadBacklogs();
    }
    updateHotReloadStatus();
  }

  function onPyFileChanged(uri: vscode.Uri): void {
    reconcileHotReloadState();
    const filePath = uri.fsPath;
    if (shouldIgnoreForHotReload(filePath)) {
      return;
    }

    const state = hotReloadLeaseManager.getState();
    if (!state.enabled) {
      return;
    }
    const desiredPids = new Set(state.sessions.map((session) => session.pid));
    if (desiredPids.size === 0) {
      return;
    }
    for (const pid of desiredPids) {
      addHotReloadBacklog(pid, filePath);
    }

    const activeLeases = hotReloadLeaseManager.getActiveLeases();
    const desiredPidCount = desiredPids.size;
    if (activeLeases.length < desiredPidCount) {
      void hotReloadLeaseManager.reconcile().then(
        () => reconcileHotReloadState(),
        (error) => logError('[HotReload] Lease retry failed', error),
      );
    }
    if (hotReloadDebounceTimer) {
      clearTimeout(hotReloadDebounceTimer);
    }
    hotReloadDebounceTimer = setTimeout(() => {
      hotReloadDebounceTimer = undefined;
      flushAvailableHotReloadBacklogs();
    }, 500);
  }

  function scheduleHotReloadFlush(batch: HotReloadPidBatch): void {
    const generation = batch.generation;
    batch.flushChain = batch.flushChain
      .catch((error) => {
        logError('[HotReload] Previous reload batch failed for PID=' + batch.pid, error);
      })
      .then(() => drainHotReload(batch.pid, generation));
  }

  function isCurrentHotReloadBatch(
    batch: HotReloadPidBatch,
    generation: number,
  ): boolean {
    return (
      hotReloadBatches.get(batch.pid) === batch
      && batch.generation === generation
      && !batch.abortController.signal.aborted
      && activeLeaseForPid(batch.pid, batch.leaseId) !== undefined
    );
  }

  async function drainHotReload(pid: number, generation: number): Promise<void> {
    const batch = hotReloadBatches.get(pid);
    if (
      !batch
      || !isCurrentHotReloadBatch(batch, generation)
      || batch.pendingFiles.size === 0
    ) {
      return;
    }

    const files = [...batch.pendingFiles];
    batch.pendingFiles.clear();
    for (const filePath of files) {
      batch.inFlightFiles.add(filePath);
    }
    const signal = batch.abortController.signal;
    log('[HotReload] Requesting reload for PID=' + pid + ': ' + files.join(', '));
    hotReloadStatusItem.text = '$(sync~spin) Reloading PID ' + pid + '...';

    try {
      const requestId = await injector.requestHotReload(pid, files, batch.leaseId);
      if (requestId === null || !isCurrentHotReloadBatch(batch, generation)) {
        return;
      }

      let results = await injector.pollReloadResult(
        pid,
        3_000,
        20,
        requestId,
        signal,
        batch.leaseId,
      );

      let pending = false;
      if (results === null && isCurrentHotReloadBatch(batch, generation)) {
        pending = await injector.isReloadPending(pid, requestId, batch.leaseId);
        if (!pending) {
          results = await injector.readReloadResult(pid, requestId, batch.leaseId);
        }
      }
      if (
        results === null
        && pending
        && isCurrentHotReloadBatch(batch, generation)
      ) {
        const lease = activeLeaseForPid(pid, batch.leaseId);
        const atBreakpoint = lease?.ownerSessionIds.some((sessionId) =>
          pausedSessions.has(sessionId)
        ) ?? false;
        hotReloadStatusItem.text = atBreakpoint
          ? '$(clock) Reload queued — continue to apply'
          : '$(clock) Reload queued for PID ' + pid + '...';
        hotReloadStatusItem.tooltip = atBreakpoint
          ? 'Hot reload is waiting because the target is paused at a breakpoint.'
          : undefined;
        log('[HotReload] Extending pending request=' + requestId
          + ' for PID=' + pid + ', paused=' + atBreakpoint);
        results = await injector.pollReloadResult(
          pid,
          60_000,
          20,
          requestId,
          signal,
          batch.leaseId,
        );
      }

      if (!isCurrentHotReloadBatch(batch, generation)) {
        return;
      }
      if (results !== null) {
        const ok = results.filter((result) => result.startsWith('OK:'));
        const errors = results.filter((result) => result.startsWith('ERR:'));
        const skipped = results.filter((result) => result.startsWith('SKIP:'));
        if (ok.length > 0) {
          const modules = ok.map((result) => result.replace('OK:', ''));
          void vscode.window.showInformationMessage(
            '$(flame) Hot reloaded PID ' + pid + ': ' + modules.join(', ')
          );
        }
        if (errors.length > 0) {
          const details = errors.map((result) => result.replace('ERR:', ''));
          void vscode.window.showWarningMessage(
            '$(warning) Reload failed for PID ' + pid + ': ' + details.join('; ')
          );
        }
        if (skipped.length > 0 && ok.length === 0 && errors.length === 0) {
          log('[HotReload] All files skipped for PID=' + pid + ': ' + skipped.join(', '));
        }
        log('[HotReload] Results for ' + requestId + ': '
          + ok.length + ' OK, ' + errors.length + ' ERR, '
          + skipped.length + ' SKIP');
      } else {
        log('[HotReload] No result for ' + requestId + ' after extended wait');
      }
    } catch (error) {
      if (!signal.aborted) {
        logError('[HotReload] Failed to reload PID=' + pid, error);
      }
    } finally {
      batch.inFlightFiles.clear();
      if (isCurrentHotReloadBatch(batch, generation)) {
        updateHotReloadStatus();
      }
    }
  }

  async function registerHotReloadSession(
    sessionId: string,
    pid: number,
    lifecycleToken: symbol,
  ): Promise<void> {
    try {
      await hotReloadLeaseManager.registerSession(sessionId, pid);
      // A terminate/restart racing this await already invalidates ownership in
      // the manager. Never unregister by session ID here: a newer generation
      // may have claimed that ID while this acquire was completing.
      if (hotReloadLifecycleTokens.get(sessionId) !== lifecycleToken) { return; }
    } catch (error) {
      logError('[HotReload] Could not acquire lease for PID=' + pid, error);
      if (hotReloadLifecycleTokens.get(sessionId) === lifecycleToken) {
        void vscode.window.showWarningMessage(
          'Hot reload could not start for PID ' + pid
          + '. The debug session remains active; see logs for details.'
        );
      }
    } finally {
      reconcileHotReloadState();
    }
  }

  function revokeHotReloadSession(
    sessionId: string,
    expectedLifecycleToken?: symbol,
  ): Promise<void> {
    const currentToken = hotReloadLifecycleTokens.get(sessionId);
    const inFlight = hotReloadReleasesBySession.get(sessionId);
    if (
      expectedLifecycleToken !== undefined
      && currentToken !== expectedLifecycleToken
    ) {
      return inFlight?.lifecycleToken === expectedLifecycleToken
        ? inFlight.promise
        : Promise.resolve();
    }
    if (currentToken === undefined) {
      return inFlight?.promise ?? Promise.resolve();
    }

    hotReloadLifecycleTokens.delete(sessionId);
    const release = hotReloadLeaseManager.unregisterSession(sessionId);
    const record = {
      lifecycleToken: currentToken,
      promise: release,
    };
    hotReloadReleasesBySession.set(sessionId, record);
    reconcileHotReloadState();
    void release.then(
      () => reconcileHotReloadState(),
      (error) => logError('[HotReload] Session lease release failed', error),
    ).finally(() => {
      if (hotReloadReleasesBySession.get(sessionId) === record) {
        hotReloadReleasesBySession.delete(sessionId);
      }
    });
    return release;
  }

  function shutdownHotReloadLifecycle(): Promise<void> {
    hotReloadShutdownPromise ??= (async () => {
      hotReloadLocallyDisposed = true;
      hotReloadLifecycleTokens.clear();
      disposeWorkspaceHotReloadWatcher();
      const inFlightReleases = [...hotReloadReleasesBySession.values()]
        .map((record) => record.promise);
      await Promise.allSettled([
        hotReloadLeaseManager.dispose(),
        ...inFlightReleases,
      ]);
      hotReloadReleasesBySession.clear();
    })();
    return hotReloadShutdownPromise;
  }

  activeHotReloadShutdown = shutdownHotReloadLifecycle;
  context.subscriptions.push({
    dispose: () => { void shutdownHotReloadLifecycle(); },
  });

  // Debug session lifecycle logging
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(async (session) => {
      mcpController.handleSessionStarted(session);
      const engine = session.type === 'django-process' ? targetEngineFromSession(session) : undefined;
      const sessionPid = session.type === 'django-process' ? targetPidFromSession(session) : undefined;
      const hotReloadLifecycleToken = session.type === 'django-process'
        ? ensureHotReloadLifecycleToken(session)
        : undefined;
      if (engine) {
        effectiveSessionEngines.set(session.id, engine);
      }
      if (engine && sessionPid !== undefined) {
        const configuredHost = session.configuration.host;
        const configuredPort = session.configuration.port;
        const host = typeof configuredHost === 'string' && configuredHost.length > 0
          ? configuredHost
          : '127.0.0.1';
        const port = typeof configuredPort === 'number' && Number.isInteger(configuredPort) && configuredPort > 0
          ? configuredPort
          : 5678;
        const lockTarget: DebugSessionLockTarget = {
          pid: sessionPid,
          engine,
          host,
          port,
          ownerToken: ensureDebugSessionLockToken(session),
        };

        // The descriptor factory normally owns the lock before this event. Run
        // the same guard again as a lifecycle fallback so an alternate VS Code
        // startup path can never overwrite a live session's lock.
        const claim = await sessionLockGuard.claim(session, lockTarget);
        if (!claim.allowed) {
          void revokeHotReloadSession(session.id, hotReloadLifecycleToken);
          effectiveSessionEngines.delete(session.id);
          log(`[DebugSession] Stopping unclaimed session ${session.id}: ${claim.message}`);
          void vscode.window.showErrorMessage(claim.message);
          await vscode.debug.stopDebugging(session);
          return;
        }

        // The attach command reserves the lock before session startup. Refresh it
        // here as well because VS Code's Restart flow bypasses that command.
        const promoted = await updatePidLockIf(
          sessionPid,
          (current) => current.sessionId === session.id
            && current.ownerToken === lockTarget.ownerToken,
          lockInfoForTarget(session, lockTarget, 'active'),
        );
        if (!promoted) {
          void revokeHotReloadSession(session.id, hotReloadLifecycleToken);
          effectiveSessionEngines.delete(session.id);
          const currentClaim = claimedSessionsByPid.get(sessionPid);
          if (currentClaim?.sessionId === session.id
            && currentClaim.ownerToken === lockTarget.ownerToken) {
            claimedSessionsByPid.delete(sessionPid);
          }
          log(`[DebugSession] Stopping session ${session.id}: its PID lock changed before activation`);
          void vscode.window.showErrorMessage(
            `Cannot attach to PID ${sessionPid}: its debug-session lock changed during startup.`
          );
          await vscode.debug.stopDebugging(session);
          return;
        }
        log(`[DebugSession] Lock file active for PID=${sessionPid} (engine=${engine})`);

        if (
          supportsHotReload(engine)
          && hotReloadLifecycleToken
          && hotReloadLifecycleTokens.get(session.id) === hotReloadLifecycleToken
        ) {
          await registerHotReloadSession(
            session.id,
            sessionPid,
            hotReloadLifecycleToken,
          );
        } else {
          void revokeHotReloadSession(session.id, hotReloadLifecycleToken);
        }
      }
      log(
        `[DebugSession] Started: ${session.name} (type=${session.type}` +
        `${engine ? `, engine=${engine}` : ''}` +
        `${sessionPid !== undefined ? `, pid=${sessionPid}` : ''})`
      );
    }),
    vscode.debug.onDidTerminateDebugSession(async (session) => {
      mcpController.handleSessionTerminated(session);
      log(`[DebugSession] Terminated: ${session.name}`);
      if (session.type === 'django-process') {
        // Revoke the capability and abort local polls before waiting on lock I/O.
        const hotReloadRelease = revokeHotReloadSession(
          session.id,
          hotReloadTokenBySession.get(session),
        );
        const sessionPid = targetPidFromSession(session);
        const engine = effectiveSessionEngines.get(session.id) ?? targetEngineFromSession(session);
        effectiveSessionEngines.delete(session.id);
        const sessionOwnerToken = session.configuration[DEBUG_SESSION_LOCK_TOKEN_KEY];
        let lockRemoved = false;
        if (sessionPid !== undefined) {
          try {
            lockRemoved = await removePidLockIf(
              sessionPid,
              (activeLock) => activeLock.sessionId === session.id
                || (activeLock.sessionId === undefined
                  && typeof sessionOwnerToken === 'string'
                  && sessionOwnerToken.length > 0
                  && activeLock.ownerToken === sessionOwnerToken),
            );
          } catch (err) {
            logError(`[DebugSession] Failed to release PID=${sessionPid} lock`, err);
          }
        }
        if (sessionPid !== undefined) {
          const inMemoryClaim = claimedSessionsByPid.get(sessionPid);
          if (inMemoryClaim?.sessionId === session.id
            && typeof sessionOwnerToken === 'string'
            && inMemoryClaim.ownerToken === sessionOwnerToken) {
            claimedSessionsByPid.delete(sessionPid);
          }
        }
        await hotReloadRelease;
        log(
          `[DebugSession] ${lockRemoved ? `Lock file removed for PID=${sessionPid}` : 'No PID lock to remove'} ` +
          '(engine=' + engine + '), hot reload lease released'
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('djangoProcessDebugger.hotReload')) {
        return;
      }
      const enabled = vscode.workspace
        .getConfiguration('djangoProcessDebugger')
        .get<boolean>('hotReload', true);
      const update = hotReloadLeaseManager.setEnabled(enabled);
      reconcileHotReloadState();
      void update.then(
        () => reconcileHotReloadState(),
        (error) => logError('[HotReload] Setting reconciliation failed', error),
      );
    }),
  );

  const mcpControlTools = new Set([
    'django_session_start',
    'django_breakpoints_update',
    'django_execution_control',
  ]);
  const controllerBackend = mcpController.asTransportBackend();
  const mcpBackend: McpTransportBackend = {
    ...controllerBackend,
    async callTool(name, args, requestContext) {
      const evaluateAllowed = vscode.workspace
        .getConfiguration('djangoProcessDebugger')
        .get<boolean>('mcp.allowEvaluate', false);
      if (mcpToolRequiresEvaluatePermission(name, args) && !evaluateAllowed) {
        const result = {
          ok: false,
          error: {
            code: 'POLICY_DISABLED',
            message: 'MCP expression evaluation is disabled by djangoProcessDebugger.mcp.allowEvaluate.',
          },
        };
        return {
          structuredContent: result,
          text: JSON.stringify(result),
          isError: true,
        };
      }
      const controlAllowed = vscode.workspace
        .getConfiguration('djangoProcessDebugger')
        .get<boolean>('mcp.allowControl', true);
      if (mcpControlTools.has(name) && !controlAllowed) {
        const result = {
          ok: false,
          error: {
            code: 'POLICY_DISABLED',
            message: 'MCP debugger control is disabled by djangoProcessDebugger.mcp.allowControl.',
          },
        };
        return {
          structuredContent: result,
          text: JSON.stringify(result),
          isError: true,
        };
      }
      return controllerBackend.callTool(name, args, requestContext);
    },
  };

  async function mcpWorkspaceFolders(): Promise<McpWorkspaceFolderManifest[]> {
    const result: McpWorkspaceFolderManifest[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') {
        continue;
      }
      let canonicalPath: string;
      try {
        canonicalPath = await fs.promises.realpath(folder.uri.fsPath);
      } catch {
        canonicalPath = path.resolve(folder.uri.fsPath);
      }
      result.push({
        name: folder.name,
        uri: folder.uri.toString(),
        fsPath: folder.uri.fsPath,
        canonicalPath: path.resolve(canonicalPath),
      });
    }
    return result.sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));
  }

  let mcpHost: StartedMcpWindowHost | undefined;
  let mcpDisposed = false;
  let mcpLifecycleChain = Promise.resolve();
  const extensionVersion = String(
    (context.extension.packageJSON as { version?: unknown }).version ?? '0.0.0',
  );

  function clearMcpOwnedBreakpoints(): void {
    try {
      const removed = mcpController.clearOwnedBreakpoints();
      if (removed > 0) {
        log(`[MCP] Removed ${removed} MCP-owned breakpoint(s)`);
      }
    } catch (error) {
      logError('[MCP] Could not remove MCP-owned breakpoints', error);
    }
  }

  function queueMcpReconcile(restart = false): Promise<void> {
    mcpLifecycleChain = mcpLifecycleChain.then(async () => {
      if (mcpDisposed) {
        return;
      }
      if (restart) {
        if (mcpHost) {
          const previous = mcpHost;
          mcpHost = undefined;
          await previous.dispose();
        }
        clearMcpOwnedBreakpoints();
      }

      const enabled = vscode.workspace
        .getConfiguration('djangoProcessDebugger')
        .get<boolean>('mcp.enabled', true);
      const folders = enabled && vscode.workspace.isTrusted
        ? await mcpWorkspaceFolders()
        : [];
      const shouldRun = enabled && vscode.workspace.isTrusted && folders.length > 0;
      if (!shouldRun) {
        if (mcpHost) {
          const previous = mcpHost;
          mcpHost = undefined;
          await previous.dispose();
          log('[MCP] Window endpoint stopped');
        }
        clearMcpOwnedBreakpoints();
        return;
      }
      if (mcpHost) {
        return;
      }

      let started: StartedMcpWindowHost | undefined;
      for (let attempt = 0; attempt < 3 && started === undefined; attempt += 1) {
        try {
          started = await startMcpWindowHost({
            windowId: mcpWindowId,
            extensionPid: process.pid,
            extensionVersion,
            workspaceFolders: folders,
            backend: mcpBackend,
            instructions: [
              'Use django_targets_list before django_session_start.',
              'Target, stop, frame, and variable references are opaque and expire.',
              'Use django_session_wait_ready after starting, then django_execution_wait and django_state_snapshot.',
              'Pass the current stopRef when continuing or stepping so a newer stop is never resumed by mistake.',
              'This server is restricted to the workspace folders in the owning VS Code window.',
            ].join(' '),
          });
        } catch (error) {
          if (!(error instanceof McpWindowIdCollisionError) || attempt >= 2) {
            throw error;
          }
          const collidedId = mcpWindowId;
          mcpWindowId = createMcpWindowId();
          context.environmentVariableCollection.replace(MCP_WINDOW_ID_VARIABLE, mcpWindowId);
          mcpController.setWindowId(mcpWindowId);
          log(`[MCP] Window id collision for ${collidedId}; retrying with ${mcpWindowId}`);
        }
      }
      if (!started) {
        throw new Error('MCP window endpoint could not claim a unique discovery id.');
      }
      if (mcpDisposed) {
        await started.dispose();
        return;
      }
      mcpHost = started;
      log(`[MCP] Window endpoint listening at ${started.url} (window=${mcpWindowId})`);
    }).catch((error) => {
      logError('[MCP] Window endpoint reconciliation failed', error);
    });
    return mcpLifecycleChain;
  }

  async function shutdownMcpLifecycle(): Promise<void> {
    if (mcpDisposed) {
      await mcpLifecycleChain;
      return;
    }
    mcpDisposed = true;
    await mcpLifecycleChain;
    const current = mcpHost;
    mcpHost = undefined;
    await current?.dispose();
    clearMcpOwnedBreakpoints();
  }

  activeMcpShutdown = shutdownMcpLifecycle;
  context.subscriptions.push(
    { dispose: () => { void shutdownMcpLifecycle(); } },
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void queueMcpReconcile(true);
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void queueMcpReconcile();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('djangoProcessDebugger.mcp.enabled')) {
        void queueMcpReconcile();
      }
    }),
  );
  void queueMcpReconcile();

  context.subscriptions.push(
    factory,
    tracker,
    attachCmd,
    setupCmd,
    statusCmd,
    killCmd,
    reinstallCmd,
    cleanLsCmd,
    installMcpCmd,
    repairMcpCmd,
    verifyMcpCmd,
    mcpStatusCmd,
    hotReloadStatusItem,
    getLogger(),
  );
  log('Extension activated');
  return DJANGO_PROCESS_DEBUGGER_PUBLIC_API;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Failed to get port')));
      }
    });
    srv.on('error', reject);
  });
}

export async function deactivate(): Promise<void> {
  const hotReloadShutdown = activeHotReloadShutdown;
  const mcpShutdown = activeMcpShutdown;
  activeHotReloadShutdown = undefined;
  activeMcpShutdown = undefined;
  await Promise.allSettled([
    hotReloadShutdown?.(),
    mcpShutdown?.(),
  ].filter((operation): operation is Promise<void> => operation !== undefined));
}
