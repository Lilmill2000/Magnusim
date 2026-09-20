"""Isolated remesh: prove the VF wall annulus is carved, not filled.

WSL case: ``cfddesk-outlet-gap-verify`` (does not touch the UI case or
the SST campaign). Writes ``runs/phase5c/OUTLET-GAP-INVESTIGATE/``.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import numpy as np
import pyvista as pv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cfddesk.cad.location import find_location_in_mesh
from cfddesk.cad.passage import check_passage_cells, measure_role_passages
from cfddesk.cad.step import load_step
from cfddesk.mesh.case_writer import prepare_standard_mesh_case
from cfddesk.mesh.gmsh_standard import apply_boundary_patch_types, emitted_patch_types
from cfddesk.project.mesh_sizing import base_cell_from_fineness
from cfddesk.project.model import Project, _bbox_diagonal_m_for_project
from cfddesk.project.settings import MeshSettings
from cfddesk.runner.sync import copy_back
from cfddesk.wsl.mesh_run import run_cfmesh_pipeline

STEP = Path(r"C:\Users\drmil\Desktop\3D\Step Files\Vortex CFD Test.step")
PROJECT = Path(r"C:\Users\drmil\Documents\Simulations\New folder (5)\project.json")
OUT = ROOT / "runs" / "phase5c" / "OUTLET-GAP-INVESTIGATE"
WSL_ID = "cfddesk-outlet-gap-verify"

Z = 0.3048
R_IN = 0.0254
R_OUT = 0.030175
# Baseline F=5 hexcore filled the metal with 3634 cells.
BASELINE_METAL_CELLS = 3634


def probe_vf_wall(mesh_dir: Path) -> dict:
    foam = mesh_dir / "case.foam"
    if not foam.exists():
        foam.write_text("", encoding="utf-8")
    reader = pv.OpenFOAMReader(str(foam))
    reader.skip_zero_time = False
    try:
        reader.enable_all_patches = True
    except Exception:
        pass
    if hasattr(reader, "all_patches"):
        try:
            reader.all_patches = True
        except Exception:
            pass
    if reader.time_values:
        reader.set_active_time_value(reader.time_values[0])
    mb = reader.read()
    internal = mb["internalMesh"]
    cc = np.asarray(internal.cell_centers().points)
    r = np.hypot(cc[:, 0], cc[:, 1])
    # Interior of the metal tube — not the fluid under the VF floor (z<254 mm)
    # and not keep=1 centroids sitting on the end-cap faces.
    metal = (cc[:, 2] > 0.260) & (cc[:, 2] < 0.300) & (r > R_IN) & (r < R_OUT)
    surf = internal.extract_surface()
    surf = surf.compute_normals(
        cell_normals=True, point_normals=False, auto_orient_normals=False
    )
    scc = np.asarray(surf.cell_centers().points)
    nrm = np.asarray(surf.cell_data["Normals"])
    sr = np.hypot(scc[:, 0], scc[:, 1])
    lid = (
        (np.abs(scc[:, 2] - Z) < 0.008)
        & (np.abs(nrm[:, 2]) > 0.7)
        & (sr > R_IN + 0.0003)
        & (sr < R_OUT - 0.0003)
    )
    return {
        "n_internal": int(internal.n_cells),
        "internal_cells_in_vf_wall": int(metal.sum()),
        "lid_faces": int(lid.sum()),
    }


def render_top(mesh_dir: Path, png: Path, title: str) -> None:
    pv.OFF_SCREEN = True
    foam = mesh_dir / "case.foam"
    if not foam.exists():
        foam.write_text("", encoding="utf-8")
    reader = pv.OpenFOAMReader(str(foam))
    if reader.time_values:
        reader.set_active_time_value(reader.time_values[0])
    surf = reader.read()["internalMesh"].extract_surface()
    pl = pv.Plotter(off_screen=True, window_size=(1400, 1400))
    pl.set_background("white")
    pl.add_mesh(
        surf,
        color="#b0b0b0",
        show_edges=True,
        edge_color="black",
        line_width=0.25,
        lighting=False,
    )
    pl.view_xy()
    pl.camera.focal_point = (0.0, 0.0, Z)
    pl.camera.position = (0.0, 0.0, Z + 0.25)
    pl.camera.up = (0.0, 1.0, 0.0)
    pl.camera.zoom(6.0)
    pl.add_text(title, font_size=10, color="black")
    png.parent.mkdir(parents=True, exist_ok=True)
    pl.show(screenshot=str(png))
    pl.close()


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    project_base = Project.load(PROJECT)
    solid = load_step(STEP)
    m = project_base.mesh
    L = _bbox_diagonal_m_for_project(project_base) or 1.0
    fineness = 5
    base = float(base_cell_from_fineness(L, fineness))
    project = project_base.with_mesh(
        MeshSettings(
            base_cell_m=base,
            refinement=m.refinement,
            location_in_mesh=m.location_in_mesh,
            location_source=m.location_source,
            min_cells_across_passage=float(m.min_cells_across_passage),
            stl_facet_to_cell_ratio=float(m.stl_facet_to_cell_ratio),
            fineness=fineness,
            sizing_mode="automatic",
            physics_based=bool(m.physics_based),
            add_layers=False,
            max_meshing_runtime_s=float(m.max_meshing_runtime_s),
            algorithm="standard",
            hex_element_core=True,
        )
    )
    loc = find_location_in_mesh(solid, float(project.scale_to_metres))
    passages = measure_role_passages(solid, project)
    passage = check_passage_cells(
        passages,
        base_cell_m=base,
        refinement_level=max(
            project.mesh.refinement.inlet, project.mesh.refinement.outlet
        ),
        min_cells=project.mesh.min_cells_across_passage,
    )
    case_dir = OUT / "case"
    results_dir = OUT / "results"
    if case_dir.exists():
        shutil.rmtree(case_dir)
    if results_dir.exists():
        shutil.rmtree(results_dir)
    case_dir.mkdir(parents=True)

    prep = prepare_standard_mesh_case(
        solid,
        project,
        case_dir,
        location=loc,
        passage_check=passage,
        base_cell_m=base,
        refinement=project.mesh.refinement,
    )
    mesh_dict = (case_dir / "system" / "meshDict").read_text(encoding="utf-8")
    print("gap_count", prep.get("gap_count"))
    print("gap_local_ref", prep.get("gap_local_ref"))
    print("gap_min_cell_m", prep.get("gap_min_cell_m"))
    print("hollowCone" in mesh_dict, "objectRefinements" in mesh_dict)

    result = run_cfmesh_pipeline(case_dir, wsl_case_name=WSL_ID, timeout_total=3600.0)
    report: dict = {
        "wsl": WSL_ID,
        "prep": {
            k: prep.get(k)
            for k in (
                "max_cell_m",
                "boundary_cell_m",
                "skin_cell_m",
                "gap_count",
                "gap_local_ref",
                "gap_min_cell_m",
                "stl_max_edge_m",
            )
        },
        "check_ok": bool(result.check_ok),
        "n_cells": result.n_cells,
        "summary": result.summary,
        "meshDict": mesh_dict,
    }
    if not result.check_ok:
        (OUT / "VERIFY.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print("MESH FAIL", result.summary)
        return 1

    copy_back(WSL_ID, results_dir)
    bound = results_dir / "constant" / "polyMesh" / "boundary"
    if bound.is_file():
        apply_boundary_patch_types(bound, emitted_patch_types(project))

    probe = probe_vf_wall(results_dir)
    metal = int(probe["internal_cells_in_vf_wall"])
    lid = int(probe.get("lid_faces") or 0)
    n_cells = int(result.n_cells or probe["n_internal"])
    png = OUT / "images" / "top_outlet.png"
    render_top(
        results_dir, png, f"F=5 gap-aware cells={n_cells} metal={metal} lid={lid}"
    )

    gates = {
        "check_ok": True,
        "gap_refs_written": bool(prep.get("gap_local_ref")),
        "hollow_cone": "hollowCone" in mesh_dict,
        "metal_cells_cleared": metal <= 50,
        "no_lid": lid == 0,
        "cell_budget": n_cells < 2_000_000,
    }
    report.update(
        {
            "probe": probe,
            "gates": gates,
            "ok": all(gates.values()),
            "image": str(png),
        }
    )
    (OUT / "VERIFY.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "meshDict"}, indent=2))
    print("OVERALL", "PASS" if report["ok"] else "FAIL")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
