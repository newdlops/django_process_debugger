#!/usr/bin/env python3
"""Dependency-free Django request-exception target for native DAP tests."""

import json
import os
import queue
import sys
import threading
import types


TEXT_HOOKS = []


class Signal:
    """Small subset of django.dispatch.Signal used by the tracer integration."""

    def __init__(self):
        self.receivers = []

    def connect(self, receiver, sender=None, weak=True, dispatch_uid=None):
        key = dispatch_uid if dispatch_uid is not None else receiver
        for current_key, _current_receiver in self.receivers:
            if current_key == key:
                return
        self.receivers.append((key, receiver))

    def disconnect(self, receiver=None, sender=None, dispatch_uid=None):
        key = dispatch_uid if dispatch_uid is not None else receiver
        original_count = len(self.receivers)
        self.receivers[:] = [
            (current_key, current_receiver)
            for current_key, current_receiver in self.receivers
            if current_key != key
        ]
        return len(self.receivers) != original_count

    def send(self, sender, **named):
        return [
            (receiver, receiver(signal=self, sender=sender, **named))
            for _key, receiver in tuple(self.receivers)
        ]


def install_fake_django():
    django = types.ModuleType("django")
    django.__path__ = []
    core = types.ModuleType("django.core")
    core.__path__ = []
    signals = types.ModuleType("django.core.signals")
    handlers = types.ModuleType("django.core.handlers")
    handlers.__path__ = []
    exception_handler = types.ModuleType("django.core.handlers.exception")

    signals.got_request_exception = Signal()
    handler_source = """
from django.core.signals import got_request_exception


def response_for_exception(request, exc):
    handler_local_marker = "handler local exc fallback"
    got_request_exception.send(sender=None, request=request)
    return {"status": 500, "marker": handler_local_marker}
"""

    sys.modules["django"] = django
    sys.modules["django.core"] = core
    sys.modules["django.core.signals"] = signals
    sys.modules["django.core.handlers"] = handlers
    sys.modules["django.core.handlers.exception"] = exception_handler
    django.core = core
    core.signals = signals
    core.handlers = handlers
    handlers.exception = exception_handler
    exec(
        compile(
            handler_source,
            os.path.join(os.path.dirname(__file__), "django/core/handlers/exception.py"),
            "exec",
        ),
        exception_handler.__dict__,
    )
    return exception_handler.response_for_exception


response_for_exception = install_fake_django()

sys.path.insert(0, sys.argv[1])

from django_process_debugger_tracer import start


class RequestProblem(Exception):
    def __str__(self):
        TEXT_HOOKS.append("exception-str")
        raise RuntimeError("debugger must not invoke exception __str__")

    def __repr__(self):
        TEXT_HOOKS.append("exception-repr")
        raise RuntimeError("debugger must not invoke exception __repr__")


class FakeRequest:
    def __init__(self, method, path, path_info):
        self.method = method
        self.path = path
        self.path_info = path_info

    def __str__(self):
        TEXT_HOOKS.append("request-str")
        raise RuntimeError("debugger must not invoke request __str__")

    def __repr__(self):
        TEXT_HOOKS.append("request-repr")
        raise RuntimeError("debugger must not invoke request __repr__")


def synchronous_request_exception():
    request = FakeRequest("POST", "/shop/orders/42/", "/orders/42/")
    route_value = 41
    try:
        raise RequestProblem("sync request problem")  # SYNC_RAISE
    except RequestProblem as exc:
        response_for_exception(request, exc)  # SYNC_HANDLER
    return route_value


def handler_local_fallback_exception():
    request = FakeRequest("GET", "/app/fallback/", "/fallback/")
    fallback_value = 9
    try:
        raise RequestProblem("fallback request problem")  # FALLBACK_RAISE
    except RequestProblem as captured:
        saved_exception = captured
    # There is no active exception context here. The integration must recover
    # the exception from response_for_exception's local ``exc`` value.
    response_for_exception(request, saved_exception)  # FALLBACK_HANDLER
    return fallback_value


ASGI_EXCEPTION_QUEUE = queue.Queue(maxsize=1)
ASGI_RESULT_QUEUE = queue.Queue(maxsize=1)


def asgi_like_cross_thread_exception():
    request = FakeRequest("PATCH", "/asgi/orders/42/", "/orders/42/")
    origin_value = 17
    try:
        raise RequestProblem("asgi request problem")  # ASGI_ORIGIN_RAISE
    except RequestProblem as exc:
        ASGI_EXCEPTION_QUEUE.put((request, exc))
    ASGI_RESULT_QUEUE.get(timeout=20.0)
    return origin_value


COMMANDS = {
    "SYNC": synchronous_request_exception,
    "FALLBACK": handler_local_fallback_exception,
    "ASGI": asgi_like_cross_thread_exception,
}


endpoint = start("127.0.0.1", 0)
print(
    json.dumps(
        {
            "pid": os.getpid(),
            "host": endpoint[0],
            "port": endpoint[1],
            "source": __file__,
        }
    ),
    flush=True,
)


worker_pool = []
asgi_boundary_worker = None


def initialize_worker_pool():
    global asgi_boundary_worker

    # Construct all threading/queue machinery before exception filters are
    # enabled. CPython's threading helpers use caught AttributeError probes,
    # which are legitimate raised events but unrelated to this fixture.
    for index in range(8):
        commands = queue.Queue(maxsize=1)

        def run_one(command_queue=commands):
            command = command_queue.get()
            threading.current_thread().name = "django-exception-worker-{}".format(
                command.lower()
            )
            COMMANDS[command]()

        worker = threading.Thread(
            target=run_one,
            name="django-exception-worker-pool-{}".format(index),
            daemon=True,
        )
        worker.start()
        worker_pool.append((worker, commands))

    def run_asgi_boundary():
        threading.current_thread().name = "django-asgi-boundary-worker"
        request, exc = ASGI_EXCEPTION_QUEUE.get()
        try:
            raise exc  # ASGI_WORKER_RERAISE
        except RequestProblem as reraised:
            response_for_exception(request, reraised)  # ASGI_HANDLER
        ASGI_RESULT_QUEUE.put(True)

    asgi_boundary_worker = threading.Thread(
        target=run_asgi_boundary,
        name="django-asgi-boundary-worker",
        daemon=True,
    )
    asgi_boundary_worker.start()


for raw_command in sys.stdin:
    command = raw_command.strip()
    if command == "QUIT":
        break
    if command not in COMMANDS:
        print("UNKNOWN:{}".format(command), flush=True)
        continue
    if not worker_pool:
        initialize_worker_pool()
    TEXT_HOOKS[:] = []
    worker, commands = worker_pool.pop(0)
    commands.put(command)
    worker.join(timeout=20.0)
    if worker.is_alive():
        raise RuntimeError("Django exception target worker did not resume")
    print(
        "DONE:{}:HOOKS={}".format(command, len(TEXT_HOOKS)),
        flush=True,
    )
