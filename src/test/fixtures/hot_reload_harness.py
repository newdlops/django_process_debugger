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
  - Snapshot each class's __dict__ BEFORE reload.
  - importlib.reload(mod) rebinds mod.ClassName to NEW class (old one is still
    alive via outside references).
  - For each (old_name, old_class_dict): find the NEW class, iterate OLD method
    functions, and overwrite __code__ / __defaults__ / __kwdefaults__ / __dict__
    in place so that outside code still holding the OLD class reference sees
    new behavior on next call.

Usage:
    python hot_reload_harness.py APP_DIR [MODULE_TO_PREIMPORT ...]

Special stdin commands (for testing externally held references):
    CALL <python-expression>   -> print repr(eval(expr))
"""
import importlib
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


def _unwrap_chain(fn):
    """Return [fn, fn.__wrapped__, fn.__wrapped__.__wrapped__, ...].

    Mirrors bootstrap behavior: follow functools.wraps chains so decorator-
    wrapped methods get their innermost user function patched.
    """
    chain = []
    seen = set()
    while isinstance(fn, types.FunctionType) and id(fn) not in seen:
        seen.add(id(fn))
        chain.append(fn)
        fn = getattr(fn, '__wrapped__', None)
    return chain


def _patch_fn_pair(old_fn, new_fn, label, patched_list):
    old_chain = _unwrap_chain(old_fn)
    new_chain = _unwrap_chain(new_fn)
    levels = 0
    for o, n in zip(old_chain, new_chain):
        o.__code__ = n.__code__
        o.__defaults__ = n.__defaults__
        o.__kwdefaults__ = getattr(n, '__kwdefaults__', None)
        o.__dict__.update(n.__dict__)
        levels += 1
    if levels:
        suffix = '' if levels == 1 else f' (+{levels - 1} unwrapped)'
        patched_list.append(f"{label}{suffix}")


def _deep_reload_module(mod):
    """Mirror of the bootstrap's deep-reload — import filter + unwrap chain.

    Returns "ClassName.methodName" / "functionName" entries that were patched.
    """
    mod_name = mod.__name__
    patched = []

    old_funcs = {}
    old_class_methods = {}
    for attr_name, obj in mod.__dict__.items():
        obj_mod = getattr(obj, '__module__', None)
        if obj_mod is not None and obj_mod != mod_name:
            continue  # skip imported symbols
        if isinstance(obj, types.FunctionType):
            old_funcs[attr_name] = obj
        elif isinstance(obj, type):
            old_class_methods[attr_name] = (obj, {})
            for mname, mobj in obj.__dict__.items():
                if isinstance(mobj, types.FunctionType):
                    old_class_methods[attr_name][1][mname] = mobj
                elif isinstance(mobj, (classmethod, staticmethod)):
                    inner = getattr(mobj, '__func__', None)
                    if inner:
                        old_class_methods[attr_name][1][mname] = inner

    importlib.reload(mod)

    for attr_name, old_fn in old_funcs.items():
        new_fn = mod.__dict__.get(attr_name)
        if isinstance(new_fn, types.FunctionType):
            _patch_fn_pair(old_fn, new_fn, attr_name, patched)

    for cls_name, (_old_cls, methods) in old_class_methods.items():
        new_cls = mod.__dict__.get(cls_name)
        if not isinstance(new_cls, type):
            continue
        for mname, old_mfn in methods.items():
            new_raw = new_cls.__dict__.get(mname)
            new_mfn = None
            if isinstance(new_raw, types.FunctionType):
                new_mfn = new_raw
            elif isinstance(new_raw, (classmethod, staticmethod)):
                new_mfn = getattr(new_raw, '__func__', None)
            if new_mfn and isinstance(old_mfn, types.FunctionType):
                _patch_fn_pair(old_mfn, new_mfn, f"{cls_name}.{mname}", patched)

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
