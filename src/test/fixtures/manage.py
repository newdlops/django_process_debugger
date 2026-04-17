#!/usr/bin/env python3
"""Fake manage.py for E2E tests.

Usage:
    python manage.py runserver PORT

- Matches the "manage.py runserver" pattern used by the bootstrap/finder.
- Binds a TCP listener on PORT so port detection works.
- Sleeps forever until SIGTERM.
- If the bootstrap (_django_debug_bootstrap) is on sys.path / .pth, it will
  auto-register SIGUSR1/SIGUSR2 handlers because sys.argv matches the pattern.
"""
import os
import signal
import socket
import sys
import threading
import time


def main() -> int:
    if len(sys.argv) < 3 or sys.argv[1] != 'runserver':
        print('usage: manage.py runserver PORT', file=sys.stderr)
        return 2

    try:
        port = int(sys.argv[2])
    except ValueError:
        print(f'invalid port: {sys.argv[2]}', file=sys.stderr)
        return 2

    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', port))
    s.listen(8)
    sys.stdout.write(f'READY pid={os.getpid()} port={port}\n')
    sys.stdout.flush()

    stop_event = threading.Event()

    def _graceful_stop(signum, frame):  # noqa: ARG001
        stop_event.set()

    signal.signal(signal.SIGTERM, _graceful_stop)
    signal.signal(signal.SIGINT, _graceful_stop)

    while not stop_event.is_set():
        time.sleep(0.2)

    s.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
