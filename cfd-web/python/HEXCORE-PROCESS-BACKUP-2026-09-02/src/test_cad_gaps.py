"""Thin-wall CAD gaps must drive hexcore local/object refinement."""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cfddesk.cad.gaps import (
    GapObjectRefinement,
    GapRefinement,
    gap_object_refinements,
    gap_refinements,
    hexcore_gap_controls,
    measure_radial_gaps,
    unresolved_gaps,
)
from cfddesk.mesh.cfmesh_standard import write_mesh_dict
from cfddesk.project.model import Project

STEP = Path(r"C:\Users\drmil\Desktop\3D\Step Files\Vortex CFD Test.step")
PROJECT = Path(r"C:\Users\drmil\Documents\Simulations\New folder (5)\project.json")

# Vortex-finder wall: r=25.4 mm inner, r=30.175 mm outer.
VF_GAP_M = 0.0047752
VF_R_IN = 0.0254
VF_R_OUT = 0.0301752
F5_SKIN_M = 0.0057049054


def _require_step() -> None:
    assert STEP.is_file(), f"vortex STEP missing: {STEP}"


def _project() -> Project:
    if PROJECT.is_file():
        return Project.load(PROJECT)
    walls = [i for i in range(17) if i not in (9, 12)]
    return Project.from_dict(
        {
            "version": 13,
            "units": {
                "scale_to_metres": 0.001,
                "native_unit": "MM",
                "confirmed": True,
                "ambiguous": False,
            },
            "geometries": [{"id": "g1", "name": "G", "step_path": str(STEP), "faces": []}],
            "simulations": [
                {
                    "id": "s1",
                    "name": "Sim",
                    "analysis_type": "incompressible",
                    "geometry_id": "g1",
                    "boundary_conditions": [
                        {
                            "id": "in",
                            "name": "Velocity inlet",
                            "patch_name": "velocity_inlet",
                            "type": "velocity_inlet_fixed",
                            "face_ids": [9],
                        },
                        {
                            "id": "out",
                            "name": "Pressure outlet",
                            "patch_name": "pressure_outlet",
                            "type": "pressure_outlet_gauge",
                            "face_ids": [12],
                        },
                        {
                            "id": "w",
                            "name": "Wall no-slip 1",
                            "patch_name": "walls",
                            "type": "wall_noslip",
                            "face_ids": walls,
                        },
                    ],
                    "meshes": [{"id": "meshA", "name": "Mesh 1", "settings": {}}],
                    "active_mesh_id": "meshA",
                }
            ],
        }
    )


def test_vortex_step_has_vf_wall_gap() -> None:
    _require_step()
    from cfddesk.cad.step import load_step

    solid = load_step(STEP)
    gaps = measure_radial_gaps(solid, scale_to_metres=0.001)
    cyl = [
        g
        for g in gaps
        if g.kind == "coaxial_cylinders" and abs(g.gap_m - VF_GAP_M) < 2e-5
    ]
    assert cyl, f"missing coaxial VF wall; gaps={[ (g.kind, g.face_a, g.face_b, g.gap_m) for g in gaps ]}"
    g = cyl[0]
    assert {g.face_a, g.face_b} == {11, 16}
    assert abs(g.r_inner_m - VF_R_IN) < 2e-5
    assert abs(g.r_outer_m - VF_R_OUT) < 2e-5

    roof = [
        g
        for g in gaps
        if g.kind == "concentric_circles" and abs(g.gap_m - VF_GAP_M) < 2e-5
    ]
    assert roof, "missing roof outlet/annulus pair"
    assert {roof[0].face_a, roof[0].face_b} == {12, 15}

    floor = [
        g
        for g in gaps
        if g.kind == "annular_face" and abs(g.gap_m - VF_GAP_M) < 2e-5
    ]
    assert floor and floor[0].face_a == 10


def test_vf_gap_unresolved_at_standard_skin() -> None:
    _require_step()
    from cfddesk.cad.step import load_step

    solid = load_step(STEP)
    gaps = measure_radial_gaps(solid, scale_to_metres=0.001)
    thin = unresolved_gaps(gaps, skin_cell_m=F5_SKIN_M)
    assert any(abs(g.gap_m - VF_GAP_M) < 2e-5 for g in thin)
    # Barrel (Ø304.8) vs VF is not a thin gap.
    assert all(g.gap_m < 2.0 * F5_SKIN_M for g in thin)


def test_gap_refinements_map_to_split_wall_patches() -> None:
    _require_step()
    from cfddesk.cad.step import load_step

    solid = load_step(STEP)
    project = _project()
    refs, objs, thin = hexcore_gap_controls(solid, project, skin_cell_m=F5_SKIN_M)
    assert thin
    patterns = {r.pattern for r in refs}
    assert "walls__f11" in patterns
    assert "walls__f16" in patterns
    assert "pressure_outlet" in patterns
    # End caps of the VF tube.
    assert "walls__f10" in patterns
    # Entire roof plate is not localRef'd (hollowCone covers the hole rim).
    assert "walls__f15" not in patterns
    cell = min(r.cell_size_m for r in refs)
    assert abs(cell - VF_GAP_M / 3.0) < 2e-5
    assert objs
    assert all(o.r_inner_m < VF_R_IN <= VF_R_OUT < o.r_outer_m for o in objs)


def test_write_mesh_dict_emits_gap_blocks() -> None:
    refs = [
        GapRefinement(
            pattern="walls__f11",
            cell_size_m=0.00159173,
            thickness_m=0.0143256,
            gap_m=0.0047752,
            face_ids=(11,),
        )
    ]
    objs = [
        GapObjectRefinement(
            name="gap_0",
            cell_size_m=0.00159173,
            p0=(0.0, 0.0, 0.249),
            p1=(0.0, 0.0, 0.310),
            r_inner_m=0.0206,
            r_outer_m=0.0350,
            gap_m=0.0047752,
        )
    ]
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "meshDict"
        write_mesh_dict(
            path,
            surface_file="constant/triSurface/geometry.fms",
            max_cell_m=0.0228,
            boundary_cell_m=0.0114,
            skin_cell_m=0.0057,
            gap_refs=refs,
            gap_objects=objs,
            allow_gap_min_cell=False,
        )
        text = path.read_text(encoding="utf-8")
    assert '    "walls__f11"' in text
    assert "cellSize 0.00159173" in text
    assert "objectRefinements" in text
    assert "type hollowCone" in text
    assert "minCellSize     0.0114" in text


def test_write_mesh_dict_gap_floor_drops_min_cell() -> None:
    refs = [
        GapRefinement(
            pattern="pressure_outlet",
            cell_size_m=0.00159173,
            thickness_m=0.0143256,
            gap_m=0.0047752,
            face_ids=(12,),
        )
    ]
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "meshDict"
        write_mesh_dict(
            path,
            surface_file="constant/triSurface/geometry.fms",
            max_cell_m=0.0228,
            boundary_cell_m=0.0114,
            skin_cell_m=0.0057,
            gap_refs=refs,
            allow_gap_min_cell=True,
        )
        text = path.read_text(encoding="utf-8")
    assert "minCellSize     0.00159173" in text


def test_gap_object_dedupes_same_annulus() -> None:
    from cfddesk.cad.gaps import RadialGap

    a = RadialGap(
        face_a=11,
        face_b=16,
        gap_m=VF_GAP_M,
        r_inner_m=VF_R_IN,
        r_outer_m=VF_R_OUT,
        axis=(0.0, 0.0, 1.0),
        origin_m=(0.0, 0.0, 0.0),
        kind="coaxial_cylinders",
        s_min_m=0.254,
        s_max_m=0.3048,
    )
    b = RadialGap(
        face_a=12,
        face_b=15,
        gap_m=VF_GAP_M,
        r_inner_m=VF_R_IN,
        r_outer_m=VF_R_OUT,
        axis=(0.0, 0.0, 1.0),
        origin_m=(0.0, 0.0, 0.3048),
        kind="concentric_circles",
        s_min_m=0.0,
        s_max_m=0.0,
    )
    objs = gap_object_refinements([a, b], min_cells=3.0)
    assert len(objs) == 1
    assert objs[0].p0[2] < 0.254
    assert objs[0].p1[2] > 0.3048


def test_hexcore_fingerprint_marks_gap_recipe() -> None:
    from cfddesk.project.settings import MeshSettings

    m = MeshSettings(algorithm="standard", hex_element_core=True)
    payload = m.fingerprint()
    off = MeshSettings(algorithm="standard", hex_element_core=False).fingerprint()
    assert payload != off


if __name__ == "__main__":
    tests = [
        test_write_mesh_dict_emits_gap_blocks,
        test_write_mesh_dict_gap_floor_drops_min_cell,
        test_gap_object_dedupes_same_annulus,
        test_hexcore_fingerprint_marks_gap_recipe,
        test_vortex_step_has_vf_wall_gap,
        test_vf_gap_unresolved_at_standard_skin,
        test_gap_refinements_map_to_split_wall_patches,
    ]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
