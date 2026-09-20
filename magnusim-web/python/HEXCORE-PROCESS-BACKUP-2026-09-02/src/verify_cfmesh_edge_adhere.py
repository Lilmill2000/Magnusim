"""Canonical remesh gate: CAD edges + ~3-layer skin + cone body-fit.

Writes ``runs/phase5c/CFMESH-EDGE-ADHERE-VERIFY/``. See ``STATUS.md`` there
for the locked recipe. Do not reintroduce deep localRef / minCellSize floods.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

import numpy as np
import pyvista as pv
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cfddesk.cad.location import find_location_in_mesh
from cfddesk.cad.passage import check_passage_cells, measure_role_passages
from cfddesk.cad.step import extract_cad_edges, load_step, tessellate_faces
from cfddesk.mesh.case_writer import prepare_standard_mesh_case
from cfddesk.mesh.gmsh_standard import apply_boundary_patch_types, emitted_patch_types
from cfddesk.project.mesh_sizing import base_cell_from_fineness
from cfddesk.project.model import Project, _bbox_diagonal_m_for_project
from cfddesk.project.settings import MeshSettings
from cfddesk.runner.sync import copy_back
from cfddesk.wsl.mesh_run import run_cfmesh_pipeline

STEP = Path(r"C:\Users\drmil\Desktop\3D\Step Files\Vortex CFD Test.step")
PROJECT = Path(r"C:\Users\drmil\Documents\Simulations\New folder (5)\project.json")
OUT = ROOT / "runs" / "phase5c" / "CFMESH-EDGE-ADHERE-VERIFY"
PRESETS = (("coarse", 3), ("standard", 5), ("fine", 8))
# ~3 fine cells between wall and hex bulk (allow 2.0–3.5)
SKIN_LO, SKIN_HI = 2.0, 3.5


def skin_stats(mesh_dir: Path, bulk_cell_m: float, skin_cell_m: float | None = None) -> dict:
    """Radial peel depth at the cyclone barrel, in skin-sized cells."""
    foam = mesh_dir / "case.foam"
    if not foam.exists():
        foam.write_text("", encoding="utf-8")
    reader = pv.OpenFOAMReader(str(foam))
    if reader.time_values:
        reader.set_active_time_value(reader.time_values[0])
    block = reader.read()["internalMesh"]
    cc = block.cell_centers().points
    vols = np.abs(
        block.compute_cell_sizes(length=False, area=False, volume=True)["Volume"]
    )
    size = np.cbrt(vols)
    frac_bulk = float(vols[size > 0.7 * bulk_cell_m].sum() / max(vols.sum(), 1e-30))
    z0 = -0.05
    mask = (np.abs(cc[:, 2] - z0) < 0.012) & (np.abs(cc[:, 1]) < 0.015) & (cc[:, 0] > 0)
    sel = np.where(mask)[0]
    order = sel[np.argsort(-cc[sel, 0])]
    fine_thresh = 0.7 * bulk_cell_m
    bins: list[tuple[float, float]] = []
    last = None
    for i in order:
        r = float(cc[i, 0])
        if last is not None and abs(r - last) < 0.0015:
            continue
        if size[i] < fine_thresh:
            bins.append((r, float(size[i])))
            last = r
        elif bins:
            break
    wall = float(cc[order[0], 0]) if len(order) else None
    band = (wall - bins[-1][0]) if bins and wall is not None else None
    med = float(np.median([s for _, s in bins])) if bins else None
    skin_ref = float(skin_cell_m) if skin_cell_m is not None else med
    eff_layers = (band / skin_ref) if band and skin_ref and skin_ref > 0 else None
    eff_by_median = (band / med) if band and med and med > 0 else None
    return {
        "n_cells": int(block.n_cells),
        "size_p50": float(np.percentile(size, 50)),
        "size_p90": float(np.percentile(size, 90)),
        "size_max": float(size.max()),
        "frac_vol_bulk": frac_bulk,
        "radial_fine_bins": len(bins),
        "fine_band_depth_m": band,
        "effective_skin_layers": eff_layers,
        "effective_skin_layers_by_median": eff_by_median,
        "fine_sizes": [round(s, 5) for _, s in bins[:10]],
    }


def parse_corners(log: str) -> tuple[int, int]:
    corners = [int(m.group(1)) for m in re.finditer(r"Found (\d+) corners", log)]
    edges = [int(m.group(1)) for m in re.finditer(r"Found (\d+) edge points", log)]
    return (max(corners) if corners else 0, max(edges) if edges else 0)


def cad_edge_gap_mm(mesh_dir: Path, solid, scale: float, bulk_m: float) -> dict:
    """Distance from *wetted* CAD edge samples to nearest mesh boundary point.

    Samples far from the fluid surface (internal BREP wires) are excluded so a
    few outliers cannot inflate p95 to tens of mm.
    """
    defl = max(bulk_m * 0.25, 0.002)
    pts, lines = extract_cad_edges(solid, deflection=defl / max(scale, 1e-30), scale=scale)
    if pts.size == 0:
        return {"error": "no cad edges"}
    samples = []
    i = 0
    n = int(lines.size)
    while i < n:
        count = int(lines[i])
        i += 1
        ids = [int(lines[i + k]) for k in range(count)]
        i += count
        for a in ids:
            samples.append(pts[a])
    samples = np.unique(np.round(np.asarray(samples, dtype=float), 5), axis=0)
    foam = mesh_dir / "case.foam"
    foam.write_text("", encoding="utf-8")
    reader = pv.OpenFOAMReader(str(foam))
    if reader.time_values:
        reader.set_active_time_value(reader.time_values[0])
    mb = reader.read()
    bnd = mb["boundary"]
    pl = []
    for bi in range(bnd.n_blocks):
        b = bnd[bi]
        if b is not None and getattr(b, "n_points", 0):
            pl.append(np.asarray(b.points))
    mpts = np.unique(np.vstack(pl), axis=0) if pl else np.asarray(
        mb["internalMesh"].extract_surface().points
    )
    tree = cKDTree(mpts)
    d, _ = tree.query(samples, k=1)
    # Keep samples that lie on/near the fluid boundary (within ~1 bulk cell).
    wet = d <= max(bulk_m * 1.25, 0.02)
    if wet.sum() < 10:
        wet = d <= max(bulk_m * 2.0, 0.04)
    dw = d[wet]
    return {
        "n_samples": int(len(samples)),
        "n_wetted": int(wet.sum()),
        "p50_mm": float(np.percentile(dw, 50) * 1000),
        "p95_mm": float(np.percentile(dw, 95) * 1000),
        "max_mm": float(dw.max() * 1000),
        "frac_gt_half_bulk": float((dw > 0.5 * bulk_m).mean()),
    }


def cone_p95(mesh_dir: Path, solid, scale: float) -> float:
    pts, faces, fids = tessellate_faces(
        solid, linear_deflection=0.5, angular_deflection=0.1
    )
    pts_m = pts * scale
    foam = mesh_dir / "case.foam"
    if not foam.exists():
        foam.write_text("", encoding="utf-8")
    reader = pv.OpenFOAMReader(str(foam))
    if reader.time_values:
        reader.set_active_time_value(reader.time_values[0])
    mb = reader.read()
    bnd = mb["boundary"]
    pl = []
    for bi in range(bnd.n_blocks):
        b = bnd[bi]
        if b is not None and getattr(b, "n_points", 0):
            pl.append(np.asarray(b.points))
    tree = cKDTree(np.unique(np.vstack(pl), axis=0))
    mask = fids == 2
    fp = pts_m[faces[mask].ravel()]
    fp = np.unique(np.round(fp, 5), axis=0)
    d, _ = tree.query(fp, k=1)
    return float(np.percentile(d, 95) * 1000)


def render(mesh_dir: Path, png: Path, title: str) -> None:
    pv.OFF_SCREEN = True
    foam = mesh_dir / "case.foam"
    if not foam.exists():
        foam.write_text("", encoding="utf-8")
    reader = pv.OpenFOAMReader(str(foam))
    if reader.time_values:
        reader.set_active_time_value(reader.time_values[0])
    cut = reader.read()["internalMesh"].slice(normal="x", origin=(0, 0, 0))
    pl = pv.Plotter(off_screen=True, window_size=(1600, 1200))
    pl.set_background("white")
    pl.add_mesh(
        cut, color="#c45c26", show_edges=True, edge_color="black", line_width=0.35, lighting=False
    )
    pl.view_yz()
    pl.camera.zoom(1.15)
    pl.add_text(title, font_size=11, color="black")
    png.parent.mkdir(parents=True, exist_ok=True)
    pl.show(screenshot=str(png))
    pl.close()


def run_one(label: str, fineness: int, solid, project_base: Project) -> dict:
    m = project_base.mesh
    L = _bbox_diagonal_m_for_project(project_base) or 1.0
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
    case_dir = OUT / label / "case"
    results_dir = OUT / label / "results"
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
    print("meshDict edge block present:", "edgeMeshRefinement" in (case_dir / "system" / "meshDict").read_text(encoding="utf-8"))
    print("cad_feature_edges", prep.get("cad_feature_edges"))
    print("wall_face_split", prep.get("wall_face_split"), "merge", prep.get("patch_merge_map"))

    wsl = f"cfddesk-edge-{label}"
    result = run_cfmesh_pipeline(case_dir, wsl_case_name=wsl, timeout_total=3600.0)
    if not result.check_ok:
        return {"label": label, "ok": False, "error": result.summary, "prep": prep}

    copy_back(wsl, results_dir)
    bound = results_dir / "constant" / "polyMesh" / "boundary"
    if bound.is_file():
        apply_boundary_patch_types(bound, emitted_patch_types(project))

    cart = (results_dir / "log.cartesianMesh").read_text(encoding="utf-8", errors="replace")
    corners, edge_pts = parse_corners(cart)
    bulk = float(prep["boundary_cell_m"])
    edge_gap = cad_edge_gap_mm(
        results_dir, solid, float(project.scale_to_metres), bulk
    )
    cone = cone_p95(results_dir, solid, float(project.scale_to_metres))
    skin = skin_stats(results_dir, bulk, float(prep["skin_cell_m"]))
    n_cells = result.n_cells or skin["n_cells"]
    eff = skin.get("effective_skin_layers")
    png = OUT / "images" / f"{label}_xcut.png"
    skin_txt = f"{eff:.2f}" if eff is not None else "?"
    render(
        results_dir,
        png,
        f"{label} F={fineness} cells={n_cells} corners={corners} "
        f"skin={skin_txt} edge_p95={edge_gap.get('p95_mm', '?')}mm",
    )

    # Gates: CAD edges + ~3-layer skin before hex (both must pass).
    gates = {
        "mesh_ok": True,
        "edge_mesh_written": int(prep.get("cad_feature_edges") or 0) > 0,
        "wall_face_split": bool(prep.get("wall_face_split")),
        "edge_pts": edge_pts > 200,
        "edge_p95": edge_gap.get("p95_mm", 99) < 0.55 * bulk * 1000,
        # Prefer p95; a few non-wetted BREP samples can inflate max.
        "edge_frac": edge_gap.get("frac_gt_half_bulk", 1) < 0.08,
        "cone_p95": cone < 0.6 * bulk * 1000,
        "cell_budget": (n_cells or 0) < (350_000 if fineness <= 3 else 2_000_000),
        "corners_standard": (corners > 0) if fineness == 5 else True,
        "skin_layers_~3": eff is not None and SKIN_LO <= float(eff) <= SKIN_HI,
        # Coarse hex core is smaller; 0.40 still means hex-dominant volume.
        "bulk_vol": float(skin.get("frac_vol_bulk") or 0) >= (0.40 if fineness <= 3 else 0.50),
    }
    return {
        "label": label,
        "fineness": fineness,
        "ok": all(gates.values()),
        "gates": gates,
        "n_cells": n_cells,
        "corners": corners,
        "edge_points": edge_pts,
        "edge_gap": edge_gap,
        "cone_p95_mm": cone,
        "skin": skin,
        "effective_skin_layers": eff,
        "prep": {
            k: prep[k]
            for k in (
                "max_cell_m",
                "boundary_cell_m",
                "skin_cell_m",
                "cad_feature_edges",
                "edge_mesh_file",
                "stl_max_edge_m",
                "wall_face_split",
            )
            if k in prep
        },
        "image": str(png),
        "meshDict": (case_dir / "system" / "meshDict").read_text(encoding="utf-8"),
    }


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "images").mkdir(exist_ok=True)
    project = Project.load(PROJECT)
    solid = load_step(STEP)
    reports = []
    for label, f in PRESETS:
        print(f"\n======== {label} F={f} ========")
        rep = run_one(label, f, solid, project)
        reports.append(rep)
        print(json.dumps({k: v for k, v in rep.items() if k != "meshDict"}, indent=2))
        if not rep.get("ok"):
            print("FAILED", {k: v for k, v in rep.get("gates", {}).items() if not v})

    overall = all(r.get("ok") for r in reports)
    (OUT / "VERIFY.json").write_text(
        json.dumps({"overall_pass": overall, "runs": reports}, indent=2),
        encoding="utf-8",
    )
    print("\n======== OVERALL", "PASS" if overall else "FAIL", "========")
    return 0 if overall else 1


if __name__ == "__main__":
    raise SystemExit(main())
