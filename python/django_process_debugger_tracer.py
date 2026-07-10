"""Dependency-free experimental DAP tracer for running Python processes.

The module deliberately depends only on the Python standard library and does
not import debugpy or pydevd.  It implements the small DAP surface needed by
the experimental Django debugger backend.
"""

from __future__ import annotations

import dis
import itertools
import json
import os
import socket
import sys
import threading
import types
import weakref
from dataclasses import dataclass
from typing import Any, Dict, Optional, Set, Tuple


_THIS_FILE = os.path.normcase(os.path.realpath(__file__))
_MAX_DAP_MESSAGE_BYTES = 8 * 1024 * 1024
_MAX_DAP_HEADER_BYTES = 64 * 1024
_MAX_HANDLES_PER_STOP = 10_000
_ACTIVE_TRACER = None
_ACTIVE_LOCK = threading.Lock()


def _path(value: str) -> str:
    return os.path.normcase(os.path.realpath(value))


def _depth(frame: types.FrameType) -> int:
    result = 0
    while frame is not None:
        result += 1
        frame = frame.f_back
    return result


def _type_name(value: Any) -> str:
    try:
        return type.__getattribute__(type(value), "__name__")
    except BaseException:
        return "object"


def _existing_thread_trace_hook():
    getter = getattr(threading, "gettrace", None)
    if getter is not None:
        return getter()
    # CPython 3.8-3.9 has no public getter, but threading.settrace stores the
    # future-thread hook here. Reading it is safer than silently replacing it.
    return getattr(threading, "_trace_hook", None)


def _executable_lines(filename: str) -> Set[int]:
    with open(filename, "rb") as source_file:
        code = compile(source_file.read(), filename, "exec")

    lines = set()  # type: Set[int]

    def visit(item: types.CodeType) -> None:
        lines.update(line for _, line in dis.findlinestarts(item))
        for child in item.co_consts:
            if isinstance(child, types.CodeType):
                visit(child)

    visit(code)
    return lines


@dataclass
class StopContext:
    native_thread_id: int
    dap_thread_id: int
    frame: types.FrameType
    reason: str
    paused: bool = True


class NativeDapTracer:
    def __init__(self) -> None:
        self.owner_pid = os.getpid()
        self.breakpoints: Dict[str, Set[int]] = {}
        self.steps: Dict[int, Tuple[str, int]] = {}
        self.pause_requests = set()  # type: Set[int]
        self.stops: Dict[int, StopContext] = {}
        self.condition = threading.Condition(threading.RLock())
        self.send_lock = threading.Lock()
        self.client: Optional[socket.socket] = None
        self.server: Optional[socket.socket] = None
        self.enabled = True
        self.configured = False
        self.control_ident: Optional[int] = None
        self.sequence = 1
        self.pending_attach: Optional[Dict[str, Any]] = None
        self.native_to_dap: Dict[int, int] = {}
        self.dap_to_native: Dict[int, int] = {}
        self.native_threads = weakref.WeakValueDictionary()
        self.next_thread_id = 1
        self.next_handle = 1
        self.frames: Dict[int, Tuple[int, types.FrameType]] = {}
        self.values: Dict[int, Tuple[int, Any]] = {}
        self.value_handles: Dict[Tuple[int, int], int] = {}
        self.normalized_paths: Dict[str, str] = {}
        self.endpoint: Optional[Tuple[str, int]] = None
        self.disconnect_requested = False
        self.threading_hook_installed = False
        self.all_threads_hook_installed = False
        self.sys_hook_installed = False

    def start(self, host: str = "127.0.0.1", port: int = 0) -> Tuple[str, int]:
        if sys.gettrace() is not None or _existing_thread_trace_hook() is not None:
            raise RuntimeError(
                "Experimental tracer will not replace an existing sys/threading trace hook"
            )
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((host, port))
        server.listen(1)
        self.server = server
        endpoint = server.getsockname()
        self.endpoint = (str(endpoint[0]), int(endpoint[1]))

        # Start this before threading.settrace(), so the DAP control path can
        # never pause itself in the trace callback.
        control = threading.Thread(
            target=self._serve,
            name="native-dap-control",
            daemon=True,
        )
        control.start()

        threading.settrace(self.trace)
        self.threading_hook_installed = True
        settrace_all_threads = getattr(threading, "settrace_all_threads", None)
        if settrace_all_threads is not None:
            settrace_all_threads(self.trace)
            self.all_threads_hook_installed = True
        sys.settrace(self.trace)
        self.sys_hook_installed = True
        caller = sys._getframe(1)
        while caller is not None:
            caller.f_trace = self.trace
            caller = caller.f_back
        return self.endpoint

    def trace(self, frame: types.FrameType, event: str, arg: Any):
        # A debugger callback must never inject its own exception into the
        # application being observed. Protocol/controller errors are reported
        # on the DAP side; unexpected trace-path failures leave tracing active
        # for later frames instead of changing debuggee behavior.
        try:
            return self._trace(frame, event, arg)
        except Exception:
            return self.trace if self.enabled else None

    def _trace(self, frame: types.FrameType, event: str, arg: Any):
        # Another library's Python-level after-fork callback may run before our
        # registered cleanup callback. Never evaluate an inherited breakpoint,
        # pause request, or step in that window: the child has no DAP control
        # thread yet and would otherwise be able to suspend forever.
        if os.getpid() != self.owner_pid:
            self.enabled = False
            self.configured = False
            sys.settrace(None)
            return None
        if not self.enabled:
            # Each traced thread clears its own global trace hook after an
            # internal shutdown. A control thread cannot do this on its behalf
            # on Python 3.11 and earlier.
            sys.settrace(None)
            return None
        native_id = threading.get_ident()
        if native_id == self.control_ident:
            return None
        if not self.configured:
            # Remove local line tracing while detached. The process-wide call
            # hook remains installed, so new Django request frames are traced
            # again after the next configurationDone request.
            return None
        active_client = self.client
        if active_client is None:
            return None
        self._ensure_thread_identity(native_id, threading.current_thread())
        if event not in ("call", "line"):
            return self.trace

        raw_filename = frame.f_code.co_filename
        filename = self.normalized_paths.get(raw_filename)
        if filename is None:
            filename = _path(raw_filename)
            self.normalized_paths[raw_filename] = filename
        if filename == _THIS_FILE:
            return None
        if event == "call":
            # ``dis.findlinestarts`` includes a function's definition line.
            # Python reports that location as a call event rather than a line
            # event when entering an already-imported function.
            if frame.f_lineno in self.breakpoints.get(filename, ()):
                self._pause(native_id, frame, "breakpoint", active_client)
            return self.trace
        reason: Optional[str] = None
        if native_id in self.pause_requests:
            reason = "pause"
        elif frame.f_lineno in self.breakpoints.get(filename, ()):
            reason = "breakpoint"
        else:
            step = self.steps.get(native_id)
            if step is not None:
                mode, start_depth = step
                current_depth = _depth(frame)
                if mode == "stepIn":
                    reason = "step"
                elif mode == "next" and current_depth <= start_depth:
                    reason = "step"
                elif mode == "stepOut" and current_depth < start_depth:
                    reason = "step"

        if reason is not None:
            self._pause(native_id, frame, reason, active_client)
        return self.trace

    def _ensure_thread_identity(
        self,
        native_id: int,
        thread: threading.Thread,
    ) -> None:
        if self.native_threads.get(native_id) is thread:
            return
        with self.condition:
            previous = self.native_threads.get(native_id)
            has_stale_state = (
                native_id in self.native_to_dap
                or native_id in self.steps
                or native_id in self.pause_requests
                or native_id in self.stops
            )
            if previous is not thread and (previous is not None or has_stale_state):
                # CPython may recycle get_ident() values. A new Thread object
                # must not inherit the prior thread's pending step/pause or DAP
                # identity merely because the integer identifier was reused.
                self._discard_thread_identity_locked(native_id)
            self.native_threads[native_id] = thread

    def _discard_thread_identity_locked(self, native_id: int) -> None:
        old_dap_id = self.native_to_dap.pop(native_id, None)
        if old_dap_id is not None:
            self.dap_to_native.pop(old_dap_id, None)
        self.native_threads.pop(native_id, None)
        self.steps.pop(native_id, None)
        self.pause_requests.discard(native_id)
        stale_stop = self.stops.pop(native_id, None)
        if stale_stop is not None:
            stale_stop.paused = False
        self.frames = {
            handle: entry
            for handle, entry in self.frames.items()
            if entry[0] != native_id
        }
        self.values = {
            handle: entry
            for handle, entry in self.values.items()
            if entry[0] != native_id
        }
        self.value_handles = {
            key: handle
            for key, handle in self.value_handles.items()
            if key[0] != native_id
        }
        self.condition.notify_all()

    def _prune_dead_thread_mappings_locked(self) -> None:
        tracked_ids = (
            set(self.native_to_dap)
            | set(self.steps)
            | self.pause_requests
            | set(self.stops)
        )
        for native_id in tracked_ids:
            if native_id not in self.native_threads:
                self._discard_thread_identity_locked(native_id)

    def _thread_id(
        self,
        native_id: int,
        thread: Optional[threading.Thread] = None,
    ) -> int:
        if thread is not None:
            self._ensure_thread_identity(native_id, thread)
        with self.condition:
            result = self.native_to_dap.get(native_id)
            if result is None:
                result = self.next_thread_id
                self.next_thread_id += 1
                self.native_to_dap[native_id] = result
                self.dap_to_native[result] = native_id
            return result

    def _thread_id_for_snapshot(
        self,
        native_id: int,
        thread: threading.Thread,
    ) -> Optional[int]:
        """Map a ``threading.enumerate`` row without overriding live trace state."""
        if not thread.is_alive() or thread.ident != native_id:
            return None
        with self.condition:
            self._prune_dead_thread_mappings_locked()
            current = self.native_threads.get(native_id)
            if current is not None and current is not thread and current.is_alive():
                # The enumerate() snapshot is stale: an actually executing
                # replacement thread already registered this recycled ident.
                return None
            if not thread.is_alive() or thread.ident != native_id:
                return None
            self._ensure_thread_identity(native_id, thread)
            result = self.native_to_dap.get(native_id)
            if result is None:
                result = self.next_thread_id
                self.next_thread_id += 1
                self.native_to_dap[native_id] = result
                self.dap_to_native[result] = native_id
            return result

    def _pause(
        self,
        native_id: int,
        frame: types.FrameType,
        reason: str,
        expected_client: socket.socket,
    ) -> None:
        with self.condition:
            if (
                not self.enabled
                or not self.configured
                or self.client is not expected_client
            ):
                return
            self._expire_handles(native_id)
            dap_id = self._thread_id(native_id, threading.current_thread())
            context = StopContext(native_id, dap_id, frame, reason)
            self.pause_requests.discard(native_id)
            self.steps.pop(native_id, None)
            self.stops[native_id] = context
            if not self._event(
                "stopped",
                {
                    "reason": reason,
                    "threadId": dap_id,
                    "allThreadsStopped": False,
                },
                expected_client=expected_client,
            ):
                self.stops.pop(native_id, None)
                return
            while context.paused and self.enabled:
                self.condition.wait()
            self.stops.pop(native_id, None)

    def _serve(self) -> None:
        self.control_ident = threading.get_ident()
        assert self.server is not None
        while self.enabled:
            try:
                client, _ = self.server.accept()
            except OSError:
                break
            self.client = client
            self.sequence = 1
            self.disconnect_requested = False
            client.settimeout(5.0)
            stream = client.makefile("rb")
            first_message = True
            try:
                while self.enabled and not self.disconnect_requested:
                    request = self._read_message(stream)
                    if request is None:
                        break
                    if not isinstance(request, dict):
                        raise ValueError("DAP message must be a JSON object")
                    if first_message:
                        if request.get("command") != "initialize":
                            raise ValueError("The first DAP request must be initialize")
                        first_message = False
                    try:
                        self._request(request)
                    except Exception:
                        self._response(
                            request,
                            success=False,
                            message="Experimental tracer failed to handle this request",
                        )
                    if request.get("command") == "configurationDone" and self.configured:
                        # Keep the timeout through the attach/configuration
                        # handshake so an initialize-only localhost client
                        # cannot monopolize the single persistent listener.
                        client.settimeout(None)
            except Exception:
                # Endpoint liveness probes are allowed to connect and close
                # without speaking DAP.  Malformed clients must not consume
                # the process-wide listener either.
                pass
            finally:
                try:
                    stream.close()
                except OSError:
                    pass
                self._drop_client(client)

    @staticmethod
    def _read_message(stream) -> Optional[Dict[str, Any]]:
        content_length: Optional[int] = None
        header_bytes = 0
        while True:
            line = stream.readline(8192)
            if not line:
                return None
            header_bytes += len(line)
            if header_bytes > _MAX_DAP_HEADER_BYTES:
                raise ValueError("DAP headers are too large")
            if len(line) >= 8192 and not line.endswith(b"\n"):
                raise ValueError("DAP header line is too large")
            if line in (b"\r\n", b"\n"):
                break
            name, _, value = line.decode("ascii").partition(":")
            if name.lower() == "content-length":
                content_length = int(value.strip())
        if content_length is None:
            raise ValueError("DAP message has no Content-Length")
        if content_length < 0 or content_length > _MAX_DAP_MESSAGE_BYTES:
            raise ValueError("DAP message body is too large")
        payload = stream.read(content_length)
        if len(payload) != content_length:
            return None
        return json.loads(payload.decode("utf-8"))

    def _send(
        self,
        message: Dict[str, Any],
        expected_client: Optional[socket.socket] = None,
    ) -> bool:
        try:
            with self.send_lock:
                client = expected_client if expected_client is not None else self.client
                if client is None:
                    return False
                if expected_client is not None and self.client is not expected_client:
                    return False
                message = {"seq": self.sequence, **message}
                self.sequence += 1
                body = json.dumps(
                    message, ensure_ascii=False, separators=(",", ":")
                ).encode("utf-8")
                packet = (
                    b"Content-Length: "
                    + str(len(body)).encode("ascii")
                    + b"\r\n\r\n"
                    + body
                )
                client.sendall(packet)
            return True
        except OSError:
            return False

    def _response(
        self,
        request: Dict[str, Any],
        body: Optional[Dict[str, Any]] = None,
        *,
        success: bool = True,
        message: Optional[str] = None,
    ) -> bool:
        response: Dict[str, Any] = {
            "type": "response",
            "request_seq": request.get("seq", 0),
            "success": success,
            "command": request.get("command", ""),
        }
        if body is not None:
            response["body"] = body
        if message is not None:
            response["message"] = message
        return self._send(response)

    def _event(
        self,
        name: str,
        body: Optional[Dict[str, Any]] = None,
        *,
        expected_client: Optional[socket.socket] = None,
    ) -> bool:
        event: Dict[str, Any] = {"type": "event", "event": name}
        if body is not None:
            event["body"] = body
        return self._send(event, expected_client)

    def _request(self, request: Dict[str, Any]) -> None:
        command = request.get("command")
        raw_args = request.get("arguments")
        args = raw_args if isinstance(raw_args, dict) else {}
        if command == "initialize":
            self._response(
                request,
                {
                    "supportsConfigurationDoneRequest": True,
                    "supportsSingleThreadExecutionRequests": True,
                    "supportsVariablePaging": True,
                },
            )
        elif command == "attach":
            self.pending_attach = request
            self._event("initialized")
        elif command == "setBreakpoints":
            self._set_breakpoints(request, args)
        elif command == "setExceptionBreakpoints":
            filters = args.get("filters") or []
            filter_options = args.get("filterOptions") or []
            if filters or filter_options:
                self._response(
                    request,
                    success=False,
                    message="Experimental native tracer does not support exception breakpoints",
                )
            else:
                self._response(request)
        elif command == "configurationDone":
            with self.condition:
                self.configured = True
                self._response(request)
                if self.pending_attach is not None:
                    self._response(self.pending_attach)
                    self.pending_attach = None
                self._event(
                    "process",
                    {
                        "name": os.path.basename(sys.argv[0]) or "python",
                        "systemProcessId": os.getpid(),
                        "isLocalProcess": True,
                        "startMethod": "attach",
                    },
                )
        elif command == "threads":
            threads = []
            for item in threading.enumerate():
                if item.ident is None or item.ident == self.control_ident:
                    continue
                dap_thread_id = self._thread_id_for_snapshot(item.ident, item)
                if dap_thread_id is not None:
                    threads.append({"id": dap_thread_id, "name": item.name})
            self._response(request, {"threads": threads})
        elif command == "stackTrace":
            self._stack_trace(request, args)
        elif command == "scopes":
            self._scopes(request, args)
        elif command == "variables":
            self._variables(request, args)
        elif command in ("continue", "next", "stepIn", "stepOut"):
            self._resume(request, args, command)
        elif command == "pause":
            self._request_pause(request, args)
        elif command == "disconnect":
            with self.condition:
                self.configured = False
                self.disconnect_requested = True
                self._response(request)
                self._event("terminated")
                for context in self.stops.values():
                    context.paused = False
                self.condition.notify_all()
        else:
            self._response(request, success=False, message=f"Unsupported request: {command}")

    def _set_breakpoints(self, request: Dict[str, Any], args: Dict[str, Any]) -> None:
        source = args.get("source") or {}
        filename = source.get("path")
        requested = args.get("breakpoints") or [
            {"line": line} for line in args.get("lines", [])
        ]
        results = []
        resolved = set()  # type: Set[int]
        executable = set()  # type: Set[int]
        error: Optional[str] = None
        if not isinstance(filename, str) or not filename.endswith(".py"):
            error = "Experimental native tracer supports Python files only"
        else:
            try:
                executable = _executable_lines(filename)
            except Exception as exc:
                error = f"Cannot load source: {exc}"

        for item in requested:
            line = int(item.get("line", 0))
            unsupported = [
                name
                for name in ("condition", "hitCondition", "logMessage")
                if item.get(name) not in (None, "")
            ]
            if unsupported:
                results.append(
                    {
                        "verified": False,
                        "line": line,
                        "source": source,
                        "message": (
                            "Experimental native tracer does not support "
                            + ", ".join(unsupported)
                        ),
                    }
                )
                continue
            candidates = [value for value in executable if value >= line]
            actual = min(candidates) if candidates else line
            verified = error is None and bool(candidates)
            result: Dict[str, Any] = {
                "verified": verified,
                "line": actual,
                "source": source,
            }
            if not verified:
                result["message"] = error or "No executable Python statement at or after this line"
            else:
                resolved.add(actual)
            results.append(result)
        if isinstance(filename, str):
            normalized = _path(filename)
            if resolved:
                self.breakpoints[normalized] = resolved
            else:
                self.breakpoints.pop(normalized, None)
        self._response(request, {"breakpoints": results})

    def _stack_trace(self, request: Dict[str, Any], args: Dict[str, Any]) -> None:
        with self.condition:
            native_id = self.dap_to_native.get(int(args.get("threadId", 0)))
            context = self.stops.get(native_id) if native_id is not None else None
        if context is None:
            self._response(request, success=False, message="Thread is not stopped")
            return
        stack = []
        frame: Optional[types.FrameType] = context.frame
        while frame is not None:
            handle = self._handle_frame(native_id, frame)
            stack.append(
                {
                    "id": handle,
                    "name": frame.f_code.co_name,
                    "line": frame.f_lineno,
                    "column": 1,
                    "source": {
                        "name": os.path.basename(frame.f_code.co_filename),
                        "path": os.path.realpath(frame.f_code.co_filename),
                    },
                }
            )
            frame = frame.f_back
        start = max(0, int(args.get("startFrame", 0)))
        levels = int(args.get("levels", 0))
        selected = stack[start:] if levels <= 0 else stack[start : start + levels]
        self._response(request, {"stackFrames": selected, "totalFrames": len(stack)})

    def _handle_frame(self, native_id: int, frame: types.FrameType) -> int:
        with self.condition:
            for handle, existing in self.frames.items():
                if existing[0] == native_id and existing[1] is frame:
                    return handle
            if len(self.frames) + len(self.values) >= _MAX_HANDLES_PER_STOP:
                return 0
            handle = self.next_handle
            self.next_handle += 1
            self.frames[handle] = (native_id, frame)
            return handle

    def _handle_value(self, native_id: int, value: Any) -> int:
        if not self._expandable(value):
            return 0
        key = (native_id, id(value))
        with self.condition:
            existing = self.value_handles.get(key)
            if existing is not None:
                return existing
            if len(self.frames) + len(self.values) >= _MAX_HANDLES_PER_STOP:
                return 0
            handle = self.next_handle
            self.next_handle += 1
            self.values[handle] = (native_id, value)
            self.value_handles[key] = handle
            return handle

    def _expire_handles(self, native_id: int) -> None:
        with self.condition:
            self.frames = {
                handle: entry
                for handle, entry in self.frames.items()
                if entry[0] != native_id
            }
            self.values = {
                handle: entry
                for handle, entry in self.values.items()
                if entry[0] != native_id
            }
            self.value_handles = {
                key: handle
                for key, handle in self.value_handles.items()
                if key[0] != native_id
            }

    @staticmethod
    def _expandable(value: Any) -> bool:
        if type(value) in (dict, list, tuple, set, frozenset):
            return True
        try:
            return type(object.__getattribute__(value, "__dict__")) is dict
        except BaseException:
            return False

    @staticmethod
    def _child_counts(value: Any) -> Tuple[int, int]:
        if type(value) is dict:
            return len(value), 0
        if type(value) in (list, tuple, set, frozenset):
            return 0, len(value)
        try:
            instance_dict = object.__getattribute__(value, "__dict__")
            return (len(instance_dict), 0) if type(instance_dict) is dict else (0, 0)
        except BaseException:
            return 0, 0

    def _scopes(self, request: Dict[str, Any], args: Dict[str, Any]) -> None:
        with self.condition:
            entry = self.frames.get(int(args.get("frameId", 0)))
            active = entry is not None and entry[0] in self.stops
        if not active or entry is None:
            self._response(request, success=False, message="Unknown or expired frame")
            return
        frame = entry[1]
        native_id = entry[0]
        frame_locals = frame.f_locals
        frame_globals = frame.f_globals
        locals_ref = self._handle_value(native_id, frame_locals)
        globals_ref = self._handle_value(native_id, frame_globals)
        self._response(
            request,
            {
                "scopes": [
                    {
                        "name": "Locals",
                        "presentationHint": "locals",
                        "variablesReference": locals_ref,
                        "namedVariables": len(frame_locals),
                        "expensive": False,
                    },
                    {
                        "name": "Globals",
                        "variablesReference": globals_ref,
                        "namedVariables": len(frame_globals),
                        "expensive": True,
                    },
                ]
            },
        )

    @classmethod
    def _safe_repr(cls, value: Any, depth: int = 0, seen: Optional[Set[int]] = None) -> str:
        """Render values without invoking application-defined ``__repr__``."""
        if seen is None:
            seen = set()
        value_type = type(value)
        if value_type is str:
            result = repr(value[:256])
            if len(value) > 256:
                result += "..."
        elif value_type is bytes:
            result = repr(value[:256])
            if len(value) > 256:
                result += "..."
        elif value_type in (type(None), bool, int, float, complex):
            try:
                result = repr(value)
            except BaseException as exc:
                result = "<repr failed: {}>".format(type(exc).__name__)
        elif id(value) in seen:
            result = "<recursive>"
        elif depth >= 2 and value_type in (dict, list, tuple, set, frozenset):
            result = "<{} len={}>".format(value_type.__name__, len(value))
        elif value_type is dict:
            seen.add(id(value))
            pairs = []
            for index, (key, item) in enumerate(value.items()):
                if index >= 10:
                    pairs.append("...")
                    break
                pairs.append(
                    "{}: {}".format(
                        cls._safe_repr(key, depth + 1, seen),
                        cls._safe_repr(item, depth + 1, seen),
                    )
                )
            seen.discard(id(value))
            result = "{" + ", ".join(pairs) + "}"
        elif value_type in (list, tuple, set, frozenset):
            seen.add(id(value))
            rendered = []
            for index, item in enumerate(value):
                if index >= 10:
                    rendered.append("...")
                    break
                rendered.append(cls._safe_repr(item, depth + 1, seen))
            seen.discard(id(value))
            if value_type is list:
                result = "[" + ", ".join(rendered) + "]"
            elif value_type is tuple:
                suffix = "," if len(value) == 1 else ""
                result = "(" + ", ".join(rendered) + suffix + ")"
            elif value_type is set:
                result = "set()" if not value else "{" + ", ".join(rendered) + "}"
            else:
                result = "frozenset({" + ", ".join(rendered) + "})"
        else:
            # object.__repr__ bypasses an application class's overridden repr.
            try:
                result = object.__repr__(value)
            except BaseException:
                result = "<{} instance>".format(_type_name(value))
        return result if len(result) <= 500 else result[:497] + "..."

    def _variable(self, native_id: int, name: str, value: Any) -> Dict[str, Any]:
        result = {
            "name": name,
            "value": self._safe_repr(value),
            "type": _type_name(value),
            "variablesReference": self._handle_value(native_id, value),
        }
        named, indexed = self._child_counts(value)
        if named:
            result["namedVariables"] = named
        if indexed:
            result["indexedVariables"] = indexed
        return result

    def _variables(self, request: Dict[str, Any], args: Dict[str, Any]) -> None:
        with self.condition:
            entry = self.values.get(int(args.get("variablesReference", 0)))
            active = entry is not None and entry[0] in self.stops
        if not active or entry is None:
            self._response(request, success=False, message="Unknown or expired variablesReference")
            return
        native_id, value = entry
        start = max(0, int(args.get("start", 0)))
        requested_count = int(args.get("count", 0))
        _named_count, indexed_count = self._child_counts(value)
        total_count = _named_count or indexed_count
        remaining = max(0, total_count - start)
        count = min(requested_count, remaining) if requested_count > 0 else remaining
        rows = []
        if type(value) is dict:
            items = itertools.islice(value.items(), start, start + count)
            for key, item in items:
                name = key if type(key) is str else self._safe_repr(key)
                rows.append(self._variable(native_id, name, item))
        elif type(value) in (list, tuple):
            items = itertools.islice(enumerate(value), start, start + count)
            rows = [self._variable(native_id, str(index), item) for index, item in items]
        elif type(value) in (set, frozenset):
            items = itertools.islice(enumerate(value), start, start + count)
            rows = [self._variable(native_id, str(index), item) for index, item in items]
        else:
            try:
                instance_dict = object.__getattribute__(value, "__dict__")
                if type(instance_dict) is not dict:
                    raise TypeError("object __dict__ is not an exact dict")
                items = itertools.islice(instance_dict.items(), start, start + count)
                rows = [
                    self._variable(
                        native_id,
                        key if type(key) is str else self._safe_repr(key),
                        item,
                    )
                    for key, item in items
                ]
            except BaseException:
                rows = []
        self._response(request, {"variables": rows})

    def _resume(self, request: Dict[str, Any], args: Dict[str, Any], command: str) -> None:
        dap_id = int(args.get("threadId", 0))
        with self.condition:
            native_id = self.dap_to_native.get(dap_id)
            context = self.stops.get(native_id) if native_id is not None else None
            if context is None:
                self._response(request, success=False, message="Thread is not stopped")
                return
            single_thread = args.get("singleThread") is True
            contexts = [context] if single_thread else list(self.stops.values())
            if command != "continue":
                self.steps[context.native_thread_id] = (
                    command,
                    _depth(context.frame),
                )
            else:
                for resumed in contexts:
                    self.steps.pop(resumed.native_thread_id, None)

            for resumed in contexts:
                native_id = resumed.native_thread_id
                self.frames = {
                    handle: entry
                    for handle, entry in self.frames.items()
                    if entry[0] != native_id
                }
                self.values = {
                    handle: entry
                    for handle, entry in self.values.items()
                    if entry[0] != native_id
                }
                self.value_handles = {
                    key: handle
                    for key, handle in self.value_handles.items()
                    if key[0] != native_id
                }
                resumed.paused = False

            all_threads_continued = not single_thread
            body = (
                {"allThreadsContinued": all_threads_continued}
                if command == "continue"
                else None
            )
            # Keep new stops behind the same condition until the client has
            # observed the response and continued event. Otherwise another
            # request thread could emit stopped immediately before an
            # allThreadsContinued event and leave VS Code's UI out of sync.
            self._response(request, body)
            self._event(
                "continued",
                {
                    "threadId": context.dap_thread_id,
                    "allThreadsContinued": all_threads_continued,
                },
            )
            self.condition.notify_all()

    def _request_pause(self, request: Dict[str, Any], args: Dict[str, Any]) -> None:
        dap_id = int(args.get("threadId", 0))
        with self.condition:
            native_id = self.dap_to_native.get(dap_id)
            if native_id is not None:
                self.pause_requests.add(native_id)
        if native_id is None:
            self._response(request, success=False, message="Unknown thread")
            return
        self._response(request)

    def _drop_client(self, client: socket.socket) -> None:
        with self.condition:
            if self.client is client:
                self.client = None
            self.configured = False
            self.pending_attach = None
            self.breakpoints.clear()
            self.steps.clear()
            self.pause_requests.clear()
            for context in self.stops.values():
                context.paused = False
            self.stops.clear()
            self.frames.clear()
            self.values.clear()
            self.value_handles.clear()
            self.native_to_dap.clear()
            self.dap_to_native.clear()
            self.native_threads = weakref.WeakValueDictionary()
            self.next_thread_id = 1
            self.condition.notify_all()
        try:
            client.close()
        except OSError:
            pass

    def _shutdown(self) -> None:
        with self.condition:
            if not self.enabled:
                return
            self.enabled = False
            self.configured = False
            for context in self.stops.values():
                context.paused = False
            self.condition.notify_all()
        if self.threading_hook_installed:
            threading.settrace(None)
            self.threading_hook_installed = False
        settrace_all_threads = getattr(threading, "settrace_all_threads", None)
        if self.all_threads_hook_installed and settrace_all_threads is not None:
            try:
                settrace_all_threads(None)
            except BaseException:
                pass
            self.all_threads_hook_installed = False
        for sock in (self.client, self.server):
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass

    def _after_fork_child(self) -> None:
        """Discard all state inherited from the parent after ``fork()``.

        Only the thread that called ``fork()`` exists in the child.  The DAP
        control thread is gone, while its sockets, locks, and trace callbacks
        would otherwise remain inherited.  In particular, a breakpoint hit in
        that state could wait forever on a condition that no controller can
        service.

        This method deliberately never acquires one of the inherited locks.
        Locks may have been held by a vanished parent thread at the instant of
        the fork, so they are replaced outright along with all mutable state.
        """
        self.enabled = False
        self.configured = False

        inherited_client = self.client
        inherited_server = self.server
        self.client = None
        self.server = None
        self.endpoint = None

        # Disable both the current-thread and future-thread hooks before any
        # application code can run in the child.
        if self.sys_hook_installed:
            try:
                sys.settrace(None)
            except BaseException:
                pass
            self.sys_hook_installed = False
        if self.threading_hook_installed:
            try:
                threading.settrace(None)
            except BaseException:
                pass
            self.threading_hook_installed = False
        settrace_all_threads = getattr(threading, "settrace_all_threads", None)
        if self.all_threads_hook_installed and settrace_all_threads is not None:
            try:
                settrace_all_threads(None)
            except BaseException:
                pass
            self.all_threads_hook_installed = False

        # Closing the inherited descriptors is essential: an open copy in a
        # worker would keep the parent's listener alive and could make PID/port
        # ownership checks report the wrong process.
        for sock in (inherited_client, inherited_server):
            if sock is not None:
                try:
                    sock.close()
                except BaseException:
                    pass

        self.breakpoints = {}
        self.steps = {}
        self.pause_requests = set()
        self.stops = {}
        self.pending_attach = None
        self.native_to_dap = {}
        self.dap_to_native = {}
        self.native_threads = weakref.WeakValueDictionary()
        self.next_thread_id = 1
        self.next_handle = 1
        self.frames = {}
        self.values = {}
        self.value_handles = {}
        self.normalized_paths = {}
        self.control_ident = None
        self.sequence = 1
        self.disconnect_requested = False

        # Never reuse synchronization primitives that may have been owned by a
        # thread which no longer exists in the child.
        self.condition = threading.Condition(threading.RLock())
        self.send_lock = threading.Lock()


def start(host: str = "127.0.0.1", port: int = 0) -> Tuple[str, int]:
    """Start (or reuse) the in-process DAP server and return its endpoint."""
    global _ACTIVE_TRACER
    with _ACTIVE_LOCK:
        tracer = _ACTIVE_TRACER
        if tracer is not None and tracer.enabled and tracer.endpoint is not None:
            return tracer.endpoint
        tracer = NativeDapTracer()
        # Publish before opening the listener/installing hooks so an unrelated
        # application thread that forks during activation can still find and
        # discard this partially-started tracer in its at-fork callback.
        _ACTIVE_TRACER = tracer
        try:
            return tracer.start(host, port)
        except BaseException:
            try:
                tracer._shutdown()
            except BaseException:
                pass
            if _ACTIVE_TRACER is tracer:
                _ACTIVE_TRACER = None
            raise


def _reset_after_fork_child() -> None:
    """Reset module ownership in a freshly-forked child process."""
    global _ACTIVE_TRACER, _ACTIVE_LOCK

    # Do not enter _ACTIVE_LOCK here: it may have been held by a thread that
    # vanished at fork time.  Publish fresh globals first so even a cleanup
    # failure cannot leave the child pointing at the parent's tracer.
    inherited_tracer = _ACTIVE_TRACER
    _ACTIVE_TRACER = None
    _ACTIVE_LOCK = threading.Lock()

    if inherited_tracer is not None:
        try:
            inherited_tracer._after_fork_child()
        except BaseException:
            # At-fork callbacks must not prevent the child from continuing.
            try:
                sys.settrace(None)
            except BaseException:
                pass


_register_at_fork = getattr(os, "register_at_fork", None)
if _register_at_fork is not None:
    _register_at_fork(after_in_child=_reset_after_fork_child)
