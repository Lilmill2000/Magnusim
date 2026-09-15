
"""Fixture-based Project.from_dict migrations v5..v13 → current PROJECT_VERSION."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from cfddesk.project.model import (
    PROJECT_VERSION,
    Project,
    _mesh_input_fingerprint_v9_quantize,
    _upgrade_to_v10,
)

from tests.conftest import PROJECTS


@pytest.mark.parametrize("ver", list(range(5, 14)))
def test_migrate_to_current(ver):
    path = PROJECTS / f"v{ver}.json"
    assert path.is_file(), f"missing migration fixture {path.name}"
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


def test_v10_does_not_restamp_fingerprint():
    """v10 adds block_aabb to the live formula but must not rewrite stored stamps."""
    doc = json.loads((PROJECTS / "v13.json").read_text(encoding="utf-8"))
    proj = Project.from_dict(doc)
    v9_fp = _mesh_input_fingerprint_v9_quantize(proj)
    current_fp = proj.mesh_input_fingerprint()
    assert v9_fp != current_fp
    stamped = proj.with_mesh_fingerprint(v9_fp)
    after = _upgrade_to_v10(stamped)
    assert after.mesh_fingerprint_at_last_mesh == v9_fp
    assert after.mesh_input_fingerprint() == current_fp
