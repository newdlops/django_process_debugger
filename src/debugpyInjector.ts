import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DEFAULT_DEBUG_ENGINE, isDebugEngine, type DebugEngine } from './debugEngine';
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
const TRACER_MODULE_FILENAME = '_django_debug_tracer.py';
const TRACER_SOURCE_PATH = path.resolve(
  __dirname,
  '..',
  'python',
  'django_process_debugger_tracer.py',
);
export const BOOTSTRAP_VERSION = '2026.07.10.10';
export type DebugpyEndpoint = TcpListeningEndpoint;
type BootstrapRuntimeState = {
  pid: number;
  version: string;
  engines?: DebugEngine[];
  activationVersion?: number;
};
type HotReloadResultPayload = {
  requestId?: string;
  results: string[];
};

let hotReloadRequestSequence = 0;

function pythonProbeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.PORT_MANAGER_HOOK = '0';
  env.PORT_MANAGER_HOOK_DISABLED = '1';
  delete env.DYLD_INSERT_LIBRARIES;
  delete env.LD_PRELOAD;
  return env;
}

/**
 * Bootstrap script installed into the target venv's site-packages.
 * Installs a SIGUSR1/SIGUSR2 handler that starts the selected engine on demand.
 *
 * The generated bootstrap embeds the bundled debugpy path and imports the
 * installed native tracer companion when experimental mode is selected.
 */
/**
 * Activation file path: the extension writes a versioned engine/port payload
 * here before sending a signal. The legacy .port filename and integer content
 * remain supported for debugpy compatibility.
 * Using a file avoids the problem of not being able to set env vars on
 * an already-running process.
 */
const PORT_FILE_DIR = '/tmp/django-process-debugger';

async function ensurePrivatePortFileDir(): Promise<void> {
  await fs.mkdir(PORT_FILE_DIR, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(PORT_FILE_DIR, 0o700);
  } catch {
    // A pre-existing directory may not be owned by this user. The subsequent
    // file operation will surface a useful error if it is not writable.
  }
}
function portFilePath(pid: number): string {
  return `${PORT_FILE_DIR}/${pid}.port`;
}

function activeFilePath(pid: number, engine: DebugEngine): string {
  return engine === 'experimental'
    ? `${PORT_FILE_DIR}/${pid}.experimental.active`
    : `${PORT_FILE_DIR}/${pid}.active`;
}

function otherDebugEngine(engine: DebugEngine): DebugEngine {
  return engine === 'debugpy' ? 'experimental' : 'debugpy';
}

function reloadFilePath(pid: number): string {
  return `${PORT_FILE_DIR}/${pid}.reload`;
}

function reloadProcessingFilePath(pid: number): string {
  return `${reloadFilePath(pid)}.processing`;
}

function reloadResultFilePath(pid: number): string {
  return `${PORT_FILE_DIR}/${pid}.reload.result`;
}

function isFsError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function nextHotReloadRequestId(pid: number): string {
  hotReloadRequestSequence += 1;
  return `${pid}-${process.pid}-${Date.now().toString(36)}-${hotReloadRequestSequence.toString(36)}`;
}

function parseHotReloadResult(content: string): HotReloadResultPayload {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const candidate = parsed as Record<string, unknown>;
      if (
        candidate.version === 2
        && typeof candidate.requestId === 'string'
        && Array.isArray(candidate.results)
        && candidate.results.every((entry) => typeof entry === 'string')
      ) {
        return {
          requestId: candidate.requestId,
          results: candidate.results as string[],
        };
      }
    }
  } catch {
    // Legacy bootstrap results are newline-delimited. Keep reading those so
    // an attach can report a useful result while a process restart is pending.
  }
  return {
    results: content.trim().split('\n').filter(Boolean),
  };
}

function bootstrapStateFilePath(pid: number): string {
  return `${PORT_FILE_DIR}/${pid}.bootstrap.json`;
}

function isCeleryWorkerCommand(command: string): boolean {
  return [
    /(?:^|\s)(?:\S*\/)?celery(?:\s|$).*?\bworker\b/i,
    /(?:^|\s)-m\s+celery(?:\s|$).*?\bworker\b/i,
    /(?:^|\s)(?:\S*\/)?celery(?:\s|$).*?\bmulti\s+start\b/i,
    /(?:^|\s)(?:\S*\/)?celeryd(?:\s|$)/i,
  ].some((pattern) => pattern.test(command));
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
    '        if _os.path.basename(_argv0) == "celeryd" or " celeryd" in _cmd:',
    '            return True',
    '        # Fallback for Python < 3.10 (no orig_argv): a `-m <pkg> worker`',
    '        # invocation arrives as argv == ["-m", "worker", ...].',
    '        if _argv0 == "-m" and "worker" in _parts:',
    '            return True',
    '        # Interactive Django shells are long-lived attach targets too. Match',
    '        # the manage.py command tokens rather than a broad substring so a',
    '        # similarly named management command is not opted in accidentally.',
    '        for _index, _part in enumerate(_parts[:-1]):',
    '            if _os.path.basename(_part) == "manage.py" and _parts[_index + 1] in ("shell", "shell_plus"):',
    '                return True',
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
    '        def _write_bootstrap_state():',
    '            try:',
    '                _os.makedirs(_PORT_FILE_DIR, exist_ok=True)',
    '                try:',
    '                    _os.chmod(_PORT_FILE_DIR, 0o700)',
    '                except Exception:',
    '                    pass',
    '                import json as _json',
    '                _state_file = f"{_PORT_FILE_DIR}/{_os.getpid()}.bootstrap.json"',
    '                _state_tmp = _state_file + ".tmp"',
    '                with open(_state_tmp, "w") as _f:',
    '                    _f.write(_json.dumps({"version": ' + JSON.stringify(BOOTSTRAP_VERSION) + ', "pid": _os.getpid(), "engines": ["debugpy", "experimental"], "activationVersion": 1}))',
    '                _os.chmod(_state_tmp, 0o600)',
    '                _os.replace(_state_tmp, _state_file)',
    '            except Exception as _e:',
    '                _dbg_log(f"Failed to write bootstrap state: {_e}")',
    '',
    '        _dbg_log("Bootstrap module loaded, installing signal handlers")',
    '        _write_bootstrap_state()',
    '',
    '        _hot_reload_watcher_started = False',
    '        _engine_endpoints = {}',
    '        _activated_engine = None',
    '        _bootstrap_pid = _os.getpid()',
    '',
    '        def _reset_bootstrap_after_fork():',
    '            global _hot_reload_watcher_started, _engine_endpoints, _activated_engine, _bootstrap_pid',
    '            # The child has no copy of parent daemon threads and must own',
    '            # a fresh activation lifecycle. Never retain parent endpoints.',
    '            _bootstrap_pid = _os.getpid()',
    '            _engine_endpoints = {}',
    '            _activated_engine = None',
    '            _hot_reload_watcher_started = False',
    '',
    '        _register_at_fork = getattr(_os, "register_at_fork", None)',
    '        if _register_at_fork is not None:',
    '            _register_at_fork(after_in_child=_reset_bootstrap_after_fork)',
    '',
    '        # Persistent weak registry of every still-live function generation.',
    '        # Django/GraphQL/Celery may capture a new module generation after any',
    '        # reload, so retaining only the pre-first-reload objects is insufficient.',
    '        # Keyed by module name -> {function_key: WeakSet(function_object)}.',
    '        _original_mod_funcs = {}',
    '',
    '        def _start_hot_reload_watcher():',
    '            """Start a daemon thread that watches for module reload requests."""',
    '            import threading',
    '            import importlib',
    '            import importlib.util',
    '            import json',
    '            import time',
    '',
    '            _pid = _os.getpid()',
    '            _reload_file = f"{_PORT_FILE_DIR}/{_pid}.reload"',
    '            _reload_processing_file = _reload_file + ".processing"',
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
    '                _file_changed_signal.connect(',
    '                    _suppress_autoreload,',
    '                    weak=False,',
    '                    dispatch_uid="django-process-debugger-hot-reload",',
    '                )',
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
    '                  2. Index those functions by logical + code qualname and',
    '                     weakly track every live reload generation.',
    '                  3. Patch every live OLD.__code__ / __defaults__ / __kwdefaults__ /',
    '                     __dict__ from the matching NEW function.',
    '',
    '                Externally held references (Django URL conf, GraphQL schema,',
    '                Celery task registry, ...) keep the SAME function object,',
    '                but the next call dispatches through the fresh bytecode."""',
    '                import types',
    '                import os',
    '                import weakref',
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
    '                def _function_key(_fn):',
    '                    # functools.wraps copies function.__qualname__ but not',
    '                    # code.co_qualname. Keeping both distinguishes wrapper',
    '                    # and wrapped functions while pairing generations.',
    '                    _logical = getattr(_fn, "__qualname__", None)',
    '                    _code_name = _code_key(_fn.__code__)',
    '                    return ((_logical or _code_name), _code_name)',
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
    '                    """Return {function_key: [all reachable functions]}."""',
    '                    _idx = {}',
    '                    for _fn in _walk_reachable(list(_target_mod.__dict__.values())):',
    '                        _c = _fn.__code__',
    '                        if not _is_in_this_file(_c):',
    '                            continue',
    '                        _idx.setdefault(_function_key(_fn), []).append(_fn)',
    '                    return _idx',
    '',
    '                _generation_registry = _original_mod_funcs.setdefault(',
    '                    _mod_name,',
    '                    {},',
    '                )',
    '',
    '                def _remember_generation(_index):',
    '                    for _key, _functions in _index.items():',
    '                        _bucket = _generation_registry.get(_key)',
    '                        if _bucket is None:',
    '                            _bucket = weakref.WeakSet()',
    '                            _generation_registry[_key] = _bucket',
    '                        for _function in _functions:',
    '                            _bucket.add(_function)',
    '',
    '                # Register the currently exported generation on EVERY',
    '                # reload. Framework code may have captured it after an',
    '                # earlier reload, so first-generation-only storage leaves',
    '                # those newer references stale.',
    '                _current_fns = _index_module_functions(_mod)',
    '                _remember_generation(_current_fns)',
    '',
    '                # A timestamp-based .pyc can remain valid when an editor',
    '                # makes a same-size change within one filesystem tick.',
    '                # Derive the canonical cache from the matched source path',
    '                # rather than trusting module.__cached__, which application',
    '                # code can replace with an unrelated path. Always remove the',
    '                # derived cache so source is recompiled; failures are non-fatal.',
    '                _cached_file = getattr(_mod, "__cached__", None)',
    '                _canonical_cached_file = None',
    '                if type(_mod_file) is str:',
    '                    try:',
    '                        _canonical_cached_file = importlib.util.cache_from_source(',
    '                            _mod_file,',
    '                        )',
    '                    except Exception:',
    '                        pass',
    '                if type(_canonical_cached_file) is str:',
    '                    try:',
    '                        _os.unlink(_canonical_cached_file)',
    '                    except FileNotFoundError:',
    '                        pass',
    '                    except Exception as _e:',
    '                        _dbg_log(f"Could not remove bytecode cache for {_mod_name}: {_e}")',
    '                if (',
    '                    _cached_file is not None',
    '                    and (',
    '                        type(_cached_file) is not str',
    '                        or type(_canonical_cached_file) is not str',
    '                        or os.path.realpath(_cached_file)',
    '                        != os.path.realpath(_canonical_cached_file)',
    '                    )',
    '                ):',
    '                    _dbg_log(f"Skipped non-canonical bytecode cache for {_mod_name}")',
    '                importlib.invalidate_caches()',
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
    '                # Patch every still-live prior generation. WeakSets retain',
    '                # externally held Django/GraphQL/Celery references without',
    '                # leaking generations that nobody uses anymore.',
    '                _patched = set()',
    '                for _key, _bucket in list(_generation_registry.items()):',
    '                    _new_candidates = _new_fns.get(_key)',
    '                    if not _new_candidates:',
    '                        continue',
    '                    _new_fn = _new_candidates[0]',
    '                    for _old_fn in list(_bucket):',
    '                        if any(_old_fn is _candidate for _candidate in _new_candidates):',
    '                            continue',
    '                        try:',
    '                            _old_fn.__code__ = _new_fn.__code__',
    '                            _old_fn.__defaults__ = _new_fn.__defaults__',
    '                            _old_fn.__kwdefaults__ = getattr(_new_fn, "__kwdefaults__", None)',
    '                            _old_fn.__dict__.update(_new_fn.__dict__)',
    '                            _old_fn.__annotations__ = dict(',
    '                                getattr(_new_fn, "__annotations__", {}),',
    '                            )',
    '                            _old_fn.__doc__ = _new_fn.__doc__',
    '                            _patched.add(_key[0])',
    '                        except Exception as _e:',
    '                            _dbg_log(f"Failed to patch {_key[0]} in {_mod_name}: {_e}")',
    '',
    '                _remember_generation(_new_fns)',
    '                return sorted(_patched)',
    '',
    '            def _publish_reload_result(_request_id, _results):',
    '                _result_tmp = (',
    '                    _reload_result_file',
    '                    + "."',
    '                    + str(threading.get_ident())',
    '                    + ".tmp"',
    '                )',
    '                _payload = (',
    '                    json.dumps({',
    '                        "version": 2,',
    '                        "requestId": _request_id,',
    '                        "results": _results,',
    '                    })',
    '                    if _request_id is not None',
    '                    else "\\n".join(_results)',
    '                )',
    '                try:',
    '                    with open(_result_tmp, "w") as _f:',
    '                        _f.write(_payload)',
    '                    try:',
    '                        _os.chmod(_result_tmp, 0o600)',
    '                    except Exception:',
    '                        pass',
    '                    _os.replace(_result_tmp, _reload_result_file)',
    '                finally:',
    '                    try:',
    '                        _os.unlink(_result_tmp)',
    '                    except FileNotFoundError:',
    '                        pass',
    '',
    '            def _clear_reload_claim():',
    '                try:',
    '                    _os.unlink(_reload_processing_file)',
    '                except FileNotFoundError:',
    '                    pass',
    '                except Exception as _e:',
    '                    _dbg_log(f"Could not clear reload claim: {_e}")',
    '',
    '            def _reload_watcher():',
    '                # The experimental tracer installs threading.settrace().',
    '                # Reload implementation details must not hit application',
    '                # breakpoints or Raised filters on this internal thread.',
    '                if _activated_engine == "experimental":',
    '                    try:',
    '                        _sys.settrace(None)',
    '                    except Exception:',
    '                        pass',
    '                while True:',
    '                    try:',
    '                        _request_id = None',
    '                        _claimed = False',
    '                        time.sleep(0.3)',
    '                        try:',
    '                            _os.replace(_reload_file, _reload_processing_file)',
    '                            _claimed = True',
    '                        except FileNotFoundError:',
    '                            continue',
    '                        with open(_reload_processing_file) as _f:',
    '                            _raw_request = _f.read()',
    '',
    '                        try:',
    '                            _request = json.loads(_raw_request)',
    '                        except Exception:',
    '                            if _raw_request.lstrip().startswith("{"):',
    '                                raise',
    '                            _request = None',
    '                        if isinstance(_request, dict) and _request.get("version") == 2:',
    '                            _request_id = _request.get("requestId")',
    '                            _paths = _request.get("paths")',
    '                            if not isinstance(_request_id, str) or not isinstance(_paths, list):',
    '                                raise ValueError("Invalid hot reload v2 request")',
    '                            if not all(isinstance(_p, str) for _p in _paths):',
    '                                raise ValueError("Invalid hot reload path")',
    '                            _paths = [_p for _p in _paths if _p]',
    '                        else:',
    '                            _paths = [',
    '                                _p.strip()',
    '                                for _p in _raw_request.strip().split("\\n")',
    '                                if _p.strip()',
    '                            ]',
    '                        if not _paths:',
    '                            _publish_reload_result(_request_id, [])',
    '                            _clear_reload_claim()',
    '                            _claimed = False',
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
    '                        _publish_reload_result(_request_id, _results)',
    '                        _clear_reload_claim()',
    '                        _claimed = False',
    '',
    '                    except Exception as _e:',
    '                        _dbg_log(f"Reload watcher error: {_e}")',
    '                        try:',
    '                            _publish_reload_result(',
    '                                locals().get("_request_id"),',
    '                                [f"ERR:protocol:{type(_e).__name__}:{_e}"],',
    '                            )',
    '                        except Exception:',
    '                            pass',
    '                        finally:',
    '                            if locals().get("_claimed", False):',
    '                                _clear_reload_claim()',
    '',
    '            _t = threading.Thread(target=_reload_watcher, daemon=True, name="django-debug-hot-reload")',
    '            _t.start()',
    '            _dbg_log("Hot reload watcher started")',
    '',
    '        def _django_debugger_signal_handler(signum, frame):',
    '            global _hot_reload_watcher_started, _engine_endpoints, _activated_engine, _bootstrap_pid',
    '            _current_pid = _os.getpid()',
    '            if _bootstrap_pid != _current_pid:',
    '                # A forked child has its own lifecycle. Do not reuse the',
    '                # parent engine ownership or endpoints; the experimental',
    '                # tracer at-fork callback has also closed inherited sockets.',
    '                _bootstrap_pid = _current_pid',
    '                _engine_endpoints = {}',
    '                _activated_engine = None',
    '                _hot_reload_watcher_started = False',
    '                _dbg_log("Fork detected; reset inherited engine ownership")',
    '            _dbg_log(f"Signal {signum} received")',
    '            _write_bootstrap_state()',
    '            _pid = _os.getpid()',
    '            _port_file = f"{_PORT_FILE_DIR}/{_pid}.port"',
    '            def _clear_pending_port_file():',
    '                try:',
    '                    _os.unlink(_port_file)',
    '                except FileNotFoundError:',
    '                    pass',
    '                except Exception as _e:',
    '                    _dbg_log(f"Failed to remove stale port file: {_e}")',
    '            def _active_file_for(_engine_name):',
    '                if _engine_name == "experimental":',
    '                    return f"{_PORT_FILE_DIR}/{_pid}.experimental.active"',
    '                return f"{_PORT_FILE_DIR}/{_pid}.active"',
    '            def _endpoint_is_alive(_host, _port_value):',
    '                try:',
    '                    import socket as _socket',
    '                    _sock = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)',
    '                    _sock.settimeout(0.2)',
    '                    try:',
    '                        return _sock.connect_ex((_host or "127.0.0.1", int(_port_value))) == 0',
    '                    finally:',
    '                        _sock.close()',
    '                except Exception as _e:',
    '                    _dbg_log(f"Endpoint check failed for {_host}:{_port_value}: {_e}")',
    '                    return False',
    '            def _read_active_endpoint(_file_path, _expected_engine):',
    '                try:',
    '                    with open(_file_path) as _f:',
    '                        _content = _f.read().strip()',
    '                    try:',
    '                        import json as _json',
    '                        _parsed = _json.loads(_content)',
    '                        if isinstance(_parsed, dict):',
    '                            _recorded_engine = _parsed.get("engine")',
    '                            if _recorded_engine is not None and _recorded_engine != _expected_engine:',
    '                                return None',
    '                            if _expected_engine == "experimental" and _recorded_engine != "experimental":',
    '                                return None',
    '                            return (str(_parsed.get("host") or "127.0.0.1"), int(_parsed.get("port")))',
    '                    except Exception:',
    '                        pass',
    '                    if _expected_engine == "debugpy":',
    '                        return ("127.0.0.1", int(_content))',
    '                    return None',
    '                except FileNotFoundError:',
    '                    return None',
    '                except Exception as _e:',
    '                    _dbg_log(f"Failed to read {_expected_engine} active endpoint: {_e}")',
    '                    return None',
    '            def _remove_active_file(_file_path):',
    '                try:',
    '                    _os.unlink(_file_path)',
    '                except FileNotFoundError:',
    '                    pass',
    '                except Exception as _e:',
    '                    _dbg_log(f"Failed to remove stale active file {_file_path}: {_e}")',
    '            def _write_active_endpoint(_file_path, _engine_name, _host, _port_value):',
    '                import json as _json',
    '                _tmp_file = _file_path + ".tmp"',
    '                with open(_tmp_file, "w") as _f:',
    '                    _f.write(_json.dumps({"version": 1, "engine": _engine_name, "host": _host, "port": _port_value}))',
    '                _os.chmod(_tmp_file, 0o600)',
    '                _os.replace(_tmp_file, _file_path)',
    '',
    '            # Read activation intent before inspecting endpoint markers. Older',
    '            # extensions wrote a bare integer; that remains a debugpy request.',
    '            _engine = "debugpy"',
    '            _port = 5678',
    '            try:',
    '                with open(_port_file) as _f:',
    '                    _request_content = _f.read().strip()',
    '                import json as _json',
    '                try:',
    '                    _request = _json.loads(_request_content)',
    '                except Exception:',
    '                    _request = int(_request_content)',
    '                if isinstance(_request, dict):',
    '                    if int(_request.get("version", 0)) != 1:',
    '                        raise ValueError("unsupported activation request version")',
    '                    _requested_engine = _request.get("engine", "debugpy")',
    '                    if _requested_engine not in ("debugpy", "experimental"):',
    '                        raise ValueError(f"unsupported debug engine: {_requested_engine}")',
    '                    _engine = _requested_engine',
    '                    _port = int(_request.get("port", 5678))',
    '                else:',
    '                    _port = int(_request)',
    '                if _port < 0 or _port > 65535:',
    '                    raise ValueError(f"invalid debug port: {_port}")',
    '                _clear_pending_port_file()',
    '                _dbg_log(f"Read activation request engine={_engine} port={_port}")',
    '            except FileNotFoundError:',
    '                _dbg_log(f"Activation file not found, using defaults engine={_engine} port={_port}")',
    '            except Exception as _e:',
    '                _clear_pending_port_file()',
    '                _dbg_log(f"Invalid activation request: {_e}")',
    '                return',
    '',
    '            # A tracer owns interpreter-wide hooks that cannot be safely',
    '            # replaced in every existing thread on all supported Python',
    '            # versions. Ownership therefore lasts until process restart.',
    '            if _activated_engine is not None:',
    '                if _activated_engine != _engine:',
    '                    _dbg_log(f"Cannot activate {_engine}: {_activated_engine} owns this PID until restart")',
    '                    return',
    '                _owned_endpoint = _engine_endpoints.get(_activated_engine)',
    '                if _owned_endpoint is not None and _endpoint_is_alive(_owned_endpoint[0], _owned_endpoint[1]):',
    '                    try:',
    '                        _write_active_endpoint(_active_file_for(_engine), _engine, _owned_endpoint[0], _owned_endpoint[1])',
    '                    except Exception as _e:',
    '                        _dbg_log(f"Failed to restore owned {_engine} endpoint: {_e}")',
    '                    return',
    '                _dbg_log(f"Cannot reactivate {_engine}: its process-level hooks were already installed; restart required")',
    '                return',
    '',
    '            _active_file = _active_file_for(_engine)',
    '            _existing_endpoint = _read_active_endpoint(_active_file, _engine)',
    '            if _existing_endpoint is not None:',
    '                if _endpoint_is_alive(_existing_endpoint[0], _existing_endpoint[1]):',
    '                    _dbg_log(f"{_engine} already active on {_existing_endpoint[0]}:{_existing_endpoint[1]}, skipping")',
    '                    return',
    '                _remove_active_file(_active_file)',
    '                _dbg_log(f"Removed stale {_engine} endpoint {_existing_endpoint[0]}:{_existing_endpoint[1]}")',
    '',
    '            # The first experimental tracer intentionally runs exclusively.',
    '            # Keep per-engine files so this guard can be relaxed in the future.',
    '            _other_engine = "experimental" if _engine == "debugpy" else "debugpy"',
    '            _other_active_file = _active_file_for(_other_engine)',
    '            _other_endpoint = _read_active_endpoint(_other_active_file, _other_engine)',
    '            if _other_endpoint is None:',
    '                _other_endpoint = _engine_endpoints.get(_other_engine)',
    '            if _other_endpoint is not None:',
    '                if _endpoint_is_alive(_other_endpoint[0], _other_endpoint[1]):',
    '                    _dbg_log(f"Cannot activate {_engine}: {_other_engine} is already active on {_other_endpoint[0]}:{_other_endpoint[1]}")',
    '                    return',
    '                _remove_active_file(_other_active_file)',
    '',
    '            _stored_endpoint = _engine_endpoints.get(_engine)',
    '            if _stored_endpoint is not None:',
    '                if not _endpoint_is_alive(_stored_endpoint[0], _stored_endpoint[1]):',
    '                    _dbg_log(f"Stored {_engine} endpoint is stale: {_stored_endpoint[0]}:{_stored_endpoint[1]}")',
    '                    _engine_endpoints.pop(_engine, None)',
    '                else:',
    '                    try:',
    '                        _write_active_endpoint(_active_file, _engine, _stored_endpoint[0], _stored_endpoint[1])',
    '                        _dbg_log(f"{_engine} endpoint restored in active file: {_stored_endpoint[0]}:{_stored_endpoint[1]}")',
    '                    except Exception as _e:',
    '                        _dbg_log(f"Failed to restore {_engine} active file: {_e}")',
    '                    return',
    '',
    '            # Claim process-level tracing ownership before importing or',
    '            # starting the engine. A partial activation is also unsafe to',
    '            # replace without restarting the target process.',
    '            _activated_engine = _engine',
    '            try:',
    '                if _engine == "debugpy":',
    '                    _bundled = ' + JSON.stringify(bundledDebugpyPath),
    '                    if _bundled and _bundled not in _sys.path:',
    '                        _sys.path.insert(0, _bundled)',
    '                        _dbg_log(f"Added bundled path: {_bundled}")',
    '                    import debugpy',
    '                    _dbg_log(f"debugpy imported from {debugpy.__file__}")',
    '                    _listen_result = debugpy.listen(("127.0.0.1", _port))',
    '                else:',
    '                    import _django_debug_tracer as _experimental_tracer',
    '                    _dbg_log(f"experimental tracer imported from {_experimental_tracer.__file__}")',
    '                    _listen_result = _experimental_tracer.start("127.0.0.1", _port)',
    '                _host = "127.0.0.1"',
    '                _actual_port = _port',
    '                if isinstance(_listen_result, (tuple, list)) and len(_listen_result) >= 2:',
    '                    _host = str(_listen_result[0])',
    '                    _actual_port = int(_listen_result[1])',
    '                _write_active_endpoint(_active_file, _engine, _host, _actual_port)',
    '                _engine_endpoints[_engine] = (_host, _actual_port)',
    '                _dbg_log(f"{_engine} listening on {_host}:{_actual_port}")',
    '                if not _hot_reload_watcher_started:',
    '                    _start_hot_reload_watcher()',
    '                    _hot_reload_watcher_started = True',
    '            except RuntimeError as _e:',
    '                if "already" in str(_e).lower():',
    '                    _dbg_log(f"{_engine} already listening: {_e}")',
    '                else:',
    '                    _dbg_log(f"{_engine} RuntimeError: {_e}\\n{_traceback.format_exc()}")',
    '            except Exception as _e:',
    '                _dbg_log(f"{_engine} ERROR: {_e}\\n{_traceback.format_exc()}")',
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
    const tracerModulePath = path.join(venvSitePackages, TRACER_MODULE_FILENAME);

    log(`[Injector] Installing bootstrap to ${venvSitePackages}`);
    log(`[Injector]   .pth file: ${pthPath}`);
    log(`[Injector]   module: ${modulePath}`);
    log(`[Injector]   tracer: ${tracerModulePath}`);

    await fs.copyFile(TRACER_SOURCE_PATH, tracerModulePath);
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
    const tracerModulePath = path.join(venvSitePackages, TRACER_MODULE_FILENAME);

    for (const f of [pthPath, modulePath, tracerModulePath]) {
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
   * Atomically publishes a correlated v2 request; the bootstrap's reload
   * watcher claims it and runs importlib.reload().
   */
  async requestHotReload(pid: number, filePaths: string[]): Promise<string | null> {
    if (filePaths.length === 0) { return null; }
    await ensurePrivatePortFileDir();
    const requestId = nextHotReloadRequestId(pid);
    const requestFile = reloadFilePath(pid);
    const temporaryFile = `${requestFile}.${requestId}.tmp`;
    const payload = JSON.stringify({
      version: 2,
      requestId,
      paths: filePaths,
    });

    try {
      await fs.unlink(reloadResultFilePath(pid));
    } catch (error) {
      if (!isFsError(error, 'ENOENT')) { throw error; }
    }

    try {
      await fs.writeFile(temporaryFile, payload, {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      });
      // Set permissions before publishing the fixed request filename. The
      // Python watcher can consume that filename immediately after rename.
      await fs.chmod(temporaryFile, 0o600);
      await fs.rename(temporaryFile, requestFile);
    } finally {
      try {
        await fs.unlink(temporaryFile);
      } catch (error) {
        if (!isFsError(error, 'ENOENT')) { throw error; }
      }
    }
    log(
      `[Injector] Hot reload requested for PID=${pid}, request=${requestId}: `
      + filePaths.join(', '),
    );
    return requestId;
  }

  /**
   * Read the result of the last hot reload request.
   * Returns result rows (OK:module, ERR:module:reason, SKIP:path). When an
   * expected id is provided, a stale result is left untouched.
   */
  async readReloadResult(
    pid: number,
    expectedRequestId?: string,
  ): Promise<string[] | null> {
    const resultFile = reloadResultFilePath(pid);
    let content: string;
    try {
      content = await fs.readFile(resultFile, 'utf-8');
    } catch (error) {
      if (isFsError(error, 'ENOENT')) { return null; }
      throw error;
    }
    const payload = parseHotReloadResult(content);
    if (
      expectedRequestId !== undefined
      && payload.requestId !== expectedRequestId
    ) {
      return null;
    }
    try {
      await fs.unlink(resultFile);
    } catch (error) {
      if (!isFsError(error, 'ENOENT')) { throw error; }
    }
    return payload.results;
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
    expectedRequestId?: string,
    signal?: AbortSignal,
  ): Promise<string[] | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs && signal?.aborted !== true) {
      const result = await this.readReloadResult(pid, expectedRequestId);
      if (result !== null) { return result; }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  }

  /**
   * Check whether a queued reload request file still sits on disk —
   * i.e. the Python watcher hasn't consumed it yet. Used to distinguish
   * "Python-side didn't process" from "Python-side reported nothing".
   */
  async isReloadPending(pid: number, expectedRequestId?: string): Promise<boolean> {
    for (const requestFile of [
      reloadFilePath(pid),
      reloadProcessingFilePath(pid),
    ]) {
      try {
        if (expectedRequestId === undefined) {
          await fs.access(requestFile);
          return true;
        }
        const content = await fs.readFile(requestFile, 'utf-8');
        try {
          const parsed = JSON.parse(content) as Record<string, unknown>;
          if (parsed.version === 2 && parsed.requestId === expectedRequestId) {
            return true;
          }
        } catch {
          // A legacy request has no correlation id. It is still pending for a
          // legacy caller, but never claim it as this v2 request.
        }
      } catch (error) {
        if (!isFsError(error, 'ENOENT')) { throw error; }
      }
    }
    return false;
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
      if (!content.includes(`bootstrap ${BOOTSTRAP_VERSION}`)) {
        return false;
      }

      const installedTracer = await fs.readFile(path.join(venvSitePackages, TRACER_MODULE_FILENAME));
      const bundledTracer = await fs.readFile(TRACER_SOURCE_PATH);
      return installedTracer.equals(bundledTracer);
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
      ], { env: pythonProbeEnv() });
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
   * Check if a debug engine is already active for a given PID.
   * Returns the endpoint if active, null otherwise.
   */
  async getActiveEndpoint(
    pid: number,
    engine: DebugEngine = DEFAULT_DEBUG_ENGINE,
  ): Promise<DebugpyEndpoint | null> {
    const activeFile = activeFilePath(pid, engine);
    try {
      this.verifyProcessAlive(pid);
    } catch {
      await fs.unlink(activeFile).catch(() => {});
      return null;
    }

    try {
      const content = await fs.readFile(activeFile, 'utf-8');
      const recorded = this.parseActiveFile(content, engine);
      if (recorded) {
        // The experimental server lives inside the target process, so require
        // PID ownership. debugpy listens from its adapter child process and
        // therefore must continue to resolve by recorded host/port.
        const endpoint = engine === 'experimental'
          ? await this.findListeningEndpoint(recorded.port, pid, recorded.host)
          : recorded.host
            ? await this.findListeningEndpoint(recorded.port, undefined, recorded.host)
            : await this.findListeningEndpoint(recorded.port);
        if (endpoint) {
          return endpoint;
        }
        const pidOwnedEndpoint = await this.findListeningEndpoint(recorded.port, pid);
        if (pidOwnedEndpoint) {
          log(
            `[Injector] ${engine} endpoint host ${recorded.host ?? 'unknown'} for PID=${pid} ` +
            `resolved through PID-owned listener ${formatEndpoint(pidOwnedEndpoint)}`
          );
          return pidOwnedEndpoint;
        }
      }
      // Stale or incompatible active file — the selected engine is not listening.
      await fs.unlink(activeFile).catch(() => {});
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check if a debug engine is already active for a given PID.
   * Returns the port if active, null otherwise.
   */
  async getActivePort(
    pid: number,
    engine: DebugEngine = DEFAULT_DEBUG_ENGINE,
  ): Promise<number | null> {
    const endpoint = await this.getActiveEndpoint(pid, engine);
    return endpoint?.port ?? null;
  }

  private parseActiveFile(
    content: string,
    expectedEngine: DebugEngine = DEFAULT_DEBUG_ENGINE,
  ): { host?: string; port: number } | null {
    const trimmed = content.trim();
    try {
      const parsed = JSON.parse(trimmed) as { engine?: unknown; host?: unknown; port?: unknown };
      const recordedEngine = typeof parsed.engine === 'string' ? parsed.engine : undefined;
      if (recordedEngine !== undefined && recordedEngine !== expectedEngine) {
        return null;
      }
      if (expectedEngine === 'experimental' && recordedEngine !== 'experimental') {
        return null;
      }
      if (typeof parsed.port === 'number' && Number.isInteger(parsed.port)) {
        return {
          host: typeof parsed.host === 'string' ? parsed.host : undefined,
          port: parsed.port,
        };
      }
    } catch {
      // Legacy active files contain only the port.
    }

    if (expectedEngine !== DEFAULT_DEBUG_ENGINE) {
      return null;
    }
    const port = parseInt(trimmed, 10);
    return Number.isInteger(port) ? { port } : null;
  }

  /**
   * Activate a debug engine in a running Django process by sending SIGUSR1.
   * Returns the endpoint the selected engine is listening on.
   *
   * If that engine is already active, returns the existing endpoint.
   * SAFETY: Will NOT send SIGUSR1 unless the bootstrap module is confirmed
   * importable, because Python's default SIGUSR1 handler terminates the process.
   */
  async activateEndpoint(
    pid: number,
    port: number,
    engine: DebugEngine = DEFAULT_DEBUG_ENGINE,
  ): Promise<DebugpyEndpoint> {
    log(`[Injector] Activating ${engine} for PID=${pid} port=${port}`);

    this.verifyProcessAlive(pid);
    log(`[Injector] Process ${pid} is alive`);

    // Reuse only the requested engine. A persistent debugpy endpoint must never
    // be mistaken for the experimental tracer (or vice versa).
    const existingEndpoint = await this.getActiveEndpoint(pid, engine);
    if (existingEndpoint !== null) {
      log(`[Injector] ${engine} already active for PID=${pid} on ${formatEndpoint(existingEndpoint)}`);
      return existingEndpoint;
    }

    // The initial native tracer and debugpy both own interpreter tracing state.
    // Keep them selectable side-by-side, but do not run them simultaneously in
    // the same target process until coexistence is explicitly supported.
    const conflictingEngine = otherDebugEngine(engine);
    const conflictingEndpoint = await this.getActiveEndpoint(pid, conflictingEngine);
    if (conflictingEndpoint !== null) {
      throw new DebugEngineConflictError(pid, engine, conflictingEngine, conflictingEndpoint);
    }

    // SAFETY: Verify bootstrap is installed before sending SIGUSR1
    const pythonPath = await this.resolvePythonForPid(pid);
    const bootstrapReady = await this.verifyBootstrapLoaded(pythonPath);
    if (!bootstrapReady) {
      log(`[Injector] Bootstrap module not importable from ${pythonPath}`);
      throw new BootstrapNotInstalledError(pid);
    }
    log(`[Injector] Bootstrap module verified as importable`);

    const loadedBootstrapState = await this.getLoadedBootstrapState(pid);
    const loadedBootstrapVersion = loadedBootstrapState?.version ?? null;
    if (!loadedBootstrapState || loadedBootstrapVersion !== BOOTSTRAP_VERSION) {
      log(
        `[Injector] Target PID=${pid} loaded bootstrap version ` +
        `${loadedBootstrapVersion ?? 'unknown'}, expected ${BOOTSTRAP_VERSION}`
      );
      throw new BootstrapRuntimeVersionError(pid, loadedBootstrapVersion, BOOTSTRAP_VERSION);
    }
    if (loadedBootstrapState.pid === pid) {
      log(`[Injector] Target PID=${pid} loaded bootstrap version ${loadedBootstrapVersion}`);
    } else {
      log(
        `[Injector] Target PID=${pid} inherited bootstrap version ${loadedBootstrapVersion} ` +
        `from ancestor PID=${loadedBootstrapState.pid}`
      );
    }

    // Keep the legacy .port filename, but use a versioned payload. The new
    // bootstrap also accepts the old bare-integer format as a debugpy request.
    await ensurePrivatePortFileDir();
    const activationRequest = { version: 1, engine, port };
    await fs.writeFile(portFilePath(pid), JSON.stringify(activationRequest), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await fs.chmod(portFilePath(pid), 0o600);
    log(`[Injector] Wrote activation request: ${portFilePath(pid)} = ${JSON.stringify(activationRequest)}`);

    // Determine which signal to send: celery overrides SIGUSR1 for log reopen,
    // so we use SIGUSR2 for celery workers and SIGUSR1 for everything else.
    const command = await this.getProcessCommand(pid);
    const isCelery = isCeleryWorkerCommand(command);
    const signal = isCelery ? 'SIGUSR2' : 'SIGUSR1';

    log(`[Injector] Sending ${signal} to PID=${pid} (${isCelery ? 'celery' : 'django'})`);
    try {
      process.kill(pid, signal);
    } catch (err) {
      await fs.unlink(portFilePath(pid)).catch(() => {});
      logError(`[Injector] Failed to send ${signal} to PID=${pid}`, err);
      throw new SignalError(pid, err instanceof Error ? err : new Error(String(err)), signal);
    }

    // Wait for the target process to publish a live active endpoint.
    log(`[Injector] Waiting for ${engine} active endpoint on port ${port}...`);
    const endpoint = await this.waitForActiveEndpoint(pid, port, 5000, engine);
    if (!endpoint) {
      await fs.unlink(portFilePath(pid)).catch(() => {});
      const racedConflict = await this.getActiveEndpoint(pid, conflictingEngine);
      if (racedConflict !== null) {
        throw new DebugEngineConflictError(pid, engine, conflictingEngine, racedConflict);
      }
      log(`[Injector] ${engine} endpoint for PID=${pid} port=${port} not available after ${signal}`);
      throw new BootstrapNotLoadedError(pid, port, signal, engine);
    }
    log(`[Injector] ${engine} is listening on ${formatEndpoint(endpoint)}`);
    return endpoint;
  }

  /**
   * Backward-compatible helper for callers that only need the port.
   */
  async activate(
    pid: number,
    port: number,
    engine: DebugEngine = DEFAULT_DEBUG_ENGINE,
  ): Promise<number> {
    const endpoint = await this.activateEndpoint(pid, port, engine);
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

  private async getLoadedBootstrapState(pid: number): Promise<BootstrapRuntimeState | null> {
    const directState = await this.readBootstrapState(pid);
    if (directState) {
      return directState;
    }

    for (const ancestorPid of await this.getAncestorPids(pid)) {
      const ancestorState = await this.readBootstrapState(ancestorPid);
      if (ancestorState) {
        return ancestorState;
      }
    }

    return null;
  }

  private async readBootstrapState(pid: number): Promise<BootstrapRuntimeState | null> {
    try {
      this.verifyProcessAlive(pid);
      const content = await fs.readFile(bootstrapStateFilePath(pid), 'utf-8');
      const parsed = JSON.parse(content) as {
        pid?: unknown;
        version?: unknown;
        engines?: unknown;
        activationVersion?: unknown;
      };
      if (parsed.pid !== pid || typeof parsed.version !== 'string') {
        return null;
      }
      const state: BootstrapRuntimeState = { pid, version: parsed.version };
      if (Array.isArray(parsed.engines)) {
        state.engines = parsed.engines.filter(isDebugEngine);
      }
      if (typeof parsed.activationVersion === 'number' && Number.isInteger(parsed.activationVersion)) {
        state.activationVersion = parsed.activationVersion;
      }
      return state;
    } catch {
      return null;
    }
  }

  private async getAncestorPids(pid: number): Promise<number[]> {
    const ancestors: number[] = [];
    const seen = new Set<number>([pid]);
    let currentPid = pid;

    for (let depth = 0; depth < 16; depth += 1) {
      const parentPid = await this.getParentPid(currentPid);
      if (!parentPid || parentPid <= 1 || seen.has(parentPid)) {
        break;
      }
      ancestors.push(parentPid);
      seen.add(parentPid);
      currentPid = parentPid;
    }

    return ancestors;
  }

  private async getParentPid(pid: number): Promise<number | null> {
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'ppid=']);
      const parentPid = Number.parseInt(stdout.trim(), 10);
      return Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null;
    } catch {
      return null;
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
      ];
      if (pid !== undefined) {
        args.push('-a');
      }
      args.push(
        '-i', `TCP:${port}`,
        '-sTCP:LISTEN',
      );
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

  private async waitForActiveEndpoint(
    pid: number,
    expectedPort: number,
    timeoutMs: number,
    engine: DebugEngine = DEFAULT_DEBUG_ENGINE,
  ): Promise<DebugpyEndpoint | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const endpoint = await this.getActiveEndpoint(pid, engine);
      if (endpoint) {
        if (endpoint.port !== expectedPort) {
          log(
            `[Injector] Reusing existing ${engine} endpoint ${formatEndpoint(endpoint)} ` +
            `for PID=${pid}; requested port was ${expectedPort}`
          );
          await fs.unlink(portFilePath(pid)).catch(() => {});
        }
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
    public readonly signal: NodeJS.Signals = 'SIGUSR1',
  ) {
    super(`Failed to send ${signal} to PID ${pid}: ${cause.message}`);
    this.name = 'SignalError';
  }
}

export class DebugEngineConflictError extends Error {
  constructor(
    public readonly pid: number,
    public readonly requestedEngine: DebugEngine,
    public readonly activeEngine: DebugEngine,
    public readonly activeEndpoint: DebugpyEndpoint,
  ) {
    super(
      `Cannot activate ${requestedEngine} for PID ${pid} because ${activeEngine} is already active ` +
      `on ${formatEndpoint(activeEndpoint)}. Restart the target process before switching debug engines.`
    );
    this.name = 'DebugEngineConflictError';
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

export class BootstrapRuntimeVersionError extends Error {
  constructor(
    public readonly pid: number,
    public readonly loadedVersion: string | null,
    public readonly expectedVersion: string,
  ) {
    super(
      loadedVersion
        ? `Target PID ${pid} loaded bootstrap ${loadedVersion}, but this extension requires ${expectedVersion}. Restart the target process after setup.`
        : `Target PID ${pid} did not publish bootstrap runtime state. Restart the target process after setup so the debug bootstrap is loaded.`
    );
    this.name = 'BootstrapRuntimeVersionError';
  }
}

export class BootstrapNotLoadedError extends Error {
  constructor(
    public readonly pid: number,
    public readonly port: number,
    public readonly signal: NodeJS.Signals = 'SIGUSR1',
    public readonly engine: DebugEngine = DEFAULT_DEBUG_ENGINE,
  ) {
    super(
      `Sent ${signal} to PID ${pid} but ${engine} did not start listening on port ${port}. ` +
      `The Django process was likely not started with the debug bootstrap loaded.`
    );
    this.name = 'BootstrapNotLoadedError';
  }
}
