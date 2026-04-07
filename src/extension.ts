import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
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

  async function findVenvPythons(): Promise<{ pythonPath: string; source: string }[]> {
    const results: { pythonPath: string; source: string }[] = [];
    const seen = new Set<string>();

    const addIfExists = async (pythonPath: string, source: string) => {
      // Resolve symlinks to avoid duplicates
      let resolved = pythonPath;
      try {
        resolved = await fsPromises.realpath(pythonPath);
      } catch { /* use original */ }
      if (seen.has(resolved)) { return; }
      try {
        await fsPromises.access(pythonPath);
        seen.add(resolved);
        results.push({ pythonPath, source });
      } catch { /* not found */ }
    };

    const home = os.homedir();
    const venvNames = ['.venv', 'venv', '.virtualenv', 'env', '.env'];

    // 1. Workspace venv directories
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = folder.uri.fsPath;
      for (const venvName of venvNames) {
        await addIfExists(path.join(root, venvName, 'bin', 'python'), `${folder.name}/${venvName}`);
      }
    }

    // 2. Sibling project directories
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const parentDir = path.dirname(folder.uri.fsPath);
      try {
        const siblings = await fsPromises.readdir(parentDir);
        for (const sibling of siblings) {
          if (sibling === path.basename(folder.uri.fsPath)) { continue; }
          const siblingPath = path.join(parentDir, sibling);
          for (const venvName of ['.venv', 'venv']) {
            await addIfExists(path.join(siblingPath, venvName, 'bin', 'python'), `../${sibling}/${venvName}`);
          }
        }
      } catch { /* can't read parent */ }
    }

    // 3. asdf Python versions
    const asdfDir = path.join(home, '.asdf', 'installs', 'python');
    try {
      const versions = await fsPromises.readdir(asdfDir);
      for (const ver of versions) {
        await addIfExists(path.join(asdfDir, ver, 'bin', 'python3'), `asdf: ${ver}`);
      }
    } catch { /* not found */ }

    // 4. pyenv Python versions
    const pyenvDir = process.env.PYENV_ROOT
      ? path.join(process.env.PYENV_ROOT, 'versions')
      : path.join(home, '.pyenv', 'versions');
    try {
      const versions = await fsPromises.readdir(pyenvDir);
      for (const ver of versions) {
        await addIfExists(path.join(pyenvDir, ver, 'bin', 'python3'), `pyenv: ${ver}`);
        // pyenv virtualenvs
        await addIfExists(path.join(pyenvDir, ver, 'bin', 'python'), `pyenv: ${ver}`);
      }
    } catch { /* not found */ }

    // 5. conda environments
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
          await addIfExists(path.join(condaDir, env, 'bin', 'python'), `conda: ${env}`);
        }
      } catch { /* not found */ }
    }

    // 6. Poetry virtualenvs
    const poetryDirs = [
      path.join(home, 'Library', 'Caches', 'pypoetry', 'virtualenvs'),  // macOS
      path.join(home, '.cache', 'pypoetry', 'virtualenvs'),              // Linux
    ];
    for (const poetryDir of poetryDirs) {
      try {
        const entries = await fsPromises.readdir(poetryDir);
        for (const entry of entries) {
          await addIfExists(path.join(poetryDir, entry, 'bin', 'python'), `poetry: ${entry}`);
        }
      } catch { /* not found */ }
    }

    // 7. pipenv virtualenvs
    const pipenvDirs = [
      path.join(home, '.local', 'share', 'virtualenvs'),
    ];
    for (const pipenvDir of pipenvDirs) {
      try {
        const entries = await fsPromises.readdir(pipenvDir);
        for (const entry of entries) {
          await addIfExists(path.join(pipenvDir, entry, 'bin', 'python'), `pipenv: ${entry}`);
        }
      } catch { /* not found */ }
    }

    // 8. Homebrew Python
    for (const brewPrefix of ['/opt/homebrew', '/usr/local']) {
      await addIfExists(path.join(brewPrefix, 'bin', 'python3'), `homebrew`);
    }

    return results;
  }

  async function detectPythonPath(): Promise<string | undefined> {
    const items: (vscode.QuickPickItem & { pythonPath?: string })[] = [];
    const seen = new Set<string>();

    // 1. Running Django processes
    const processes = await processFinder.findDjangoProcesses();
    for (const p of processes) {
      if (!seen.has(p.pythonPath)) {
        seen.add(p.pythonPath);
        const portLabel = p.port ? `:${p.port}` : '';
        items.push({
          label: `$(play) ${p.pythonPath}`,
          description: `Running ${p.type}${portLabel} (PID ${p.pid})`,
          pythonPath: p.pythonPath,
        });
      }
    }

    // 2. Discovered venvs
    const venvs = await findVenvPythons();
    for (const v of venvs) {
      if (!seen.has(v.pythonPath)) {
        seen.add(v.pythonPath);
        items.push({
          label: `$(folder) ${v.pythonPath}`,
          description: v.source,
          pythonPath: v.pythonPath,
        });
      }
    }

    // 3. VS Code Python extension's selected interpreter
    try {
      const pyExt = vscode.extensions.getExtension('ms-python.python');
      if (pyExt?.isActive) {
        const execDetails = await vscode.commands.executeCommand<{ path?: string[] }>(
          'python.interpreterPath',
          { workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.toString() },
        );
        // The command may return a string directly in some versions
        const pyPath = typeof execDetails === 'string'
          ? execDetails
          : (execDetails as { path?: string[] })?.path?.[0];
        if (pyPath && !seen.has(pyPath)) {
          seen.add(pyPath);
          items.push({
            label: `$(symbol-misc) ${pyPath}`,
            description: 'VS Code selected interpreter',
            pythonPath: pyPath,
          });
        }
      }
    } catch { /* extension not available */ }

    // Separator + browse
    if (items.length > 0) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }
    items.push({
      label: '$(file-directory) Browse...',
      description: 'Select Python executable from file browser',
      alwaysShow: true,
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select Python interpreter',
      matchOnDescription: true,
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

    const result = (selected as { pythonPath?: string }).pythonPath ?? selected.label;
    log(`User selected python: ${result}`);
    return result;
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

      const items = await Promise.all(processes.map(async (p) => {
        const icon = p.type === 'celery' ? '$(server-process)' : '$(globe)';
        const typeLabel = p.type === 'celery' ? 'Celery Worker' : 'Django Server';
        const activePort = await injector.getActivePort(p.pid);
        const portStatus = activePort
          ? `$(debug-alt) Port ${activePort} — debugpy active`
          : '$(circle-slash) debugpy not attached';
        const portLabel = p.port ? ` | Port: ${p.port}` : '';
        return {
          label: `${icon} [${typeLabel}] PID: ${p.pid}${portLabel}`,
          description: p.command,
          detail: `${portStatus}  |  Python: ${p.pythonPath}`,
          process: p,
        };
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
      const justMyCode = vscode.workspace.getConfiguration('djangoProcessDebugger').get<boolean>('justMyCode', true);
      const processType = selected.process.type;
      const sessionLabel = processType === 'celery' ? 'Celery Worker' : 'Django';
      const debugConfig: vscode.DebugConfiguration = {
        type: 'django-process',
        request: 'attach',
        name: `${sessionLabel} (PID: ${pid})`,
        host: '127.0.0.1',
        port: debugPort,
        justMyCode,
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

      const pythonPath = await detectPythonPath();
      if (!pythonPath) { return; }

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Reinstalling debugpy...' },
          async () => {
            const dir = await debugpyManager.reinstall(pythonPath);
            injector.setBundledDebugpyPath(dir);
          },
        );
        vscode.window.showInformationMessage(
          `debugpy reinstalled successfully using ${pythonPath}. Restart your Django server to apply.`
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

      // ── 3. Kill zombie language server & debugpy processes ──
      try {
        const { stdout } = await execFileAsync('ps', ['aux']);
        const lsPatterns = [
          /jedi[-_]language[-_]server/i,
          /pylance/i,
          /pyright/i,
          /python.*language.server/i,
        ];
        const killed: number[] = [];
        for (const line of stdout.split('\n')) {
          if (!lsPatterns.some((p) => p.test(line))) { continue; }
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[1], 10);
          if (isNaN(pid)) { continue; }
          try {
            process.kill(pid, 'SIGKILL');
            killed.push(pid);
            log(`[Clean] Killed PID=${pid}: ${parts.slice(10).join(' ')}`);
          } catch { /* already dead */ }
        }
        if (killed.length > 0) {
          actions.push(`Killed ${killed.length} language server process(es): PID ${killed.join(', ')}`);
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

      // ── 7. Re-sign Python binaries (macOS code signature recovery) ──
      // Repeated Python crashes (caused by bad bootstrap) can trigger macOS
      // AppleSystemPolicy to block the binary. Re-signing with ad-hoc signature fixes it.
      if (process.platform === 'darwin') {
        const pythonBinaries = new Set<string>();
        const home = os.homedir();

        const collectBinaries = async (dir: string) => {
          try {
            const files = await fsPromises.readdir(dir);
            for (const f of files) {
              if (/^python3?(\.\d+)*$/.test(f)) {
                try {
                  const realPath = await fsPromises.realpath(path.join(dir, f));
                  pythonBinaries.add(realPath);
                } catch { /* broken symlink */ }
              }
            }
          } catch { /* dir not found */ }
        };

        // Workspace venvs
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
          for (const venvName of ['.venv', 'venv', '.virtualenv', 'env']) {
            await collectBinaries(path.join(folder.uri.fsPath, venvName, 'bin'));
          }
        }

        // Version managers: asdf, pyenv
        const versionManagerDirs = [
          path.join(home, '.asdf', 'installs', 'python'),
          process.env.PYENV_ROOT
            ? path.join(process.env.PYENV_ROOT, 'versions')
            : path.join(home, '.pyenv', 'versions'),
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

        // Verify & re-sign broken ones
        let resignCount = 0;
        for (const pyBin of pythonBinaries) {
          try {
            await execFileAsync('codesign', ['--verify', pyBin], { timeout: 5_000 });
          } catch {
            try {
              await execFileAsync('codesign', ['--force', '--sign', '-', pyBin], { timeout: 5_000 });
              resignCount++;
              log(`[Clean] Re-signed: ${pyBin}`);
            } catch (err) {
              logError(`[Clean] Failed to re-sign ${pyBin}`, err);
            }
          }
        }
        if (resignCount > 0) {
          actions.push(`Re-signed ${resignCount} Python binary(ies)`);
        }
        log(`[Clean] Checked ${pythonBinaries.size} Python binaries, re-signed ${resignCount}`);
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

  context.subscriptions.push(factory, tracker, attachCmd, setupCmd, killCmd, reinstallCmd, cleanLsCmd, getLogger());
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
