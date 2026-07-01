import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { log, logError } from './logger';
import {
  TcpListeningEndpoint,
  formatEndpoint,
  normalizeListeningHost,
  parseLsofTcpListenLine,
} from './listeningEndpoint';

const execFileAsync = promisify(execFile);

const PTH_FILENAME = 'django_process_debugger.pth';
const BOOTSTRAP_MODULE = '_django_debug_bootstrap';
export const BOOTSTRAP_VERSION = '2026.07.01.1';
export type DebugpyEndpoint = TcpListeningEndpoint;

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

function reloadFilePath(pid: number): string {
  return `${PORT_FILE_DIR}/${pid}.reload`;
}

function reloadResultFilePath(pid: number): string {
  return `${PORT_FILE_DIR}/${pid}.reload.result`;
}

function makeBootstrapScript(bundledDebugpyPath: string): string {
  // Build Python source as plain string concatenation to avoid
  // JS template literal ${} clashing with Python f-string {}.
  //
  // SAFETY: The entire module is wrapped in try/except so that
  // a failure here NEVER kills the host Python process (pip, jedi, tests, etc.).
  // The .pth file runs this on every Python startup in the venv.
  const lines = [
    `# django-process-debugger bootstrap ${BOOTSTRAP_VERSION}`,
    'try:',
    '    import sys as _sys',
    '    import os as _os',
    '',
    '    def _is_target_process():',
    '        """Match long-running server processes only, never tools.',
    '',
    '        Runs at site/.pth init time. For `python -m pkg ...` the',
    '        interpreter rewrites sys.argv to ["-m", <args>] with the module',
    '        name (celery/uvicorn/...) stripped and argv[0] == "-m", so',
    '        sys.argv alone can never see "celery". sys.orig_argv (Py3.10+)',
    '        preserves the real command line, so inspect that when present."""',
    '        _exe = _os.path.basename(_sys.executable).lower()',
    '        _blocked = ("pip", "jedi", "pylance", "pyright", "pytest", "mypy", "ruff", "black", "isort")',
    '        if any(_b in _exe for _b in _blocked):',
    '            return False',
    '        _orig = getattr(_sys, "orig_argv", None) or _sys.argv',
    '        _parts = [str(_a).lower() for _a in _orig]',
    '        _argv0 = _parts[0] if _parts else ""',
    '        _cmd = " ".join(_parts)',
    '        # Block tool commands. With orig_argv the "-m pip"/"-m pytest"',
    '        # form is intact, so these match as written.',
    '        _blocked_cmds = (',
    '            "-m pip", "-m pytest", "-m jedi", "-m pylint", "-m mypy",',
    '            "-m black", "-m isort", "-m ruff", "language-server", "language_server",',
    '            "setup.py", "pyproject.toml",',
    '        )',
    '        if any(_b in _cmd for _b in _blocked_cmds):',
    '            return False',
    '        # Celery worker: `python -m celery [-A app] worker ...` or the',
    '        # `celery` console script. The module name and the `worker`',
    '        # subcommand may be separated by options (-A app), so test for',
    '        # both tokens rather than a fixed "celery worker" substring.',
    '        if "worker" in _parts and ("celery" in _parts or _os.path.basename(_argv0) == "celery"):',
    '            return True',
    '        # Fallback for Python < 3.10 (no orig_argv): a `-m <pkg> worker`',
    '        # invocation arrives as argv == ["-m", "worker", ...].',
    '        if _argv0 == "-m" and "worker" in _parts:',
    '            return True',
    '        # Other long-running servers (script form, or "<name> " in cmd).',
    '        _server_patterns = (',
    '            "manage.py runserver",',
    '            "manage.py run_huey",',
    '            "uvicorn ",',
    '            "gunicorn ",',
    '            "daphne ",',
    '        )',
    '        if any(_p in _cmd for _p in _server_patterns):',
    '            return True',
    '        # ASGI/WSGI servers launched via `-m` (bare tokens in argv).',
    '        if "-m" in _parts and any(_s in _parts for _s in ("uvicorn", "gunicorn", "daphne")):',
    '            return True',
    '        return False',
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
    '        _hot_reload_watcher_started = False',
    '',
    '        # Persistent storage: keeps references to the ORIGINAL functions',
    '        # (before any reload) so we always patch the ones Django actually calls.',
    '        # Keyed by module name -> {co_qualname: function_object}.',
    '        _original_mod_funcs = {}',
    '',
    '        def _start_hot_reload_watcher():',
    '            """Start a daemon thread that watches for module reload requests."""',
    '            import threading',
    '            import importlib',
    '            import time',
    '',
    '            _pid = _os.getpid()',
    '            _reload_file = f"{_PORT_FILE_DIR}/{_pid}.reload"',
    '            _reload_result_file = f"{_PORT_FILE_DIR}/{_pid}.reload.result"',
    '',
    '            # ── Suppress Django autoreloader restarts (multi-layer) ──',
    '            #',
    '            # Django restart flow: StatReloader.tick() detects mtime change',
    '            #   → notify_file_changed(path)',
    '            #   → file_changed signal dispatch',
    '            #   → trigger_reload(path)  (if no handler returns True)',
    '            #   → sys.exit(3)',
    '            #   → parent process restarts child',
    '            #',
    '            # We suppress at TWO layers for robustness:',
    '            #   1. file_changed signal handler returning True (Django built-in extension point)',
    '            #   2. Patch trigger_reload() as belt-and-suspenders',
    '',
    '            # Layer 1: file_changed signal — returning True prevents trigger_reload()',
    '            try:',
    '                from django.utils.autoreload import file_changed as _file_changed_signal',
    '                def _suppress_autoreload(sender, file_path, **kwargs):',
    '                    _dbg_log(f"Autoreload suppressed (signal): {file_path}")',
    '                    return True',
    '                _file_changed_signal.connect(_suppress_autoreload)',
    '                _dbg_log("Django file_changed signal handler registered")',
    '            except Exception as _e:',
    '                _dbg_log(f"Could not register file_changed handler: {_e}")',
    '',
    '            # Layer 2: patch trigger_reload() to prevent sys.exit(3)',
    '            try:',
    '                import django.utils.autoreload as _autoreload_mod',
    '                def _suppressed_trigger_reload(filename):',
    '                    _dbg_log(f"Autoreload suppressed (trigger_reload): {filename}")',
    '                _autoreload_mod.trigger_reload = _suppressed_trigger_reload',
    '                _dbg_log("Django trigger_reload patched")',
    '            except Exception as _e:',
    '                _dbg_log(f"Could not patch trigger_reload: {_e}")',
    '',
    '            def _deep_reload_module(_mod):',
    '                """Reload _mod and swap __code__ on ALL function objects that',
    '                live in _mod.__file__, including those only reachable through',
    '                decorator wrapper closures.',
    '',
    '                Why not just follow __wrapped__? Decorators that skip',
    '                @functools.wraps do not set __wrapped__, so the chain breaks',
    '                before reaching the user function — the wrapper body gets',
    '                the new bytes but the inner call targets the stale closure',
    '                cell, and a change like `print("ffff")` -> `print("dddd")`',
    '                simply does not take effect. Instead we:',
    '',
    '                  1. Walk everything reachable from mod.__dict__ via',
    '                     __wrapped__ AND __closure__ cells. Any function whose',
    '                     __code__.co_filename matches mod.__file__ belongs to',
    '                     this module regardless of where the outer wrapper',
    '                     was defined.',
    '                  2. Index those functions by co_qualname so we can pair',
    '                     OLD and NEW counterparts even if the decorator chain',
    '                     reshapes the object graph.',
    '                  3. Patch OLD.__code__ / __defaults__ / __kwdefaults__ /',
    '                     __dict__ from the matching NEW function.',
    '',
    '                Externally held references (Django URL conf, GraphQL schema,',
    '                Celery task registry, ...) keep the SAME function object,',
    '                but the next call dispatches through the fresh bytecode."""',
    '                import types',
    '                import os',
    '',
    '                _mod_name = _mod.__name__',
    '                _mod_file = getattr(_mod, "__file__", None)',
    '                _mod_real = None',
    '                if _mod_file:',
    '                    try:',
    '                        _mod_real = os.path.realpath(_mod_file)',
    '                    except Exception:',
    '                        _mod_real = _mod_file',
    '',
    '                def _code_key(_code):',
    '                    # co_qualname (Py3.11+) uniquely identifies functions',
    '                    # within a file; fall back to co_name on older runtimes.',
    '                    _qn = getattr(_code, "co_qualname", None)',
    '                    return _qn if _qn else _code.co_name',
    '',
    '                def _is_in_this_file(_code):',
    '                    if _mod_real is None:',
    '                        return False',
    '                    _f = getattr(_code, "co_filename", None)',
    '                    if not _f:',
    '                        return False',
    '                    try:',
    '                        return os.path.realpath(_f) == _mod_real',
    '                    except Exception:',
    '                        return _f == _mod_file',
    '',
    '                def _walk_reachable(_start_values):',
    '                    """Yield every FunctionType object reachable from the',
    '                    given iterable via __wrapped__ chains, closure cells,',
    '                    and class __dict__ members. id()-tracked to avoid cycles."""',
    '                    _seen = set()',
    '                    _stack = list(_start_values)',
    '                    while _stack:',
    '                        _obj = _stack.pop()',
    '                        if id(_obj) in _seen:',
    '                            continue',
    '                        _seen.add(id(_obj))',
    '                        if isinstance(_obj, types.FunctionType):',
    '                            yield _obj',
    '                            _w = getattr(_obj, "__wrapped__", None)',
    '                            if _w is not None:',
    '                                _stack.append(_w)',
    '                            _cl = getattr(_obj, "__closure__", None)',
    '                            if _cl:',
    '                                for _cell in _cl:',
    '                                    try:',
    '                                        _stack.append(_cell.cell_contents)',
    '                                    except ValueError:',
    '                                        pass',
    '                        elif isinstance(_obj, type):',
    '                            for _mobj in list(_obj.__dict__.values()):',
    '                                if isinstance(_mobj, types.FunctionType):',
    '                                    _stack.append(_mobj)',
    '                                elif isinstance(_mobj, (classmethod, staticmethod)):',
    '                                    _inner = getattr(_mobj, "__func__", None)',
    '                                    if _inner is not None:',
    '                                        _stack.append(_inner)',
    '                                elif isinstance(_mobj, property):',
    '                                    for _acc in (_mobj.fget, _mobj.fset, _mobj.fdel):',
    '                                        if _acc is not None:',
    '                                            _stack.append(_acc)',
    '',
    '                def _index_module_functions(_target_mod):',
    '                    """Return {co_qualname: function_object} for functions',
    '                    reachable from _target_mod.__dict__ whose code is in',
    '                    this module file."""',
    '                    _idx = {}',
    '                    for _fn in _walk_reachable(list(_target_mod.__dict__.values())):',
    '                        _c = _fn.__code__',
    '                        if not _is_in_this_file(_c):',
    '                            continue',
    '                        _idx.setdefault(_code_key(_c), _fn)',
    '                    return _idx',
    '',
    '                # First reload: capture ORIGINAL function refs (the ones',
    '                # Django/GraphQL/Celery registered at import time) keyed by',
    '                # co_qualname. Subsequent reloads keep patching these same',
    '                # objects in place.',
    '                if _mod_name not in _original_mod_funcs:',
    '                    _original_mod_funcs[_mod_name] = _index_module_functions(_mod)',
    '                    _dbg_log(',
    '                        f"Captured {len(_original_mod_funcs[_mod_name])} original fn refs "',
    '                        f"for {_mod_name}"',
    '                    )',
    '',
    '                # Reload source — creates NEW code objects and rebinds the',
    '                # module attributes. External references still point at the',
    '                # OLD objects which we patched into _original_mod_funcs.',
    '                importlib.reload(_mod)',
    '',
    '                # Invalidate linecache so debugpy / traceback reads fresh',
    '                # source for the reloaded file.',
    '                try:',
    '                    import linecache',
    '                    linecache.checkcache()',
    '                    if _mod_file:',
    '                        linecache.checkcache(_mod_file)',
    '                except Exception as _e:',
    '                    _dbg_log(f"linecache invalidation failed for {_mod_name}: {_e}")',
    '',
    '                _new_fns = _index_module_functions(_mod)',
    '',
    '                # Pair OLD and NEW by co_qualname, swap __code__ in place.',
    '                _patched = []',
    '                _orig_map = _original_mod_funcs[_mod_name]',
    '                for _qn, _old_fn in list(_orig_map.items()):',
    '                    _new_fn = _new_fns.get(_qn)',
    '                    if _new_fn is None or _new_fn is _old_fn:',
    '                        continue',
    '                    try:',
    '                        _old_fn.__code__ = _new_fn.__code__',
    '                        _old_fn.__defaults__ = _new_fn.__defaults__',
    '                        _old_fn.__kwdefaults__ = getattr(_new_fn, "__kwdefaults__", None)',
    '                        _old_fn.__dict__.update(_new_fn.__dict__)',
    '                        _patched.append(_qn)',
    '                    except Exception as _e:',
    '                        _dbg_log(f"Failed to patch {_qn} in {_mod_name}: {_e}")',
    '',
    '                # Also pick up functions that appeared NEW since the first',
    '                # reload (e.g. user added a new function) — register them',
    '                # so subsequent reloads can patch them.',
    '                for _qn, _new_fn in _new_fns.items():',
    '                    _orig_map.setdefault(_qn, _new_fn)',
    '',
    '                return _patched',
    '',
    '            def _reload_watcher():',
    '                while True:',
    '                    try:',
    '                        time.sleep(0.3)',
    '                        if not _os.path.exists(_reload_file):',
    '                            continue',
    '                        with open(_reload_file) as _f:',
    '                            _paths = [_p.strip() for _p in _f.read().strip().split("\\n") if _p.strip()]',
    '                        _os.unlink(_reload_file)',
    '                        if not _paths:',
    '                            continue',
    '',
    '                        importlib.invalidate_caches()',
    '                        _results = []',
    '',
    '                        for _fpath in _paths:',
    '                            _found = False',
    '                            _abs_fpath = _os.path.abspath(_fpath)',
    '                            for _name, _mod in list(_sys.modules.items()):',
    '                                _mod_file = getattr(_mod, "__file__", None)',
    '                                if not _mod_file:',
    '                                    continue',
    '                                _abs_mod = _os.path.abspath(_mod_file)',
    '                                if _abs_mod.endswith(".pyc"):',
    '                                    _abs_mod = _abs_mod[:-1]',
    '                                if _abs_mod == _abs_fpath:',
    '                                    try:',
    '                                        _patched = _deep_reload_module(_mod)',
    '                                        _patch_list = ", ".join(_patched) if _patched else ""',
    '                                        _patch_info = f" (patched: {_patch_list})" if _patched else ""',
    '                                        _msg = f"OK:{_name}{_patch_info}"',
    '                                        _dbg_log(f"Hot reloaded: {_name}{_patch_info}")',
    '                                        _results.append(_msg)',
    '                                    except Exception as _e:',
    '                                        _msg = f"ERR:{_name}:{_e}"',
    '                                        _dbg_log(f"Reload failed: {_name}: {_e}")',
    '                                        _results.append(_msg)',
    '                                    _found = True',
    '                                    break',
    '                            if not _found:',
    '                                _msg = f"SKIP:{_fpath}"',
    '                                _dbg_log(f"No loaded module for: {_fpath}")',
    '                                _results.append(_msg)',
    '',
    '                        try:',
    '                            with open(_reload_result_file, "w") as _f:',
    '                                _f.write("\\n".join(_results))',
    '                        except Exception:',
    '                            pass',
    '',
    '                    except Exception as _e:',
    '                        _dbg_log(f"Reload watcher error: {_e}")',
    '',
    '            _t = threading.Thread(target=_reload_watcher, daemon=True, name="django-debug-hot-reload")',
    '            _t.start()',
    '            _dbg_log("Hot reload watcher started")',
    '',
    '        def _django_debugger_signal_handler(signum, frame):',
    '            global _hot_reload_watcher_started',
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
    '                _listen_result = debugpy.listen(("127.0.0.1", _port))',
    '                _host = "127.0.0.1"',
    '                _actual_port = _port',
    '                if isinstance(_listen_result, (tuple, list)) and len(_listen_result) >= 2:',
    '                    _host = str(_listen_result[0])',
    '                    _actual_port = int(_listen_result[1])',
    '                import json as _json',
    '                with open(_active_file, "w") as _f:',
    '                    _f.write(_json.dumps({"host": _host, "port": _actual_port}))',
    '                _dbg_log(f"debugpy listening on {_host}:{_actual_port}")',
    '                # Start hot reload watcher after debugpy is active',
    '                if not _hot_reload_watcher_started:',
    '                    _start_hot_reload_watcher()',
    '                    _hot_reload_watcher_started = True',
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

    // Warn (but allow) installing into global/system site-packages
    const parentDir = path.resolve(venvSitePackages, '..', '..', '..');
    const isVenv = await this.isVenvDir(parentDir);
    if (!isVenv) {
      log(`[Injector] WARNING: ${venvSitePackages} is a global/system site-packages (not a virtualenv)`);
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
   * Request hot reload of changed Python files in a running process.
   * Writes file paths to the reload request file; the bootstrap's
   * reload watcher thread picks them up and does importlib.reload().
   */
  async requestHotReload(pid: number, filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) { return; }
    await fs.mkdir(PORT_FILE_DIR, { recursive: true });
    await fs.writeFile(reloadFilePath(pid), filePaths.join('\n'), 'utf-8');
    log(`[Injector] Hot reload requested for PID=${pid}: ${filePaths.join(', ')}`);
  }

  /**
   * Read the result of the last hot reload request.
   * Returns an array of result lines (OK:module, ERR:module:reason, SKIP:path).
   */
  async readReloadResult(pid: number): Promise<string[] | null> {
    const resultFile = reloadResultFilePath(pid);
    try {
      const content = await fs.readFile(resultFile, 'utf-8');
      await fs.unlink(resultFile).catch(() => {});
      return content.trim().split('\n').filter(Boolean);
    } catch {
      return null;
    }
  }

  /**
   * Poll until the reload result is available or the timeout expires.
   * The Python-side watcher thread is suspended by debugpy while the process
   * is paused at a breakpoint (allThreadsStopped), so a result that doesn't
   * arrive promptly usually means execution needs to resume first. Callers
   * should use a long timeout when the session is known-paused.
   */
  async pollReloadResult(
    pid: number,
    timeoutMs: number,
    intervalMs: number = 20,
  ): Promise<string[] | null> {
    const resultFile = reloadResultFilePath(pid);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const content = await fs.readFile(resultFile, 'utf-8');
        await fs.unlink(resultFile).catch(() => {});
        return content.trim().split('\n').filter(Boolean);
      } catch {
        // not yet
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  }

  /**
   * Check whether a queued reload request file still sits on disk —
   * i.e. the Python watcher hasn't consumed it yet. Used to distinguish
   * "Python-side didn't process" from "Python-side reported nothing".
   */
  async isReloadPending(pid: number): Promise<boolean> {
    try {
      await fs.access(reloadFilePath(pid));
      return true;
    } catch {
      return false;
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
   * Check if the installed bootstrap version matches the current version.
   * Returns true if up-to-date, false if outdated or missing.
   */
  async isBootstrapUpToDate(venvSitePackages: string): Promise<boolean> {
    try {
      const modulePath = path.join(venvSitePackages, `${BOOTSTRAP_MODULE}.py`);
      const content = await fs.readFile(modulePath, 'utf-8');
      return content.includes(`bootstrap ${BOOTSTRAP_VERSION}`);
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
        [
          'import site',
          'import sysconfig',
          'paths = []',
          'purelib = sysconfig.get_path("purelib")',
          'if purelib:',
          '    paths.append(purelib)',
          'for candidate in getattr(site, "getsitepackages", lambda: [])():',
          '    if candidate not in paths:',
          '        paths.append(candidate)',
          'print(paths[0])',
        ].join('\n'),
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
   * Handles uv, poetry run, etc. where the wrapper is not python itself.
   */
  async resolvePythonForPid(pid: number): Promise<string> {
    try {
      const { stdout: fullCmd } = await execFileAsync('ps', [
        '-p', String(pid), '-o', 'command=',
      ]);
      const cmd = fullCmd.trim();
      log(`[Injector] ps output for PID=${pid}: ${cmd}`);

      // Strategy 1: Direct python binary in command
      const pythonMatch = cmd.match(/(\S*python\S*)/);
      if (pythonMatch && pythonMatch[1] !== 'python' && pythonMatch[1] !== 'python3') {
        // Absolute or relative path to python — use it
        return pythonMatch[1];
      }

      // Strategy 2: For wrappers like `uv run python`, find the actual
      // python executable via /proc or lsof -p PID to get the real binary.
      // On macOS, use `lsof -p PID -Fn` to find the executable path.
      try {
        const { stdout: lsofOut } = await execFileAsync('lsof', [
          '-p', String(pid), '-Fn',
        ], { timeout: 5_000 });
        // lsof output: first "n" line after "ftxt" is the executable path
        const lines = lsofOut.split('\n');
        let foundTxt = false;
        for (const line of lines) {
          if (line === 'ftxt') { foundTxt = true; continue; }
          if (foundTxt && line.startsWith('n')) {
            const exePath = line.slice(1); // remove leading 'n'
            if (exePath.includes('python') || exePath.includes('Python')) {
              log(`[Injector] lsof resolved executable: ${exePath}`);
              return exePath;
            }
          }
        }
      } catch {
        // lsof may fail
      }

      // Strategy 3: Check child processes — for `uv run python`, the child
      // is the actual python binary
      try {
        const { stdout: psOut } = await execFileAsync('ps', [
          '-o', 'pid=,command=', '--ppid', String(pid),
        ]);
        for (const line of psOut.trim().split('\n')) {
          const childMatch = line.trim().match(/^\d+\s+(\S*python\S*)/);
          if (childMatch) {
            log(`[Injector] Found child python process: ${childMatch[1]}`);
            return childMatch[1];
          }
        }
      } catch {
        // --ppid may not be supported on macOS ps, try pgrep
        try {
          const { stdout: pgrepOut } = await execFileAsync('pgrep', ['-P', String(pid)]);
          for (const childPidStr of pgrepOut.trim().split('\n').filter(Boolean)) {
            const childPid = childPidStr.trim();
            const { stdout: childCmd } = await execFileAsync('ps', [
              '-p', childPid, '-o', 'command=',
            ]);
            const childMatch = childCmd.trim().match(/(\S*python\S*)/);
            if (childMatch) {
              log(`[Injector] Found child python via pgrep: ${childMatch[1]}`);
              return childMatch[1];
            }
          }
        } catch { /* skip */ }
      }

      // Fallback
      if (pythonMatch) { return pythonMatch[1]; }
      return 'python3';
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
   * Returns the endpoint if active, null otherwise.
   */
  async getActiveEndpoint(pid: number): Promise<DebugpyEndpoint | null> {
    const activeFile = path.join(PORT_FILE_DIR, `${pid}.active`);
    try {
      const content = await fs.readFile(activeFile, 'utf-8');
      const recorded = this.parseActiveFile(content);
      if (recorded) {
        let endpoint = await this.findListeningEndpoint(recorded.port, undefined, recorded.host);
        if (!endpoint && recorded.host) {
          endpoint = await this.findListeningEndpoint(recorded.port);
        }
        if (endpoint) {
          return endpoint;
        }
      }
      // Stale active file — debugpy no longer listening
      await fs.unlink(activeFile).catch(() => {});
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check if debugpy is already active for a given PID.
   * Returns the port if active, null otherwise.
   */
  async getActivePort(pid: number): Promise<number | null> {
    const endpoint = await this.getActiveEndpoint(pid);
    return endpoint?.port ?? null;
  }

  private parseActiveFile(content: string): { host?: string; port: number } | null {
    const trimmed = content.trim();
    try {
      const parsed = JSON.parse(trimmed) as { host?: unknown; port?: unknown };
      if (typeof parsed.port === 'number' && Number.isInteger(parsed.port)) {
        return {
          host: typeof parsed.host === 'string' ? parsed.host : undefined,
          port: parsed.port,
        };
      }
    } catch {
      // Legacy active files contain only the port.
    }

    const port = parseInt(trimmed, 10);
    return Number.isInteger(port) ? { port } : null;
  }

  /**
   * Activate debugpy in a running Django process by sending SIGUSR1.
   * Returns the endpoint debugpy is listening on.
   *
   * If debugpy is already active, returns the existing endpoint.
   * SAFETY: Will NOT send SIGUSR1 unless the bootstrap module is confirmed
   * importable, because Python's default SIGUSR1 handler terminates the process.
   */
  async activateEndpoint(pid: number, port: number): Promise<DebugpyEndpoint> {
    log(`[Injector] Activating debugpy for PID=${pid} port=${port}`);

    this.verifyProcessAlive(pid);
    log(`[Injector] Process ${pid} is alive`);

    // Check if debugpy is already active for this PID
    const existingEndpoint = await this.getActiveEndpoint(pid);
    if (existingEndpoint !== null) {
      log(`[Injector] debugpy already active for PID=${pid} on ${formatEndpoint(existingEndpoint)}`);
      return existingEndpoint;
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
    const detectedEndpoint = await this.waitForPortListening(port, 5000);
    if (!detectedEndpoint) {
      log(`[Injector] Port ${port} not open after SIGUSR1`);
      throw new BootstrapNotLoadedError(pid, port);
    }
    const endpoint = await this.getActiveEndpoint(pid) ?? detectedEndpoint;
    log(`[Injector] debugpy is listening on ${formatEndpoint(endpoint)}`);
    return endpoint;
  }

  /**
   * Backward-compatible helper for callers that only need the port.
   */
  async activate(pid: number, port: number): Promise<number> {
    const endpoint = await this.activateEndpoint(pid, port);
    return endpoint.port;
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
  async isPortListeningPublic(port: number, host?: string): Promise<boolean> {
    return (await this.findListeningEndpoint(port, undefined, host)) !== null;
  }

  /**
   * Resolve the actual listening endpoint for a port.
   */
  async findListeningEndpointPublic(
    port: number,
    pid?: number,
    host?: string,
  ): Promise<DebugpyEndpoint | null> {
    return this.findListeningEndpoint(port, pid, host);
  }

  private async findListeningEndpoint(
    port: number,
    pid?: number,
    host?: string,
  ): Promise<DebugpyEndpoint | null> {
    try {
      const args = [
        '-nP',
        '-i', `TCP:${port}`,
        '-sTCP:LISTEN',
      ];
      if (pid !== undefined) {
        args.push('-p', String(pid));
      }

      const { stdout } = await execFileAsync('lsof', [
        ...args,
      ]);
      const expectedHost = host ? normalizeListeningHost(host) : undefined;
      for (const line of stdout.split('\n')) {
        const endpoint = parseLsofTcpListenLine(line);
        if (!endpoint || endpoint.port !== port) {
          continue;
        }
        if (expectedHost && endpoint.host !== expectedHost) {
          continue;
        }
        return endpoint;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Wait for a port to start listening, checked via lsof (non-invasive).
   */
  private async waitForPortListening(
    port: number,
    timeoutMs: number,
    pid?: number,
  ): Promise<DebugpyEndpoint | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const endpoint = await this.findListeningEndpoint(port, pid);
      if (endpoint) {
        return endpoint;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
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
