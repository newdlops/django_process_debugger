import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as net from 'net';
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
export const BOOTSTRAP_VERSION = '2026.07.13.2';
export type DebugpyEndpoint = TcpListeningEndpoint & { authToken?: string };
const ACTIVE_ENDPOINT_RECORD_VERSION = 3;
type BootstrapRuntimeState = {
  pid: number;
  version: string;
  engines?: DebugEngine[];
  activationVersion?: number;
  pythonExecutable?: string;
  runtimeId?: string;
  controlSocket?: string;
};
type CurrentBootstrapControlState = BootstrapRuntimeState & {
  runtimeId: string;
  controlSocket: string;
};
type HotReloadResultPayload = {
  requestId?: string;
  leaseId?: string;
  results: string[];
};

let hotReloadRequestSequence = 0;
const EXPERIMENTAL_AUTH_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const HOT_RELOAD_LEASE_ID_PATTERN = /^[0-9a-f]{64}$/;
const RUNTIME_ID_PATTERN = /^[0-9a-f]{64}$/i;

export const HOT_RELOAD_LEASE_TTL_MS = 15_000;
export const HOT_RELOAD_LEASE_HEARTBEAT_MS = 5_000;

export function isValidExperimentalAuthToken(value: unknown): value is string {
  return typeof value === 'string' && EXPERIMENTAL_AUTH_TOKEN_PATTERN.test(value);
}

export function isValidHotReloadLeaseId(value: unknown): value is string {
  return typeof value === 'string' && HOT_RELOAD_LEASE_ID_PATTERN.test(value);
}

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
 * Installs a private per-process control socket that starts the selected engine
 * on demand without sending a potentially fatal signal to the target PID.
 *
 * The generated bootstrap embeds the bundled debugpy path and imports the
 * installed native tracer companion when experimental mode is selected.
 *
 * Runtime state, endpoint, and hot-reload coordination files live in a private
 * per-user directory. Engine activation itself uses a PID-owned Unix socket so
 * PID reuse can only produce a safe connection failure, never a fatal signal.
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
function controlSocketPath(pid: number): string {
  return `${PORT_FILE_DIR}/${pid}.control.sock`;
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

function hotReloadLeaseFilePath(pid: number, leaseId: string): string {
  return `${PORT_FILE_DIR}/${pid}.hot-reload.${leaseId}.lease`;
}

function isFsError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isFsError(error, 'ENOENT')) { throw error; }
  }
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
        (candidate.version === 2 || candidate.version === 3)
        && typeof candidate.requestId === 'string'
        && Array.isArray(candidate.results)
        && candidate.results.every((entry) => typeof entry === 'string')
      ) {
        return {
          requestId: candidate.requestId,
          ...(typeof candidate.leaseId === 'string' ? { leaseId: candidate.leaseId } : {}),
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
    '        import traceback as _traceback',
    '',
    '        _PORT_FILE_DIR = ' + JSON.stringify(PORT_FILE_DIR),
    '        _LOG_FILE = _PORT_FILE_DIR + "/bootstrap.log"',
    '        _bootstrap_pid = _os.getpid()',
    '        _runtime_id = _os.urandom(32).hex()',
    '        _control_socket_path = f"{_PORT_FILE_DIR}/{_bootstrap_pid}.control.sock"',
    '        _control_server_socket = None',
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
    '                    _f.write(_json.dumps({',
    '                        "version": ' + JSON.stringify(BOOTSTRAP_VERSION) + ',',
    '                        "pid": _os.getpid(),',
    '                        "engines": ["debugpy", "experimental"],',
    '                        "activationVersion": 2,',
    '                        "pythonExecutable": _sys.executable,',
    '                        "runtimeId": _runtime_id,',
    '                        "controlSocket": _control_socket_path,',
    '                    }))',
    '                _os.chmod(_state_tmp, 0o600)',
    '                _os.replace(_state_tmp, _state_file)',
    '            except Exception as _e:',
    '                _dbg_log(f"Failed to write bootstrap state: {_e}")',
    '',
    '        import threading as _threading',
    '        import time as _time',
    '',
    '        _hot_reload_watcher_started = False',
    '        _hot_reload_thread = None',
    '        _hot_reload_leases = {}',
    '        _hot_reload_lock = _threading.RLock()',
    '        _hot_reload_wake_event = _threading.Event()',
    '        _hot_reload_signal = None',
    '        _hot_reload_receiver = None',
    '        _hot_reload_dispatch_uid = None',
    '        _hot_reload_autoreload_module = None',
    '        _hot_reload_trigger_wrapper = None',
    '        _hot_reload_original_trigger = None',
    '        _hot_reload_inherited_signal = None',
    '        _hot_reload_inherited_dispatch_uid = None',
    '        _engine_endpoints = {}',
    '        _activated_engine = None',
    '',
    '        def _reset_bootstrap_after_fork():',
    '            global _hot_reload_watcher_started, _hot_reload_thread, _hot_reload_leases',
    '            global _hot_reload_lock, _hot_reload_wake_event',
    '            global _hot_reload_signal, _hot_reload_receiver, _hot_reload_dispatch_uid',
    '            global _hot_reload_autoreload_module, _hot_reload_trigger_wrapper, _hot_reload_original_trigger',
    '            global _hot_reload_inherited_signal, _hot_reload_inherited_dispatch_uid',
    '            global _engine_endpoints, _activated_engine, _bootstrap_pid',
    '            global _runtime_id, _control_socket_path, _control_server_socket',
    '            # The child has no copy of parent daemon threads. Close the',
    '            # inherited descriptor and publish a fresh PID-owned identity',
    '            # and control socket before it can be attached.',
    '            _inherited_server = _control_server_socket',
    '            _control_server_socket = None',
    '            if _inherited_server is not None:',
    '                try:',
    '                    _inherited_server.close()',
    '                except Exception:',
    '                    pass',
    '            _bootstrap_pid = _os.getpid()',
    '            _runtime_id = _os.urandom(32).hex()',
    '            _control_socket_path = f"{_PORT_FILE_DIR}/{_bootstrap_pid}.control.sock"',
    '            _engine_endpoints = {}',
    '            _activated_engine = None',
    '            # Threads do not survive fork. Inherited suppression callbacks',
    '            # remain structurally installed, so make them fail open by',
    '            # clearing leases and changing the PID. A later child acquire',
    '            # removes the inert inherited signal receiver at a safe point.',
    '            _hot_reload_inherited_signal = _hot_reload_signal',
    '            _hot_reload_inherited_dispatch_uid = _hot_reload_dispatch_uid',
    '            _hot_reload_watcher_started = False',
    '            _hot_reload_thread = None',
    '            _hot_reload_leases = {}',
    '            _hot_reload_lock = _threading.RLock()',
    '            _hot_reload_wake_event = _threading.Event()',
    '            _hot_reload_signal = None',
    '            _hot_reload_receiver = None',
    '            _hot_reload_dispatch_uid = None',
    '            _hot_reload_autoreload_module = None',
    '            _hot_reload_trigger_wrapper = None',
    '            _hot_reload_original_trigger = None',
    '            try:',
    '                _start_activation_control_server()',
    '            except Exception as _e:',
    '                _dbg_log(f"Failed to restart activation control server after fork: {_e}")',
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
    '        def _hot_reload_lease_path(_lease_id):',
    '            return f"{_PORT_FILE_DIR}/{_os.getpid()}.hot-reload.{_lease_id}.lease"',
    '',
    '        def _prune_hot_reload_leases_locked():',
    '            """Remove missing/expired leases. Caller must hold the RLock."""',
    '            _now = _time.time()',
    '            for _lease_id, _ttl_seconds in list(_hot_reload_leases.items()):',
    '                _lease_file = _hot_reload_lease_path(_lease_id)',
    '                _fresh = False',
    '                try:',
    '                    _lease_stat = _os.stat(_lease_file)',
    '                    _fresh = (',
    '                        _lease_stat.st_uid == _os.getuid()',
    '                        and (_lease_stat.st_mode & 0o077) == 0',
    '                        and _now - _lease_stat.st_mtime <= _ttl_seconds',
    '                    )',
    '                except (FileNotFoundError, OSError):',
    '                    _fresh = False',
    '                if _fresh:',
    '                    continue',
    '                _hot_reload_leases.pop(_lease_id, None)',
    '                try:',
    '                    _os.unlink(_lease_file)',
    '                except FileNotFoundError:',
    '                    pass',
    '                except Exception as _e:',
    '                    _dbg_log(f"Could not remove expired hot reload lease: {_e}")',
    '                _dbg_log(f"Hot reload lease expired or released: {_lease_id[:12]}")',
    '            return bool(_hot_reload_leases)',
    '',
    '        def _hot_reload_lease_is_live(_lease_id=None):',
    '            if _os.getpid() != _bootstrap_pid:',
    '                return False',
    '            with _hot_reload_lock:',
    '                _prune_hot_reload_leases_locked()',
    '                if _lease_id is None:',
    '                    return bool(_hot_reload_leases)',
    '                return _lease_id in _hot_reload_leases',
    '',
    '        def _install_hot_reload_suppression_locked():',
    '            """Install reversible Django autoreloader hooks for this PID."""',
    '            global _hot_reload_signal, _hot_reload_receiver, _hot_reload_dispatch_uid',
    '            global _hot_reload_autoreload_module, _hot_reload_trigger_wrapper, _hot_reload_original_trigger',
    '            global _hot_reload_inherited_signal, _hot_reload_inherited_dispatch_uid',
    '            if _hot_reload_trigger_wrapper is not None or _hot_reload_receiver is not None:',
    '                return True',
    '            try:',
    '                import django.utils.autoreload as _autoreload_mod',
    '                _file_changed_signal = _autoreload_mod.file_changed',
    '            except ImportError:',
    '                # Celery and other supported Python targets may not import',
    '                # Django. Module hot reload remains useful without hooks.',
    '                _dbg_log("Django autoreloader unavailable; no suppression needed")',
    '                return True',
    '            except Exception as _e:',
    '                _dbg_log(f"Could not inspect Django autoreloader: {_e}")',
    '                return False',
    '',
    '            # A fork child can inherit the parent Signal receiver even though',
    '            # its thread and leases are gone. Remove that inert receiver now,',
    '            # outside the at-fork callback where Django locks are unsafe.',
    '            if _hot_reload_inherited_signal is not None and _hot_reload_inherited_dispatch_uid is not None:',
    '                try:',
    '                    _hot_reload_inherited_signal.disconnect(',
    '                        dispatch_uid=_hot_reload_inherited_dispatch_uid,',
    '                    )',
    '                except Exception as _e:',
    '                    _dbg_log(f"Could not remove inherited autoreload receiver: {_e}")',
    '                _hot_reload_inherited_signal = None',
    '                _hot_reload_inherited_dispatch_uid = None',
    '',
    '            _owner_pid = _os.getpid()',
    '            _dispatch_uid = f"django-process-debugger-hot-reload-{_owner_pid}"',
    '            _current_trigger = _autoreload_mod.trigger_reload',
    '            _original_trigger = getattr(',
    '                _current_trigger,',
    '                "_django_process_debugger_original_trigger",',
    '                _current_trigger,',
    '            )',
    '',
    '            def _suppress_autoreload(sender=None, file_path=None, **kwargs):',
    '                if _os.getpid() == _owner_pid and _hot_reload_lease_is_live():',
    '                    _dbg_log(f"Autoreload suppressed (signal): {file_path}")',
    '                    return True',
    '                return None',
    '',
    '            def _suppressed_trigger_reload(filename):',
    '                if _os.getpid() == _owner_pid and _hot_reload_lease_is_live():',
    '                    _dbg_log(f"Autoreload suppressed (trigger_reload): {filename}")',
    '                    return None',
    '                return _original_trigger(filename)',
    '',
    '            _suppressed_trigger_reload._django_process_debugger_original_trigger = _original_trigger',
    '            _suppressed_trigger_reload._django_process_debugger_owner_pid = _owner_pid',
    '            _signal_connected = False',
    '            try:',
    '                _file_changed_signal.connect(',
    '                    _suppress_autoreload,',
    '                    weak=False,',
    '                    dispatch_uid=_dispatch_uid,',
    '                )',
    '                _signal_connected = True',
    '                _autoreload_mod.trigger_reload = _suppressed_trigger_reload',
    '            except Exception as _e:',
    '                if _signal_connected:',
    '                    try:',
    '                        _file_changed_signal.disconnect(dispatch_uid=_dispatch_uid)',
    '                    except Exception:',
    '                        pass',
    '                if getattr(_autoreload_mod, "trigger_reload", None) is _suppressed_trigger_reload:',
    '                    _autoreload_mod.trigger_reload = _original_trigger',
    '                _dbg_log(f"Could not install Django autoreload suppression: {_e}")',
    '                return False',
    '',
    '            _hot_reload_signal = _file_changed_signal',
    '            _hot_reload_receiver = _suppress_autoreload',
    '            _hot_reload_dispatch_uid = _dispatch_uid',
    '            _hot_reload_autoreload_module = _autoreload_mod',
    '            _hot_reload_trigger_wrapper = _suppressed_trigger_reload',
    '            _hot_reload_original_trigger = _original_trigger',
    '            _dbg_log("Django autoreloader suppression installed")',
    '            return True',
    '',
    '        def _restore_hot_reload_suppression_locked():',
    '            """Restore only hooks still owned by this bootstrap instance."""',
    '            global _hot_reload_signal, _hot_reload_receiver, _hot_reload_dispatch_uid',
    '            global _hot_reload_autoreload_module, _hot_reload_trigger_wrapper, _hot_reload_original_trigger',
    '            if _hot_reload_signal is not None and _hot_reload_dispatch_uid is not None:',
    '                try:',
    '                    _hot_reload_signal.disconnect(dispatch_uid=_hot_reload_dispatch_uid)',
    '                except Exception as _e:',
    '                    _dbg_log(f"Could not disconnect autoreload receiver: {_e}")',
    '            if (',
    '                _hot_reload_autoreload_module is not None',
    '                and getattr(_hot_reload_autoreload_module, "trigger_reload", None) is _hot_reload_trigger_wrapper',
    '            ):',
    '                try:',
    '                    _hot_reload_autoreload_module.trigger_reload = _hot_reload_original_trigger',
    '                except Exception as _e:',
    '                    _dbg_log(f"Could not restore Django trigger_reload: {_e}")',
    '            _hot_reload_signal = None',
    '            _hot_reload_receiver = None',
    '            _hot_reload_dispatch_uid = None',
    '            _hot_reload_autoreload_module = None',
    '            _hot_reload_trigger_wrapper = None',
    '            _hot_reload_original_trigger = None',
    '            _dbg_log("Django autoreloader suppression restored")',
    '',
    '        def _acquire_hot_reload_lease(_lease_id, _ttl_ms):',
    '            if (',
    '                not isinstance(_lease_id, str)',
    '                or len(_lease_id) != 64',
    '                or any(_char not in "0123456789abcdef" for _char in _lease_id)',
    '            ):',
    '                _dbg_log("Rejected invalid hot reload lease ID")',
    '                return False',
    '            try:',
    '                _ttl_ms = int(_ttl_ms)',
    '            except Exception:',
    '                return False',
    '            if _ttl_ms < 500 or _ttl_ms > 120000:',
    '                _dbg_log(f"Rejected invalid hot reload TTL: {_ttl_ms}")',
    '                return False',
    '            with _hot_reload_lock:',
    '                _hot_reload_leases[_lease_id] = _ttl_ms / 1000.0',
    '                if not _hot_reload_lease_is_live(_lease_id):',
    '                    _dbg_log("Rejected missing or stale hot reload lease file")',
    '                    return False',
    '            if not _start_hot_reload_watcher():',
    '                with _hot_reload_lock:',
    '                    _hot_reload_leases.pop(_lease_id, None)',
    '                    if not _hot_reload_leases:',
    '                        _restore_hot_reload_suppression_locked()',
    '                return False',
    '            _hot_reload_wake_event.set()',
    '            _dbg_log(f"Hot reload lease acquired: {_lease_id[:12]} ttl={_ttl_ms}ms")',
    '            return True',
    '',
    '        def _start_hot_reload_watcher():',
    '            """Start a daemon thread that watches for module reload requests."""',
    '            global _hot_reload_watcher_started, _hot_reload_thread',
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
    '            with _hot_reload_lock:',
    '                if not _prune_hot_reload_leases_locked():',
    '                    return False',
    '                if _hot_reload_thread is not None and _hot_reload_thread.is_alive():',
    '                    if not _install_hot_reload_suppression_locked():',
    '                        return False',
    '                    return True',
    '                if not _install_hot_reload_suppression_locked():',
    '                    return False',
    '                _hot_reload_watcher_started = True',
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
    '            def _publish_reload_result(_request_id, _results, _lease_id=None):',
    '                _result_tmp = (',
    '                    _reload_result_file',
    '                    + "."',
    '                    + str(threading.get_ident())',
    '                    + ".tmp"',
    '                )',
    '                _payload = (',
    '                    json.dumps({',
    '                        "version": 3 if _lease_id is not None else 2,',
    '                        "requestId": _request_id,',
    '                        **({"leaseId": _lease_id} if _lease_id is not None else {}),',
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
    '                global _hot_reload_watcher_started, _hot_reload_thread',
    '                # The experimental tracer installs threading.settrace().',
    '                # Reload implementation details must not hit application',
    '                # breakpoints or Raised filters on this internal thread.',
    '                if _activated_engine == "experimental":',
    '                    try:',
    '                        _sys.settrace(None)',
    '                    except Exception:',
    '                        pass',
    '                try:',
    '                    while True:',
    '                        _request_id = None',
    '                        _lease_id = None',
    '                        _claimed = False',
    '                        _hot_reload_wake_event.wait(0.3)',
    '                        _hot_reload_wake_event.clear()',
    '                        with _hot_reload_lock:',
    '                            if not _prune_hot_reload_leases_locked():',
    '                                break',
    '                        try:',
    '                            try:',
    '                                _os.replace(_reload_file, _reload_processing_file)',
    '                                _claimed = True',
    '                            except FileNotFoundError:',
    '                                continue',
    '                            with open(_reload_processing_file) as _f:',
    '                                _raw_request = _f.read()',
    '',
    '                            _request = json.loads(_raw_request)',
    '                            if isinstance(_request, dict) and _request.get("version") == 3:',
    '                                _request_id = _request.get("requestId")',
    '                                _lease_id = _request.get("leaseId")',
    '                                _paths = _request.get("paths")',
    '                                if (',
    '                                    not isinstance(_request_id, str)',
    '                                    or not isinstance(_lease_id, str)',
    '                                    or not isinstance(_paths, list)',
    '                                ):',
    '                                    raise ValueError("Invalid hot reload v3 request")',
    '                                if not all(isinstance(_p, str) for _p in _paths):',
    '                                    raise ValueError("Invalid hot reload path")',
    '                                if not _hot_reload_lease_is_live(_lease_id):',
    '                                    raise ValueError("Inactive hot reload lease")',
    '                                _paths = [_p for _p in _paths if _p]',
    '                            else:',
    '                                raise ValueError("Hot reload request requires an active v3 lease")',
    '                            if not _paths:',
    '                                _publish_reload_result(_request_id, [], _lease_id)',
    '                                _clear_reload_claim()',
    '                                _claimed = False',
    '                                continue',
    '',
    '                            importlib.invalidate_caches()',
    '                            _results = []',
    '',
    '                            for _fpath in _paths:',
    '                                _found = False',
    '                                _abs_fpath = _os.path.abspath(_fpath)',
    '                                for _name, _mod in list(_sys.modules.items()):',
    '                                    _mod_file = getattr(_mod, "__file__", None)',
    '                                    if not _mod_file:',
    '                                        continue',
    '                                    _abs_mod = _os.path.abspath(_mod_file)',
    '                                    if _abs_mod.endswith(".pyc"):',
    '                                        _abs_mod = _abs_mod[:-1]',
    '                                    if _abs_mod == _abs_fpath:',
    '                                        try:',
    '                                            _patched = _deep_reload_module(_mod)',
    '                                            _patch_list = ", ".join(_patched) if _patched else ""',
    '                                            _patch_info = f" (patched: {_patch_list})" if _patched else ""',
    '                                            _msg = f"OK:{_name}{_patch_info}"',
    '                                            _dbg_log(f"Hot reloaded: {_name}{_patch_info}")',
    '                                            _results.append(_msg)',
    '                                        except BaseException as _e:',
    '                                            _msg = f"ERR:{_name}:{type(_e).__name__}:{_e}"',
    '                                            _dbg_log(f"Reload failed: {_name}: {_e}")',
    '                                            _results.append(_msg)',
    '                                        _found = True',
    '                                        break',
    '                                if not _found:',
    '                                    _msg = f"SKIP:{_fpath}"',
    '                                    _dbg_log(f"No loaded module for: {_fpath}")',
    '                                    _results.append(_msg)',
    '',
    '                            _publish_reload_result(_request_id, _results, _lease_id)',
    '                            _clear_reload_claim()',
    '                            _claimed = False',
    '',
    '                        except BaseException as _e:',
    '                            _dbg_log(f"Reload watcher error: {_e}")',
    '                            try:',
    '                                _publish_reload_result(',
    '                                    _request_id,',
    '                                    [f"ERR:protocol:{type(_e).__name__}:{_e}"],',
    '                                    _lease_id,',
    '                                )',
    '                            except Exception:',
    '                                pass',
    '                            finally:',
    '                                if _claimed:',
    '                                    _clear_reload_claim()',
    '                finally:',
    '                    with _hot_reload_lock:',
    '                        if _hot_reload_thread is threading.current_thread():',
    '                            _hot_reload_thread = None',
    '                        _hot_reload_watcher_started = False',
    '                        _still_active = _prune_hot_reload_leases_locked()',
    '                        if not _still_active:',
    '                            try:',
    '                                _os.unlink(_reload_file)',
    '                            except FileNotFoundError:',
    '                                pass',
    '                            except Exception as _e:',
    '                                _dbg_log(f"Could not remove inactive reload request: {_e}")',
    '                            _restore_hot_reload_suppression_locked()',
    '                    _dbg_log("Hot reload watcher stopped")',
    '                    if _still_active:',
    '                        _start_hot_reload_watcher()',
    '',
    '            _t = threading.Thread(target=_reload_watcher, daemon=True, name="django-debug-hot-reload")',
    '            # Keep debugger internals from tracing/suspending this lifecycle',
    '            # worker. The filesystem lease remains the crash fallback.',
    '            _t.pydev_do_not_trace = True',
    '            _t.is_pydev_daemon_thread = True',
    '            _t.django_debugger_do_not_trace = True',
    '            with _hot_reload_lock:',
    '                if not _prune_hot_reload_leases_locked():',
    '                    _hot_reload_watcher_started = False',
    '                    _restore_hot_reload_suppression_locked()',
    '                    return False',
    '                _hot_reload_thread = _t',
    '                try:',
    '                    _t.start()',
    '                except Exception:',
    '                    _hot_reload_thread = None',
    '                    _hot_reload_watcher_started = False',
    '                    _restore_hot_reload_suppression_locked()',
    '                    raise',
    '            _dbg_log("Hot reload watcher started")',
    '            return True',
    '',
    '        def _django_debugger_activation_handler(_request_content):',
    '            global _engine_endpoints, _activated_engine, _bootstrap_pid',
    '            _current_pid = _os.getpid()',
    '            if _bootstrap_pid != _current_pid:',
    '                # A child without a completed at-fork reset must fail closed.',
    '                _dbg_log("Rejected activation on an uninitialized fork child")',
    '                return False',
    '            _dbg_log("Authenticated control request received from private socket")',
    '            _write_bootstrap_state()',
    '            _pid = _os.getpid()',
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
    '                            if _parsed.get("version") != ' + JSON.stringify(ACTIVE_ENDPOINT_RECORD_VERSION) + ':',
    '                                return None',
    '                            _recorded_engine = _parsed.get("engine")',
    '                            if _recorded_engine != _expected_engine:',
    '                                return None',
    '                            if _parsed.get("pid") != _pid:',
    '                                return None',
    '                            if _parsed.get("runtimeId") != _runtime_id:',
    '                                return None',
    '                            if _parsed.get("bootstrapVersion") != ' + JSON.stringify(BOOTSTRAP_VERSION) + ':',
    '                                return None',
    '                            _recorded_host = _parsed.get("host")',
    '                            _recorded_port = _parsed.get("port")',
    '                            if not isinstance(_recorded_host, str) or not _recorded_host:',
    '                                return None',
    '                            if isinstance(_recorded_port, bool) or not isinstance(_recorded_port, int):',
    '                                return None',
    '                            if _recorded_port <= 0 or _recorded_port > 65535:',
    '                                return None',
    '                            _recorded_auth_token = _parsed.get("authToken")',
    '                            if _expected_engine == "experimental":',
    '                                if not isinstance(_recorded_auth_token, str) or len(_recorded_auth_token) != 64:',
    '                                    return None',
    '                                if any(_char not in "0123456789abcdef" for _char in _recorded_auth_token):',
    '                                    return None',
    '                            else:',
    '                                _recorded_auth_token = None',
    '                            return (_recorded_host, _recorded_port, _recorded_auth_token)',
    '                    except Exception:',
    '                        pass',
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
    '            def _write_active_endpoint(_file_path, _engine_name, _host, _port_value, _auth_token=None):',
    '                import json as _json',
    '                _tmp_file = _file_path + ".tmp"',
    '                _payload = {',
    '                    "version": ' + JSON.stringify(ACTIVE_ENDPOINT_RECORD_VERSION) + ',',
    '                    "engine": _engine_name,',
    '                    "host": _host,',
    '                    "port": _port_value,',
    '                    "pid": _pid,',
    '                    "runtimeId": _runtime_id,',
    '                    "bootstrapVersion": ' + JSON.stringify(BOOTSTRAP_VERSION) + ',',
    '                }',
    '                if _engine_name == "experimental":',
    '                    _payload["authToken"] = _auth_token',
    '                with open(_tmp_file, "w") as _f:',
    '                    _f.write(_json.dumps(_payload))',
    '                _os.chmod(_tmp_file, 0o600)',
    '                _os.replace(_tmp_file, _file_path)',
    '',
    '            # Parse and authenticate the versioned activation request. The',
    '            # runtime ID changes on every process start and after every fork.',
    '            _engine = "debugpy"',
    '            _port = 5678',
    '            _auth_token = None',
    '            try:',
    '                import json as _json',
    '                import hmac as _hmac',
    '                _request = _json.loads(_request_content)',
    '                if not isinstance(_request, dict):',
    '                    raise ValueError("activation request must be an object")',
    '                if int(_request.get("version", 0)) != 2:',
    '                    raise ValueError("unsupported activation request version")',
    '                _request_runtime_id = _request.get("runtimeId")',
    '                if not isinstance(_request_runtime_id, str) or not _hmac.compare_digest(_request_runtime_id, _runtime_id):',
    '                    raise ValueError("activation runtime identity mismatch")',
    '                _action = _request.get("action", "activate")',
    '                if _action == "hotReloadLease":',
    '                    return _acquire_hot_reload_lease(',
    '                        _request.get("leaseId"),',
    '                        _request.get("ttlMs"),',
    '                    )',
    '                if _action != "activate":',
    '                    raise ValueError(f"unsupported control action: {_action}")',
    '                _requested_engine = _request.get("engine", "debugpy")',
    '                if _requested_engine not in ("debugpy", "experimental"):',
    '                    raise ValueError(f"unsupported debug engine: {_requested_engine}")',
    '                _engine = _requested_engine',
    '                _port = int(_request.get("port", 5678))',
    '                if _port < 0 or _port > 65535:',
    '                    raise ValueError(f"invalid debug port: {_port}")',
    '                if _engine == "experimental":',
    '                    _auth_token = _request.get("authToken")',
    '                    if not isinstance(_auth_token, str) or len(_auth_token) != 64:',
    '                        raise ValueError("missing or invalid experimental DAP authentication")',
    '                    if any(_char not in "0123456789abcdef" for _char in _auth_token):',
    '                        raise ValueError("missing or invalid experimental DAP authentication")',
    '                _dbg_log(f"Read activation request engine={_engine} port={_port}")',
    '            except Exception as _e:',
    '                _dbg_log(f"Invalid activation request: {_e}")',
    '                return False',
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
    '                        _write_active_endpoint(_active_file_for(_engine), _engine, _owned_endpoint[0], _owned_endpoint[1], _owned_endpoint[2])',
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
    '                        _write_active_endpoint(_active_file, _engine, _stored_endpoint[0], _stored_endpoint[1], _stored_endpoint[2])',
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
    '                    _listen_result = _experimental_tracer.start("127.0.0.1", _port, auth_token=_auth_token)',
    '                _host = "127.0.0.1"',
    '                _actual_port = _port',
    '                if isinstance(_listen_result, (tuple, list)) and len(_listen_result) >= 2:',
    '                    _host = str(_listen_result[0])',
    '                    _actual_port = int(_listen_result[1])',
    '                _write_active_endpoint(_active_file, _engine, _host, _actual_port, _auth_token)',
    '                _engine_endpoints[_engine] = (_host, _actual_port, _auth_token)',
    '                _dbg_log(f"{_engine} listening on {_host}:{_actual_port}")',
    '            except RuntimeError as _e:',
    '                if "already" in str(_e).lower():',
    '                    _dbg_log(f"{_engine} already listening: {_e}")',
    '                else:',
    '                    _dbg_log(f"{_engine} RuntimeError: {_e}\\n{_traceback.format_exc()}")',
    '            except Exception as _e:',
    '                _dbg_log(f"{_engine} ERROR: {_e}\\n{_traceback.format_exc()}")',
    '',
    '        def _start_activation_control_server():',
    '            global _control_server_socket',
    '            import socket as _socket',
    '            import threading as _threading',
    '            _owner_pid = _os.getpid()',
    '            try:',
    '                _os.unlink(_control_socket_path)',
    '            except FileNotFoundError:',
    '                pass',
    '            _server = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)',
    '            try:',
    '                _server.bind(_control_socket_path)',
    '                _os.chmod(_control_socket_path, 0o600)',
    '                _server.listen(4)',
    '            except Exception:',
    '                _server.close()',
    '                raise',
    '            _control_server_socket = _server',
    '            _write_bootstrap_state()',
    '',
    '            def _activation_control_loop():',
    '                while _os.getpid() == _owner_pid and _control_server_socket is _server:',
    '                    try:',
    '                        _connection, _ = _server.accept()',
    '                    except OSError:',
    '                        break',
    '                    try:',
    '                        _connection.settimeout(2.0)',
    '                        _request_bytes = b""',
    '                        while len(_request_bytes) <= 65536:',
    '                            _chunk = _connection.recv(4096)',
    '                            if not _chunk:',
    '                                break',
    '                            _request_bytes += _chunk',
    '                            if b"\\n" in _request_bytes:',
    '                                _request_bytes = _request_bytes.split(b"\\n", 1)[0]',
    '                                break',
    '                        if not _request_bytes or len(_request_bytes) > 65536:',
    '                            raise ValueError("empty or oversized activation request")',
    '                        _request_text = _request_bytes.decode("utf-8")',
    '                        _is_lease_request = False',
    '                        try:',
    '                            import json as _json',
    '                            _request_preview = _json.loads(_request_text)',
    '                            _is_lease_request = (',
    '                                isinstance(_request_preview, dict)',
    '                                and _request_preview.get("action") == "hotReloadLease"',
    '                            )',
    '                        except Exception:',
    '                            pass',
    '                        if _is_lease_request:',
    '                            # Lease acquire must be acknowledged only after its',
    '                            # runtime identity, lease file, TTL, and hooks are',
    '                            # validated. Engine activation keeps its early ack',
    '                            # because debugger startup can take several seconds.',
    '                            _accepted = _django_debugger_activation_handler(_request_text)',
    '                            _connection.sendall(b"accepted\\n" if _accepted else b"rejected\\n")',
    '                        else:',
    '                            _connection.sendall(b"accepted\\n")',
    '                            _django_debugger_activation_handler(_request_text)',
    '                    except Exception as _e:',
    '                        _dbg_log(f"Control request failed: {_e}")',
    '                    finally:',
    '                        try:',
    '                            _connection.close()',
    '                        except Exception:',
    '                            pass',
    '',
    '            _thread = _threading.Thread(',
    '                target=_activation_control_loop,',
    '                daemon=True,',
    '                name="django-debug-activation",',
    '            )',
    '            _thread.django_debugger_do_not_trace = True',
    '            _thread.start()',
    '            _dbg_log(f"Private activation control socket listening: {_control_socket_path}")',
    '',
    '        _dbg_log("Bootstrap module loaded, starting private activation control socket")',
    '        _start_activation_control_server()',
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
   * Long-running supported processes publish a private activation socket.
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
   * Production callers provide a live lease and publish a correlated v3
   * request. Omitting the lease retains the v2 transport used by isolated
   * reload harness tests; a production bootstrap rejects it.
   */
  async requestHotReload(
    pid: number,
    filePaths: string[],
    leaseId?: string,
  ): Promise<string | null> {
    if (filePaths.length === 0) { return null; }
    if (leaseId !== undefined && !isValidHotReloadLeaseId(leaseId)) {
      throw new TypeError('Hot reload lease ID must be 64 lowercase hexadecimal characters');
    }
    await ensurePrivatePortFileDir();
    const requestId = nextHotReloadRequestId(pid);
    const requestFile = reloadFilePath(pid);
    const temporaryFile = `${requestFile}.${requestId}.tmp`;
    const payload = JSON.stringify({
      version: leaseId === undefined ? 2 : 3,
      requestId,
      ...(leaseId === undefined ? {} : { leaseId }),
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
    } catch (error) {
      try {
        await unlinkIfExists(temporaryFile);
      } catch (cleanupError) {
        logError(`[Injector] Failed to remove unpublished reload request ${temporaryFile}`, cleanupError);
      }
      throw error;
    }
    await unlinkIfExists(temporaryFile);
    log(
      `[Injector] Hot reload requested for PID=${pid}, request=${requestId}: `
      + filePaths.join(', '),
    );
    return requestId;
  }

  /**
   * Register a target-side hot-reload lease after publishing its private lease
   * file. The target installs Django suppression only after both the runtime
   * identity and fresh lease file have been validated.
   */
  async acquireHotReloadLease(
    pid: number,
    leaseId: string,
    ttlMs: number = HOT_RELOAD_LEASE_TTL_MS,
  ): Promise<void> {
    this.validateHotReloadLeaseArguments(pid, leaseId, ttlMs);
    const state = await this.requireCurrentBootstrapControlState(pid);
    await this.renewHotReloadLease(pid, leaseId, ttlMs);
    try {
      await this.sendControlRequest(state.controlSocket, {
        version: 2,
        runtimeId: state.runtimeId,
        action: 'hotReloadLease',
        leaseId,
        ttlMs,
      }, pid);
    } catch (error) {
      await this.releaseHotReloadLease(pid, leaseId);
      throw error;
    }
  }

  /**
   * Renew a lease using only an atomic private-file replacement. This stays
   * operational even when a debugger has suspended every Python thread.
   */
  async renewHotReloadLease(
    pid: number,
    leaseId: string,
    ttlMs: number = HOT_RELOAD_LEASE_TTL_MS,
  ): Promise<void> {
    this.validateHotReloadLeaseArguments(pid, leaseId, ttlMs);
    await ensurePrivatePortFileDir();
    const leaseFile = hotReloadLeaseFilePath(pid, leaseId);
    const temporaryFile = leaseFile + '.' + process.pid + '.'
      + randomBytes(8).toString('hex') + '.tmp';
    const payload = JSON.stringify({
      version: 1,
      pid,
      leaseId,
      ttlMs,
      renewedAt: Date.now(),
    });
    try {
      await fs.writeFile(temporaryFile, payload, {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      });
      await fs.chmod(temporaryFile, 0o600);
      await fs.rename(temporaryFile, leaseFile);
    } catch (error) {
      try {
        await unlinkIfExists(temporaryFile);
      } catch (cleanupError) {
        logError(`[Injector] Failed to remove unpublished hot-reload lease ${temporaryFile}`, cleanupError);
      }
      throw error;
    }
    await unlinkIfExists(temporaryFile);
  }

  /** Release is filesystem-only; TTL remains the crash fallback. */
  async releaseHotReloadLease(pid: number, leaseId: string): Promise<void> {
    this.validateHotReloadLeaseArguments(pid, leaseId, HOT_RELOAD_LEASE_TTL_MS);
    try {
      await fs.unlink(hotReloadLeaseFilePath(pid, leaseId));
    } catch (error) {
      if (!isFsError(error, 'ENOENT')) { throw error; }
    }
  }

  /**
   * Read the result of the last hot reload request.
   * Returns result rows (OK:module, ERR:module:reason, SKIP:path). When an
   * expected id is provided, a stale result is left untouched.
   */
  async readReloadResult(
    pid: number,
    expectedRequestId?: string,
    expectedLeaseId?: string,
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
    if (
      expectedLeaseId !== undefined
      && payload.leaseId !== expectedLeaseId
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
    expectedLeaseId?: string,
  ): Promise<string[] | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs && signal?.aborted !== true) {
      const result = await this.readReloadResult(
        pid,
        expectedRequestId,
        expectedLeaseId,
      );
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
  async isReloadPending(
    pid: number,
    expectedRequestId?: string,
    expectedLeaseId?: string,
  ): Promise<boolean> {
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
          if (
            (parsed.version === 2 || parsed.version === 3)
            && parsed.requestId === expectedRequestId
            && (
              expectedLeaseId === undefined
              || parsed.leaseId === expectedLeaseId
            )
          ) {
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
    const runtimeState = await this.readBootstrapState(pid);
    if (runtimeState?.pythonExecutable) {
      log(
        `[Injector] Using Python executable published by target PID=${pid}: ` +
        runtimeState.pythonExecutable
      );
      return runtimeState.pythonExecutable;
    }

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

  /** Verify that the target runtime's exact Python can import the bootstrap. */
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
      const runtimeState = await this.getLoadedBootstrapState(pid);
      if (
        !runtimeState
        || runtimeState.version !== BOOTSTRAP_VERSION
        || runtimeState.activationVersion !== 2
        || typeof runtimeState.runtimeId !== 'string'
        || !RUNTIME_ID_PATTERN.test(runtimeState.runtimeId)
        || runtimeState.controlSocket !== controlSocketPath(pid)
      ) {
        await fs.unlink(activeFile).catch(() => {});
        return null;
      }

      const content = await fs.readFile(activeFile, 'utf-8');
      const recorded = this.parseActiveFile(content, engine, pid, runtimeState.runtimeId);
      if (recorded) {
        // The experimental server lives inside the target process, so require
        // PID ownership. debugpy listens from its adapter child process and
        // therefore must continue to resolve by recorded host/port.
        const endpoint = engine === 'experimental'
          ? await this.findListeningEndpoint(recorded.port, pid, recorded.host)
          : recorded.host
            ? await this.findListeningEndpoint(recorded.port, undefined, recorded.host)
            : await this.findListeningEndpoint(recorded.port);
        const pidOwnedEndpoint = endpoint
          ? null
          : await this.findListeningEndpoint(recorded.port, pid);
        if (!endpoint && pidOwnedEndpoint) {
          log(
            `[Injector] ${engine} endpoint host ${recorded.host ?? 'unknown'} for PID=${pid} ` +
            `resolved through PID-owned listener ${formatEndpoint(pidOwnedEndpoint)}`
          );
        }
        const resolvedEndpoint = endpoint ?? pidOwnedEndpoint;
        if (resolvedEndpoint) {
          // Resolving a listener can take long enough for a PID to exit and be
          // reused. Re-read the identity immediately before returning it.
          const currentState = await this.getLoadedBootstrapState(pid);
          if (
            currentState?.version !== BOOTSTRAP_VERSION
            || currentState.activationVersion !== 2
            || currentState.runtimeId !== runtimeState.runtimeId
            || currentState.controlSocket !== controlSocketPath(pid)
          ) {
            await fs.unlink(activeFile).catch(() => {});
            return null;
          }
          return recorded.authToken
            ? { ...resolvedEndpoint, authToken: recorded.authToken }
            : resolvedEndpoint;
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
    expectedEngine: DebugEngine,
    expectedPid: number,
    expectedRuntimeId: string,
  ): { host?: string; port: number; authToken?: string } | null {
    try {
      const parsed = JSON.parse(content.trim()) as {
        version?: unknown;
        engine?: unknown;
        host?: unknown;
        port?: unknown;
        pid?: unknown;
        runtimeId?: unknown;
        bootstrapVersion?: unknown;
        authToken?: unknown;
      };
      if (
        parsed.version !== ACTIVE_ENDPOINT_RECORD_VERSION
        || parsed.engine !== expectedEngine
        || parsed.pid !== expectedPid
        || parsed.runtimeId !== expectedRuntimeId
        || parsed.bootstrapVersion !== BOOTSTRAP_VERSION
        || typeof parsed.host !== 'string'
        || parsed.host.length === 0
        || typeof parsed.port !== 'number'
        || !Number.isInteger(parsed.port)
        || parsed.port <= 0
        || parsed.port > 65_535
      ) {
        return null;
      }
      if (
        expectedEngine === 'experimental'
        && !isValidExperimentalAuthToken(parsed.authToken)
      ) {
        return null;
      }
      return {
        host: parsed.host,
        port: parsed.port,
        ...(expectedEngine === 'experimental'
          ? { authToken: parsed.authToken as string }
          : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * Activate a debug engine through the target's private Unix control socket.
   * If that engine is already active, returns the existing endpoint.
   *
   * The direct PID state, per-runtime random identity, and live socket are all
   * required. A stale state file or PID reuse therefore fails without sending
   * any process signal.
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

    const loadedBootstrapState = await this.getLoadedBootstrapState(pid);
    const loadedBootstrapVersion = loadedBootstrapState?.version ?? null;
    if (!loadedBootstrapState || loadedBootstrapVersion !== BOOTSTRAP_VERSION) {
      log(
        `[Injector] Target PID=${pid} loaded bootstrap version ` +
        `${loadedBootstrapVersion ?? 'unknown'}, expected ${BOOTSTRAP_VERSION}`
      );
      throw new BootstrapRuntimeVersionError(pid, loadedBootstrapVersion, BOOTSTRAP_VERSION);
    }
    if (
      loadedBootstrapState.activationVersion !== 2
      || !loadedBootstrapState.pythonExecutable
      || !path.isAbsolute(loadedBootstrapState.pythonExecutable)
      || !loadedBootstrapState.runtimeId
      || !/^[0-9a-f]{64}$/i.test(loadedBootstrapState.runtimeId)
      || loadedBootstrapState.controlSocket !== controlSocketPath(pid)
    ) {
      throw new BootstrapRuntimeIdentityError(pid);
    }
    log(`[Injector] Target PID=${pid} published a current private activation identity`);

    // Verify the exact interpreter published by the live target. In particular,
    // sys.executable retains a venv path on macOS even when ps/lsof show the
    // kernel-resolved base interpreter.
    const pythonPath = loadedBootstrapState.pythonExecutable;
    const bootstrapReady = await this.verifyBootstrapLoaded(pythonPath);
    if (!bootstrapReady) {
      log(`[Injector] Bootstrap module not importable from target runtime ${pythonPath}`);
      throw new BootstrapNotInstalledError(pid);
    }
    log(`[Injector] Bootstrap module verified using target runtime ${pythonPath}`);

    const authToken = engine === 'experimental'
      ? randomBytes(32).toString('hex')
      : undefined;
    const activationRequest = {
      version: 2 as const,
      runtimeId: loadedBootstrapState.runtimeId,
      engine,
      port,
      ...(authToken ? { authToken } : {}),
    };
    log(
      `[Injector] Sending authenticated ${engine} activation over ` +
      `${loadedBootstrapState.controlSocket}`
    );
    await this.sendControlRequest(loadedBootstrapState.controlSocket, activationRequest, pid);

    // Wait for the target process to publish a live active endpoint.
    log(`[Injector] Waiting for ${engine} active endpoint on port ${port}...`);
    const endpoint = await this.waitForActiveEndpoint(pid, port, 5000, engine);
    if (!endpoint) {
      const racedConflict = await this.getActiveEndpoint(pid, conflictingEngine);
      if (racedConflict !== null) {
        throw new DebugEngineConflictError(pid, engine, conflictingEngine, racedConflict);
      }
      log(`[Injector] ${engine} endpoint for PID=${pid} port=${port} not available after activation`);
      throw new BootstrapNotLoadedError(pid, port, engine);
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

  private validateHotReloadLeaseArguments(
    pid: number,
    leaseId: string,
    ttlMs: number,
  ): void {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new RangeError('Hot reload PID must be a positive integer');
    }
    if (!isValidHotReloadLeaseId(leaseId)) {
      throw new TypeError('Hot reload lease ID must be 64 lowercase hexadecimal characters');
    }
    if (!Number.isInteger(ttlMs) || ttlMs < 500 || ttlMs > 120_000) {
      throw new RangeError('Hot reload lease TTL must be between 500 and 120000ms');
    }
  }

  private async requireCurrentBootstrapControlState(
    pid: number,
  ): Promise<CurrentBootstrapControlState> {
    this.verifyProcessAlive(pid);
    const state = await this.getLoadedBootstrapState(pid);
    if (!state || state.version !== BOOTSTRAP_VERSION) {
      throw new BootstrapRuntimeVersionError(pid, state?.version ?? null, BOOTSTRAP_VERSION);
    }
    if (
      state.activationVersion !== 2
      || typeof state.runtimeId !== 'string'
      || !/^[0-9a-f]{64}$/i.test(state.runtimeId)
      || state.controlSocket !== controlSocketPath(pid)
    ) {
      throw new BootstrapRuntimeIdentityError(pid);
    }
    return state as CurrentBootstrapControlState;
  }

  private async getLoadedBootstrapState(pid: number): Promise<BootstrapRuntimeState | null> {
    // An ancestor state is not proof that a child retained Python handlers: the
    // child may have exec'd an unrelated program. Fork-aware bootstraps publish
    // a fresh direct state and control socket for every child instead.
    return this.readBootstrapState(pid);
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
        pythonExecutable?: unknown;
        runtimeId?: unknown;
        controlSocket?: unknown;
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
      if (typeof parsed.pythonExecutable === 'string' && parsed.pythonExecutable.length > 0) {
        state.pythonExecutable = parsed.pythonExecutable;
      }
      if (typeof parsed.runtimeId === 'string' && parsed.runtimeId.length > 0) {
        state.runtimeId = parsed.runtimeId;
      }
      if (typeof parsed.controlSocket === 'string' && parsed.controlSocket.length > 0) {
        state.controlSocket = parsed.controlSocket;
      }
      return state;
    } catch {
      return null;
    }
  }

  private async sendControlRequest(
    socketPath: string,
    request: Record<string, unknown>,
    pid: number,
  ): Promise<void> {
    const payload = `${JSON.stringify(request)}\n`;

    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ path: socketPath });
        let response = '';
        let settled = false;
        const timer = setTimeout(() => {
          finish(new Error('timed out waiting for control acknowledgement'));
        }, 3_000);

        const finish = (error?: Error): void => {
          if (settled) { return; }
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          if (error) { reject(error); }
          else { resolve(); }
        };

        socket.setEncoding('utf-8');
        socket.once('connect', () => socket.write(payload));
        socket.on('data', (chunk: string) => {
          response += chunk;
          if (response.includes('\n')) {
            if (response.split('\n', 1)[0] === 'accepted') {
              finish();
            } else {
              finish(new Error('target rejected the control request'));
            }
          }
        });
        socket.once('error', (error) => finish(error));
        socket.once('close', () => {
          if (!settled) {
            finish(new Error('control socket closed before acknowledgement'));
          }
        });
      });
    } catch (error) {
      throw new BootstrapControlChannelError(
        pid,
        error instanceof Error ? error : new Error(String(error)),
      );
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
        if (expectedPort === 0) {
          log(
            `[Injector] ${engine} selected dynamic endpoint ${formatEndpoint(endpoint)} ` +
            `for PID=${pid}`
          );
        } else if (endpoint.port !== expectedPort) {
          log(
            `[Injector] Reusing existing ${engine} endpoint ${formatEndpoint(endpoint)} ` +
            `for PID=${pid}; requested port was ${expectedPort}`
          );
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

export class DebugEngineConflictError extends Error {
  public readonly activeEndpoint: DebugpyEndpoint;

  constructor(
    public readonly pid: number,
    public readonly requestedEngine: DebugEngine,
    public readonly activeEngine: DebugEngine,
    activeEndpoint: DebugpyEndpoint,
  ) {
    super(
      `Cannot activate ${requestedEngine} for PID ${pid} because ${activeEngine} is already active ` +
      `on ${formatEndpoint(activeEndpoint)}. Restart the target process before switching debug engines.`
    );
    this.name = 'DebugEngineConflictError';
    this.activeEndpoint = { host: activeEndpoint.host, port: activeEndpoint.port };
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

export class BootstrapRuntimeIdentityError extends Error {
  constructor(public readonly pid: number) {
    super(
      `Target PID ${pid} did not publish a valid private activation identity. ` +
      `Restart the target process after running setup with the current extension.`
    );
    this.name = 'BootstrapRuntimeIdentityError';
  }
}

export class BootstrapControlChannelError extends Error {
  constructor(
    public readonly pid: number,
    public readonly cause: Error,
  ) {
    super(
      `Could not reach the private activation channel for target PID ${pid}: ${cause.message}. ` +
      `The PID may have exited or been reused; no process signal was sent.`
    );
    this.name = 'BootstrapControlChannelError';
  }
}

export class BootstrapNotLoadedError extends Error {
  constructor(
    public readonly pid: number,
    public readonly port: number,
    public readonly engine: DebugEngine = DEFAULT_DEBUG_ENGINE,
  ) {
    super(
      `Target PID ${pid} accepted the private activation request, but ${engine} did not start ` +
      `listening on port ${port}. Check the bootstrap log for the engine startup error.`
    );
    this.name = 'BootstrapNotLoadedError';
  }
}
