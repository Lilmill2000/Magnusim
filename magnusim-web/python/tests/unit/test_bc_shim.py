"""case.bc_registry and case.bc_menu are 1.x shims over the hub's BC kinds.

The BC types and families belong to Incompressible Flow (read here through the
hub, never by importing the plugin). The shim loads the registry itself, and
when the plugin is not loaded the seven stored BC type keys still have a
semantic and a patch type, so old projects still load and mesh.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from cfddesk.case import bc_menu, bc_registry
from cfddesk.case.bc_registry import _LEGACY_SEMANTICS, BC_TYPES, get_type, patch_type_for
from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.discovery import get_hub
from tests.conftest import PROJECTS

STORED_KEYS = {
    "velocity_inlet_fixed",
    "velocity_inlet_volumetric",
    "velocity_inlet_mass",
    "velocity_outlet",
    "pressure_outlet_gauge",
    "wall_noslip",
    "wall_slip",
}


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_for_tests()
    yield
    reset_for_tests()


@pytest.fixture
def without_bundled_plugins(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A hub where Incompressible Flow did not load (no bundled plugins at all)."""
    empty = tmp_path / "no-bundled"
    empty.mkdir()
    monkeypatch.setenv("MAGNUSIM_BUNDLED_DIR", str(empty))
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(tmp_path / "no-plugins"))
    reset_for_tests()
    hub = load_all(force=True)
    assert hub.registry("bc").keys() == []
    return hub


def test_get_type_works_before_load_all():
    assert get_hub().registry("bc").keys() == []
    spec = get_type("wall_noslip")
    hub = get_hub()
    assert spec is hub.registry("bc").get("wall_noslip")
    assert hub.registry("bc").owner("wall_noslip") == "incompressible_flow"
    assert (spec.semantic, spec.patch_type, spec.family) == ("wall", "wall", "wall")
    assert spec.write_U is not None


def test_bc_types_view_follows_the_hub():
    hub = load_all()
    reg = hub.registry("bc")
    assert list(BC_TYPES) == reg.keys()
    assert len(BC_TYPES) == len(reg.keys()) == 7
    assert all(BC_TYPES[k] is reg.get(k) for k in reg.keys())
    assert "no_such_bc" not in BC_TYPES and 3 not in BC_TYPES
    with pytest.raises(KeyError):
        get_type("no_such_bc")
    with pytest.raises(TypeError):
        BC_TYPES["wall_slip"] = None  # type: ignore[index]
    # A BC type another plugin registers shows up in the view.
    from dataclasses import replace

    reg.register(replace(reg.get("wall_slip"), key="fx_wall", family=""), plugin="fx")
    assert "fx_wall" in BC_TYPES and BC_TYPES["fx_wall"].key == "fx_wall"


def test_legacy_semantics_match_the_plugin_specs():
    load_all()
    assert set(_LEGACY_SEMANTICS) == STORED_KEYS
    for key, (semantic, patch_type) in _LEGACY_SEMANTICS.items():
        spec = get_hub().registry("bc").get(key)
        assert (spec.semantic, spec.patch_type) == (semantic, patch_type)


def test_legacy_semantics_cover_the_stored_keys_when_the_plugin_is_unloaded(without_bundled_plugins):
    assert set(BC_TYPES) == STORED_KEYS
    for key in STORED_KEYS:
        spec = get_type(key)
        assert (spec.semantic, spec.patch_type) == _LEGACY_SEMANTICS[key]
        assert spec.write_U is None and spec.supported is False
        assert bc_registry.default_settings(key) == {}
    assert patch_type_for("wall_slip") == "wall"
    assert patch_type_for("velocity_inlet_mass") == "patch"
    # The stored v8 menu keys still resolve, though no family is registered.
    assert bc_menu.menu_types() == []
    assert bc_menu.nested_from_legacy("velocity_inlet_mass") == ("velocity_inlet", "flow_rate", "mass")
    assert bc_menu.legacy_from_nested("wall", "slip") == "wall_slip"
    assert bc_menu.legacy_from_nested("pressure_outlet", "fixed_gauge") == "pressure_outlet_gauge"
    assert bc_menu.migrate_bc_dict({"type": "wall_slip"})["variant"] == "slip"


def test_an_old_project_still_types_its_walls_when_the_plugin_is_unloaded(without_bundled_plugins):
    from cfddesk.project.model import Project

    doc = json.loads((PROJECTS / "v13.json").read_text(encoding="utf-8"))
    project = Project.from_dict(doc)
    roles = {
        bc.name: project.role_of(bc.face_ids[0])
        for sim in project.simulations
        for bc in sim.boundary_conditions
        if bc.face_ids
    }
    assert roles and "walls" in roles.values()


_HEX_ID = re.compile(r"^[0-9a-f]{12}$")


def _normalized(doc: Any, known: str) -> Any:
    """``doc`` without its save time, and ids the load made up as ``<new id>``."""
    if isinstance(doc, dict):
        return {k: _normalized(v, known) for k, v in doc.items() if k != "updated_at"}
    if isinstance(doc, list):
        return [_normalized(v, known) for v in doc]
    if isinstance(doc, str) and _HEX_ID.match(doc) and doc not in known:
        return "<new id>"
    return doc


def _load_all_fixtures() -> dict[str, Any]:
    from cfddesk.project.model import Project

    out = {}
    for version in range(5, 16):
        text = (PROJECTS / f"v{version}.json").read_text(encoding="utf-8")
        out[f"v{version}"] = _normalized(Project.from_dict(json.loads(text)).to_dict(), text)
    return out


def _bc_parts(doc: dict[str, Any]) -> dict[str, Any]:
    """What BC types decide in a project: its BCs and its faces' BC ids."""
    return {
        "boundary_conditions": [sim.get("boundary_conditions") for sim in doc.get("simulations") or []],
        "faces": [g.get("faces") for g in doc.get("geometries") or []],
    }


def test_old_project_files_load_the_same_with_or_without_the_plugin(tmp_path, monkeypatch):
    """project.json v5..v15 give the same BCs whether the BC types come from
    Incompressible Flow or from the legacy table: stored BC keys, menu keys and
    settings never depend on the plugin being there. (The analysis type does:
    the default analysis is the plugin's.)"""
    with_plugin = _load_all_fixtures()
    assert get_hub().registry("bc").owner("wall_noslip") == "incompressible_flow"

    empty = tmp_path / "no-bundled"
    empty.mkdir()
    monkeypatch.setenv("MAGNUSIM_BUNDLED_DIR", str(empty))
    reset_for_tests()
    load_all(force=True)
    assert get_hub().registry("bc").keys() == []
    without = _load_all_fixtures()
    for name in with_plugin:
        assert _bc_parts(without[name]) == _bc_parts(with_plugin[name]), name
    assert any(any(bcs) for bcs in _bc_parts(with_plugin["v13"])["boundary_conditions"])


def test_old_project_files_round_trip_through_to_dict():
    from cfddesk.project.model import Project

    for version in range(5, 16):
        text = (PROJECTS / f"v{version}.json").read_text(encoding="utf-8")
        first = Project.from_dict(json.loads(text)).to_dict()
        again = Project.from_dict(json.loads(json.dumps(first))).to_dict()
        known = json.dumps(first)
        assert _normalized(again, known) == _normalized(first, known), f"v{version}"
