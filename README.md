# Django Process Debugger

Attach a debugger to a running Django or Celery process without modifying your codebase. Designed for macOS Apple Silicon.

## Features

- Detect running Django and Celery processes with PID and port info
- Attach debugpy at runtime via SIGUSR1/SIGUSR2 signal — no lldb, no code changes
- Opt in to a fully independent native tracer with conditional and hit-count breakpoints, logpoints, expression evaluation, and controlled value changes while keeping debugpy as the stable default
- **Hot Reload** — edit Python files with either debug engine and see changes immediately without restarting Django or losing your debug session
- Smart process tree resolution — select any process (uv wrapper, autoreloader, or child) and the debugger attaches to the right one
- Vendored debugpy bundle shipped with the extension — no target-runtime pip install required
- `print()` output redirected to VS Code Debug Console by default with the debugpy backend
- Guided runtime setup with preflight checks, recommendation ranking, and workspace profile reuse
- Auto-discover Python interpreters from running servers, VS Code selection, asdf, pyenv, mise, conda, Poetry, pipenv, Homebrew, and more
- Host/port-grouped attach picker — attachable Django servers are grouped by listener host and port
- Kill processes and fully clean up debug artifacts with one command
- macOS code signature auto-repair (quarantine removal + ad-hoc re-signing)
- Workspace-level debug session lock to prevent conflicts across VS Code windows
- Bootstrap auto-update on attach — outdated bootstrap is detected and updated automatically

## Quick Start

### 1. Setup (one-time per runtime)

Run **Django Debugger: Setup** from the Command Palette (`Cmd+Shift+P`).

Pick the runtime that actually launches Django or Celery. The setup picker recommends running server interpreters first, then the VS Code-selected interpreter, then workspace venvs and other discovered runtimes.

Before installing, the extension runs a preflight check for Python version, `site-packages`, writability, shared-runtime risk, and bundled `debugpy` availability. Successful setup is saved as a workspace profile so you can reuse it later.

This installs a lightweight bootstrap into the target runtime's `site-packages` that registers a signal handler. Your project code is not modified.

### 2. Restart Django

Restart your Django server through your normal workflow (`manage.py runserver`, `uv run python manage.py runserver`, etc.). The bootstrap loads automatically.

To try the native tracer, set `djangoProcessDebugger.engine` to `experimental` before attaching. No setting change is needed for the stable debugpy backend.

### 3. Attach

Run **Django Debugger: Attach to Django Process** from the Command Palette.

Select the server you want to debug — attachable Django processes are grouped by listener host and port, with the related PIDs shown in the item description. The extension automatically resolves the correct child process in the Django process tree, activates the selected debug engine, and connects VS Code's debugger.

### 4. Edit & Debug (Hot Reload)

With either debug backend attached, simply edit and save any `.py` file. The extension automatically:

1. Detects the file change
2. Reloads the module in the running process via `importlib.reload()`
3. Patches all existing function references with the new code (`__code__` replacement)
4. Suppresses Django's autoreloader to prevent process restart

Your debug session stays alive, breakpoints remain active, and the next request executes the updated code. With the debugpy backend, `print()` output appears directly in the VS Code Debug Console.

## Commands

| Command | Description |
|---------|-------------|
| **Django Debugger: Setup** | Install debug bootstrap into the runtime that launches Django/Celery |
| **Django Debugger: Show Setup Status** | Show the selected engine, saved runtime profile, bootstrap status, and bundled debugpy fallback |
| **Django Debugger: Attach to Django Process** | Attach debugger to a running Django/Celery process |
| **Django Debugger: Kill Django/Celery Process** | Kill selected processes (multi-select supported) |
| **Django Debugger: Reinstall debugpy** | Remove and reinstall the bundled debugpy |
| **Django Debugger: Clean All** | Full reset: remove bootstrap files, kill stale processes, clear caches, repair Python binaries |

## How It Works

### Debug Engines

`debugpy` remains the default and recommended backend. The `experimental` backend is a new tracer implemented independently of debugpy and is available as an explicit opt-in:

```json
{
  "djangoProcessDebugger.engine": "experimental"
}
```

The experimental tracer currently supports line, conditional, hit-count, raised-exception, uncaught-exception, and Django-request-exception breakpoints, logpoints, hot reload, DAP exception details (`exceptionInfo`), stack frames, scopes, variable inspection, Python expression evaluation, Set Variable, continue, pause, step over, step in, and step out. Function breakpoints are not supported yet.

Other VS Code extensions can consume the engine through the API returned by this extension's activation. The stable contract exposes the `django-process` debug type, supported engines, Setup/Status command IDs, and local-PID/hot-reload capabilities; consumers start a normal debug session so they cannot bypass PID locking or engine ownership.

Conditional breakpoints and Evaluate accept Python expressions in the selected frame's globals and locals. They run on the paused application thread, preserving its thread-local and context-variable state. A condition that evaluates to a false value is skipped. If a condition raises, the tracer contains the exception and stops at that breakpoint with an error description instead of allowing the debugger expression to escape into the application. Evaluate errors are returned as failed DAP requests.

The `Raised Exceptions` filter stops at the exception's first raise site, including exceptions that application code catches later, without stopping again as the same exception propagates through callers. Generator/iterator control-flow exceptions (`StopIteration`, `StopAsyncIteration`, and `GeneratorExit`) are skipped. The `Uncaught Exceptions` filter stops post-mortem only when an exception escapes the main Python process entry point or a `threading.Thread.run()` entry point. Selecting both can therefore stop once at the raised phase and again if that exception is ultimately uncaught. Uncaught handling skips `SystemExit` and `KeyboardInterrupt`, and does not cover exceptions retained by asyncio tasks, `sys.unraisablehook` events, child-process failures, or native crashes. Exception details use bounded previews of directly stored `args`, include cause/context chains and Python 3.11+ exception-group children, and do not automatically call an application-defined `__str__` or `__repr__`.

The `Django Request Exceptions` filter observes Django's `got_request_exception` boundary and stops with DAP break mode `userUnhandled` when Django is converting a request exception into an HTTP 500 response. It adds a `Django Request` scope for request context. Selecting it together with `Raised Exceptions` stops first at the raise site and again at the Django boundary. Request bodies, headers, and cookies are not evaluated automatically. Exceptions outside that boundary—including retained asyncio task exceptions, custom middleware that builds its own 500 response, and errors raised later while iterating a streaming response—remain governed by the existing Raised and Uncaught filters.

At an uncaught or Django-request post-mortem stop, the original frames have already unwound but remain available for stack, scope, variable, and expression inspection. Continue releases the stop; stepping and Set Variable are unavailable for those historical frames.

Hit-count breakpoints count only hits whose normal condition evaluated to true. They accept `N`, `== N`, `> N`, `>= N`, `< N`, `<= N`, and `% N`; `% N` matches every Nth hit. Counts are shared across the process's threads for that breakpoint and reset when breakpoints for its source file are replaced.

Logpoints use literal text with `{python_expression}` placeholders and `{{` or `}}` for literal braces. Values use the same bounded safe rendering as Variables, so application-defined `__repr__`, `__str__`, and properties are not called. A placeholder failure is printed as a type-only diagnostic and never stops the application. Log output is sent through a bounded asynchronous queue so a slow debugger client cannot block the traced request thread; excess messages are dropped with a later summary.

Set Variable evaluates the entered value as a Python expression; for example, use `'ready'` including the quotes to assign a string. It can update existing locals and globals, dictionary entries with string keys, list elements, and existing attributes stored in an instance `__dict__`. It does not create new variables or attributes; slot-only attributes, non-string dictionary keys, tuples, sets, and frozensets remain read-only. If the selected Python runtime cannot safely synchronize an optimized local back to its executing frame, the request fails instead of reporting a display-only change.

Reference objects in Variables and Evaluate use a shallow preview of directly stored `__dict__` fields, such as `<User id=1, name='Kim'>`, instead of showing only a memory address. The preview is bounded and never evaluates properties or application-defined `__repr__`/`__str__`; objects whose state cannot be read safely remain opaque as `<TypeName>`.

For values with safely discoverable hooks, object expansion also shows lazy `repr()`, `str()`, `len()`, standard `@property`, `functools.cached_property`, and native slot rows as `<not evaluated>`. Opening one of those rows evaluates only that member on the selected paused application thread. A failure is shown as a type-only value such as `<evaluation raised RuntimeError>` and does not escape into the application. VS Code's `debug.autoExpandLazyVariables` setting can request these rows automatically; leave it disabled if hooks must run only after an explicit click.

Variables include evaluatable names for identifiers and safe dictionary, sequence, attribute, property, and slot paths, so nested values work naturally with Watch, Copy Value, and related debugger actions. Clipboard-context evaluation returns a larger bounded representation for exact strings and bytes, while clients that request hexadecimal value formatting receive exact integers in `0x` form.

Conditional breakpoint, logpoint, Evaluate, Set Variable, and lazy-member expressions execute inside the target process and are not sandboxed. Function calls and object mutations can have application side effects. A blocking condition, logpoint placeholder, Evaluate, Set Variable, or lazy hook blocks its selected application thread; Evaluate, Set Variable, and lazy requests also stall protocol control for that session. Python cannot safely force-cancel arbitrary evaluation. Expression failures, including `SystemExit` and other `BaseException` subclasses, are contained by the tracer; normal previews and evaluated structured values are rendered without calling an application-defined `__repr__`. Frame and variable references expire when execution resumes, and references for replaced structured values expire immediately, so stale references cannot be used to evaluate or mutate later state.

Changing the setting affects new sessions only. Both engines retain process-level tracing state after a DAP session ends, so the first activated engine owns that PID until it restarts. Restart the target process before attaching it with the other engine.

On Python 3.11 and earlier, pure `sys.settrace` cannot immediately install tracing into every already-running non-main thread. The experimental backend guarantees the current/main thread that handles activation and threads created after activation; broader existing-thread support is still under development. It also refuses activation when another coverage/debug/profiling trace hook is already installed instead of replacing that hook.

### Debug Attach

1. **Setup** installs a `.pth` file and a small Python module into your target runtime's `site-packages`. The `.pth` file causes Python to auto-load the module at startup, which registers a SIGUSR1/SIGUSR2 signal handler. Long-running servers and interactive `manage.py shell`/`shell_plus` processes are supported; tools like pip, pytest, and language servers are explicitly excluded via a blocklist.

2. **Attach** finds the target process, resolves the process tree to find the actual debuggable child process (handling `uv run`, `poetry run`, Django autoreloader, etc.), writes an engine activation request to a temp file, sends SIGUSR1 (or SIGUSR2 for Celery), and waits for the selected engine to start listening. The process picker shows CWD first, includes its final folder beside the PID, and lets you search by CWD. Then VS Code connects via DAP (Debug Adapter Protocol) over TCP.

3. **debugpy** is shipped as a vendored bundle inside the extension and copied into private extension storage on first use, so your target runtime stays clean. If macOS blocks the Python binary (code signature issue), the extension still auto-repairs it with `codesign --force --deep --sign -` when pip fallback is needed.

### Hot Reload

When either debug engine activates, a background watcher thread starts in the Django process. On the VS Code side, a `FileSystemWatcher` monitors `**/*.py` files. The experimental engine excludes this internal watcher thread from tracing so reload implementation details cannot trigger application breakpoints or Raised exception filters.

When you save a file:

1. The extension writes the changed file path to `/tmp/django-process-debugger/{pid}.reload`
2. The Python watcher thread picks it up and finds the corresponding module in `sys.modules`
3. Before every reload, all currently reachable function/method generations are weakly registered (including references created by an earlier reload)
4. `importlib.reload()` re-executes the module, creating new function objects
5. Every still-live prior generation has its `__code__`, defaults, annotations, and documentation patched — this means existing URL patterns, decorators, closures, and class references execute the updated code
6. Django's autoreloader is suppressed via two layers:
   - `file_changed` signal handler returning `True` (Django's built-in extension point)
   - `trigger_reload()` patched to prevent `sys.exit(3)`

This approach works with:
- Function-based views and class-based views (CBV)
- `as_view()` closures that captured the original class
- Decorated functions and methods
- `classmethod` and `staticmethod`
- Module-level functions

## Process Tree Support

Django's `runserver` with autoreload creates a process tree:

```
uv run python manage.py runserver 8000        # wrapper (uv, poetry, etc.)
  └─ .venv/bin/python3 manage.py runserver 8000  # parent (autoreloader)
       └─ .venv/bin/python3 manage.py runserver 8000  # child (actual server)
```

You can select **any** process in the tree — the extension walks down to the deepest Python child and attaches there.

## Supported Python Environments

- **asdf** Python versions
- **pyenv** / pyenv-virtualenv
- **mise** (formerly rtx)
- **conda** (miniconda3, anaconda3, miniforge3)
- **Poetry** virtualenvs
- **pipenv** virtualenvs
- **Homebrew** Python
- **uv** managed projects
- Project-local venvs (`.venv`, `venv`, `.virtualenv`, `env`)

## Supported Servers

- `manage.py runserver` (including via `uv run`, `poetry run`)
- `manage.py run_huey`
- Celery workers (`celery worker`, `-m celery worker`)
- daphne (ASGI)
- uvicorn (ASGI)
- gunicorn (WSGI)

## Requirements

- macOS (Apple Silicon supported)
- Python 3.8+
- pip (for initial debugpy bundling)

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `djangoProcessDebugger.engine` | `debugpy` | Debug backend for new attach sessions. Restart an already-activated target before switching engines. |
| `djangoProcessDebugger.justMyCode` | `true` | Only debug user-written code. Set to `false` to step into Django/Celery internals. Currently debugpy-only. |
| `djangoProcessDebugger.redirectOutput` | `true` | Redirect `print()` / stdout / stderr to the VS Code Debug Console. Currently debugpy-only. |
| `djangoProcessDebugger.hotReload` | `true` | Hot-reload changed `.py` files without restarting Django. Supported by both debug engines. |

## Troubleshooting

### Experimental tracer limitations

- Conditional breakpoints, logpoint placeholders, Evaluate, and Set Variable accept expressions only, not statements or multiline `exec` input. Expressions run in the target process and can have side effects or block, so use them with the same care as application code.
- Lazy `repr()`, `str()`, `len()`, standard `@property`, `functools.cached_property`, and native slot rows can execute arbitrary application code when requested, and VS Code may request them automatically when `debug.autoExpandLazyVariables` is enabled. Custom descriptor classes, including framework-specific cached-property implementations, remain hidden until they can be discovered without weakening the safe-preview boundary.
- Set Variable changes existing locals/globals, dictionary entries with string keys, list elements, and existing `__dict__`-backed instance attributes. It cannot create names or attributes; slot-only attributes, non-string dictionary keys, and tuple, set, and frozenset handles remain read-only. Optimized-local updates fail explicitly on a runtime where the change cannot be synchronized safely.
- Raised, uncaught, and Django request exception breakpoints are supported. Uncaught and Django-request stops are post-mortem: inspection, Evaluate, and Continue are available, but stepping and Set Variable are rejected because the original frames have already unwound. The Django request scope does not automatically evaluate request bodies, headers, or cookies.
- Function breakpoints are not implemented by the experimental tracer yet. Use `debugpy` when you need them.
- `justMyCode` filtering and Debug Console output redirection are not implemented by the experimental tracer yet.
- Stop the current session before changing engines, then restart the target process before attaching it with the other engine.
- The experimental trace hook remains installed for same-engine reattach after disconnect. Restart the target process to remove its tracing overhead completely.
- On Python 3.11 and earlier, a thread that was already running before attach may not be traced until broader existing-thread support is implemented.
- The experimental backend will not replace an existing `sys.settrace`/`threading.settrace` hook. Stop the other coverage, profiler, or debugger integration and restart the target first.

### Hot reload not reflecting changes

- Make sure you ran **Setup** and **restarted Django** after the extension was updated. The bootstrap is loaded at process startup — updating the extension alone does not update the running process.
- On attach, the extension checks the bootstrap version and auto-updates if needed, but a Django restart is still required for the new bootstrap to load.
- Hot reload patches all still-live function generations. Changes to **class-level attributes**, **module-level constants consumed at import time**, decorator closure layout, or removed symbols may still require a full restart.

### print() not showing in Debug Console

- `redirectOutput` must be `true` (default). If you changed it, re-attach the debugger.
- Output only appears in the Debug Console for requests **after** the debugger attaches. Pre-attach output goes to the terminal only.

### Python killed after extension use

If Python processes are being killed with `zsh: killed`, run **Django Debugger: Clean All**. This removes all bootstrap files, clears quarantine attributes, and re-signs Python binaries with an ad-hoc code signature.

### Language server crashes

If Jedi or Pylance keeps crashing, run **Clean All** and reload the VS Code window when prompted. The bootstrap uses a strict blocklist to prevent interfering with language servers.

### debugpy installation fails with SIGKILL

The extension automatically detects SIGKILL during pip install and attempts to repair the Python binary's macOS code signature before retrying. If it still fails, run **Clean All** first, then try again.

### "Bootstrap not installed" after Setup

Make sure to restart your Django server after running Setup. If using `uv run`, the extension resolves through the wrapper to the actual Python child process automatically.

### Setup picked the wrong runtime

Run **Django Debugger: Show Setup Status** to inspect the saved runtime profile, then rerun **Setup** and pick the runtime that actually launches your Django or Celery process. The picker ranks running server interpreters first to reduce this problem.

## License

MIT
