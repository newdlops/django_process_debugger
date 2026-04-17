"""Fixture exercising the decorator-unwrap scenario surfaced in log.txt.

The real-world case (from the user's Django+GraphQL app):
  @company_owner_required
  @login_required
  def resolve_xxx(self, info, **data):
      ...

When the module is reloaded, a fresh wrapper is built around a fresh inner
function. But any outside holder of the OLD wrapper (e.g. the GraphQL schema's
resolver map) still calls the OLD wrapper, whose closure captures the OLD
inner function. Without __wrapped__-chain unwrap, patching the wrapper's
__code__ is useless — the closure still points at the pre-reload code.

This fixture reproduces that shape with a minimal decorator that uses
functools.wraps (so __wrapped__ is set).
"""
import functools


def decorate(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        return fn(*args, **kwargs)
    return wrapper


class DecoratedView:
    @decorate
    def render(self) -> str:
        return 'render v1'


@decorate
def top_level() -> str:
    return 'top v1'
