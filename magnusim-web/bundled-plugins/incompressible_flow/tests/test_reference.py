"""A study's reference values (incompressible_flow.reference): saved keys, blanks
filled in, directions made square, and the study schema that declares them."""

from __future__ import annotations

import math
from types import SimpleNamespace

import pytest

from incompressible_flow.analyses import build_incompressible_steady, build_incompressible_transient
from incompressible_flow.reference import (
    REFERENCE_KEYS,
    default_lift,
    has_reference_values,
    reference_record,
    resolve_reference,
)
from incompressible_flow.runspec import FaceProps


def _spec(reference=None, mapped=None, face_props=None, rho=1.2):
    return SimpleNamespace(
        reference=reference or {},
        mapped=mapped or [],
        face_props=face_props or {},
        rho=rho,
        speed_for_k=1.0,
    )


def _inlet(value=10.0, **extra):
    bc = {"name": "Inlet", "bc_type": "Velocity Inlet", "value": value, "unit": "m/s", "faces": ["face 1@B"]}
    bc.update(extra)
    return {"bc": bc, "patch": "inlet"}


def test_reference_record_keeps_only_set_reference_keys():
    rec = {"turbulence_model": "kOmegaSST", "ref_area": 0.5, "ref_speed": None, "ref_cofr": [0, 0, 1]}
    assert reference_record(rec) == {"ref_area": 0.5, "ref_cofr": [0, 0, 1]}
    assert reference_record(None) == {}
    assert has_reference_values({"ref_pressure": 0})
    assert not has_reference_values({"ref_speed": None})


def test_blank_values_are_calculated_or_defaulted():
    ref = resolve_reference(_spec(mapped=[_inlet(12.5)]))
    assert ref.speed == pytest.approx(12.5)
    assert ref.speed_auto
    assert ref.pressure == 0.0
    assert ref.area is None and ref.length is None
    assert ref.cofr == (0.0, 0.0, 0.0)
    # A normal inlet without face normals: drag along +X, lift +Z.
    assert ref.drag == (1.0, 0.0, 0.0) and ref.drag_auto
    assert ref.lift == pytest.approx((0.0, 0.0, 1.0)) and ref.lift_auto
    assert ref.side == pytest.approx((0.0, 1.0, 0.0))  # lift x drag, as forceCoeffs takes it
    assert ref.rho == 1.2


def test_saved_values_win():
    raw = {
        "ref_speed": 30.0,
        "ref_pressure": 101.0,
        "ref_area": 2.0,
        "ref_length": 0.25,
        "ref_cofr": [0.1, 0, 0],
        "ref_drag_dir": [0, 2, 0],
        "ref_lift_dir": [0, 0, -3],
    }
    ref = resolve_reference(_spec(raw, mapped=[_inlet(5.0)]))
    assert (ref.speed, ref.speed_auto, ref.pressure, ref.area, ref.length) == (30.0, False, 101.0, 2.0, 0.25)
    assert ref.cofr == (0.1, 0.0, 0.0)
    assert ref.drag == (0.0, 1.0, 0.0) and not ref.drag_auto
    assert ref.lift == pytest.approx((0.0, 0.0, -1.0)) and not ref.lift_auto


def test_lift_is_made_square_to_drag_and_a_parallel_lift_falls_back():
    ref = resolve_reference(_spec({"ref_drag_dir": [1, 0, 0], "ref_lift_dir": [1, 0, 1]}))
    assert ref.lift == pytest.approx((0.0, 0.0, 1.0))
    ref = resolve_reference(_spec({"ref_drag_dir": [1, 0, 0], "ref_lift_dir": [2, 0, 0]}))
    assert ref.lift == pytest.approx((0.0, 0.0, 1.0)) and ref.lift_auto
    assert ref.notes and "lift direction" in ref.notes[0]


def test_default_lift_is_y_when_drag_runs_along_z():
    assert default_lift((0.0, 0.0, 1.0)) == pytest.approx((0.0, 1.0, 0.0))
    s = 1 / math.sqrt(2)
    lift = default_lift((s, 0.0, s))
    assert sum(a * b for a, b in zip(lift, (s, 0.0, s), strict=True)) == pytest.approx(0.0)


def test_drag_follows_the_inlet_flow():
    vector = _inlet(4.0, direction="Vector", vector=[0, 3, 4])
    ref = resolve_reference(_spec(mapped=[vector]))
    assert ref.drag == pytest.approx((0.0, 0.6, 0.8))
    # A normal inlet blows against its faces' outward normal.
    props = {"face 1@B": FaceProps(area_m2=0.01, normal=(-1.0, 0.0, 0.0))}
    ref = resolve_reference(_spec(mapped=[_inlet(4.0)], face_props=props))
    assert ref.drag == pytest.approx((1.0, 0.0, 0.0))
    props = {"face 1@B": FaceProps(area_m2=0.01, normal=(0.0, 1.0, 0.0))}
    ref = resolve_reference(_spec(mapped=[_inlet(4.0)], face_props=props))
    assert ref.drag == pytest.approx((0.0, -1.0, 0.0))


def test_with_no_inlet_drag_and_speed_follow_the_freestream():
    fs = {
        "bc": {"name": "Far field", "bc_type": "Freestream", "value": 20.0, "unit": "m/s", "vector": [0, 0, -2], "faces": ["face 9@B"]},
        "patch": "far_field",
    }
    ref = resolve_reference(_spec(mapped=[fs]))
    assert ref.drag == pytest.approx((0.0, 0.0, -1.0))
    assert ref.speed == pytest.approx(20.0)
    assert ref.drag_auto and ref.speed_auto
    # An inlet still wins over a freestream.
    vector = _inlet(4.0, direction="Vector", vector=[0, 3, 4])
    assert resolve_reference(_spec(mapped=[fs, vector])).drag == pytest.approx((0.0, 0.6, 0.8))


def test_bad_values_read_as_blank():
    raw = {"ref_speed": -3, "ref_area": "x", "ref_length": 0, "ref_cofr": [1, 2], "ref_drag_dir": [0, 0, 0]}
    ref = resolve_reference(_spec(raw, mapped=[_inlet(7.0)]))
    assert ref.speed == pytest.approx(7.0) and ref.speed_auto
    assert ref.area is None and ref.length is None
    assert ref.cofr == (0.0, 0.0, 0.0)
    assert ref.drag == (1.0, 0.0, 0.0)


@pytest.mark.parametrize("build", [build_incompressible_steady, build_incompressible_transient])
def test_study_schema_declares_the_reference_group_blank(build):
    analysis = build()
    fields = {f.key: f for f in analysis.settings_schema if f.group == "reference"}
    assert tuple(fields) == REFERENCE_KEYS
    for f in fields.values():
        assert f.default is None and f.optional, f.key
    assert fields["ref_area"].quantity == "area"
    assert fields["ref_cofr"].kind == "vector3"
    # Nothing of it is copied into a new study's record.
    from cfddesk.registry.analysis import schema_defaults

    assert not set(schema_defaults(analysis.settings_schema)) & set(REFERENCE_KEYS)
