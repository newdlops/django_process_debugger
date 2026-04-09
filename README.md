# Django Process Debugger

Attach a debugger to a running Django or Celery process without modifying your codebase. Designed for macOS Apple Silicon.

## Features

- Detect running Django and Celery processes with PID and port info
- Attach debugpy at runtime via SIGUSR1/SIGUSR2 signal — no lldb, no code changes
- Smart process tree resolution — select any process (uv wrapper, autoreloader, or child) and the debugger attaches to the right one
- Vendored debugpy bundle shipped with the extension — no target-runtime pip install required
- Guided runtime setup with preflight checks, recommendation ranking, and workspace profile reuse
- Auto-discover Python interpreters from running servers, VS Code selection, asdf, pyenv, mise, conda, Poetry, pipenv, Homebrew, and more
- Port-grouped QuickPick — parent/child processes on the same port shown as one entry
- Kill processes and fully clean up debug artifacts with one command
- macOS code signature auto-repair (quarantine removal + ad-hoc re-signing)
- Workspace-level debug session lock to prevent conflicts across VS Code windows

## Quick Start

### 1. Setup (one-time per runtime)

Run **Django Debugger: Setup** from the Command Palette (`Cmd+Shift+P`).

Pick the runtime that actually launches Django or Celery. The setup picker recommends running server interpreters first, then the VS Code-selected interpreter, then workspace venvs and other discovered runtimes.

Before installing, the extension runs a preflight check for Python version, `site-packages`, writability, shared-runtime risk, and bundled `debugpy` availability. Successful setup is saved as a workspace profile so you can reuse it later.

This installs a lightweight bootstrap into the target runtime's `site-packages` that registers a signal handler. Your project code is not modified.

### 2. Restart Django

Restart your Django server through your normal workflow (`manage.py runserver`, `uv run python manage.py runserver`, etc.). The bootstrap loads automatically.

### 3. Attach

Run **Django Debugger: Attach to Django Process** from the Command Palette.

Select the process you want to debug — processes are grouped by port, showing PID and type. The extension automatically resolves the correct child process in the Django process tree, activates debugpy, and connects VS Code's debugger.

## Commands

| Command | Description |
|---------|-------------|
| **Django Debugger: Setup** | Install debug bootstrap into the runtime that launches Django/Celery |
| **Django Debugger: Show Setup Status** | Show the saved runtime profile, bootstrap status, and bundled debugpy source |
| **Django Debugger: Attach to Django Process** | Attach debugger to a running Django/Celery process |
| **Django Debugger: Kill Django/Celery Process** | Kill selected processes (multi-select supported) |
| **Django Debugger: Reinstall debugpy** | Remove and reinstall the bundled debugpy |
| **Django Debugger: Clean All** | Full reset: remove bootstrap files, kill stale processes, clear caches, repair Python binaries |

## How It Works

1. **Setup** installs a `.pth` file and a small Python module into your target runtime's `site-packages`. The `.pth` file causes Python to auto-load the module at startup, which registers a SIGUSR1/SIGUSR2 signal handler. Only long-running server processes (runserver, celery worker, etc.) are affected — tools like pip, pytest, and language servers are explicitly excluded via a blocklist.

2. **Attach** finds the target process, resolves the process tree to find the actual debuggable child process (handling `uv run`, `poetry run`, Django autoreloader, etc.), writes a port number to a temp file, sends SIGUSR1 (or SIGUSR2 for Celery), and waits for debugpy to start listening. Then VS Code connects via DAP (Debug Adapter Protocol) over TCP.

3. **debugpy** is shipped as a vendored bundle inside the extension and copied into private extension storage on first use, so your target runtime stays clean. If macOS blocks the Python binary (code signature issue), the extension still auto-repairs it with `codesign --force --deep --sign -` when pip fallback is needed.

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
| `djangoProcessDebugger.justMyCode` | `true` | Only debug user-written code. Set to `false` to step into Django/Celery internals. |

## Troubleshooting

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
