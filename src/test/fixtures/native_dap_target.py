#!/usr/bin/env python3
"""Small target process for the dependency-free native DAP integration test."""

import json
import os
import sys
import threading
import time
import types


sys.path.insert(0, sys.argv[1])

from django_process_debugger_tracer import start


AUTH_TOKEN = "0123456789abcdef" * 4
GLOBAL_VALUE = 5
SHADOWED_VALUE = "global"
REQUEST_HOOK_CALLS = []


class HttpRequest:
    pass


class WSGIRequest(HttpRequest):
    def __init__(self):
        self.method = "GET"
        self.path = "/orders/42/"
        self.path_info = "/orders/42/"
        self.resolver_match = "orders:detail"

    def __repr__(self):
        REQUEST_HOOK_CALLS.append("repr")
        raise RuntimeError("request repr must stay lazy")

    def __str__(self):
        REQUEST_HOOK_CALLS.append("str")
        raise RuntimeError("request str must stay lazy")

    @property
    def body(self):
        REQUEST_HOOK_CALLS.append("body")
        raise RuntimeError("request body must not be evaluated")


django_module = types.ModuleType("django")
django_http_module = types.ModuleType("django.http")
django_request_module = types.ModuleType("django.http.request")
django_request_module.HttpRequest = HttpRequest
sys.modules["django"] = django_module
sys.modules["django.http"] = django_http_module
sys.modules["django.http.request"] = django_request_module


class DangerousValue:
    def __init__(self):
        self.state = "original"

    def __repr__(self):
        raise RuntimeError("application repr must not run in debugger")

    def __str__(self):
        raise RuntimeError("application str must not run in debugger")


class LazyValue:
    __slots__ = ("_calls", "label")

    def __init__(self, calls):
        self._calls = calls
        self.label = "ready"

    def __repr__(self):
        self._calls.append(("repr", threading.current_thread().name))
        return "LazyValue(label={!r})".format(self.label)

    def __str__(self):
        self._calls.append(("str", threading.current_thread().name))
        return "lazy:{}".format(self.label)

    @property
    def worker_name(self):
        self._calls.append(("property", threading.current_thread().name))
        return threading.current_thread().name

    @property
    def structured(self):
        self._calls.append(("structured", threading.current_thread().name))
        return [self.label, threading.current_thread().name]

    @property
    def runtime_error(self):
        self._calls.append(("runtime_error", threading.current_thread().name))
        raise RuntimeError("lazy property failed")

    @property
    def system_exit(self):
        self._calls.append(("system_exit", threading.current_thread().name))
        raise SystemExit("lazy property must not escape")


def calculate(seed):
    SHADOWED_VALUE = "local"
    payload = {"seed": seed, "items": [seed, seed + 1]}
    large = list(range(500))
    total = sum(payload["items"])
    condition_false_probe = None  # CONDITION_FALSE
    dangerous = DangerousValue()  # CONDITION_ERROR
    lazy_calls = []
    lazy_value = LazyValue(lazy_calls)
    for hit_index in range(1, 5):
        hit_probe = hit_index  # HIT_LOGPOINT
    result = total * 2  # BREAKPOINT
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        time.sleep(0.01)
    return result


endpoint = start("127.0.0.1", 0, auth_token=AUTH_TOKEN)
same_endpoint = start(
    "127.0.0.1",
    endpoint[1] + 1,
    auth_token=AUTH_TOKEN,
)
print(
    json.dumps(
        {
            "pid": os.getpid(),
            "host": endpoint[0],
            "port": endpoint[1],
            "authToken": AUTH_TOKEN,
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
    request = WSGIRequest()
    print("RESULT={}".format(calculate(20)), flush=True)


worker = threading.Thread(target=request_worker, name="request-worker")
worker.start()
worker.join(timeout=20.0)
if worker.is_alive():
    raise RuntimeError("debug target worker did not resume")
