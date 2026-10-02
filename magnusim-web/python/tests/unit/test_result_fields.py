"""Results viewer fields: whatever the run's analysis writes, not only magU and p.

A scalar colours by its own name, a vector by ``mag<name>``. Fields the case
stores divided by density (its analysis's ``kinematic_fields`` in
w27-case.json; ``p`` for cases written before that list existed) are shown
times rho, in every view: surface, series range, cut plane, iso surface and
plot over path. The iso surface and plot over path used to skip that, so an
iso value typed in Pa cut kinematic p.
"""
# case_volume must import after volume_cache puts tools/ on sys.path.
# ruff: noqa: I001
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import pyvista as pv

import cfddesk.worker.methods  # noqa: F401  — register RPCs
from cfddesk.worker import handle_line, volume_cache
import case_units  # noqa: E402
import case_volume  # noqa: E402
import export_case_field  # noqa: E402
import export_iso_surface  # noqa: E402
import export_plot_over_path  # noqa: E402

RHO = 1.2


def _rpc(method: str, params: dict) -> dict:
    msg = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    return json.loads(handle_line(json.dumps(msg)))


def _scalar_file(path: Path, name: str, values) -> None:
    body = "\n".join(repr(float(v)) for v in values)
    path.write_text(
        "FoamFile\n{\n    format      ascii;\n    class       volScalarField;\n"
        f"    object      {name};\n}}\n\n"
        f"internalField   nonuniform List<scalar>\n{len(values)}\n(\n{body}\n)\n;\n",
        encoding="utf-8",
    )


def _case(tmp_path: Path, sidecar: dict | None, fields: dict[str, np.ndarray]) -> Path:
    case = tmp_path / "case"
    (case / "1").mkdir(parents=True)
    if sidecar is not None:
        (case / "w27-case.json").write_text(json.dumps(sidecar), encoding="utf-8")
    for name, vals in fields.items():
        _scalar_file(case / "1" / name, name, vals)
    return case


def _mesh(arrays: dict[str, float]) -> pv.UnstructuredGrid:
    mesh = pv.ImageData(dimensions=(5, 5, 5), spacing=(0.1, 0.1, 0.1)).cast_to_unstructured_grid()
    for name, value in arrays.items():
        mesh.cell_data[name] = np.full(mesh.n_cells, value)
        mesh.point_data[name] = np.full(mesh.n_points, value)
    return mesh


def _patch_volume(monkeypatch, mesh) -> None:
    volume_cache.clear()
    monkeypatch.setattr(case_volume, "load_volume", lambda case, time, **_kw: (mesh.copy(), "test"))
    for mod in (export_iso_surface, export_plot_over_path):
        monkeypatch.setattr(mod, "load_volume", lambda case, time, **_kw: (mesh.copy(), "test"))


def test_kinematic_fields_come_from_the_case_and_default_to_p(tmp_path: Path):
    listed = _case(tmp_path / "a", {"rho": RHO, "kinematic_fields": ["p_rgh"]}, {})
    legacy = _case(tmp_path / "b", {"rho": RHO}, {})
    assert case_units.kinematic_fields(listed) == ("p_rgh",)
    assert case_units.kinematic_fields(legacy) == ("p",)
    assert case_units.field_scale(listed, "p") == 1.0
    assert case_units.field_scale(listed, "p_rgh") == RHO
    assert case_units.field_scale(legacy, "p") == RHO


def test_any_scalar_field_colours_the_surface_unscaled(tmp_path: Path, monkeypatch):
    vals = np.linspace(290.0, 310.0, 64)
    case = _case(tmp_path, {"rho": RHO, "kinematic_fields": []}, {"T": vals})
    _patch_volume(monkeypatch, _mesh({"T": 300.0}))
    out = tmp_path / "surf"
    res = _rpc("filter.case_field", {"case_dir": str(case), "time": "1", "field": "T", "out_dir": str(out)})
    assert "result" in res, res
    data = pv.read(str(out / "T.vtp"))
    assert np.allclose(data.point_data["T"], 300.0)
    meta = json.loads((out / "T.meta.json").read_text(encoding="utf-8"))
    assert meta["field"] == "T" and meta["foam_kind"] == "scalar"
    assert (meta["foam_proof"]["min"], meta["foam_proof"]["max"]) == (290.0, 310.0)
    assert meta["scaled_by_density"] is False and "pressure_range_unit" not in meta
    assert meta["fields_available"] == ["T"]
    rng = _rpc("filter.series_range", {"case_dir": str(case), "field": "T"})["result"]
    assert (rng["min"], rng["max"], rng["scaled_by_density"]) == (290.0, 310.0, False)


def _foam_file(path: Path, cls: str, internal: str) -> None:
    path.write_text(
        f"FoamFile\n{{\n    format      ascii;\n    class       {cls};\n"
        f"    object      {path.name};\n}}\n\ninternalField   {internal};\n",
        encoding="utf-8",
    )


def test_tensor_fields_are_never_offered(tmp_path: Path, monkeypatch):
    """R (Reynolds-stress models) is a volSymmTensorField: not a scalar to colour by."""
    case = _case(tmp_path, {"rho": RHO, "kinematic_fields": ["p"]}, {"p": np.zeros(8), "k": np.ones(8)})
    t = case / "1"
    _foam_file(t / "U", "volVectorField", "uniform (1 0 0)")
    _foam_file(t / "R", "volSymmTensorField", "uniform (1 0 0 1 0 1)")
    _foam_file(t / "gradU", "volTensorField", "uniform (0 0 0 0 0 0 0 0 0)")
    assert export_case_field.foam_kind(t / "R") == "symm_tensor"
    assert export_case_field.foam_kind(t / "gradU") == "tensor"
    assert export_case_field.foam_kind(t / "U") == "vector"
    assert export_case_field.foam_kind(t / "p") == "scalar"
    # Scalars and vectors are listed as before; the tensors are left out.
    assert export_case_field.shown_fields(t) == ["k", "p", "magU"]
    for name in ("R", "magR", "gradU"):
        assert export_case_field.foam_source(t, name) is None
        assert export_case_field.list_field_times(case, name) == []
    _patch_volume(monkeypatch, _mesh({"p": 0.0, "k": 1.0}))
    res = _rpc("filter.case_field", {"case_dir": str(case), "time": "1", "field": "R", "out_dir": str(tmp_path / "o")})
    assert "tensor" in res["error"]["message"], res
    out = tmp_path / "k"
    res = _rpc("filter.case_field", {"case_dir": str(case), "time": "1", "field": "k", "out_dir": str(out)})
    assert "result" in res, res
    assert json.loads((out / "k.meta.json").read_text(encoding="utf-8"))["fields_available"] == ["k", "p", "magU"]


def test_field_names_are_checked(tmp_path: Path):
    case = _case(tmp_path, {"rho": RHO}, {"p": np.zeros(8)})
    for bad in ("../p", "p;rm", "", "1p"):
        res = _rpc("filter.case_field", {"case_dir": str(case), "time": "1", "field": bad or " ", "out_dir": str(tmp_path / "o")})
        assert "error" in res, bad
    with pytest.raises(ValueError):
        export_case_field.series_field_range(case, "../p")


def test_iso_surface_and_plot_over_path_show_pressure_in_pa(tmp_path: Path, monkeypatch):
    case = _case(tmp_path, {"rho": RHO}, {"p": np.linspace(0.0, 10.0, 64)})
    mesh = _mesh({})
    # p rises along x (kinematic 0..10), so an iso value in Pa lands at a known x.
    xs = mesh.points[:, 0]
    mesh.point_data["p"] = xs / 0.4 * 10.0
    mesh.cell_data["p"] = mesh.cell_centers().points[:, 0] / 0.4 * 10.0
    mesh.point_data["U"] = np.tile([1.0, 0.0, 0.0], (mesh.n_points, 1))
    mesh.cell_data["U"] = np.tile([1.0, 0.0, 0.0], (mesh.n_cells, 1))
    _patch_volume(monkeypatch, mesh)

    # 6 Pa = 5 m^2/s^2 x 1.2 -> the surface p = 5 kinematic sits at x = 0.2.
    out = tmp_path / "iso"
    export_iso_surface.export_iso_surface(
        case, "1", out, iso_scalar="Pressure", iso_value=5.0 * RHO, coloring="Pressure"
    )
    iso = pv.read(str(next(out.glob("*.vtp"))))
    assert iso.n_points > 0
    assert np.allclose(iso.points[:, 0], 0.2, atol=1e-6)
    assert np.allclose(iso.point_data["p"], 5.0 * RHO)

    out2 = tmp_path / "pop"
    series = export_plot_over_path.export_plot_over_path(
        case, "1", out2, points=[[0.0, 0.2, 0.2], [0.4, 0.2, 0.2]], subdivisions=4, field_variable="Pressure"
    )
    vals = [v for v in series["values"] if v is not None]
    assert vals and abs(max(vals) - 10.0 * RHO) < 1e-6 and abs(min(vals)) < 1e-6


def test_writing_a_case_stamps_its_frame_fields(tmp_path: Path):
    """Results list a time only when the analysis's frame fields are there (T for
    a scalar analysis, not U and p): the case sidecar says which they are."""
    from types import SimpleNamespace

    from cfddesk.registry.analysis import _stamp_case

    case = tmp_path / "case"
    case.mkdir()
    (case / "w27-case.json").write_text(json.dumps({"rho": RHO, "kinematic_fields": ["p"]}), encoding="utf-8")
    _stamp_case(case, "incompressible_steady", SimpleNamespace(frame_fields=("U", "p")))
    doc = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    assert doc == {"rho": RHO, "kinematic_fields": ["p"], "analysis_key": "incompressible_steady", "frame_fields": ["U", "p"]}

    bare = tmp_path / "bare"
    bare.mkdir()
    _stamp_case(bare, "stub_diffusion_steady", SimpleNamespace(frame_fields=(), fields=("T",)))
    assert json.loads((bare / "w27-case.json").read_text(encoding="utf-8"))["frame_fields"] == ["T"]
