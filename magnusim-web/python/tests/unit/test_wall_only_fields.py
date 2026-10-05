"""Fields stored on the walls only (y+, wall shear stress) colour the surface by their wall values.

A function object writes them with a uniform internal field (0 inside) and one
value per face on the wall patches. The exporters must read the patch values
(the volume reader puts them on the boundary points), never fill the surface
with the uniform 0 inside, and scale a kinematic vector and its magnitude by
rho once. The file layout below is what OpenFOAM v2606 writes (ascii and binary).
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
import case_volume  # noqa: E402
from case_units import scale_kinematic  # noqa: E402
from export_case_field import parse_foam_scalar_or_vector, read_boundary_values  # noqa: E402

RHO = 1.2
WALL_YPLUS = np.array([31.5, 44.0, 187.25, 52.0])
WALL_TAU = np.array([[1.0, 0.0, 0.0], [0.0, 2.0, 0.0], [3.0, 4.0, 0.0], [0.5, 0.0, 0.0]])


def _rpc(method: str, params: dict) -> dict:
    msg = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    return json.loads(handle_line(json.dumps(msg)))


def _wall_field(fmt: str, kind: str, name: str, values: np.ndarray) -> bytes:
    """An OpenFOAM field file as a function object writes it: 0 inside, values on the walls."""
    vec = kind == "vector"
    cls = "volVectorField" if vec else "volScalarField"
    zero = "(0 0 0)" if vec else "0"
    head = (
        "FoamFile\n{\n    version     2.0;\n    format      " + fmt + ";\n"
        '    arch        "LSB;label=32;scalar=64";\n'
        f"    class       {cls};\n    object      {name};\n}}\n\n"
        f"dimensions      [0 2 -2 0 0 0 0];\n\ninternalField   uniform {zero};\n\n"
        "boundaryField\n{\n"
        f"    inlet\n    {{\n        type            calculated;\n        value           uniform {zero};\n    }}\n"
        "    frontAndBack\n    {\n        type            empty;\n    }\n"
        "    walls\n    {\n        type            calculated;\n"
        f"        value           nonuniform List<{kind}> \n{len(values)}\n("
    ).encode("latin1")
    if fmt == "binary":
        body = np.asarray(values, dtype="<f8").tobytes()
    else:
        rows = [f"({a!r} {b!r} {c!r})" for a, b, c in values.tolist()] if vec else [repr(float(v)) for v in values]
        body = ("\n" + "\n".join(rows) + "\n").encode("latin1")
    return head + body + b")\n;\n    }\n}\n\n\n// ************************************************************************* //\n"


def _case(tmp_path: Path, fmt: str = "binary") -> Path:
    case = tmp_path / "case"
    (case / "1").mkdir(parents=True)
    (case / "w27-case.json").write_text(
        json.dumps({"rho": RHO, "kinematic_fields": ["p", "wallShearStress", "pMean"]}), encoding="utf-8"
    )
    (case / "1" / "yPlus").write_bytes(_wall_field(fmt, "scalar", "yPlus", WALL_YPLUS))
    (case / "1" / "wallShearStress").write_bytes(_wall_field(fmt, "vector", "wallShearStress", WALL_TAU))
    (case / "1" / "U").write_text("internalField   uniform (1 0 0);\n", encoding="utf-8")
    return case


def _mesh() -> pv.UnstructuredGrid:
    """Like OpenFOAMReader output: 0 in the cells, the wall values on the wall points (x = 0)."""
    mesh = pv.ImageData(dimensions=(5, 5, 5), spacing=(0.1, 0.1, 0.1)).cast_to_unstructured_grid()
    wall = np.isclose(mesh.points[:, 0], 0.0)
    mesh.cell_data["yPlus"] = np.zeros(mesh.n_cells)
    mesh.point_data["yPlus"] = np.where(wall, WALL_YPLUS.max(), 0.0)
    mesh.cell_data["wallShearStress"] = np.zeros((mesh.n_cells, 3))
    tau = np.zeros((mesh.n_points, 3))
    tau[wall] = WALL_TAU[2]
    mesh.point_data["wallShearStress"] = tau
    mesh.cell_data["U"] = np.tile([1.0, 0.0, 0.0], (mesh.n_cells, 1))
    mesh.point_data["U"] = np.tile([1.0, 0.0, 0.0], (mesh.n_points, 1))
    return mesh


def _patch_volume(monkeypatch, mesh) -> None:
    volume_cache.clear()
    monkeypatch.setattr(case_volume, "load_volume", lambda case, time, **_kw: (mesh, "test"))


@pytest.mark.parametrize("fmt", ["binary", "ascii"])
def test_boundary_values_are_read_from_ascii_and_binary(tmp_path, fmt):
    case = _case(tmp_path, fmt)
    values, per_face = read_boundary_values(case / "1" / "yPlus", "scalar")
    assert per_face is True
    # The inlet's uniform 0, then the four wall faces (the empty patch has no value).
    assert values.tolist() == [0.0, *WALL_YPLUS.tolist()]
    vectors, per_face = read_boundary_values(case / "1" / "wallShearStress", "vector")
    assert per_face is True and vectors.shape == (5, 3)
    assert np.allclose(vectors[1:], WALL_TAU)


def test_a_field_with_uniform_patches_only_is_not_wall_only(tmp_path):
    path = tmp_path / "U"
    path.write_text(
        "FoamFile\n{\n    format      ascii;\n    class       volVectorField;\n}\n"
        "internalField   uniform (0 0 0);\nboundaryField\n{\n    inlet\n    {\n"
        "        type            fixedValue;\n        value           uniform (5 0 0);\n    }\n}\n",
        encoding="utf-8",
    )
    values, per_face = read_boundary_values(path, "vector")
    assert per_face is False and values.tolist() == [[5.0, 0.0, 0.0]]
    stats = parse_foam_scalar_or_vector(path, "vector")
    assert stats["uniform"] is True and not stats.get("boundary_only")


@pytest.mark.parametrize("fmt", ["binary", "ascii"])
def test_wall_only_stats_are_the_wall_values(tmp_path, fmt):
    case = _case(tmp_path, fmt)
    stats = parse_foam_scalar_or_vector(case / "1" / "yPlus", "scalar")
    assert stats["uniform"] is False and stats["boundary_only"] is True
    assert (stats["pmin"], stats["pmax"]) == (0.0, float(WALL_YPLUS.max()))
    stats = parse_foam_scalar_or_vector(case / "1" / "wallShearStress", "vector")
    assert stats["boundary_only"] is True and stats["umax"] == pytest.approx(5.0)


def test_surface_keeps_the_wall_values(tmp_path, monkeypatch):
    case = _case(tmp_path)
    _patch_volume(monkeypatch, _mesh())
    out = tmp_path / "surf"
    res = _rpc("filter.case_field", {"case_dir": str(case), "time": "1", "field": "yPlus", "out_dir": str(out)})
    assert "result" in res, res
    surf = pv.read(str(out / "yPlus.vtp"))
    assert float(np.max(surf.point_data["yPlus"])) == pytest.approx(WALL_YPLUS.max())
    meta = json.loads((out / "yPlus.meta.json").read_text(encoding="utf-8"))
    assert meta["uniform_foam"] is False
    assert (meta["foam_proof"]["min"], meta["foam_proof"]["max"]) == (0.0, float(WALL_YPLUS.max()))


def test_wall_shear_stress_shows_in_pa_once(tmp_path, monkeypatch):
    case = _case(tmp_path)
    _patch_volume(monkeypatch, _mesh())
    out = tmp_path / "surf"
    res = _rpc(
        "filter.case_field",
        {"case_dir": str(case), "time": "1", "field": "magwallShearStress", "out_dir": str(out)},
    )
    assert "result" in res, res
    surf = pv.read(str(out / "magwallShearStress.vtp"))
    assert float(np.max(surf.point_data["magwallShearStress"])) == pytest.approx(5.0 * RHO)
    # Its vector rides along on the points in the same unit.
    assert float(np.max(np.linalg.norm(surf.point_data["wallShearStress"], axis=1))) == pytest.approx(5.0 * RHO)
    meta = json.loads((out / "magwallShearStress.meta.json").read_text(encoding="utf-8"))
    assert meta["foam_proof"]["max"] == pytest.approx(5.0 * RHO)
    assert meta["scaled_by_density"] is True


def test_inspect_reads_the_probed_wall_value_not_the_uniform_inside(tmp_path, monkeypatch):
    case = _case(tmp_path)
    mesh = _mesh()
    mesh.point_data["yPlus"] = np.full(mesh.n_points, 42.0)
    _patch_volume(monkeypatch, mesh)
    res = _rpc("filter.inspect", {"case_dir": str(case), "time": "1", "out_dir": str(tmp_path / "o"),
                                  "x": 0.0, "y": 0.2, "z": 0.2, "fields": ["yPlus"]})
    assert abs(res["result"]["values"]["yPlus"] - 42.0) < 1e-9


def test_scale_kinematic_scales_a_vector_and_its_magnitude(tmp_path):
    case = _case(tmp_path)
    ds = pv.PolyData(np.zeros((2, 3)))
    ds.point_data["wallShearStress"] = np.array([[3.0, 4.0, 0.0], [0.0, 0.0, 0.0]])
    ds.point_data["magwallShearStress"] = np.array([5.0, 0.0])
    scale_kinematic(ds, case)
    assert np.allclose(ds.point_data["wallShearStress"][0], [3.0 * RHO, 4.0 * RHO, 0.0])
    assert np.allclose(ds.point_data["magwallShearStress"], [5.0 * RHO, 0.0])
