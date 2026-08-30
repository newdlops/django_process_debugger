# Django Process Debugger

Attach a debugger to a running Django or Celery process without modifying your codebase. Designed for macOS Apple Silicon.

## Features

- Detect running Django and Celery processes with PID and port info
- Attach the built-in native tracer at runtime through a private PID-owned control socket — no lldb, process signal, or code changes
- Use the independent native tracer by default, or explicitly select debugpy when you need its compatibility features
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

This installs a lightweight bootstrap into the target runtime's `site-packages` that publishes a private activation socket for supported long-running processes. Your project code is not modified.

### 2. Restart Django

Restart your Django server through your normal workflow (`manage.py runserver`, `uv run python manage.py runserver`, etc.). The bootstrap loads automatically.

The native tracer is the default and needs no debugpy bundle or target-runtime pip. Set `djangoProcessDebugger.engine` to `debugpy` before setup/attach only when you need the debugpy backend.

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
| **Django Debugger: Clean This Workspace** | Remove debugger bootstrap files from this workspace's saved runtime after a safety preview. Does not stop Python processes or touch other runtimes/caches. |
| **Django Debugger: Install MCP for This Workspace** | Configure the current project so Claude Code and Codex can use this VS Code window's debugger MCP endpoint. |
| **Django Debugger: Show MCP Status** | Check project configuration, copied bridge files, the current window registration, and endpoint health. |
| **Django Debugger: Verify MCP Connection** | Launch the installed project bridge and verify MCP initialization, tool discovery, and debugger status end to end. |
| **Django Debugger: Repair MCP for This Workspace** | Safely refresh stale or missing project-local MCP files and client configuration. |

## Agent MCP

Each trusted VS Code window starts its own private, workspace-scoped MCP endpoint. In a trusted project, run **Django Debugger: Install MCP for This Workspace** to add Claude Code (`.mcp.json`) and Codex (`.codex/config.toml`) configuration plus a project-local launcher under `.django-process-debugger/`. The installer copies the two required bridge runtime files into `.django-process-debugger/runtime/`; generated launchers and client configuration contain no absolute workspace or VS Code extension paths, so the project continues to work from nested working directories and after it is moved. Restart or reconnect the agent after installation. After extension upgrades, **Show MCP Status** reports stale copies and **Repair MCP** refreshes them.

The generated configuration executes the project-local `.django-process-debugger/mcp-stdio.js` file with Node.js. Review and version-control these files according to the project's normal policy; installation, repair, and verification are blocked while VS Code Workspace Trust is disabled. Claude uses `CLAUDE_PROJECT_DIR` when available, while both Claude and Codex can locate the launcher by walking up from their current working directory. The generated Codex project configuration uses the `writes` approval mode, so read-only inspection can proceed normally while state-changing debugger tools prompt for approval by default.

The MCP server exposes a deliberately debugger-specific surface:

- inspect the window, setup, and active-session status
- list only Django/Celery targets whose working directory belongs to this workspace, preferring verified traffic listeners over duplicate command-only runserver processes
- attach through the normal `django-process` debug-session path
- add and remove MCP-owned breakpoints without replacing user breakpoints
- wait for session readiness or stops, and report breakpoint verification per live session
- inspect bounded stacks, scopes, variables, Django request context, and failure/exception summaries
- optionally inspect a restricted identifier/attribute/literal-index path, such as `request.user.email`
- pause, continue, step, or disconnect a session

MCP clients never receive the target control socket, DAP authentication credential, or hot-reload lease token. Target selection uses short-lived opaque references instead of accepting arbitrary PIDs, and frame/variable references expire as soon as execution resumes. Runtime setup, process killing, cleanup, `Set Variable`, and arbitrary DAP requests are not exposed. By default, conditional/log breakpoints and expression inspection are also blocked. If `mcp.allowEvaluate` is enabled, breakpoint conditions and log messages may use general debugger expressions; `django_expression_inspect` remains limited to identifier/attribute/literal-index paths and still rejects calls, operators, assignments, and dunder access.

A typical client flow is `django_targets_list` → `django_breakpoints_update` → `django_session_start` → `django_session_wait_ready` → `django_execution_wait` → `django_state_snapshot` or `django_request_context` → `django_execution_control`. Target rows report verified traffic-listener state and a Port Manager network label when one is available, without exposing a PID. `django_breakpoints_status` verifies live adapter breakpoints, `django_failure_snapshot` summarizes a stopped failure, and `django_variables_expand` traverses opaque variable references. In total, the endpoint publishes 13 focused tools.

If the same project is open in more than one VS Code window, launch the agent from the desired window's integrated terminal so the bridge receives that window's identity. The bridge fails rather than choosing an ambiguous window. Multi-root windows use all workspace folders as their access boundary.

Settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `djangoProcessDebugger.mcp.enabled` | `true` | Publish the private endpoint in trusted workspaces. |
| `djangoProcessDebugger.mcp.allowControl` | `true` | Allow attach, MCP-owned breakpoint changes, and execution control. Read-only inspection remains available when disabled. |
| `djangoProcessDebugger.mcp.allowEvaluate` | `false` | Allow conditional/log breakpoints and restricted stopped-frame path inspection. Debugger expressions and property access can execute application code, so enable it only for trusted agents and applications. |

## How It Works

### Debug Engines

`experimental` is the default built-in backend and works without debugpy provisioning. Select `debugpy` explicitly when you need its compatibility features:

```json
{
  "djangoProcessDebugger.engine": "debugpy"
}
```

The experimental tracer currently supports line, conditional, hit-count, raised-exception, uncaught-exception, and Django-request-exception breakpoints, logpoints, hot reload, DAP exception details (`exceptionInfo`), stack frames, scopes, Django request context at ordinary breakpoint stops, variable inspection, Python expression evaluation, Set Variable, continue, pause, step over, step in, and step out. Function breakpoints are not supported yet.

Other VS Code extensions can consume the engine through the API returned by this extension's activation. The stable contract exposes the `django-process` debug type, supported engines, Setup/Status command IDs, and local-PID/hot-reload capabilities; consumers start a normal debug session so they cannot bypass PID locking or engine ownership.

Conditional breakpoints and Evaluate accept Python expressions in the selected frame's globals and locals. They run on the paused application thread, preserving its thread-local and context-variable state. A condition that evaluates to a false value is skipped. If a condition raises, the tracer contains the exception and stops at that breakpoint with an error description instead of allowing the debugger expression to escape into the application. Evaluate errors are returned as failed DAP requests.

The `Raised Exceptions` filter stops at the exception's first raise site, including exceptions that application code catches later, without stopping again as the same exception propagates through callers. Generator/iterator control-flow exceptions (`StopIteration`, `StopAsyncIteration`, and `GeneratorExit`) are skipped. The `Uncaught Exceptions` filter stops post-mortem only when an exception escapes the main Python process entry point or a `threading.Thread.run()` entry point. Selecting both can therefore stop once at the raised phase and again if that exception is ultimately uncaught. Uncaught handling skips `SystemExit` and `KeyboardInterrupt`, and does not cover exceptions retained by asyncio tasks, `sys.unraisablehook` events, child-process failures, or native crashes. Exception details use bounded previews of directly stored `args`, include cause/context chains and Python 3.11+ exception-group children, and do not automatically call an application-defined `__str__` or `__repr__`.

The `Django Request Exceptions` filter observes Django's `got_request_exception` boundary and stops with DAP break mode `userUnhandled` when Django is converting a request exception into an HTTP 500 response. It adds a `Django Request` scope for request context. Selecting it together with `Raised Exceptions` stops first at the raise site and again at the Django boundary. Request bodies, headers, and cookies are not evaluated automatically. Exceptions outside that boundary—including retained asyncio task exceptions, custom middleware that builds its own 500 response, and errors raised later while iterating a streaming response—remain governed by the existing Raised and Uncaught filters.

At an ordinary breakpoint or step stop, the experimental tracer also exposes `Django Request` when an already-loaded `HttpRequest` is directly present in the bounded active stack. It never imports Django for discovery, follows object attributes, or evaluates request properties, `repr()`, or `str()`. The scope is a read-only snapshot of the stored request object, method, path, path info, and resolver match; detached asyncio tasks without a request in their active stack are intentionally not guessed from thread-global state.

At an uncaught or Django-request post-mortem stop, the original frames have already unwound but remain available for stack, scope, variable, and expression inspection. Continue releases the stop; stepping and Set Variable are unavailable for those historical frames.

Hit-count breakpoints count only hits whose normal condition evaluated to true. They accept `N`, `== N`, `> N`, `>= N`, `< N`, `<= N`, and `% N`; `% N` matches every Nth hit. Counts are shared across the process's threads for that breakpoint and reset when breakpoints for its source file are replaced.

Logpoints use literal text with `{python_expression}` placeholders and `{{` or `}}` for literal braces. Values use the same bounded safe rendering as Variables, so application-defined `__repr__`, `__str__`, and properties are not called. A placeholder failure is printed as a type-only diagnostic and never stops the application. Log output is sent through a bounded asynchronous queue so a slow debugger client cannot block the traced request thread; excess messages are dropped with a later summary.

Set Variable evaluates the entered value as a Python expression; for example, use `'ready'` including the quotes to assign a string. It can update existing locals and globals, dictionary entries with string keys, list elements, and existing attributes stored in an instance `__dict__`. It does not create new variables or attributes; slot-only attributes, non-string dictionary keys, tuples, sets, and frozensets remain read-only. If the selected Python runtime cannot safely synchronize an optimized local back to its executing frame, the request fails instead of reporting a display-only change.

Reference objects in Variables and Evaluate use a shallow preview of directly stored `__dict__` fields, such as `<User id=1, name='Kim'>`, instead of showing only a memory address. The preview is bounded and never evaluates properties or application-defined `__repr__`/`__str__`; objects whose state cannot be read safely remain opaque as `<TypeName>`.

For values with safely discoverable hooks, object expansion also shows lazy `repr()`, `str()`, `len()`, standard `@property`, `functools.cached_property`, and native slot rows as `<not evaluated>`. Opening one of those rows evaluates only that member on the selected paused application thread. A failure is shown as a type-only value such as `<evaluation raised RuntimeError>` and does not escape into the application. VS Code's `debug.autoExpandLazyVariables` setting can request these rows automatically; leave it disabled if hooks must run only after an explicit click.

Variables include evaluatable names for identifiers and safe dictionary, sequence, attribute, property, and slot paths, so nested values work naturally with Watch, Copy Value, and related debugger actions. Clipboard-context evaluation returns a larger bounded representation for exact strings and bytes, while clients that request hexadecimal value formatting receive exact integers in `0x` form.

Conditional breakpoint, logpoint, Evaluate, Set Variable, and lazy-member expressions execute inside the target process and are not sandboxed. Function calls and object mutations can have application side effects. A blocking condition, logpoint placeholder, Evaluate, Set Variable, or lazy hook blocks its selected application thread; Evaluate, Set Variable, and lazy requests also stall protocol control for that session. Python cannot safely force-cancel arbitrary evaluation. Expression failures, including `SystemExit` and other `BaseException` subclasses, are contained by the tracer; normal previews and evaluated structured values are rendered without calling an application-defined `__repr__`. Frame and variable references expire when execution resumes, and references for replaced structured values expire immediately, so stale references cannot be used to evaluate or mutate later state.

Changing the setting affects new sessions only. Both engines retain process-level tracing state after a DAP session ends, so the first activated engine owns that PID until it restarts. Restart the target process before attaching it with the other engine.

The experimental DAP listener requires a random 256-bit process credential in its `attach` request. The credential is carried only through private runtime files/session configuration, is compared using a fixed-size digest, and is omitted from debugger logs and the tracer status API. The stable debugpy protocol is unchanged.

On Python 3.11 and earlier, `sys.settrace` cannot retrofit arbitrary already-running threads. Threads created after activation are covered. For threads that already exist, the experimental backend cooperatively enables standard WSGI request threads at the next `request_started` boundary on Django 4.x/5.x, and persistent ASGI event-loop threads on Django 5+ where asynchronous signal dispatch is available. On Django 4.x ASGI, synchronous worker code may be covered, but an event-loop thread created before activation can remain untraced. Other pre-existing service threads may also remain untraced. `django_breakpoints_status.sessions[].traceCoverage` is a bounded snapshot of currently known live threads, separate from source-line verification. The tracer also refuses to replace another coverage/debug/profiling trace hook.

Within `traceCoverage`, `coverage: "all"` means all threads known in that snapshot are believed trace-enabled; it is not a lifetime guarantee for future, native, or subsequently modified threads. `knownThreadCount` and `traceEnabledThreadCount` are snapshot counts. `djangoRequestBridgeModes` reports installed receiver paths such as `wsgi-sync` and `asgi-async`; the request-bridge observation fields separately report whether a receiver actually ran and enabled tracing. `untracedThreadNames` is bounded and may be incomplete.

### Debug Attach

1. **Setup** installs a `.pth` file and a small Python module into your target runtime's `site-packages`. The `.pth` file causes Python to auto-load the module at startup, which creates a private PID-owned Unix control socket and publishes the runtime's exact Python executable and random process identity. Long-running servers and interactive `manage.py shell`/`shell_plus` processes are supported; tools like pip, pytest, and language servers are explicitly excluded via a blocklist.

2. **Attach** finds the target process, resolves the process tree to find the actual debuggable child process (handling `uv run`, `poetry run`, Django autoreloader, etc.), verifies its direct runtime state, and sends an authenticated activation request over that private socket. No process signal is used, so stale PID state fails safely. The process picker shows CWD first, includes its final folder beside the PID, and lets you search by CWD. Then VS Code connects via DAP (Debug Adapter Protocol) over TCP.

3. **debugpy** is shipped as a vendored bundle inside the extension and copied into private extension storage on first use, so your target runtime stays clean. If macOS blocks the Python binary (code signature issue), the extension still auto-repairs it with `codesign --force --deep --sign -` when pip fallback is needed.

### Hot Reload

Hot reload has its own lifecycle and does not start merely because a debug engine is listening. Each live debug session acquires a private, expiring lease for its target PID; only then does the target start its watcher and temporarily suppress Django's autoreloader. VS Code uses one `FileSystemWatcher` for `**/*.py` and independent per-PID reload queues, so simultaneous targets do not block one another. The experimental engine excludes the internal watcher thread from tracing so reload implementation details cannot trigger application breakpoints or Raised exception filters.

The lease is renewed through an atomic `0600` file, which still works while debugger breakpoints suspend Python threads. Turning the setting off, ending the last session for a PID, or deactivating the extension releases the lease. If VS Code or its extension host crashes, the target expires it automatically after a short TTL. On the final release or expiry, the target disconnects only its own `file_changed` receiver and restores `trigger_reload()` only if that hook is still the one it installed, preserving later third-party patches.

When you save a file:

1. The extension writes the changed file path to `/tmp/django-process-debugger/{pid}.reload`
2. The Python watcher thread picks it up and finds the corresponding module in `sys.modules`
3. Before every reload, all currently reachable function/method generations are weakly registered (including references created by an earlier reload)
4. `importlib.reload()` re-executes the module, creating new function objects
5. Every still-live prior generation has its `__code__`, defaults, annotations, and documentation patched — this means existing URL patterns, decorators, closures, and class references execute the updated code
6. Django's autoreloader is suppressed via two layers:
   - `file_changed` signal handler returning `True` (Django's built-in extension point)
   - `trigger_reload()` patched to prevent `sys.exit(3)`

Both layers exist only while at least one valid hot-reload lease is live.

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
- pip only when the vendored debugpy bundle is unavailable and fallback provisioning is required

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `djangoProcessDebugger.engine` | `experimental` | Debug backend for new attach sessions. Restart an already-activated target before switching engines. |
| `djangoProcessDebugger.justMyCode` | `true` | Only debug user-written code. Set to `false` to step into Django/Celery internals. Currently debugpy-only. |
| `djangoProcessDebugger.redirectOutput` | `true` | Redirect `print()` / stdout / stderr to the VS Code Debug Console. Currently debugpy-only. |
| `djangoProcessDebugger.hotReload` | `true` | Hot-reload changed `.py` files without restarting Django. Supported by both debug engines. |

## Telemetry

Release builds can use the official [`@vscode/extension-telemetry`](https://github.com/microsoft/vscode-extension-telemetry) package to send a deliberately small set of usage events to the publisher's Application Insights resource. The reporter follows VS Code's global telemetry level automatically; set `telemetry.telemetryLevel` to `off` to disable transmission.

The extension records successful activation with coarse feature settings; fixed command invocation, outcome, funnel stage, and duration; allowlisted setting changes; aggregate MCP tool outcomes and duration; aggregate hot-reload outcomes, batch size, and duration; and Django debugger session start/termination with its entry point, selected engine, boolean debugger options, and elapsed duration. The telemetry package also supplies common product metadata such as the extension and VS Code versions, OS/architecture, a VS Code session identifier, and VS Code's pseudonymous machine identifier.

It does **not** send workspace names or paths, process IDs or ports, process command lines, MCP arguments/results/references or client identifiers, file or module names from hot reload, Python/Django application data, source or breakpoint contents, evaluated expressions, debug values, error messages, or stack traces. Unknown MCP tool names are normalized to the fixed value `unknown`. The complete machine-readable event classification is in [`telemetry.json`](./telemetry.json).

Telemetry remains disabled when no publisher connection string is configured. A release manifest may provide it as `telemetry.connectionString`; local extension-host and CI runs may instead set `DJANGO_PROCESS_DEBUGGER_TELEMETRY_CONNECTION_STRING`. Application Insights connection strings identify the destination and are [not treated as secrets by the telemetry package](https://github.com/microsoft/vscode-extension-telemetry#setup).

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
- On Python 3.11 and earlier, standard WSGI request threads become trace-enabled at their next request-started boundary. Persistent ASGI event-loop threads receive the same bridge on Django 5+; a Django 4.x ASGI loop that predates activation may remain untraced. Inspect `django_breakpoints_status.sessions[].traceCoverage` when using MCP.
- A breakpoint marked `verified` has resolved to an executable source line. It does not by itself prove that every process thread is trace-enabled.
- The experimental backend will not replace an existing `sys.settrace`/`threading.settrace` hook. Stop the other coverage, profiler, or debugger integration and restart the target first.

### Hot reload not reflecting changes

- Make sure you ran **Setup** and **restarted Django** after the extension was updated. The bootstrap is loaded at process startup — updating the extension alone does not update the running process.
- On attach, the extension checks the bootstrap version and auto-updates if needed, but a Django restart is still required for the new bootstrap to load.
- Hot reload patches all still-live function generations. Changes to **class-level attributes**, **module-level constants consumed at import time**, decorator closure layout, or removed symbols may still require a full restart.

### print() not showing in Debug Console

- `redirectOutput` must be `true` (default). If you changed it, re-attach the debugger.
- Output only appears in the Debug Console for requests **after** the debugger attaches. Pre-attach output goes to the terminal only.

### Python killed after extension use

Run **Django Debugger: Clean This Workspace** to remove bootstrap files from the exact runtime saved by Setup. The cleanup previews its allow-listed scope first and never stops Python processes, scans other runtimes, clears language-server caches, or re-signs unrelated Python binaries. Restart a running Django/Celery process afterward to unload a bootstrap that was already imported.

### Language server crashes

If Jedi or Pylance keeps crashing after Setup, run **Clean This Workspace**, restart the affected Python tools, and inspect the extension logs. The bootstrap uses a strict blocklist to prevent interfering with language servers.

### debugpy installation fails with SIGKILL

The extension automatically detects SIGKILL during pip install and attempts a targeted repair of the selected Python runtime before retrying. If it still fails, use **Reinstall debugpy** or rerun **Setup** with a healthy runtime; workspace cleanup no longer performs broad binary re-signing.

### "Bootstrap not installed" after Setup

Make sure to restart your Django server after running Setup. If using `uv run`, the extension resolves through the wrapper to the actual Python child process automatically.

### Setup picked the wrong runtime

Run **Django Debugger: Show Setup Status** to inspect the saved runtime profile, then rerun **Setup** and pick the runtime that actually launches your Django or Celery process. The picker ranks running server interpreters first to reduce this problem.

## License

MIT
