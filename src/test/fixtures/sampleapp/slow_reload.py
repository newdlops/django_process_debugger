"""Module whose second execution models a slow import during hot reload."""

import time


if globals().get("_loaded_once"):
    time.sleep(3.4)

_loaded_once = True


def value() -> str:
    return "slow reload complete"
