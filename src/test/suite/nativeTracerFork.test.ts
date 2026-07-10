import * as assert from 'assert';
import { execFile } from 'child_process';
import * as path from 'path';
import { describe, it } from 'mocha';
import { findSystemPython, projectRoot } from './testHelpers';

describe('Feature: experimental tracer fork safety', function () {
  it('drops inherited hooks, sockets, state, and locked synchronization primitives', async function () {
    this.timeout(20_000);
    if (process.platform === 'win32') {
      this.skip();
      return;
    }

    const python = await findSystemPython();
    if (!python) {
      this.skip();
      return;
    }

    const script = String.raw`
import json
import os
import select
import signal
import sys
import threading
import traceback

sys.path.insert(0, sys.argv[1])
import django_process_debugger_tracer as tracer_module

endpoint = tracer_module.start("127.0.0.1", 0)
inherited = tracer_module._ACTIVE_TRACER
inherited.configured = True
inherited.breakpoints = {"inherited.py": {10}}
inherited.steps = {123: ("next", 4)}
inherited_server = inherited.server
old_condition = inherited.condition
old_send_lock = inherited.send_lock
old_active_lock = tracer_module._ACTIVE_LOCK

locks_held = threading.Event()
release_locks = threading.Event()

def hold_inherited_locks():
    with tracer_module._ACTIVE_LOCK:
        with inherited.condition:
            locks_held.set()
            release_locks.wait(10)

holder = threading.Thread(target=hold_inherited_locks, daemon=True)
holder.start()
if not locks_held.wait(5):
    raise RuntimeError("failed to hold inherited locks")

read_fd, write_fd = os.pipe()
child_pid = os.fork()
if child_pid == 0:
    os.close(read_fd)
    result = {}
    try:
        result.update({
            "active_cleared": tracer_module._ACTIVE_TRACER is None,
            "active_lock_replaced": tracer_module._ACTIVE_LOCK is not old_active_lock,
            "old_tracer_disabled": inherited.enabled is False,
            "old_endpoint_cleared": inherited.endpoint is None,
            "old_server_reference_cleared": inherited.server is None,
            "old_server_fd_closed": inherited_server.fileno() == -1,
            "current_trace_cleared": sys.gettrace() is None,
            "future_trace_cleared": tracer_module._existing_thread_trace_hook() is None,
            "condition_replaced": inherited.condition is not old_condition,
            "send_lock_replaced": inherited.send_lock is not old_send_lock,
            "breakpoints_cleared": inherited.breakpoints == {},
            "steps_cleared": inherited.steps == {},
        })
        child_endpoint = tracer_module.start("127.0.0.1", 0)
        result.update({
            "child_reactivated": tracer_module._ACTIVE_TRACER is not inherited,
            "child_listener_distinct": child_endpoint != endpoint,
        })
        tracer_module._ACTIVE_TRACER._shutdown()
    except BaseException:
        result["error"] = traceback.format_exc()
    os.write(write_fd, json.dumps(result, sort_keys=True).encode("utf-8"))
    os.close(write_fd)
    os._exit(0)

os.close(write_fd)
release_locks.set()
holder.join(5)

try:
    readable, _, _ = select.select([read_fd], [], [], 8)
    if not readable:
        os.kill(child_pid, signal.SIGKILL)
        os.waitpid(child_pid, 0)
        raise RuntimeError("forked child deadlocked during tracer reset")
    child_result = json.loads(os.read(read_fd, 1024 * 1024).decode("utf-8"))
    _, child_status = os.waitpid(child_pid, 0)
    parent_result = {
        "parent_tracer_preserved": tracer_module._ACTIVE_TRACER is inherited and inherited.enabled,
        "parent_listener_preserved": inherited.server is inherited_server and inherited_server.fileno() >= 0,
        "child_exited_cleanly": os.WIFEXITED(child_status) and os.WEXITSTATUS(child_status) == 0,
    }
    print(json.dumps({"child": child_result, "parent": parent_result}, sort_keys=True))
finally:
    os.close(read_fd)
    inherited._shutdown()
`;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT_MANAGER_HOOK: '0',
      PORT_MANAGER_HOOK_DISABLED: '1',
    };
    delete env.DYLD_INSERT_LIBRARIES;
    delete env.LD_PRELOAD;

    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        python,
        ['-c', script, path.join(projectRoot(), 'python')],
        { env, timeout: 15_000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`${error.message}\n${stderr}`));
            return;
          }
          resolve(stdout.trim());
        },
      );
    });

    const result = JSON.parse(output) as {
      child: Record<string, unknown>;
      parent: Record<string, unknown>;
    };
    assert.strictEqual(result.child.error, undefined);
    for (const [name, value] of Object.entries(result.child)) {
      assert.strictEqual(value, true, `child check failed: ${name}`);
    }
    for (const [name, value] of Object.entries(result.parent)) {
      assert.strictEqual(value, true, `parent check failed: ${name}`);
    }
  });
});
