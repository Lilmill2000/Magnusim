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
import export_iso_volume  # noqa: E402
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
    for mod in (export_iso_surface, export_iso_volume, export_plot_over_path):
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
    # The case's sidecar lists no result fields, so the meta has none.
    assert meta["result_fields"] is None
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


def test_exported_meta_carries_the_cases_result_fields(tmp_path: Path, monkeypatch):
    """API 1.4: the surface meta lists the sidecar's result fields (labels and units)."""
    rows = [
        {"key": "T", "label": "Temperature", "unit_quantity": "temperature", "kind": "scalar",
         "unit": "K", "magnitude_label": "", "shown": "T"},
        {"key": "W", "label": "Drift", "unit_quantity": "velocity", "kind": "vector",
         "unit": "", "magnitude_label": "Drift speed", "shown": "magW"},
    ]
    case = _case(tmp_path, {"rho": RHO, "kinematic_fields": [], "result_fields": rows}, {"T": np.full(64, 300.0)})
    _patch_volume(monkeypatch, _mesh({"T": 300.0}))
    out = tmp_path / "surf"
    res = _rpc("filter.case_field", {"case_dir": str(case), "time": "1", "field": "T", "out_dir": str(out)})
    assert "result" in res, res
    meta = json.loads((out / "T.meta.json").read_text(encoding="utf-8"))
    assert meta["result_fields"] == [
        {"key": "T", "kind": "scalar", "unit_quantity": "temperature", "label": "Temperature",
         "unit": "K", "magnitude_label": ""},
        {"key": "W", "kind": "vector", "unit_quantity": "velocity", "label": "Drift",
         "unit": "", "magnitude_label": "Drift speed"},
    ]


def test_field_names_are_checked(tmp_path: Path, monkeypatch):
    case = _case(tmp_path, {"rho": RHO}, {"p": np.zeros(8)})
    for bad in ("../p", "p;rm", "1p"):
        res = _rpc("filter.case_field", {"case_dir": str(case), "time": "1", "field": bad, "out_dir": str(tmp_path / "o")})
        assert "error" in res, bad
    with pytest.raises(ValueError):
        export_case_field.series_field_range(case, "../p")
    # No field: the case's default shown field.
    _patch_volume(monkeypatch, _mesh({"p": 0.0}))
    res = _rpc("filter.case_field", {"case_dir": str(case), "time": "1", "field": " ", "out_dir": str(tmp_path / "d")})
    assert res["result"]["field"] == "p", res


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
    export_iso_surface.export_iso_surface(case, "1", out, iso_field="p", iso_value=5.0 * RHO, color_field="p")
    iso = pv.read(str(next(out.glob("*.vtp"))))
    assert iso.n_points > 0
    assert np.allclose(iso.points[:, 0], 0.2, atol=1e-6)
    assert np.allclose(iso.point_data["p"], 5.0 * RHO)

    out2 = tmp_path / "pop"
    series = export_plot_over_path.export_plot_over_path(
        case, "1", out2, points=[[0.0, 0.2, 0.2], [0.4, 0.2, 0.2]], subdivisions=4, field="p"
    )
    vals = [v for v in series["values"] if v is not None]
    assert vals and abs(max(vals) - 10.0 * RHO) < 1e-6 and abs(min(vals)) < 1e-6


def test_writing_a_case_stamps_its_frame_fields(tmp_path: Path):
    """Results list a time only when the analysis's frame fields are there (T for
    a scalar analysis, not U and p): the case sidecar says which they are."""
    from types import SimpleNamespace

    from cfddesk.registry.analysis import ResultField, _stamp_case

    case = tmp_path / "case"
    case.mkdir()
    (case / "w27-case.json").write_text(json.dumps({"rho": RHO, "kinematic_fields": ["p"]}), encoding="utf-8")
    declared = (ResultField("U", "Velocity", "velocity", "vector"), ResultField("p", "Pressure", "pressure", "scalar", unit="Pa"))
    _stamp_case(case, "incompressible_steady", SimpleNamespace(key="x", frame_fields=("U", "p"), result_fields=declared))
    doc = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    assert doc == {
        "rho": RHO,
        "kinematic_fields": ["p"],
        "analysis_key": "incompressible_steady",
        "frame_fields": ["U", "p"],
        "result_fields": [
            {"key": "U", "label": "Velocity", "unit_quantity": "velocity", "kind": "vector",
             "unit": "", "magnitude_label": "", "shown": "magU"},
            {"key": "p", "label": "Pressure", "unit_quantity": "pressure", "kind": "scalar",
             "unit": "Pa", "magnitude_label": "", "shown": "p"},
        ],
    }

    bare = tmp_path / "bare"
    bare.mkdir()
    _stamp_case(bare, "stub_diffusion_steady", SimpleNamespace(frame_fields=(), fields=("T",)))
    assert json.loads((bare / "w27-case.json").read_text(encoding="utf-8"))["frame_fields"] == ["T"]


def _inspect(case: Path, out: Path, **extra) -> dict:
    res = _rpc("filter.inspect", {"case_dir": str(case), "time": "1", "out_dir": str(out),
                                  "x": 0.2, "y": 0.2, "z": 0.2, **extra})
    assert "result" in res, res
    return res["result"]


def test_inspect_probes_the_shown_fields_with_no_physics_names(tmp_path: Path, monkeypatch):
    """A T-only case answers T; there is no magU or p to mirror."""
    case = _case(tmp_path, {"rho": RHO, "kinematic_fields": []}, {"T": np.full(64, 300.0)})
    _patch_volume(monkeypatch, _mesh({"T": 300.0}))
    r = _inspect(case, tmp_path / "o")
    assert r["hit"] is True and r["values"] == {"T": 300.0}
    assert r["fields_available"] == ["T"]
    assert "magU" not in r and "p" not in r
    meta = json.loads((tmp_path / "o" / "inspect.meta.json").read_text(encoding="utf-8"))
    assert meta["values"] == {"T": 300.0} and meta["fields"] == ["T"]
    assert "magU" not in meta and "p" not in meta and "units" not in meta
    assert meta["source_foam"] == {"T": str((case / "1" / "T").resolve())}


def test_inspect_named_fields_and_vector_magnitudes(tmp_path: Path, monkeypatch):
    case = _case(tmp_path, {"rho": RHO, "kinematic_fields": []}, {"T": np.full(64, 300.0)})
    _foam_file(case / "1" / "W", "volVectorField", "uniform (3 4 0)")
    mesh = _mesh({"T": 300.0})
    mesh.point_data["W"] = np.tile([0.0, 6.0, 8.0], (mesh.n_points, 1))
    mesh.cell_data["W"] = np.tile([0.0, 6.0, 8.0], (mesh.n_cells, 1))
    _patch_volume(monkeypatch, mesh)
    # W is stored uniform at this time: its uniform magnitude wins over the volume's.
    r = _inspect(case, tmp_path / "all")
    assert r["values"] == {"T": 300.0, "magW": 5.0}
    r = _inspect(case, tmp_path / "one", fields="T")
    assert r["values"] == {"T": 300.0}
    bad = _rpc("filter.inspect", {"case_dir": str(case), "time": "1", "out_dir": str(tmp_path / "b"),
                                  "x": 0.2, "y": 0.2, "z": 0.2, "fields": ["../T"]})
    assert bad["error"]["code"] == -32602


@pytest.mark.parametrize(("kinematic", "scale"), [([], 1.0), (["p"], RHO)])
def test_inspect_scales_only_kinematic_fields(tmp_path: Path, monkeypatch, kinematic, scale):
    case = _case(tmp_path, {"rho": RHO, "kinematic_fields": kinematic}, {"p": np.full(64, 10.0), "T": np.full(64, 300.0)})
    _patch_volume(monkeypatch, _mesh({"p": 10.0, "T": 300.0}))
    r = _inspect(case, tmp_path / "o")
    assert abs(r["values"]["p"] - 10.0 * scale) < 1e-9
    assert r["values"]["T"] == 300.0
    assert abs(r["p"] - 10.0 * scale) < 1e-9
    meta = json.loads((tmp_path / "o" / "inspect.meta.json").read_text(encoding="utf-8"))
    assert meta["units"] == {"p": "Pa"} and meta["scaled_by_density"] == (["p"] if kinematic else [])


def test_inspect_uniform_scalar_time_overrides_the_volume(tmp_path: Path, monkeypatch):
    case = _case(tmp_path, {"rho": RHO, "kinematic_fields": []}, {})
    _foam_file(case / "1" / "T", "volScalarField", "uniform 350")
    _patch_volume(monkeypatch, _mesh({"T": 300.0}))
    r = _inspect(case, tmp_path / "o")
    assert r["values"] == {"T": 350.0}
    entry = volume_cache.get_prepared(str(case), "1")
    assert np.allclose(entry["slice"].point_data["T"], 300.0)


def test_inspect_needs_a_written_frame(tmp_path: Path, monkeypatch):
    case = _case(tmp_path, {"rho": RHO}, {})
    _patch_volume(monkeypatch, _mesh({"T": 300.0}))
    res = _rpc("filter.inspect", {"case_dir": str(case), "time": "1", "out_dir": str(tmp_path / "o"),
                                  "x": 0.2, "y": 0.2, "z": 0.2})
    assert "time_not_found" in res["error"]["message"]


def _t_case(tmp_path: Path) -> tuple[Path, pv.UnstructuredGrid]:
    """A case that writes only T, rising along x (290 K at x=0 to 310 K at x=0.4)."""
    case = _case(tmp_path, {"rho": RHO, "kinematic_fields": []}, {"T": np.linspace(290.0, 310.0, 64)})
    mesh = _mesh({})
    mesh.point_data["T"] = 290.0 + mesh.points[:, 0] / 0.4 * 20.0
    mesh.cell_data["T"] = 290.0 + mesh.cell_centers().points[:, 0] / 0.4 * 20.0
    return case, mesh


def test_iso_and_plot_work_on_a_t_only_case(tmp_path: Path, monkeypatch):
    case, mesh = _t_case(tmp_path)
    _patch_volume(monkeypatch, mesh)
    # Named, and '' (the case's default field, T): the same contour at x = 0.2.
    for asked in ("T", ""):
        out = tmp_path / f"iso-{asked or 'default'}"
        meta = export_iso_surface.export_iso_surface(case, "1", out, iso_field=asked, iso_value=300.0)
        iso = pv.read(str(out / "iso_surface.vtp"))
        assert iso.n_points > 0 and np.allclose(iso.points[:, 0], 0.2, atol=1e-6)
        assert (meta["iso_field"], meta["coloring_field"], meta["vector_field"]) == ("T", "T", None)
        assert meta["source_foam"] == {"T": str(case / "1" / "T")}
        assert "iso_scalar" not in meta and "source_foam_U" not in meta
    vol = export_iso_volume.export_iso_volume(case, "1", tmp_path / "iv", iso_field="T")
    assert vol["iso_field"] == "T" and vol["n_cells"] > 0
    with pytest.raises(RuntimeError, match="magU"):
        export_iso_surface.export_iso_surface(case, "1", tmp_path / "nou", iso_field="magU", iso_value=1.0)

    series = export_plot_over_path.export_plot_over_path(
        case, "1", tmp_path / "pop", points=[[0.0, 0.2, 0.2], [0.4, 0.2, 0.2]], subdivisions=4, field="T"
    )
    assert series["field_name"] == "T"
    assert abs(min(series["values"]) - 290.0) < 1e-6 and abs(max(series["values"]) - 310.0) < 1e-6
    default = export_plot_over_path.export_plot_over_path(
        case, "1", tmp_path / "pop2", points=[[0.0, 0.2, 0.2], [0.4, 0.2, 0.2]], subdivisions=4
    )
    assert default["field_name"] == "T" and default["values"] == series["values"]


def test_iso_colours_by_a_vector_magnitude_and_carries_the_vector(tmp_path: Path, monkeypatch):
    case, mesh = _t_case(tmp_path)
    _foam_file(case / "1" / "W", "volVectorField", "uniform (0 0 2)")
    mesh.point_data["W"] = np.tile([0.0, 0.0, 2.0], (mesh.n_points, 1))
    mesh.cell_data["W"] = np.tile([0.0, 0.0, 2.0], (mesh.n_cells, 1))
    _patch_volume(monkeypatch, mesh)
    out = tmp_path / "iso"
    meta = export_iso_surface.export_iso_surface(case, "1", out, iso_field="T", iso_value=300.0, color_field="W")
    iso = pv.read(str(out / "iso_surface.vtp"))
    assert (meta["coloring_field"], meta["vector_field"], meta["vectors_live"]) == ("magW", "W", True)
    assert np.allclose(iso.point_data["magW"], 2.0) and "W" in iso.point_data


def test_cut_plane_keeps_only_the_shown_field_and_the_asked_extras(tmp_path: Path, monkeypatch):
    case, mesh = _t_case(tmp_path)
    _scalar_file(case / "1" / "Y", "Y", np.ones(64))
    mesh.point_data["Y"] = np.ones(mesh.n_points)
    mesh.cell_data["Y"] = np.ones(mesh.n_cells)
    _patch_volume(monkeypatch, mesh)

    def cut(name: str, **params) -> pv.PolyData:
        out = tmp_path / name
        res = _rpc("filter.cut_plane", {"case_dir": str(case), "time": "1", "out_dir": str(out),
                                        "ox": 0.2, "oy": 0.2, "oz": 0.2, "nx": 0, "ny": 1, "nz": 0, **params})
        assert "result" in res, res
        return pv.read(str(out / "cut_plane.vtp"))

    for name, params in (("named", {"field": "T", "extra": ""}), ("default", {"extra": []})):
        data = cut(name, **params)
        assert set(data.point_data.keys()) | set(data.cell_data.keys()) == {"T"}, name
    # No extra at all (today's page): every scalar the frame wrote.
    data = cut("all", field="T")
    assert set(data.point_data.keys()) | set(data.cell_data.keys()) == {"T", "Y"}
    data = cut("extra", field="T", extra=["Y", "missing"])
    assert set(data.point_data.keys()) | set(data.cell_data.keys()) == {"T", "Y"}
    meta = json.loads((tmp_path / "extra" / "cut_plane.meta.json").read_text(encoding="utf-8"))
    assert (meta["field"], meta["vector_field"], meta["extra"]) == ("T", None, ["Y"])


def test_cut_plane_for_a_page_that_names_no_extra_keeps_p_and_t(tmp_path: Path, monkeypatch):
    """The page colours a cut plane's glyphs by p or T and reads inspect picks from
    the slice: with no extra named the slice keeps them; extra='' keeps only the
    field, the vector and its magnitude."""
    case = _case(tmp_path, {"rho": RHO, "kinematic_fields": ["p"]}, {"p": np.full(64, 10.0), "T": np.full(64, 300.0)})
    _foam_file(case / "1" / "U", "volVectorField", "uniform (1 0 0)")
    mesh = _mesh({"p": 10.0, "T": 300.0})
    mesh.point_data["U"] = np.tile([1.0, 0.0, 0.0], (mesh.n_points, 1))
    mesh.cell_data["U"] = np.tile([1.0, 0.0, 0.0], (mesh.n_cells, 1))
    _patch_volume(monkeypatch, mesh)

    def cut(name: str, **params) -> pv.PolyData:
        out = tmp_path / name
        res = _rpc("filter.cut_plane", {"case_dir": str(case), "time": "1", "out_dir": str(out), "field": "magU",
                                        "ox": 0.2, "oy": 0.2, "oz": 0.2, "nx": 0, "ny": 1, "nz": 0, **params})
        assert "result" in res, res
        return pv.read(str(out / "cut_plane.vtp"))

    data = cut("page")
    assert {"magU", "U", "p", "T"} <= set(data.point_data.keys())
    assert np.allclose(data.point_data["p"], 10.0 * RHO) and np.allclose(data.point_data["T"], 300.0)
    data = cut("none", extra="")
    assert set(data.point_data.keys()) | set(data.cell_data.keys()) == {"magU", "U"}

    # The CLI follows the same rule: --extra left out keeps them, --extra "" does not.
    import export_cut_plane

    monkeypatch.setattr(export_cut_plane, "read_volume_at_time", lambda c, t: (mesh.copy(), "test"))
    for name, extra in (("cli-page", None), ("cli-none", "")):
        export_cut_plane.export_cut_plane(case, "1", tmp_path / name, ox=0.2, oy=0.2, oz=0.2, nx=0, ny=1, nz=0,
                                          field="magU", extra=extra)
    page = pv.read(str(tmp_path / "cli-page" / "cut_plane.vtp"))
    none = pv.read(str(tmp_path / "cli-none" / "cut_plane.vtp"))
    assert {"p", "T"} <= set(page.point_data.keys())
    assert set(none.point_data.keys()) | set(none.cell_data.keys()) == {"magU", "U"}


def _w_case(tmp_path: Path, sidecar: dict, vectors=("W",)) -> tuple[Path, pv.UnstructuredGrid]:
    """A case whose velocity is W (no U), with p, plus any other vectors given."""
    case = _case(tmp_path, sidecar, {"p": np.full(64, 10.0)})
    mesh = _mesh({"p": 10.0})
    for name in vectors:
        _foam_file(case / "1" / name, "volVectorField", "uniform (1 0 0)")
        mesh.point_data[name] = np.tile([1.0, 0.0, 0.0] if name == "W" else [0.0, 0.0, 3.0], (mesh.n_points, 1))
        mesh.cell_data[name] = np.tile([1.0, 0.0, 0.0] if name == "W" else [0.0, 0.0, 3.0], (mesh.n_cells, 1))
    return case, mesh


VELOCITY_W = {"key": "W", "kind": "vector", "unit_quantity": "velocity", "label": "Wind"}


def test_particle_trace_follows_the_cases_velocity_vector(tmp_path: Path, monkeypatch):
    sidecar = {"rho": RHO, "kinematic_fields": [], "result_fields": [
        {"key": "B", "kind": "vector", "unit_quantity": "magnetic_field"}, VELOCITY_W,
    ]}
    case, mesh = _w_case(tmp_path, sidecar, vectors=("B", "W"))
    _patch_volume(monkeypatch, mesh)
    out = tmp_path / "pt"
    res = _rpc("filter.particle_trace", {"case_dir": str(case), "time": "1", "out_dir": str(out)})
    assert "result" in res, res
    data = pv.read(str(out / "particle_trace.vtp"))
    assert data.n_points > 0
    assert {"W", "magW", "p"} <= set(data.point_data.keys())
    assert "U" not in data.point_data and "magU" not in data.point_data and "B" not in data.point_data
    assert np.allclose(data.point_data["magW"], 1.0)
    # kinematic_fields [] keeps p as stored.
    assert np.allclose(data.point_data["p"], 10.0)
    meta = json.loads((out / "particle_trace.meta.json").read_text(encoding="utf-8"))
    assert (meta["vector_field"], meta["coloring_field"]) == ("W", "magW")
    assert meta["source_foam"]["W"] == str((case / "1" / "W").resolve())
    assert "magU_min" not in meta and abs(meta["vector_magnitude_max"] - 1.0) < 1e-9

    # A coloring field: the paths carry only it beside the vector.
    out2 = tmp_path / "pt-colour"
    res = _rpc("filter.particle_trace", {"case_dir": str(case), "time": "1", "out_dir": str(out2), "coloring": "magB"})
    assert "result" in res, res
    data = pv.read(str(out2 / "particle_trace.vtp"))
    assert {"W", "magW", "magB"} <= set(data.point_data.keys()) and "p" not in data.point_data
    assert np.allclose(data.point_data["magB"], 3.0)


def test_particle_trace_sole_vector_on_a_fresh_read(tmp_path: Path, monkeypatch):
    import export_particle_trace

    case, mesh = _w_case(tmp_path, {"rho": RHO, "kinematic_fields": ["p"]})
    monkeypatch.setattr(export_particle_trace, "read_volume_at_time", lambda c, t: (mesh.copy(), "test"))
    meta = export_particle_trace.export_particle_trace(case, "1", tmp_path / "pt")
    data = pv.read(str(tmp_path / "pt" / "particle_trace.vtp"))
    assert meta["vector_field"] == "W" and data.n_points > 0
    assert np.allclose(data.point_data["p"], 10.0 * RHO)


def test_particle_trace_without_a_velocity_says_so(tmp_path: Path, monkeypatch):
    case, mesh = _t_case(tmp_path)
    _patch_volume(monkeypatch, mesh)
    res = _rpc("filter.particle_trace", {"case_dir": str(case), "time": "1", "out_dir": str(tmp_path / "pt")})
    assert res["error"]["message"] == "This case has no velocity field to trace", res


def test_writing_a_case_stamps_its_kinematic_fields(tmp_path: Path):
    """API 1.4: the analysis's kinematic_fields go in the sidecar; the writer's own
    list wins; an analysis that does not declare them leaves the sidecar alone,
    and such a case is read as before (p)."""
    from types import SimpleNamespace

    from cfddesk.registry.analysis import AnalysisType, _stamp_case

    declared = tmp_path / "declared"
    declared.mkdir()
    _stamp_case(declared, "x_steady", SimpleNamespace(frame_fields=("U", "p"), kinematic_fields=("p", "p_rgh")))
    doc = json.loads((declared / "w27-case.json").read_text(encoding="utf-8"))
    assert doc["kinematic_fields"] == ["p", "p_rgh"]
    assert case_units.kinematic_fields(declared) == ("p", "p_rgh")

    own = tmp_path / "own"
    own.mkdir()
    (own / "w27-case.json").write_text(json.dumps({"rho": RHO, "kinematic_fields": []}), encoding="utf-8")
    _stamp_case(own, "x_steady", SimpleNamespace(frame_fields=("U", "p"), kinematic_fields=("p",)))
    assert json.loads((own / "w27-case.json").read_text(encoding="utf-8"))["kinematic_fields"] == []
    assert case_units.kinematic_fields(own) == ()

    # An analysis that does not declare them (as the stub analysis): no list.
    undeclared = tmp_path / "undeclared"
    undeclared.mkdir()
    stub_like = AnalysisType("stub_diffusion_steady", "Stub", "TEST", "steady", ("T",))
    assert stub_like.kinematic_fields is None
    _stamp_case(undeclared, stub_like.key, stub_like)
    doc = json.loads((undeclared / "w27-case.json").read_text(encoding="utf-8"))
    assert "kinematic_fields" not in doc and doc["frame_fields"] == ["T"]
    assert case_units.kinematic_fields(undeclared) == case_units.LEGACY_KINEMATIC_FIELDS == ("p",)
