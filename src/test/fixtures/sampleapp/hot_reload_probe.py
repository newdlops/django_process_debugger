"""Probe module used by the experimental hot-reload bootstrap E2E test."""

import os
import sys


_marker_path = os.environ.get("DPD_EXPERIMENTAL_HOT_RELOAD_PROBE")
if _marker_path:
    with open(_marker_path, "w", encoding="utf-8") as _marker_file:
        _marker_file.write(
            "untraced" if sys.gettrace() is None else "traced"
        )


def probe_value() -> str:
    return "experimental hot reload probe"
