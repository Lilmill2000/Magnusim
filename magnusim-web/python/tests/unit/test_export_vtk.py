"""Export to ParaView (VTK): python/tools/export_vtk.py on the committed cavity case.

The zip holds a .vtm per frame (the internal mesh .vtu and a .vtp per boundary
patch) with every saved field as cell data, a .pvd for several frames and a
README; kinematic pressure is multiplied by the case's density and saved as p_Pa.
"""
from __future__ import annotations

import json
import shutil
import zipfile
from pathlib import Path

import export_vtk
import numpy as np
import pytest
import pyvista as pv
from export_case_field import read_internal_field

CAVITY = Path(__file__).resolve().parents[1] / "fixtures" / "foam-results" / "cavity-2d"
N_CELLS = 400  # constant/polyMesh/owner: nCells:400
TIMES = ["0.1", "0.2", "0.3", "0.4", "0.5"]


@pytest.fixture()
def case(tmp_path: Path) -> Path:
    dst = tmp_path / "Run 1" / "case"
    shutil.copytree(CAVITY, dst)
    return dst


def _unzip(zip_path: Path, dest: Path) -> Path:
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(dest)
    return dest


def _events(capsys) -> list[dict]:
    out = capsys.readouterr().out
    return [
        json.loads(line[len("MAGNUSIM_EVENT ") :])
        for line in out.splitlines()
        if line.startswith("MAGNUSIM_EVENT ")
    ]


def test_one_frame_has_the_mesh_and_every_field_with_pressure_in_pa(case, tmp_path, capsys):
    result = export_vtk.export_vtk(case, ["0.5"], tmp_path / "out", name="Run 1")
    zip_path = Path(result["zip"])
    assert zip_path.name == "Run_1.zip" and zip_path.is_file()
    assert result["n_cells"] == N_CELLS
    assert result["fields"] == ["U", "p_Pa"]
    assert result["pa_fields"] == ["p_Pa"] and result["rho"] == 1000.0
    assert result["open"] == "Run_1_0.5.vtm"
    with zipfile.ZipFile(zip_path) as zf:
        names = set(zf.namelist())
    assert {"README.txt", "Run_1_0.5.vtm", "Run_1/0.5/internalMesh.vtu"} <= names
    assert {f"Run_1/0.5/boundary/{p}.vtp" for p in ("movingWall", "fixedWalls", "frontAndBack")} <= names
    assert not any(n.endswith(".pvd") for n in names)  # one frame: no time series

    root = _unzip(zip_path, tmp_path / "x")
    mb = pv.read(root / "Run_1_0.5.vtm")
    assert isinstance(mb, pv.MultiBlock)
    internal = mb["internalMesh"]
    assert internal.n_cells == N_CELLS
    assert "p" not in internal.cell_data and "p" not in internal.point_data
    _, p = read_internal_field(case / "0.5" / "p", "scalar")
    _, u = read_internal_field(case / "0.5" / "U", "vector")
    np.testing.assert_allclose(internal.cell_data["p_Pa"], p * 1000.0, rtol=1e-5, atol=1e-6)
    np.testing.assert_allclose(internal.cell_data["U"], u, rtol=1e-5, atol=1e-9)
    assert "Pa" in str(internal.field_data["Magnusim_units"][0])
    boundary = mb["boundary"]
    assert sorted(boundary.keys()) == ["fixedWalls", "frontAndBack", "movingWall"]
    lid = boundary["movingWall"]
    assert lid.n_cells == 20 and {"U", "p_Pa"} <= set(lid.cell_data.keys())
    # The lid moves at 1 m/s along x: its face values say so.
    np.testing.assert_allclose(lid.cell_data["U"][:, 0], 1.0)

    readme = (root / "README.txt").read_text(encoding="utf-8")
    assert "Open Run_1_0.5.vtm in ParaView" in readme
    assert "x density 1000 kg/m^3, in Pa" in readme

    events = _events(capsys)
    fractions = [e["fraction"] for e in events if e["event"] == "progress"]
    assert fractions == sorted(fractions) and fractions[-1] == 1.0
    assert events[-1]["event"] == "exported" and events[-1]["file_name"] == "Run_1.zip"
    # The build folder is gone; only the zip stays.
    assert sorted(p.name for p in (tmp_path / "out").iterdir()) == ["Run_1.zip"]


def test_all_frames_make_a_time_series(case, tmp_path):
    result = export_vtk.export_vtk(case, TIMES, tmp_path / "out", name="cavity")
    assert result["open"] == "cavity.pvd"
    root = _unzip(Path(result["zip"]), tmp_path / "x")
    pvd = (root / "cavity.pvd").read_text(encoding="utf-8")
    for t in TIMES:
        assert f'timestep="{t}"' in pvd and f'file="cavity_{t}.vtm"' in pvd
        frame = pv.read(root / f"cavity_{t}.vtm")["internalMesh"]
        _, p = read_internal_field(case / t / "p", "scalar")
        np.testing.assert_allclose(frame.cell_data["p_Pa"], p * 1000.0, rtol=1e-5, atol=1e-6)
    series = pv.get_reader(str(root / "cavity.pvd"))
    assert [round(float(t), 6) for t in series.time_values] == [float(t) for t in TIMES]


def test_without_a_density_pressure_keeps_its_name_and_unit(case, tmp_path):
    sidecar = case / "w27-case.json"
    doc = json.loads(sidecar.read_text(encoding="utf-8"))
    doc.pop("rho")
    sidecar.write_text(json.dumps(doc), encoding="utf-8")
    result = export_vtk.export_vtk(case, ["0.5"], tmp_path / "out")
    assert result["fields"] == ["U", "p"] and result["pa_fields"] == []
    root = _unzip(Path(result["zip"]), tmp_path / "x")
    internal = pv.read(root / "results_0.5.vtm")["internalMesh"]
    _, p = read_internal_field(case / "0.5" / "p", "scalar")
    np.testing.assert_allclose(internal.cell_data["p"], p, rtol=1e-5, atol=1e-9)
    assert "not converted to Pa" in str(internal.field_data["Magnusim_units"][0])


def test_a_case_with_no_kinematic_field_is_written_as_is(case, tmp_path):
    sidecar = case / "w27-case.json"
    doc = json.loads(sidecar.read_text(encoding="utf-8"))
    doc["kinematic_fields"] = []
    sidecar.write_text(json.dumps(doc), encoding="utf-8")
    result = export_vtk.export_vtk(case, ["0.5"], tmp_path / "out")
    assert result["fields"] == ["U", "p"]
    assert result["units_note"] == "Fields are as OpenFOAM wrote them (SI units)."


def test_errors_are_plain_sentences(case, tmp_path, capsys):
    with pytest.raises(export_vtk.ExportError, match=r"no saved frame at 0\.7"):
        export_vtk.export_vtk(case, ["0.7"], tmp_path / "out")
    with pytest.raises(export_vtk.ExportError, match="No frame to export"):
        export_vtk.export_vtk(case, [""], tmp_path / "out")
    with pytest.raises(export_vtk.ExportError, match="not a saved frame time"):
        export_vtk.export_vtk(case, ["../x"], tmp_path / "out")
    shutil.rmtree(case / "constant" / "polyMesh")
    with pytest.raises(export_vtk.ExportError, match="has no mesh"):
        export_vtk.export_vtk(case, ["0.5"], tmp_path / "out")
    capsys.readouterr()
    code = export_vtk.main(["--case", str(case), "--times", "0.5", "--out-dir", str(tmp_path / "o2")])
    assert code == 1
    events = _events(capsys)
    assert events[-1] == {
        "event": "export_error",
        "error": "The run's case has no mesh (constant/polyMesh is missing).",
    }


def test_file_names_are_safe():
    assert export_vtk.safe_name("Run 1 (copy)") == "Run_1_copy"
    assert export_vtk.safe_name("../..") == "results"
    assert export_vtk.safe_name("") == "results"
    assert len(export_vtk.safe_name("x" * 300)) == 80
