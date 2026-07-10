#!/usr/bin/env python3
"""Command-driven target for native tracer exception breakpoint tests."""

import json
import os
import queue
import sys
import threading


sys.path.insert(0, sys.argv[1])

from django_process_debugger_tracer import start


EXCEPTION_TEXT_HOOKS = []
ORIGINAL_EXCEPTION_HOOKS = []


class ParentProblem(Exception):
    def __str__(self):
        EXCEPTION_TEXT_HOOKS.append("str")
        raise RuntimeError("debugger must not invoke exception __str__")

    def __repr__(self):
        EXCEPTION_TEXT_HOOKS.append("repr")
        raise RuntimeError("debugger must not invoke exception __repr__")


class ChildProblem(ParentProblem):
    pass


class OuterProblem(ParentProblem):
    pass


def caught_exception():
    mutable = 1
    try:
        raise ChildProblem("caught child")  # CAUGHT_RAISE
    except ParentProblem:
        return mutable


def uncaught_exception():
    postmortem_value = 7
    raise ChildProblem("uncaught child")  # UNCAUGHT_RAISE


def explicit_cause_exception():
    try:
        raise ValueError("root cause")  # CAUSE_INNER_RAISE
    except ValueError as cause:
        raise OuterProblem("outer problem") from cause  # CAUSE_OUTER_RAISE


COMMANDS = {
    "CAUGHT": caught_exception,
    "UNCAUGHT": uncaught_exception,
    "CAUSE": explicit_cause_exception,
}


def quiet_thread_exception(_args):
    # The tracer wraps this hook while the uncaught filter is active. Keeping
    # the fixture's hook quiet makes stdout markers and DAP events the only
    # synchronization signals and avoids invoking hostile exception text hooks.
    ORIGINAL_EXCEPTION_HOOKS.append("threading")


threading.excepthook = quiet_thread_exception
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


def initialize_worker_pool():
    # Thread/Condition construction deliberately happens while the first test
    # command has exception filters disabled. CPython's threading module uses
    # caught AttributeError probes while adapting primitive locks; those are
    # real raised exceptions and would otherwise be valid `raised` stops that
    # obscure the fixture's intentional exception.
    for index in range(8):
        commands = queue.Queue(maxsize=1)

        def run_one(command_queue=commands):
            command = command_queue.get()
            threading.current_thread().name = "exception-worker-{}".format(
                command.lower()
            )
            COMMANDS[command]()

        worker = threading.Thread(
            target=run_one,
            name="exception-worker-pool-{}".format(index),
            daemon=True,
        )
        worker.start()
        worker_pool.append((worker, commands))


for raw_command in sys.stdin:
    command = raw_command.strip()
    if command == "QUIT":
        break
    target = COMMANDS.get(command)
    if target is None:
        print("UNKNOWN:{}".format(command), flush=True)
        continue
    if not worker_pool:
        initialize_worker_pool()
    EXCEPTION_TEXT_HOOKS[:] = []
    ORIGINAL_EXCEPTION_HOOKS[:] = []
    worker, commands = worker_pool.pop(0)
    commands.put(command)
    worker.join(timeout=20.0)
    if worker.is_alive():
        raise RuntimeError("exception target worker did not resume")
    print(
        "DONE:{}:HOOKS={}:CHAIN={}".format(
            command,
            len(EXCEPTION_TEXT_HOOKS),
            len(ORIGINAL_EXCEPTION_HOOKS),
        ),
        flush=True,
    )
