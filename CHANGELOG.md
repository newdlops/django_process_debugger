# Changelog

## [0.2.5] - 2026-04-17

### Fixed
- **Hot reload silently failing at breakpoints** — when debugpy stopped all threads at a breakpoint, the Python-side reload watcher thread was also frozen, so reload requests timed out against the extension's fixed 1s wait and disappeared from the UI. The extension now polls for the result (3s short poll, then 60s long poll if the request is still queued) and tracks paused sessions via DAP `stopped`/`continued` events. Queued reloads now surface as a `$(clock) Reload queued — continue to apply` status bar indicator and are delivered the moment execution resumes.
- **Decorator-wrapped methods not seeing new code after reload** — functions decorated with `@functools.wraps` capture the inner function in a closure; patching only the wrapper's `__code__` left the closure pointing at the pre-reload body, so GraphQL resolvers / Django views wrapped with `@login_required`, `@company_owner_required`, etc. reported reload success but served stale code. The bootstrap's `_deep_reload_module` now follows the `__wrapped__` chain and patches every level of the unwrap graph. Patched entries for multi-level wrappers are reported as `name (+N unwrapped)`.
- **Misleading "patched" list for imported symbols** — `from typing import TypedDict, cast` and similar imports were appearing in the reload result's patched list, obscuring what actually changed. `_deep_reload_module` now skips any symbol whose `__module__` doesn't match the reloaded module.

### Changed
- Bootstrap version bumped to `2026.04.17`. Existing venvs auto-upgrade on next attach.
- `DebugpyInjector` gained `pollReloadResult(pid, timeoutMs, intervalMs)` and `isReloadPending(pid)` for non-blocking result retrieval.
- `FileSystemWatcher` exclusion rule extracted to `src/hotReloadFilter.ts` (`shouldIgnoreForHotReload`) for unit testing.

### Added — developer tooling
- End-to-end test infrastructure (`src/test/suite/*.test.ts`, `@vscode/test-electron`) covering:
  - Process discovery (single + multi-process)
  - Bootstrap install/update/uninstall lifecycle + non-target process gating
  - Hot reload full cycle via a Python harness that mirrors the bootstrap's reload watcher and deep-reload logic
  - Hot reload reference semantics (URL-conf dict capture, class-method in-place patching, module indirection, constant by-value capture, async coroutine capture)
  - Multi-worker isolation (one worker reloaded, others untouched)
  - Breakpoint-deadlock recovery, decorator unwrap, import filter
- `PerfReporter` generates `test-results/perf-report.md` + `.json` on every `npm test` run, recording per-measurement wall times.
- `optimization.md` — prioritized improvement backlog with before/after baselines, scenario matrix, and production-bug diagnosis rooted in real `log.txt` evidence.

## [0.2.4] - 2026-04-15

### Added
- **Hot Reload**: Edit Python files while debugging — changes are applied instantly without restarting Django or losing your debug session
  - Background watcher thread in the Django process monitors for reload requests
  - `importlib.reload()` + `__code__` patching ensures all existing references (URL patterns, decorators, CBV `as_view()` closures) execute the updated code
  - Persistent original-reference tracking: always patches the functions Django actually holds, even after multiple edits
  - Status bar indicator shows hot reload state
  - File change debouncing (500ms) to batch rapid saves
  - Skips non-project files (site-packages, __pycache__, venv, migrations)
- **Django autoreloader suppression** (two-layer):
  - `file_changed` signal handler returning `True` (Django's built-in extension point)
  - `trigger_reload()` patched to prevent `sys.exit(3)`
  - Works with both `StatReloader` and `WatchmanReloader` (Django 4.x/5.x)
- **`redirectOutput` setting** (default: `true`): `print()` and stdout/stderr now appear in the VS Code Debug Console instead of only in the terminal
- **`hotReload` setting** (default: `true`): toggle hot reload on/off
- **Bootstrap auto-update on attach**: detects outdated bootstrap versions and auto-updates site-packages (Django restart still required to load the new bootstrap)
- **Bootstrap version check**: `isBootstrapUpToDate()` method compares installed vs current version

### Changed
- Debug configuration now includes `redirectOutput` flag in DAP attach request
- Bootstrap version bumped to `2026.04.15`

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
