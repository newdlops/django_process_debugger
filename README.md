# Django Process Debugger

Attach a debugger to a running Django process without modifying your codebase. Designed for macOS Apple Silicon.

## Features

- Detect running Django processes (runserver, daphne, uvicorn, gunicorn)
- Attach debugpy at runtime via SIGUSR1 signal — no lldb, no code-signing required
- Bundled debugpy — no need to install debugpy in your project's virtualenv
- Workspace-level debug session lock to prevent conflicts across VS Code windows
- Dynamic port allocation — no conflicts with other debuggers

## Quick Start

### 1. Setup (one-time per venv)

Run **Django Debugger: Setup** from the Command Palette (`Cmd+Shift+P`).

This installs a lightweight bootstrap into your venv's `site-packages` that registers a SIGUSR1 signal handler. Your project code is not modified.

### 2. Restart Django

Restart your Django server through your normal workflow. The bootstrap loads automatically.

### 3. Attach

Run **Django Debugger: Attach to Django Process** from the Command Palette.

Select the process you want to debug. The extension sends SIGUSR1 to activate debugpy, then connects VS Code's debugger.

## Commands

| Command | Description |
|---------|-------------|
| `Django Debugger: Setup` | Install debug bootstrap into your venv |
| `Django Debugger: Attach to Django Process` | Attach debugger to a running Django process |
| `Django Debugger: Find Django Processes` | List detected Django processes |
| `Django Debugger: Remove Debug Support` | Uninstall the bootstrap from your venv |

## How It Works

1. **Setup** installs a `.pth` file and a small Python module into your venv's `site-packages`. The `.pth` file causes Python to auto-load the module at startup, which registers a SIGUSR1 signal handler.

2. **Attach** finds the target process, writes a port number to a temp file, sends SIGUSR1, and waits for debugpy to start listening. Then VS Code connects via DAP (Debug Adapter Protocol) over TCP.

3. debugpy is bundled with the extension — your project's virtualenv stays clean.

## Requirements

- macOS (Apple Silicon supported)
- Python 3.8+
- pip (for initial debugpy bundling)

## Supported Django Servers

- `manage.py runserver`
- daphne (ASGI)
- uvicorn (ASGI)
- gunicorn (WSGI)

## Cleanup

Run **Django Debugger: Remove Debug Support** to uninstall the bootstrap files from your venv.
