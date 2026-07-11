#!/usr/bin/env python3
"""Fake manage.py for E2E tests.

Usage:
    python manage.py runserver PORT

- Matches the "manage.py runserver" pattern used by the bootstrap/finder.
- Binds a TCP listener on PORT so port detection works.
- Sleeps forever until SIGTERM.
- If the bootstrap (_django_debug_bootstrap) is on sys.path / .pth, it will
  auto-publish the private activation control socket because sys.argv matches the pattern.
"""
import os
import signal
import socket
import sys
import threading
import time
import types


_hot_reload_lifecycle_state_path = os.environ.get(
    'DPD_EXPERIMENTAL_HOT_RELOAD_LIFECYCLE_STATE'
)
_hot_reload_fake_signal = None
_hot_reload_fake_autoreload = None
_hot_reload_original_trigger = None
_hot_reload_application_receiver = None


class _FakeSignal:
    """Small Django Signal stand-in used only by the hot-reload lifecycle E2E."""

    def __init__(self):
        self.receivers = {}
        self.connect_count = 0
        self.disconnect_count = 0

    def connect(self, receiver, sender=None, weak=True, dispatch_uid=None):  # noqa: ARG002
        key = dispatch_uid if dispatch_uid is not None else id(receiver)
        self.receivers[key] = receiver
        self.connect_count += 1

    def disconnect(self, receiver=None, sender=None, dispatch_uid=None):  # noqa: ARG002
        key = dispatch_uid if dispatch_uid is not None else id(receiver)
        removed = self.receivers.pop(key, None) is not None
        if removed:
            self.disconnect_count += 1
        return removed

    def send(self, sender=None, **kwargs):
        return [
            (receiver, receiver(sender=sender, **kwargs))
            for receiver in list(self.receivers.values())
        ]


def _install_fake_django_autoreload():
    """Publish a dependency-free autoreload module before lease acquisition."""
    global _hot_reload_fake_signal
    global _hot_reload_fake_autoreload
    global _hot_reload_original_trigger
    global _hot_reload_application_receiver

    if not _hot_reload_lifecycle_state_path:
        return

    django_module = types.ModuleType('django')
    django_module.__path__ = []
    utils_module = types.ModuleType('django.utils')
    utils_module.__path__ = []
    autoreload_module = types.ModuleType('django.utils.autoreload')
    fake_signal = _FakeSignal()

    def application_receiver(sender=None, **kwargs):  # noqa: ARG001
        return None

    def original_trigger_reload(filename):
        return filename

    fake_signal.connect(
        application_receiver,
        weak=False,
        dispatch_uid='fixture-application-receiver',
    )
    autoreload_module.file_changed = fake_signal
    autoreload_module.trigger_reload = original_trigger_reload
    django_module.utils = utils_module
    utils_module.autoreload = autoreload_module
    sys.modules['django'] = django_module
    sys.modules['django.utils'] = utils_module
    sys.modules['django.utils.autoreload'] = autoreload_module

    _hot_reload_fake_signal = fake_signal
    _hot_reload_fake_autoreload = autoreload_module
    _hot_reload_original_trigger = original_trigger_reload
    _hot_reload_application_receiver = application_receiver


def _write_hot_reload_lifecycle_state():
    if (
        not _hot_reload_lifecycle_state_path
        or _hot_reload_fake_signal is None
        or _hot_reload_fake_autoreload is None
        or _hot_reload_original_trigger is None
    ):
        return

    import json

    receivers = _hot_reload_fake_signal.receivers
    current_trigger = _hot_reload_fake_autoreload.trigger_reload
    debugger_receiver_count = sum(
        isinstance(key, str)
        and key.startswith('django-process-debugger-hot-reload-')
        for key in receivers
    )
    payload = {
        'pid': os.getpid(),
        'receiverCount': len(receivers),
        'debuggerReceiverCount': debugger_receiver_count,
        'applicationReceiverPresent': (
            receivers.get('fixture-application-receiver')
            is _hot_reload_application_receiver
        ),
        'triggerIsOriginal': current_trigger is _hot_reload_original_trigger,
        'triggerReferencesOriginal': (
            getattr(
                current_trigger,
                '_django_process_debugger_original_trigger',
                None,
            )
            is _hot_reload_original_trigger
        ),
        'watcherThreadCount': sum(
            thread.name == 'django-debug-hot-reload' and thread.is_alive()
            for thread in threading.enumerate()
        ),
        'connectCount': _hot_reload_fake_signal.connect_count,
        'disconnectCount': _hot_reload_fake_signal.disconnect_count,
    }
    temporary_path = _hot_reload_lifecycle_state_path + '.tmp'
    try:
        with open(temporary_path, 'w', encoding='utf-8') as state_file:
            json.dump(payload, state_file)
        os.chmod(temporary_path, 0o600)
        os.replace(temporary_path, _hot_reload_lifecycle_state_path)
    except OSError:
        # The parent test may remove its temp directory during process teardown.
        pass


_install_fake_django_autoreload()


# The experimental hot-reload E2E test needs one workspace module to be loaded
# before engine activation. Keep this opt-in so the general attach fixture stays
# dependency-free and unchanged for every other test.
if os.environ.get('DPD_EXPERIMENTAL_HOT_RELOAD_PROBE'):
    import sampleapp.hot_reload_probe  # noqa: F401


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
    _write_hot_reload_lifecycle_state()
    sys.stdout.write(f'READY pid={os.getpid()} port={port}\n')
    sys.stdout.flush()

    stop_event = threading.Event()

    def _graceful_stop(signum, frame):  # noqa: ARG001
        stop_event.set()

    signal.signal(signal.SIGTERM, _graceful_stop)
    signal.signal(signal.SIGINT, _graceful_stop)

    while not stop_event.is_set():
        _write_hot_reload_lifecycle_state()
        time.sleep(0.05 if _hot_reload_lifecycle_state_path else 0.2)

    s.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
