import * as assert from 'assert';
import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { describe, it } from 'mocha';
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

describe('Feature: experimental tracer safety boundaries', function () {
  it('refuses to replace an existing Python trace hook', async function () {
    const python = await findSystemPython();
    if (!python) {
      this.skip();
      return;
    }

    const script = String.raw`
import sys
import threading
sys.path.insert(0, sys.argv[1])
import django_process_debugger_tracer as tracer

def existing(frame, event, arg):
    return existing

sys.settrace(existing)
threading.settrace(existing)
try:
    tracer.start()
except RuntimeError as exc:
    assert "will not replace" in str(exc), str(exc)
    assert sys.gettrace() is existing, "current-thread hook was erased"
    assert tracer._existing_thread_trace_hook() is existing, "future-thread hook was erased"
    assert tracer._ACTIVE_TRACER is None, "failed activation retained tracer ownership"
    print("REFUSED")
else:
    raise AssertionError("experimental tracer replaced an existing hook")
finally:
    sys.settrace(None)
    threading.settrace(None)
`;
    const { stdout } = await execFileAsync(
      python,
      ['-c', script, path.join(projectRoot(), 'python')],
      { env: cleanPythonEnv(), timeout: 10_000 },
    );
    assert.match(stdout, /REFUSED/);
  });

  it('serializes handle creation and expiration across threads', async function () {
    const python = await findSystemPython();
    if (!python) {
      this.skip();
      return;
    }

    const script = String.raw`
import sys
import threading
sys.path.insert(0, sys.argv[1])
from django_process_debugger_tracer import NativeDapTracer

tracer = NativeDapTracer()
native_id = 1234
errors = []

def create_handles():
    try:
        for index in range(20000):
            tracer._handle_value(native_id, [index])
    except BaseException as exc:
        errors.append(exc)

def expire_handles():
    try:
        for _ in range(20000):
            tracer._expire_handles(native_id)
    except BaseException as exc:
        errors.append(exc)

threads = [threading.Thread(target=create_handles), threading.Thread(target=expire_handles)]
for thread in threads:
    thread.start()
for thread in threads:
    thread.join()
assert not errors, errors
print("SYNCHRONIZED")
`;
    const { stdout } = await execFileAsync(
      python,
      ['-c', script, path.join(projectRoot(), 'python')],
      { env: cleanPythonEnv(), timeout: 20_000 },
    );
    assert.match(stdout, /SYNCHRONIZED/);
  });

  it('rejects inherited trace work and a stop racing with disconnect', async function () {
    const python = await findSystemPython();
    if (!python) {
      this.skip();
      return;
    }

    const script = String.raw`
import gc
import os
import socket
import sys
import threading
sys.path.insert(0, sys.argv[1])
from django_process_debugger_tracer import NativeDapTracer

# This is the state visible in a forked child before Python reaches the
# tracer's registered after-fork cleanup callback.
inherited = NativeDapTracer()
inherited.owner_pid = os.getpid() + 1
inherited.configured = True
inherited.steps[threading.get_ident()] = ("stepIn", 0)
pause_calls = []
inherited._pause = lambda *args: pause_calls.append(args)
assert inherited._trace(sys._getframe(), "line", None) is None
assert not pause_calls, "inherited step was evaluated before the PID guard"
assert inherited.enabled is False and inherited.configured is False

# A recycled CPython thread identifier must receive a fresh DAP identity and
# cannot inherit pending controls from the dead Thread object.
reused = NativeDapTracer()
old_thread = threading.Thread(name="old-worker")
new_thread = threading.Thread(name="new-worker")
first_dap_id = reused._thread_id(777, old_thread)
reused.steps[777] = ("stepOut", 4)
reused.pause_requests.add(777)
second_dap_id = reused._thread_id(777, new_thread)
assert second_dap_id != first_dap_id
assert 777 not in reused.steps and 777 not in reused.pause_requests

authoritative = NativeDapTracer()
live_thread = threading.current_thread()
live_ident = threading.get_ident()
live_dap_id = authoritative._thread_id(live_ident, live_thread)
authoritative.steps[live_ident] = ("next", 3)

class StaleSnapshot:
    ident = live_ident
    name = "stale-enumeration-row"

    @staticmethod
    def is_alive():
        return True

assert authoritative._thread_id_for_snapshot(live_ident, StaleSnapshot()) is None
assert authoritative.native_threads[live_ident] is live_thread
assert authoritative.native_to_dap[live_ident] == live_dap_id
assert authoritative.steps[live_ident] == ("next", 3)

pruned = NativeDapTracer()
ephemeral = threading.Thread(name="ephemeral-worker")
pruned._thread_id(999, ephemeral)
del ephemeral
gc.collect()
with pruned.condition:
    pruned._prune_dead_thread_mappings_locked()
assert 999 not in pruned.native_threads
assert 999 not in pruned.native_to_dap

# Force disconnect to race while _pause() is emitting stopped. The state/event
# transition must remain serialized, then disconnect must wake the stop.
tracer = NativeDapTracer()
client, peer = socket.socketpair()
tracer.client = client
tracer.configured = True
entered = threading.Event()
proceed = threading.Event()
drop_finished = threading.Event()
worker_errors = []
drop_errors = []

def block_stopped_event(*args, **kwargs):
    entered.set()
    proceed.wait(2)
    return True

tracer._event = block_stopped_event

def race_pause():
    try:
        tracer._pause(1234, sys._getframe(), "breakpoint", client)
    except BaseException as exc:
        worker_errors.append(exc)

worker = threading.Thread(
    target=race_pause,
    daemon=True,
)
worker.start()
assert entered.wait(1), "pause worker did not reach the race window"

def race_drop():
    try:
        tracer._drop_client(client)
    except BaseException as exc:
        drop_errors.append(exc)
    finally:
        drop_finished.set()

dropper = threading.Thread(target=race_drop, daemon=True)
dropper.start()
assert not drop_finished.wait(0.05), "disconnect bypassed the stop transition lock"
proceed.set()
worker.join(1)
dropper.join(1)
peer.close()
assert not worker.is_alive(), "stale stop waited after client disconnect"
assert not dropper.is_alive(), "disconnect did not complete"
assert not worker_errors, worker_errors
assert not drop_errors, drop_errors
assert not tracer.stops
assert not tracer.native_threads and not tracer.native_to_dap and not tracer.dap_to_native

bound = NativeDapTracer()
bound_client, bound_peer = socket.socketpair()
bound.client = bound_client
bound.configured = True
event_clients = []

def capture_event(*args, **kwargs):
    event_clients.append(kwargs.get("expected_client"))
    return False

bound._event = capture_event
bound._pause(4321, sys._getframe(), "breakpoint", bound_client)
bound_client.close()
bound_peer.close()
assert event_clients == [bound_client], "stopped event was not bound to its DAP client"
print("RACES_CLOSED")
`;
    const { stdout } = await execFileAsync(
      python,
      ['-c', script, path.join(projectRoot(), 'python')],
      { env: cleanPythonEnv(), timeout: 10_000 },
    );
    assert.match(stdout, /RACES_CLOSED/);
  });
});
