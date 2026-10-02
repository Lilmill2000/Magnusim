"""Frozen migration values (cfddesk.project.legacy_sim) stay frozen.

Old project.json files mean what they meant when written: changing the fluids
library's air density or the BC registry's defaults must not change what a
v4..v7 file loads as.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import magnusim_sdk.fluids as fluids
import pytest

from cfddesk.project.legacy_sim import (
    V4_BC_SETTINGS,
    V7_ASSUMED_DENSITY_KG_M3,
    v4_bcs_from_roles,
)
from tests.unit.test_legacy_project_roundtrip import GOLDEN, load_case, snapshot


def _golden(name: str) -> object:
    return json.loads((GOLDEN / f"{name}.json").read_text(encoding="utf-8"))


def test_v7_assumed_density_is_frozen():
    assert V7_ASSUMED_DENSITY_KG_M3 == 1.204


@pytest.mark.parametrize("name", ["v4", "v5", "v5_recovered_run", "v6", "v7"])
def test_migration_ignores_library_air_density(
    name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    before = snapshot(*load_case(name, tmp_path / "before"))
    monkeypatch.setattr(fluids, "RHO_AIR", 999.0)
    # Any core module holding its own RHO_AIR name (an import of the library value).
    for mod_name, mod in list(sys.modules.items()):
        if mod_name.startswith("cfddesk") and hasattr(mod, "RHO_AIR"):
            monkeypatch.setattr(mod, "RHO_AIR", 999.0)
    after = snapshot(*load_case(name, tmp_path / "after"))
    assert after == before
    assert json.loads(json.dumps(after)) == _golden(name)


def test_v4_bc_settings_match_the_registry_golden():
    assert json.loads(json.dumps(V4_BC_SETTINGS)) == _golden("bc_registry_v4")


def test_v4_bcs_from_roles_fills_missing_boundary_keys():
    rows = v4_bcs_from_roles(
        [(2, "walls"), (0, "inlet"), (1, "outlet"), (3, "unassigned"), (4, "walls")],
        None,
        {"inlet": 2, "outlet": 2, "walls": 1},
    )
    assert [(r["patch_name"], r["face_ids"], r["refinement_level"]) for r in rows] == [
        ("inlet", [0], 2),
        ("outlet", [1], 2),
        ("walls", [2, 4], 1),
    ]
    inlet, outlet, walls = rows
    assert inlet["settings"]["speed_m_s"] == 0.5
    assert inlet["settings"]["direction_mode"] == "normal"
    assert inlet["settings"]["velocity"] == [-1.0, 0.0, 0.0]
    assert outlet["settings"] == {"gauge_pressure": 0.0}
    assert walls["settings"] == V4_BC_SETTINGS["wall_noslip"]
    # The frozen table is copied, never handed out.
    walls["settings"]["htc_W_m2K"] = 0.0
    assert V4_BC_SETTINGS["wall_noslip"]["htc_W_m2K"] == 10.0


def test_v4_bcs_from_roles_skips_roles_no_face_has():
    rows = v4_bcs_from_roles([(0, "walls")], {"outlet_p": 3.0}, {"inlet": 2, "outlet": 2, "walls": 1})
    assert [r["type"] for r in rows] == ["wall_noslip"]
