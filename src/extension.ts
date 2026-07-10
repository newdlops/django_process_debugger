import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DjangoProcess, DjangoProcessFinder } from './processFinder';
import {
  DebugpyInjector,
  BootstrapNotLoadedError,
  BootstrapNotInstalledError,
  BootstrapRuntimeVersionError,
  BOOTSTRAP_VERSION,
} from './debugpyInjector';
import { DebugpyManager, DebugpyProvisioningInfo } from './debugpyManager';
import { log, logError, getLogger } from './logger';
import { shouldIgnoreForHotReload } from './hotReloadFilter';
import { TcpListeningEndpoint, formatEndpoint } from './listeningEndpoint';
import { summarizeDapMessage } from './dapLogging';
import {
  processQuickPickDescription,
  processQuickPickDetail,
  selectGroupedDisplayCwd,
} from './processQuickPickDisplay';
import {
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

const LOCK_DIR = '/tmp/django-process-debugger';
const LEGACY_LOCK_FILE = path.join(LOCK_DIR, 'debug-session.lock');
const PENDING_LOCK_TTL_MS = 30_000;

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

function removeLock(pid?: number): void {
  if (typeof pid === 'number') {
    try { fs.unlinkSync(lockFileForPid(pid)); } catch { /* ignore */ }
    const legacyLock = readLockFile(LEGACY_LOCK_FILE);
    if (legacyLock?.pid === pid) {
      try { fs.unlinkSync(LEGACY_LOCK_FILE); } catch { /* ignore */ }
    }
    return;
  }

  try { fs.unlinkSync(LEGACY_LOCK_FILE); } catch { /* ignore */ }
  try {
    for (const entry of fs.readdirSync(LOCK_DIR)) {
      if (/^debug-session\.\d+\.(?:lock|claim)$/.test(entry)) {
        try { fs.unlinkSync(path.join(LOCK_DIR, entry)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
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

export function activate(context: vscode.ExtensionContext) {
  log('Extension activating...');

  const processFinder = new DjangoProcessFinder();
  const injector = new DebugpyInjector();
  const debugpyManager = new DebugpyManager(context);

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

  // Sessions currently paused at a breakpoint (all threads stopped).
  // The Python-side hot-reload watcher thread is frozen during this period,
  // so reload requests are queued until the user resumes execution.
  const pausedSessions = new Set<string>();
  interface DapEvent { type?: string; event?: string; body?: { allThreadsStopped?: boolean } }

  // DAP message tracker for debugging the debug protocol itself
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory(
    'django-process',
    {
      createDebugAdapterTracker(session: vscode.DebugSession) {
        return {
          onWillStartSession() {
            log(`[DAP] Session starting`);
          },
          onWillReceiveMessage(message: unknown) {
            log(`[DAP] -> send: ${summarizeDapMessage(message)}`);
          },
          onDidSendMessage(message: unknown) {
            const msg = message as DapEvent;
            if (msg?.type === 'event') {
              if (msg.event === 'stopped' && msg.body?.allThreadsStopped) {
                pausedSessions.add(session.id);
                log(`[HotReload] Session ${session.id} paused (allThreadsStopped)`);
              } else if (msg.event === 'continued') {
                pausedSessions.delete(session.id);
                log(`[HotReload] Session ${session.id} resumed`);
              } else if (msg.event === 'terminated' || msg.event === 'exited') {
                pausedSessions.delete(session.id);
              }
            }
            log(`[DAP] <- recv: ${summarizeDapMessage(message)}`);
          },
          onError(error: Error) {
            logError(`[DAP] Error`, error);
          },
          onExit(code: number | undefined, signal: string | undefined) {
            pausedSessions.delete(session.id);
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
      await vscode.commands.executeCommand('djangoProcessDebugger.setup');
    } else if (selected.action === 'reinstall') {
      await vscode.commands.executeCommand('djangoProcessDebugger.reinstallDebugpy');
    } else if (selected.action === 'logs') {
      getLogger().show();
    }
  }

  // Command: Setup
  const setupCmd = vscode.commands.registerCommand(
    'djangoProcessDebugger.setup',
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
    'djangoProcessDebugger.showSetupStatus',
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
            await vscode.commands.executeCommand('djangoProcessDebugger.setup');
          } else if (choice === 'Show Status') {
            await showSetupStatus();
          } else if (choice === 'Show Logs') {
            getLogger().show();
          }
          return;
        }
      }

      let debugEndpoint: TcpListeningEndpoint;
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

  // Command: Clean Python Language Server
  const cleanLsCmd = vscode.commands.registerCommand(
    'djangoProcessDebugger.cleanPythonLanguageServer',
    async () => {
      log('Command: cleanPythonLanguageServer');

      const { execFile: execFileCb } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFileCb);

      const actions: string[] = [];

      // ── 1. Remove ALL shared bootstrap and tracer files ──
      // These are the root cause of Python process poisoning.
      // Search workspace venvs, asdf installs, and common Python locations.
      const home = os.homedir();
      const pyenvRoot = process.env.PYENV_ROOT ?? path.join(home, '.pyenv');
      const searchRoots = [
        ...(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? []),
        // Version managers
        path.join(home, '.asdf', 'installs', 'python'),
        path.join(pyenvRoot, 'versions'),
        // Conda
        path.join(home, 'miniconda3', 'envs'),
        path.join(home, 'anaconda3', 'envs'),
        path.join(home, 'miniforge3', 'envs'),
        path.join(home, '.conda', 'envs'),
        // Poetry / pipenv
        path.join(home, 'Library', 'Caches', 'pypoetry', 'virtualenvs'),
        path.join(home, '.cache', 'pypoetry', 'virtualenvs'),
        path.join(home, '.local', 'share', 'virtualenvs'),
        // Homebrew
        '/usr/local/lib',
        '/opt/homebrew/lib',
      ];

      const bootstrapFiles = [
        'django_process_debugger.pth',
        '_django_debug_bootstrap.py',
        '_django_debug_tracer.py',
      ];
      const bootstrapFindExpression = bootstrapFiles.flatMap((fileName, index) =>
        index === 0 ? ['-name', fileName] : ['-o', '-name', fileName]
      );

      for (const root of searchRoots) {
        try {
          await fsPromises.access(root);
        } catch { continue; }

        try {
          const { stdout } = await execFileAsync('find', [
            root, '-maxdepth', '8',
            '(', ...bootstrapFindExpression, ')',
            '-type', 'f',
          ], { timeout: 10_000 });

          for (const filePath of stdout.trim().split('\n').filter(Boolean)) {
            try {
              await fsPromises.unlink(filePath);
              actions.push(`Removed bootstrap: ${filePath}`);
              log(`[Clean] Removed: ${filePath}`);
            } catch (err) {
              logError(`[Clean] Failed to remove ${filePath}`, err);
            }
          }
        } catch {
          // find may fail on some dirs, that's ok
        }
      }

      // ── 2. Clean up /tmp/django-process-debugger/ temp files ──
      const tmpDir = '/tmp/django-process-debugger';
      try {
        const stat = await fsPromises.stat(tmpDir);
        if (stat.isDirectory()) {
          await fsPromises.rm(tmpDir, { recursive: true, force: true });
          actions.push(`Removed temp dir: ${tmpDir}`);
          log(`[Clean] Removed: ${tmpDir}`);
        }
      } catch { /* not found */ }

      // ── 3. Kill ALL Python processes (thorough clean) ──
      // Clean All is a full reset — kill every Python process except VS Code internals.
      try {
        const { stdout } = await execFileAsync('ps', ['aux']);
        const myPid = process.pid;
        const myPpid = (await execFileAsync('ps', ['-o', 'ppid=', '-p', String(myPid)])).stdout.trim();

        // Match any line with a python binary in the command
        const pythonBinPattern = /python\d?(\.\d+)*/;

        const killed: { pid: number; label: string; command: string }[] = [];

        for (const line of stdout.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 11) { continue; }
          const pid = parseInt(parts[1], 10);
          if (isNaN(pid)) { continue; }

          const command = parts.slice(10).join(' ');

          // Must be a Python process
          if (!pythonBinPattern.test(command)) { continue; }

          // Never kill ourselves or our parent (VS Code extension host)
          if (pid === myPid || String(pid) === myPpid) { continue; }

          // Categorize for logging
          let label = 'python';
          if (/manage\.py\s+runserver|uvicorn\s|gunicorn\s|daphne\s/.test(command)) {
            label = 'django';
          } else if (/celery\s+.*worker|-m\s+celery\s+worker/.test(command)) {
            label = 'celery';
          } else if (/jedi|pylance|pyright|language.server/i.test(command)) {
            label = 'language-server';
          } else if (/debugpy|_django_debug_bootstrap|_django_debug_tracer|django_process_debugger_tracer/.test(command)) {
            label = 'debug-agent';
          }

          try {
            // SIGTERM for servers (graceful), SIGKILL for everything else
            const signal = (label === 'django' || label === 'celery') ? 'SIGTERM' : 'SIGKILL';
            process.kill(pid, signal);
            killed.push({ pid, label, command });
            log(`[Clean] ${signal} PID=${pid} [${label}]: ${command}`);
          } catch { /* already dead */ }
        }

        if (killed.length > 0) {
          // Group by label for summary
          const groups = new Map<string, number[]>();
          for (const k of killed) {
            const arr = groups.get(k.label) ?? [];
            arr.push(k.pid);
            groups.set(k.label, arr);
          }
          for (const [label, pids] of groups) {
            actions.push(`Killed ${pids.length} ${label} process(es): PID ${pids.join(', ')}`);
          }
        }
      } catch (err) {
        logError('[Clean] Failed to scan processes', err);
      }

      // ── 4. Clear Jedi & parso caches ──
      const cacheDirs = [
        path.join(os.homedir(), '.cache', 'jedi'),
        path.join(os.homedir(), 'Library', 'Caches', 'jedi'),
        path.join(os.homedir(), '.cache', 'parso'),
        path.join(os.homedir(), 'Library', 'Caches', 'parso'),
      ];
      for (const dir of cacheDirs) {
        try {
          const stat = await fsPromises.stat(dir);
          if (stat.isDirectory()) {
            await fsPromises.rm(dir, { recursive: true, force: true });
            actions.push(`Removed cache: ${dir}`);
            log(`[Clean] Removed cache: ${dir}`);
          }
        } catch { /* not found */ }
      }

      // ── 5. Remove bundled debugpy (will be reinstalled on next Setup) ──
      const debugpyDir = debugpyManager.getDebugpyDir();
      try {
        const stat = await fsPromises.stat(debugpyDir);
        if (stat.isDirectory()) {
          await fsPromises.rm(debugpyDir, { recursive: true, force: true });
          actions.push(`Removed bundled debugpy: ${debugpyDir}`);
          log(`[Clean] Removed bundled debugpy: ${debugpyDir}`);
        }
      } catch { /* not found */ }

      // ── 6. Remove debug session lock ──
      removeLock();
      await clearSetupProfile(context);
      actions.push('Cleared workspace setup profile');

      // ── 7. Restore Python binaries (macOS code signature + quarantine) ──
      // Repeated crashes can trigger macOS AppleSystemPolicy to block binaries.
      // We need to: remove quarantine xattr, re-sign, and verify execution.
      if (process.platform === 'darwin') {
        const pythonBinaries = new Set<string>();
        const home = os.homedir();

        // Collect all Python binaries (resolve symlinks to get real files)
        const collectBinaries = async (dir: string) => {
          try {
            const files = await fsPromises.readdir(dir);
            for (const f of files) {
              if (/^python3?(\.\d+)*$/.test(f)) {
                const fullPath = path.join(dir, f);
                // Add both symlink path and resolved real path
                try {
                  const realPath = await fsPromises.realpath(fullPath);
                  pythonBinaries.add(realPath);
                } catch { /* broken symlink */ }
                // Also add the symlink itself if it's a different path
                try {
                  await fsPromises.access(fullPath);
                  pythonBinaries.add(fullPath);
                } catch { /* skip */ }
              }
            }
          } catch { /* dir not found */ }
        };

        // Workspace venvs
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
          for (const venvName of ['.venv', 'venv', '.virtualenv', 'env', '.env']) {
            await collectBinaries(path.join(folder.uri.fsPath, venvName, 'bin'));
          }
        }

        // Sibling project venvs
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
          const parentDir = path.dirname(folder.uri.fsPath);
          try {
            const siblings = await fsPromises.readdir(parentDir);
            for (const sibling of siblings) {
              for (const venvName of ['.venv', 'venv']) {
                await collectBinaries(path.join(parentDir, sibling, venvName, 'bin'));
              }
            }
          } catch { /* skip */ }
        }

        // Version managers: asdf, pyenv, mise
        const versionManagerDirs = [
          path.join(home, '.asdf', 'installs', 'python'),
          process.env.PYENV_ROOT
            ? path.join(process.env.PYENV_ROOT, 'versions')
            : path.join(home, '.pyenv', 'versions'),
          path.join(home, '.local', 'share', 'mise', 'installs', 'python'),
        ];
        for (const baseDir of versionManagerDirs) {
          try {
            const versions = await fsPromises.readdir(baseDir);
            for (const ver of versions) {
              await collectBinaries(path.join(baseDir, ver, 'bin'));
            }
          } catch { /* not found */ }
        }

        // conda
        const condaDirs = [
          path.join(home, 'miniconda3', 'envs'),
          path.join(home, 'anaconda3', 'envs'),
          path.join(home, 'miniforge3', 'envs'),
          path.join(home, '.conda', 'envs'),
        ];
        for (const condaDir of condaDirs) {
          try {
            const envs = await fsPromises.readdir(condaDir);
            for (const env of envs) {
              await collectBinaries(path.join(condaDir, env, 'bin'));
            }
          } catch { /* not found */ }
        }

        // Poetry / pipenv
        const venvCacheDirs = [
          path.join(home, 'Library', 'Caches', 'pypoetry', 'virtualenvs'),
          path.join(home, '.cache', 'pypoetry', 'virtualenvs'),
          path.join(home, '.local', 'share', 'virtualenvs'),
        ];
        for (const cacheDir of venvCacheDirs) {
          try {
            const entries = await fsPromises.readdir(cacheDir);
            for (const entry of entries) {
              await collectBinaries(path.join(cacheDir, entry, 'bin'));
            }
          } catch { /* not found */ }
        }

        // Homebrew
        for (const brewPrefix of ['/opt/homebrew/bin', '/usr/local/bin']) {
          await collectBinaries(brewPrefix);
        }

        // Deduplicate by resolving all to real paths
        const uniqueBinaries = new Set<string>();
        for (const pyBin of pythonBinaries) {
          try {
            const realPath = await fsPromises.realpath(pyBin);
            uniqueBinaries.add(realPath);
          } catch {
            uniqueBinaries.add(pyBin);
          }
        }

        log(`[Clean] Found ${uniqueBinaries.size} unique Python binaries to check`);

        let repairCount = 0;
        for (const pyBin of uniqueBinaries) {
          let needsRepair = false;

          // Step A: Check if binary is currently broken by trying to run it
          try {
            await execFileAsync(pyBin, ['-S', '-c', 'print("ok")'], { timeout: 5_000 });
          } catch {
            needsRepair = true;
            log(`[Clean] Broken binary detected: ${pyBin}`);
          }

          if (!needsRepair) { continue; }

          // Step B: Remove quarantine extended attribute
          try {
            await execFileAsync('xattr', ['-dr', 'com.apple.quarantine', pyBin], { timeout: 5_000 });
            log(`[Clean] Removed quarantine xattr: ${pyBin}`);
          } catch { /* no quarantine attr — fine */ }

          // Step C: Clear macOS security assessment (revoke any cached deny)
          try {
            const binDir = path.dirname(pyBin);
            await execFileAsync('xattr', ['-cr', binDir], { timeout: 5_000 });
            log(`[Clean] Cleared xattrs on dir: ${binDir}`);
          } catch { /* skip */ }

          // Step D: Re-sign with ad-hoc signature
          try {
            await execFileAsync('codesign', [
              '--force', '--deep', '--sign', '-', pyBin,
            ], { timeout: 10_000 });
            log(`[Clean] Re-signed: ${pyBin}`);
          } catch (err) {
            logError(`[Clean] codesign failed for ${pyBin}`, err);
          }

          // Step E: Verify it actually works now
          try {
            await execFileAsync(pyBin, ['-S', '-c', 'print("ok")'], { timeout: 5_000 });
            repairCount++;
            log(`[Clean] Verified working: ${pyBin}`);
          } catch {
            log(`[Clean] Still broken after repair: ${pyBin} — may need manual reinstall`);
            actions.push(`WARNING: Could not repair ${pyBin} — consider reinstalling this Python version`);
          }
        }

        if (repairCount > 0) {
          actions.push(`Repaired ${repairCount} Python binary(ies) (quarantine + codesign)`);
        }
        log(`[Clean] Checked ${uniqueBinaries.size} binaries, repaired ${repairCount}`);
      }

      // ── Summary ──
      const summary = actions.join('\n');
      if (summary) { log(`[Clean] Done:\n${summary}`); }

      const choice = await vscode.window.showInformationMessage(
        actions.length > 0
          ? `Cleaned ${actions.length} item(s). Python environment restored. Reload window?`
          : 'Nothing to clean. Reload window to restart language server?',
        'Reload Window', 'Show Logs',
      );
      if (choice === 'Reload Window') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      } else if (choice === 'Show Logs') {
        getLogger().show();
      }
    }
  );

  // ── Hot Reload: file watcher management ──
  let hotReloadWatcher: vscode.FileSystemWatcher | undefined;
  let hotReloadPid: number | undefined;
  let hotReloadSessionId: string | undefined;
  const effectiveSessionEngines = new Map<string, DebugEngine>();
  let hotReloadDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let hotReloadPendingFiles: Set<string> = new Set();
  let hotReloadGeneration = 0;
  let hotReloadAbortController: AbortController | undefined;
  let hotReloadFlushChain: Promise<void> = Promise.resolve();
  const hotReloadStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

  function startHotReloadWatcher(pid: number, sessionId: string): void {
    stopHotReloadWatcher();
    const hotReloadEnabled = vscode.workspace.getConfiguration('djangoProcessDebugger').get<boolean>('hotReload', true);
    if (!hotReloadEnabled) {
      log('[HotReload] Disabled by setting');
      return;
    }

    hotReloadAbortController = new AbortController();
    hotReloadPid = pid;
    hotReloadSessionId = sessionId;

    hotReloadWatcher = vscode.workspace.createFileSystemWatcher('**/*.py');
    hotReloadWatcher.onDidChange((uri) => onPyFileChanged(uri));
    hotReloadWatcher.onDidCreate((uri) => onPyFileChanged(uri));

    hotReloadStatusItem.text = '$(flame) Hot Reload';
    hotReloadStatusItem.tooltip = `Hot reload active for PID ${pid}. Changed .py files are reloaded without restarting.`;
    hotReloadStatusItem.show();

    log(`[HotReload] File watcher started for PID=${pid}`);
  }

  function stopHotReloadWatcher(): void {
    hotReloadGeneration += 1;
    hotReloadAbortController?.abort();
    hotReloadAbortController = undefined;
    if (hotReloadDebounceTimer) {
      clearTimeout(hotReloadDebounceTimer);
      hotReloadDebounceTimer = undefined;
    }
    hotReloadPendingFiles.clear();
    if (hotReloadWatcher) {
      hotReloadWatcher.dispose();
      hotReloadWatcher = undefined;
    }
    hotReloadPid = undefined;
    hotReloadSessionId = undefined;
    hotReloadStatusItem.hide();
    log('[HotReload] File watcher stopped');
  }

  function onPyFileChanged(uri: vscode.Uri): void {
    if (!hotReloadPid) { return; }
    const filePath = uri.fsPath;

    if (shouldIgnoreForHotReload(filePath)) {
      return;
    }

    hotReloadPendingFiles.add(filePath);

    // Debounce: batch changes within 500ms window
    if (hotReloadDebounceTimer) {
      clearTimeout(hotReloadDebounceTimer);
    }
    hotReloadDebounceTimer = setTimeout(() => {
      hotReloadDebounceTimer = undefined;
      scheduleHotReloadFlush();
    }, 500);
  }

  function scheduleHotReloadFlush(): void {
    const generation = hotReloadGeneration;
    hotReloadFlushChain = hotReloadFlushChain
      .catch((error) => {
        logError('[HotReload] Previous reload batch failed', error);
      })
      .then(() => drainHotReload(generation));
  }

  async function drainHotReload(generation: number): Promise<void> {
    if (
      generation === hotReloadGeneration
      && hotReloadPid !== undefined
      && hotReloadSessionId !== undefined
      && hotReloadAbortController !== undefined
      && hotReloadPendingFiles.size > 0
    ) {
      const pid = hotReloadPid;
      const sessionId = hotReloadSessionId;
      const abortController = hotReloadAbortController;
      const files = [...hotReloadPendingFiles];
      hotReloadPendingFiles.clear();

      log(`[HotReload] Requesting reload for ${files.length} file(s): ${files.join(', ')}`);
      hotReloadStatusItem.text = '$(sync~spin) Reloading...';

      try {
        const requestId = await injector.requestHotReload(pid, files);
        if (requestId === null || abortController.signal.aborted) { return; }

        // The request id prevents an old/crashed watcher result from being
        // consumed by a later batch. Only one batch per session is in flight.
        let results = await injector.pollReloadResult(
          pid,
          3_000,
          20,
          requestId,
          abortController.signal,
        );

        let pending = false;
        if (results === null && !abortController.signal.aborted) {
          pending = await injector.isReloadPending(pid, requestId);
          if (!pending) {
            // The watcher publishes the result before clearing .processing.
            // Re-read across that transition so a result created between the
            // short poll and pending check cannot be missed.
            results = await injector.readReloadResult(pid, requestId);
          }
        }
        if (results === null && !abortController.signal.aborted && pending) {
          const atBreakpoint = pausedSessions.has(sessionId);
          if (generation === hotReloadGeneration) {
            hotReloadStatusItem.text = atBreakpoint
              ? '$(clock) Reload queued — continue to apply'
              : '$(clock) Reload queued...';
            hotReloadStatusItem.tooltip = atBreakpoint
              ? `Hot reload is waiting because the process is paused at a breakpoint. ` +
                `The Python watcher thread cannot run until you continue.`
              : undefined;
          }
          log(
            `[HotReload] Result not ready after 3s — request=${requestId}, `
            + `pending=true, paused=${atBreakpoint}. Extending timeout.`,
          );
          results = await injector.pollReloadResult(
            pid,
            60_000,
            20,
            requestId,
            abortController.signal,
          );
        }

        if (abortController.signal.aborted || generation !== hotReloadGeneration) {
          return;
        }
        if (results !== null) {
          const ok = results.filter((r) => r.startsWith('OK:'));
          const err = results.filter((r) => r.startsWith('ERR:'));
          const skip = results.filter((r) => r.startsWith('SKIP:'));

          if (ok.length > 0) {
            const moduleNames = ok.map((r) => r.replace('OK:', ''));
            vscode.window.showInformationMessage(
              `$(flame) Hot reloaded: ${moduleNames.join(', ')}`
            );
          }
          if (err.length > 0) {
            const details = err.map((r) => r.replace('ERR:', ''));
            vscode.window.showWarningMessage(
              `$(warning) Reload failed: ${details.join('; ')}`
            );
          }
          if (skip.length > 0 && ok.length === 0 && err.length === 0) {
            log(`[HotReload] All files skipped (not loaded as modules): ${skip.join(', ')}`);
          }
          log(
            `[HotReload] Results for ${requestId}: `
            + `${ok.length} OK, ${err.length} ERR, ${skip.length} SKIP`,
          );
        } else {
          log(`[HotReload] No result for ${requestId} after extended wait`);
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          logError('[HotReload] Failed to request reload', err);
        }
      } finally {
        if (generation === hotReloadGeneration) {
          hotReloadStatusItem.text = '$(flame) Hot Reload';
          hotReloadStatusItem.tooltip = `Hot reload active for PID ${pid}. ` +
            `Changed .py files are reloaded without restarting.`;
        }
      }
    }
  }

  // Debug session lifecycle logging
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(async (session) => {
      const engine = session.type === 'django-process' ? targetEngineFromSession(session) : undefined;
      const sessionPid = session.type === 'django-process' ? targetPidFromSession(session) : undefined;
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

        if (supportsHotReload(engine)) {
          startHotReloadWatcher(sessionPid, session.id);
        } else {
          log(`[HotReload] Disabled for ${engine}`);
        }
      }
      log(
        `[DebugSession] Started: ${session.name} (type=${session.type}` +
        `${engine ? `, engine=${engine}` : ''}` +
        `${sessionPid !== undefined ? `, pid=${sessionPid}` : ''})`
      );
    }),
    vscode.debug.onDidTerminateDebugSession(async (session) => {
      log(`[DebugSession] Terminated: ${session.name}`);
      if (session.type === 'django-process') {
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
        const hotReloadStopped = sessionPid !== undefined
          && hotReloadPid === sessionPid
          && hotReloadSessionId === session.id;
        if (hotReloadStopped) {
          stopHotReloadWatcher();
        }
        log(
          `[DebugSession] ${lockRemoved ? `Lock file removed for PID=${sessionPid}` : 'No PID lock to remove'} ` +
          `(engine=${engine})${hotReloadStopped ? ', hot reload stopped' : ''}`
        );
      }
    }),
  );

  context.subscriptions.push(factory, tracker, attachCmd, setupCmd, statusCmd, killCmd, reinstallCmd, cleanLsCmd, hotReloadStatusItem, getLogger());
  log('Extension activated');
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

export function deactivate() {}
