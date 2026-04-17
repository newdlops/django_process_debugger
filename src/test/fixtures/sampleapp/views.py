"""Reloadable fixture module for hot-reload E2E tests.

Each function/method embeds its version directly in the body so that edits
change the compiled __code__ object. This isolates three reload scenarios:
  - top-level function (captured references see OLD code unless rebound)
  - class-based view method (deep-reload patches __code__ in place)
  - async handler (captured coroutines run OLD code; new calls see new code)

GREETING is kept as a top-level constant to demonstrate the by-value capture
limitation (see hotReloadCycle.test.ts).
"""

GREETING = 'hello v1'


def greet() -> str:
    return 'direct v1'


class IndexView:
    def get(self) -> str:
        return 'IndexView.get v1'


async def handle() -> str:
    return 'handle v1'
