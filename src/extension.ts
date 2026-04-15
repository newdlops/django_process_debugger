import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DjangoProcess, DjangoProcessFinder } from './processFinder';
import { DebugpyInjector, BootstrapNotLoadedError, BootstrapNotInstalledError, BOOTSTRAP_VERSION } from './debugpyInjector';
import { DebugpyManager, DebugpyProvisioningInfo } from './debugpyManager';
import { log, logError, getLogger } from './logger';
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
const LOCK_FILE = path.join(LOCK_DIR, 'debug-session.lock');

interface LockInfo {
  pid: number;
  port: number;
  workspaceId: string;
  workspaceName: string;
  timestamp: string;
}

function readLock(): LockInfo | null {
  try {
    const data = fs.readFileSync(LOCK_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function writeLock(info: LockInfo): void {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  fs.writeFileSync(LOCK_FILE, JSON.stringify(info), 'utf-8');
}

function removeLock(): void {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

function getWorkspaceId(): string {
  // Use a combination that's unique per VS Code window
  return process.pid + '-' + (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'unknown');
}

function getWorkspaceName(): string {
  return vscode.workspace.workspaceFolders?.[0]?.name ?? 'Unknown Workspace';
}

export function activate(context: vscode.ExtensionContext) {
  log('Extension activating...');

  const processFinder = new DjangoProcessFinder();
  const injector = new DebugpyInjector();
  const debugpyManager = new DebugpyManager(context);

  // Register our own debug adapter factory.
  // This connects directly to debugpy's DAP server via TCP —
  // no dependency on ms-python.python or ms-python.debugpy extensions.
  // Debug adapter: connects directly to debugpy's DAP server via TCP
  const factory = vscode.debug.registerDebugAdapterDescriptorFactory(
    'django-process',
    {
      createDebugAdapterDescriptor(session: vscode.DebugSession) {
        const config = session.configuration;
        const host: string = config.host ?? '127.0.0.1';
        const port: number = config.port ?? 5678;
        log(`[DebugAdapter] Connecting to DAP server at ${host}:${port}`);
        return new vscode.DebugAdapterServer(port, host);
      },
    }
  );

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
            log(`[DAP] -> send: ${JSON.stringify(message)}`);
          },
          onDidSendMessage(message: unknown) {
            log(`[DAP] <- recv: ${JSON.stringify(message)}`);
          },
          onError(error: Error) {
            logError(`[DAP] Error`, error);
          },
          onExit(code: number | undefined, signal: string | undefined) {
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
          progress.report({ message: 'Preparing bundled debugpy...' });
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
    const profile = await getSetupProfile(context);
    const debugpyInfo = await debugpyManager.getProvisioningInfo();
    const bootstrapInstalled = profile
      ? await isProfileStillInstalled(profile, injector)
      : false;

    const items: StatusQuickPickItem[] = [];
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
      detail: debugpyInfo.path,
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
      log('Command: attachToProcess');

      const processes = await processFinder.findDjangoProcesses();
      log(`Found ${processes.length} Django process(es)`);
      if (processes.length === 0) {
        vscode.window.showWarningMessage(
          'No running Django processes found. Start a Django server first.'
        );
        return;
      }

      // Group by port to deduplicate parent/child processes on the same server
      // Show one entry per port (or per unique celery worker)
      const portGroups = new Map<string, typeof processes>();
      for (const p of processes) {
        const key = p.type === 'celery'
          ? `celery-${p.pid}`  // each celery worker is unique
          : `${p.port ?? 'no-port'}-${p.type}`;
        const group = portGroups.get(key) ?? [];
        group.push(p);
        portGroups.set(key, group);
      }

      const items = await Promise.all([...portGroups.values()].map(async (group) => {
        // Pick the representative: prefer the one with the highest CPU (active child)
        const representative = group[0];
        const allPids = group.map((p) => p.pid);
        const icon = representative.type === 'celery' ? '$(server-process)' : '$(globe)';
        const typeLabel = representative.type === 'celery' ? 'Celery Worker' : 'Django Server';

        // Check debugpy status for any pid in the group
        let activePort: number | null = null;
        for (const p of group) {
          activePort = await injector.getActivePort(p.pid);
          if (activePort) { break; }
        }
        const portStatus = activePort
          ? `$(debug-alt) debugpy active on ${activePort}`
          : '$(circle-slash) debugpy not attached';
        const portLabel = representative.port ? ` | Port: ${representative.port}` : '';
        const pidLabel = allPids.length > 1
          ? `PIDs: ${allPids.join(', ')}`
          : `PID: ${allPids[0]}`;

        return {
          label: `${icon} [${typeLabel}] ${pidLabel}${portLabel}`,
          description: representative.command,
          detail: `${portStatus}  |  Python: ${representative.pythonPath}`,
          process: representative,
        };
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a Django process to attach debugger',
      });

      if (!selected) {
        log('User cancelled process selection');
        return;
      }

      // Resolve to the actual debuggable Python process
      // (walks down from uv wrapper → autoreloader → actual server)
      const resolved = await processFinder.resolveDebuggablePid(selected.process.pid);
      const pid = resolved.pid;
      const resolvedPythonPath = await injector.resolvePythonForPid(pid);
      const targetProcess: DjangoProcess = {
        ...selected.process,
        pid,
        pythonPath: resolvedPythonPath,
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
      log(`Selected PID=${selected.process.pid} → resolved to PID=${pid} (${resolvedPythonPath})`);

      // Check if another VS Code window already has an active debug session
      const existingLock = readLock();
      if (existingLock && existingLock.workspaceId !== getWorkspaceId()) {
        // Verify the lock is still valid: process alive AND port still listening
        let lockValid = false;
        try {
          process.kill(existingLock.pid, 0); // process alive?
          lockValid = await injector.isPortListeningPublic(existingLock.port);
        } catch {
          lockValid = false;
        }

        if (lockValid) {
          log(`Active debug session detected from workspace "${existingLock.workspaceName}" (PID ${existingLock.pid})`);
          vscode.window.showErrorMessage(
            `Cannot attach: a debug session is already active in workspace "${existingLock.workspaceName}" ` +
            `(PID ${existingLock.pid}, port ${existingLock.port}). ` +
            `Stop the existing session first.`
          );
          return;
        } else {
          log('Found stale lock file, removing');
          removeLock();
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
              `Bootstrap updated to v${BOOTSTRAP_VERSION}. Hot reload improvements will take effect after restarting the Django server.`
            );
          } catch (updateErr) {
            logError('[Attach] Bootstrap auto-update failed', updateErr);
          }
        }
      } catch (err) {
        logError(`[Attach] Failed to inspect runtime ${resolvedPythonPath}`, err);
      }

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

      let debugPort: number;
      try {
        debugPort = await injector.activate(pid, port);
        if (debugPort !== port) {
          log(`debugpy was already active on port ${debugPort}, reusing`);
        }
        log(`debugpy activated for PID=${pid} on port ${debugPort}`);
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

      // Use our own debug type — connects directly to debugpy DAP server
      const justMyCode = vscode.workspace.getConfiguration('djangoProcessDebugger').get<boolean>('justMyCode', true);
      const processType = selected.process.type;
      const sessionLabel = processType === 'celery' ? 'Celery Worker' : 'Django';
      const redirectOutput = vscode.workspace.getConfiguration('djangoProcessDebugger').get<boolean>('redirectOutput', true);
      const debugConfig: vscode.DebugConfiguration = {
        type: 'django-process',
        request: 'attach',
        name: `${sessionLabel} (PID: ${pid})`,
        host: '127.0.0.1',
        port: debugPort,
        justMyCode,
        redirectOutput,
      };

      log(`Debug config: ${JSON.stringify(debugConfig)}`);

      // Write lock before starting session
      writeLock({
        pid,
        port: debugPort,
        workspaceId: getWorkspaceId(),
        workspaceName: getWorkspaceName(),
        timestamp: new Date().toISOString(),
      });

      const started = await vscode.debug.startDebugging(undefined, debugConfig);
      log(`Debug session started: ${started}`);

      if (started) {
        startHotReloadWatcher(pid);
        vscode.window.showInformationMessage(
          `$(debug-alt) ${sessionLabel} (PID: ${pid}) attached on port ${debugPort}`
        );
      } else {
        removeLock();
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
        return {
          label: `${icon} [${typeLabel}] PID: ${p.pid}${portLabel}`,
          description: p.command,
          detail: `Python: ${p.pythonPath}`,
          process: p,
        };
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a process to kill',
        canPickMany: true,
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

      // ── 1. Remove ALL bootstrap .pth and _django_debug_bootstrap.py files ──
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
      ];

      for (const root of searchRoots) {
        try {
          await fsPromises.access(root);
        } catch { continue; }

        try {
          const { stdout } = await execFileAsync('find', [
            root, '-maxdepth', '8',
            '(', '-name', 'django_process_debugger.pth', '-o', '-name', '_django_debug_bootstrap.py', ')',
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
          } else if (/debugpy|_django_debug_bootstrap/.test(command)) {
            label = 'debugpy';
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
  let hotReloadDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let hotReloadPendingFiles: Set<string> = new Set();
  const hotReloadStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

  function startHotReloadWatcher(pid: number): void {
    const hotReloadEnabled = vscode.workspace.getConfiguration('djangoProcessDebugger').get<boolean>('hotReload', true);
    if (!hotReloadEnabled) {
      log('[HotReload] Disabled by setting');
      return;
    }

    stopHotReloadWatcher();
    hotReloadPid = pid;

    hotReloadWatcher = vscode.workspace.createFileSystemWatcher('**/*.py');
    hotReloadWatcher.onDidChange((uri) => onPyFileChanged(uri));
    hotReloadWatcher.onDidCreate((uri) => onPyFileChanged(uri));

    hotReloadStatusItem.text = '$(flame) Hot Reload';
    hotReloadStatusItem.tooltip = `Hot reload active for PID ${pid}. Changed .py files are reloaded without restarting.`;
    hotReloadStatusItem.show();

    log(`[HotReload] File watcher started for PID=${pid}`);
  }

  function stopHotReloadWatcher(): void {
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
    hotReloadStatusItem.hide();
    log('[HotReload] File watcher stopped');
  }

  function onPyFileChanged(uri: vscode.Uri): void {
    if (!hotReloadPid) { return; }
    const filePath = uri.fsPath;

    // Ignore files outside workspace, inside venvs, __pycache__, migrations, etc.
    if (filePath.includes('site-packages') ||
        filePath.includes('__pycache__') ||
        filePath.includes('.venv') ||
        filePath.includes('/venv/') ||
        filePath.includes('node_modules') ||
        filePath.includes('/migrations/')) {
      return;
    }

    hotReloadPendingFiles.add(filePath);

    // Debounce: batch changes within 500ms window
    if (hotReloadDebounceTimer) {
      clearTimeout(hotReloadDebounceTimer);
    }
    hotReloadDebounceTimer = setTimeout(() => {
      flushHotReload();
    }, 500);
  }

  async function flushHotReload(): Promise<void> {
    if (!hotReloadPid || hotReloadPendingFiles.size === 0) { return; }

    const pid = hotReloadPid;
    const files = [...hotReloadPendingFiles];
    hotReloadPendingFiles.clear();

    log(`[HotReload] Requesting reload for ${files.length} file(s): ${files.join(', ')}`);
    hotReloadStatusItem.text = '$(sync~spin) Reloading...';

    try {
      await injector.requestHotReload(pid, files);

      // Wait briefly for the Python watcher to process and write results
      await new Promise((r) => setTimeout(r, 1000));

      const results = await injector.readReloadResult(pid);
      if (results) {
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

        log(`[HotReload] Results: ${ok.length} OK, ${err.length} ERR, ${skip.length} SKIP`);
      }
    } catch (err) {
      logError('[HotReload] Failed to request reload', err);
    }

    hotReloadStatusItem.text = '$(flame) Hot Reload';
  }

  // Debug session lifecycle logging
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      log(`[DebugSession] Started: ${session.name} (type=${session.type})`);
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      log(`[DebugSession] Terminated: ${session.name}`);
      if (session.type === 'django-process') {
        removeLock();
        stopHotReloadWatcher();
        log('[DebugSession] Lock file removed, hot reload stopped');
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
