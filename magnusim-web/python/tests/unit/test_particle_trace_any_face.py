"""Any CAD face can seed a particle trace, including curved walls."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pyvista as pv

TOOLS = Path(__file__).resolve().parents[2] / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from export_particle_trace import (  # noqa: E402
    load_cad_face_surface,
    normalize_cad_face_label,
    resolve_face_ids,
    sample_regular_grid_on_surface,
)


INLET = {
    "id": "face 4@Body1",
    "label": "face 4@Body1",
    "patch": "inlet",
    "available": True,
    "role": "inlet",
    "faces": ["face 4@Body1"],
}


def test_normalize_cad_face_label():
    assert normalize_cad_face_label("Face 13@Body1") == "face 13@Body1"
    assert normalize_cad_face_label("face 2") == "face 2@Body1"
    assert normalize_cad_face_label("walls") is None


def test_resolve_keeps_wall_cad_face():
    assert resolve_face_ids(["face 13@Body1"], [INLET]) == ["face 13@Body1"]
    assert resolve_face_ids(["Face 4@Body1"], [INLET]) == ["face 4@Body1"]
    assert resolve_face_ids([], [INLET]) == ["face 4@Body1"]
    assert resolve_face_ids(["__none__"], [INLET]) == []


def test_curved_face_seeds_lie_on_surface():
    cyl = pv.Cylinder(
        center=(0.0, 0.0, 0.0),
        direction=(0.0, 0.0, 1.0),
        radius=1.0,
        height=2.0,
        resolution=36,
        capping=False,
    )
    pts = np.asarray(sample_regular_grid_on_surface(cyl, 24), dtype=float)
    assert pts.shape[0] == 24
    radii = np.hypot(pts[:, 0], pts[:, 1])
    assert float(np.mean(np.abs(radii - 1.0))) < 0.05
    assert float(np.max(np.abs(radii - 1.0))) < 0.12


def test_load_cad_face_from_preview(tmp_path: Path):
    geom = tmp_path / "geometries" / "Geometry_part"
    geom.mkdir(parents=True)
    (tmp_path / "project.json").write_text("{}", encoding="utf-8")
    (geom / "id.json").write_text(json.dumps({"id": "g1", "kind": "geometry"}), encoding="utf-8")
    case = geom / "simulations" / "Sim" / "meshes" / "Mesh" / "case"
    case.mkdir(parents=True)
    poly = pv.PolyData(
        np.array([[0.0, 0.0, 0.0], [100.0, 0.0, 0.0], [0.0, 100.0, 0.0]], dtype=float),
        np.hstack([[3, 0, 1, 2]]),
    )
    poly.cell_data["faceId"] = np.array([13], dtype=np.int32)
    poly.cell_data["solidId"] = np.array([1], dtype=np.int32)
    poly.save(str(geom / "cad_faces.vtp"))
    (geom / "cad_preview.json").write_text(
        json.dumps({"faces_length_unit": "mm"}), encoding="utf-8"
    )
    loaded, src = load_cad_face_surface(case, "face 13@Body1")
    assert loaded is not None
    assert "CAD" in src
    pts = np.asarray(loaded.points, dtype=float)
    assert pts.shape[0] >= 3
    assert float(np.max(np.abs(pts))) < 0.2
