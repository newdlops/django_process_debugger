"""Fixture that captures references to views in the two patterns that
real Django/ASGI apps use:

  URLCONF   — dict of callable (mirrors Django's `path(..., view_func)` flow
              where the view function is stored in the URL resolver).
              This pattern exposes a hot-reload LIMITATION: the dict holds
              the OLD function object, so `URLCONF['/']()` keeps returning
              old values even after reload of views.py.

  SAVED_CLASS — direct reference to a class (mirrors `path(..., MyView.as_view())`
              where the class survives in the resolver). Deep-reload patches
              methods in place, so `SAVED_CLASS().get()` DOES see updates.

  MODULE    — reference to the views module object itself. `MODULE.greet()`
              follows the rebinding done by `importlib.reload`, so it DOES
              see updates.
"""
from sampleapp import views
from sampleapp.views import greet, IndexView

URLCONF = {
    '/': greet,              # captured function reference — stale after reload
}
SAVED_CLASS = IndexView      # captured class reference — patched in place
MODULE = views               # module ref — live after reload


def call_urlconf() -> str:
    return URLCONF['/']()


def call_saved_class() -> str:
    return SAVED_CLASS().get()


def call_module_fn() -> str:
    return MODULE.greet()
