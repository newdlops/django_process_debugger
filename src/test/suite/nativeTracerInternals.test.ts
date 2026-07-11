import * as assert from 'assert';
import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { describe, it } from 'mocha';
import { findSystemPython, projectRoot } from './testHelpers';

const execFileAsync = promisify(execFile);

function cleanPythonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT_MANAGER_HOOK: '0',
    PORT_MANAGER_HOOK_DISABLED: '1',
  };
  delete env.DYLD_INSERT_LIBRARIES;
  delete env.LD_PRELOAD;
  return env;
}

describe('Feature: experimental tracer safety boundaries', function () {
  it('previews stored object fields without invoking application hooks', async function () {
    const python = await findSystemPython();
    if (!python) {
      this.skip();
      return;
    }

    const script = String.raw`
import functools
import sys
sys.path.insert(0, sys.argv[1])
from django_process_debugger_tracer import (
    NativeDapTracer,
    SetVariableError,
    ValueHandle,
    _MAX_LAZY_MEMBERS,
    _MAX_LAZY_MEMBER_SCAN,
    _lazy_member_specs,
)

calls = []

class Child:
    def __init__(self):
        self.count = 3

    def __repr__(self):
        calls.append("child repr")
        raise AssertionError("child repr ran")

class Preview:
    def __init__(self):
        self.state = "ready"
        self.child = Child()
        self.loop = self
        for index in range(8):
            setattr(self, "field_{}".format(index), index)

    def __repr__(self):
        calls.append("repr")
        raise AssertionError("repr ran")

    def __str__(self):
        calls.append("str")
        raise AssertionError("str ran")

    @property
    def computed(self):
        calls.append("property")
        raise AssertionError("property ran")

class DictTrap:
    dict_calls = 0

    @property
    def __dict__(self):
        type(self).dict_calls += 1
        raise AssertionError("custom __dict__ ran")

class MetaTrap(type):
    mro_calls = 0
    dict_calls = 0
    eq_calls = 0
    name_calls = 0

    def __eq__(cls, other):
        MetaTrap.eq_calls += 1
        return False

    __hash__ = type.__hash__

    @property
    def __name__(cls):
        MetaTrap.name_calls += 1
        return "SpoofedName"

    @property
    def __mro__(cls):
        MetaTrap.mro_calls += 1
        raise AssertionError("metaclass __mro__ ran")

    @property
    def __dict__(cls):
        MetaTrap.dict_calls += 1
        raise AssertionError("metaclass __dict__ ran")

class MetaPreview(metaclass=MetaTrap):
    def __init__(self):
        self.value = 9

attribute_calls = []

class AttributeTrap:
    def __init__(self):
        object.__setattr__(self, "state", "stored")

    def __getattribute__(self, name):
        attribute_calls.append(name)
        if name == "state":
            return "computed"
        return object.__getattribute__(self, name)

class UserDescriptor:
    def __get__(self, instance, owner):
        calls.append("custom descriptor")
        raise AssertionError("custom descriptor ran")

class LazyOnly:
    __slots__ = ("slot_value",)
    custom_descriptor = UserDescriptor()

    def __init__(self):
        self.slot_value = 7

    def __repr__(self):
        calls.append("lazy repr")
        raise AssertionError("lazy repr ran during discovery")

    def __str__(self):
        calls.append("lazy str")
        raise AssertionError("lazy str ran during discovery")

    def __len__(self):
        calls.append("lazy len")
        return 1

    @property
    def computed(self):
        calls.append("lazy property")
        raise AssertionError("lazy property ran during discovery")

class CachedOnly:
    @functools.cached_property
    def computed(self):
        calls.append("cached property")
        return 11

evil_key_calls = []

class EvilKey:
    def __hash__(self):
        return hash("computed")

    def __eq__(self, other):
        evil_key_calls.append(other)
        return False

text_calls = []

class SneakyText(str):
    def __iter__(self):
        text_calls.append("iter")
        raise AssertionError("repr result iterated through user code")

class TextHook:
    def __repr__(self):
        text_calls.append("repr")
        return SneakyText("safe text")

tracer = NativeDapTracer()
preview_value = Preview()
preview = tracer._safe_repr(preview_value)
assert "state='ready'" in preview, preview
assert "child=<Child count=3>" in preview, preview
assert "loop=<recursive>" in preview, preview
assert "..." in preview, preview
assert " object at 0x" not in preview, preview
assert len(preview) <= 500
assert not calls, calls
preview_lazy = {(item.name, item.kind) for item in _lazy_member_specs(preview_value)}
assert ("repr()", "lazy_repr") in preview_lazy
assert ("str()", "lazy_str") in preview_lazy
assert ("computed", "lazy_property") in preview_lazy
assert not calls, calls

lazy_only = LazyOnly()
lazy_specs = {(item.name, item.kind) for item in _lazy_member_specs(lazy_only)}
assert lazy_specs == {
    ("repr()", "lazy_repr"),
    ("str()", "lazy_str"),
    ("len()", "lazy_len"),
    ("computed", "lazy_property"),
    ("slot_value", "lazy_slot"),
}, lazy_specs
assert tracer._expandable(lazy_only) is True
assert tracer._child_counts(lazy_only) == (len(lazy_specs), 0)
lazy_row = tracer._variable(
    1,
    "lazy_only",
    lazy_only,
    None,
    0,
    evaluate_name="lazy_only",
)
assert lazy_row["value"] == "<LazyOnly>"
assert lazy_row["variablesReference"] > 0
assert lazy_row["evaluateName"] == "lazy_only"
assert "custom_descriptor" not in {item.name for item in _lazy_member_specs(lazy_only)}
assert not calls, calls

cached = CachedOnly()
evil_key = EvilKey()
cached.__dict__[evil_key] = "collision"
assert [(item.name, item.kind) for item in _lazy_member_specs(cached)] == [
    ("computed", "lazy_cached_property"),
]
assert not calls, calls
assert not evil_key_calls, evil_key_calls
del cached.__dict__[evil_key]
cached_result = tracer._evaluate_lazy_member(
    ValueHandle(1, cached, None, "lazy_cached_property", name="computed")
)
assert cached_result == 11
assert calls == ["cached property"], calls
assert not _lazy_member_specs(cached)
calls.clear()

lazy_text = tracer._evaluate_lazy_member(
    ValueHandle(1, TextHook(), None, "lazy_repr", name="repr()")
)
assert type(lazy_text) is str
assert tracer._escape_log_text(lazy_text) == "safe text"
assert text_calls == ["repr"], text_calls

bulk_calls = []
bulk_namespace = {
    "field_{}".format(index): index
    for index in range(_MAX_LAZY_MEMBER_SCAN + 20)
}
bulk_namespace["late_property"] = property(
    lambda self: bulk_calls.append("late") or 1
)
Bulk = type("Bulk", (), bulk_namespace)
bulk_specs = _lazy_member_specs(Bulk())
assert len(bulk_specs) <= _MAX_LAZY_MEMBERS
assert "late_property" not in {item.name for item in bulk_specs}
assert not bulk_calls, bulk_calls

trap = DictTrap()
assert tracer._safe_repr(trap) == "<DictTrap>"
assert tracer._expandable(trap) is False
assert tracer._child_counts(trap) == (0, 0)
row = tracer._variable(1, "trap", trap, None, 0)
assert row["variablesReference"] == 0
try:
    tracer._assign_value(ValueHandle(1, trap, None), "fake", 1)
except SetVariableError:
    pass
else:
    raise AssertionError("custom __dict__ target was writable")
assert DictTrap.dict_calls == 0

meta_value = MetaPreview()
MetaTrap.mro_calls = 0
MetaTrap.dict_calls = 0
MetaTrap.eq_calls = 0
MetaTrap.name_calls = 0
assert tracer._safe_repr(meta_value) == "<MetaPreview value=9>"
assert tracer._expandable(meta_value) is True
assert not _lazy_member_specs(meta_value)
assert MetaTrap.mro_calls == 0
assert MetaTrap.dict_calls == 0
assert MetaTrap.eq_calls == 0
assert MetaTrap.name_calls == 0

attribute_trap = AttributeTrap()
assert tracer._safe_repr(attribute_trap) == "<AttributeTrap state='stored'>"
assert tracer._uses_standard_attribute_lookup(attribute_trap) is False
assert not attribute_calls, attribute_calls
assert tracer._format_value(41, {"hex": True}) == "0x29"
assert tracer._format_value(-42, {"hex": True}) == "-0x2a"
assert tracer._format_value(True, {"hex": True}) == "True"
huge_hex = tracer._format_value(1 << 1000000, {"hex": True})
assert len(huge_hex) <= 500
assert huge_hex.startswith("0x") and huge_hex.endswith("...<truncated>")
huge_escaped = tracer._escape_log_text("\x00" * 1000000)
assert len(huge_escaped) <= 16 * 1024
assert huge_escaped.endswith("...<truncated>")
clipboard_value = "x" * 1000
assert tracer._format_value(clipboard_value, clipboard=True) == repr(clipboard_value)
print("SAFE_PREVIEW")
`;
    const { stdout } = await execFileAsync(
      python,
      ['-c', script, path.join(projectRoot(), 'python')],
      { env: cleanPythonEnv(), timeout: 10_000 },
    );
    assert.match(stdout, /SAFE_PREVIEW/);
  });

  it('discovers and caches Django request scopes without importing Django or invoking hooks', async function () {
    const python = await findSystemPython();
    if (!python) {
      this.skip();
      return;
    }

    const script = String.raw`
import sys
import threading
import types

sys.path.insert(0, sys.argv[1])
from django_process_debugger_tracer import (
    ExceptionStopInfo,
    NativeDapTracer,
    StopContext,
    _MAX_DJANGO_REQUEST_LOCALS_PER_FRAME,
    _MAX_DJANGO_REQUEST_STACK_SCAN,
)


def capture_responses(tracer):
    responses = []

    def capture(request, body=None, success=True, message=None, **_kwargs):
        responses.append({
            "body": body,
            "success": success,
            "message": message,
        })
        return True

    tracer._response = capture
    return responses


module_names = (
    "django.http.request",
    "django.core.handlers.base",
    "django.core.handlers.wsgi",
    "django.core.handlers.asgi",
)
missing = object()
original_modules = {
    name: sys.modules.get(name, missing)
    for name in module_names
}
for name in module_names:
    sys.modules.pop(name, None)

try:
    # A request-shaped object is not sufficient, and discovery must not import
    # Django or touch any of its application-defined properties.
    duck_hooks = []

    class RequestDuck:
        @property
        def method(self):
            duck_hooks.append("method")
            raise AssertionError("duck method property ran")

        @property
        def path(self):
            duck_hooks.append("path")
            raise AssertionError("duck path property ran")

    def scan_duck():
        duck = RequestDuck()
        return NativeDapTracer._django_request_scope_from_stack(
            sys._getframe()
        )

    assert scan_duck() is None
    assert not duck_hooks, duck_hooks
    assert "django.http.request" not in sys.modules

    request_module = types.ModuleType("django.http.request")

    class HttpRequest:
        pass

    request_module.HttpRequest = HttpRequest
    sys.modules["django.http.request"] = request_module

    handler_module = types.ModuleType("django.core.handlers.base")

    class BaseHandler:
        # Deliberately use a non-standard argument name. Exact handler code
        # identity, not a local-name guess, must select this active request.
        def _get_response(self, active, callback):
            return callback()

    handler_module.BaseHandler = BaseHandler
    sys.modules["django.core.handlers.base"] = handler_module

    hooks = []

    class RequestMeta(type):
        instance_checks = 0
        subclass_checks = 0
        equality_checks = 0
        mro_reads = 0

        def __instancecheck__(cls, instance):
            RequestMeta.instance_checks += 1
            raise AssertionError("metaclass __instancecheck__ ran")

        def __subclasscheck__(cls, subclass):
            RequestMeta.subclass_checks += 1
            raise AssertionError("metaclass __subclasscheck__ ran")

        def __eq__(cls, other):
            RequestMeta.equality_checks += 1
            return False

        __hash__ = type.__hash__

        @property
        def __mro__(cls):
            RequestMeta.mro_reads += 1
            raise AssertionError("metaclass __mro__ ran")

    class EvilRequest(HttpRequest, metaclass=RequestMeta):
        def __init__(self, method, path):
            object.__setattr__(self, "method", method)
            object.__setattr__(self, "path", path)
            object.__setattr__(self, "path_info", path + "info/")
            object.__setattr__(self, "resolver_match", {"route": path})

        def __getattribute__(self, name):
            hooks.append(("getattribute", name))
            raise AssertionError("request __getattribute__ ran")

        def __repr__(self):
            hooks.append(("repr", None))
            raise AssertionError("request __repr__ ran")

        def __str__(self):
            hooks.append(("str", None))
            raise AssertionError("request __str__ ran")

        @property
        def body(self):
            hooks.append(("body", None))
            raise AssertionError("request body property ran")

        @property
        def user(self):
            hooks.append(("user", None))
            raise AssertionError("request user property ran")

    active = EvilRequest("GET", "/active/")
    inner = EvilRequest("POST", "/inner/")
    decoy = EvilRequest("DELETE", "/decoy/")
    RequestMeta.instance_checks = 0
    RequestMeta.subclass_checks = 0
    RequestMeta.equality_checks = 0
    RequestMeta.mro_reads = 0

    def inspect_named(request):
        return NativeDapTracer._django_request_scope_from_stack(
            sys._getframe()
        )

    def inspect_alias(alias):
        return NativeDapTracer._django_request_scope_from_stack(
            sys._getframe()
        )

    handler = BaseHandler()
    named_scope = handler._get_response(
        active,
        lambda: inspect_named(inner),
    )
    assert named_scope["request"] is inner
    assert named_scope["method"] == "POST"
    assert named_scope["path"] == "/inner/"
    assert named_scope["path_info"] == "/inner/info/"

    # A closer arbitrary alias is weaker evidence than a known handler frame.
    handler_scope = handler._get_response(
        active,
        lambda: inspect_alias(decoy),
    )
    assert handler_scope["request"] is active
    assert handler_scope["resolver_match"] == {"route": "/active/"}

    fallback_scope = inspect_alias(decoy)
    assert fallback_scope["request"] is decoy
    assert not hooks, hooks
    assert RequestMeta.instance_checks == 0
    assert RequestMeta.subclass_checks == 0
    assert RequestMeta.equality_checks == 0
    assert RequestMeta.mro_reads == 0

    # The scan stops before a request frame outside its stack bound.
    def bounded_outer(alias, depth):
        def descend(remaining):
            if remaining:
                return descend(remaining - 1)
            return NativeDapTracer._django_request_scope_from_stack(
                sys._getframe()
            )

        return descend(depth)

    assert bounded_outer(active, 8)["request"] is active
    assert bounded_outer(
        active,
        _MAX_DJANGO_REQUEST_STACK_SCAN + 8,
    ) is None

    # A request local beyond the per-frame scan bound is not inspected. Keep
    # the only live request behind a class attribute so outer frames cannot
    # provide an accidental fallback candidate.
    class RequestHolder:
        value = active

    saved_requests = (active, inner, decoy)
    active = None
    inner = None
    decoy = None
    many_locals_source = ["def many_locals():"]
    many_locals_source.extend(
        "    local_{} = {}".format(index, index)
        for index in range(_MAX_DJANGO_REQUEST_LOCALS_PER_FRAME + 16)
    )
    many_locals_source.extend((
        "    late_alias = RequestHolder.value",
        "    return NativeDapTracer._django_request_scope_from_stack(sys._getframe())",
    ))
    many_locals_namespace = {
        "NativeDapTracer": NativeDapTracer,
        "RequestHolder": RequestHolder,
        "sys": sys,
    }
    exec("\n".join(many_locals_source), many_locals_namespace)
    assert many_locals_namespace["many_locals"]() is None
    active, inner, decoy = saved_requests

    def exercise_cached_scope(request):
        tracer = NativeDapTracer()
        responses = capture_responses(tracer)
        native_id = threading.get_ident()
        frame = sys._getframe()
        context = StopContext(native_id, 1, frame, "breakpoint")
        tracer.stops[native_id] = context
        frame_id = tracer._handle_frame(native_id, frame)
        parent_frame_id = tracer._handle_frame(native_id, frame.f_back)

        scans = []
        original_scan = tracer._django_request_scope_from_stack

        def counted_scan(candidate_frame):
            scans.append(candidate_frame)
            return original_scan(candidate_frame)

        tracer._django_request_scope_from_stack = counted_scan
        tracer._scopes({"seq": 1}, {"frameId": frame_id})
        tracer._scopes({"seq": 2}, {"frameId": frame_id})
        tracer._scopes({"seq": 3}, {"frameId": parent_frame_id})
        assert len(scans) == 1, scans
        request_scopes = [
            next(
                scope
                for scope in response["body"]["scopes"]
                if scope["name"] == "Django Request"
            )
            for response in responses[:3]
        ]
        references = {
            scope["variablesReference"]
            for scope in request_scopes
        }
        assert len(references) == 1, references
        request_reference = references.pop()

        tracer._variables(
            {"seq": 4},
            {"variablesReference": request_reference},
        )
        rows = responses[-1]["body"]["variables"]
        request_row = next(row for row in rows if row["name"] == "request")
        assert request_row["value"] == "<EvilRequest>"
        assert request_row["variablesReference"] > 0
        assert all(
            "readOnly" in row.get("presentationHint", {}).get("attributes", [])
            for row in rows
        ), rows
        assert not hooks, hooks

        tracer._set_variable(
            {"seq": 5},
            {
                "variablesReference": request_reference,
                "name": "method",
                "value": "hooks.append(('set-expression', None)) or 'PATCH'",
            },
        )
        assert responses[-1]["success"] is False
        assert responses[-1]["message"] == "Django Request scope is read-only"
        assert not hooks, hooks
        return request_reference

    cached_reference = exercise_cached_scope(active)
    assert cached_reference > 0

    def exercise_negative_cache(request):
        tracer = NativeDapTracer()
        responses = capture_responses(tracer)
        native_id = threading.get_ident()
        frame = sys._getframe()
        context = StopContext(native_id, 1, frame, "breakpoint")
        tracer.stops[native_id] = context
        frame_id = tracer._handle_frame(native_id, frame)
        saved_module = sys.modules.pop("django.http.request")
        try:
            tracer._scopes({"seq": 6}, {"frameId": frame_id})
            assert context.django_request_scope_resolved is True
            assert context.django_request_scope is None
            assert all(
                scope["name"] != "Django Request"
                for scope in responses[-1]["body"]["scopes"]
            )

            # A negative result remains deterministic for this stop even if
            # another thread/module action makes Django visible meanwhile.
            sys.modules["django.http.request"] = saved_module
            tracer._scopes({"seq": 7}, {"frameId": frame_id})
            assert all(
                scope["name"] != "Django Request"
                for scope in responses[-1]["body"]["scopes"]
            )

            tracer._expire_handles(native_id)
            next_context = StopContext(native_id, 1, frame, "step")
            tracer.stops[native_id] = next_context
            next_frame_id = tracer._handle_frame(native_id, frame)
            tracer._scopes({"seq": 8}, {"frameId": next_frame_id})
            assert next_context.django_request_scope_resolved is True
            assert next_context.django_request_scope["request"] is request
            assert any(
                scope["name"] == "Django Request"
                for scope in responses[-1]["body"]["scopes"]
            )
        finally:
            sys.modules["django.http.request"] = saved_module

    exercise_negative_cache(active)

    # Signal-supplied post-mortem request context is authoritative even if a
    # different live HttpRequest is visible in the stopped frame.
    authoritative = object()

    def exception_scope_precedence(request):
        tracer = NativeDapTracer()
        context = StopContext(
            threading.get_ident(),
            1,
            sys._getframe(),
            "exception",
            exception_info=ExceptionStopInfo(
                RuntimeError("boom"),
                None,
                "userUnhandled",
                "djangoRequestUnhandled",
                1,
                request_scope={"request": authoritative, "path": "/signal/"},
            ),
        )
        tracer._django_request_scope_from_stack = lambda _frame: (_ for _ in ()).throw(
            AssertionError("authoritative exception scope performed a stack scan")
        )
        return tracer._django_request_scope_for_context(context)

    authoritative_scope = exception_scope_precedence(active)
    assert authoritative_scope["request"] is authoritative
    assert authoritative_scope["path"] == "/signal/"
    assert not hooks, hooks
finally:
    for name, module in original_modules.items():
        if module is missing:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = module

print("DJANGO_REQUEST_SCOPE_SAFE")
`;
    const { stdout } = await execFileAsync(
      python,
      ['-c', script, path.join(projectRoot(), 'python')],
      { env: cleanPythonEnv(), timeout: 15_000 },
    );
    assert.match(stdout, /DJANGO_REQUEST_SCOPE_SAFE/);
  });

  it('refuses to replace an existing Python trace hook', async function () {
    const python = await findSystemPython();
    if (!python) {
      this.skip();
      return;
    }

    const script = String.raw`
import sys
import threading
sys.path.insert(0, sys.argv[1])
import django_process_debugger_tracer as tracer

def existing(frame, event, arg):
    return existing

sys.settrace(existing)
threading.settrace(existing)
try:
    tracer.start(auth_token="0123456789abcdef" * 4)
except RuntimeError as exc:
    assert "will not replace" in str(exc), str(exc)
    assert sys.gettrace() is existing, "current-thread hook was erased"
    assert tracer._existing_thread_trace_hook() is existing, "future-thread hook was erased"
    assert tracer._ACTIVE_TRACER is None, "failed activation retained tracer ownership"
    print("REFUSED")
else:
    raise AssertionError("experimental tracer replaced an existing hook")
finally:
    sys.settrace(None)
    threading.settrace(None)
`;
    const { stdout } = await execFileAsync(
      python,
      ['-c', script, path.join(projectRoot(), 'python')],
      { env: cleanPythonEnv(), timeout: 10_000 },
    );
    assert.match(stdout, /REFUSED/);
  });

  it('serializes handle creation and expiration across threads', async function () {
    const python = await findSystemPython();
    if (!python) {
      this.skip();
      return;
    }

    const script = String.raw`
import sys
import threading
sys.path.insert(0, sys.argv[1])
from django_process_debugger_tracer import NativeDapTracer

tracer = NativeDapTracer()
native_id = 1234
errors = []

def create_handles():
    try:
        for index in range(20000):
            tracer._handle_value(native_id, [index])
    except BaseException as exc:
        errors.append(exc)

def expire_handles():
    try:
        for _ in range(20000):
            tracer._expire_handles(native_id)
    except BaseException as exc:
        errors.append(exc)

threads = [threading.Thread(target=create_handles), threading.Thread(target=expire_handles)]
for thread in threads:
    thread.start()
for thread in threads:
    thread.join()
assert not errors, errors
print("SYNCHRONIZED")
`;
    const { stdout } = await execFileAsync(
      python,
      ['-c', script, path.join(projectRoot(), 'python')],
      { env: cleanPythonEnv(), timeout: 20_000 },
    );
    assert.match(stdout, /SYNCHRONIZED/);
  });

  it('rejects inherited trace work and a stop racing with disconnect', async function () {
    const python = await findSystemPython();
    if (!python) {
      this.skip();
      return;
    }

    const script = String.raw`
import gc
import os
import socket
import sys
import threading
sys.path.insert(0, sys.argv[1])
import django_process_debugger_tracer as tracer_module
from django_process_debugger_tracer import BreakpointMatch, NativeDapTracer

# This is the state visible in a forked child before Python reaches the
# tracer's registered after-fork cleanup callback.
inherited = NativeDapTracer()
inherited.owner_pid = os.getpid() + 1
inherited.configured = True
inherited.steps[threading.get_ident()] = ("stepIn", 0)
pause_calls = []
inherited._pause = lambda *args: pause_calls.append(args)
assert inherited._trace(sys._getframe(), "line", None) is None
assert not pause_calls, "inherited step was evaluated before the PID guard"
assert inherited.enabled is False and inherited.configured is False

# A recycled CPython thread identifier must receive a fresh DAP identity and
# cannot inherit pending controls from the dead Thread object.
reused = NativeDapTracer()
old_thread = threading.Thread(name="old-worker")
new_thread = threading.Thread(name="new-worker")
first_dap_id = reused._thread_id(777, old_thread)
reused.steps[777] = ("stepOut", 4)
reused.pause_requests.add(777)
second_dap_id = reused._thread_id(777, new_thread)
assert second_dap_id != first_dap_id
assert 777 not in reused.steps and 777 not in reused.pause_requests

authoritative = NativeDapTracer()
live_thread = threading.current_thread()
live_ident = threading.get_ident()
live_dap_id = authoritative._thread_id(live_ident, live_thread)
authoritative.steps[live_ident] = ("next", 3)

class StaleSnapshot:
    ident = live_ident
    name = "stale-enumeration-row"

    @staticmethod
    def is_alive():
        return True

assert authoritative._thread_id_for_snapshot(live_ident, StaleSnapshot()) is None
assert authoritative.native_threads[live_ident] is live_thread
assert authoritative.native_to_dap[live_ident] == live_dap_id
assert authoritative.steps[live_ident] == ("next", 3)

pruned = NativeDapTracer()
ephemeral = threading.Thread(name="ephemeral-worker")
pruned._thread_id(999, ephemeral)
del ephemeral
gc.collect()
with pruned.condition:
    pruned._prune_dead_thread_mappings_locked()
assert 999 not in pruned.native_threads
assert 999 not in pruned.native_to_dap

# Force disconnect to race while _pause() is emitting stopped. The state/event
# transition must remain serialized, then disconnect must wake the stop.
tracer = NativeDapTracer()
client, peer = socket.socketpair()
tracer.client = client
tracer.configured = True
entered = threading.Event()
proceed = threading.Event()
drop_finished = threading.Event()
worker_errors = []
drop_errors = []

def block_stopped_event(*args, **kwargs):
    entered.set()
    proceed.wait(2)
    return True

tracer._event = block_stopped_event

def race_pause():
    try:
        tracer._pause(1234, sys._getframe(), "breakpoint", client)
    except BaseException as exc:
        worker_errors.append(exc)

worker = threading.Thread(
    target=race_pause,
    daemon=True,
)
worker.start()
assert entered.wait(1), "pause worker did not reach the race window"

def race_drop():
    try:
        tracer._drop_client(client)
    except BaseException as exc:
        drop_errors.append(exc)
    finally:
        drop_finished.set()

dropper = threading.Thread(target=race_drop, daemon=True)
dropper.start()
assert not drop_finished.wait(0.05), "disconnect bypassed the stop transition lock"
proceed.set()
worker.join(1)
dropper.join(1)
peer.close()
assert not worker.is_alive(), "stale stop waited after client disconnect"
assert not dropper.is_alive(), "disconnect did not complete"
assert not worker_errors, worker_errors
assert not drop_errors, drop_errors
assert not tracer.stops
assert not tracer.native_threads and not tracer.native_to_dap and not tracer.dap_to_native

bound = NativeDapTracer()
bound_client, bound_peer = socket.socketpair()
bound.client = bound_client
bound.configured = True
event_clients = []

def capture_event(*args, **kwargs):
    event_clients.append(kwargs.get("expected_client"))
    return False

bound._event = capture_event
bound._pause(4321, sys._getframe(), "breakpoint", bound_client)
bound_client.close()
bound_peer.close()
assert event_clients == [bound_client], "stopped event was not bound to its DAP client"

# A slow condition may finish after setBreakpoints replaced its source table.
# The old snapshot must not emit a stale stopped event.
stale = NativeDapTracer()
stale_client, stale_peer = socket.socketpair()
stale.client = stale_client
stale.configured = True
old_table = {1: ()}
stale.breakpoints["/example.py"] = {1: ()}
stale_events = []
stale._event = lambda *args, **kwargs: stale_events.append(args) or True
stale._pause(
    9876,
    sys._getframe(),
    "breakpoint",
    stale_client,
    breakpoint_match=BreakpointMatch("/example.py", old_table, (77,)),
)
stale_client.close()
stale_peer.close()
assert not stale_events, "replaced breakpoint snapshot emitted a stale stop"
assert not stale.stops

# Explicit breakpoints=[] replaces the source table. It must not fall back to
# the legacy lines array and accidentally retain/reinstall an old breakpoint.
replacement = NativeDapTracer()
replacement._response = lambda *args, **kwargs: True
replacement._set_breakpoints(
    {"seq": 1, "command": "setBreakpoints"},
    {
        "source": {"path": tracer_module.__file__},
        "breakpoints": [{"line": 1, "condition": "True"}],
    },
)
normalized_source = os.path.normcase(os.path.realpath(tracer_module.__file__))
assert normalized_source in replacement.breakpoints
replacement._set_breakpoints(
    {"seq": 2, "command": "setBreakpoints"},
    {
        "source": {"path": tracer_module.__file__},
        "breakpoints": [],
        "lines": [1],
    },
)
assert normalized_source not in replacement.breakpoints
print("RACES_CLOSED")
`;
    const { stdout } = await execFileAsync(
      python,
      ['-c', script, path.join(projectRoot(), 'python')],
      { env: cleanPythonEnv(), timeout: 10_000 },
    );
    assert.match(stdout, /RACES_CLOSED/);
  });

  it('keeps exception breakpoint configuration and snapshots bounded and safe', async function () {
    const python = await findSystemPython();
    if (!python) {
      this.skip();
      return;
    }

    const script = String.raw`
import builtins
import gc
import os
import socket
import sys
import threading
import weakref
sys.path.insert(0, sys.argv[1])
from django_process_debugger_tracer import (
    ExceptionStopInfo,
    ExceptionStopMarker,
    NativeDapTracer,
    _MAX_EXCEPTION_MESSAGE_CHARS,
    _MAX_EXCEPTION_STACK_CHARS,
    _MAX_EXCEPTION_TYPE_CHARS,
    _MAX_INNER_EXCEPTION_DEPTH,
)


def capture_responses(tracer):
    responses = []

    def capture(request, body=None, **kwargs):
        responses.append(
            {
                "body": body,
                "success": kwargs.get("success", True),
                "message": kwargs.get("message"),
            }
        )
        return True

    tracer._response = capture
    return responses


# Legacy filters and filterOptions are additive within one request, while each
# request replaces the previous exception configuration. Invalid entries stay
# visible as individual unverified rows and do not erase valid entries.
original_sys_hook = sys.excepthook
original_threading_hook = threading.excepthook
configured = NativeDapTracer()
responses = capture_responses(configured)
try:
    configured._set_exception_breakpoints(
        {"seq": 1, "command": "setExceptionBreakpoints"},
        {"filters": ["raised"]},
    )
    assert configured.exception_filters == {"raised"}
    assert responses[-1]["success"] is True
    assert responses[-1]["body"]["breakpoints"][0]["verified"] is True
    first_generation = configured.exception_generation

    configured._set_exception_breakpoints(
        {"seq": 2, "command": "setExceptionBreakpoints"},
        {
            "filters": ["raised", "unknown"],
            "filterOptions": [
                {"filterId": "uncaught"},
                {"filterId": "raised", "condition": "value > 0"},
            ],
            "exceptionOptions": [{"breakMode": "always"}],
        },
    )
    rows = responses[-1]["body"]["breakpoints"]
    assert [row["verified"] for row in rows] == [True, False, True, False, False]
    assert all("id" in row for row in (rows[0], rows[2]))
    assert all("message" in row for row in (rows[1], rows[3], rows[4]))
    assert configured.exception_filters == {"raised", "uncaught"}
    assert configured.exception_generation == first_generation + 1
    assert sys.excepthook is configured.sys_exception_hook
    assert threading.excepthook is configured.threading_exception_hook

    configured._set_exception_breakpoints(
        {"seq": 3, "command": "setExceptionBreakpoints"},
        {"filters": ["raised"]},
    )
    assert configured.exception_filters == {"raised"}
    assert sys.excepthook is original_sys_hook
    assert threading.excepthook is original_threading_hook

    generation_before_invalid_array = configured.exception_generation
    configured._set_exception_breakpoints(
        {"seq": 4, "command": "setExceptionBreakpoints"},
        {"filters": "raised"},
    )
    assert responses[-1]["success"] is False
    assert configured.exception_filters == {"raised"}
    assert configured.exception_generation == generation_before_invalid_array

    # Restoration must not overwrite a hook installed by another library after
    # the tracer wrapper. The tracer still drops its own saved references.
    configured._set_exception_breakpoints(
        {"seq": 5, "command": "setExceptionBreakpoints"},
        {"filters": ["uncaught"]},
    )
    wrapped_sys_hook = configured.sys_exception_hook
    wrapped_threading_hook = configured.threading_exception_hook
    assert sys.excepthook is wrapped_sys_hook
    assert threading.excepthook is wrapped_threading_hook

    def foreign_sys_hook(*args):
        return None

    def foreign_threading_hook(args):
        return None

    sys.excepthook = foreign_sys_hook
    threading.excepthook = foreign_threading_hook
    configured._restore_uncaught_exception_hooks()
    assert sys.excepthook is foreign_sys_hook
    assert threading.excepthook is foreign_threading_hook
    assert configured.sys_exception_hook is None
    assert configured.threading_exception_hook is None

    # Re-sending the same uncaught configuration after another integration
    # replaced both hooks must wrap the new current hooks instead of returning
    # a false verified success with inactive tracer hooks.
    configured._set_exception_breakpoints(
        {"seq": 6, "command": "setExceptionBreakpoints"},
        {"filters": ["uncaught"]},
    )
    assert sys.excepthook is configured.sys_exception_hook
    assert threading.excepthook is configured.threading_exception_hook
    assert configured.previous_sys_excepthook is foreign_sys_hook
    assert configured.previous_threading_excepthook is foreign_threading_hook
    configured._set_exception_breakpoints(
        {"seq": 7, "command": "setExceptionBreakpoints"},
        {"filters": ["raised"]},
    )
    assert sys.excepthook is foreign_sys_hook
    assert threading.excepthook is foreign_threading_hook

    # Hook restoration is identity-based even when the application had stored
    # None. Do not retain an orphaned tracer wrapper in that unusual state.
    sys.excepthook = None
    threading.excepthook = None
    configured._set_exception_breakpoints(
        {"seq": 8, "command": "setExceptionBreakpoints"},
        {"filters": ["uncaught"]},
    )
    configured._set_exception_breakpoints(
        {"seq": 9, "command": "setExceptionBreakpoints"},
        {"filters": []},
    )
    assert sys.excepthook is None
    assert threading.excepthook is None
finally:
    sys.excepthook = original_sys_hook
    threading.excepthook = original_threading_hook
    configured._restore_uncaught_exception_hooks()


# The main-thread wrapper delegates to the application hook exactly once and
# releases every marker owned by that terminating exception flow.
sys_chain_calls = []
handled_uncaught = []

def application_sys_hook(exception_type, exception_value, exception_traceback):
    sys_chain_calls.append((exception_type, exception_value, exception_traceback))

sys.excepthook = application_sys_hook
sys_hook_tracer = NativeDapTracer()
with sys_hook_tracer.condition:
    sys_hook_tracer._install_uncaught_exception_hooks_locked()
try:
    try:
        raise RuntimeError("sys hook")
    except RuntimeError as caught_sys_error:
        sys_error = caught_sys_error
        sys_traceback = caught_sys_error.__traceback__
    native_id = threading.get_ident()
    sys_hook_tracer.last_exception_stops[native_id] = (
        ExceptionStopMarker(sys_error, "uncaught"),
    )
    sys_hook_tracer._handle_uncaught_exception = (
        lambda *args: handled_uncaught.append(args)
    )
    sys_hook_tracer.sys_exception_hook(
        type(sys_error),
        sys_error,
        sys_traceback,
    )
    assert len(handled_uncaught) == 1
    assert len(sys_chain_calls) == 1
    assert sys_chain_calls[0][1] is sys_error
    assert native_id not in sys_hook_tracer.last_exception_stops
finally:
    sys_hook_tracer._restore_uncaught_exception_hooks()
    sys.excepthook = original_sys_hook
    threading.excepthook = original_threading_hook


# Exception presentation must use BaseException/type storage directly. None of
# the application text hooks or metaclass properties below may execute.
hook_calls = []

class TrapMeta(type):
    def __getattribute__(cls, name):
        if name in ("__name__", "__qualname__", "__module__"):
            hook_calls.append("metaclass " + name)
            raise AssertionError("metaclass type metadata hook ran")
        return type.__getattribute__(cls, name)

class EvilError(BaseException, metaclass=TrapMeta):
    def __str__(self):
        hook_calls.append("exception str")
        raise AssertionError("exception __str__ ran")

    def __repr__(self):
        hook_calls.append("exception repr")
        raise AssertionError("exception __repr__ ran")

class Payload:
    def __str__(self):
        hook_calls.append("payload str")
        raise AssertionError("payload __str__ ran")

    def __repr__(self):
        hook_calls.append("payload repr")
        raise AssertionError("payload __repr__ ran")

class MetadataText(str):
    def __format__(self, format_spec):
        hook_calls.append("metadata format")
        raise SystemExit("metadata __format__ ran")

    def __str__(self):
        hook_calls.append("metadata str")
        raise SystemExit("metadata __str__ ran")

class MetadataPayload:
    pass

MetadataPayload.__name__ = MetadataText("MetadataPayload")

def metadata_function():
    return None

metadata_function.__qualname__ = MetadataText("metadata_function")

message_value = EvilError("\x1b\n\ud800" + ("x" * (_MAX_EXCEPTION_MESSAGE_CHARS + 200)))
message = NativeDapTracer._exception_message(message_value)
type_name = NativeDapTracer._exception_type_name(message_value)
full_type_name = NativeDapTracer._exception_type_name(message_value, full=True)
description = NativeDapTracer._exception_stop_description(
    ExceptionStopInfo(message_value, None, "always", "raised", 1)
)
assert len(message) <= _MAX_EXCEPTION_MESSAGE_CHARS
assert "\\x1b\\n\\ud800" in message
assert "\x1b" not in message and "\n" not in message and "\ud800" not in message
assert type_name == "EvilError"
assert full_type_name.endswith(".EvilError")
assert "\\x1b\\n\\ud800" in description

payload_message = NativeDapTracer._exception_message(EvilError(Payload()))
assert "Payload" in payload_message
metadata_message = NativeDapTracer._exception_message(
    EvilError(MetadataPayload(), metadata_function)
)
assert "MetadataPayload" in metadata_message
assert "metadata_function" in metadata_message
huge_integer_message = NativeDapTracer._exception_message(
    EvilError(1 << 1000000)
)
assert len(huge_integer_message) <= _MAX_EXCEPTION_MESSAGE_CHARS
assert "0x" in huge_integer_message and huge_integer_message.endswith("...")
assert not hook_calls, hook_calls

LongError = TrapMeta(
    "Long\n" + ("T" * (_MAX_EXCEPTION_TYPE_CHARS + 200)),
    (BaseException,),
    {},
)
bounded_type = NativeDapTracer._exception_type_name(LongError("value"))
assert len(bounded_type) <= _MAX_EXCEPTION_TYPE_CHARS
assert "\\n" in bounded_type and "\n" not in bounded_type
assert bounded_type.endswith("...<truncated>")
assert not hook_calls, hook_calls


# Cause/context traversal must follow Python display precedence without loops or
# unbounded chains.
cycle_a = EvilError("cycle-a")
cycle_b = EvilError("cycle-b")
cycle_a.__cause__ = cycle_b
cycle_b.__cause__ = cycle_a
cycle_details = NativeDapTracer._exception_details(cycle_a, None)
assert cycle_details["innerException"][0]["message"] == "cycle-b"
assert "innerException" not in cycle_details["innerException"][0]
assert len(cycle_details["stackTrace"]) <= _MAX_EXCEPTION_STACK_CHARS

chain = [EvilError("chain-{}".format(index)) for index in range(_MAX_INNER_EXCEPTION_DEPTH + 4)]
for current, child in zip(chain, chain[1:]):
    current.__cause__ = child
chain_details = NativeDapTracer._exception_details(chain[0], None)
chain_depth = 1
cursor = chain_details
while cursor.get("innerException"):
    chain_depth += 1
    cursor = cursor["innerException"][0]
assert chain_depth == _MAX_INNER_EXCEPTION_DEPTH + 1
assert len(chain_details["stackTrace"]) <= _MAX_EXCEPTION_STACK_CHARS

context_inner = EvilError("context")
context_outer = EvilError("outer")
context_outer.__context__ = context_inner
context_details = NativeDapTracer._exception_details(context_outer, None)
assert context_details["innerException"][0]["message"] == "context"
context_outer.__suppress_context__ = True
assert "innerException" not in NativeDapTracer._exception_details(context_outer, None)
exception_group_type = getattr(builtins, "ExceptionGroup", None)
if exception_group_type is not None:
    exception_group = exception_group_type(
        "group",
        [ValueError("group-a"), TypeError("group-b")],
    )
    group_details = NativeDapTracer._exception_details(exception_group, None)
    assert [
        child["typeName"] for child in group_details["innerException"]
    ] == ["ValueError", "TypeError"]
    assert [
        child["message"] for child in group_details["innerException"]
    ] == ["group-a", "group-b"]
    assert "group-a" in group_details["stackTrace"]
    assert "group-b" in group_details["stackTrace"]
    large_group = exception_group_type(
        "large-group",
        [ValueError("child-{}".format(index)) for index in range(100)],
    )
    large_group_details = NativeDapTracer._exception_details(large_group, None)
    assert len(large_group_details["innerException"]) == 32
    assert "additional contained exceptions omitted" in large_group_details["stackTrace"]
assert not hook_calls, hook_calls


# Deep tracebacks retain the innermost throw site in details and select that
# same historical frame for an uncaught post-mortem stop.
def deep_failure(remaining):
    if remaining:
        return deep_failure(remaining - 1)
    leaf_marker = "deep-leaf"
    raise EvilError("deep")

try:
    deep_failure(400)
except EvilError as caught_deep_error:
    deep_error = caught_deep_error
    deep_traceback = caught_deep_error.__traceback__
else:
    raise AssertionError("deep exception did not escape")
leaf_traceback = deep_traceback
while leaf_traceback.tb_next is not None:
    leaf_traceback = leaf_traceback.tb_next
deep_details = NativeDapTracer._exception_details(deep_error, deep_traceback)
assert "line {}".format(leaf_traceback.tb_lineno) in deep_details["stackTrace"]
assert "earlier frames truncated" in deep_details["stackTrace"]
deep_tracer = NativeDapTracer()
deep_client = object()
deep_tracer.client = deep_client
deep_tracer.configured = True
deep_tracer.exception_filters = {"uncaught"}
selected_frames = []
deep_tracer._pause = lambda native_id, frame, *args, **kwargs: selected_frames.append(frame) or True
deep_tracer._handle_uncaught_exception(
    threading.get_ident(),
    deep_error,
    deep_traceback,
)
assert selected_frames[0].f_locals["leaf_marker"] == "deep-leaf"


# A generation that lost the configuration race must not emit, allocate stop
# state, or retain the exception through the de-duplication table.
stale = NativeDapTracer()
stale_client = object()
stale.client = stale_client
stale.configured = True
stale.exception_filters = {"raised"}
stale.exception_generation = 9
stale_events = []
stale._event = lambda *args, **kwargs: stale_events.append((args, kwargs)) or False
stale_value = EvilError("stale")
stale_reference = weakref.ref(stale_value)
stale_info = ExceptionStopInfo(stale_value, None, "always", "raised", 8)
assert stale._pause(
    7101,
    sys._getframe(),
    "exception",
    stale_client,
    exception_stop=stale_info,
) is False
assert not stale_events
assert not stale.stops and not stale.last_exception_stops
assert not stale.frames and not stale.values and not stale.value_handles
del stale_info
del stale_value
gc.collect()
assert stale_reference() is None

# A failed stopped event rolls back the committed marker and stop context too.
rejected = NativeDapTracer()
rejected_client = object()
rejected.client = rejected_client
rejected.configured = True
rejected.exception_filters = {"raised"}
rejected.exception_generation = 3
rejected_events = []
rejected._event = lambda *args, **kwargs: rejected_events.append((args, kwargs)) or False
rejected_value = EvilError("rejected")
rejected_reference = weakref.ref(rejected_value)
rejected_info = ExceptionStopInfo(rejected_value, None, "always", "raised", 3)
assert rejected._pause(
    7102,
    sys._getframe(),
    "exception",
    rejected_client,
    exception_stop=rejected_info,
) is False
assert len(rejected_events) == 1
assert not rejected.stops and not rejected.last_exception_stops
del rejected_info
del rejected_value
gc.collect()
assert rejected_reference() is None


# A successful event can resume synchronously in this unit probe. Its marker
# must suppress a second propagation stop for the same exception object.
duplicate = NativeDapTracer()
duplicate_client = object()
duplicate.client = duplicate_client
duplicate.configured = True
duplicate.exception_filters = {"raised"}
duplicate.exception_generation = 4
duplicate_events = []
duplicate_value = EvilError("duplicate")
duplicate_info = ExceptionStopInfo(
    duplicate_value,
    None,
    "always",
    "raised",
    4,
)

def accept_and_resume(name, body, **kwargs):
    duplicate_events.append((name, body))
    duplicate.stops[7103].paused = False
    return True

duplicate._event = accept_and_resume
assert duplicate._pause(
    7103,
    sys._getframe(),
    "exception",
    duplicate_client,
    exception_stop=duplicate_info,
) is True
assert duplicate._pause(
    7103,
    sys._getframe(),
    "exception",
    duplicate_client,
    exception_stop=duplicate_info,
) is False
assert len(duplicate_events) == 1
assert duplicate.last_exception_stops[7103] == (
    ExceptionStopMarker(duplicate_value, "raised"),
)
duplicate._clear_exception_stop(7103, duplicate_value)
assert 7103 not in duplicate.last_exception_stops


# Real trace events through a finally block must still classify one logical
# propagation as one raised stop. After the handler completes, a later distinct
# exception on the same thread must be eligible to stop again.
flow = NativeDapTracer()
flow_client = object()
flow.client = flow_client
flow.configured = True
flow.exception_filters = {"raised"}
flow.exception_generation = 1
flow_events = []

class FlowError(Exception):
    pass

class NestedFlowError(Exception):
    pass

def accept_flow_stop(name, body, **kwargs):
    if body.get("text") in ("FlowError", "NestedFlowError"):
        flow_events.append(body)
    flow.stops[threading.get_ident()].paused = False
    return True

def raise_through_finally(label):
    try:
        raise FlowError(label)
    finally:
        marker = label
        assert marker == label

def catch_flow(label):
    try:
        raise_through_finally(label)
    except FlowError:
        pass

def raise_with_nested_exception():
    try:
        raise FlowError("outer")
    finally:
        try:
            raise NestedFlowError("inner")
        except NestedFlowError:
            pass

def catch_nested_exception():
    try:
        raise_with_nested_exception()
    except FlowError:
        pass

flow._event = accept_flow_stop
previous_trace = sys.gettrace()
sys.settrace(flow.trace)
try:
    catch_flow("first")
    catch_flow("second")
    catch_nested_exception()
finally:
    sys.settrace(previous_trace)
assert [event["text"] for event in flow_events] == [
    "FlowError",
    "FlowError",
    "FlowError",
    "NestedFlowError",
], flow_events
assert all(event["reason"] == "exception" for event in flow_events)


# Thread cleanup, client drop, and the lock-free fork reset must all release
# exception references and restore only tracer-owned hooks.
identity = NativeDapTracer()
identity.last_exception_stops[7201] = (
    ExceptionStopMarker(EvilError("identity"), "raised"),
)
with identity.condition:
    identity._discard_thread_identity_locked(7201)
assert 7201 not in identity.last_exception_stops

drop_client, drop_peer = socket.socketpair()
drop = NativeDapTracer()
drop.client = drop_client
drop.configured = True
capture_responses(drop)
drop._set_exception_breakpoints(
    {"seq": 10, "command": "setExceptionBreakpoints"},
    {"filters": ["uncaught"]},
)
drop.last_exception_stops[7202] = (
    ExceptionStopMarker(EvilError("drop"), "uncaught"),
)
assert sys.excepthook is drop.sys_exception_hook
drop._drop_client(drop_client)
assert not drop.exception_filters and not drop.last_exception_stops
assert drop.sys_exception_hook is None and drop.threading_exception_hook is None
assert sys.excepthook is original_sys_hook
assert threading.excepthook is original_threading_hook
drop_peer.close()

fork_client, fork_peer = socket.socketpair()
forked = NativeDapTracer()
forked.client = fork_client
forked.endpoint = ("127.0.0.1", 1)
forked.configured = True
capture_responses(forked)
forked._set_exception_breakpoints(
    {"seq": 11, "command": "setExceptionBreakpoints"},
    {"filters": ["raised", "uncaught"]},
)
forked.last_exception_stops[7203] = (
    ExceptionStopMarker(EvilError("fork"), "raised"),
)
assert sys.excepthook is forked.sys_exception_hook
forked._after_fork_child()
assert forked.enabled is False and forked.configured is False
assert not forked.exception_filters and not forked.last_exception_stops
assert forked.exception_generation == 0
assert forked.sys_exception_hook is None and forked.threading_exception_hook is None
assert forked.client is None and forked.endpoint is None
assert sys.excepthook is original_sys_hook
assert threading.excepthook is original_threading_hook
fork_peer.close()

assert not hook_calls, hook_calls
print("EXCEPTIONS_SAFE")
`;
    const { stdout } = await execFileAsync(
      python,
      ['-c', script, path.join(projectRoot(), 'python')],
      { env: cleanPythonEnv(), timeout: 15_000 },
    );
    assert.match(stdout, /EXCEPTIONS_SAFE/);
  });

  it('manages the Django request exception signal without importing Django or leaking receiver failures', async function () {
    const python = await findSystemPython();
    if (!python) {
      this.skip();
      return;
    }

    const script = String.raw`
import os
import socket
import sys
import types

sys.path.insert(0, sys.argv[1])
from django_process_debugger_tracer import NativeDapTracer


def capture_responses(tracer):
    responses = []

    def capture(request, body=None, **kwargs):
        responses.append(
            {
                "body": body,
                "success": kwargs.get("success", True),
                "message": kwargs.get("message"),
            }
        )
        return True

    tracer._response = capture
    return responses


module_names = (
    "django.core.signals",
    "django.core.handlers.exception",
)
missing = object()
original_modules = {
    name: sys.modules.get(name, missing)
    for name in module_names
}
for name in module_names:
    sys.modules.pop(name, None)

try:
    # Enabling the specialized filter must not import Django. The failed filter
    # stays visible as an unverified row and is not retained as active state.
    unavailable = NativeDapTracer()
    unavailable_responses = capture_responses(unavailable)
    unavailable._set_exception_breakpoints(
        {"seq": 1, "command": "setExceptionBreakpoints"},
        {"filters": ["djangoRequestUnhandled"]},
    )
    unavailable_row = unavailable_responses[-1]["body"]["breakpoints"][0]
    assert unavailable_row["verified"] is False
    assert "Cannot install Django request exception signal" in unavailable_row["message"]
    assert unavailable.exception_filters == set()
    assert unavailable.django_exception_signal is None
    assert all(name not in sys.modules for name in module_names)

    class FakeSignal:
        def __init__(self):
            self.connect_calls = []
            self.disconnect_calls = []
            self.receivers = []
            self.raise_disconnect = False

        def connect(self, receiver, weak=True, dispatch_uid=None):
            self.connect_calls.append((receiver, weak, dispatch_uid))
            self.receivers.append((receiver, dispatch_uid))

        def disconnect(self, receiver=None, dispatch_uid=None):
            self.disconnect_calls.append((receiver, dispatch_uid))
            if self.raise_disconnect:
                raise SystemExit("hostile disconnect")
            self.receivers = [
                entry
                for entry in self.receivers
                if not (entry[0] is receiver and entry[1] == dispatch_uid)
            ]
            return True

    fake_signal = FakeSignal()
    signals_module = types.ModuleType("django.core.signals")
    signals_module.got_request_exception = fake_signal
    handler_module = types.ModuleType("django.core.handlers.exception")

    def response_for_exception(request, exc):
        return request, exc

    handler_module.response_for_exception = response_for_exception
    sys.modules["django.core.signals"] = signals_module
    sys.modules["django.core.handlers.exception"] = handler_module

    configured = NativeDapTracer()
    configured.client = object()
    configured.configured = True
    configured_responses = capture_responses(configured)
    configured._set_exception_breakpoints(
        {"seq": 2, "command": "setExceptionBreakpoints"},
        {"filters": ["djangoRequestUnhandled"]},
    )
    assert configured_responses[-1]["body"]["breakpoints"][0]["verified"] is True
    assert configured.exception_filters == {"djangoRequestUnhandled"}
    assert configured.django_exception_signal is fake_signal
    assert configured.django_response_for_exception_code is response_for_exception.__code__
    assert len(fake_signal.connect_calls) == 1
    first_receiver, weak, first_dispatch_uid = fake_signal.connect_calls[0]
    assert weak is False
    assert type(first_dispatch_uid) is str and first_dispatch_uid
    assert configured.django_exception_receiver is first_receiver

    # Reconfiguration repairs a receiver removed by an autoreloader: disconnect
    # the old registration, then install a fresh strong receiver with the same
    # tracer-specific dispatch UID.
    configured._set_exception_breakpoints(
        {"seq": 3, "command": "setExceptionBreakpoints"},
        {"filters": ["djangoRequestUnhandled"]},
    )
    assert len(fake_signal.connect_calls) == 2
    assert len(fake_signal.disconnect_calls) == 1
    assert fake_signal.disconnect_calls[0] == (first_receiver, first_dispatch_uid)
    second_receiver, second_weak, second_dispatch_uid = fake_signal.connect_calls[1]
    assert second_receiver is not first_receiver
    assert second_weak is False
    assert second_dispatch_uid == first_dispatch_uid

    # Receiver failures, including BaseException subclasses, must never replace
    # the application's request exception. The inherited-PID guard runs before
    # entering tracer request handling.
    handled = []

    def hostile_handler(native_id, request):
        handled.append((native_id, request))
        raise SystemExit("receiver failure")

    configured._handle_django_request_exception = hostile_handler
    request = object()
    assert second_receiver(sender=object(), request=request, unexpected=True) is None
    assert len(handled) == 1 and handled[0][1] is request
    real_owner_pid = configured.owner_pid
    configured.owner_pid = real_owner_pid + 1000000
    assert second_receiver(request=object()) is None
    assert len(handled) == 1
    configured.owner_pid = real_owner_pid

    configured._set_exception_breakpoints(
        {"seq": 4, "command": "setExceptionBreakpoints"},
        {"filters": []},
    )
    assert len(fake_signal.disconnect_calls) == 2
    assert configured.exception_filters == set()
    assert configured.django_exception_signal is None
    assert configured.django_exception_receiver is None
    assert configured.django_exception_dispatch_uid is None
    assert configured.django_response_for_exception_code is None

    # Client drop performs the same ownership-aware disconnect and clears all
    # filter state.
    drop_client, drop_peer = socket.socketpair()
    drop = NativeDapTracer()
    drop.client = drop_client
    drop.configured = True
    capture_responses(drop)
    drop._set_exception_breakpoints(
        {"seq": 5, "command": "setExceptionBreakpoints"},
        {"filters": ["djangoRequestUnhandled"]},
    )
    drop_receiver = drop.django_exception_receiver
    disconnects_before_drop = len(fake_signal.disconnect_calls)
    drop._drop_client(drop_client)
    assert len(fake_signal.disconnect_calls) == disconnects_before_drop + 1
    assert fake_signal.disconnect_calls[-1][0] is drop_receiver
    assert drop.exception_filters == set()
    assert drop.django_exception_signal is None
    assert drop.django_exception_receiver is None
    drop_peer.close()

    # Even a hostile Signal.disconnect cannot leak through shutdown. The stale
    # receiver remains inert because shutdown clears enabled/configured/filter
    # state before returning.
    shutdown = NativeDapTracer()
    shutdown.configured = True
    capture_responses(shutdown)
    shutdown._set_exception_breakpoints(
        {"seq": 6, "command": "setExceptionBreakpoints"},
        {"filters": ["djangoRequestUnhandled"]},
    )
    shutdown_receiver = shutdown.django_exception_receiver
    fake_signal.raise_disconnect = True
    disconnects_before_shutdown = len(fake_signal.disconnect_calls)
    shutdown._shutdown()
    assert len(fake_signal.disconnect_calls) == disconnects_before_shutdown + 1
    assert shutdown.enabled is False and shutdown.configured is False
    assert shutdown.exception_filters == set()
    assert shutdown.django_exception_signal is None
    assert shutdown.django_exception_receiver is None
    assert shutdown_receiver(request=object()) is None
finally:
    for name, module in original_modules.items():
        if module is missing:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = module

print("DJANGO_SIGNAL_SAFE")
`;
    const { stdout } = await execFileAsync(
      python,
      ['-c', script, path.join(projectRoot(), 'python')],
      { env: cleanPythonEnv(), timeout: 10_000 },
    );
    assert.match(stdout, /DJANGO_SIGNAL_SAFE/);
  });

  it('counts hits atomically and renders logpoints without application hooks', async function () {
    const python = await findSystemPython();
    if (!python) {
      this.skip();
      return;
    }

    const script = String.raw`
import queue
import os
import socket
import sys
import threading
import time
sys.path.insert(0, sys.argv[1])
from django_process_debugger_tracer import (
    BreakpointMatch,
    BreakpointSpec,
    HitCondition,
    NativeDapTracer,
    _LOG_QUEUE_STOP,
    _MAX_PENDING_LOG_SUMMARIES,
)

expected = {
    "1": [1],
    "== 2": [2],
    "> 2": [3, 4, 5, 6],
    ">= 2": [2, 3, 4, 5, 6],
    "< 3": [1, 2],
    "<= 3": [1, 2, 3],
    "% 2": [2, 4, 6],
}
for expression, hits in expected.items():
    condition = NativeDapTracer._parse_hit_condition(expression)
    assert [count for count in range(1, 7) if condition.matches(count)] == hits
for invalid in ("", "0", "% 0", "-1", "1 or 2", "@HIT@ == 2"):
    try:
        NativeDapTracer._parse_hit_condition(invalid)
    except ValueError:
        pass
    else:
        raise AssertionError("invalid hit condition accepted: {!r}".format(invalid))

tracer = NativeDapTracer()
filename = "/atomic-hit-test.py"
spec = BreakpointSpec(17, 1, hit_condition=HitCondition("==", 1000))
table = {line: (spec,) for line in range(1, 10000)}
tracer.breakpoints[filename] = table
matched = []
matched_lock = threading.Lock()

def hit_many():
    for _ in range(100):
        result = tracer._breakpoint_match(sys._getframe(), filename)
        if result is not None:
            with matched_lock:
                matched.extend(result.breakpoint_ids)

threads = [threading.Thread(target=hit_many) for _ in range(10)]
for thread in threads:
    thread.start()
for thread in threads:
    thread.join()
assert matched == [17], matched
assert tracer.breakpoint_hit_counts[17] == 1000

false_spec = BreakpointSpec(
    18,
    1,
    condition="False",
    code=compile("False", "<false condition>", "eval"),
    hit_condition=HitCondition("==", 1),
)
false_table = {line: (false_spec,) for line in range(1, 10000)}
tracer.breakpoints[filename] = false_table
for _ in range(10):
    assert tracer._breakpoint_match(sys._getframe(), filename) is None
assert tracer.breakpoint_hit_counts.get(18, 0) == 0

# A one-line function emits call and line events at the same source location.
# That pair is one logical breakpoint hit, not two.
dedup = NativeDapTracer()
dedup.configured = True
dedup.client = object()
one_line_filename = "/one-line-hit-test.py"
normalized_one_line = os.path.normcase(os.path.realpath(one_line_filename))
dedup_spec = BreakpointSpec(19, 1, hit_condition=HitCondition("==", 2))
dedup.breakpoints[normalized_one_line] = {1: (dedup_spec,)}
dedup_pauses = []
dedup._pause = lambda *args, **kwargs: dedup_pauses.append(kwargs["breakpoint_match"])

def feed_one_line(frame, event, arg):
    if frame.f_code.co_name == "one_line":
        dedup._trace(frame, event, arg)
    return feed_one_line

one_line_namespace = {}
exec(compile("def one_line(): return 1\none_line()\none_line()\n", one_line_filename, "exec"), one_line_namespace)
previous_trace = sys.gettrace()
sys.settrace(feed_one_line)
try:
    one_line_namespace["one_line"]()
    one_line_namespace["one_line"]()
finally:
    sys.settrace(previous_trace)
assert dedup.breakpoint_hit_counts[19] == 2
assert len(dedup_pauses) == 1
assert dedup_pauses[0].breakpoint_ids == (19,)

# A logpoint-only match may coincide with an active step, but its replaceable
# breakpoint snapshot must not become the guard for the independent step stop.
step_log = NativeDapTracer()
step_log.configured = True
step_log.client = object()
step_frame = sys._getframe()
step_filename = os.path.normcase(os.path.realpath(step_frame.f_code.co_filename))
step_spec = BreakpointSpec(22, 1, log_parts=())
step_log.breakpoints[step_filename] = {
    line: (step_spec,) for line in range(1, 10000)
}
step_log._ensure_thread_identity(threading.get_ident(), threading.current_thread())
step_log.steps[threading.get_ident()] = ("stepIn", 0)
step_log._queue_breakpoint_logs = lambda *args, **kwargs: None
step_pauses = []
step_log._pause = lambda *args, **kwargs: step_pauses.append((args, kwargs))
step_log._trace(step_frame, "line", None)
assert len(step_pauses) == 1
assert step_pauses[0][0][2] == "step"
assert step_pauses[0][1]["breakpoint_match"] is None

resetter = NativeDapTracer()
responses = []
resetter._response = lambda request, body=None, **kwargs: responses.append(body) or True
source_file = sys.modules["django_process_debugger_tracer"].__file__
source_args = {
    "source": {"path": source_file},
    "breakpoints": [{"line": 1, "hitCondition": "2"}],
}
resetter._set_breakpoints({"seq": 1, "command": "setBreakpoints"}, source_args)
normalized_source = os.path.normcase(os.path.realpath(source_file))
old_spec = next(iter(resetter.breakpoints[normalized_source].values()))[0]
resetter.breakpoint_hit_counts[old_spec.breakpoint_id] = 1
resetter._set_breakpoints({"seq": 2, "command": "setBreakpoints"}, source_args)
new_spec = next(iter(resetter.breakpoints[normalized_source].values()))[0]
assert new_spec.breakpoint_id != old_spec.breakpoint_id
assert old_spec.breakpoint_id not in resetter.breakpoint_hit_counts
assert resetter.breakpoint_hit_counts[new_spec.breakpoint_id] == 0
resetter._set_breakpoints(
    {"seq": 3, "command": "setBreakpoints"},
    {"source": {"path": source_file}, "breakpoints": []},
)
assert normalized_source not in resetter.breakpoints
assert not resetter.breakpoint_hit_counts
resetter._set_breakpoints(
    {"seq": 4, "command": "setBreakpoints"},
    {
        "source": {"path": source_file},
        "breakpoints": [
            {"line": 1, "hitCondition": 2},
            {"line": 1, "hitCondition": "1" * 129},
            {"line": 1, "logMessage": 7},
        ],
    },
)
invalid_rows = responses[-1]["breakpoints"]
assert [row["verified"] for row in invalid_rows] == [False, False, False]
assert "string" in invalid_rows[0]["message"].lower()
assert "invalid hit condition" in invalid_rows[1]["message"].lower()
assert "string" in invalid_rows[2]["message"].lower()

calls = []
class Trap:
    def __init__(self):
        self.state = "ready"
    def __repr__(self):
        calls.append("repr")
        raise AssertionError("repr ran")
    def __str__(self):
        calls.append("str")
        raise AssertionError("str ran")
    @property
    def computed(self):
        calls.append("property")
        raise AssertionError("property ran")

trap = Trap()
parts = NativeDapTracer._compile_log_message(
    "literal={{ok}} nested={ {'value': [1, {'deep': 2}]} } "
    "trap={trap} error={(_ for _ in ()).throw(SystemExit('stop'))}",
    "test",
)
rendered = NativeDapTracer._render_log_message(parts, sys._getframe())
assert "literal={ok}" in rendered, rendered
assert "nested={'value': [1, <dict len=1>]}" in rendered, rendered
assert "trap=<Trap state='ready'>" in rendered, rendered
assert "error=<evaluation raised SystemExit>" in rendered, rendered
assert not calls, calls

first_placeholder_started = threading.Event()
release_first_placeholder = threading.Event()
later_placeholder_calls = []
render_is_current = [True]

def blocking_placeholder():
    first_placeholder_started.set()
    release_first_placeholder.wait(2)
    return 1

def later_placeholder():
    later_placeholder_calls.append(True)
    return 2

stale_parts = NativeDapTracer._compile_log_message(
    "first={blocking_placeholder()} second={later_placeholder()}",
    "stale-test",
)
stale_render_result = []
render_frame = sys._getframe()

def render_stale_logpoint():
    stale_render_result.append(
        NativeDapTracer._render_log_message(
            stale_parts,
            render_frame,
            lambda: render_is_current[0],
        )
    )

render_thread = threading.Thread(target=render_stale_logpoint)
render_thread.start()
assert first_placeholder_started.wait(1)
render_is_current[0] = False
release_first_placeholder.set()
render_thread.join(2)
assert not render_thread.is_alive()
assert stale_render_result == [None], stale_render_result
assert not later_placeholder_calls, later_placeholder_calls

dangerous_exception = type("Dangerous\nName", (BaseException,), {})
dangerous_code = compile(
    "(_ for _ in ()).throw(dangerous_exception())",
    "<dangerous condition>",
    "eval",
)
diagnostic_tracer = NativeDapTracer()
diagnostic_filename = "/diagnostic-test.py"
diagnostic_specs = (
    BreakpointSpec(20, 1, code=dangerous_code, log_parts=()),
    BreakpointSpec(21, 1, code=dangerous_code),
)
diagnostic_table = {line: diagnostic_specs for line in range(1, 10000)}
diagnostic_tracer.breakpoints[diagnostic_filename] = diagnostic_table
diagnostic_match = diagnostic_tracer._breakpoint_match(
    sys._getframe(),
    diagnostic_filename,
)
assert diagnostic_match is not None
assert diagnostic_match.breakpoint_ids == (21,)
assert "Dangerous\\nName" in diagnostic_match.log_outputs[0]
assert "Dangerous\\nName" in diagnostic_match.description

escaped = NativeDapTracer._render_log_message(
    NativeDapTracer._compile_log_message("control=\x1b\n surrogate=\ud800", "test"),
    sys._getframe(),
)
assert "\\x1b\\n" in escaped, escaped
assert "\\ud800" in escaped, escaped
for invalid in ("{}", "value={1", "value=1}", "value={1 + }"):
    try:
        NativeDapTracer._compile_log_message(invalid, "test")
    except (SyntaxError, ValueError):
        pass
    else:
        raise AssertionError("invalid log message accepted: {!r}".format(invalid))

# A saturated output queue must never block the traced application thread.
queued = NativeDapTracer()
client, peer = socket.socketpair()
queued.client = client
queued.configured = True
queued.log_queue = queue.Queue(maxsize=1)
queued.log_queue.put_nowait(object())
log_table = {1: ()}
queued.breakpoints[filename] = log_table
log_match = BreakpointMatch(filename, log_table, (), None, ("message",))
started = time.monotonic()
queued._queue_breakpoint_logs(log_match, sys._getframe(), client)
elapsed = time.monotonic() - started
assert elapsed < 0.1, elapsed
assert queued.dropped_log_events == 1

# The sender reports a final overflow burst before the next queued message,
# without consuming the queue slot needed by that real message.
queued.log_queue = queue.Queue(maxsize=1)
queued_events = []
queued._event = lambda name, body, **kwargs: queued_events.append(body) or True
queued._queue_breakpoint_logs(log_match, sys._getframe(), client)
sender = threading.Thread(target=queued._send_log_events)
sender.start()
deadline = time.monotonic() + 1
while len(queued_events) < 2 and time.monotonic() < deadline:
    time.sleep(0.01)
queued.log_queue.put_nowait(_LOG_QUEUE_STOP)
sender.join(1)
assert not sender.is_alive()
assert "dropped 1 logpoint messages" in queued_events[0]["output"]
assert queued_events[1]["output"] == "message\n"
assert queued.dropped_log_events == 0
client.close()
peer.close()

# A stale queued generation cannot consume the overflow summary belonging to
# the current generation that was dropped behind it.
generation_queue = NativeDapTracer()
generation_client, generation_peer = socket.socketpair()
generation_queue.client = generation_client
generation_queue.configured = True
generation_queue.log_queue = queue.Queue(maxsize=1)
old_generation_table = {1: ()}
new_generation_table = {1: ()}
generation_queue.breakpoints[filename] = old_generation_table
generation_queue._queue_breakpoint_logs(
    BreakpointMatch(filename, old_generation_table, (), None, ("old",)),
    sys._getframe(),
    generation_client,
)
generation_queue.breakpoints[filename] = new_generation_table
generation_queue._queue_breakpoint_logs(
    BreakpointMatch(filename, new_generation_table, (), None, ("new",)),
    sys._getframe(),
    generation_client,
)
assert generation_queue.dropped_log_events == 1
generation_events = []

def capture_current_generation(name, body, **kwargs):
    guard = kwargs.get("guard")
    if guard is not None and not guard():
        return False
    generation_events.append(body)
    return True

generation_queue._event = capture_current_generation
generation_sender = threading.Thread(target=generation_queue._send_log_events)
generation_sender.start()
deadline = time.monotonic() + 1
while not generation_events and time.monotonic() < deadline:
    time.sleep(0.01)
generation_queue.log_queue.put_nowait(_LOG_QUEUE_STOP)
generation_sender.join(1)
assert len(generation_events) == 1, generation_events
assert "dropped 1 logpoint messages" in generation_events[0]["output"]
generation_client.close()
generation_peer.close()

# An event already in the queue is still discarded if its source table is
# replaced before the sender writes it to the old client.
stale_queue = NativeDapTracer()
stale_client, stale_peer = socket.socketpair()
stale_peer.settimeout(0.1)
stale_queue.client = stale_client
stale_queue.configured = True
stale_queue.breakpoints[filename] = log_table
stale_queue._queue_breakpoint_logs(log_match, sys._getframe(), stale_client)
assert stale_queue.log_queue.qsize() == 1
stale_queue.breakpoints[filename] = {1: ()}
stale_sender = threading.Thread(target=stale_queue._send_log_events)
stale_sender.start()
deadline = time.monotonic() + 1
while not stale_queue.log_queue.empty() and time.monotonic() < deadline:
    time.sleep(0.01)
stale_queue.log_queue.put_nowait(_LOG_QUEUE_STOP)
stale_sender.join(1)
assert not stale_sender.is_alive()
try:
    stale_peer.recv(1)
except socket.timeout:
    pass
else:
    raise AssertionError("stale queued logpoint output reached the client")
stale_client.close()
stale_peer.close()

# Repeated source generations cannot turn the bounded queue's drop metadata
# into an unbounded table/socket retention path.
bounded_queue = NativeDapTracer()
bounded_client, bounded_peer = socket.socketpair()
bounded_queue.client = bounded_client
bounded_queue.configured = True
bounded_queue.log_queue = queue.Queue(maxsize=1)
bounded_queue.log_queue.put_nowait(object())
for generation in range(_MAX_PENDING_LOG_SUMMARIES * 3):
    generation_table = {1: ()}
    bounded_queue.breakpoints[filename] = generation_table
    bounded_queue._queue_breakpoint_logs(
        BreakpointMatch(filename, generation_table, (), None, (str(generation),)),
        sys._getframe(),
        bounded_client,
    )
assert len(bounded_queue.dropped_log_summaries) <= _MAX_PENDING_LOG_SUMMARIES
assert bounded_queue.dropped_log_events == _MAX_PENDING_LOG_SUMMARIES * 3
bounded_client.close()
bounded_peer.close()
print("HITS_AND_LOGS_SAFE")
`;
    const { stdout } = await execFileAsync(
      python,
      ['-c', script, path.join(projectRoot(), 'python')],
      { env: cleanPythonEnv(), timeout: 15_000 },
    );
    assert.match(stdout, /HITS_AND_LOGS_SAFE/);
  });
});
