"""The results core picks its default field from the case's result fields, not a
physics name; old records that name the velocity magnitude read as before.

Pins what an Incompressible Flow study and an old project show: the default
colouring is "Velocity Magnitude" (the field magU), stored filters and colour
scales read and write the same values, and a case whose sidecar lists U first
opens on magU.
"""

import json
import sys
from pathlib import Path

import numpy as np
import pytest
import pyvista as pv

TOOLS = Path(__file__).resolve().parents[2] / "tools"
sys.path.insert(0, str(TOOLS))

from cfddesk.builtin.filters import build_cut_plane, build_surface_field  # noqa: E402
from cfddesk.results import filters as rf  # noqa: E402
from cfddesk.results.color_scale import ColorScale  # noqa: E402
from cfddesk.results.loader import (  # noqa: E402
    _finalize_field,
    case_result_fields,
    ensure_colour_field,
    has_vector_magnitude,
)

# Incompressible Flow's result field rows, as its analysis declares them.
IF_ROWS = [
    {"key": "U", "label": "Velocity", "kind": "vector", "magnitude_label": "Velocity Magnitude"},
    {"key": "p", "label": "Pressure", "kind": "scalar"},
    {"key": "k", "label": "Turbulent kinetic energy", "kind": "scalar"},
]


def _grid(**cells: np.ndarray) -> pv.UnstructuredGrid:
    grid = pv.ImageData(dimensions=(3, 3, 2)).cast_to_unstructured_grid()
    for name, values in cells.items():
        grid.cell_data[name] = values
    return grid


def _vel(n: int = 4) -> np.ndarray:
    return np.tile(np.array([[3.0, 4.0, 0.0]]), (n, 1))


def test_velocity_case_opens_on_its_magnitude_with_or_without_a_sidecar():
    grid = _grid(U=_vel(), p=np.arange(4.0))
    assert ensure_colour_field(grid) == "magU"
    np.testing.assert_allclose(grid.cell_data["magU"], 5.0)
    assert ensure_colour_field(_grid(U=_vel(), p=np.arange(4.0)), ["U", "p"]) == "magU"
    assert has_vector_magnitude(grid, "p")


def test_default_follows_the_result_field_order():
    assert ensure_colour_field(_grid(U=_vel(), p=np.arange(4.0)), ["p", "U"]) == "p"
    # A key the frame did not write is skipped.
    assert ensure_colour_field(_grid(U=_vel(), p=np.arange(4.0)), ["T", "U"]) == "magU"
    # Any vector, by any name, is shown by its magnitude.
    other = _grid(W=_vel(), T=np.arange(4.0))
    assert ensure_colour_field(other) == "magW"
    assert not has_vector_magnitude(_grid(T=np.arange(4.0)), "T")


def test_a_cached_magnitude_without_its_vector_is_still_preferred():
    assert ensure_colour_field(_grid(p=np.arange(4.0), magU=np.ones(4))) == "magU"
    assert ensure_colour_field(_grid(p=np.arange(4.0))) == "p"
    with pytest.raises(RuntimeError):
        ensure_colour_field(_grid())


def test_finalize_recomputes_a_stale_magnitude_and_honours_prefer():
    grid = _grid(U=_vel(), p=np.arange(4.0), magU=np.zeros(4))
    assert _finalize_field(grid, None) == "magU"
    np.testing.assert_allclose(grid.cell_data["magU"], 5.0)
    assert _finalize_field(_grid(U=_vel(), p=np.arange(4.0)), "p") == "p"
    assert _finalize_field(_grid(W=_vel()), "magW") == "magW"
    assert _finalize_field(_grid(), None) == ""


def test_case_result_fields_reads_the_sidecar(tmp_path: Path):
    assert case_result_fields(tmp_path) == []
    (tmp_path / "w27-case.json").write_text(
        json.dumps({"result_fields": [{"key": "U", "kind": "vector"}, "p", {"key": ""}]}), encoding="utf-8"
    )
    assert case_result_fields(tmp_path) == ["U", "p"]


def test_coloring_labels_map_as_before():
    for label in ("Velocity Magnitude", "velocity magnitude", "magU", "|U|", "U magnitude", "Velocity", "", "  "):
        assert rf.coloring_to_scalar_field(label) == "magU"
    assert rf.coloring_to_scalar_field("p") == "p"
    assert rf.LEGACY_MAGNITUDE_FIELD == "magU"


def test_coloring_labels_resolve_through_the_analysis_rows():
    assert rf.coloring_to_scalar_field("Velocity Magnitude", IF_ROWS) == "magU"
    assert rf.coloring_to_scalar_field("Pressure", IF_ROWS) == "p"
    assert rf.coloring_to_scalar_field("Velocity", IF_ROWS) == "magU"
    rows = [{"key": "W", "label": "Wind", "kind": "vector", "magnitude_label": "Wind speed"}]
    assert rf.coloring_to_scalar_field("wind speed", rows) == "magW"
    assert rf.coloring_to_scalar_field("T", rows) == "T"


@pytest.mark.parametrize(
    "cls, attr",
    [
        (rf.CutPlaneFilter, "coloring"),
        (rf.StreamlineFilter, "coloring"),
        (rf.PlotOverPathFilter, "field_variable"),
        (rf.IsoSurfaceFilter, "iso_scalar"),
        (rf.IsoVolumeFilter, "iso_scalar"),
    ],
)
def test_stored_filters_read_and_write_as_before(cls, attr):
    for stored in ({}, {"field": "magU"}, {"field": "U"}, {"field": ""}, {"field": None}):
        f = cls.from_dict(stored)
        assert getattr(f, attr) == "Velocity Magnitude"
        assert f.field == "magU"
    assert getattr(cls.from_dict({"field": "p"}), attr) == "p"
    f = cls()
    assert getattr(f, attr) == "Velocity Magnitude"
    if "field" in f.to_dict():
        assert f.to_dict()["field"] == "magU"
    for value in ("magU", "U", ""):
        f.field = value
        assert getattr(f, attr) == "Velocity Magnitude"
    f.field = "k"
    assert getattr(f, attr) == "k"


def test_colour_scale_persists_the_same_field():
    assert ColorScale().to_dict()["field"] == "magU"
    assert ColorScale.from_dict({"mode": "auto"}).field == "magU"
    assert ColorScale.from_dict({"field": "p"}).field == "p"


def test_builtin_filter_schemas_default_to_the_cases_field():
    for spec in (build_cut_plane(), build_surface_field()):
        field = next(f for f in spec.params_schema if f.key == "field")
        assert field.default == ""


def test_series_range_with_no_field_uses_the_cases_default(tmp_path: Path):
    from export_case_field import series_field_range

    for t, vec in (("0", (0.0, 0.0, 0.0)), ("1", (3.0, 4.0, 0.0))):
        d = tmp_path / t
        d.mkdir()
        (d / "U").write_text(f"internalField   uniform ({vec[0]} {vec[1]} {vec[2]});\n", encoding="utf-8")
        (d / "p").write_text("internalField   uniform 2;\n", encoding="utf-8")
    (tmp_path / "w27-case.json").write_text(json.dumps({"result_fields": IF_ROWS}), encoding="utf-8")
    out = series_field_range(tmp_path, "")
    assert out["field"] == "magU" and out["max"] == 5.0
    (tmp_path / "w27-case.json").write_text(json.dumps({"result_fields": ["p", "U"]}), encoding="utf-8")
    assert series_field_range(tmp_path, "")["field"] == "p"
    with pytest.raises(ValueError):
        series_field_range(tmp_path / "missing", "")
