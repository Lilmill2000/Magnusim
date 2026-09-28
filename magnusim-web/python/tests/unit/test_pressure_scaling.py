"""Worker exports must turn kinematic p into Pa exactly once.

The worker volume cache is shared by every export at a time step. Pressure
must stay kinematic in the cache; each export scales only its own output.
"""
# case_volume must import after volume_cache puts tools/ on sys.path.
# ruff: noqa: I001
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pyvista as pv

import cfddesk.worker.methods  # noqa: F401  — register RPCs
from cfddesk.worker import handle_line, volume_cache
import case_volume  # noqa: E402

RHO = 1.2
P_KIN = 10.0
P_PA = P_KIN * RHO


def _rpc(method: str, params: dict) -> dict:
    msg = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    return json.loads(handle_line(json.dumps(msg)))


def _write_scalar(path: Path, values: np.ndarray) -> None:
    body = "\n".join(repr(float(v)) for v in values)
    path.write_text(
        "FoamFile\n{\n    format      ascii;\n    class       volScalarField;\n"
        "    object      p;\n}\n\n"
        f"internalField   nonuniform List<scalar>\n{len(values)}\n(\n{body}\n)\n;\n",
        encoding="utf-8",
    )


def _case(tmp_path: Path, times=("1",), p_by_time=None) -> Path:
    case = tmp_path / "case"
    case.mkdir()
    (case / "w27-case.json").write_text(json.dumps({"rho": RHO}), encoding="utf-8")
    for t in times:
        d = case / t
        d.mkdir()
        vals = (p_by_time or {}).get(t, np.full(64, P_KIN))
        _write_scalar(d / "p", np.asarray(vals, dtype=float))
        (d / "U").write_text("internalField   uniform (1 0 0);\n", encoding="utf-8")
    return case


def _mesh() -> pv.UnstructuredGrid:
    """Like OpenFOAMReader output: U and p on both cells and points."""
    mesh = pv.ImageData(dimensions=(5, 5, 5), spacing=(0.1, 0.1, 0.1)).cast_to_unstructured_grid()
    mesh.cell_data["U"] = np.tile([1.0, 0.0, 0.0], (mesh.n_cells, 1))
    mesh.cell_data["p"] = np.full(mesh.n_cells, P_KIN)
    mesh.point_data["U"] = np.tile([1.0, 0.0, 0.0], (mesh.n_points, 1))
    mesh.point_data["p"] = np.full(mesh.n_points, P_KIN)
    return mesh


def _patch_volume(monkeypatch, mesh) -> None:
    volume_cache.clear()
    monkeypatch.setattr(case_volume, "load_volume", lambda case, time, **_kw: (mesh, "test"))


def _all_p(path: Path) -> np.ndarray:
    data = pv.read(str(path))
    parts = [np.asarray(data.point_data["p"])] if "p" in data.point_data else []
    if "p" in data.cell_data:
        parts.append(np.asarray(data.cell_data["p"]))
    assert parts, f"no p in {path.name}"
    return np.concatenate(parts)


def test_cache_keeps_kinematic_pressure(tmp_path, monkeypatch):
    case = _case(tmp_path)
    _patch_volume(monkeypatch, _mesh())
    entry = volume_cache.get_prepared(str(case), "1")
    for key in ("mesh", "grid", "slice"):
        ds = entry[key]
        assert np.allclose(ds.point_data["p"], P_KIN), key


def test_surface_pressure_is_pa_once_and_never_compounds(tmp_path, monkeypatch):
    case = _case(tmp_path)
    _patch_volume(monkeypatch, _mesh())
    for n in range(3):
        out = tmp_path / f"surf{n}"
        res = _rpc("filter.case_field", {"case_dir": str(case), "time": "1", "field": "p", "out_dir": str(out)})
        assert "result" in res, res
        assert np.allclose(_all_p(out / "p.vtp"), P_PA), f"export {n}"
    entry = volume_cache.get_prepared(str(case), "1")
    assert np.allclose(entry["mesh"].point_data["p"], P_KIN)
    assert np.allclose(entry["mesh"].cell_data["p"], P_KIN)


def test_surface_meta_reports_pressure_range_in_pa(tmp_path, monkeypatch):
    vals = np.linspace(-5.0, 20.0, 64)
    case = _case(tmp_path, p_by_time={"1": vals})
    _patch_volume(monkeypatch, _mesh())
    out = tmp_path / "surf"
    _rpc("filter.case_field", {"case_dir": str(case), "time": "1", "field": "p", "out_dir": str(out)})
    meta = json.loads((out / "p.meta.json").read_text(encoding="utf-8"))
    assert meta["foam_proof"]["pmin"] == -5.0 * RHO
    assert meta["foam_proof"]["pmax"] == 20.0 * RHO
    assert meta["pressure_range_unit"] == "Pa"


def test_cut_plane_pressure_is_pa_once(tmp_path, monkeypatch):
    case = _case(tmp_path)
    _patch_volume(monkeypatch, _mesh())
    # A surface export first: it must not leave the cache pre-scaled for the cut.
    _rpc("filter.case_field", {"case_dir": str(case), "time": "1", "field": "p", "out_dir": str(tmp_path / "s")})
    for n in range(2):
        out = tmp_path / f"cut{n}"
        res = _rpc(
            "filter.cut_plane",
            {"case_dir": str(case), "time": "1", "out_dir": str(out), "field": "p",
             "ox": 0.2, "oy": 0.2, "oz": 0.2, "nx": 0, "ny": 1, "nz": 0},
        )
        assert res.get("result", {}).get("volume_cached") is True, res
        assert np.allclose(_all_p(out / "cut_plane.vtp"), P_PA), f"cut {n}"


def test_particle_trace_pressure_is_pa_and_cache_untouched(tmp_path, monkeypatch):
    case = _case(tmp_path)
    _patch_volume(monkeypatch, _mesh())
    out = tmp_path / "pt"
    res = _rpc("filter.particle_trace", {"case_dir": str(case), "time": "1", "out_dir": str(out)})
    assert "result" in res, res
    vtps = sorted(out.glob("*.vtp"))
    assert vtps, "no particle trace output"
    with_p = [d for d in (pv.read(str(v)) for v in vtps) if "p" in d.point_data and d.n_points]
    assert with_p, f"no particle trace output carries p: {[v.name for v in vtps]}"
    for data in with_p:
        assert np.allclose(data.point_data["p"], P_PA)
    entry = volume_cache.get_prepared(str(case), "1")
    assert np.allclose(entry["grid"].point_data["p"], P_KIN)


def test_series_range_pressure_in_pa(tmp_path):
    case = _case(
        tmp_path,
        times=("0.5", "1"),
        p_by_time={"0.5": np.linspace(-2.0, 3.0, 64), "1": np.linspace(-1.0, 8.0, 64)},
    )
    res = _rpc("filter.series_range", {"case_dir": str(case), "field": "p"})
    out = res["result"]
    assert out["min"] == -2.0 * RHO
    assert out["max"] == 8.0 * RHO
    assert out["unit"] == "Pa"


def test_inspect_through_worker_reports_pa_and_leaves_cache(tmp_path, monkeypatch):
    case = _case(tmp_path)
    _patch_volume(monkeypatch, _mesh())
    for n in range(2):
        out = tmp_path / f"insp{n}"
        res = _rpc("filter.inspect", {"case_dir": str(case), "time": "1", "out_dir": str(out),
                                      "x": 0.2, "y": 0.2, "z": 0.2})
        r = res["result"]
        assert r["hit"] is True and r["volume_cached"] is True
        assert abs(r["p"] - P_PA) < 1e-9, f"inspect {n}"
        assert abs(r["magU"] - 1.0) < 1e-9
        meta = json.loads((out / "inspect.meta.json").read_text(encoding="utf-8"))
        assert meta["units"]["p"] == "Pa" and abs(meta["p"] - P_PA) < 1e-9
        assert meta["volume_from"] == "worker-cache"
    entry = volume_cache.get_prepared(str(case), "1")
    assert np.allclose(entry["slice"].point_data["p"], P_KIN)


def test_inspect_miss_is_honest(tmp_path, monkeypatch):
    case = _case(tmp_path)
    _patch_volume(monkeypatch, _mesh())
    res = _rpc("filter.inspect", {"case_dir": str(case), "time": "1", "out_dir": str(tmp_path / "o"),
                                  "x": 5.0, "y": 5.0, "z": 5.0})
    r = res["result"]
    assert r["hit"] is False and r["p"] is None and r["magU"] is None


def test_inspect_uniform_time_uses_the_uniform_values(tmp_path, monkeypatch):
    case = _case(tmp_path)
    (case / "1" / "p").write_text("internalField   uniform 3;\n", encoding="utf-8")
    (case / "1" / "U").write_text("internalField   uniform (0 0 2);\n", encoding="utf-8")
    _patch_volume(monkeypatch, _mesh())
    res = _rpc("filter.inspect", {"case_dir": str(case), "time": "1", "out_dir": str(tmp_path / "o"),
                                  "x": 0.2, "y": 0.2, "z": 0.2})
    r = res["result"]
    assert abs(r["p"] - 3.0 * RHO) < 1e-9
    assert abs(r["magU"] - 2.0) < 1e-9
    entry = volume_cache.get_prepared(str(case), "1")
    assert np.allclose(entry["slice"].point_data["p"], P_KIN)


def test_inspect_requires_a_point(tmp_path):
    res = _rpc("filter.inspect", {"case_dir": str(tmp_path), "time": "1", "out_dir": str(tmp_path / "o")})
    assert res["error"]["code"] == -32602
