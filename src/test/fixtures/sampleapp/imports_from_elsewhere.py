"""Fixture used by the "import filter" test.

Imports several classes/functions from stdlib + another local module. The
deep-reload "patched: ..." list must NOT include any of these imports.
"""
from typing import TypedDict, cast

from sampleapp.decorated import decorate, DecoratedView


class MyConfig(TypedDict):
    name: str


def my_function() -> str:
    return 'my v1'


class MyOwnClass:
    def method(self) -> str:
        return 'method v1'


__all__ = [
    'MyConfig',
    'my_function',
    'MyOwnClass',
    # Re-exported imports — these SHOULD still be skipped by the filter.
    'cast',
    'TypedDict',
    'decorate',
    'DecoratedView',
]
