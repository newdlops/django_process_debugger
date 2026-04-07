# Changelog

## [0.2.0] - 2026-04-07

### Added
- Process port display in QuickPick (PID + Port)
- Port-grouped QuickPick: parent/child/wrapper processes on the same port shown as one entry
- Process tree resolution: select any process (uv wrapper, autoreloader, or child) and debugger attaches to the correct leaf Python process
- Kill Django/Celery process command with multi-select support
- Reinstall debugpy command
- Clean All command with 7-step full reset:
  1. Remove bootstrap files from all Python environments
  2. Clean temp files
  3. Kill all stale Python processes (language servers, Django/Celery, zombies)
  4. Clear Jedi/parso caches
  5. Remove bundled debugpy
  6. Remove debug session lock
  7. Repair macOS code signatures (quarantine removal + ad-hoc re-signing)
- Auto-discovery of Python interpreters from asdf, pyenv, mise, conda, Poetry, pipenv, Homebrew, and workspace venvs
- VS Code selected interpreter detection
- macOS code signature auto-repair during pip install (detects SIGKILL, re-signs, retries)
- Support for `uv run`, `poetry run`, `pipenv run` wrapper processes
- Support for `manage.py run_huey`

### Changed
- Bootstrap safety: entire module wrapped in try/except to prevent host process crashes
- Stricter process matching: removed broad "django" pattern, added explicit blocklist for tools (pip, jedi, pytest, mypy, pylint, black, isort, ruff, language-server, etc.)
- Global Python setup now allowed with warning (was blocked; Clean All can recover)
- Removed "Remove Debug Support" command (replaced by Clean All)
- pip installation uses spawn with signal capture instead of execFile

### Fixed
- Bootstrap `.pth` file poisoning all Python processes in the venv (pip, jedi-language-server, etc.)
- `uv run python` wrapper processes failing to attach (now resolves through process tree)
- Missing pip error output during debugpy installation
- macOS code signature invalidation caused by repeated Python crashes

## [0.1.0] - 2026-04-06

### Added
- Initial release
- Detect running Django processes (runserver, daphne, uvicorn, gunicorn)
- Detect Celery worker processes
- Attach debugpy at runtime via SIGUSR1/SIGUSR2 signal
- Bundled debugpy installation (no venv pollution)
- Workspace-level debug session lock
- Dynamic port allocation
- Setup and teardown commands
- justMyCode configuration option
