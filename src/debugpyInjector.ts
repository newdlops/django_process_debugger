import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { log, logError } from './logger';

const execFileAsync = promisify(execFile);

const PTH_FILENAME = 'django_process_debugger.pth';
const BOOTSTRAP_MODULE = '_django_debug_bootstrap';

/**
 * Bootstrap script installed into the target venv's site-packages.
 * Installs a SIGUSR1 handler that starts debugpy on demand.
 *
 * The bundled debugpy path is read from a companion config file
 * so we don't need env vars.
 */
/**
 * Port file path: the extension writes the desired port here before
 * sending SIGUSR1. The bootstrap reads it to know which port to listen on.
 * Using a file avoids the problem of not being able to set env vars on
 * an already-running process.
 */
const PORT_FILE_DIR = '/tmp/django-process-debugger';
function portFilePath(pid: number): string {
  return `${PORT_FILE_DIR}/${pid}.port`;
}

function makeBootstrapScript(bundledDebugpyPath: string): string {
  // Build Python source as plain string concatenation to avoid
  // JS template literal ${} clashing with Python f-string {}.
  //
  // SAFETY: The entire module is wrapped in try/except so that
  // a failure here NEVER kills the host Python process (pip, jedi, tests, etc.).
  // The .pth file runs this on every Python startup in the venv.
  const lines = [
    'try:',
    '    import sys as _sys',
    '    import os as _os',
    '',
    '    def _is_target_process():',
    '        """Strict check: only match long-running server processes, not tools."""',
    '        # Skip non-main scripts (pip, jedi, pytest, etc.)',
    '        _exe = _os.path.basename(_sys.executable).lower()',
    '        _blocked = ("pip", "jedi", "pylance", "pyright", "pytest", "mypy", "ruff", "black", "isort")',
    '        if any(_b in _exe for _b in _blocked):',
    '            return False',
    '        _cmd = " ".join(_sys.argv).lower()',
    '        # Block tool commands that happen to contain target words',
    '        _blocked_cmds = (',
    '            "-m pip", "-m pytest", "-m jedi", "-m pylint", "-m mypy",',
    '            "-m black", "-m isort", "-m ruff", "language-server", "language_server",',
    '            "site-packages", "setup.py", "pyproject.toml",',
    '        )',
    '        if any(_b in _cmd for _b in _blocked_cmds):',
    '            return False',
    '        # Only match known server process patterns',
    '        _server_patterns = [',
    '            "manage.py runserver",',
    '            "manage.py run_huey",',
    '            "uvicorn ",',
    '            "gunicorn ",',
    '            "daphne ",',
    '            "celery worker",',
    '            "-m celery worker",',
    '        ]',
    '        return any(_p in _cmd for _p in _server_patterns)',
    '',
    '    if _is_target_process():',
    '        import signal as _signal',
    '        import traceback as _traceback',
    '',
    '        _PORT_FILE_DIR = ' + JSON.stringify(PORT_FILE_DIR),
    '        _LOG_FILE = _PORT_FILE_DIR + "/bootstrap.log"',
    '',
    '        def _dbg_log(msg):',
    '            try:',
    '                with open(_LOG_FILE, "a") as _f:',
    '                    _f.write(f"[PID {_os.getpid()}] {msg}\\n")',
    '            except Exception:',
    '                pass',
    '',
    '        _dbg_log("Bootstrap module loaded, installing signal handlers")',
    '',
    '        def _django_debugger_signal_handler(signum, frame):',
    '            _dbg_log(f"Signal {signum} received")',
    '            _active_file = f"{_PORT_FILE_DIR}/{_os.getpid()}.active"',
    '            try:',
    '                with open(_active_file) as _f:',
    '                    _existing_port = _f.read().strip()',
    '                _dbg_log(f"debugpy already active on port {_existing_port}, skipping")',
    '                return',
    '            except FileNotFoundError:',
    '                pass',
    '            _bundled = ' + JSON.stringify(bundledDebugpyPath),
    '            if _bundled and _bundled not in _sys.path:',
    '                _sys.path.insert(0, _bundled)',
    '                _dbg_log(f"Added bundled path: {_bundled}")',
    '            try:',
    '                import debugpy',
    '                _dbg_log(f"debugpy imported from {debugpy.__file__}")',
    '                _port_file = f"{_PORT_FILE_DIR}/{_os.getpid()}.port"',
    '                _port = 5678',
    '                try:',
    '                    with open(_port_file) as _f:',
    '                        _port = int(_f.read().strip())',
    '                    _os.unlink(_port_file)',
    '                    _dbg_log(f"Read port {_port} from {_port_file}")',
    '                except FileNotFoundError:',
    '                    _dbg_log(f"Port file not found, using default {_port}")',
    '                except ValueError as ve:',
    '                    _dbg_log(f"Bad port file content: {ve}")',
    '                debugpy.listen(("127.0.0.1", _port))',
    '                with open(_active_file, "w") as _f:',
    '                    _f.write(str(_port))',
    '                _dbg_log(f"debugpy listening on 127.0.0.1:{_port}")',
    '            except RuntimeError as e:',
    '                if "already" in str(e).lower():',
    '                    _dbg_log(f"debugpy already listening: {e}")',
    '                else:',
    '                    _dbg_log(f"RuntimeError: {e}\\n{_traceback.format_exc()}")',
    '            except Exception as e:',
    '                _dbg_log(f"ERROR: {e}\\n{_traceback.format_exc()}")',
    '',
    '        _signal.signal(_signal.SIGUSR1, _django_debugger_signal_handler)',
    '        _signal.signal(_signal.SIGUSR2, _django_debugger_signal_handler)',
    '        _dbg_log("SIGUSR1+SIGUSR2 handlers installed")',
    '',
    'except Exception:',
    '    # NEVER let bootstrap errors propagate — this runs on every Python startup',
    '    pass',
    '',
  ];
  return lines.join('\n');
}

/**
 * .pth file content — Python executes lines starting with "import" in .pth
 * files during site-packages initialization.
 */
const PTH_CONTENT = `import ${BOOTSTRAP_MODULE}\n`;

export class DebugpyInjector {
  private bundledDebugpyPath: string | null = null;

  setBundledDebugpyPath(dir: string): void {
    this.bundledDebugpyPath = dir;
    log(`[Injector] Bundled debugpy path set to: ${dir}`);
  }

  /**
   * Install the debug bootstrap into a venv's site-packages.
   * This makes ALL Python processes using this venv load the SIGUSR1 handler.
   * Requires restarting the Django server after installation.
   */
  async installBootstrap(venvSitePackages: string): Promise<void> {
    if (!this.bundledDebugpyPath) {
      throw new Error('Bundled debugpy path not set');
    }

    // Safety: refuse to install into global/system site-packages
    // Only allow venv or virtualenv directories (contain bin/activate or pyvenv.cfg)
    const parentDir = path.resolve(venvSitePackages, '..', '..', '..');
    const isVenv = await this.isVenvDir(parentDir);
    if (!isVenv) {
      log(`[Injector] WARNING: ${venvSitePackages} does not appear to be inside a virtualenv (checked ${parentDir})`);
      throw new Error(
        `Refusing to install bootstrap into non-venv site-packages: ${venvSitePackages}. ` +
        `This would affect ALL Python processes using this interpreter. ` +
        `Please select a virtualenv Python instead.`
      );
    }

    const pthPath = path.join(venvSitePackages, PTH_FILENAME);
    const modulePath = path.join(venvSitePackages, `${BOOTSTRAP_MODULE}.py`);

    log(`[Injector] Installing bootstrap to ${venvSitePackages}`);
    log(`[Injector]   .pth file: ${pthPath}`);
    log(`[Injector]   module: ${modulePath}`);

    await fs.writeFile(modulePath, makeBootstrapScript(this.bundledDebugpyPath), 'utf-8');
    await fs.writeFile(pthPath, PTH_CONTENT, 'utf-8');

    log(`[Injector] Bootstrap installed successfully`);
  }

  private async isVenvDir(dir: string): Promise<boolean> {
    // Check for pyvenv.cfg (standard venv marker) or bin/activate (virtualenv marker)
    for (const marker of ['pyvenv.cfg', path.join('bin', 'activate')]) {
      try {
        await fs.access(path.join(dir, marker));
        return true;
      } catch {
        // continue
      }
    }
    return false;
  }

  /**
   * Remove the debug bootstrap from a venv's site-packages.
   */
  async uninstallBootstrap(venvSitePackages: string): Promise<void> {
    const pthPath = path.join(venvSitePackages, PTH_FILENAME);
    const modulePath = path.join(venvSitePackages, `${BOOTSTRAP_MODULE}.py`);

    for (const f of [pthPath, modulePath]) {
      try {
        await fs.unlink(f);
        log(`[Injector] Removed: ${f}`);
      } catch {
        // already gone
      }
    }
  }

  /**
   * Check if the bootstrap is installed in a venv.
   */
  async isBootstrapInstalled(venvSitePackages: string): Promise<boolean> {
    try {
      await fs.access(path.join(venvSitePackages, PTH_FILENAME));
      await fs.access(path.join(venvSitePackages, `${BOOTSTRAP_MODULE}.py`));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the site-packages directory for a venv from a running process's
   * python path.
   */
  async resolveSitePackages(pythonPath: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(pythonPath, [
        '-c',
        'import site; print(site.getsitepackages()[0])',
      ]);
      const dir = stdout.trim();
      log(`[Injector] Resolved site-packages: ${dir}`);
      return dir;
    } catch (err) {
      logError(`[Injector] Failed to resolve site-packages for ${pythonPath}`, err);
      // Fallback: guess from pythonPath
      // e.g. /path/to/.venv/bin/python3 -> /path/to/.venv/lib/python3.X/site-packages
      const venvDir = path.resolve(path.dirname(pythonPath), '..');
      const libDir = path.join(venvDir, 'lib');
      try {
        const entries = await fs.readdir(libDir);
        const pyDir = entries.find((e) => e.startsWith('python'));
        if (pyDir) {
          return path.join(libDir, pyDir, 'site-packages');
        }
      } catch {
        // ignore
      }
      throw new Error(`Could not determine site-packages for ${pythonPath}`);
    }
  }

  /**
   * Resolve the python path from a running process PID.
   */
  async resolvePythonForPid(pid: number): Promise<string> {
    try {
      const { stdout } = await execFileAsync('ps', [
        '-p', String(pid), '-o', 'command=',
      ]);
      const fullCmd = stdout.trim();
      log(`[Injector] ps output for PID=${pid}: ${fullCmd}`);
      const match = fullCmd.match(/^(\S*python\S*)/);
      return match ? match[1] : 'python3';
    } catch (err) {
      logError(`[Injector] Failed to resolve python path for PID=${pid}`, err);
      return 'python3';
    }
  }

  /**
   * Verify the bootstrap is loaded in the target process by checking
   * if the module is importable from the process's python.
   * This prevents sending SIGUSR1 to an unprotected process (which would kill it).
   */
  async verifyBootstrapLoaded(pythonPath: string): Promise<boolean> {
    try {
      await execFileAsync(pythonPath, [
        '-c', `import ${BOOTSTRAP_MODULE}`,
      ], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if debugpy is already active for a given PID.
   * Returns the port if active, null otherwise.
   */
  async getActivePort(pid: number): Promise<number | null> {
    const activeFile = path.join(PORT_FILE_DIR, `${pid}.active`);
    try {
      const content = await fs.readFile(activeFile, 'utf-8');
      const port = parseInt(content.trim(), 10);
      if (!isNaN(port) && await this.isPortListening(port)) {
        return port;
      }
      // Stale active file — debugpy no longer listening
      await fs.unlink(activeFile).catch(() => {});
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Activate debugpy in a running Django process by sending SIGUSR1.
   * Returns the port debugpy is listening on.
   *
   * If debugpy is already active, returns the existing port.
   * SAFETY: Will NOT send SIGUSR1 unless the bootstrap module is confirmed
   * importable, because Python's default SIGUSR1 handler terminates the process.
   */
  async activate(pid: number, port: number): Promise<number> {
    log(`[Injector] Activating debugpy for PID=${pid} port=${port}`);

    this.verifyProcessAlive(pid);
    log(`[Injector] Process ${pid} is alive`);

    // Check if debugpy is already active for this PID
    const existingPort = await this.getActivePort(pid);
    if (existingPort !== null) {
      log(`[Injector] debugpy already active for PID=${pid} on port ${existingPort}`);
      return existingPort;
    }

    // SAFETY: Verify bootstrap is installed before sending SIGUSR1
    const pythonPath = await this.resolvePythonForPid(pid);
    const bootstrapReady = await this.verifyBootstrapLoaded(pythonPath);
    if (!bootstrapReady) {
      log(`[Injector] Bootstrap module not importable from ${pythonPath}`);
      throw new BootstrapNotInstalledError(pid);
    }
    log(`[Injector] Bootstrap module verified as importable`);

    // Write the desired port to a file the bootstrap will read
    await fs.mkdir(PORT_FILE_DIR, { recursive: true });
    await fs.writeFile(portFilePath(pid), String(port), 'utf-8');
    log(`[Injector] Wrote port file: ${portFilePath(pid)} = ${port}`);

    // Determine which signal to send: celery overrides SIGUSR1 for log reopen,
    // so we use SIGUSR2 for celery workers and SIGUSR1 for everything else.
    const command = await this.getProcessCommand(pid);
    const isCelery = /celery\s+.*worker|-m\s+celery\s+worker/.test(command);
    const signal = isCelery ? 'SIGUSR2' : 'SIGUSR1';

    log(`[Injector] Sending ${signal} to PID=${pid} (${isCelery ? 'celery' : 'django'})`);
    try {
      process.kill(pid, signal);
    } catch (err) {
      logError(`[Injector] Failed to send ${signal} to PID=${pid}`, err);
      throw new SignalError(pid, err instanceof Error ? err : new Error(String(err)));
    }

    // Wait for debugpy to start listening (via lsof, non-invasive)
    log(`[Injector] Waiting for debugpy to listen on port ${port}...`);
    const listening = await this.waitForPortListening(port, 5000);
    if (!listening) {
      log(`[Injector] Port ${port} not open after SIGUSR1`);
      throw new BootstrapNotLoadedError(pid, port);
    }
    log(`[Injector] debugpy is listening on port ${port}`);
    return port;
  }

  private async getProcessCommand(pid: number): Promise<string> {
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
      return stdout.trim();
    } catch {
      return '';
    }
  }

  private verifyProcessAlive(pid: number): void {
    try {
      process.kill(pid, 0);
    } catch {
      throw new ProcessNotFoundError(pid);
    }
  }

  /**
   * Check if a port is being listened on WITHOUT connecting to it.
   * Uses lsof to avoid consuming debugpy's single-client slot.
   */
  async isPortListeningPublic(port: number): Promise<boolean> {
    return this.isPortListening(port);
  }

  private async isPortListening(port: number): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('lsof', [
        '-i', `TCP:${port}`, '-sTCP:LISTEN', '-P', '-n',
      ]);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Wait for a port to start listening, checked via lsof (non-invasive).
   */
  private async waitForPortListening(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isPortListening(port)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }
}

export class ProcessNotFoundError extends Error {
  constructor(public readonly pid: number) {
    super(`Process ${pid} does not exist or has already exited.`);
    this.name = 'ProcessNotFoundError';
  }
}

export class SignalError extends Error {
  constructor(
    public readonly pid: number,
    public readonly cause: Error,
  ) {
    super(`Failed to send SIGUSR1 to PID ${pid}: ${cause.message}`);
    this.name = 'SignalError';
  }
}

export class BootstrapNotInstalledError extends Error {
  constructor(public readonly pid: number) {
    super(
      `Debug bootstrap is not installed in the target venv. ` +
      `Run "Django Debugger: Setup" first, then restart your Django server.`
    );
    this.name = 'BootstrapNotInstalledError';
  }
}

export class BootstrapNotLoadedError extends Error {
  constructor(
    public readonly pid: number,
    public readonly port: number,
  ) {
    super(
      `Sent SIGUSR1 to PID ${pid} but debugpy did not start listening on port ${port}. ` +
      `The Django process was likely not started with the debug bootstrap loaded.`
    );
    this.name = 'BootstrapNotLoadedError';
  }
}
