#!/usr/bin/env python3
"""E2E hot-reload harness.

Replicates the reload-watcher protocol AND the deep-reload logic implemented
by the real bootstrap (src/debugpyInjector.ts :: makeBootstrapScript) so we can
exercise the full edit-trigger-result cycle from a test without starting debugpy.

Protocol:
  1. Extension writes absolute file paths to /tmp/django-process-debugger/PID.reload
     (one per line).
  2. Watcher polls every RELOAD_POLL_SEC seconds.
  3. On each pass, if the .reload file exists, it is read and unlinked; paths
     are matched to loaded modules by __file__, and each is deep-reloaded.
  4. Results written to /tmp/django-process-debugger/PID.reload.result:
       OK:module.name (patched: ClassA.method1, ClassA.method2)
       ERR:module.name:Exception text
       SKIP:/absolute/path

Deep-reload semantics (must match bootstrap):
  - BEFORE importlib.reload, walk mod.__dict__ and follow __wrapped__ AND
    __closure__ cells to collect every function whose __code__.co_filename ==
    mod.__file__. Index by co_qualname so OLD/NEW pair by identity across
    reload even if the decorator chain reshapes the object graph.
  - importlib.reload(mod) rebinds mod attributes to fresh objects.
  - Walk NEW mod.__dict__ the same way → {qualname: new_fn}.
  - For each qualname, overwrite OLD.__code__ / __defaults__ / __kwdefaults__
    / __dict__ in place. Outside holders (Django URL conf / GraphQL schema /
    Celery registry) keep the SAME object and dispatch through the fresh
    bytecode on next call.

Usage:
    python hot_reload_harness.py APP_DIR [MODULE_TO_PREIMPORT ...]

Special stdin commands (for testing externally held references):
    CALL <python-expression>   -> print repr(eval(expr))
"""
import importlib
import linecache
import os
import signal
import sys
import threading
import time
import traceback
import types

PORT_FILE_DIR = '/tmp/django-process-debugger'
RELOAD_POLL_SEC = 0.05  # tighter than real bootstrap (0.3s) so tests are fast

# When set, the watcher loop still polls but skips processing — used to
# simulate debugpy freezing all threads at a breakpoint.
_watcher_paused = threading.Event()


# Persistent storage of original function refs per module. Mirrors the
# bootstrap: we snapshot once and keep patching those same objects in place on
# every subsequent reload so externally held references stay live.
_original_mod_funcs: dict = {}


def _code_key(code):
    qn = getattr(code, 'co_qualname', None)
    return qn if qn else code.co_name


def _walk_reachable(start_values):
    """Yield every FunctionType reachable from start_values via __wrapped__,
    __closure__ cells, and class __dict__ members. id()-tracked."""
    seen = set()
    stack = list(start_values)
    while stack:
        obj = stack.pop()
        if id(obj) in seen:
            continue
        seen.add(id(obj))
        if isinstance(obj, types.FunctionType):
            yield obj
            w = getattr(obj, '__wrapped__', None)
            if w is not None:
                stack.append(w)
            cl = getattr(obj, '__closure__', None)
            if cl:
                for cell in cl:
                    try:
                        stack.append(cell.cell_contents)
                    except ValueError:
                        pass
        elif isinstance(obj, type):
            for mobj in list(obj.__dict__.values()):
                if isinstance(mobj, types.FunctionType):
                    stack.append(mobj)
                elif isinstance(mobj, (classmethod, staticmethod)):
                    inner = getattr(mobj, '__func__', None)
                    if inner is not None:
                        stack.append(inner)
                elif isinstance(mobj, property):
                    for acc in (mobj.fget, mobj.fset, mobj.fdel):
                        if acc is not None:
                            stack.append(acc)


def _deep_reload_module(mod):
    """Mirror of the bootstrap's deep-reload.

    Walks closures (not just __wrapped__) and pairs OLD/NEW by co_qualname so
    decorator chains without @functools.wraps still get their inner user
    function patched in place. Returns the patched qualnames.
    """
    mod_name = mod.__name__
    mod_file = getattr(mod, '__file__', None)
    mod_real = os.path.realpath(mod_file) if mod_file else None

    def _in_this_file(code):
        if mod_real is None:
            return False
        f = getattr(code, 'co_filename', None)
        if not f:
            return False
        try:
            return os.path.realpath(f) == mod_real
        except Exception:  # noqa: BLE001
            return f == mod_file

    def _index(target_mod):
        idx = {}
        for fn in _walk_reachable(list(target_mod.__dict__.values())):
            c = fn.__code__
            if not _in_this_file(c):
                continue
            idx.setdefault(_code_key(c), fn)
        return idx

    if mod_name not in _original_mod_funcs:
        _original_mod_funcs[mod_name] = _index(mod)

    importlib.reload(mod)

    try:
        linecache.checkcache()
        if mod_file:
            linecache.checkcache(mod_file)
    except Exception:  # noqa: BLE001
        pass

    new_fns = _index(mod)
    patched = []
    orig_map = _original_mod_funcs[mod_name]
    for qn, old_fn in list(orig_map.items()):
        new_fn = new_fns.get(qn)
        if new_fn is None or new_fn is old_fn:
            continue
        try:
            old_fn.__code__ = new_fn.__code__
            old_fn.__defaults__ = new_fn.__defaults__
            old_fn.__kwdefaults__ = getattr(new_fn, '__kwdefaults__', None)
            old_fn.__dict__.update(new_fn.__dict__)
            patched.append(qn)
        except Exception:  # noqa: BLE001
            pass

    for qn, new_fn in new_fns.items():
        orig_map.setdefault(qn, new_fn)

    return patched


def _reload_watcher(pid: int) -> None:
    reload_file = f"{PORT_FILE_DIR}/{pid}.reload"
    result_file = f"{PORT_FILE_DIR}/{pid}.reload.result"
    while True:
        try:
            time.sleep(RELOAD_POLL_SEC)
            if _watcher_paused.is_set():
                continue  # simulates debugpy all-threads-stopped
            if not os.path.exists(reload_file):
                continue
            with open(reload_file, 'r', encoding='utf-8') as f:
                paths = [p.strip() for p in f.read().strip().split('\n') if p.strip()]
            os.unlink(reload_file)
            if not paths:
                continue

            importlib.invalidate_caches()
            results = []
            for fpath in paths:
                abs_fpath = os.path.abspath(fpath)
                found = False
                for name, mod in list(sys.modules.items()):
                    mod_file = getattr(mod, '__file__', None)
                    if not mod_file:
                        continue
                    abs_mod = os.path.abspath(mod_file)
                    if abs_mod.endswith('.pyc'):
                        abs_mod = abs_mod[:-1]
                    if abs_mod == abs_fpath:
                        try:
                            patched = _deep_reload_module(mod)
                            patch_info = f" (patched: {', '.join(patched)})" if patched else ''
                            results.append(f"OK:{name}{patch_info}")
                        except Exception as e:  # noqa: BLE001 — mirror bootstrap
                            results.append(f"ERR:{name}:{e}")
                        found = True
                        break
                if not found:
                    results.append(f"SKIP:{fpath}")

            with open(result_file, 'w', encoding='utf-8') as f:
                f.write('\n'.join(results))
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"[harness] watcher error: {e}\n")
            sys.stderr.flush()


def _stdin_evaluator() -> None:
    """Read commands from stdin; enables tests to probe process state.

    Supported commands (one per line):
      CALL <expr>         -> prints OUT:<repr(eval(expr))> on a single line
      PAUSE_WATCHER       -> stop processing reload requests (simulates breakpoint)
      RESUME_WATCHER      -> resume processing
      QUIT                -> exit process cleanly
    """
    for raw_line in sys.stdin:
        line = raw_line.rstrip('\n')
        if not line:
            continue
        if line == 'QUIT':
            os._exit(0)
        if line == 'PAUSE_WATCHER':
            _watcher_paused.set()
            sys.stdout.write('OUT:paused\n')
            sys.stdout.flush()
            continue
        if line == 'RESUME_WATCHER':
            _watcher_paused.clear()
            sys.stdout.write('OUT:resumed\n')
            sys.stdout.flush()
            continue
        if line.startswith('CALL '):
            expr = line[5:]
            try:
                val = eval(expr, _eval_globals)  # noqa: S307 — test harness only
                sys.stdout.write(f"OUT:{val!r}\n")
            except Exception as e:  # noqa: BLE001
                sys.stdout.write(f"ERR:{type(e).__name__}:{e}\n")
            sys.stdout.flush()


_eval_globals: dict = {}


def main() -> int:
    if len(sys.argv) < 2:
        print('usage: hot_reload_harness.py APP_DIR [MODULE ...]', file=sys.stderr)
        return 2

    app_dir = sys.argv[1]
    preimport = sys.argv[2:]

    os.makedirs(PORT_FILE_DIR, exist_ok=True)

    sys.path.insert(0, app_dir)
    for mod_name in preimport:
        try:
            imported = importlib.import_module(mod_name)
            _eval_globals[mod_name.split('.')[-1]] = imported
            _eval_globals[mod_name.replace('.', '_')] = imported
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"[harness] pre-import failed for {mod_name}: {e}\n{traceback.format_exc()}\n")
            return 1

    # Also expose each top-level module (e.g. sampleapp.urls -> sampleapp) by
    # name for convenience in CALL expressions.
    _eval_globals['sys'] = sys
    _eval_globals['importlib'] = importlib

    pid = os.getpid()
    watcher = threading.Thread(target=_reload_watcher, args=(pid,), daemon=True,
                               name='harness-hot-reload-watcher')
    watcher.start()

    stdin_thread = threading.Thread(target=_stdin_evaluator, daemon=True,
                                    name='harness-stdin-evaluator')
    stdin_thread.start()

    sys.stdout.write(f"READY pid={pid}\n")
    sys.stdout.flush()

    stop_event = threading.Event()

    def _graceful_stop(signum, frame):  # noqa: ARG001
        stop_event.set()

    signal.signal(signal.SIGTERM, _graceful_stop)
    signal.signal(signal.SIGINT, _graceful_stop)

    while not stop_event.is_set():
        time.sleep(0.2)

    return 0


if __name__ == '__main__':
    sys.exit(main())
