# Changelog

## Unreleased

## [0.2.919] - 2026-08-30

- Fixed first-run bootstrap activation after a reboot or temporary-directory cleanup by recreating the private runtime directory before binding the control socket. The bootstrap version is now `2026.08.30.1`, so existing targets must rerun setup and restart to load the fix.
- Added a deterministic cold-start regression plus readiness-gated live MCP-to-Django debugging coverage, and pinned CI to Python 3.14 with short isolated VS Code profiles.

## [0.2.918] - 2026-08-30

- The built-in experimental tracer is now the default for new setup, snippets, direct attaches, and MCP attaches. It installs a usable bootstrap without debugpy or pip; selecting debugpy explicitly still provisions it and requires a process restart after bootstrap changes.
- Discovery preserves worktree-launched targets and normalized loopback listener forms. Attach failures now provide a specific setup, status, log, or restart remedy instead of continuing after runtime inspection/update failures.
- Telemetry now reports privacy-bounded command outcomes and funnel stages, MCP tool outcomes, allowlisted setting changes, hot-reload batch outcomes, and debug-session entry points. Reporter failures are isolated from extension behavior, incomplete session tracking is bounded, and schema-contract, 100,000-event regression, and reproducible multi-million-event durability benchmarks cover the telemetry boundary.
- Release verification now runs on Node.js 22 with the current VS Code Extension Host launcher and disables production telemetry for every automated test host.

## [0.2.914] - 2026-07-13

### Fixed
- Django target discovery now distinguishes verified listeners from command-derived endpoints. When an autoreload or duplicate runserver candidate does not own traffic and a verified listener exists for the same project and port, only the traffic-serving target is offered for attach.
- Loopback relay endpoints are no longer copied by port alone across ambiguous Django targets from different Port Manager networks. Network identity is retained internally, exposed as a bounded target label, and revalidated with listener and port provenance immediately before an MCP attach.

### Added
- Experimental trace coverage now distinguishes a future-thread hook and an installed Django request bridge from request-boundary dispatches and successful per-thread trace activation.

### Tests
- Added regressions for duplicate same-project runservers, cross-network relay ambiguity, Port Manager network metadata, MCP route revalidation, and request-bridge observation diagnostics.

### Runtime
- Bootstrap/tracer version bumped to `2026.07.13.2`; running Django, Daphne, Celery, and shell targets must restart after setup to load the expanded tracer diagnostics.

## [0.2.913] - 2026-07-13

### Fixed
- On Python 3.11 and earlier, the experimental tracer now opts already-running standard WSGI request threads into tracing at `request_started`; on Django 5+, an ASGI-scoped async receiver also covers persistent Daphne/ASGI event-loop threads before middleware and views execute. Django 4.x ASGI event loops created before activation remain an explicit limitation.
- Experimental pause now rejects a known untraced thread instead of returning a success that can never produce a stopped event. MCP prefers trace-enabled threads and reports `THREAD_NOT_TRACE_ENABLED` when no selected thread can currently honor pause.
- The bootstrap activation service thread is explicitly excluded from application tracing.

### Added
- `django_breakpoints_status` now includes a bounded known-live-thread snapshot: Python version, all-thread-hook/request-bridge state and modes, traced and known thread counts, and untraced thread names without exposing DAP thread IDs.

### Tests
- Added a forced Python 3.11-style regression target with a Django 5-style ASGI event loop created before tracer activation, proving sender-scoped request-boundary installation and cleanup, source verification, breakpoint halt, stack inspection, continue, and explicit pre-boundary pause rejection.

### Runtime
- Bootstrap/tracer version bumped to `2026.07.13.1`; running Django, Daphne, Celery, and shell targets must restart after setup so the request-boundary integration is loaded.

## [0.2.912] - 2026-07-13

### Fixed
- Experimental sessions now activate and publish their private DAP credential during debug-configuration resolution, before VS Code snapshots the attach arguments. MCP and direct `launch.json` sessions no longer reach the tracer with a missing credential, and descriptor creation rejects a target generation that changes between configuration and connection.
- Failed `initialize`, `attach`, or `configurationDone` startup now permanently abandons the exact PID-lock generation instead of leaving a pending in-window claim. Tracker error/exit and late lifecycle events share an idempotent cleanup path, and an immediate retry on the same live PID waits for guarded cleanup rather than the pending-lock TTL.
- MCP sessions whose adapter rejects startup now transition to `terminated` immediately instead of timing out in `starting`; reentrant `startDebugging` rejection/throw paths remove both session indexes, and late DAP messages cannot revive retired session references.
- Dynamic `port: 0` activation is logged as a newly selected endpoint instead of misleadingly claiming that an existing endpoint was reused.

### Tests
- Added a real VS Code experimental-session E2E covering authenticated attach, forced post-descriptor authentication failure, lock cleanup, immediate same-PID retry, disconnect, and existing-endpoint reuse.

## [0.2.911] - 2026-07-12

### Added
- Added a private, authenticated, workspace-scoped MCP endpoint per trusted VS Code window, plus portable Claude Code and Codex project configuration.
- Added 13 focused debugger tools for target discovery, attach readiness, MCP-owned breakpoints, execution events/control, bounded state and variable inspection, Django request context, failure summaries, and opt-in restricted path inspection.
- Added **Install MCP**, **Show MCP Status**, **Verify MCP Connection**, and **Repair MCP** commands with copied-runtime/configuration diagnostics.
- Added real stdio → HTTP MCP → VS Code → debugpy breakpoint E2E coverage and concurrent multi-window/client routing tests.

### Security
- MCP clients receive only short-lived opaque target/session/stop/frame/variable references; raw PIDs, activation sockets, DAP credentials, and hot-reload capabilities stay private.
- Project setup, discovery, launcher/runtime verification, and registry ownership fail closed on unsafe paths, stale artifacts, ambiguous windows, ownership races, or cross-project launcher fallback.
- State-changing tools prompt by default in generated Codex configuration. Expression-capable tools are disabled by default, and debugger control is serialized per session with stop-epoch validation.

### Fixed
- MCP session readiness now waits for a successful DAP `configurationDone` response instead of treating VS Code's earlier session-start event as adapter readiness.
- Target references are consumed atomically and their process/workspace identity is revalidated immediately before attach.
- MCP-owned breakpoints are removed when the endpoint is disabled, restarted for workspace changes, or deactivated.

## [0.2.910] - 2026-07-11

### Added
- Added `djangoProcessDebugger.engine` with stable `debugpy` as the default and an explicit `experimental` opt-in for the independent native tracer.
- Added engine-aware attach configuration, status, PID lock metadata, and focused configuration tests.
- Added a dependency-free experimental DAP tracer with line breakpoints, stack/scopes, variable inspection, stepping, pause, and safe protocol-log redaction.
- Added conditional breakpoints and stopped-frame Python expression evaluation to the experimental tracer. Invalid conditions are rejected during breakpoint setup, and runtime condition errors are contained and surfaced as breakpoint descriptions.
- Added process-wide hit-count breakpoints to the experimental tracer with `N`, comparison, and `% N` syntax, condition-aware counting, and source-replacement counter resets.
- Added safe experimental logpoints with compiled `{expression}` placeholders, escaped braces, type-only evaluation errors, and bounded asynchronous DAP output.
- Added experimental Set Variable support for existing locals/globals, string-keyed dictionary entries, list elements, and `__dict__`-backed instance attributes, including target-thread evaluation, CPython fast-local synchronization, and explicit failures for stale, immutable, or unsupported targets.
- Added bounded reference-object previews from directly stored fields without invoking application properties, `__repr__`, or `__str__`.
- Added opt-in lazy Variables rows for application-defined `repr()`, `str()`, `len()`, standard `@property`, `functools.cached_property`, and native slots. Lazy evaluation runs on the selected paused thread, contains `BaseException` failures, and leaves normal previews hook-free.
- Added evaluatable names for safe nested variable paths, clipboard-context rendering for larger strings and bytes, and client-requested hexadecimal integer formatting.
- Added Raised and Uncaught exception breakpoints plus DAP `exceptionInfo` details to the experimental tracer. Raised exceptions stop once at their first raise site, while uncaught process/thread exits provide post-mortem inspection, Evaluate, and Continue with hook-free, bounded `args` previews, chained exceptions, and Python 3.11+ exception-group children.
- Added a `Django Request Exceptions` filter that stops with `userUnhandled` at Django's `got_request_exception` HTTP 500 boundary and exposes a Django request scope without automatically evaluating bodies, headers, or cookies. Selecting it with Raised exceptions provides raise-site and framework-boundary stops; Django-request post-mortem frames support inspection, Evaluate, and Continue but reject stepping and Set Variable, while asyncio-task and non-Django exception coverage remains unchanged.
- Added hot reload support to the experimental tracer using the same bootstrap watcher as debugpy, with the internal reload thread excluded from native tracing.
- Added a declarative extension API v1 for sibling extensions. Consumers start the public `django-process` debug type and retain PID locking, engine ownership, bootstrap validation, and hot reload instead of invoking internal activation helpers.
- Added `manage.py shell` and `shell_plus` to the bootstrap target gate so the debugger can attach directly to live interactive Django shell processes.
- Added a private authenticated activation control socket with per-process runtime identities, replacing process signals for engine activation.
- Added authenticated experimental-DAP attach credentials and PID-scoped, expiring hot-reload leases with independent multi-target queues.
- Added **Clean This Workspace**, a fail-closed cleanup flow that previews an allow-listed scope and removes only the saved runtime's bootstrap plus explicitly owned stale PID artifacts.

### Fixed
- Attach process picker now shows attachable Django server targets grouped by listener host and port, so parent/child/wrapper processes collapse only when they resolve to the same `host:port`.
- Experimental tracer state is discarded safely in forked workers so inherited hooks, sockets, and locks cannot suspend a child without a DAP controller.
- Experimental DAP handles are now stop-scoped and synchronized across threads, with variable paging and bounded message handling.
- Experimental condition, Evaluate, and Set Variable failures, including `BaseException` subclasses, are contained by the debugger instead of escaping into the target application. DAP diagnostics redact both evaluated expressions and their results.
- Process selection now shows CWD before long runtime details, surfaces the project folder beside the PID, supports CWD search, and falls back to a grouped sibling process when the representative has no CWD.
- Variable expansion no longer executes a user-defined `__dict__` descriptor while probing object state.
- PID debug-session claims are now atomic across VS Code windows and expire with their owning extension host, while Restart safely transfers the same claim.
- Hot reload now patches every still-live function generation instead of only the objects present before the first reload, so URL-conf, class, and decorated references captured after earlier reloads continue updating. Request claiming and result publication are atomic and request-correlated, eliminating worker unlink/chmod races, partial results, stale-result mixups, and overlapping VS Code flushes.
- Experimental host integrations can opt individual user-code threads into tracing while keeping backend service workers exempt; canonical and legacy tracer imports now share one process-wide singleton.
- Generated `.django-shell` analysis and console-cell files are excluded from hot reload requests.
- Active endpoint records now bind the engine listener to the current target PID, runtime identity, and bootstrap version. Legacy or mismatched records are rejected before listener reuse and identity is checked again after listener discovery to close PID-reuse races.
- Extension tests now allocate ephemeral loopback ports instead of sharing fixed ports across concurrent runs and port-manager environments.

### Security
- Removed the tracked runtime `log.txt`, which could contain debugger variable payloads, and added CI protection against adding it again.
- Experimental DAP credentials, activation identities, and hot-reload capabilities are stored in private `0600` records and omitted from protocol logs and public status APIs.

### Changed
- Replaced the destructive global `Clean All` behavior. Cleanup no longer scans home/global Python installs, stops Python or language-server processes, clears unrelated caches, removes shared debugpy storage, or broadly re-signs Python binaries.
- Bootstrap/tracer version bumped to `2026.07.11.4`. Existing runtimes auto-update on the next attach; restart running Django/Celery/shell processes afterward so the host-integration contract is loaded.

## [0.2.7] - 2026-06-09

### Fixed
- **Celery workers (and any `python -m …` server) could not be attached** — the bootstrap's process gate inspected `sys.argv`, but at `.pth`/`site` initialization time `python -m celery worker …` has already had its `sys.argv` rewritten to `['-m', '<args…>']`: the module name (`celery`) is stripped and `argv[0]` is the literal `'-m'`. So the `"celery worker"` / `"-m celery worker"` patterns never matched, the SIGUSR1/SIGUSR2 handler was never installed, and attaching failed with `BootstrapNotLoadedError` even after a clean restart. (Django `runserver` was unaffected because it launches as a script, so its `argv` stays intact.) The gate now reads `sys.orig_argv` (Python 3.10+), which preserves the real command line, matches celery by the `celery` + `worker` tokens (tolerating `-A app` in between), and falls back to a `-m … worker` heuristic on Python < 3.10. ASGI/WSGI servers launched via `-m uvicorn|gunicorn|daphne` are now detected as well.
- Removed the overly-broad `"site-packages"` entry from the tool blocklist: under `python -m <tool>` it could match `argv[0]` (e.g. `…/site-packages/celery/__main__.py`) and falsely exclude real servers. Tool exclusion now relies on the `-m pip` / `-m pytest` / … patterns, which `sys.orig_argv` makes reliable.

### Changed
- Bootstrap version bumped to `2026.06.09.1`. Existing venvs auto-upgrade on next attach; **restart the Django/Celery process afterward** so the new bootstrap loads at startup.

### Added — tests
- Regression test: a `python -m celery worker` invocation now installs the signal handler. The gating suite previously only covered the script-form `manage.py runserver`, which is why this regression went unnoticed.

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
