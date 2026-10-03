"""Incompressible Flow's material model (materials.py): the Fluid picker's presets.

The presets are the one copy of each fluid's values: the core's Materials panel
and POST /api/materials read them from the registry. A saved record keeps its
own numbers; one without them reads LEGACY_AIR, what older versions filled in.
"""

from __future__ import annotations

import json

import pytest
from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.discovery import get_hub
from magnusim_sdk.fluids import LIBRARY, NU_AIR, RHO_AIR

from incompressible_flow import materials, results
from incompressible_flow.runspec import air_from_materials

# (key, name, nu m^2/s, rho kg/m^3, library code) at 20 C, 1 atm, in picker order.
PRESETS = [
    ("air", "Air", 1.516e-5, 1.204, "AIR"),
    ("argon", "Argon", 1.34e-5, 1.661, "ARGON"),
    ("co2", "Carbon dioxide", 8.03e-6, 1.842, "CO2"),
    ("hydrogen", "Hydrogen", 1.05e-4, 0.0838, "HYDROGEN"),
    ("nitrogen", "Nitrogen", 1.51e-5, 1.165, "NITROGEN"),
    ("water", "Water", 1.004e-6, 998.2, "WATER"),
    ("seawater", "Seawater (3.5% saline)", 1.05e-6, 1025.0, "SEAWATER"),
    ("custom", "Custom fluid", 1.516e-5, 1.204, "CUSTOM"),
]


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def test_presets_are_the_fluids_at_20c_in_picker_order():
    got = [
        (p["key"], p["name"], p["values"]["nu"], p["values"]["rho"], p["library"])
        for p in materials.PRESETS
    ]
    assert got == PRESETS
    assert materials.AIR == {"nu": 1.516e-5, "rho": 1.204}
    assert materials.preset("air")["codes"] == ("AIR", "DEFAULT")
    assert materials.preset("water")["values"] == {"nu": 1.004e-6, "rho": 998.2}
    codes = [c for p in materials.PRESETS for c in p["codes"]]
    assert len(codes) == len(set(codes)), "a library code names one preset"
    names = [n.lower() for p in materials.PRESETS for n in p["names"]]
    assert len(names) == len(set(names)), "a name names one preset"
    assert materials.preset("custom")["names"] == ()


def test_legacy_air_is_frozen():
    # Older projects' records without numbers solve with these; never change them.
    assert materials.LEGACY_AIR == {"nu": 1.529e-5, "rho": 1.196}
    assert materials.preset("air")["legacy_values"] == materials.LEGACY_AIR
    assert materials.preset("custom")["legacy_values"] == materials.LEGACY_AIR
    assert "legacy_values" not in materials.preset("water")
    assert results.DEFAULT_RHO == 1.196


def test_sdk_library_agrees_with_the_presets():
    assert (NU_AIR, RHO_AIR) == (1.516e-5, 1.204)
    for m in LIBRARY:
        p = materials.preset(m.key)
        assert (m.name, m.nu, m.rho) == (p["name"], p["values"]["nu"], p["values"]["rho"]), m.key
    assert [m.key for m in LIBRARY] == [p["key"] for p in materials.PRESETS]


def test_describe_row_has_schema_library_and_record_shape():
    rows = {row["key"]: row for row in get_hub().registry("material").describe()}
    row = rows["newtonian_incompressible"]
    json.dumps(row)
    props = row["schema"]["properties"]
    assert props["nu"]["default"] == 1.516e-5
    assert props["nu"]["x-cfddesk"]["quantity"] == "kinematic_viscosity"
    assert props["rho"]["default"] == 1.204
    assert props["rho"]["x-cfddesk"]["quantity"] == "density"
    assert [p["key"] for p in row["library"]] == [p[0] for p in PRESETS]
    air = row["library"][0]
    assert air["values"] == {"nu": 1.516e-5, "rho": 1.204}
    assert air["codes"] == ["AIR", "DEFAULT"]
    assert air["legacy_values"] == {"nu": 1.529e-5, "rho": 1.196}
    assert row["record_keys"] == {"nu": ["kinematic_viscosity", "nu"], "rho": ["density", "rho"]}
    assert row["record_constants"]["viscosity_model"] == "Newtonian"
    assert row["custom_preset"] == "custom"


def _mats(rec: dict) -> dict:
    return {"materials": [{"id": "m1", "simulation_id": "s1", "assigned_volumes": ["Body1"], **rec}]}


def test_a_saved_record_keeps_its_numbers():
    air = air_from_materials(_mats({"name": "Air", "kinematic_viscosity": 1.529e-5, "density": 1.196}), "s1")
    assert (air["nu"], air["rho"]) == (1.529e-5, 1.196)
    air = air_from_materials(_mats({"name": "Air", "kinematic_viscosity": 1.516e-5, "density": 1.204}), "s1")
    assert (air["nu"], air["rho"]) == (1.516e-5, 1.204)


def test_a_record_without_numbers_reads_legacy_air():
    # What older versions solved such a record with: unchanged by the new Air.
    air = air_from_materials(_mats({"name": "Air", "library": "DEFAULT"}), "s1")
    assert (air["nu"], air["rho"]) == (1.529e-5, 1.196)
    air = air_from_materials(_mats({"name": "Air", "kinematic_viscosity": 2e-5}), "s1")
    assert (air["nu"], air["rho"]) == (2e-5, 1.196)


def test_the_core_materials_mirror_reads_these_record_keys():
    # The materials.json mirror keeps each property under the model's record keys;
    # its fallback (no model loaded) is these same keys.
    from cfddesk.project.web_mirrors import materials as mirror

    assert mirror.record_keys() == materials.RECORD_KEYS
    assert mirror.record_keys("newtonian_incompressible") == materials.RECORD_KEYS
    assert mirror._FALLBACK_RECORD_KEYS == materials.RECORD_KEYS
