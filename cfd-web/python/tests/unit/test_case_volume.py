"""Native solved fields must supersede a mesh-only prepared snapshot."""
from pathlib import Path

import pyvista as pv

from tools import case_volume


def test_solved_time_uses_native_fields_instead_of_prepared_mesh(tmp_path: Path, monkeypatch):
    prepared = pv.ImageData(dimensions=(2, 2, 2)).cast_to_unstructured_grid()
    prepared.save(tmp_path / ".cfddesk-prepared.vtu")
    (tmp_path / "0.5").mkdir()
    (tmp_path / "0.5" / "U").write_text("native field placeholder")
    solved = prepared.copy()
    solved.point_data["U"] = [[2.0, 0.0, 0.0]] * solved.n_points
    monkeypatch.setattr(case_volume, "read_openfoam_volume", lambda case, time: solved)
    volume, source = case_volume.load_volume(tmp_path, "0.5", use_cache=False)
    assert "U" in volume.point_data
    assert volume.point_data["U"][0, 0] == 2.0
    assert source.startswith("OpenFOAMReader:")


def test_legacy_prepared_case_remains_readable(tmp_path: Path):
    prepared = pv.ImageData(dimensions=(2, 2, 2)).cast_to_unstructured_grid()
    prepared.point_data["U"] = [[1.0, 0.0, 0.0]] * prepared.n_points
    prepared.save(tmp_path / ".cfddesk-prepared.vtu")
    volume, source = case_volume.load_volume(tmp_path, "0", use_cache=False)
    assert "U" in volume.point_data
    assert source.endswith(".cfddesk-prepared.vtu")

