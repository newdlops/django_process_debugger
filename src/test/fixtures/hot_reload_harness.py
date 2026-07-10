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
  4. A v2 JSON result envelope is atomically published at
     /tmp/django-process-debugger/PID.reload.result. Its ``results`` rows are:
       OK:module.name (patched: ClassA.method1, ClassA.method2)
       ERR:module.name:Exception text
       SKIP:/absolute/path

Deep-reload semantics (must match bootstrap):
  - BEFORE importlib.reload, walk mod.__dict__ and follow __wrapped__ AND
    __closure__ cells to collect every function whose __code__.co_filename ==
    mod.__file__. Track all still-live generations weakly by logical + compiled
    qualname so objects captured after any earlier reload remain patchable.
  - importlib.reload(mod) rebinds mod attributes to fresh objects.
  - Walk NEW mod.__dict__ the same way → {qualname: new_fn}.
  - For each qualname, overwrite every live OLD generation's __code__ /
    __defaults__ / __kwdefaults__ / __dict__ in place. Outside holders (Django
    URL conf / GraphQL schema / Celery registry) keep the SAME object and
    dispatch through the fresh bytecode on next call.

Usage:
    python hot_reload_harness.py APP_DIR [MODULE_TO_PREIMPORT ...]

Special stdin commands (for testing externally held references):
    CALL <python-expression>   -> print repr(eval(expr))
"""
import importlib
import importlib.util
import json
import linecache
import os
import signal
import sys
import threading
import time
import traceback
import types
import weakref

PORT_FILE_DIR = '/tmp/django-process-debugger'
RELOAD_POLL_SEC = 0.05  # tighter than real bootstrap (0.3s) so tests are fast

# When set, the watcher loop still polls but skips processing — used to
# simulate debugpy freezing all threads at a breakpoint.
_watcher_paused = threading.Event()


# Weak storage of every function generation observed for each module. A single
# "original" snapshot is insufficient: application registries can capture the
# fresh objects installed by any later importlib.reload(). WeakSet keeps those
# generations patchable while an application still references them without
# retaining otherwise-dead reload generations forever.
_original_mod_funcs: dict = {}


def _code_key(code):
    qn = getattr(code, 'co_qualname', None)
    return qn if qn else code.co_name


def _function_key(fn):
    """Pair logical and compiled qualnames across reload generations.

    functools.wraps copies function.__qualname__ onto its wrapper but leaves
    code.co_qualname intact. Keeping both prevents a wrapper and its wrapped
    function from collapsing into the same registry entry.
    """
    code_name = _code_key(fn.__code__)
    logical_name = getattr(fn, '__qualname__', None)
    return (logical_name or code_name, code_name)


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

    Walks closures (not just __wrapped__) and pairs OLD/NEW by logical + code
    qualname so decorator chains without @functools.wraps still get their inner
    user function patched in place. Returns the patched logical qualnames.
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
            # A decorator factory can create several wrapper objects with the
            # same co_qualname. Keep every object instead of silently dropping
            # all but the first generation/member.
            idx.setdefault(_function_key(fn), []).append(fn)
        return idx

    tracked = _original_mod_funcs.setdefault(mod_name, {})

    def _track(index):
        for qn, functions in index.items():
            generations = tracked.setdefault(qn, weakref.WeakSet())
            for fn in functions:
                generations.add(fn)

    # Register the generation currently exposed by the module before reload.
    # It may have been installed by an earlier reload and captured by Django,
    # GraphQL, Celery, or another application registry since then.
    # Keep the pre-reload index strongly reachable until patching completes.
    # Otherwise functions with no external holder can disappear from WeakSet
    # as soon as importlib.reload() replaces the module attribute.
    current_fns = _index(mod)
    _track(current_fns)

    cached_file = getattr(mod, '__cached__', None)
    canonical_cached_file = None
    if type(mod_file) is str:
        try:
            canonical_cached_file = importlib.util.cache_from_source(mod_file)
        except Exception:  # noqa: BLE001
            pass
    if type(canonical_cached_file) is str:
        try:
            os.unlink(canonical_cached_file)
        except FileNotFoundError:
            pass
        except Exception:  # noqa: BLE001
            pass
    importlib.invalidate_caches()
    importlib.reload(mod)

    try:
        linecache.checkcache()
        if mod_file:
            linecache.checkcache(mod_file)
    except Exception:  # noqa: BLE001
        pass

    new_fns = _index(mod)
    patched = set()
    for function_key, generations in list(tracked.items()):
        candidates = new_fns.get(function_key)
        if not candidates:
            continue
        # Functions sharing a code qualname (notably repeated decorator
        # wrappers) execute equivalent code. Their closure-held inner
        # functions are tracked under their own qualnames and patched below.
        new_fn = candidates[0]
        for old_fn in list(generations):
            if any(old_fn is candidate for candidate in candidates):
                continue
            try:
                old_fn.__code__ = new_fn.__code__
                old_fn.__defaults__ = new_fn.__defaults__
                old_fn.__kwdefaults__ = getattr(new_fn, '__kwdefaults__', None)
                old_fn.__dict__.update(new_fn.__dict__)
                old_fn.__annotations__ = dict(
                    getattr(new_fn, '__annotations__', {}),
                )
                old_fn.__doc__ = new_fn.__doc__
                patched.add(function_key[0])
            except Exception:  # noqa: BLE001
                pass

    # Track the newly installed generation immediately. This also covers a
    # caller that captures it and then replaces/deletes the module attribute
    # before the next reload scan.
    _track(new_fns)

    return sorted(patched)


def _reload_watcher(pid: int) -> None:
    reload_file = f"{PORT_FILE_DIR}/{pid}.reload"
    processing_file = f"{reload_file}.processing"
    result_file = f"{PORT_FILE_DIR}/{pid}.reload.result"

    def publish_result(request_id, results):
        result_tmp = f"{result_file}.{threading.get_ident()}.tmp"
        payload = (
            json.dumps({
                'version': 2,
                'requestId': request_id,
                'results': results,
            })
            if request_id is not None
            else '\n'.join(results)
        )
        try:
            with open(result_tmp, 'w', encoding='utf-8') as f:
                f.write(payload)
            try:
                os.chmod(result_tmp, 0o600)
            except Exception:  # noqa: BLE001
                pass
            os.replace(result_tmp, result_file)
        finally:
            try:
                os.unlink(result_tmp)
            except FileNotFoundError:
                pass

    def clear_claim():
        try:
            os.unlink(processing_file)
        except FileNotFoundError:
            pass

    while True:
        request_id = None
        claimed = False
        try:
            time.sleep(RELOAD_POLL_SEC)
            if _watcher_paused.is_set():
                continue  # simulates debugpy all-threads-stopped

            try:
                os.replace(reload_file, processing_file)
                claimed = True
            except FileNotFoundError:
                continue

            with open(processing_file, 'r', encoding='utf-8') as f:
                raw_request = f.read()

            try:
                request = json.loads(raw_request)
            except Exception:  # noqa: BLE001
                if raw_request.lstrip().startswith('{'):
                    raise
                request = None
            if isinstance(request, dict) and request.get('version') == 2:
                request_id = request.get('requestId')
                paths = request.get('paths')
                if not isinstance(request_id, str) or not isinstance(paths, list):
                    raise ValueError('Invalid hot reload v2 request')
                if not all(isinstance(item, str) for item in paths):
                    raise ValueError('Invalid hot reload path')
                paths = [item for item in paths if item]
            else:
                paths = [
                    item.strip()
                    for item in raw_request.strip().split('\n')
                    if item.strip()
                ]
            if not paths:
                publish_result(request_id, [])
                clear_claim()
                claimed = False
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

            publish_result(request_id, results)
            clear_claim()
            claimed = False
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"[harness] watcher error: {e}\n")
            sys.stderr.flush()
            try:
                publish_result(
                    request_id,
                    [f"ERR:protocol:{type(e).__name__}:{e}"],
                )
            except Exception:  # noqa: BLE001
                pass
            finally:
                if claimed:
                    try:
                        clear_claim()
                    except Exception:  # noqa: BLE001
                        pass


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
