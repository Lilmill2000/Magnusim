"""magnusim_sdk.study.study_fluid: the study's one fluid among its material records.

A record of the Air preset is told by its preset key, else its library code;
only a record with neither (saved before presets) is matched by name.
"""

from __future__ import annotations

import re

from magnusim_sdk.study import study_fluid


def _old_study_fluid(materials: list) -> dict | None:
    """The rule before preset keys were read (name contains "air"), to pin unchanged results."""
    rows = [m for m in materials if isinstance(m, dict)]
    assigned = [m for m in rows if m.get("assigned_volumes") or m.get("assigned_volume")]
    named = [m for m in rows if re.search(r"air", str(m.get("name") or ""), re.I)]
    return (assigned or named or rows or [None])[0]


def _rec(rid: str, name: str, preset: str | None, library: str | None, vols: list[str] | None = None) -> dict:
    rec: dict = {"id": rid, "name": name, "assigned_volumes": list(vols or [])}
    if preset is not None:
        rec["preset"] = preset
    if library is not None:
        rec["library"] = library
    return rec


def test_the_assigned_material_wins():
    water = _rec("w", "Water", "water", "WATER", ["Body1"])
    air = _rec("a", "Air", "air", "AIR")
    assert study_fluid([air, water]) is water


def test_unassigned_air_is_found_by_its_preset_key_or_library_code():
    water = _rec("w", "Water", "water", "WATER")
    assert study_fluid([water, _rec("a", "Air", "air", "AIR")])["id"] == "a"
    assert study_fluid([water, _rec("a", "", None, "DEFAULT")])["id"] == "a"
    assert study_fluid([water, _rec("a", "Fluid 2", None, "air")])["id"] == "a"
    assert study_fluid([water, _rec("a", "Whatever", "AIR", None)])["id"] == "a"


def test_an_old_record_without_preset_or_library_is_air_by_name():
    water = _rec("w", "Water", "water", "WATER")
    assert study_fluid([water, _rec("a", "Air", None, None)])["id"] == "a"
    assert study_fluid([water, _rec("a", "my air 30C", None, None)])["id"] == "a"


def test_a_custom_fluid_named_like_air_is_not_air():
    first = _rec("w", "Water", "water", "WATER")
    custom = _rec("c", "Hot air", "custom", "CUSTOM")
    assert study_fluid([first, custom]) is first
    assert study_fluid([first, _rec("c", "Air", None, "CUSTOM")]) is first


def test_else_the_first_and_none_for_no_records():
    a, b = _rec("w", "Water", "water", "WATER"), _rec("n", "Nitrogen", "nitrogen", "NITROGEN")
    assert study_fluid([a, b]) is a
    assert study_fluid([]) is None
    assert study_fluid([None, "x"]) is None  # type: ignore[list-item]


def test_records_the_app_writes_keep_their_result():
    """Every record the Fluid picker writes (preset key + its library code and name)."""
    presets = [
        ("air", "Air", "AIR"),
        ("argon", "Argon", "ARGON"),
        ("co2", "Carbon dioxide", "CO2"),
        ("hydrogen", "Hydrogen", "HYDROGEN"),
        ("nitrogen", "Nitrogen", "NITROGEN"),
        ("water", "Water", "WATER"),
        ("seawater", "Seawater (3.5% saline)", "SEAWATER"),
        ("custom", "Custom fluid", "CUSTOM"),
    ]
    recs = [_rec(k, n, k, c) for k, n, c in presets]
    lists = [[r] for r in recs]
    lists += [[a, b] for a in recs for b in recs if a is not b]
    lists += [[dict(a, assigned_volumes=["Body1"]), b] for a in recs for b in recs if a is not b]
    lists += [[a, dict(b, assigned_volumes=["Body1"])] for a in recs for b in recs if a is not b]
    lists.append([_rec("old", "Air", None, "DEFAULT"), *recs])
    lists.append([_rec("v15", "Air", None, None), *recs[1:]])
    for lst in lists:
        assert study_fluid(lst) is _old_study_fluid(lst), [m.get("id") for m in lst]
