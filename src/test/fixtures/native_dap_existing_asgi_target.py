#!/usr/bin/env python3
"""Persistent ASGI-loop target for the Python 3.11 request trace bridge."""

import asyncio
import functools
import inspect
import json
import os
import sys
import threading
import types


sys.path.insert(0, sys.argv[1])


class RequestStartedSignal:
    def __init__(self):
        self.receivers = []

    def connect(self, receiver, sender=None, weak=True, dispatch_uid=None):
        lookup_key = (
            dispatch_uid if dispatch_uid is not None else id(receiver),
            id(sender),
        )
        # Match Django's duplicate handling: an existing lookup key wins. This
        # catches cleanup bugs that a fake "replace by UID" implementation
        # would otherwise conceal during reconfiguration or reattach.
        if any(entry[0] == lookup_key for entry in self.receivers):
            return
        self.receivers.append((lookup_key, sender, receiver))

    def disconnect(self, receiver=None, sender=None, dispatch_uid=None):
        lookup_key = (
            dispatch_uid if dispatch_uid is not None else id(receiver),
            id(sender),
        )
        before = len(self.receivers)
        self.receivers = [
            entry
            for entry in self.receivers
            if entry[0] != lookup_key
        ]
        return len(self.receivers) != before

    async def asend(self, sender=None, **kwargs):
        responses = []
        for _lookup_key, expected_sender, receiver in tuple(self.receivers):
            if expected_sender is not None and expected_sender is not sender:
                continue
            if inspect.iscoroutinefunction(receiver):
                result = await receiver(sender=sender, **kwargs)
            else:
                # Django 5 adapts sync receivers through sync_to_async, so it
                # must not accidentally enable the persistent ASGI loop under
                # test. Only the async receiver executes on this loop thread.
                result = await asyncio.get_running_loop().run_in_executor(
                    None,
                    functools.partial(receiver, sender=sender, **kwargs),
                )
            responses.append((receiver, result))
        return responses


request_started = RequestStartedSignal()


class ASGIHandler:
    pass


django_module = types.ModuleType("django")
django_core_module = types.ModuleType("django.core")
django_signals_module = types.ModuleType("django.core.signals")
django_handlers_module = types.ModuleType("django.core.handlers")
django_asgi_module = types.ModuleType("django.core.handlers.asgi")
django_signals_module.request_started = request_started
django_asgi_module.ASGIHandler = ASGIHandler
sys.modules["django"] = django_module
sys.modules["django.core"] = django_core_module
sys.modules["django.core.signals"] = django_signals_module
sys.modules["django.core.handlers"] = django_handlers_module
sys.modules["django.core.handlers.asgi"] = django_asgi_module


loop = asyncio.new_event_loop()
loop_ready = threading.Event()


def run_existing_asgi_loop():
    asyncio.set_event_loop(loop)
    loop_ready.set()
    loop.run_forever()


loop_thread = threading.Thread(
    target=run_existing_asgi_loop,
    name="preexisting-asgi-loop",
    daemon=True,
)
loop_thread.start()
if not loop_ready.wait(timeout=5.0):
    raise RuntimeError("ASGI loop did not start")


# Import and activate only after the ASGI thread is already running. On Python
# 3.11, threading.settrace() cannot retroactively reach that thread.
if hasattr(threading, "settrace_all_threads"):
    delattr(threading, "settrace_all_threads")
from django_process_debugger_tracer import start


AUTH_TOKEN = "0123456789abcdef" * 4


async def handle_asgi_request():
    await request_started.asend(sender=ASGIHandler, scope={"type": "http"})
    response_status = "pass"  # ASGI_BREAKPOINT
    return response_status


def foreign_trace(frame, event, arg):
    return foreign_trace


async def handle_conflicting_asgi_request():
    sys.settrace(foreign_trace)
    try:
        await request_started.asend(sender=ASGIHandler, scope={"type": "http"})
    finally:
        sys.settrace(None)
    return "conflict"


endpoint = start("127.0.0.1", 0, auth_token=AUTH_TOKEN)
print(
    json.dumps(
        {
            "pid": os.getpid(),
            "host": endpoint[0],
            "port": endpoint[1],
            "authToken": AUTH_TOKEN,
            "source": __file__,
        }
    ),
    flush=True,
)


for raw_command in sys.stdin:
    command = raw_command.strip()
    if command == "GO":
        future = asyncio.run_coroutine_threadsafe(handle_asgi_request(), loop)
        print("DONE={}".format(future.result(timeout=20.0)), flush=True)
    elif command == "CONFLICT":
        future = asyncio.run_coroutine_threadsafe(
            handle_conflicting_asgi_request(),
            loop,
        )
        print("DONE={}".format(future.result(timeout=20.0)), flush=True)
    elif command == "STATUS":
        print("RECEIVERS={}".format(len(request_started.receivers)), flush=True)
    elif command == "QUIT":
        break


loop.call_soon_threadsafe(loop.stop)
loop_thread.join(timeout=5.0)
