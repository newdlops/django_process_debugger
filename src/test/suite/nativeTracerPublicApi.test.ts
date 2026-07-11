import * as assert from 'assert';
import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { describe, it } from 'mocha';
import { BOOTSTRAP_VERSION } from '../../debugpyInjector';
import { findSystemPython, projectRoot } from './testHelpers';

const execFileAsync = promisify(execFile);

function cleanPythonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT_MANAGER_HOOK: '0',
    PORT_MANAGER_HOOK_DISABLED: '1',
  };
  delete env.DYLD_INSERT_LIBRARIES;
  delete env.LD_PRELOAD;
  return env;
}

describe('Feature: reusable experimental tracer API', function () {
  it('publishes metadata, status, thread control, and both import aliases', async function () {
    this.timeout(20_000);
    const python = await findSystemPython();
    if (!python) { this.skip(); return; }

    const script = String.raw`
import json
import sys
import threading

sys.path.insert(0, sys.argv[1])
import django_process_debugger_tracer as tracer_module
import _django_debug_tracer as legacy_module

assert legacy_module is tracer_module
assert tracer_module.TRACER_API_VERSION == 1
assert tracer_module.TRACER_VERSION == sys.argv[2]
assert tracer_module.EXEMPT_THREAD_ATTRIBUTE == "django_debugger_do_not_trace"

initial = tracer_module.status()
assert initial["apiVersion"] == 1
assert initial["version"] == sys.argv[2]
assert initial["pid"] > 0
assert initial["active"] is False
assert initial["endpoint"] is None
assert initial["clientAttached"] is False

probe = tracer_module.NativeDapTracer()
probe.configured = True
probe.client = object()
thread = threading.current_thread()
frame = sys._getframe()
assert probe._trace(frame, "call", None) is not None
setattr(thread, tracer_module.EXEMPT_THREAD_ATTRIBUTE, True)
assert probe._trace(frame, "call", None) is None
delattr(thread, tracer_module.EXEMPT_THREAD_ATTRIBUTE)
setattr(thread, "pydev_do_not_trace", True)
assert probe._trace(frame, "call", None) is None
delattr(thread, "pydev_do_not_trace")

endpoint = tracer_module.start("127.0.0.1", 0)
active = tracer_module.status()
assert active["active"] is True
assert tuple(active["endpoint"]) == endpoint
assert active["clientAttached"] is False

tracer_module.trace_this_thread(False)
assert sys.gettrace() is None
assert getattr(thread, tracer_module.EXEMPT_THREAD_ATTRIBUTE) is True
tracer_module.trace_this_thread(True)
assert getattr(sys.gettrace(), "__self__", None) is tracer_module._ACTIVE_TRACER
assert getattr(thread, tracer_module.EXEMPT_THREAD_ATTRIBUTE) is False
tracer_module.trace_this_thread(False)

try:
    tracer_module.trace_this_thread(1)
except TypeError:
    pass
else:
    raise AssertionError("non-bool thread tracing flag was accepted")

print(json.dumps(active))
`;
    const { stdout } = await execFileAsync(
      python,
      ['-c', script, path.join(projectRoot(), 'python'), BOOTSTRAP_VERSION],
      { env: cleanPythonEnv(), timeout: 15_000 },
    );
    const status = JSON.parse(stdout.trim()) as Record<string, unknown>;
    assert.strictEqual(status.apiVersion, 1);
    assert.strictEqual(status.version, BOOTSTRAP_VERSION);
    assert.strictEqual(status.active, true);
  });

  it('uses the same singleton when the legacy module name loads first', async function () {
    this.timeout(15_000);
    const python = await findSystemPython();
    if (!python) { this.skip(); return; }

    const tracerPath = path.join(projectRoot(), 'python', 'django_process_debugger_tracer.py');
    const script = String.raw`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("_django_debug_tracer", sys.argv[1])
legacy = importlib.util.module_from_spec(spec)
sys.modules["_django_debug_tracer"] = legacy
spec.loader.exec_module(legacy)
import django_process_debugger_tracer as canonical
assert canonical is legacy
assert sys.modules["_django_debug_tracer"] is sys.modules["django_process_debugger_tracer"]
assert canonical.TRACER_API_VERSION == 1
`;
    await execFileAsync(
      python,
      ['-c', script, tracerPath],
      { env: cleanPythonEnv(), timeout: 10_000 },
    );
  });
});
