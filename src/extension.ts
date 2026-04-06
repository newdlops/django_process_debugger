import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { DjangoProcessFinder } from './processFinder';
import { DebugpyInjector, BootstrapNotLoadedError, BootstrapNotInstalledError } from './debugpyInjector';
import { DebugpyManager } from './debugpyManager';
import { log, logError, getLogger } from './logger';

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

  async function detectPythonPath(): Promise<string | undefined> {
    const items: vscode.QuickPickItem[] = [];

    // Add running Django processes as options
    const processes = await processFinder.findDjangoProcesses();
    const seen = new Set<string>();
    for (const p of processes) {
      if (!seen.has(p.pythonPath)) {
        seen.add(p.pythonPath);
        items.push({
          label: p.pythonPath,
          description: 'Detected from running process',
        });
      }
    }

    // Always show browse option
    items.push({
      label: '$(file-directory) Browse...',
      description: 'Select Python executable from file browser',
      alwaysShow: true,
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select Python interpreter for your venv',
    });

    if (!selected) { return undefined; }

    if (selected.label.includes('Browse...')) {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        title: 'Select Python Interpreter',
        openLabel: 'Select Python',
      });
      if (uris && uris.length > 0) {
        log(`User browsed python: ${uris[0].fsPath}`);
        return uris[0].fsPath;
      }
      return undefined;
    }

    log(`User selected python: ${selected.label}`);
    return selected.label;
  }

  async function ensureDebugpy(pythonPath: string): Promise<string> {
    const dir = await debugpyManager.ensureInstalled(pythonPath);
    injector.setBundledDebugpyPath(dir);
    return dir;
  }

  // Command: Setup
  const setupCmd = vscode.commands.registerCommand(
    'djangoProcessDebugger.setup',
    async () => {
      log('Command: setup');
      const pythonPath = await detectPythonPath();
      if (!pythonPath) { return; }

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Preparing debugpy...' },
          () => ensureDebugpy(pythonPath),
        );

        const sitePackages = await injector.resolveSitePackages(pythonPath);
        // Always overwrite — bootstrap code may have been updated
        await injector.installBootstrap(sitePackages);
        vscode.window.showInformationMessage(
          'Debug bootstrap installed. Restart your Django server, then use "Attach to Django Process".'
        );
      } catch (err) {
        logError('[Setup] Failed', err);
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Setup failed: ${msg}`, 'Show Logs').then((c) => {
          if (c === 'Show Logs') { getLogger().show(); }
        });
      }
    }
  );

  // Command: Teardown
  const teardownCmd = vscode.commands.registerCommand(
    'djangoProcessDebugger.teardown',
    async () => {
      log('Command: teardown');
      const pythonPath = await detectPythonPath();
      if (!pythonPath) { return; }

      try {
        const sitePackages = await injector.resolveSitePackages(pythonPath);
        await injector.uninstallBootstrap(sitePackages);
        vscode.window.showInformationMessage('Debug bootstrap removed.');
      } catch (err) {
        logError('[Teardown] Failed', err);
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Teardown failed: ${msg}`);
      }
    }
  );

  // Command: Find processes
  const findCmd = vscode.commands.registerCommand(
    'djangoProcessDebugger.findDjangoProcesses',
    async () => {
      log('Command: findDjangoProcesses');
      const processes = await processFinder.findDjangoProcesses();
      log(`Found ${processes.length} Django process(es)`);
      if (processes.length === 0) {
        vscode.window.showInformationMessage('No running Django processes found.');
        return [];
      }
      return processes;
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

      try {
        await ensureDebugpy(processes[0].pythonPath);
      } catch (err) {
        logError('Failed to prepare bundled debugpy', err);
        vscode.window.showErrorMessage(
          'Failed to prepare debugpy. Run "Django Debugger: Setup" first.',
          'Run Setup', 'Show Logs',
        ).then((c) => {
          if (c === 'Run Setup') {
            vscode.commands.executeCommand('djangoProcessDebugger.setup');
          } else if (c === 'Show Logs') { getLogger().show(); }
        });
        return;
      }

      const items = processes.map((p) => ({
        label: `PID: ${p.pid}`,
        description: p.command,
        detail: `Python: ${p.pythonPath}`,
        process: p,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a Django process to attach debugger',
      });

      if (!selected) {
        log('User cancelled process selection');
        return;
      }

      const pid = selected.process.pid;
      const port = await findFreePort();
      log(`Attaching to PID=${pid} on port=${port}`);

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
            `Debug bootstrap is not installed in the target venv. ` +
            `Run "Setup" first, then restart your Django server.`,
            'Run Setup', 'Show Logs',
          );
          if (choice === 'Run Setup') {
            await vscode.commands.executeCommand('djangoProcessDebugger.setup');
          } else if (choice === 'Show Logs') { getLogger().show(); }
        } else if (err instanceof BootstrapNotLoadedError) {
          vscode.window.showErrorMessage(
            `Bootstrap is installed but the process hasn't loaded it. ` +
            `Restart your Django server and try again.`,
            'Show Logs',
          ).then((c) => { if (c === 'Show Logs') { getLogger().show(); } });
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(
            `Debugger attach failed: ${msg}`, 'Show Logs',
          ).then((c) => { if (c === 'Show Logs') { getLogger().show(); } });
        }
        return;
      }

      log(`Starting debug session for PID=${pid}`);

      // Use our own debug type — connects directly to debugpy DAP server
      const debugConfig: vscode.DebugConfiguration = {
        type: 'django-process',
        request: 'attach',
        name: `Django (PID: ${pid})`,
        host: '127.0.0.1',
        port: debugPort,
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

      if (!started) {
        removeLock();
        vscode.window.showErrorMessage(
          'Failed to start debug session. Check logs for details.',
          'Show Logs',
        ).then((c) => { if (c === 'Show Logs') { getLogger().show(); } });
      }
    }
  );

  // Debug session lifecycle logging
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      log(`[DebugSession] Started: ${session.name} (type=${session.type})`);
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      log(`[DebugSession] Terminated: ${session.name}`);
      if (session.type === 'django-process') {
        removeLock();
        log('[DebugSession] Lock file removed');
      }
    }),
  );

  context.subscriptions.push(factory, tracker, findCmd, attachCmd, setupCmd, teardownCmd, getLogger());
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
