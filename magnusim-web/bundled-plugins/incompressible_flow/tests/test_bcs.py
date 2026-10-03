"""Incompressible Flow's BC types and families (bcs.py).

The resolve table pins what the core's web_bc_to_registry returned before the
BC types moved into this plugin: the same key and SI settings for every record.
"""

from __future__ import annotations

import json
import math

import pytest
from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.bc import BC_COLORS
from cfddesk.registry.discovery import get_hub

from incompressible_flow import bcs

CUBE = "\N{SUPERSCRIPT THREE}"
V = "Velocity inlet"

# (name, record, key, settings): web_bc_to_registry's answers at the move.
RESOLVE_TABLE = [
    ("fixed normal m/s", {"bc_type": V, "velocity_type": "Fixed", "value": 5, "unit": "m/s", "direction": "Normal to face", "vector": [0, 0, 1]}, "velocity_inlet_fixed", {"direction_mode": "normal", "speed": 5.0}),
    ("fixed normal ft/s", {"bc_type": V, "velocity_type": "Fixed", "value": 10, "unit": "ft/s", "direction": "Normal to face"}, "velocity_inlet_fixed", {"direction_mode": "normal", "speed": 3.048}),
    ("fixed normal ft/min", {"bc_type": V, "velocity_type": "Fixed", "value": 600, "unit": "ft/min"}, "velocity_inlet_fixed", {"direction_mode": "normal", "speed": 3.048}),
    ("fixed, no unit", {"bc_type": V, "velocity_type": "Fixed", "value": 7}, "velocity_inlet_fixed", {"direction_mode": "normal", "speed": 7.0}),
    ("fixed, no value", {"bc_type": V, "velocity_type": "Fixed", "unit": "m/s"}, "velocity_inlet_fixed", {"direction_mode": "normal", "speed": 1.0}),
    ("fixed, unknown unit", {"bc_type": V, "velocity_type": "Fixed", "value": 4, "unit": "furlong/s"}, "velocity_inlet_fixed", {"direction_mode": "normal", "speed": 4.0}),
    ("fixed vector", {"bc_type": V, "velocity_type": "Fixed", "value": 3, "unit": "m/s", "direction": "Vector", "vector": [1, 2, 2]}, "velocity_inlet_fixed", {"direction_mode": "vector", "velocity": [1.0, 2.0, 2.0]}),
    ("fixed zero vector", {"bc_type": V, "velocity_type": "Fixed", "value": 3, "unit": "m/s", "direction": "Vector", "vector": [0, 0, 0]}, "velocity_inlet_fixed", {"direction_mode": "vector", "velocity": [0.0, 0.0, 0.0]}),
    ("CFM (ft3/min, superscript)", {"bc_type": V, "velocity_type": "Flow rate", "flow_rate_type": "Volumetric flow", "value": 100, "unit": f"ft{CUBE}/min"}, "velocity_inlet_volumetric", {"volumetric_flow_rate": 0.047194745}),
    ("CFM (ft3/min, ascii)", {"bc_type": V, "velocity_type": "Flow rate", "flow_rate_type": "Volumetric flow", "value": 100, "unit": "ft3/min"}, "velocity_inlet_volumetric", {"volumetric_flow_rate": 0.047194745}),
    ("CFM", {"bc_type": V, "velocity_type": "Flow rate", "flow_rate_type": "Volumetric flow", "value": 100, "unit": "CFM"}, "velocity_inlet_volumetric", {"volumetric_flow_rate": 0.047194745}),
    ("m3/s", {"bc_type": V, "velocity_type": "Flow rate", "flow_rate_type": "Volumetric flow", "value": 0.01, "unit": f"m{CUBE}/s"}, "velocity_inlet_volumetric", {"volumetric_flow_rate": 0.01}),
    ("m3/h, ascii", {"bc_type": V, "velocity_type": "Flow rate", "value": 36, "unit": "m3/h"}, "velocity_inlet_volumetric", {"volumetric_flow_rate": 0.01}),
    ("kg/s", {"bc_type": V, "velocity_type": "Flow rate", "flow_rate_type": "Mass flow", "value": 0.5, "unit": "kg/s"}, "velocity_inlet_mass", {"mass_flow_rate": 0.5}),
    ("lb/s", {"bc_type": V, "velocity_type": "Flow rate", "flow_rate_type": "Mass flow", "value": 1, "unit": "lb/s"}, "velocity_inlet_mass", {"mass_flow_rate": 0.45359237}),
    # A mass unit on a Fixed record reads as a volumetric flow of the bare number.
    ("kg/s unit on a fixed record", {"bc_type": V, "velocity_type": "Fixed", "value": 2, "unit": "kg/s"}, "velocity_inlet_volumetric", {"volumetric_flow_rate": 2.0}),
    ("flow rate, no value", {"bc_type": V, "velocity_type": "Flow rate", "flow_rate_type": "Volumetric flow", "unit": f"m{CUBE}/s"}, "velocity_inlet_volumetric", {"volumetric_flow_rate": 0.0}),
    ("lower-case type", {"bc_type": "velocity inlet", "value": 2, "unit": "m/s"}, "velocity_inlet_fixed", {"direction_mode": "normal", "speed": 2.0}),
    ("velocity outlet", {"bc_type": "Velocity outlet", "velocity_type": "Fixed", "value": 5, "unit": "m/s"}, "velocity_outlet", {}),
    ("pressure Pa", {"bc_type": "Pressure", "pressure_type": "Fixed value", "value": 101, "unit": "Pa"}, "pressure_outlet_gauge", {"gauge_pressure": 101.0}),
    ("pressure psi", {"bc_type": "Pressure", "pressure_type": "Fixed value", "value": 2, "unit": "psi"}, "pressure_outlet_gauge", {"gauge_pressure": 13789.514586336}),
    ("pressure kPa", {"bc_type": "Pressure", "value": 1.5, "unit": "kPa"}, "pressure_outlet_gauge", {"gauge_pressure": 1500.0}),
    ("pressure, no value", {"bc_type": "Pressure", "unit": "Pa"}, "pressure_outlet_gauge", {"gauge_pressure": 0.0}),
    ("Pressure outlet alias", {"bc_type": "Pressure outlet", "value": 3, "unit": "Pa"}, "pressure_outlet_gauge", {"gauge_pressure": 3.0}),
    ("Pressure inlet alias, psi", {"bc_type": "Pressure inlet", "value": 1, "unit": "psi"}, "pressure_outlet_gauge", {"gauge_pressure": 6894.757293168}),
    ("no-slip wall", {"bc_type": "Wall", "wall_type": "No-slip"}, "wall_noslip", {}),
    ("slip wall", {"bc_type": "Wall", "wall_type": "Slip"}, "wall_slip", {}),
    ("slip wall, lower case", {"bc_type": "wall", "wall_type": "slip"}, "wall_slip", {}),
    ("no_slip wall", {"bc_type": "Wall", "wall_type": "no_slip"}, "wall_noslip", {}),
    ("wall, no type", {"bc_type": "Wall"}, "wall_noslip", {}),
    ("Slip wall alias (type not read)", {"bc_type": "Slip wall", "wall_type": "Slip"}, "wall_noslip", {}),
    ("No-slip wall alias", {"bc_type": "No-slip wall"}, "wall_noslip", {}),
    ("unknown type -> wall", {"bc_type": "Symmetry"}, "wall_noslip", {}),
    ("empty record -> wall", {}, "wall_noslip", {}),
]

STORED_KEYS = (
    "velocity_inlet_fixed",
    "velocity_inlet_volumetric",
    "velocity_inlet_mass",
    "velocity_outlet",
    "pressure_outlet_gauge",
    "wall_noslip",
    "wall_slip",
)


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _family(key: str):
    return get_hub().registry("bc_family").get(key)


@pytest.mark.parametrize(("name", "record", "key", "settings"), RESOLVE_TABLE, ids=[r[0] for r in RESOLVE_TABLE])
def test_resolve_matches_the_core_mapping_it_replaced(name, record, key, settings):
    assert bcs.resolve_record(dict(record)) == (key, settings)
    # Every family resolves through the same mapping.
    for fam in bcs.BC_FAMILIES:
        assert fam.resolve(dict(record)) == (key, settings)


@pytest.mark.parametrize(("name", "record", "key", "settings"), RESOLVE_TABLE, ids=[r[0] for r in RESOLVE_TABLE])
def test_the_core_dispatches_records_to_these_families(name, record, key, settings):
    from cfddesk.project.web_adapter import web_bc_to_registry

    assert web_bc_to_registry(dict(record)) == (key, settings)


def test_a_non_finite_direction_vector_is_refused():
    with pytest.raises(ValueError, match="three finite components"):
        bcs.resolve_record({"bc_type": V, "value": 3, "direction": "Vector", "vector": [1, math.nan, 0]})


def test_the_plugin_registers_the_stored_keys_and_four_families():
    hub = get_hub()
    reg = hub.registry("bc")
    assert tuple(reg.keys()) == STORED_KEYS == bcs.BC_KEYS
    assert {reg.owner(k) for k in reg.keys()} == {"incompressible_flow"}
    fams = hub.registry("bc_family")
    assert fams.keys() == ["velocity_inlet", "velocity_outlet", "pressure_outlet", "wall"]
    assert {fams.owner(k) for k in fams.keys()} == {"incompressible_flow"}
    assert hub.failures == []
    for analysis in ("incompressible_steady", "incompressible_transient"):
        assert tuple(hub.registry("analysis").get(analysis).bc_types) == STORED_KEYS


def test_families_cover_every_bc_type_once():
    variants = [v for fam in bcs.BC_FAMILIES for v in fam.variants]
    assert sorted(variants) == sorted(STORED_KEYS)
    by_key = {spec.key: spec for spec in bcs.BC_TYPES}
    for fam in bcs.BC_FAMILIES:
        for v in fam.variants:
            assert by_key[v].family == fam.key


def test_variant_match_values_are_the_records_values():
    match = {spec.key: spec.match for spec in bcs.BC_TYPES}
    assert match["velocity_inlet_fixed"] == (("velocity_type", "Fixed"),)
    assert match["velocity_inlet_volumetric"] == (("velocity_type", "Flow rate"), ("flow_rate_type", "Volumetric flow"))
    assert match["velocity_inlet_mass"] == (("velocity_type", "Flow rate"), ("flow_rate_type", "Mass flow"))
    assert match["wall_noslip"] == (("wall_type", "No-slip"),)
    assert match["wall_slip"] == (("wall_type", "Slip"),)
    assert match["velocity_outlet"] == match["pressure_outlet_gauge"] == ()


def test_family_labels_types_colours_and_slot():
    rows = {fam.key: fam for fam in bcs.BC_FAMILIES}
    assert {k: (f.label, f.record_type, f.color) for k, f in rows.items()} == {
        "velocity_inlet": ("Velocity inlet", "Velocity inlet", "inlet"),
        "velocity_outlet": ("Velocity outlet", "Velocity outlet", "outlet"),
        "pressure_outlet": ("Pressure", "Pressure", "pressure"),
        "wall": ("Wall", "Wall", "wall"),
    }
    assert rows["pressure_outlet"].aliases == ("Pressure inlet", "Pressure outlet")
    assert rows["wall"].aliases == ("Slip wall", "No-slip wall")
    assert rows["wall"].hint == "Slip or no-slip, face by face"
    assert rows["wall"].variants[0] == "wall_noslip"
    assert all(f.color in BC_COLORS for f in rows.values())
    assert {f.ui for f in rows.values()} == {"incompressible_flow.bc"}


def test_each_family_seeds_both_unit_systems():
    for fam in bcs.BC_FAMILIES:
        assert set(fam.defaults) == {"metric", "imperial"}, fam.key
        assert set(fam.defaults["metric"]) == set(fam.defaults["imperial"]), fam.key
    rows = {fam.key: fam for fam in bcs.BC_FAMILIES}
    for key in ("velocity_inlet", "velocity_outlet"):
        metric, imperial = rows[key].defaults["metric"], rows[key].defaults["imperial"]
        assert metric == {
            "velocity_type": "Fixed",
            "flow_rate_type": "Volumetric flow",
            "value": 5,
            "unit": "m/s",
            "direction": "Normal to face",
            "vector": [0, 0, 1],
            "apply_per_face": True,
        }
        assert imperial == {**metric, "unit": "ft/s"}
    assert rows["pressure_outlet"].defaults == {
        "metric": {"pressure_type": "Fixed value", "value": 0, "unit": "Pa"},
        "imperial": {"pressure_type": "Fixed value", "value": 0, "unit": "psi"},
    }
    assert rows["wall"].defaults == {"metric": {"wall_type": "Slip"}, "imperial": {"wall_type": "Slip"}}


def test_value_rules_name_the_unit_quantity():
    rows = {fam.key: fam for fam in bcs.BC_FAMILIES}

    def quantity(fam_key: str, record: dict) -> str | None:
        for _field, _unit, q, when in rows[fam_key].values:
            if all(record.get(k) == v for k, v in when.items()):
                return q
        return None

    assert quantity("velocity_inlet", {"velocity_type": "Fixed"}) == "velocity"
    assert quantity("velocity_inlet", {"velocity_type": "Flow rate", "flow_rate_type": "Volumetric flow"}) == "volumetric_flow"
    assert quantity("velocity_inlet", {"velocity_type": "Flow rate", "flow_rate_type": "Mass flow"}) == "mass_flow"
    assert quantity("velocity_outlet", {"velocity_type": "Fixed"}) == "velocity"
    assert quantity("pressure_outlet", {}) == "pressure"
    assert quantity("wall", {"wall_type": "Slip"}) is None


def test_generic_fields_keep_their_choices_and_defaults_consistent():
    for fam in bcs.BC_FAMILIES:
        keys = [f.key for f in fam.fields]
        assert len(keys) == len(set(keys)), fam.key
        for f in fam.fields:
            if f.kind == "choice":
                assert f.default in f.choices, (fam.key, f.key)
            for dep in (f.depends_on or {}):
                assert dep in keys, (fam.key, f.key, dep)
        # Every seeded choice is one of its field's choices.
        for seed in fam.defaults.values():
            for f in fam.fields:
                if f.kind == "choice" and f.key in seed:
                    assert seed[f.key] in f.choices, (fam.key, f.key)


def test_describe_rows_are_plain_json_without_resolve():
    rows = {row["key"]: row for row in get_hub().registry("bc_family").describe()}
    assert set(rows) == {"velocity_inlet", "velocity_outlet", "pressure_outlet", "wall"}
    for row in rows.values():
        assert "resolve" not in row
        json.dumps(row)
    wall = rows["wall"]["fields"]["properties"]["wall_type"]
    assert wall["enum"] == ["No-slip", "Slip"] and wall["default"] == "No-slip"
    assert rows["pressure_outlet"]["fields"]["properties"]["value"]["x-cfddesk"]["quantity"] == "pressure"
