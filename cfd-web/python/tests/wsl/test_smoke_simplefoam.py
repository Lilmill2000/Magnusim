"""WSL smoke — deselected by default (``pytest -m 'not wsl'``)."""
from __future__ import annotations

import pytest

from cfddesk.wsl.openfoam import smoke_simplefoam

pytestmark = pytest.mark.wsl


def test_simplefoam_help():
    result = smoke_simplefoam()
    text = f"{result.stdout}\n{result.stderr}"
    assert result.returncode == 0, text
    lowered = text.lower()
    assert "simplefoam" in lowered or "usage" in lowered
