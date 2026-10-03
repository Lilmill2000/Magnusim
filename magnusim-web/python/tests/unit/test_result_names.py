"""Shown result fields: what every results tool works on, with no physics names.

A scalar is shown by its own name, a vector X by mag<X>. A tool asked for no
field opens on the case's first result field the frame wrote; particles follow
the case's velocity vector (whatever it is called), else the frame's only vector.
"""
# result_names must import after volume_cache puts tools/ on sys.path.
# ruff: noqa: I001
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import pyvista as pv

from cfddesk.worker import volume_cache
import case_volume  # noqa: E402
import result_names  # noqa: E402


def _foam_file(path: Path, cls: str, internal: str) -> None:
    path.write_text(
        f"FoamFile\n{{\n    format      ascii;\n    class       {cls};\n"
        f"    object      {path.name};\n}}\n\ninternalField   {internal};\n",
        encoding="utf-8",
    )


def _time(tmp_path: Path, files: dict[str, str], sidecar: dict | None = None) -> Path:
    case = tmp_path / "case"
    (case / "1").mkdir(parents=True)
    if sidecar is not None:
        (case / "w27-case.json").write_text(json.dumps(sidecar), encoding="utf-8")
    for name, cls in files.items():
        internal = "uniform (1 0 0)" if "Vector" in cls else "uniform 1"
        _foam_file(case / "1" / name, cls, internal)
    return case


def _grid() -> pv.UnstructuredGrid:
    return pv.ImageData(dimensions=(3, 3, 3), spacing=(1.0, 1.0, 1.0)).cast_to_unstructured_grid()


def test_shown_fields_name_vectors_by_magnitude(tmp_path: Path):
    case = _time(tmp_path, {"W": "volVectorField", "T": "volScalarField", "R": "volSymmTensorField"})
    assert result_names.shown_fields(case / "1") == ["T", "magW"]
    assert result_names.foam_source(case / "1", "magW") == ("W", "vector")
    assert result_names.foam_source(case / "1", "T") == ("T", "scalar")
    assert result_names.foam_source(case / "1", "magR") is None


def test_shown_fields_leave_out_face_fields_and_old_times(tmp_path: Path):
    """A real Incompressible Flow frame: U, p, k, omega, nut, plus the face flux phi
    (surfaceScalarField) and a second-order scheme's old-time copies. Only what the
    results page has always offered is shown: never phi, U_0 or phi_0."""
    case = _time(
        tmp_path,
        {
            "U": "volVectorField",
            "p": "volScalarField",
            "k": "volScalarField",
            "omega": "volScalarField",
            "nut": "volScalarField",
            "phi": "surfaceScalarField",
            "U_0": "volVectorField",
            "phi_0": "surfaceScalarField",
        },
    )
    t = case / "1"
    assert result_names.foam_kind(t / "phi") == "face"
    assert sorted(result_names.shown_fields(t)) == ["k", "magU", "nut", "omega", "p"]
    assert result_names.foam_source(t, "phi") is None
    assert result_names.foam_source(t, "magU") == ("U", "vector")
    # The fixture cavity (U and p) is unchanged.
    fixture = Path(__file__).resolve().parents[1] / "fixtures" / "foam-results" / "cavity-2d" / "0.5"
    assert sorted(result_names.shown_fields(fixture)) == ["magU", "p"]


def test_ensure_shown_field_derives_magnitude_on_cells_and_points():
    cells = _grid()
    cells.cell_data["W"] = np.tile([3.0, 4.0, 0.0], (cells.n_cells, 1))
    result_names.ensure_shown_field(cells, "magW")
    assert np.allclose(cells.cell_data["magW"], 5.0) and "magW" not in cells.point_data

    both = _grid()
    both.point_data["W"] = np.tile([0.0, 0.0, 2.0], (both.n_points, 1))
    both.cell_data["W"] = np.tile([0.0, 6.0, 8.0], (both.n_cells, 1))
    result_names.ensure_shown_field(both, "magW")
    assert np.allclose(both.point_data["magW"], 2.0)
    assert np.allclose(both.cell_data["magW"], 10.0)

    scalar = _grid()
    scalar.cell_data["T"] = np.full(scalar.n_cells, 300.0)
    result_names.ensure_shown_field(scalar, "T")
    with pytest.raises(RuntimeError, match="magT"):
        result_names.ensure_shown_field(scalar, "magT")
    with pytest.raises(RuntimeError, match="magU"):
        result_names.ensure_shown_field(scalar, "magU")


def test_point_shown_field_promotes_cells():
    grid = _grid()
    grid.cell_data["W"] = np.tile([3.0, 4.0, 0.0], (grid.n_cells, 1))
    out = result_names.point_shown_field(grid, "magW")
    assert np.allclose(out.point_data["magW"], 5.0)


def test_default_shown_field_prefers_the_sidecar_then_the_folder(tmp_path: Path):
    files = {"W": "volVectorField", "T": "volScalarField"}
    listed = _time(tmp_path / "a", files, {"result_fields": [
        {"key": "missing", "kind": "scalar"},
        {"key": "W", "kind": "vector", "unit_quantity": "velocity"},
        {"key": "T", "kind": "scalar", "unit_quantity": "temperature"},
    ]})
    assert result_names.default_shown_field(listed, "1") == "magW"
    plain = _time(tmp_path / "b", files, {"rho": 1.0})
    assert result_names.case_result_fields(plain) is None
    assert result_names.default_shown_field(plain, "1") == "T"
    assert result_names.default_shown_field(plain, "9") == ""


def test_velocity_vector_picks_the_velocity_row_else_the_only_vector(tmp_path: Path):
    two = {"W": "volVectorField", "B": "volVectorField", "T": "volScalarField"}
    listed = _time(tmp_path / "a", two, {"result_fields": [
        {"key": "B", "kind": "vector", "unit_quantity": "magnetic_field"},
        {"key": "W", "kind": "vector", "unit_quantity": "velocity"},
    ]})
    assert result_names.velocity_vector(listed, "1") == "W"
    assert result_names.velocity_vector(listed, "1", requested="B") == "B"
    assert result_names.velocity_vector(listed, "1", requested="T") == "W"

    unlisted = _time(tmp_path / "b", two)
    assert result_names.velocity_vector(unlisted, "1") is None
    sole = _time(tmp_path / "c", {"W": "volVectorField", "T": "volScalarField"})
    assert result_names.velocity_vector(sole, "1") == "W"
    scalars = _time(tmp_path / "d", {"T": "volScalarField"})
    assert result_names.velocity_vector(scalars, "1") is None


def test_volume_cache_bakes_every_vector_magnitude(tmp_path: Path, monkeypatch):
    case = _time(tmp_path, {"W": "volVectorField", "T": "volScalarField"})
    mesh = _grid()
    mesh.cell_data["W"] = np.tile([3.0, 4.0, 0.0], (mesh.n_cells, 1))
    mesh.cell_data["T"] = np.full(mesh.n_cells, 300.0)
    volume_cache.clear()
    monkeypatch.setattr(case_volume, "load_volume", lambda c, t, **_kw: (mesh, "test"))
    entry = volume_cache.get_prepared(str(case), "1")
    grid = entry["grid"]
    assert entry["vector"] == "W" and entry["has_point_u"] is True
    assert np.allclose(grid.point_data["magW"], 5.0)
    assert "magU" not in grid.point_data and "magU" not in grid.cell_data
    volume_cache.clear()
