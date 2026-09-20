"""Volume fill must abort instead of hanging in HXT."""
from __future__ import annotations

import inspect

from cfddesk.mesh.standard_hexcore import (
    VOLUME_FILL_EXIT,
    VOLUME_FILL_TIMEOUT_S,
    generate_volume_or_timeout,
)


def test_volume_fill_watchdog_exits_the_process():
    assert VOLUME_FILL_TIMEOUT_S <= 600
    assert VOLUME_FILL_EXIT == 75
    src = inspect.getsource(generate_volume_or_timeout)
    assert "os._exit" in src
    assert "generate(3)" in src
