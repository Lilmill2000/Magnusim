
"""Fixture-based Project.from_dict migrations v5..v13."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from cfddesk.project.model import PROJECT_VERSION, Project

from tests.conftest import PROJECTS


@pytest.mark.parametrize("ver", list(range(5, 14)))
def test_migrate_to_v13(ver):
    path = PROJECTS / f"v{ver}.json"
    if not path.is_file():
        pytest.skip(f"missing {path.name}")
    doc = json.loads(path.read_text(encoding="utf-8"))
    proj = Project.from_dict(doc)
    assert proj.version == PROJECT_VERSION
    assert proj.scale_to_metres > 0
    # v12+: numerics seeded
    if ver < 12:
        assert proj.numerics_settings() is not None
    # pressures stored as Pa on BCs after v7 upgrade
    for bc in proj.boundary_conditions:
        settings = bc.settings or {}
        for key in ("gauge_pressure", "pressure", "total_pressure"):
            if key in settings:
                assert isinstance(settings[key], (int, float))
