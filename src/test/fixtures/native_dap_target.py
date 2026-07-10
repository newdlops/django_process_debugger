#!/usr/bin/env python3
"""Small target process for the dependency-free native DAP integration test."""

import json
import os
import sys
import threading
import time


sys.path.insert(0, sys.argv[1])

from django_process_debugger_tracer import start


class DangerousValue:
    def __repr__(self):
        raise RuntimeError("application repr must not run in debugger")

    def __str__(self):
        raise RuntimeError("application str must not run in debugger")


def calculate(seed):
    payload = {"seed": seed, "items": [seed, seed + 1]}
    large = list(range(500))
    total = sum(payload["items"])
    dangerous = DangerousValue()
    result = total * 2  # BREAKPOINT
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        time.sleep(0.01)
    return result


endpoint = start("127.0.0.1", 0)
same_endpoint = start("127.0.0.1", endpoint[1] + 1)
print(
    json.dumps(
        {
            "pid": os.getpid(),
            "host": endpoint[0],
            "port": endpoint[1],
            "idempotent": endpoint == same_endpoint,
            "source": __file__,
            "debugpy_loaded": any(
                name == "debugpy" or name.startswith("debugpy.")
                for name in sys.modules
            ),
            "pydevd_loaded": any(
                name == "pydevd" or name.startswith("pydevd.")
                for name in sys.modules
            ),
        }
    ),
    flush=True,
)


def request_worker():
    if sys.stdin.readline().strip() != "GO":
        return
    print("RESULT={}".format(calculate(20)), flush=True)


worker = threading.Thread(target=request_worker, name="request-worker")
worker.start()
worker.join(timeout=20.0)
if worker.is_alive():
    raise RuntimeError("debug target worker did not resume")
