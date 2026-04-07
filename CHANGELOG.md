# Changelog

## [0.2.0] - 2026-04-07

### Added
- Process port display in QuickPick (PID + Port)
- Kill Django/Celery process command with multi-select support
- Reinstall debugpy command
- Clean All command: removes bootstrap files, clears caches, kills zombie processes, re-signs Python binaries on macOS
- Auto-discovery of Python interpreters from asdf, pyenv, conda, Poetry, pipenv, Homebrew, and workspace venvs
- VS Code selected interpreter detection
- macOS code signature recovery for broken Python binaries

### Changed
- Bootstrap safety: entire module wrapped in try/except to prevent host process crashes
- Stricter process matching: removed broad "django" pattern, added explicit blocklist for tools (pip, jedi, pytest, etc.)
- Venv-only installation guard: refuses to install bootstrap into global site-packages
- Removed "Remove Debug Support" command (replaced by Clean All)

### Fixed
- Bootstrap `.pth` file poisoning all Python processes in the venv (pip, jedi-language-server, etc.)
- Missing pip error output during debugpy installation
- spawn-based process execution for reliable stdout/stderr capture

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
