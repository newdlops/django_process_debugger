# Django Process Debugger

Attach a debugger to a running Django or Celery process without modifying your codebase. Designed for macOS Apple Silicon.

## Features

- Detect running Django and Celery processes with PID and port info
- Attach debugpy at runtime via SIGUSR1/SIGUSR2 signal
- Bundled debugpy — no need to install debugpy in your project's virtualenv
- Auto-discover Python interpreters from asdf, pyenv, conda, Poetry, pipenv, and more
- Kill processes and clean up debug artifacts with one command
- macOS code signature recovery for broken Python binaries
- Workspace-level debug session lock to prevent conflicts across VS Code windows

## Quick Start

### 1. Setup (one-time per venv)

Run **Django Debugger: Setup** from the Command Palette (`Cmd+Shift+P`).

Select your venv's Python interpreter from the auto-detected list. This installs a lightweight bootstrap into the venv's `site-packages` that registers a signal handler. Your project code is not modified.

### 2. Restart Django

Restart your Django server through your normal workflow. The bootstrap loads automatically.

### 3. Attach

Run **Django Debugger: Attach to Django Process** from the Command Palette.

Select the process you want to debug — you'll see the process type, PID, and port. The extension activates debugpy and connects VS Code's debugger.

## Commands

| Command | Description |
|---------|-------------|
| **Django Debugger: Setup** | Install debug bootstrap into your venv |
| **Django Debugger: Attach to Django Process** | Attach debugger to a running Django/Celery process |
| **Django Debugger: Kill Django/Celery Process** | Kill selected processes (multi-select supported) |
| **Django Debugger: Reinstall debugpy** | Remove and reinstall the bundled debugpy |
| **Django Debugger: Clean All** | Remove all bootstrap files, caches, temp files, and restore Python binaries |

## How It Works

1. **Setup** installs a `.pth` file and a small Python module into your venv's `site-packages`. The `.pth` file causes Python to auto-load the module at startup, which registers a signal handler. Only long-running server processes (runserver, celery worker, etc.) are affected — tools like pip, pytest, and language servers are explicitly excluded.

2. **Attach** finds the target process, writes a port number to a temp file, sends SIGUSR1 (or SIGUSR2 for Celery), and waits for debugpy to start listening. Then VS Code connects via DAP (Debug Adapter Protocol) over TCP.

3. debugpy is bundled with the extension — your project's virtualenv stays clean.

## Supported Python Environments

- **asdf** Python versions
- **pyenv** / pyenv-virtualenv
- **conda** (miniconda3, anaconda3, miniforge3)
- **Poetry** virtualenvs
- **pipenv** virtualenvs
- **Homebrew** Python
- Project-local venvs (`.venv`, `venv`, `.virtualenv`, `env`)

## Supported Servers

- `manage.py runserver`
- Celery workers
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

If Python processes are being killed with `zsh: killed`, run **Django Debugger: Clean All** from the Command Palette. This removes all bootstrap files and re-signs Python binaries if macOS has invalidated their code signature.

### Language server crashes

If Jedi or Pylance keeps crashing, run **Clean All** and reload the VS Code window when prompted.

### debugpy installation fails

Run **Django Debugger: Reinstall debugpy** to remove and reinstall the bundled debugpy with your selected Python interpreter.

## License

MIT
