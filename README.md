# Django Process Debugger

Attach a debugger to a running Django or Celery process without modifying your codebase. Designed for macOS Apple Silicon.

## Features

- Detect running Django and Celery processes with PID and port info
- Attach debugpy at runtime via SIGUSR1/SIGUSR2 signal — no lldb, no code changes
- Opt in to a fully independent native tracer while keeping debugpy as the stable default
- **Hot Reload (debugpy)** — edit Python files while debugging and see changes immediately without restarting Django or losing your debug session
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

### 4. Edit & Debug (debugpy Hot Reload)

With the default debugpy backend attached, simply edit and save any `.py` file. The extension automatically:

1. Detects the file change
2. Reloads the module in the running process via `importlib.reload()`
3. Patches all existing function references with the new code (`__code__` replacement)
4. Suppresses Django's autoreloader to prevent process restart

Your debug session stays alive, breakpoints remain active, and the next request executes the updated code. `print()` output appears directly in the VS Code Debug Console.

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

The experimental tracer currently supports line breakpoints, stack frames, scopes, read-only variables, continue, step over, step in, and step out. Conditional breakpoints, expression evaluation, variable mutation, exception breakpoints, and function breakpoints are not supported yet. Hot reload also remains debugpy-only for now.

Changing the setting affects new sessions only. Both engines retain process-level tracing state after a DAP session ends, so the first activated engine owns that PID until it restarts. Restart the target process before attaching it with the other engine.

On Python 3.11 and earlier, pure `sys.settrace` cannot immediately install tracing into every already-running non-main thread. The experimental backend guarantees the current/main thread that handles activation and threads created after activation; broader existing-thread support is still under development. It also refuses activation when another coverage/debug/profiling trace hook is already installed instead of replacing that hook.

### Debug Attach

1. **Setup** installs a `.pth` file and a small Python module into your target runtime's `site-packages`. The `.pth` file causes Python to auto-load the module at startup, which registers a SIGUSR1/SIGUSR2 signal handler. Only long-running server processes (runserver, celery worker, etc.) are affected — tools like pip, pytest, and language servers are explicitly excluded via a blocklist.

2. **Attach** finds the target process, resolves the process tree to find the actual debuggable child process (handling `uv run`, `poetry run`, Django autoreloader, etc.), writes an engine activation request to a temp file, sends SIGUSR1 (or SIGUSR2 for Celery), and waits for the selected engine to start listening. Then VS Code connects via DAP (Debug Adapter Protocol) over TCP.

3. **debugpy** is shipped as a vendored bundle inside the extension and copied into private extension storage on first use, so your target runtime stays clean. If macOS blocks the Python binary (code signature issue), the extension still auto-repairs it with `codesign --force --deep --sign -` when pip fallback is needed.

### Hot Reload

When debugpy activates, a background watcher thread starts in the Django process. On the VS Code side, a `FileSystemWatcher` monitors `**/*.py` files. This hot-reload path is currently disabled for the experimental tracer.

When you save a file:

1. The extension writes the changed file path to `/tmp/django-process-debugger/{pid}.reload`
2. The Python watcher thread picks it up and finds the corresponding module in `sys.modules`
3. On the **first reload**, original function/method references are saved (these are the references Django's URL resolver, middleware chain, etc. hold)
4. `importlib.reload()` re-executes the module, creating new function objects
5. The **original** function objects' `__code__`, `__defaults__`, and `__kwdefaults__` are patched with the new code — this means every existing reference (URL patterns, decorators, closures) executes the updated code
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
| `djangoProcessDebugger.hotReload` | `true` | Hot-reload changed `.py` files without restarting Django. Currently debugpy-only. |

## Troubleshooting

### Experimental tracer limitations

- The experimental tracer intentionally advertises only the DAP features it currently implements. Use `debugpy` when you need conditions, expression evaluation, value changes, exception/function breakpoints, or hot reload.
- `justMyCode` filtering and Debug Console output redirection are not implemented by the experimental tracer yet.
- Stop the current session before changing engines, then restart the target process before attaching it with the other engine.
- The experimental trace hook remains installed for same-engine reattach after disconnect. Restart the target process to remove its tracing overhead completely.
- On Python 3.11 and earlier, a thread that was already running before attach may not be traced until broader existing-thread support is implemented.
- The experimental backend will not replace an existing `sys.settrace`/`threading.settrace` hook. Stop the other coverage, profiler, or debugger integration and restart the target first.

### Hot reload not reflecting changes

- Make sure you ran **Setup** and **restarted Django** after the extension was updated. The bootstrap is loaded at process startup — updating the extension alone does not update the running process.
- On attach, the extension checks the bootstrap version and auto-updates if needed, but a Django restart is still required for the new bootstrap to load.
- Hot reload patches function `__code__` on the original references. Changes to **class-level attributes**, **module-level constants consumed at import time**, or **new imports** may require a full restart.

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
