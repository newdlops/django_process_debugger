"""Dependency-free experimental DAP tracer for running Python processes.

The module deliberately depends only on the Python standard library and does
not import debugpy or pydevd.  It implements the small DAP surface needed by
the experimental Django debugger backend.
"""

from __future__ import annotations

import builtins
import collections
import dis
import functools
import itertools
import json
import keyword
import os
import queue
import re
import socket
import sys
import threading
import types
import weakref
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional, Set, Tuple


_THIS_FILE = os.path.normcase(os.path.realpath(__file__))
_MAX_DAP_MESSAGE_BYTES = 8 * 1024 * 1024
_MAX_DAP_HEADER_BYTES = 64 * 1024
_MAX_HANDLES_PER_STOP = 10_000
_MAX_EXPRESSION_CHARS = 64 * 1024
_MAX_LOG_OUTPUT_CHARS = 16 * 1024
_MAX_LOG_PLACEHOLDERS = 128
_MAX_PENDING_LOG_EVENTS = 256
_MAX_PENDING_LOG_SUMMARIES = 64
_MAX_LAZY_MEMBERS = 128
_MAX_LAZY_MEMBER_SCAN = 4096
_MAX_EVALUATE_NAME_KEY_CHARS = 4096
_MAX_CLIPBOARD_VALUE_CHARS = 64 * 1024
_MAX_STACK_FRAME_NAME_CHARS = 4096
_MAX_EXCEPTION_MESSAGE_CHARS = 4096
_MAX_EXCEPTION_TYPE_CHARS = 512
_MAX_EXCEPTION_STACK_CHARS = 16 * 1024
_MAX_EXCEPTION_STACK_FRAMES = 64
_MAX_EXCEPTION_STACK_LINE_CHARS = 2048
_MAX_EXCEPTION_TRACEBACK_SCAN = 64 * 1024
_MAX_DJANGO_HANDLER_FRAME_SCAN = 128
_MAX_DJANGO_REQUEST_FIELD_SCAN = 4096
_MAX_INNER_EXCEPTION_DEPTH = 8
_MAX_INNER_EXCEPTION_CHILDREN = 32
_MAX_INNER_EXCEPTION_TOTAL = 64
_MAX_FLATTENED_EXCEPTION_GROUP_CHILDREN = 8
_MAX_FLATTENED_EXCEPTION_GROUP_TOTAL = 32
_MAX_SAFE_DECIMAL_INT_BITS = 2048
_CO_OPTIMIZED = 0x0001
_CO_VARARGS = 0x0004
_CO_VARKEYWORDS = 0x0008
_ACTIVE_TRACER = None
_ACTIVE_LOCK = threading.Lock()
_LOCALS_TO_FAST = None
_TYPE_NAME_DESCRIPTOR = type.__dict__["__name__"]
_TYPE_QUALNAME_DESCRIPTOR = type.__dict__["__qualname__"]
_TYPE_MODULE_DESCRIPTOR = type.__dict__["__module__"]
_TYPE_MRO_DESCRIPTOR = type.__dict__["__mro__"]
_TYPE_DICT_DESCRIPTOR = type.__dict__["__dict__"]
_BASE_EXCEPTION_ARGS_DESCRIPTOR = BaseException.__dict__["args"]
_BASE_EXCEPTION_CAUSE_DESCRIPTOR = BaseException.__dict__["__cause__"]
_BASE_EXCEPTION_CONTEXT_DESCRIPTOR = BaseException.__dict__["__context__"]
_BASE_EXCEPTION_SUPPRESS_CONTEXT_DESCRIPTOR = BaseException.__dict__[
    "__suppress_context__"
]
_BASE_EXCEPTION_TRACEBACK_DESCRIPTOR = BaseException.__dict__["__traceback__"]
_BASE_EXCEPTION_GROUP_TYPE = getattr(builtins, "BaseExceptionGroup", None)
_BASE_EXCEPTION_GROUP_EXCEPTIONS_DESCRIPTOR = (
    _BASE_EXCEPTION_GROUP_TYPE.__dict__.get("exceptions")
    if _BASE_EXCEPTION_GROUP_TYPE is not None
    else None
)
_LOG_QUEUE_STOP = object()
_HIT_CONDITION_PATTERN = re.compile(r"\s*(==|>=|<=|>|<|%)?\s*([0-9]+)\s*\Z")

if getattr(sys.implementation, "name", "") == "cpython":
    try:
        import ctypes as _ctypes

        _LOCALS_TO_FAST = _ctypes.pythonapi.PyFrame_LocalsToFast
        _LOCALS_TO_FAST.argtypes = [_ctypes.py_object, _ctypes.c_int]
        _LOCALS_TO_FAST.restype = None
    except (AttributeError, ImportError, OSError):
        _LOCALS_TO_FAST = None


def _path(value: str) -> str:
    return os.path.normcase(os.path.realpath(value))


def _depth(frame: types.FrameType) -> int:
    result = 0
    while frame is not None:
        result += 1
        frame = frame.f_back
    return result


def _stored_text(
    value: Any,
    default: str,
    limit: int = _MAX_STACK_FRAME_NAME_CHARS,
) -> str:
    """Normalize stored str/subclass metadata without calling user hooks."""
    try:
        normalized = str.__str__(value)
    except BaseException:
        return default
    if len(normalized) <= limit:
        return normalized
    suffix = "...<truncated>"
    return normalized[: limit - len(suffix)] + suffix


def _type_name(value: Any) -> str:
    try:
        value_type = type(value)
        name = _TYPE_NAME_DESCRIPTOR.__get__(value_type, type(value_type))
        return _stored_text(name, "object")
    except BaseException:
        return "object"


def _type_full_name(value: Any) -> str:
    try:
        value_type = type(value)
        value_meta = type(value_type)
        module = _stored_text(
            _TYPE_MODULE_DESCRIPTOR.__get__(value_type, value_meta),
            "",
        )
        qualname = _stored_text(
            _TYPE_QUALNAME_DESCRIPTOR.__get__(value_type, value_meta),
            "",
        )
        if not qualname:
            return _type_name(value)
        if module:
            return "{}.{}".format(module, qualname)
        return qualname
    except BaseException:
        return _type_name(value)


def _base_exception_attribute(
    value: Any,
    descriptor: Any,
    default: Any = None,
) -> Any:
    """Read BaseException storage without invoking subclass overrides."""
    try:
        return descriptor.__get__(value, type(value))
    except BaseException:
        return default


def _type_identity_in(value_type: type, candidates: Tuple[type, ...]) -> bool:
    """Compare type objects without invoking a custom metaclass ``__eq__``."""
    return any(value_type is candidate for candidate in candidates)


def _type_mro_contains(value_type: type, candidates: Tuple[type, ...]) -> bool:
    """Check inheritance without invoking a custom metaclass hook."""
    try:
        mro = _TYPE_MRO_DESCRIPTOR.__get__(value_type, type(value_type))
        return any(
            owner is candidate
            for owner in mro
            for candidate in candidates
        )
    except BaseException:
        return _type_identity_in(value_type, candidates)


def _base_exception_group_children(value: Any) -> Tuple[Any, ...]:
    group_type = _BASE_EXCEPTION_GROUP_TYPE
    descriptor = _BASE_EXCEPTION_GROUP_EXCEPTIONS_DESCRIPTOR
    if (
        group_type is None
        or descriptor is None
        or not _type_mro_contains(type(value), (group_type,))
    ):
        return ()
    try:
        children = descriptor.__get__(value, type(value))
    except BaseException:
        return ()
    return children if type(children) is tuple else ()


def _safe_type_namespaces(value_type: type) -> Tuple[Tuple[type, Any], ...]:
    """Return real MRO namespaces without invoking metaclass overrides."""
    try:
        mro = _TYPE_MRO_DESCRIPTOR.__get__(value_type, type(value_type))
        return tuple(
            (owner, _TYPE_DICT_DESCRIPTOR.__get__(owner, type(owner)))
            for owner in mro
        )
    except BaseException:
        return ()


def _resolve_type_member(value_type: type, name: str) -> Tuple[Optional[type], Any]:
    for owner, namespace in _safe_type_namespaces(value_type):
        if name in namespace:
            return owner, namespace[name]
    return None, None


def _safe_instance_dict(value: Any) -> Optional[dict]:
    """Read a real instance dictionary without invoking application descriptors."""
    value_type = type(value)
    try:
        for owner, namespace in _safe_type_namespaces(value_type):
            if "__dict__" not in namespace:
                continue
            descriptor = namespace["__dict__"]
            # A property or custom descriptor named ``__dict__`` can execute
            # arbitrary application code. Treat the object as opaque instead.
            if type(descriptor) is not types.GetSetDescriptorType:
                return None
            try:
                instance_dict = descriptor.__get__(value, value_type)
            except BaseException:
                return None
            return instance_dict if type(instance_dict) is dict else None
    except BaseException:
        return None
    return None


def _lazy_member_specs(value: Any) -> Tuple["LazyMemberSpec", ...]:
    """Discover opt-in user-code values without executing descriptors or hooks."""
    value_type = type(value)
    if _type_identity_in(
        value_type,
        (
            type(None),
            bool,
            int,
            float,
            complex,
            str,
            bytes,
            dict,
            list,
            tuple,
            set,
            frozenset,
            type,
            types.FunctionType,
            types.MethodType,
            types.ModuleType,
            types.CodeType,
        ),
    ):
        return ()
    namespaces = _safe_type_namespaces(value_type)
    if not namespaces:
        return ()

    result = []
    repr_owner, _ = _resolve_type_member(value_type, "__repr__")
    has_custom_repr = repr_owner is not None and repr_owner is not object
    if has_custom_repr:
        result.append(LazyMemberSpec("repr()", "lazy_repr"))

    str_owner, _ = _resolve_type_member(value_type, "__str__")
    if (str_owner is not None and str_owner is not object) or has_custom_repr:
        result.append(LazyMemberSpec("str()", "lazy_str"))

    len_owner, _ = _resolve_type_member(value_type, "__len__")
    if len_owner is not None:
        result.append(LazyMemberSpec("len()", "lazy_len"))

    stored = _safe_instance_dict(value)
    stored_names = set()
    try:
        if stored is not None:
            for index, key in enumerate(stored):
                if index >= _MAX_LAZY_MEMBER_SCAN:
                    break
                if type(key) is str:
                    stored_names.add(key)
    except BaseException:
        stored_names = set()
    seen = set()
    descriptor_specs = []
    remaining_specs = max(0, _MAX_LAZY_MEMBERS - len(result))
    scanned = 0
    stop_scanning = remaining_specs == 0
    try:
        for _owner, namespace in namespaces:
            if stop_scanning:
                break
            for name, descriptor in namespace.items():
                scanned += 1
                if scanned > _MAX_LAZY_MEMBER_SCAN:
                    stop_scanning = True
                    break
                if type(name) is not str or name in seen:
                    continue
                seen.add(name)
                if name.startswith("__") and name.endswith("__"):
                    continue
                descriptor_type = type(descriptor)
                if descriptor_type is property:
                    if descriptor.fget is not None:
                        descriptor_specs.append(
                            LazyMemberSpec(name, "lazy_property")
                        )
                elif descriptor_type is functools.cached_property:
                    if name not in stored_names:
                        descriptor_specs.append(
                            LazyMemberSpec(name, "lazy_cached_property")
                        )
                elif _type_identity_in(
                    descriptor_type,
                    (
                        types.MemberDescriptorType,
                        types.GetSetDescriptorType,
                    ),
                ):
                    if name not in ("__dict__", "__weakref__"):
                        descriptor_specs.append(
                            LazyMemberSpec(name, "lazy_slot")
                        )
                if len(descriptor_specs) >= remaining_specs:
                    stop_scanning = True
                    break
    except BaseException:
        return tuple(result[:_MAX_LAZY_MEMBERS])

    descriptor_specs.sort(key=lambda item: item.name)
    result.extend(descriptor_specs[:remaining_specs])
    return tuple(result)


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
        # Python 3.14 can report artificial bytecode ranges with no source
        # line. They are not valid DAP breakpoint locations.
        lines.update(line for _, line in dis.findlinestarts(item) if line is not None)
        for child in item.co_consts:
            if isinstance(child, types.CodeType):
                visit(child)

    visit(code)
    return lines


@dataclass
class PendingOperation:
    callback: Callable[[], Any]
    done: threading.Event = field(default_factory=threading.Event)
    result: Any = None
    error: Optional[BaseException] = None
    cancelled: bool = False


@dataclass
class StopContext:
    native_thread_id: int
    dap_thread_id: int
    frame: types.FrameType
    reason: str
    description: Optional[str] = None
    exception_info: Optional["ExceptionStopInfo"] = None
    paused: bool = True
    pending_operation: Optional[PendingOperation] = None


@dataclass(frozen=True)
class HitCondition:
    operator: str
    value: int

    def matches(self, count: int) -> bool:
        if self.operator == "==":
            return count == self.value
        if self.operator == ">":
            return count > self.value
        if self.operator == ">=":
            return count >= self.value
        if self.operator == "<":
            return count < self.value
        if self.operator == "<=":
            return count <= self.value
        return count % self.value == 0


@dataclass(frozen=True)
class LogMessagePart:
    literal: Optional[str] = None
    code: Optional[types.CodeType] = None


@dataclass(frozen=True)
class BreakpointSpec:
    breakpoint_id: int
    line: int
    condition: Optional[str] = None
    code: Optional[types.CodeType] = None
    hit_condition: Optional[HitCondition] = None
    log_parts: Optional[Tuple[LogMessagePart, ...]] = None


@dataclass(frozen=True)
class BreakpointMatch:
    filename: str
    table: Dict[int, Tuple[BreakpointSpec, ...]]
    breakpoint_ids: Tuple[int, ...]
    description: Optional[str] = None
    log_outputs: Tuple[str, ...] = ()


@dataclass(frozen=True)
class QueuedLogEvent:
    expected_client: socket.socket
    filename: str
    table: Dict[int, Tuple[BreakpointSpec, ...]]
    body: Dict[str, Any]


@dataclass
class ValueHandle:
    native_thread_id: int
    value: Any
    frame: Optional[types.FrameType]
    kind: str = "value"
    parent_reference: int = 0
    name: Optional[str] = None
    evaluate_name: Optional[str] = None


@dataclass(frozen=True)
class LazyMemberSpec:
    name: str
    kind: str


@dataclass(frozen=True)
class ExceptionStopMarker:
    value: Any
    filter_id: str


@dataclass(frozen=True)
class ExceptionStopInfo:
    value: Any
    traceback: Optional[types.TracebackType]
    break_mode: str
    filter_id: str
    generation: int
    frame: Optional[types.FrameType] = None
    request_scope: Optional[Dict[str, Any]] = None


class SetVariableError(Exception):
    """Expected, user-facing failure while resolving a writable variable."""


class NativeDapTracer:
    def __init__(self) -> None:
        self.owner_pid = os.getpid()
        self.breakpoints: Dict[str, Dict[int, Tuple[BreakpointSpec, ...]]] = {}
        self.call_breakpoint_locations: Dict[
            int,
            Tuple[
                types.FrameType,
                int,
                Dict[int, Tuple[BreakpointSpec, ...]],
            ],
        ] = {}
        self.steps: Dict[int, Tuple[str, int]] = {}
        self.pause_requests = set()  # type: Set[int]
        self.stops: Dict[int, StopContext] = {}
        self.condition = threading.Condition(threading.RLock())
        self.breakpoint_lock = threading.RLock()
        self.send_lock = threading.Lock()
        self.client: Optional[socket.socket] = None
        self.server: Optional[socket.socket] = None
        self.enabled = True
        self.configured = False
        self.control_ident: Optional[int] = None
        self.log_output_ident: Optional[int] = None
        self.log_output_thread: Optional[threading.Thread] = None
        self.log_queue = queue.Queue(maxsize=_MAX_PENDING_LOG_EVENTS)
        self.log_drop_lock = threading.Lock()
        self.dropped_log_events = 0
        self.dropped_log_summaries: Dict[
            Tuple[int, str, int],
            Tuple[int, QueuedLogEvent],
        ] = {}
        self.sequence = 1
        self.pending_attach: Optional[Dict[str, Any]] = None
        self.native_to_dap: Dict[int, int] = {}
        self.dap_to_native: Dict[int, int] = {}
        self.native_threads = weakref.WeakValueDictionary()
        self.next_thread_id = 1
        self.next_breakpoint_id = 1
        self.breakpoint_hit_counts: Dict[int, int] = {}
        self.exception_filters = set()  # type: Set[str]
        self.exception_generation = 0
        self.last_exception_stops = (
            {}
        )  # type: Dict[int, Tuple[ExceptionStopMarker, ...]]
        self.previous_sys_excepthook = None  # type: Optional[Callable[..., Any]]
        self.previous_threading_excepthook = None  # type: Optional[Callable[..., Any]]
        self.sys_exception_hook = None  # type: Optional[Callable[..., Any]]
        self.threading_exception_hook = None  # type: Optional[Callable[..., Any]]
        self.django_exception_signal = None  # type: Any
        self.django_exception_receiver = None  # type: Optional[Callable[..., Any]]
        self.django_exception_dispatch_uid = None  # type: Optional[str]
        self.django_response_for_exception_code = None  # type: Optional[types.CodeType]
        self.next_handle = 1
        self.frames: Dict[int, Tuple[int, types.FrameType]] = {}
        self.values: Dict[int, ValueHandle] = {}
        self.value_handles: Dict[
            Tuple[int, int, int, str, int, Optional[str], Optional[str]],
            int,
        ] = {}
        self.normalized_paths: Dict[str, str] = {}
        self.endpoint: Optional[Tuple[str, int]] = None
        self.disconnect_requested = False
        self.client_supports_variable_type = False
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

        # Start internal protocol threads before threading.settrace(), so they
        # can never pause themselves in the trace callback.
        log_output = threading.Thread(
            target=self._send_log_events,
            name="native-dap-log-output",
            daemon=True,
        )
        self.log_output_thread = log_output
        log_output.start()
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

    def _install_uncaught_exception_hooks_locked(self) -> None:
        if self.sys_exception_hook is not None:
            if (
                sys.excepthook is self.sys_exception_hook
                and threading.excepthook is self.threading_exception_hook
            ):
                return
            # Another integration replaced one or both hooks after us. Restore
            # only the endpoints we still own, then wrap the new current pair
            # so a repeated DAP configuration genuinely re-enables uncaught
            # stops without discarding the other integration.
            self._restore_uncaught_exception_hooks()

        tracer_ref = weakref.ref(self)
        previous_sys_hook = sys.excepthook
        previous_threading_hook = threading.excepthook

        def sys_exception_hook(
            exception_type: type,
            exception_value: Any,
            exception_traceback: Optional[types.TracebackType],
        ) -> None:
            tracer = tracer_ref()
            native_id = threading.get_ident()
            attempted = False
            try:
                if (
                    tracer is not None
                    and tracer.owner_pid == os.getpid()
                    and tracer.enabled
                    and not sys.is_finalizing()
                ):
                    attempted = True
                    tracer._handle_uncaught_exception(
                        native_id,
                        exception_value,
                        exception_traceback,
                    )
            except BaseException:
                pass
            try:
                previous_sys_hook(
                    exception_type,
                    exception_value,
                    exception_traceback,
                )
            finally:
                if (
                    attempted
                    and tracer is not None
                    and tracer.owner_pid == os.getpid()
                    and not sys.is_finalizing()
                ):
                    tracer._clear_exception_stops(native_id)

        def threading_exception_hook(args: Any) -> None:
            tracer = tracer_ref()
            native_id = threading.get_ident()
            exception_value = None
            attempted = False
            try:
                exception_value = args.exc_value
                if (
                    tracer is not None
                    and tracer.owner_pid == os.getpid()
                    and tracer.enabled
                    and not sys.is_finalizing()
                ):
                    attempted = True
                    tracer._handle_uncaught_exception(
                        native_id,
                        exception_value,
                        args.exc_traceback,
                    )
            except BaseException:
                pass
            try:
                previous_threading_hook(args)
            finally:
                if (
                    attempted
                    and tracer is not None
                    and tracer.owner_pid == os.getpid()
                    and not sys.is_finalizing()
                ):
                    tracer._clear_exception_stops(native_id)

        self.previous_sys_excepthook = previous_sys_hook
        self.previous_threading_excepthook = previous_threading_hook
        self.sys_exception_hook = sys_exception_hook
        self.threading_exception_hook = threading_exception_hook
        sys.excepthook = sys_exception_hook
        try:
            threading.excepthook = threading_exception_hook
        except BaseException:
            if sys.excepthook is sys_exception_hook:
                sys.excepthook = previous_sys_hook
            self.previous_sys_excepthook = None
            self.previous_threading_excepthook = None
            self.sys_exception_hook = None
            self.threading_exception_hook = None
            raise

    def _restore_uncaught_exception_hooks(self) -> None:
        sys_hook = self.sys_exception_hook
        threading_hook = self.threading_exception_hook
        previous_sys_hook = self.previous_sys_excepthook
        previous_threading_hook = self.previous_threading_excepthook
        if sys_hook is not None and sys.excepthook is sys_hook:
            sys.excepthook = previous_sys_hook
        if (
            threading_hook is not None
            and threading.excepthook is threading_hook
        ):
            threading.excepthook = previous_threading_hook
        self.previous_sys_excepthook = None
        self.previous_threading_excepthook = None
        self.sys_exception_hook = None
        self.threading_exception_hook = None

    @staticmethod
    def _loaded_module_namespace(name: str) -> Optional[dict]:
        """Return an already-loaded module namespace without importing Django."""
        try:
            module = sys.modules.get(name)
            if type(module) is not types.ModuleType:
                return None
            namespace = object.__getattribute__(module, "__dict__")
            return namespace if type(namespace) is dict else None
        except BaseException:
            return None

    def _install_django_exception_signal_locked(self) -> None:
        # A repeated DAP configuration also repairs a receiver removed by a
        # Django autoreloader or another integration. Disconnect only in a
        # normal process: the fork-child reset deliberately takes a lock-free
        # path and merely forgets these fields.
        self._restore_django_exception_signal()

        signals_namespace = self._loaded_module_namespace(
            "django.core.signals"
        )
        if signals_namespace is None:
            raise RuntimeError("django.core.signals is not loaded")
        signal = signals_namespace.get("got_request_exception")
        if signal is None:
            raise RuntimeError("got_request_exception is unavailable")

        handler_code = None  # type: Optional[types.CodeType]
        handler_namespace = self._loaded_module_namespace(
            "django.core.handlers.exception"
        )
        if handler_namespace is not None:
            handler = handler_namespace.get("response_for_exception")
            if type(handler) is types.FunctionType:
                try:
                    candidate_code = object.__getattribute__(handler, "__code__")
                    if type(candidate_code) is types.CodeType:
                        handler_code = candidate_code
                except BaseException:
                    pass

        tracer_ref = weakref.ref(self)
        dispatch_uid = "django-process-debugger:{}:{}".format(
            self.owner_pid,
            id(self),
        )

        def django_request_exception_receiver(
            sender: Any = None,
            request: Any = None,
            **_kwargs: Any,
        ) -> None:
            tracer = tracer_ref()
            try:
                if (
                    tracer is None
                    or tracer.owner_pid != os.getpid()
                    or not tracer.enabled
                    or not tracer.configured
                    or tracer.client is None
                    or "djangoRequestUnhandled" not in tracer.exception_filters
                    or sys.is_finalizing()
                ):
                    return None
                native_id = threading.get_ident()
                if native_id in (tracer.control_ident, tracer.log_output_ident):
                    return None
                tracer._handle_django_request_exception(native_id, request)
            except BaseException:
                # A debugger receiver must never change Django's signal result
                # or replace the application's original request exception.
                pass
            return None

        connect = object.__getattribute__(signal, "connect")
        connect(
            django_request_exception_receiver,
            weak=False,
            dispatch_uid=dispatch_uid,
        )
        self.django_exception_signal = signal
        self.django_exception_receiver = django_request_exception_receiver
        self.django_exception_dispatch_uid = dispatch_uid
        self.django_response_for_exception_code = handler_code

    def _restore_django_exception_signal(self) -> None:
        signal = self.django_exception_signal
        receiver = self.django_exception_receiver
        dispatch_uid = self.django_exception_dispatch_uid
        self.django_exception_signal = None
        self.django_exception_receiver = None
        self.django_exception_dispatch_uid = None
        self.django_response_for_exception_code = None
        if signal is None or receiver is None:
            return
        try:
            disconnect = object.__getattribute__(signal, "disconnect")
            disconnect(receiver=receiver, dispatch_uid=dispatch_uid)
        except BaseException:
            # Clearing the filter/configuration still makes a receiver left by
            # an unusual Signal implementation inert through its guards.
            pass

    def _clear_exception_stop(
        self,
        native_id: int,
        value: Any,
        filter_id: Optional[str] = None,
    ) -> None:
        with self.condition:
            tracked = self.last_exception_stops.get(native_id, ())
            remaining = tuple(
                marker
                for marker in tracked
                if not (
                    marker.value is value
                    and (filter_id is None or marker.filter_id == filter_id)
                )
            )
            if not remaining:
                self.last_exception_stops.pop(native_id, None)
            elif len(remaining) != len(tracked):
                self.last_exception_stops[native_id] = remaining

    def _clear_exception_stops(self, native_id: int) -> None:
        with self.condition:
            self.last_exception_stops.pop(native_id, None)

    def _has_exception_stop(
        self,
        native_id: int,
        value: Any,
        filter_id: str,
    ) -> bool:
        if filter_id == "raised":
            # asgiref transfers an async request exception to Django's sync
            # response handler by re-raising the same exception instance in a
            # worker. Treat that as propagation of the original Raised phase,
            # not a second user-visible raise. Avoid consulting application
            # Thread subclasses on this hot path; normal trace/thread cleanup
            # expires propagation markers.
            for _tracked_native_id, tracked in tuple(
                self.last_exception_stops.items()
            ):
                if any(
                    marker.value is value and marker.filter_id == filter_id
                    for marker in tracked
                ):
                    return True
            return False
        return any(
            marker.value is value and marker.filter_id == filter_id
            for marker in self.last_exception_stops.get(native_id, ())
        )

    def _clear_handled_exception_stop(self, native_id: int) -> None:
        tracked = self.last_exception_stops.get(native_id, ())
        if not tracked:
            return
        try:
            current_exception = sys.exc_info()[1]
        except BaseException:
            return
        with self.condition:
            if self.last_exception_stops.get(native_id) is not tracked:
                return
            if current_exception is None:
                self.last_exception_stops.pop(native_id, None)
                return
            matching_index = None
            for index, marker in enumerate(tracked):
                if marker.value is current_exception:
                    matching_index = index
            if matching_index is not None:
                if matching_index + 1 < len(tracked):
                    self.last_exception_stops[native_id] = tracked[
                        : matching_index + 1
                    ]
                return
            # An untracked nested exception can temporarily hide a tracked
            # outer exception in sys.exc_info(). Keep the outer markers until
            # a later line/call observes either one of them or no exception.

    def _handle_raised_exception(
        self,
        native_id: int,
        frame: types.FrameType,
        arg: Any,
        expected_client: socket.socket,
    ) -> None:
        if type(arg) is not tuple or len(arg) != 3:
            return
        value = arg[1]
        exception_traceback = arg[2]
        if value is None or _type_mro_contains(
            type(value),
            (StopIteration, StopAsyncIteration, GeneratorExit),
        ):
            return
        if (
            type(exception_traceback) is types.TracebackType
            and exception_traceback.tb_next is not None
        ):
            # CPython prepends a traceback node while an exception propagates
            # through callers and when an existing exception object is
            # explicitly re-raised (including asgiref's worker handoff). The
            # one-node event is the original Raised phase; later nodes retain
            # the original throw site and must not create duplicate stops.
            return
        raw_filename = frame.f_code.co_filename
        filename = self.normalized_paths.get(raw_filename)
        if filename is None:
            filename = _path(raw_filename)
            self.normalized_paths[raw_filename] = filename
        if filename == _THIS_FILE:
            return

        with self.condition:
            if (
                not self.configured
                or self.client is not expected_client
                or "raised" not in self.exception_filters
                or self._has_exception_stop(native_id, value, "raised")
            ):
                return
            generation = self.exception_generation
        self._pause(
            native_id,
            frame,
            "exception",
            expected_client,
            exception_stop=ExceptionStopInfo(
                value,
                (
                    exception_traceback
                    if type(exception_traceback) is types.TracebackType
                    else None
                ),
                "always",
                "raised",
                generation,
                frame,
            ),
        )

    def _handle_uncaught_exception(
        self,
        native_id: int,
        value: Any,
        exception_traceback: Optional[types.TracebackType],
    ) -> None:
        if (
            self.owner_pid != os.getpid()
            or not self.enabled
            or sys.is_finalizing()
        ):
            return
        if native_id in (self.control_ident, self.log_output_ident):
            return
        if (
            value is None
            or type(exception_traceback) is not types.TracebackType
            or _type_mro_contains(type(value), (KeyboardInterrupt, SystemExit))
        ):
            return
        with self.condition:
            expected_client = self.client
            if (
                not self.enabled
                or not self.configured
                or expected_client is None
                or "uncaught" not in self.exception_filters
                or self._has_exception_stop(native_id, value, "uncaught")
            ):
                return
            generation = self.exception_generation

        selected_traceback = self._innermost_exception_traceback(
            exception_traceback
        )
        self._ensure_thread_identity(native_id, threading.current_thread())
        previous_trace = sys.gettrace()
        owns_trace = getattr(previous_trace, "__self__", None) is self
        if owns_trace:
            sys.settrace(None)
        try:
            self._pause(
                native_id,
                selected_traceback.tb_frame,
                "exception",
                expected_client,
                exception_stop=ExceptionStopInfo(
                    value,
                    exception_traceback,
                    "unhandled",
                    "uncaught",
                    generation,
                ),
            )
        finally:
            if (
                owns_trace
                and self.enabled
                and self.owner_pid == os.getpid()
            ):
                sys.settrace(previous_trace)

    @staticmethod
    def _innermost_exception_traceback(
        exception_traceback: types.TracebackType,
    ) -> types.TracebackType:
        selected = exception_traceback
        traversed = 0
        while (
            selected.tb_next is not None
            and traversed < _MAX_EXCEPTION_TRACEBACK_SCAN
        ):
            selected = selected.tb_next
            traversed += 1
        return selected

    def _django_handler_exception(
        self,
    ) -> Tuple[Any, Optional[types.TracebackType]]:
        """Recover Django's local ``exc`` when no active except state exists."""
        handler_code = self.django_response_for_exception_code
        if handler_code is None:
            return None, None
        frame = None  # type: Optional[types.FrameType]
        try:
            frame = sys._getframe(1)
            traversed = 0
            while frame is not None and traversed < _MAX_DJANGO_HANDLER_FRAME_SCAN:
                module_name = self._frame_module_name(frame)
                if (
                    module_name == "django.core.handlers.exception"
                    and frame.f_code is not handler_code
                ):
                    # An error-handler failure sends the same signal from
                    # get_exception_response while response_for_exception for
                    # the original HTTP exception is still farther down the
                    # stack. Never mistake that outer local for the new error.
                    return None, None
                if frame.f_code is handler_code:
                    try:
                        for key, candidate in frame.f_locals.items():
                            if type(key) is str and key == "exc":
                                exception_traceback = _base_exception_attribute(
                                    candidate,
                                    _BASE_EXCEPTION_TRACEBACK_DESCRIPTOR,
                                )
                                return (
                                    candidate,
                                    exception_traceback
                                    if type(exception_traceback)
                                    is types.TracebackType
                                    else None,
                                )
                    except BaseException:
                        return None, None
                frame = frame.f_back
                traversed += 1
        except BaseException:
            return None, None
        finally:
            # Do not retain a live Django request stack through a local frame
            # reference after the signal receiver returns.
            frame = None
        return None, None

    @staticmethod
    def _django_request_scope(request: Any) -> Dict[str, Any]:
        # Properties such as body, headers, cookies, session, and user may run
        # application/framework code. Only copy already-stored request fields;
        # explicit expansion of ``request`` remains available through the
        # normal safe/lazy variable machinery.
        result = {"request": request}  # type: Dict[str, Any]
        instance_dict = _safe_instance_dict(request)
        if instance_dict is None:
            return result
        wanted = ("method", "path", "path_info", "resolver_match")
        try:
            for index, (key, value) in enumerate(instance_dict.items()):
                if index >= _MAX_DJANGO_REQUEST_FIELD_SCAN:
                    break
                if type(key) is str and key in wanted:
                    result[key] = value
                    if len(result) == len(wanted) + 1:
                        break
        except BaseException:
            pass
        return result

    def _handle_django_request_exception(
        self,
        native_id: int,
        request: Any,
    ) -> None:
        if (
            self.owner_pid != os.getpid()
            or not self.enabled
            or sys.is_finalizing()
            or native_id in (self.control_ident, self.log_output_ident)
        ):
            return

        value = None
        exception_traceback = None  # type: Optional[types.TracebackType]
        try:
            _exception_type, value, candidate_traceback = sys.exc_info()
            if type(candidate_traceback) is types.TracebackType:
                exception_traceback = candidate_traceback
        except BaseException:
            pass

        if (
            value is None
            or not _type_mro_contains(type(value), (BaseException,))
            or exception_traceback is None
        ):
            recovered_value, recovered_traceback = self._django_handler_exception()
            if (
                recovered_value is not None
                and _type_mro_contains(type(recovered_value), (BaseException,))
                and recovered_traceback is not None
            ):
                value = recovered_value
                exception_traceback = recovered_traceback

        if (
            value is None
            or exception_traceback is None
            or not _type_mro_contains(type(value), (BaseException,))
            or _type_mro_contains(type(value), (KeyboardInterrupt, SystemExit))
        ):
            return

        with self.condition:
            expected_client = self.client
            if (
                not self.enabled
                or not self.configured
                or expected_client is None
                or "djangoRequestUnhandled" not in self.exception_filters
                or self._has_exception_stop(
                    native_id,
                    value,
                    "djangoRequestUnhandled",
                )
            ):
                return
            generation = self.exception_generation

        selected_traceback = self._innermost_exception_traceback(
            exception_traceback
        )
        request_scope = self._django_request_scope(request)
        self._ensure_thread_identity(native_id, threading.current_thread())
        previous_trace = sys.gettrace()
        owns_trace = getattr(previous_trace, "__self__", None) is self
        if owns_trace:
            sys.settrace(None)
        try:
            self._pause(
                native_id,
                selected_traceback.tb_frame,
                "exception",
                expected_client,
                exception_stop=ExceptionStopInfo(
                    value,
                    exception_traceback,
                    "userUnhandled",
                    "djangoRequestUnhandled",
                    generation,
                    request_scope=request_scope,
                ),
            )
        finally:
            if (
                owns_trace
                and self.enabled
                and self.owner_pid == os.getpid()
            ):
                sys.settrace(previous_trace)

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
        if native_id in (self.control_ident, self.log_output_ident):
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
        if event == "exception":
            try:
                self._handle_raised_exception(
                    native_id,
                    frame,
                    arg,
                    active_client,
                )
            except BaseException:
                pass
            return self.trace
        if event in ("call", "line"):
            self._clear_handled_exception_stop(native_id)
        if event not in ("call", "line"):
            if event == "return":
                self.call_breakpoint_locations.pop(native_id, None)
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
            table = self.breakpoints.get(filename)
            if table is None or not table.get(frame.f_lineno):
                self.call_breakpoint_locations.pop(native_id, None)
                return self.trace
            self.call_breakpoint_locations[native_id] = (
                frame,
                frame.f_lineno,
                table,
            )
            breakpoint_match = self._breakpoint_match(
                frame,
                filename,
                expected_table=table,
            )
            if breakpoint_match is not None:
                self._queue_breakpoint_logs(
                    breakpoint_match,
                    frame,
                    active_client,
                )
                if breakpoint_match.breakpoint_ids:
                    self._pause(
                        native_id,
                        frame,
                        "breakpoint",
                        active_client,
                        breakpoint_match=breakpoint_match,
                    )
            return self.trace
        reason: Optional[str] = None
        breakpoint_match: Optional[BreakpointMatch] = None
        if native_id in self.pause_requests:
            reason = "pause"
        else:
            call_location = self.call_breakpoint_locations.pop(native_id, None)
            duplicate_call_location = (
                call_location is not None
                and call_location[0] is frame
                and call_location[1] == frame.f_lineno
                and self.breakpoints.get(filename) is call_location[2]
            )
            if not duplicate_call_location:
                breakpoint_match = self._breakpoint_match(frame, filename)
            if breakpoint_match is not None:
                self._queue_breakpoint_logs(
                    breakpoint_match,
                    frame,
                    active_client,
                )
                if breakpoint_match.breakpoint_ids:
                    reason = "breakpoint"
            if reason is None:
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
            self._pause(
                native_id,
                frame,
                reason,
                active_client,
                breakpoint_match=(
                    breakpoint_match if reason == "breakpoint" else None
                ),
            )
        return self.trace

    def _breakpoint_match(
        self,
        frame: types.FrameType,
        filename: str,
        expected_table: Optional[Dict[int, Tuple[BreakpointSpec, ...]]] = None,
    ) -> Optional[BreakpointMatch]:
        table = (
            expected_table
            if expected_table is not None
            else self.breakpoints.get(filename)
        )
        if table is None:
            return None
        with self.breakpoint_lock:
            if self.breakpoints.get(filename) is not table:
                return None
        specs = table.get(frame.f_lineno, ())
        matched_ids = []
        log_outputs = []
        description: Optional[str] = None
        for spec in specs:
            with self.breakpoint_lock:
                if self.breakpoints.get(filename) is not table:
                    return None
            condition_error: Optional[BaseException] = None
            if spec.code is None:
                matched = True
            else:
                try:
                    matched = bool(self._evaluate_code(spec.code, frame))
                except BaseException as exc:
                    matched = False
                    condition_error = exc

            # Condition evaluation can execute arbitrary target code. Confirm
            # the immutable source snapshot is still current before counting,
            # rendering, stopping, or reporting an evaluation failure.
            with self.breakpoint_lock:
                if self.breakpoints.get(filename) is not table:
                    return None
                if condition_error is None and matched and spec.hit_condition is not None:
                    count = self.breakpoint_hit_counts.get(spec.breakpoint_id, 0) + 1
                    self.breakpoint_hit_counts[spec.breakpoint_id] = count
                    matched = spec.hit_condition.matches(count)

            if condition_error is not None:
                if spec.log_parts is not None:
                    log_outputs.append(
                        self._escape_log_text(
                            "<logpoint condition raised {}>".format(
                                _type_name(condition_error)
                            )
                        )
                    )
                else:
                    matched_ids.append(spec.breakpoint_id)
                    if description is None:
                        description = self._escape_log_text(
                            "Breakpoint condition raised {}".format(
                                _type_name(condition_error)
                            )
                        )
                continue
            if not matched:
                continue
            if spec.log_parts is not None:
                rendered = self._render_log_message(
                    spec.log_parts,
                    frame,
                    lambda: self.breakpoints.get(filename) is table,
                )
                if rendered is None:
                    return None
                log_outputs.append(rendered)
            else:
                matched_ids.append(spec.breakpoint_id)
        if not matched_ids and not log_outputs:
            return None
        return BreakpointMatch(
            filename,
            table,
            tuple(matched_ids),
            description,
            tuple(log_outputs),
        )

    @staticmethod
    def _parse_hit_condition(value: str) -> HitCondition:
        if len(value) > 128:
            raise ValueError("hit condition is too long")
        match = _HIT_CONDITION_PATTERN.fullmatch(value)
        if match is None:
            raise ValueError("unsupported hit condition syntax")
        operator = match.group(1) or "=="
        target = int(match.group(2))
        if target <= 0:
            raise ValueError("hit count must be a positive integer")
        return HitCondition(operator, target)

    @staticmethod
    def _log_expression_end(message: str, start: int) -> int:
        """Find a template expression's closing brace without evaluating it."""
        stack = []
        quote: Optional[str] = None
        triple = False
        in_comment = False
        index = start
        while index < len(message):
            char = message[index]
            if in_comment:
                if char in "\r\n":
                    in_comment = False
                index += 1
                continue
            if quote is not None:
                if char == "\\":
                    index += 2
                    continue
                if triple:
                    if message.startswith(quote * 3, index):
                        quote = None
                        triple = False
                        index += 3
                    else:
                        index += 1
                    continue
                if char == quote:
                    quote = None
                index += 1
                continue
            if char in ("'", '"'):
                quote = char
                triple = message.startswith(char * 3, index)
                index += 3 if triple else 1
                continue
            if char == "#":
                in_comment = True
                index += 1
                continue
            if char in "([{":
                stack.append(char)
                index += 1
                continue
            if char in ")]}":
                if char == "}" and not stack:
                    return index
                expected = {")": "(", "]": "[", "}": "{"}[char]
                if not stack or stack[-1] != expected:
                    raise ValueError("mismatched delimiter in logpoint expression")
                stack.pop()
            index += 1
        raise ValueError("unclosed expression in log message")

    @classmethod
    def _compile_log_message(
        cls,
        message: str,
        label: str,
    ) -> Tuple[LogMessagePart, ...]:
        if len(message) > _MAX_EXPRESSION_CHARS:
            raise ValueError("log message is too long")
        parts = []
        literal = []
        placeholders = 0
        index = 0

        def flush_literal() -> None:
            if literal:
                parts.append(LogMessagePart(literal="".join(literal)))
                literal.clear()

        while index < len(message):
            char = message[index]
            if char == "{" and index + 1 < len(message) and message[index + 1] == "{":
                literal.append("{")
                index += 2
                continue
            if char == "}" and index + 1 < len(message) and message[index + 1] == "}":
                literal.append("}")
                index += 2
                continue
            if char == "}":
                raise ValueError("unmatched closing brace in log message")
            if char != "{":
                literal.append(char)
                index += 1
                continue

            flush_literal()
            end = cls._log_expression_end(message, index + 1)
            expression = message[index + 1 : end].strip()
            if not expression:
                raise ValueError("logpoint expression cannot be empty")
            placeholders += 1
            if placeholders > _MAX_LOG_PLACEHOLDERS:
                raise ValueError("log message has too many expressions")
            code = cls._compile_expression(
                expression,
                "<logpoint expression {} #{}>".format(label, placeholders),
            )
            parts.append(LogMessagePart(code=code))
            index = end + 1
        flush_literal()
        return tuple(parts)

    @staticmethod
    def _escape_log_text(value: str) -> str:
        # Normalize a possible str subclass while still on the caller's safe
        # side of the user-code boundary. Direct str slot dispatch cannot call
        # an override on the subclass.
        value = str.__str__(value)
        escaped = []
        suffix = "...<truncated>"
        budget = _MAX_LOG_OUTPUT_CHARS - len(suffix)
        used = 0
        truncated = False
        for char in value:
            codepoint = ord(char)
            if char == "\n":
                rendered = "\\n"
            elif char == "\r":
                rendered = "\\r"
            elif char == "\t":
                rendered = "\\t"
            elif codepoint < 32 or 127 <= codepoint <= 159:
                rendered = "\\x{:02x}".format(codepoint)
            elif 0xD800 <= codepoint <= 0xDFFF:
                rendered = "\\u{:04x}".format(codepoint)
            else:
                rendered = char
            if used + len(rendered) > budget:
                truncated = True
                break
            escaped.append(rendered)
            used += len(rendered)
        result = "".join(escaped)
        return result + suffix if truncated else result

    @classmethod
    def _render_log_message(
        cls,
        parts: Tuple[LogMessagePart, ...],
        frame: types.FrameType,
        is_current: Optional[Callable[[], bool]] = None,
    ) -> Optional[str]:
        rendered = []
        for part in parts:
            if is_current is not None and not is_current():
                return None
            if part.literal is not None:
                rendered.append(part.literal)
                continue
            assert part.code is not None
            try:
                value = cls._evaluate_code(part.code, frame)
            except BaseException as exc:
                rendered.append("<evaluation raised {}>".format(_type_name(exc)))
                if is_current is not None and not is_current():
                    return None
                continue
            if is_current is not None and not is_current():
                return None
            try:
                rendered.append(cls._safe_repr(value))
            except BaseException as exc:
                rendered.append("<rendering raised {}>".format(_type_name(exc)))
        if is_current is not None and not is_current():
            return None
        return cls._escape_log_text("".join(rendered))

    def _queue_breakpoint_logs(
        self,
        breakpoint_match: BreakpointMatch,
        frame: types.FrameType,
        expected_client: socket.socket,
    ) -> None:
        if not breakpoint_match.log_outputs:
            return
        source = {
            "name": os.path.basename(frame.f_code.co_filename),
            "path": os.path.realpath(frame.f_code.co_filename),
        }
        for output in breakpoint_match.log_outputs:
            event = QueuedLogEvent(
                expected_client,
                breakpoint_match.filename,
                breakpoint_match.table,
                {
                    "category": "console",
                    "output": output + "\n",
                    "source": source,
                    "line": frame.f_lineno,
                },
            )
            if (
                not self.enabled
                or not self.configured
                or self.client is not expected_client
                or self.breakpoints.get(breakpoint_match.filename)
                is not breakpoint_match.table
            ):
                return
            try:
                self.log_queue.put_nowait(event)
            except queue.Full:
                with self.log_drop_lock:
                    self.dropped_log_events += 1
                    key = (
                        id(expected_client),
                        breakpoint_match.filename,
                        id(breakpoint_match.table),
                    )
                    previous = self.dropped_log_summaries.get(key)
                    if previous is None:
                        count = 1
                        if (
                            len(self.dropped_log_summaries)
                            >= _MAX_PENDING_LOG_SUMMARIES
                        ):
                            oldest_key = next(iter(self.dropped_log_summaries))
                            oldest_count, _ = self.dropped_log_summaries.pop(
                                oldest_key
                            )
                            count += oldest_count
                    else:
                        count = previous[0] + 1
                    summary_body = dict(event.body)
                    summary_body["output"] = ""
                    self.dropped_log_summaries[key] = (
                        count,
                        QueuedLogEvent(
                            event.expected_client,
                            event.filename,
                            event.table,
                            summary_body,
                        ),
                    )

    def _send_log_events(self) -> None:
        self.log_output_ident = threading.get_ident()
        while True:
            item = self.log_queue.get()
            if item is _LOG_QUEUE_STOP:
                return
            if not isinstance(item, QueuedLogEvent):
                continue
            try:
                with self.log_drop_lock:
                    dropped_summaries = tuple(
                        self.dropped_log_summaries.values()
                    )
                    self.dropped_log_summaries.clear()
                    self.dropped_log_events -= sum(
                        count for count, _ in dropped_summaries
                    )
                for dropped, dropped_item in dropped_summaries:
                    summary = dict(dropped_item.body)
                    summary["output"] = (
                        "<native tracer dropped {} logpoint messages>\n".format(
                            dropped
                        )
                    )
                    self._event(
                        "output",
                        summary,
                        expected_client=dropped_item.expected_client,
                        guard=lambda dropped_item=dropped_item: (
                            self.enabled
                            and self.configured
                            and self.breakpoints.get(dropped_item.filename)
                            is dropped_item.table
                        ),
                    )
                self._event(
                    "output",
                    item.body,
                    expected_client=item.expected_client,
                    guard=lambda item=item: (
                        self.enabled
                        and self.configured
                        and self.breakpoints.get(item.filename) is item.table
                    ),
                )
            except BaseException:
                # Output diagnostics must never terminate the sender or escape
                # into the traced application.
                continue

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
        self.call_breakpoint_locations.pop(native_id, None)
        self.pause_requests.discard(native_id)
        self.last_exception_stops.pop(native_id, None)
        stale_stop = self.stops.pop(native_id, None)
        if stale_stop is not None:
            stale_stop.paused = False
            self._cancel_pending_operation_locked(stale_stop)
        self.frames = {
            handle: entry
            for handle, entry in self.frames.items()
            if entry[0] != native_id
        }
        self.values = {
            handle: entry
            for handle, entry in self.values.items()
            if entry.native_thread_id != native_id
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
        *,
        breakpoint_match: Optional[BreakpointMatch] = None,
        exception_stop: Optional[ExceptionStopInfo] = None,
    ) -> bool:
        with self.condition:
            if (
                not self.enabled
                or not self.configured
                or self.client is not expected_client
            ):
                return False
            if (
                breakpoint_match is not None
                and self.breakpoints.get(breakpoint_match.filename)
                is not breakpoint_match.table
            ):
                # A condition may execute arbitrary user code and take a long
                # time. Do not stop on a breakpoint that was replaced while
                # that condition was still running.
                return False
            if exception_stop is not None and (
                exception_stop.generation != self.exception_generation
                or exception_stop.filter_id not in self.exception_filters
                or self._has_exception_stop(
                    native_id,
                    exception_stop.value,
                    exception_stop.filter_id,
                )
            ):
                return False
            description = (
                breakpoint_match.description
                if breakpoint_match is not None
                else None
            )
            exception_text: Optional[str] = None
            if exception_stop is not None:
                try:
                    description = self._exception_stop_description(exception_stop)
                    exception_text = self._exception_type_name(exception_stop.value)
                except BaseException:
                    # Exception presentation is deliberately total. A hostile
                    # payload or concurrently mutating container must never
                    # suppress the stop or escape into the debuggee.
                    description = "Exception"
                    exception_text = "Exception"
            self._expire_handles(native_id)
            dap_id = self._thread_id(native_id, threading.current_thread())
            context = StopContext(
                native_id,
                dap_id,
                frame,
                reason,
                description,
                exception_stop,
            )
            self.pause_requests.discard(native_id)
            self.steps.pop(native_id, None)
            stopped_body: Dict[str, Any] = {
                "reason": reason,
                "threadId": dap_id,
                "allThreadsStopped": False,
            }
            if description is not None:
                stopped_body["description"] = description
            if exception_text is not None:
                stopped_body["text"] = exception_text
            if breakpoint_match is not None:
                stopped_body["hitBreakpointIds"] = list(
                    breakpoint_match.breakpoint_ids
                )
            if exception_stop is not None:
                # Commit the propagation de-duplication marker only after every
                # piece of stop state has been rendered successfully.
                tracked = self.last_exception_stops.get(native_id, ())
                self.last_exception_stops[native_id] = tracked + (
                    ExceptionStopMarker(
                        exception_stop.value,
                        exception_stop.filter_id,
                    ),
                )
            self.stops[native_id] = context
            try:
                event_sent = self._event(
                    "stopped",
                    stopped_body,
                    expected_client=expected_client,
                )
            except BaseException:
                event_sent = False
            if not event_sent:
                self.stops.pop(native_id, None)
                if exception_stop is not None:
                    self._clear_exception_stop(
                        native_id,
                        exception_stop.value,
                        exception_stop.filter_id,
                    )
                return False
            while context.paused and self.enabled:
                operation = context.pending_operation
                if operation is not None:
                    context.pending_operation = None
                    # Expressions must run on the paused application thread so
                    # threading.local, contextvars, and the active event-loop
                    # context match the selected frame. Never execute user code
                    # while holding the tracer's state lock.
                    self.condition.release()
                    try:
                        operation.result = operation.callback()
                    except BaseException as exc:
                        operation.error = exc
                    finally:
                        operation.done.set()
                        self.condition.acquire()
                    continue
                self.condition.wait()
            self._cancel_pending_operation_locked(context)
            self.stops.pop(native_id, None)
            return True

    @staticmethod
    def _cancel_pending_operation_locked(context: StopContext) -> None:
        operation = context.pending_operation
        if operation is None:
            return
        context.pending_operation = None
        operation.cancelled = True
        operation.done.set()

    def _run_on_stopped_thread(
        self,
        native_id: int,
        callback: Callable[[], Any],
    ) -> Tuple[bool, Any, Optional[BaseException]]:
        operation = PendingOperation(callback)
        with self.condition:
            context = self.stops.get(native_id)
            if context is None or not context.paused:
                return False, None, None
            if context.pending_operation is not None:
                return False, None, None
            context.pending_operation = operation
            self.condition.notify_all()

        operation.done.wait()
        if operation.cancelled:
            return False, None, None
        return True, operation.result, operation.error

    @classmethod
    def _exception_type_name(cls, value: Any, *, full: bool = False) -> str:
        try:
            name = _type_full_name(value) if full else _type_name(value)
            escaped = cls._escape_log_text(name)
        except BaseException:
            escaped = "object"
        if len(escaped) > _MAX_EXCEPTION_TYPE_CHARS:
            suffix = "...<truncated>"
            return escaped[: _MAX_EXCEPTION_TYPE_CHARS - len(suffix)] + suffix
        return escaped

    @classmethod
    def _exception_message(cls, value: Any) -> str:
        args = _base_exception_attribute(
            value,
            _BASE_EXCEPTION_ARGS_DESCRIPTOR,
            (),
        )
        if type(args) is tuple and len(args) == 1 and type(args[0]) is str:
            message = args[0]
        elif type(args) is tuple and not args:
            message = ""
        else:
            message = cls._safe_repr(args)
        escaped = cls._escape_log_text(message)
        if len(escaped) > _MAX_EXCEPTION_MESSAGE_CHARS:
            suffix = "...<truncated>"
            return escaped[: _MAX_EXCEPTION_MESSAGE_CHARS - len(suffix)] + suffix
        return escaped

    @classmethod
    def _exception_stop_description(cls, info: ExceptionStopInfo) -> str:
        type_name = cls._exception_type_name(info.value)
        message = cls._exception_message(info.value)
        return "{}: {}".format(type_name, message) if message else type_name

    @classmethod
    def _exception_stack_trace(
        cls,
        exception_traceback: Optional[types.TracebackType],
    ) -> str:
        entries = []
        current = exception_traceback
        scanned = 0
        earlier_truncated = False
        while (
            type(current) is types.TracebackType
            and scanned < _MAX_EXCEPTION_TRACEBACK_SCAN
        ):
            if len(entries) >= _MAX_EXCEPTION_STACK_FRAMES:
                entries.pop(0)
                earlier_truncated = True
            entries.append((current.tb_frame, current.tb_lineno))
            current = current.tb_next
            scanned += 1
        if type(current) is types.TracebackType:
            earlier_truncated = True
        return cls._render_exception_frame_entries(entries, earlier_truncated)

    @classmethod
    def _exception_frame_stack_trace(
        cls,
        origin_frame: Optional[types.FrameType],
    ) -> str:
        # The first trace-event traceback normally contains only the throw
        # frame. Preserve its nearest callers from f_back so exceptionInfo has
        # the same useful thrown stack that DAP stackTrace exposes.
        entries = []
        current = origin_frame
        while current is not None and len(entries) < _MAX_EXCEPTION_STACK_FRAMES:
            entries.append((current, current.f_lineno))
            current = current.f_back
        earlier_truncated = current is not None
        entries.reverse()
        return cls._render_exception_frame_entries(entries, earlier_truncated)

    @classmethod
    def _render_exception_frame_entries(
        cls,
        entries: Any,
        earlier_truncated: bool,
    ) -> str:
        lines = []
        for frame, line_number in entries:
            filename = cls._escape_log_text(frame.f_code.co_filename)
            function_name = cls._escape_log_text(frame.f_code.co_name)
            suffix = "...<truncated>"
            if len(filename) > 1024:
                filename = filename[: 1024 - len(suffix)] + suffix
            if len(function_name) > 512:
                function_name = function_name[: 512 - len(suffix)] + suffix
            line = '  File "{}", line {}, in {}'.format(
                filename,
                line_number,
                function_name,
            )
            if len(line) > _MAX_EXCEPTION_STACK_LINE_CHARS:
                line = line[: _MAX_EXCEPTION_STACK_LINE_CHARS - len(suffix)] + suffix
            lines.append(line)
        marker = "  ...<earlier frames truncated>"
        budget = _MAX_EXCEPTION_STACK_CHARS - len(marker) - 1
        size = sum(len(line) + 1 for line in lines)
        while len(lines) > 1 and size > budget:
            removed = lines.pop(0)
            size -= len(removed) + 1
            earlier_truncated = True
        if earlier_truncated:
            lines.insert(0, marker)
        return "\n".join(lines)

    @classmethod
    def _exception_inner_value(cls, value: Any) -> Tuple[Any, Optional[str]]:
        cause = _base_exception_attribute(
            value,
            _BASE_EXCEPTION_CAUSE_DESCRIPTOR,
        )
        if cause is not None:
            return cause, "cause"
        suppress_context = _base_exception_attribute(
            value,
            _BASE_EXCEPTION_SUPPRESS_CONTEXT_DESCRIPTOR,
            False,
        )
        if suppress_context is not True:
            context = _base_exception_attribute(
                value,
                _BASE_EXCEPTION_CONTEXT_DESCRIPTOR,
            )
            if context is not None:
                return context, "context"
        return None, None

    @classmethod
    def _exception_chain_stack_trace(
        cls,
        value: Any,
        exception_traceback: Optional[types.TracebackType],
        depth: int = 0,
        seen: Optional[Set[int]] = None,
        origin_frame: Optional[types.FrameType] = None,
        group_budget: Optional[Any] = None,
    ) -> str:
        if seen is None:
            seen = set()
        if group_budget is None:
            group_budget = [_MAX_FLATTENED_EXCEPTION_GROUP_TOTAL]
        if id(value) in seen:
            return ""
        seen.add(id(value))

        pieces = []
        inner, relation = cls._exception_inner_value(value)
        if inner is not None and depth < _MAX_INNER_EXCEPTION_DEPTH:
            inner_traceback = _base_exception_attribute(
                inner,
                _BASE_EXCEPTION_TRACEBACK_DESCRIPTOR,
            )
            rendered_inner = cls._exception_chain_stack_trace(
                inner,
                (
                    inner_traceback
                    if type(inner_traceback) is types.TracebackType
                    else None
                ),
                depth + 1,
                seen,
                group_budget=group_budget,
            )
            if rendered_inner:
                pieces.append(rendered_inner)
                pieces.append(
                    (
                        "The above exception was the direct cause of the "
                        "following exception:"
                        if relation == "cause"
                        else "During handling of the above exception, another "
                        "exception occurred:"
                    )
                )

        group_children = _base_exception_group_children(value)
        if group_children and depth < _MAX_INNER_EXCEPTION_DEPTH:
            visible_children = group_children[
                :_MAX_FLATTENED_EXCEPTION_GROUP_CHILDREN
            ]
            group_truncated = len(group_children) > len(visible_children)
            for index, child in enumerate(visible_children, 1):
                if id(child) in seen:
                    continue
                if group_budget[0] <= 0:
                    group_truncated = True
                    break
                group_budget[0] -= 1
                child_traceback = _base_exception_attribute(
                    child,
                    _BASE_EXCEPTION_TRACEBACK_DESCRIPTOR,
                )
                rendered_child = cls._exception_chain_stack_trace(
                    child,
                    (
                        child_traceback
                        if type(child_traceback) is types.TracebackType
                        else None
                    ),
                    depth + 1,
                    seen,
                    group_budget=group_budget,
                )
                if rendered_child:
                    pieces.append(
                        "Contained exception #{}:\n{}".format(
                            index,
                            rendered_child,
                        )
                    )
            if group_truncated:
                pieces.append(
                    "...<additional contained exceptions omitted>"
                )

        stack_trace = (
            cls._exception_frame_stack_trace(origin_frame)
            if origin_frame is not None
            else cls._exception_stack_trace(exception_traceback)
        )
        if stack_trace:
            pieces.append("Traceback (most recent call last):\n" + stack_trace)
        label = cls._exception_type_name(value, full=True)
        message = cls._exception_message(value)
        pieces.append("{}: {}".format(label, message) if message else label)
        rendered = "\n\n".join(pieces)
        if len(rendered) > _MAX_EXCEPTION_STACK_CHARS:
            prefix = "...<earlier exception chain truncated>\n"
            return prefix + rendered[-(_MAX_EXCEPTION_STACK_CHARS - len(prefix)) :]
        return rendered

    @classmethod
    def _exception_details(
        cls,
        value: Any,
        exception_traceback: Optional[types.TracebackType],
        depth: int = 0,
        seen: Optional[Set[int]] = None,
        origin_frame: Optional[types.FrameType] = None,
        inner_budget: Optional[Any] = None,
    ) -> Dict[str, Any]:
        if seen is None:
            seen = set()
        if inner_budget is None:
            inner_budget = [_MAX_INNER_EXCEPTION_TOTAL]
        seen.add(id(value))
        details: Dict[str, Any] = {
            "message": cls._exception_message(value),
            "typeName": cls._exception_type_name(value),
            "fullTypeName": cls._exception_type_name(value, full=True),
        }
        stack_trace = (
            cls._exception_chain_stack_trace(
                value,
                exception_traceback,
                origin_frame=origin_frame,
            )
            if depth == 0
            else cls._exception_stack_trace(exception_traceback)
        )
        if stack_trace:
            details["stackTrace"] = stack_trace

        if depth >= _MAX_INNER_EXCEPTION_DEPTH:
            return details
        inner_details = []
        for child in _base_exception_group_children(value)[
            :_MAX_INNER_EXCEPTION_CHILDREN
        ]:
            if id(child) in seen:
                continue
            if inner_budget[0] <= 0:
                break
            inner_budget[0] -= 1
            child_traceback = _base_exception_attribute(
                child,
                _BASE_EXCEPTION_TRACEBACK_DESCRIPTOR,
            )
            inner_details.append(
                cls._exception_details(
                    child,
                    (
                        child_traceback
                        if type(child_traceback) is types.TracebackType
                        else None
                    ),
                    depth + 1,
                    seen,
                    inner_budget=inner_budget,
                )
            )
        cause, _relation = cls._exception_inner_value(value)
        if (
            cause is not None
            and id(cause) not in seen
            and inner_budget[0] > 0
        ):
            inner_budget[0] -= 1
            cause_traceback = _base_exception_attribute(
                cause,
                _BASE_EXCEPTION_TRACEBACK_DESCRIPTOR,
            )
            inner_details.append(
                cls._exception_details(
                    cause,
                    (
                        cause_traceback
                        if type(cause_traceback) is types.TracebackType
                        else None
                    ),
                    depth + 1,
                    seen,
                    inner_budget=inner_budget,
                )
            )
        if inner_details:
            details["innerException"] = inner_details
        return details

    def _exception_info(
        self,
        request: Dict[str, Any],
        args: Dict[str, Any],
    ) -> None:
        try:
            dap_thread_id = int(args.get("threadId", 0))
        except (TypeError, ValueError):
            dap_thread_id = 0
        with self.condition:
            native_id = self.dap_to_native.get(dap_thread_id)
            context = self.stops.get(native_id) if native_id is not None else None
            active = (
                context is not None
                and context.paused
                and context.reason == "exception"
                and context.exception_info is not None
            )
            info = context.exception_info if active and context is not None else None
        if info is None:
            self._response(
                request,
                success=False,
                message="Thread is not stopped on an exception",
            )
            return
        try:
            exception_id = self._exception_type_name(info.value, full=True)
            description = self._exception_stop_description(info)
            details = self._exception_details(
                info.value,
                info.traceback,
                origin_frame=info.frame,
            )
        except BaseException:
            exception_id = "Exception"
            description = "Exception details are unavailable"
            details = {
                "message": "Exception details are unavailable",
                "typeName": "Exception",
                "fullTypeName": "Exception",
            }
        self._response(
            request,
            {
                "exceptionId": exception_id,
                "description": description,
                "breakMode": info.break_mode,
                "details": details,
            },
        )

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
        guard: Optional[Callable[[], bool]] = None,
    ) -> bool:
        try:
            with self.send_lock:
                if guard is not None and not guard():
                    return False
                client = expected_client if expected_client is not None else self.client
                if client is None:
                    return False
                if expected_client is not None and self.client is not expected_client:
                    return False
                message = {"seq": self.sequence, **message}
                self.sequence += 1
                body = json.dumps(
                    message, ensure_ascii=True, separators=(",", ":")
                ).encode("utf-8")
                packet = (
                    b"Content-Length: "
                    + str(len(body)).encode("ascii")
                    + b"\r\n\r\n"
                    + body
                )
                client.sendall(packet)
            return True
        except (OSError, UnicodeError):
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
        guard: Optional[Callable[[], bool]] = None,
    ) -> bool:
        event: Dict[str, Any] = {"type": "event", "event": name}
        if body is not None:
            event["body"] = body
        return self._send(event, expected_client, guard)

    def _request(self, request: Dict[str, Any]) -> None:
        command = request.get("command")
        raw_args = request.get("arguments")
        args = raw_args if isinstance(raw_args, dict) else {}
        if command == "initialize":
            self.client_supports_variable_type = (
                args.get("supportsVariableType") is True
            )
            self._response(
                request,
                {
                    "supportsConfigurationDoneRequest": True,
                    "supportsConditionalBreakpoints": True,
                    "supportsHitConditionalBreakpoints": True,
                    "supportsLogPoints": True,
                    "supportsSingleThreadExecutionRequests": True,
                    "supportsSetVariable": True,
                    "supportsClipboardContext": True,
                    "supportsValueFormattingOptions": True,
                    "supportsExceptionInfoRequest": True,
                    "exceptionBreakpointFilters": [
                        {
                            "filter": "raised",
                            "label": "Raised Exceptions",
                            "description": (
                                "Break when an exception is raised, including "
                                "exceptions later handled by the application."
                            ),
                            "default": False,
                        },
                        {
                            "filter": "uncaught",
                            "label": "Uncaught Exceptions",
                            "description": (
                                "Break when a process or thread is exiting due "
                                "to an unhandled exception other than "
                                "SystemExit or KeyboardInterrupt."
                            ),
                            "default": True,
                        },
                        {
                            "filter": "djangoRequestUnhandled",
                            "label": "Django Request Exceptions",
                            "description": (
                                "Break when Django converts an otherwise "
                                "unhandled request exception into an error "
                                "response."
                            ),
                            "default": False,
                        },
                    ],
                },
            )
        elif command == "attach":
            self.pending_attach = request
            self._event("initialized")
        elif command == "setBreakpoints":
            self._set_breakpoints(request, args)
        elif command == "setExceptionBreakpoints":
            self._set_exception_breakpoints(request, args)
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
                if item.ident is None or item.ident in (
                    self.control_ident,
                    self.log_output_ident,
                ):
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
        elif command == "evaluate":
            self._evaluate(request, args)
        elif command == "setVariable":
            self._set_variable(request, args)
        elif command == "exceptionInfo":
            self._exception_info(request, args)
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
                    self._cancel_pending_operation_locked(context)
                self.condition.notify_all()
        else:
            self._response(request, success=False, message=f"Unsupported request: {command}")

    def _set_exception_breakpoints(
        self,
        request: Dict[str, Any],
        args: Dict[str, Any],
    ) -> None:
        raw_filters = args.get("filters", [])
        raw_filter_options = args.get("filterOptions", [])
        raw_exception_options = args.get("exceptionOptions", [])
        if (
            type(raw_filters) is not list
            or type(raw_filter_options) is not list
            or type(raw_exception_options) is not list
        ):
            self._response(
                request,
                success=False,
                message="Exception breakpoint filters and options must be arrays",
            )
            return

        known_filters = {
            "raised",
            "uncaught",
            "djangoRequestUnhandled",
        }
        enabled = set()  # type: Set[str]
        rows = []
        row_filters = []  # type: list

        def append_row(filter_id: Any, valid: bool, message: Optional[str]) -> None:
            row: Dict[str, Any] = {"verified": valid}
            if valid:
                with self.condition:
                    row["id"] = self.next_breakpoint_id
                    self.next_breakpoint_id += 1
            elif message is not None:
                row["message"] = message
            rows.append(row)
            row_filters.append(filter_id if type(filter_id) is str else None)

        for filter_id in raw_filters:
            valid = type(filter_id) is str and filter_id in known_filters
            if valid:
                enabled.add(filter_id)
            append_row(
                filter_id,
                valid,
                None if valid else "Unknown exception breakpoint filter",
            )

        for option in raw_filter_options:
            if type(option) is not dict:
                append_row(None, False, "Invalid exception filter option")
                continue
            filter_id = option.get("filterId")
            condition = option.get("condition")
            mode = option.get("mode")
            valid_filter = type(filter_id) is str and filter_id in known_filters
            valid = (
                valid_filter
                and condition in (None, "")
                and mode in (None, "")
            )
            if valid:
                enabled.add(filter_id)
                message = None
            elif not valid_filter:
                message = "Unknown exception breakpoint filter"
            else:
                message = "Conditional exception filters are not supported"
            append_row(filter_id, valid, message)

        for _option in raw_exception_options:
            append_row(
                None,
                False,
                "Per-exception options are not supported",
            )

        hook_errors = {}  # type: Dict[str, str]
        with self.condition:
            if "uncaught" in enabled:
                try:
                    self._install_uncaught_exception_hooks_locked()
                except BaseException as exc:
                    enabled.discard("uncaught")
                    hook_errors["uncaught"] = (
                        "Cannot install uncaught exception hook: {}".format(
                            _type_name(exc)
                        )
                    )
            else:
                self._restore_uncaught_exception_hooks()
            if "djangoRequestUnhandled" in enabled:
                try:
                    self._install_django_exception_signal_locked()
                except BaseException as exc:
                    enabled.discard("djangoRequestUnhandled")
                    hook_errors["djangoRequestUnhandled"] = (
                        "Cannot install Django request exception signal: {}".format(
                            _type_name(exc)
                        )
                    )
            else:
                self._restore_django_exception_signal()
            self.exception_filters = enabled
            self.exception_generation += 1

        if hook_errors:
            for row, filter_id in zip(rows, row_filters):
                hook_error = hook_errors.get(filter_id)
                if hook_error is not None and row.get("verified") is True:
                    row.clear()
                    row.update({"verified": False, "message": hook_error})
        self._response(request, {"breakpoints": rows})

    def _set_breakpoints(self, request: Dict[str, Any], args: Dict[str, Any]) -> None:
        source = args.get("source") or {}
        filename = source.get("path")
        if "breakpoints" in args:
            requested = args.get("breakpoints")
        else:
            requested = [{"line": line} for line in args.get("lines", [])]
        if not isinstance(requested, list):
            requested = []
        results = []
        resolved = {}  # type: Dict[int, list]
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
            if not isinstance(item, dict):
                results.append(
                    {
                        "verified": False,
                        "line": 0,
                        "source": source,
                        "message": "Invalid breakpoint request",
                    }
                )
                continue
            try:
                line = int(item.get("line", 0))
            except (TypeError, ValueError):
                line = 0
            raw_hit_condition = item.get("hitCondition")
            hit_condition: Optional[HitCondition] = None
            if raw_hit_condition not in (None, ""):
                if not isinstance(raw_hit_condition, str):
                    results.append(
                        {
                            "verified": False,
                            "line": line,
                            "source": source,
                            "message": "Hit condition must be a string",
                        }
                    )
                    continue
                try:
                    hit_condition = self._parse_hit_condition(raw_hit_condition)
                except (ValueError, OverflowError) as exc:
                    results.append(
                        {
                            "verified": False,
                            "line": line,
                            "source": source,
                            "message": "Invalid hit condition: {}".format(exc),
                        }
                    )
                    continue
            raw_condition = item.get("condition")
            condition = (
                raw_condition
                if not isinstance(raw_condition, str) or raw_condition.strip()
                else None
            )
            condition_code: Optional[types.CodeType] = None
            if condition is not None:
                if not isinstance(condition, str):
                    results.append(
                        {
                            "verified": False,
                            "line": line,
                            "source": source,
                            "message": "Breakpoint condition must be a string expression",
                        }
                    )
                    continue
                try:
                    condition_code = self._compile_expression(
                        condition,
                        "<breakpoint condition {}:{}>".format(filename, line),
                    )
                except SyntaxError as exc:
                    results.append(
                        {
                            "verified": False,
                            "line": line,
                            "source": source,
                            "message": "Invalid breakpoint condition: {}".format(
                                exc.msg or "syntax error"
                            ),
                        }
                    )
                    continue
                except BaseException as exc:
                    results.append(
                        {
                            "verified": False,
                            "line": line,
                            "source": source,
                            "message": "Invalid breakpoint condition: {}".format(
                                _type_name(exc)
                            ),
                        }
                    )
                    continue
            raw_log_message = item.get("logMessage")
            log_parts: Optional[Tuple[LogMessagePart, ...]] = None
            if raw_log_message not in (None, ""):
                if not isinstance(raw_log_message, str):
                    results.append(
                        {
                            "verified": False,
                            "line": line,
                            "source": source,
                            "message": "Log message must be a string",
                        }
                    )
                    continue
                try:
                    log_parts = self._compile_log_message(
                        raw_log_message,
                        "{}:{}".format(filename, line),
                    )
                except SyntaxError as exc:
                    results.append(
                        {
                            "verified": False,
                            "line": line,
                            "source": source,
                            "message": "Invalid log message: {}".format(
                                exc.msg or "syntax error"
                            ),
                        }
                    )
                    continue
                except BaseException as exc:
                    results.append(
                        {
                            "verified": False,
                            "line": line,
                            "source": source,
                            "message": "Invalid log message: {}".format(
                                _type_name(exc)
                                if not isinstance(exc, ValueError)
                                else str(exc)
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
                with self.condition:
                    breakpoint_id = self.next_breakpoint_id
                    self.next_breakpoint_id += 1
                result["id"] = breakpoint_id
                resolved.setdefault(actual, []).append(
                    BreakpointSpec(
                        breakpoint_id=breakpoint_id,
                        line=actual,
                        condition=condition,
                        code=condition_code,
                        hit_condition=hit_condition,
                        log_parts=log_parts,
                    )
                )
            results.append(result)
        if isinstance(filename, str):
            normalized = _path(filename)
            table = (
                {
                    line: tuple(specs) for line, specs in resolved.items()
                }
                if resolved
                else None
            )
            with self.condition:
                with self.breakpoint_lock:
                    previous = self.breakpoints.get(normalized)
                    if previous is not None:
                        for specs in previous.values():
                            for spec in specs:
                                self.breakpoint_hit_counts.pop(
                                    spec.breakpoint_id,
                                    None,
                                )
                    breakpoints = dict(self.breakpoints)
                    if table is not None:
                        breakpoints[normalized] = table
                        for specs in table.values():
                            for spec in specs:
                                if spec.hit_condition is not None:
                                    self.breakpoint_hit_counts[spec.breakpoint_id] = 0
                    else:
                        breakpoints.pop(normalized, None)
                    self.breakpoints = breakpoints
        self._response(request, {"breakpoints": results})

    @staticmethod
    def _frame_module_name(frame: types.FrameType) -> Optional[str]:
        try:
            for key, value in frame.f_globals.items():
                if type(key) is str and key == "__name__":
                    return value[:512] if type(value) is str else None
        except BaseException:
            return None
        return None

    @staticmethod
    def _frame_parameters(
        frame: types.FrameType,
    ) -> Tuple[Tuple[str, str, Any, bool], ...]:
        code = frame.f_code
        positional_and_keyword = code.co_argcount + code.co_kwonlyargcount
        parameter_names = list(code.co_varnames[:positional_and_keyword])
        display_names = list(parameter_names)
        offset = positional_and_keyword
        if code.co_flags & _CO_VARARGS:
            parameter_names.append(code.co_varnames[offset])
            display_names.append("*" + code.co_varnames[offset])
            offset += 1
        if code.co_flags & _CO_VARKEYWORDS:
            parameter_names.append(code.co_varnames[offset])
            display_names.append("**" + code.co_varnames[offset])

        wanted = set(parameter_names)
        values = {}
        try:
            for key, value in frame.f_locals.items():
                if type(key) is str and key in wanted:
                    values[key] = value
                    if len(values) == len(wanted):
                        break
        except BaseException:
            values = {}
        return tuple(
            (
                display_name,
                lookup_name,
                values.get(lookup_name),
                lookup_name in values,
            )
            for display_name, lookup_name in zip(
                display_names,
                parameter_names,
            )
        )

    @classmethod
    def _format_stack_frame_name(
        cls,
        frame: types.FrameType,
        format_options: Any,
        line: Optional[int] = None,
    ) -> str:
        name = frame.f_code.co_name
        if type(format_options) is not dict:
            return name

        if format_options.get("module") is True:
            module_name = cls._frame_module_name(frame)
            if module_name:
                name = "{}.{}".format(module_name, name)

        if format_options.get("parameters") is True:
            show_names = format_options.get("parameterNames") is True
            show_types = format_options.get("parameterTypes") is True
            show_values = format_options.get("parameterValues") is True
            if not (show_names or show_types or show_values):
                show_names = True
                show_values = True
            rendered_parameters = []
            rendered_size = 0
            for display_name, _lookup_name, value, available in cls._frame_parameters(
                frame
            ):
                value_type = _type_name(value) if available else "unknown"
                value_text = (
                    cls._format_value(value, format_options)
                    if available
                    else "<not available>"
                )
                if show_names:
                    rendered = display_name
                    if show_types:
                        rendered += ": " + value_type
                    if show_values:
                        rendered += "=" + value_text
                elif show_types and show_values:
                    rendered = "{}={}".format(value_type, value_text)
                elif show_types:
                    rendered = value_type
                else:
                    rendered = value_text
                if rendered_size + len(rendered) + 2 > _MAX_STACK_FRAME_NAME_CHARS:
                    rendered_parameters.append("...")
                    break
                rendered_parameters.append(rendered)
                rendered_size += len(rendered) + 2
            name += "(" + ", ".join(rendered_parameters) + ")"

        if format_options.get("line") is True:
            name += ":line {}".format(
                frame.f_lineno if line is None else line
            )
        if len(name) > _MAX_STACK_FRAME_NAME_CHARS:
            suffix = "...<truncated>"
            name = name[: _MAX_STACK_FRAME_NAME_CHARS - len(suffix)] + suffix
        return name

    def _stack_trace(self, request: Dict[str, Any], args: Dict[str, Any]) -> None:
        with self.condition:
            native_id = self.dap_to_native.get(int(args.get("threadId", 0)))
            context = self.stops.get(native_id) if native_id is not None else None
        if context is None:
            self._response(request, success=False, message="Thread is not stopped")
            return
        stack = []
        format_options = args.get("format")
        frame_rows = []  # type: list
        exception_info = context.exception_info
        if (
            exception_info is not None
            and exception_info.break_mode in ("unhandled", "userUnhandled")
            and type(exception_info.traceback) is types.TracebackType
        ):
            exception_traceback = exception_info.traceback
            traceback_rows = collections.deque(
                maxlen=_MAX_EXCEPTION_STACK_FRAMES
            )
            traversed = 0
            while (
                exception_traceback is not None
                and traversed < _MAX_EXCEPTION_TRACEBACK_SCAN
            ):
                traceback_rows.append(
                    (
                        exception_traceback.tb_frame,
                        exception_traceback.tb_lineno,
                    )
                )
                exception_traceback = exception_traceback.tb_next
                traversed += 1
            # Tracebacks run caller -> throw site; DAP stacks run current/top
            # frame -> callers. This also preserves already-unwound async
            # view/middleware frames whose f_back chain no longer exists.
            frame_rows = list(reversed(traceback_rows))
        else:
            frame = context.frame  # type: Optional[types.FrameType]
            while frame is not None:
                frame_rows.append((frame, frame.f_lineno))
                frame = frame.f_back

        for frame, line in frame_rows:
            handle = self._handle_frame(native_id, frame)
            stack.append(
                {
                    "id": handle,
                    "name": self._format_stack_frame_name(
                        frame,
                        format_options,
                        line,
                    ),
                    "line": line,
                    "column": 1,
                    "source": {
                        "name": os.path.basename(frame.f_code.co_filename),
                        "path": os.path.realpath(frame.f_code.co_filename),
                    },
                }
            )
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

    def _handle_value(
        self,
        native_id: int,
        value: Any,
        frame: Optional[types.FrameType] = None,
        kind: str = "value",
        parent_reference: int = 0,
        name: Optional[str] = None,
        evaluate_name: Optional[str] = None,
    ) -> int:
        if (
            kind not in ("locals", "globals")
            and not kind.startswith("lazy_")
            and not self._expandable(value)
        ):
            return 0
        frame_identity = id(frame) if frame is not None else 0
        value_identity = (
            frame_identity
            if kind in ("locals", "globals") and frame is not None
            else id(value)
        )
        key = (
            native_id,
            value_identity,
            frame_identity,
            kind,
            parent_reference,
            name,
            evaluate_name,
        )
        with self.condition:
            existing = self.value_handles.get(key)
            if existing is not None:
                return existing
            if len(self.frames) + len(self.values) >= _MAX_HANDLES_PER_STOP:
                return 0
            handle = self.next_handle
            self.next_handle += 1
            self.values[handle] = ValueHandle(
                native_id,
                value,
                frame,
                kind,
                parent_reference,
                name,
                evaluate_name,
            )
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
                if entry.native_thread_id != native_id
            }
            self.value_handles = {
                key: handle
                for key, handle in self.value_handles.items()
                if key[0] != native_id
            }

    @staticmethod
    def _expandable(value: Any) -> bool:
        if _type_identity_in(
            type(value),
            (dict, list, tuple, set, frozenset),
        ):
            return True
        return _safe_instance_dict(value) is not None or bool(
            _lazy_member_specs(value)
        )

    @staticmethod
    def _child_counts(value: Any) -> Tuple[int, int]:
        if type(value) is dict:
            return len(value), 0
        if _type_identity_in(
            type(value),
            (list, tuple, set, frozenset),
        ):
            return 0, len(value)
        instance_dict = _safe_instance_dict(value)
        stored_count = len(instance_dict) if instance_dict is not None else 0
        return stored_count + len(_lazy_member_specs(value)), 0

    @staticmethod
    def _bounded_evaluate_name(expression: Optional[str]) -> Optional[str]:
        if (
            type(expression) is str
            and expression
            and len(expression) <= _MAX_EXPRESSION_CHARS
        ):
            return expression
        return None

    @classmethod
    def _root_evaluate_name(cls, name: Any) -> Optional[str]:
        if (
            type(name) is str
            and len(name) <= _MAX_EXPRESSION_CHARS
            and name.isidentifier()
            and not keyword.iskeyword(name)
        ):
            return name
        return None

    @classmethod
    def _evaluated_expression_name(cls, expression: str) -> Optional[str]:
        stripped = expression.strip()
        if cls._root_evaluate_name(stripped) is not None:
            return stripped
        candidate = cls._bounded_evaluate_name("({}\n)".format(stripped))
        if candidate is None:
            return None
        try:
            compile(candidate, "<debugger evaluateName>", "eval", dont_inherit=True)
        except BaseException:
            return None
        return candidate

    @classmethod
    def _dict_evaluate_name(
        cls,
        parent: Optional[str],
        key: Any,
    ) -> Optional[str]:
        if parent is None or type(key) is not str:
            return None
        if (
            len(key) > _MAX_EVALUATE_NAME_KEY_CHARS
            or len(parent) + len(key) + 4 > _MAX_EXPRESSION_CHARS
        ):
            return None
        return cls._bounded_evaluate_name("{}[{}]".format(parent, repr(key)))

    @classmethod
    def _index_evaluate_name(
        cls,
        parent: Optional[str],
        index: int,
    ) -> Optional[str]:
        if parent is None:
            return None
        return cls._bounded_evaluate_name("{}[{}]".format(parent, index))

    @classmethod
    def _attribute_evaluate_name(
        cls,
        parent: Optional[str],
        name: Any,
    ) -> Optional[str]:
        if parent is None or cls._root_evaluate_name(name) is None:
            return None
        return cls._bounded_evaluate_name("{}.{}".format(parent, name))

    @classmethod
    def _call_evaluate_name(
        cls,
        function_name: str,
        parent: Optional[str],
    ) -> Optional[str]:
        if parent is None:
            return None
        return cls._bounded_evaluate_name(
            "{}({})".format(function_name, parent)
        )

    @staticmethod
    def _uses_standard_attribute_lookup(value: Any) -> bool:
        owner, _descriptor = _resolve_type_member(
            type(value),
            "__getattribute__",
        )
        return owner is object

    @classmethod
    def _global_root_evaluate_name(
        cls,
        frame: Optional[types.FrameType],
        globals_value: Any,
        name: Any,
    ) -> Optional[str]:
        evaluate_name = cls._root_evaluate_name(name)
        if evaluate_name is None or frame is None:
            return evaluate_name
        try:
            frame_locals = frame.f_locals
            if frame_locals is globals_value:
                return evaluate_name
            for local_name in frame_locals:
                if type(local_name) is str and local_name == name:
                    return None
        except BaseException:
            return None
        return evaluate_name

    def _scopes(self, request: Dict[str, Any], args: Dict[str, Any]) -> None:
        with self.condition:
            entry = self.frames.get(int(args.get("frameId", 0)))
            context = self.stops.get(entry[0]) if entry is not None else None
            active = context is not None and context.paused
            request_scope = (
                context.exception_info.request_scope
                if context is not None
                and context.exception_info is not None
                else None
            )
        if not active or entry is None:
            self._response(request, success=False, message="Unknown or expired frame")
            return
        frame = entry[1]
        native_id = entry[0]
        frame_locals = frame.f_locals
        frame_globals = frame.f_globals
        locals_ref = self._handle_value(native_id, frame_locals, frame, "locals")
        globals_ref = self._handle_value(native_id, frame_globals, frame, "globals")
        scopes = [
            {
                "name": "Locals",
                "presentationHint": "locals",
                "variablesReference": locals_ref,
                "namedVariables": len(frame_locals),
                "expensive": False,
            }
        ]
        if request_scope is not None:
            request_ref = self._handle_value(
                native_id,
                request_scope,
                frame,
                "django_request",
            )
            scopes.append(
                {
                    "name": "Django Request",
                    "variablesReference": request_ref,
                    "namedVariables": len(request_scope),
                    "expensive": False,
                }
            )
        scopes.append(
            {
                "name": "Globals",
                "variablesReference": globals_ref,
                "namedVariables": len(frame_globals),
                "expensive": True,
            }
        )
        self._response(
            request,
            {"scopes": scopes},
        )

    @classmethod
    def _safe_repr(cls, value: Any, depth: int = 0, seen: Optional[Set[int]] = None) -> str:
        """Render values without invoking application-defined ``__repr__``."""
        try:
            return cls._safe_repr_impl(value, depth, seen)
        except BaseException as exc:
            return "<preview unavailable: {}>".format(_type_name(exc))

    @classmethod
    def _safe_repr_impl(
        cls,
        value: Any,
        depth: int = 0,
        seen: Optional[Set[int]] = None,
    ) -> str:
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
        elif value_type is int:
            try:
                result = (
                    cls._bounded_hex(value, 500)
                    if int.bit_length(value) > _MAX_SAFE_DECIMAL_INT_BITS
                    else repr(value)
                )
            except BaseException as exc:
                result = "<repr failed: {}>".format(_type_name(exc))
        elif _type_identity_in(
            value_type,
            (type(None), bool, float, complex),
        ):
            try:
                result = repr(value)
            except BaseException as exc:
                result = "<repr failed: {}>".format(_type_name(exc))
        elif id(value) in seen:
            result = "<recursive>"
        elif depth >= 2 and _type_identity_in(
            value_type,
            (dict, list, tuple, set, frozenset),
        ):
            result = "<{} len={}>".format(_type_name(value), len(value))
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
        elif _type_identity_in(
            value_type,
            (list, tuple, set, frozenset),
        ):
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
            type_name = _type_name(value)
            instance_dict = _safe_instance_dict(value)
            if instance_dict:
                if depth >= 2:
                    result = "<{} fields={}>".format(type_name, len(instance_dict))
                else:
                    seen.add(id(value))
                    fields = []
                    for index, (key, item) in enumerate(instance_dict.items()):
                        if index >= 5:
                            fields.append("...")
                            break
                        field_name = (
                            key
                            if type(key) is str
                            else "[{}]".format(cls._safe_repr(key, depth + 1, seen))
                        )
                        fields.append(
                            "{}={}".format(
                                field_name,
                                cls._safe_repr(item, depth + 1, seen),
                            )
                        )
                    seen.discard(id(value))
                    result = "<{} {}>".format(type_name, ", ".join(fields))
            elif value_type is types.FunctionType:
                qualname = _stored_text(
                    object.__getattribute__(value, "__qualname__"),
                    "<anonymous>",
                )
                result = "<function {}>".format(
                    qualname
                )
            elif value_type is types.MethodType:
                method = object.__getattribute__(value, "__func__")
                qualname = _stored_text(
                    object.__getattribute__(method, "__qualname__"),
                    "<anonymous>",
                )
                result = "<bound method {}>".format(
                    qualname
                )
            elif value_type is types.ModuleType:
                module_name = _stored_text(
                    object.__getattribute__(value, "__name__"),
                    "<anonymous>",
                )
                result = "<module {}>".format(
                    module_name
                )
            else:
                result = "<{}>".format(type_name)
        return result if len(result) <= 500 else result[:497] + "..."

    @classmethod
    def _bounded_hex(cls, value: int, limit: int) -> str:
        negative = value < 0
        magnitude = -value if negative else value
        digits = max(1, (int.bit_length(magnitude) + 3) // 4)
        sign = "-" if negative else ""
        if len(sign) + 2 + digits <= limit:
            return hex(value)

        suffix = "...<truncated>"
        prefix_digits = max(1, limit - len(sign) - 2 - len(suffix))
        shift = max(0, (digits - prefix_digits) * 4)
        leading = magnitude >> shift
        result = "{}0x{}{}".format(sign, format(leading, "x"), suffix)
        return result[:limit]

    @classmethod
    def _format_value(
        cls,
        value: Any,
        format_options: Any = None,
        clipboard: bool = False,
    ) -> str:
        if (
            type(value) is int
            and type(format_options) is dict
            and format_options.get("hex") is True
        ):
            return cls._bounded_hex(
                value,
                _MAX_CLIPBOARD_VALUE_CHARS if clipboard else 500,
            )
        if clipboard and _type_identity_in(type(value), (str, bytes)):
            clipped = value[:_MAX_CLIPBOARD_VALUE_CHARS]
            rendered = repr(clipped)
            truncated = len(value) > len(clipped)
            suffix = "...<truncated>"
            if len(rendered) > _MAX_CLIPBOARD_VALUE_CHARS:
                rendered = rendered[
                    : _MAX_CLIPBOARD_VALUE_CHARS - len(suffix)
                ]
                truncated = True
            return rendered + suffix if truncated else rendered
        return cls._safe_repr(value)

    def _variable(
        self,
        native_id: int,
        name: str,
        value: Any,
        frame: Optional[types.FrameType],
        parent_reference: int,
        read_only: bool = False,
        evaluate_name: Optional[str] = None,
        format_options: Any = None,
        presentation_hint: Optional[Dict[str, Any]] = None,
        value_preview: Optional[str] = None,
    ) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "name": name,
            "value": (
                value_preview
                if value_preview is not None
                else self._format_value(value, format_options)
            ),
            "variablesReference": self._handle_value(
                native_id,
                value,
                frame,
                parent_reference=parent_reference,
                name=name,
                evaluate_name=evaluate_name,
            ),
        }
        if evaluate_name is not None:
            result["evaluateName"] = evaluate_name
        if self.client_supports_variable_type:
            result["type"] = _type_name(value)
        if presentation_hint is not None:
            result["presentationHint"] = dict(presentation_hint)
        elif read_only:
            result["presentationHint"] = {"attributes": ["readOnly"]}
        named, indexed = self._child_counts(value)
        if named:
            result["namedVariables"] = named
        if indexed:
            result["indexedVariables"] = indexed
        return result

    @classmethod
    def _lazy_evaluate_name(
        cls,
        parent: Optional[str],
        spec: LazyMemberSpec,
    ) -> Optional[str]:
        if spec.kind == "lazy_repr":
            return cls._call_evaluate_name("repr", parent)
        if spec.kind == "lazy_str":
            return cls._call_evaluate_name("str", parent)
        if spec.kind == "lazy_len":
            return cls._call_evaluate_name("len", parent)
        return cls._attribute_evaluate_name(parent, spec.name)

    @staticmethod
    def _lazy_presentation_hint(kind: str, lazy: bool) -> Dict[str, Any]:
        hint: Dict[str, Any] = {
            "kind": "method" if kind in (
                "lazy_repr",
                "lazy_str",
                "lazy_len",
            ) else "property",
            "attributes": ["readOnly", "hasSideEffects"],
        }
        if lazy:
            hint["lazy"] = True
        return hint

    def _lazy_variable(
        self,
        native_id: int,
        target: Any,
        frame: Optional[types.FrameType],
        parent_reference: int,
        parent_evaluate_name: Optional[str],
        spec: LazyMemberSpec,
    ) -> Optional[Dict[str, Any]]:
        evaluate_name = self._lazy_evaluate_name(parent_evaluate_name, spec)
        if (
            spec.kind in (
                "lazy_property",
                "lazy_cached_property",
                "lazy_slot",
            )
            and not self._uses_standard_attribute_lookup(target)
        ):
            evaluate_name = None
        reference = self._handle_value(
            native_id,
            target,
            frame,
            kind=spec.kind,
            parent_reference=parent_reference,
            name=spec.name,
            evaluate_name=evaluate_name,
        )
        # A lazy row without a reference violates the DAP contract because the
        # client would have no way to request its real value. Keep the paging
        # position visible, but remove the lazy hint when the stop handle limit
        # has already been reached.
        if reference == 0:
            row: Dict[str, Any] = {
                "name": spec.name,
                "value": "<debugger handle limit reached>",
                "variablesReference": 0,
                "presentationHint": self._lazy_presentation_hint(
                    spec.kind,
                    False,
                ),
            }
            if evaluate_name is not None:
                row["evaluateName"] = evaluate_name
            return row
        row: Dict[str, Any] = {
            "name": spec.name,
            "value": "<not evaluated>",
            "variablesReference": reference,
            "presentationHint": self._lazy_presentation_hint(spec.kind, True),
        }
        if evaluate_name is not None:
            row["evaluateName"] = evaluate_name
        if self.client_supports_variable_type:
            if spec.kind in ("lazy_repr", "lazy_str"):
                row["type"] = "str"
            elif spec.kind == "lazy_len":
                row["type"] = "int"
        return row

    @staticmethod
    def _evaluate_lazy_member(entry: ValueHandle) -> Any:
        target = entry.value
        if entry.kind == "lazy_repr":
            return str.__str__(repr(target))
        if entry.kind == "lazy_str":
            return str.__str__(str(target))
        if entry.kind == "lazy_len":
            return len(target)

        _owner, descriptor = _resolve_type_member(type(target), entry.name or "")
        descriptor_type = type(descriptor)
        if entry.kind == "lazy_property" and descriptor_type is property:
            return property.__get__(descriptor, target, type(target))
        if (
            entry.kind == "lazy_cached_property"
            and descriptor_type is functools.cached_property
        ):
            return functools.cached_property.__get__(
                descriptor,
                target,
                type(target),
            )
        if entry.kind == "lazy_slot" and _type_identity_in(
            descriptor_type,
            (types.MemberDescriptorType, types.GetSetDescriptorType),
        ):
            return descriptor.__get__(target, type(target))
        raise AttributeError("The lazy member is no longer available")

    def _lazy_variables(
        self,
        request: Dict[str, Any],
        args: Dict[str, Any],
        reference: int,
        entry: ValueHandle,
    ) -> None:
        completed, value, error = self._run_on_stopped_thread(
            entry.native_thread_id,
            lambda: self._evaluate_lazy_member(entry),
        )
        if not completed:
            self._response(
                request,
                success=False,
                message="The selected thread resumed",
            )
            return

        name = entry.name or "value"
        hint = self._lazy_presentation_hint(entry.kind, False)
        # A repeated lazy request replaces its prior result. Expire that result
        # and every descendant before allocating a new handle so refresh/auto-
        # expand cannot accumulate stale object graphs within one stop.
        self._invalidate_replaced_value_handles(
            entry.native_thread_id,
            reference,
            name,
        )
        if error is not None:
            row: Dict[str, Any] = {
                "name": name,
                "value": "<evaluation raised {}>".format(_type_name(error)),
                "variablesReference": 0,
                "presentationHint": hint,
            }
            if entry.evaluate_name is not None:
                row["evaluateName"] = entry.evaluate_name
            if self.client_supports_variable_type:
                row["type"] = _type_name(error)
        elif entry.kind in ("lazy_repr", "lazy_str"):
            row = {
                "name": name,
                "value": self._escape_log_text(value),
                "variablesReference": 0,
                "presentationHint": hint,
            }
            if entry.evaluate_name is not None:
                row["evaluateName"] = entry.evaluate_name
            if self.client_supports_variable_type:
                row["type"] = "str"
        else:
            row = self._variable(
                entry.native_thread_id,
                name,
                value,
                entry.frame,
                reference,
                read_only=True,
                evaluate_name=entry.evaluate_name,
                format_options=args.get("format"),
                presentation_hint=hint,
            )
        # VS Code replaces a lazy row only when this response contains exactly
        # one Variable. The returned hint intentionally omits ``lazy``.
        self._response(request, {"variables": [row]})

    def _variables(self, request: Dict[str, Any], args: Dict[str, Any]) -> None:
        try:
            reference = int(args.get("variablesReference", 0))
        except (TypeError, ValueError):
            reference = 0
        with self.condition:
            entry = self.values.get(reference)
            active = entry is not None and entry.native_thread_id in self.stops
        if not active or entry is None:
            self._response(request, success=False, message="Unknown or expired variablesReference")
            return
        if entry.kind.startswith("lazy_"):
            self._lazy_variables(request, args, reference, entry)
            return
        native_id = entry.native_thread_id
        frame = entry.frame
        value = (
            frame.f_locals
            if entry.kind == "locals" and frame is not None
            else entry.value
        )
        start = max(0, int(args.get("start", 0)))
        requested_count = int(args.get("count", 0))
        if entry.kind in ("locals", "globals"):
            try:
                _named_count, indexed_count = len(value), 0
            except BaseException:
                _named_count, indexed_count = 0, 0
        else:
            _named_count, indexed_count = self._child_counts(value)
        total_count = _named_count or indexed_count
        remaining = max(0, total_count - start)
        count = min(requested_count, remaining) if requested_count > 0 else remaining
        format_options = args.get("format")
        rows = []
        if entry.kind in ("locals", "globals") or type(value) is dict:
            shadowed_globals = set()
            global_names_ambiguous = False
            if entry.kind == "globals" and frame is not None:
                try:
                    frame_locals = frame.f_locals
                    if frame_locals is not value:
                        shadowed_globals = {
                            key
                            for key in frame_locals
                            if type(key) is str
                        }
                except BaseException:
                    # If the selected runtime cannot expose locals safely, do
                    # not claim that a global name is evaluatable unambiguously.
                    global_names_ambiguous = True
            try:
                items = itertools.islice(value.items(), start, start + count)
                for key, item in items:
                    name = key if type(key) is str else self._safe_repr(key)
                    evaluate_name = (
                        self._root_evaluate_name(key)
                        if entry.kind in ("locals", "globals")
                        else self._dict_evaluate_name(entry.evaluate_name, key)
                    )
                    if entry.kind == "globals" and (
                        global_names_ambiguous
                        or (
                            type(key) is str
                            and key in shadowed_globals
                        )
                    ):
                        evaluate_name = None
                    rows.append(
                        self._variable(
                            native_id,
                            name,
                            item,
                            frame,
                            reference,
                            read_only=type(key) is not str,
                            evaluate_name=evaluate_name,
                            format_options=format_options,
                            value_preview=(
                                "<{}>".format(_type_name(item))
                                if entry.kind == "django_request"
                                and type(key) is str
                                and key == "request"
                                else None
                            ),
                        )
                    )
            except BaseException:
                rows = []
        elif _type_identity_in(type(value), (list, tuple)):
            items = itertools.islice(enumerate(value), start, start + count)
            rows = [
                self._variable(
                    native_id,
                    str(index),
                    item,
                    frame,
                    reference,
                    read_only=type(value) is tuple,
                    evaluate_name=self._index_evaluate_name(
                        entry.evaluate_name,
                        index,
                    ),
                    format_options=format_options,
                )
                for index, item in items
            ]
        elif _type_identity_in(type(value), (set, frozenset)):
            items = itertools.islice(enumerate(value), start, start + count)
            rows = [
                self._variable(
                    native_id,
                    str(index),
                    item,
                    frame,
                    reference,
                    read_only=True,
                    format_options=format_options,
                )
                for index, item in items
            ]
        else:
            instance_dict = _safe_instance_dict(value)
            stored_count = len(instance_dict) if instance_dict is not None else 0
            lazy_specs = _lazy_member_specs(value)
            standard_attribute_lookup = self._uses_standard_attribute_lookup(
                value
            )
            if instance_dict is not None and start < stored_count:
                stored_end = min(stored_count, start + count)
                try:
                    items = itertools.islice(
                        instance_dict.items(),
                        start,
                        stored_end,
                    )
                    for key, item in items:
                        evaluate_name = self._attribute_evaluate_name(
                            entry.evaluate_name,
                            key,
                        )
                        if not standard_attribute_lookup:
                            evaluate_name = None
                        # A raw instance field shadowed by a class member is not
                        # guaranteed to match normal Python attribute lookup.
                        if (
                            evaluate_name is not None
                            and _resolve_type_member(type(value), key)[0]
                            is not None
                        ):
                            evaluate_name = None
                        rows.append(
                            self._variable(
                                native_id,
                                key
                                if type(key) is str
                                else self._safe_repr(key),
                                item,
                                frame,
                                reference,
                                read_only=type(key) is not str,
                                evaluate_name=evaluate_name,
                                format_options=format_options,
                            )
                        )
                except BaseException:
                    rows = []

            lazy_start = max(0, start - stored_count)
            lazy_end = min(
                len(lazy_specs),
                max(0, start + count - stored_count),
            )
            for spec in lazy_specs[lazy_start:lazy_end]:
                lazy_row = self._lazy_variable(
                    native_id,
                    value,
                    frame,
                    reference,
                    entry.evaluate_name,
                    spec,
                )
                if lazy_row is not None:
                    rows.append(lazy_row)
        self._response(request, {"variables": rows})

    def _evaluation_frame(
        self,
        frame_id: Any,
    ) -> Optional[Tuple[int, types.FrameType, bool]]:
        with self.condition:
            if frame_id not in (None, 0):
                try:
                    entry = self.frames.get(int(frame_id))
                except (TypeError, ValueError):
                    return None
                if entry is None or entry[0] not in self.stops:
                    return None
                return entry[0], entry[1], True
            if len(self.stops) != 1:
                return None
            context = next(iter(self.stops.values()))
            return context.native_thread_id, context.frame, False

    @staticmethod
    def _compile_expression(expression: str, label: str) -> types.CodeType:
        if len(expression) > _MAX_EXPRESSION_CHARS:
            raise ValueError("expression is too long")
        return compile(expression, label, "eval", dont_inherit=True)

    @staticmethod
    def _evaluate_code(
        code: types.CodeType,
        frame: types.FrameType,
        include_locals: bool = True,
    ) -> Any:
        # Keep assignment expressions from mutating CPython's version-specific
        # f_locals snapshot. A single merged namespace also lets nested scopes
        # in comprehensions and lambdas resolve the selected frame's locals;
        # Python otherwise resolves those names only through eval's globals.
        globals_namespace = dict(frame.f_globals)
        if include_locals:
            locals_namespace = dict(frame.f_locals)
            globals_namespace.update(locals_namespace)
        else:
            locals_namespace = globals_namespace
        # Calls and mutations performed by the expression still have normal
        # Python side effects and are documented as such.
        return eval(code, globals_namespace, locals_namespace)

    def _value_body(
        self,
        native_id: int,
        value: Any,
        frame: types.FrameType,
        result_key: str,
        parent_reference: int = 0,
        name: Optional[str] = None,
        evaluate_name: Optional[str] = None,
        format_options: Any = None,
        clipboard: bool = False,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            result_key: self._format_value(
                value,
                format_options,
                clipboard,
            ),
            "variablesReference": self._handle_value(
                native_id,
                value,
                frame,
                parent_reference=parent_reference,
                name=name,
                evaluate_name=evaluate_name,
            ),
        }
        if self.client_supports_variable_type:
            body["type"] = _type_name(value)
        named, indexed = self._child_counts(value)
        if named:
            body["namedVariables"] = named
        if indexed:
            body["indexedVariables"] = indexed
        return body

    def _evaluate(self, request: Dict[str, Any], args: Dict[str, Any]) -> None:
        expression = args.get("expression")
        if not isinstance(expression, str) or not expression.strip():
            self._response(
                request,
                success=False,
                message="Evaluate requires a non-empty Python expression",
            )
            return
        frame_entry = self._evaluation_frame(args.get("frameId"))
        if frame_entry is None:
            self._response(request, success=False, message="Unknown or expired frame")
            return
        native_id, frame, include_locals = frame_entry
        try:
            code = self._compile_expression(expression, "<debugger expression>")
        except BaseException as exc:
            self._response(
                request,
                success=False,
                message="Expression compilation raised {}".format(_type_name(exc)),
            )
            return
        completed, value, error = self._run_on_stopped_thread(
            native_id,
            lambda: self._evaluate_code(code, frame, include_locals),
        )
        if not completed:
            self._response(request, success=False, message="The selected thread resumed")
            return
        if error is not None:
            self._response(
                request,
                success=False,
                message="Expression evaluation raised {}".format(_type_name(error)),
            )
            return
        self._response(
            request,
            self._value_body(
                native_id,
                value,
                frame,
                "result",
                evaluate_name=self._evaluated_expression_name(expression),
                format_options=args.get("format"),
                clipboard=args.get("context") == "clipboard",
            ),
        )

    @staticmethod
    def _sync_frame_local(frame: types.FrameType, name: str, value: Any) -> None:
        local_values = frame.f_locals
        if name not in local_values:
            raise SetVariableError("Only existing local variables can be changed")
        optimized = bool(frame.f_code.co_flags & _CO_OPTIMIZED)
        if optimized:
            slot_names = (
                frame.f_code.co_varnames
                + frame.f_code.co_cellvars
                + frame.f_code.co_freevars
            )
            if name not in slot_names:
                raise SetVariableError("Only existing local variables can be changed")
            if getattr(sys.implementation, "name", "") != "cpython":
                raise SetVariableError(
                    "This Python runtime cannot update the selected optimized local"
                )
            if _LOCALS_TO_FAST is None and type(local_values) is dict:
                raise SetVariableError(
                    "This Python runtime cannot update the selected optimized local"
                )
        local_values[name] = value

        if optimized and _LOCALS_TO_FAST is not None:
            # This must immediately follow the f_locals write. Reading
            # frame.f_locals first refreshes the snapshot and loses the change
            # on CPython 3.8-3.12.
            _LOCALS_TO_FAST(frame, 0)

        refreshed = frame.f_locals
        if name not in refreshed or refreshed[name] is not value:
            raise SetVariableError(
                "This Python runtime cannot update the selected optimized local"
            )

    @staticmethod
    def _resolve_dict_key(value: dict, name: str) -> str:
        string_matches = [key for key in value if type(key) is str and key == name]
        if len(string_matches) == 1:
            return string_matches[0]
        raise SetVariableError(
            "Only existing dictionary entries with string keys can be changed"
        )

    def _assign_value(self, entry: ValueHandle, name: str, value: Any) -> None:
        target = entry.value
        frame = entry.frame
        if entry.kind.startswith("lazy_"):
            raise SetVariableError("Lazy values are read-only")
        if entry.kind == "locals":
            if frame is None:
                raise SetVariableError("The local scope frame has expired")
            self._sync_frame_local(frame, name, value)
            return
        if entry.kind == "globals":
            if type(target) is not dict:
                raise SetVariableError("Only existing global variables can be changed")
            key = self._resolve_dict_key(target, name)
            target[key] = value
            return
        if type(target) is dict:
            key = self._resolve_dict_key(target, name)
            target[key] = value
            return
        if type(target) is list:
            try:
                index = int(name)
            except (TypeError, ValueError):
                raise SetVariableError("List variables must use a numeric index")
            if str(index) != name or index < 0 or index >= len(target):
                raise SetVariableError("The selected list index no longer exists")
            target[index] = value
            return
        if _type_identity_in(type(target), (tuple, set, frozenset)):
            raise SetVariableError("The selected container is read-only")
        instance_dict = _safe_instance_dict(target)
        if instance_dict is None:
            raise SetVariableError("Only existing instance attributes can be changed")
        key = self._resolve_dict_key(instance_dict, name)
        instance_dict[key] = value
        return

    def _invalidate_replaced_value_handles(
        self,
        native_id: int,
        parent_reference: int,
        name: str,
    ) -> None:
        with self.condition:
            removed = {
                handle
                for handle, candidate in self.values.items()
                if candidate.native_thread_id == native_id
                and candidate.parent_reference == parent_reference
                and candidate.name == name
            }
            # Handles are a bounded graph, so descendant invalidation is
            # proportional to debugger state rather than application object
            # size. This also handles recursive/aliased containers safely.
            children = {}  # type: Dict[int, list]
            for handle, candidate in self.values.items():
                if candidate.native_thread_id == native_id:
                    children.setdefault(candidate.parent_reference, []).append(handle)
            pending = list(removed)
            while pending:
                parent = pending.pop()
                for handle in children.get(parent, ()):
                    if handle not in removed:
                        removed.add(handle)
                        pending.append(handle)
            if not removed:
                return
            self.values = {
                handle: candidate
                for handle, candidate in self.values.items()
                if handle not in removed
            }
            self.value_handles = {
                key: handle
                for key, handle in self.value_handles.items()
                if handle not in removed
            }

    def _set_variable(self, request: Dict[str, Any], args: Dict[str, Any]) -> None:
        name = args.get("name")
        expression = args.get("value")
        if not isinstance(name, str) or not name:
            self._response(request, success=False, message="Set Variable requires a name")
            return
        if not isinstance(expression, str) or not expression.strip():
            self._response(
                request,
                success=False,
                message="Set Variable requires a non-empty Python expression",
            )
            return
        try:
            reference = int(args.get("variablesReference", 0))
        except (TypeError, ValueError):
            reference = 0
        with self.condition:
            entry = self.values.get(reference)
            context = (
                self.stops.get(entry.native_thread_id)
                if entry is not None
                else None
            )
            active = context is not None and context.paused
            post_mortem = (
                active
                and context is not None
                and context.exception_info is not None
                and context.exception_info.break_mode
                in ("unhandled", "userUnhandled")
            )
        if not active or entry is None or entry.frame is None:
            self._response(
                request,
                success=False,
                message="Unknown or expired variablesReference",
            )
            return
        if post_mortem:
            self._response(
                request,
                success=False,
                message=(
                    "Variables cannot be changed in a historical exception stop"
                ),
            )
            return
        if entry.kind.startswith("lazy_"):
            self._response(
                request,
                success=False,
                message="Lazy values are read-only",
            )
            return
        try:
            code = self._compile_expression(expression, "<set variable expression>")
        except BaseException as exc:
            self._response(
                request,
                success=False,
                message="New value expression compilation raised {}".format(
                    _type_name(exc)
                ),
            )
            return

        def assign() -> Any:
            new_value = self._evaluate_code(code, entry.frame)
            self._assign_value(entry, name, new_value)
            return new_value

        completed, new_value, error = self._run_on_stopped_thread(
            entry.native_thread_id,
            assign,
        )
        if not completed:
            self._response(
                request,
                success=False,
                message="The selected thread resumed",
            )
            return
        if type(error) is SetVariableError:
            self._response(
                request,
                success=False,
                message=(
                    error.args[0]
                    if error.args
                    else "Variable cannot be changed"
                ),
            )
            return
        if error is not None:
            self._response(
                request,
                success=False,
                message="New value expression or assignment raised {}".format(
                    _type_name(error)
                ),
            )
            return
        self._invalidate_replaced_value_handles(
            entry.native_thread_id,
            reference,
            name,
        )
        if entry.kind == "locals":
            evaluate_name = self._root_evaluate_name(name)
        elif entry.kind == "globals":
            evaluate_name = self._global_root_evaluate_name(
                entry.frame,
                entry.value,
                name,
            )
        elif type(entry.value) is dict:
            evaluate_name = self._dict_evaluate_name(
                entry.evaluate_name,
                name,
            )
        elif type(entry.value) is list:
            try:
                evaluate_name = self._index_evaluate_name(
                    entry.evaluate_name,
                    int(name),
                )
            except (TypeError, ValueError):
                evaluate_name = None
        else:
            evaluate_name = self._attribute_evaluate_name(
                entry.evaluate_name,
                name,
            )
            if evaluate_name is not None and (
                not self._uses_standard_attribute_lookup(entry.value)
                or _resolve_type_member(type(entry.value), name)[0]
                is not None
            ):
                evaluate_name = None
        self._response(
            request,
            self._value_body(
                entry.native_thread_id,
                new_value,
                entry.frame,
                "value",
                parent_reference=reference,
                name=name,
                evaluate_name=evaluate_name,
                format_options=args.get("format"),
            ),
        )

    def _resume(self, request: Dict[str, Any], args: Dict[str, Any], command: str) -> None:
        dap_id = int(args.get("threadId", 0))
        with self.condition:
            native_id = self.dap_to_native.get(dap_id)
            context = self.stops.get(native_id) if native_id is not None else None
            if context is None:
                self._response(request, success=False, message="Thread is not stopped")
                return
            if (
                command != "continue"
                and context.exception_info is not None
                and context.exception_info.break_mode
                in ("unhandled", "userUnhandled")
            ):
                self._response(
                    request,
                    success=False,
                    message=(
                        "Cannot step from a historical exception stop; "
                        "continue the thread instead"
                    ),
                )
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
                    if entry.native_thread_id != native_id
                }
                self.value_handles = {
                    key: handle
                    for key, handle in self.value_handles.items()
                    if key[0] != native_id
                }
                resumed.paused = False
                self._cancel_pending_operation_locked(resumed)

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
            with self.breakpoint_lock:
                self.breakpoints = {}
                self.call_breakpoint_locations.clear()
                self.breakpoint_hit_counts.clear()
            self.exception_filters.clear()
            self.exception_generation += 1
            self.last_exception_stops.clear()
            self._restore_uncaught_exception_hooks()
            self._restore_django_exception_signal()
            with self.log_drop_lock:
                self.dropped_log_events = 0
                self.dropped_log_summaries.clear()
            self.steps.clear()
            self.pause_requests.clear()
            for context in self.stops.values():
                context.paused = False
                self._cancel_pending_operation_locked(context)
            self.stops.clear()
            self.frames.clear()
            self.values.clear()
            self.value_handles.clear()
            self.native_to_dap.clear()
            self.dap_to_native.clear()
            self.native_threads = weakref.WeakValueDictionary()
            self.next_thread_id = 1
            self.next_breakpoint_id = 1
            self.client_supports_variable_type = False
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
            with self.breakpoint_lock:
                self.breakpoints = {}
                self.call_breakpoint_locations.clear()
                self.breakpoint_hit_counts.clear()
            self.exception_filters.clear()
            self.exception_generation += 1
            self.last_exception_stops.clear()
            self._restore_uncaught_exception_hooks()
            self._restore_django_exception_signal()
            for context in self.stops.values():
                context.paused = False
                self._cancel_pending_operation_locked(context)
            self.condition.notify_all()
        try:
            self.log_queue.put_nowait(_LOG_QUEUE_STOP)
        except queue.Full:
            try:
                self.log_queue.get_nowait()
                self.log_queue.put_nowait(_LOG_QUEUE_STOP)
            except (queue.Empty, queue.Full):
                pass
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

        self._restore_uncaught_exception_hooks()
        # Never call Django Signal.disconnect() after fork. Its inherited
        # lock may have been held by a vanished parent thread. The receiver's
        # first PID check makes the inherited registration inert instead.
        self.django_exception_signal = None
        self.django_exception_receiver = None
        self.django_exception_dispatch_uid = None
        self.django_response_for_exception_code = None

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
        self.call_breakpoint_locations = {}
        self.breakpoint_hit_counts = {}
        self.exception_filters = set()
        self.exception_generation = 0
        self.last_exception_stops = {}
        self.steps = {}
        self.pause_requests = set()
        self.stops = {}
        self.pending_attach = None
        self.native_to_dap = {}
        self.dap_to_native = {}
        self.native_threads = weakref.WeakValueDictionary()
        self.next_thread_id = 1
        self.next_breakpoint_id = 1
        self.next_handle = 1
        self.frames = {}
        self.values = {}
        self.value_handles = {}
        self.normalized_paths = {}
        self.control_ident = None
        self.log_output_ident = None
        self.log_output_thread = None
        self.log_queue = queue.Queue(maxsize=_MAX_PENDING_LOG_EVENTS)
        self.log_drop_lock = threading.Lock()
        self.dropped_log_events = 0
        self.dropped_log_summaries = {}
        self.sequence = 1
        self.disconnect_requested = False
        self.client_supports_variable_type = False

        # Never reuse synchronization primitives that may have been owned by a
        # thread which no longer exists in the child.
        self.condition = threading.Condition(threading.RLock())
        self.breakpoint_lock = threading.RLock()
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
