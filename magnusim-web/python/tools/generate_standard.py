#!/usr/bin/env python3
"""cfd-web Standard mesh Generate — SimScale-style surface-first mesher.

Uniform CAD-fitted triangulated surface (gmsh) → hex element core joined by
pyramids (optional) → tet shell → gmshToFoam → prism layers on walls
(snappyHexMesh, layers only) → checkMesh.

Stdout contract (Phase 1 Step 7):
    MAGNUSIM_EVENT {"event":"progress","stage":...}  one line per stage
    MAGNUSIM_EVENT {"event":"result","ok":...}       exactly one at the end
With --legacy-markers also emit CFMESH_PROGRESS / CFMESH_RESULT for one-phase compat.
Writes ``w21-counts.json`` + ``standard-meta.json`` into --case-dir.
Isolated: never touches the cfMesh HEXCORE backup or another WSL case.
"""
from __future__ import annotations

import argparse
import atexit
import json
import math
import re
import sys
import traceback
from pathlib import Path

# cfd-web/python: the cfddesk library package lives one level up from tools/.
CFDDESK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CFDDESK_ROOT))

from cfddesk.cad.step import load_step
from cfddesk.cad.units import shape_bbox
from cfddesk.jobs import legacy_markers as _legacy
from cfddesk.mesh.generate_guard import claim_generate_case, release_generate_case
from cfddesk.mesh.gmsh_standard import (
    apply_boundary_patch_types,
    coerce_gmsh_leftover_walls,
    emitted_patch_types,
)
from cfddesk.mesh.standard_hexcore import (
    StandardSizing,
    build_standard_msh,
    write_layers_case,
    write_patch_types_txt,
)
from cfddesk.mesh.web_refinements import (
    bind_inflate_patches,
    face_ids_from_web_bc,
    inflate_notes,
    layer_specs_for_generate,
    leftover_faces,
    load_inflate_refs,
    load_surface_custom_sizes,
)
from cfddesk.project.mesh_sizing import clamp_fineness
from cfddesk.project.model import Project
from cfddesk.project.web_adapter import study_web_bcs
from cfddesk.runner.case_id import validate_wsl_case_id
from cfddesk.runner.sync import RESULTS_MARKER, copy_back_mesh
from cfddesk.wsl.mesh_run import run_standard_pipeline

PATH_KIND = "standard"
BACKEND = "gmsh-hexcore"


def _progress(stage: str, **extra) -> None:
    """Emit progress via job protocol; optional legacy CFMESH_PROGRESS line."""
    _legacy.progress(stage, **extra)


def _result(ok: bool, **extra) -> int:
    """Emit result via job protocol; optional legacy CFMESH_RESULT line."""
    return _legacy.result(ok, **extra)




def _read_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _web_bc_kind(bc: dict) -> str:
    raw = str(bc.get("bc_type") or bc.get("type") or "").strip().lower().replace("_", " ")
    if raw == "velocity inlet":
        return "inlet"
    if raw == "velocity outlet":
        return "velocity_outlet"
    if raw.startswith("pressure"):
        return "outlet"
    if raw in ("wall", "slip wall", "no-slip wall"):
        return "wall"
    raise ValueError(f"unsupported boundary condition type: {bc.get('bc_type')!r}")


def _web_wall_reg_type(bc: dict) -> str:
    """Registry key for an explicit web Wall BC: ``wall_slip`` or ``wall_noslip``."""
    raw = str(bc.get("wall_type") or "").strip().lower().replace("-", "").replace("_", "").replace(" ", "")
    return "wall_slip" if raw == "slip" else "wall_noslip"


def _apply_web_bcs(project: Project, bcs: list[dict], n_faces: int) -> Project:
    assigned: set[int] = set()
    for bc in bcs:
        fids = face_ids_from_web_bc(bc, n_faces)
        if not fids:
            continue
        kind = _web_bc_kind(bc)
        name = str(bc.get("name") or kind)
        if kind == "inlet":
            speed = float(bc.get("value") if bc.get("value") is not None else 5.0)
            project, _ = project.add_bc(
                name=name,
                bc_type="velocity_inlet_fixed",
                face_ids=fids,
                settings={"speed_m_s": speed, "direction_mode": "normal"},
            )
        elif kind == "velocity_outlet":
            project, _ = project.add_bc(name=name, bc_type="velocity_outlet", face_ids=fids)
        elif kind == "outlet":
            p = float(bc.get("value") if bc.get("value") is not None else 0.0)
            project, _ = project.add_bc(
                name=name,
                bc_type="pressure_outlet_gauge",
                face_ids=fids,
                settings={"gauge_pressure": p},
            )
        else:
            # Explicit wall BC: its own patch (type wall) so the solver can give
            # these faces slip / no-slip independently of the leftover `walls`.
            project, _ = project.add_bc(
                name=name,
                bc_type=_web_wall_reg_type(bc),
                face_ids=fids,
            )
        assigned.update(fids)
    return project


def _add_default_walls(project: Project, leftover: list[int]) -> Project:
    """Every face no BC claims → one ``walls`` patch (type wall).

    Done explicitly rather than via ``Project.with_role(fid, "walls")``: that
    helper merges into the first wall-semantic BC it finds, which would fold
    the leftovers into a user's explicit (possibly slip) Wall BC. Slip vs
    no-slip for this patch is decided at solve time from the project defaults.
    """
    if not leftover:
        return project
    existing = {bc.patch_name for bc in project.boundary_conditions}
    project, _ = project.add_bc(
        name="Wall no-slip 1",
        bc_type="wall_noslip",
        face_ids=leftover,
        refinement_level=project.mesh.refinement.walls,
        patch_name="walls" if "walls" not in existing else None,
    )
    return project


def _poly_counts(poly: Path) -> dict:
    """Cell / point / face counts straight from polyMesh (points + owner)."""
    out = {"n_cells": None, "n_points": None, "n_faces": None, "source": None}
    points = poly / "points"
    owner = poly / "owner"
    if not points.is_file() or not owner.is_file():
        return out

    def header_note(path: Path) -> dict:
        head = path.read_bytes()[:2000].decode("ascii", errors="replace")
        m = re.search(r"note\s+\"([^\"]*)\"", head)
        vals = {}
        if m:
            for kv in re.finditer(r"(\w+)\s*:\s*(\d+)", m.group(1)):
                vals[kv.group(1)] = int(kv.group(2))
        return vals

    note = header_note(owner)
    out["n_cells"] = note.get("nCells")
    out["n_faces"] = note.get("nFaces")
    out["n_points"] = note.get("nPoints")
    if out["n_cells"] is not None:
        out["source"] = "polyMesh/owner note"
    return out


def _parse_float(v, default: float) -> float:
    try:
        f = float(v)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def main() -> int:
    p = argparse.ArgumentParser(description="SimScale-style Standard mesh generate")
    p.add_argument("--project-dir", required=True)
    p.add_argument("--case-dir", required=True)
    p.add_argument("--wsl-case", required=True)
    p.add_argument("--generate-id", required=True)
    p.add_argument("--fineness", type=int, default=5)
    p.add_argument("--hex-core", type=int, default=1)
    p.add_argument("--add-layers", type=int, default=1)
    p.add_argument("--physics-based", type=int, default=1)
    p.add_argument("--small-feature", default="auto", help="metres, or 'auto'")
    p.add_argument("--gap-factor", type=float, default=0.05)
    p.add_argument("--gradation", type=float, default=1.22)
    p.add_argument("--mesh-id", default="", help="W20 mesh id — only that mesh's refinements")
    p.add_argument("--simulation-id", default="", help="Only this study's BCs become mesh patches")
    p.add_argument("--timeout", type=float, default=18000.0)
    p.add_argument("--threads", type=int, default=16)
    p.add_argument(
        "--legacy-markers",
        action="store_true",
        help="Also emit CFMESH_PROGRESS/CFMESH_RESULT lines (one-phase frontend compat).",
    )
    args = p.parse_args()
    _legacy.set_legacy_markers(bool(args.legacy_markers))

    project_dir = Path(args.project_dir).resolve()
    case_dir = Path(args.case_dir).resolve()
    wsl_case = validate_wsl_case_id(str(args.wsl_case))
    if wsl_case.startswith("cfddesk-manual-") or wsl_case == "cfddesk-cfmesh":
        return _result(False, error=f"refusing reserved WSL case id {wsl_case}")
    if "HEXCORE-PROCESS-BACKUP" in str(case_dir):
        return _result(False, error="refusing to write into HEXCORE-PROCESS-BACKUP")

    claim_generate_case(case_dir, generate_id=str(args.generate_id), mesh_id=str(args.mesh_id or ""))
    atexit.register(release_generate_case, case_dir, generate_id=str(args.generate_id))

    from cfddesk.project.paths import resolve_step_for_study

    step = resolve_step_for_study(
        project_dir,
        str(args.simulation_id or "") or None,
        str(args.mesh_id or "") or None,
    )
    if step is None or not step.is_file():
        return _result(False, error=f"missing source.step: {step}")

    try:
        _progress("load_step", step=str(step))
        solid = load_step(step)
        units = solid.units
        scale = float(
            getattr(units, "proposed_scale_to_metres", None)
            or getattr(units, "scale_to_metres", None)
            or 0.001
        )
        n_faces = len(solid.faces)
        _progress("step_loaded", n_faces=n_faces, scale_to_metres=scale)

        project = Project.from_solid(solid, scale_to_metres=scale, units_confirmed=True)
        web_bcs = study_web_bcs(
            project_dir,
            None,
            simulation_id=str(args.simulation_id or "") or None,
            mesh_id=str(args.mesh_id or "") or None,
        )
        project = _apply_web_bcs(project, web_bcs, n_faces)

        bbox = shape_bbox(solid.shape, unit="native")
        dx = (bbox.xmax - bbox.xmin) * scale
        dy = (bbox.ymax - bbox.ymin) * scale
        dz = (bbox.zmax - bbox.zmin) * scale
        fineness = clamp_fineness(int(args.fineness))
        sfs_arg = str(args.small_feature).strip().lower()
        sfs = None if sfs_arg in ("", "auto", "none") else max(0.0, _parse_float(sfs_arg, 0.0))
        sizing = StandardSizing.automatic(
            (dx, dy, dz),
            fineness=fineness,
            small_feature_m=sfs,
            gap_refinement_factor=_parse_float(args.gap_factor, 0.05),
            gradation=_parse_float(args.gradation, 1.22),
        )
        hex_core = bool(int(args.hex_core))
        add_layers = bool(int(args.add_layers))
        physics_based = bool(int(args.physics_based))
        mesh_id = str(args.mesh_id or "")
        extra_face_sizes, extra_face_mins, ref_notes = load_surface_custom_sizes(
            project_dir, mesh_id, n_faces, sizing.diag_m
        )
        inflates = load_inflate_refs(
            project_dir,
            mesh_id,
            n_faces,
            sizing.h_surface_m,
            extra_face_sizes=extra_face_sizes,
        )
        project, inflates = bind_inflate_patches(project, inflates, n_faces)
        project = _add_default_walls(project, leftover_faces(project, n_faces))
        _progress(
            "sizing",
            fineness=fineness,
            bbox_m=[dx, dy, dz],
            bbox_diag_m=sizing.diag_m,
            surface_size_m=sizing.h_surface_m,
            core_size_m=sizing.h_core_m,
            small_feature_m=sizing.small_feature_m,
            gap_refinement_factor=sizing.gap_refinement_factor,
            gradation=sizing.gradation,
            hex_core=hex_core,
            add_layers=add_layers,
            physics_based=physics_based,
            layer_thickness_m=sizing.layer_thickness_m,
            surface_custom_faces=len(extra_face_sizes),
            surface_custom=ref_notes,
            inflate=inflate_notes(inflates),
        )

        case_dir.mkdir(parents=True, exist_ok=True)
        marker = case_dir / RESULTS_MARKER
        if not marker.is_file():
            marker.write_text("cfddesk results directory - safe for copy_back clear\n", encoding="ascii")
        for stale in ("constant/polyMesh", "0"):
            d = case_dir / stale
            if d.is_dir():
                import shutil

                shutil.rmtree(d, ignore_errors=True)

        msh_path = case_dir / "constant" / "triSurface" / "geometry.msh"
        _progress("surface_mesh", surface_size_m=sizing.h_surface_m)

        def _log(msg: str) -> None:
            _progress("gmsh", msg=msg)

        pre_types = emitted_patch_types(project)
        wall_pre = [n for n, ty in pre_types.items() if ty == "wall"]
        layer_specs = layer_specs_for_generate(
            wall_patches=wall_pre,
            inflate=inflates,
            add_layers=add_layers,
            default_n=sizing.n_layers,
            default_thickness_m=sizing.layer_thickness_m,
            default_expansion=sizing.layer_expansion,
            default_min_m=sizing.layer_min_thickness_m,
        )
        mesh = build_standard_msh(
            step,
            solid,
            project,
            msh_path,
            scale_to_metres=scale,
            sizing=sizing,
            hex_core=hex_core,
            physics_based=physics_based,
            extra_face_sizes=extra_face_sizes,
            extra_face_mins=extra_face_mins,
            layer_specs=layer_specs,
            n_threads=max(1, int(args.threads)),
            log=_log,
        )
        (case_dir / "log.gmsh_host.txt").write_text("\n".join(mesh.log) + "\n", encoding="utf-8")
        _progress(
            "volume_mesh",
            n_nodes=mesh.n_nodes,
            n_tets=mesh.n_tets,
            n_hex=mesh.n_hex,
            n_pyr=mesh.n_pyr,
            n_prism=mesh.n_prism,
            n_tris=mesh.n_tris,
            hex_core_applied=mesh.hex_core_applied,
            hex_core_note=mesh.hex_core_note,
            wall_s=mesh.wall_s,
            gmsh_layer_patches=mesh.gmsh_layer_patches,
        )

        patch_types = emitted_patch_types(project)
        for name in mesh.patch_names:
            patch_types.setdefault(name, "wall")
        write_patch_types_txt(case_dir, patch_types)
        grown = set(mesh.gmsh_layer_patches)
        layer_specs = [s for s in layer_specs if s.name not in grown]
        layers_requested = bool(layer_specs)
        write_layers_case(
            case_dir,
            wall_patches=mesh.wall_patches,
            sizing=sizing,
            add_layers=layers_requested,
            layer_specs=layer_specs,
        )
        host_layers = bool(mesh.gmsh_layer_patches)
        if layers_requested or host_layers:
            infl = next((s for s in inflates if s.patch_name), None)
            _progress(
                "boundary_layers",
                wall_patches=mesh.wall_patches,
                n_layers=infl.n_layers if infl else sizing.n_layers,
                total_thickness_m=infl.thickness_m if infl else sizing.layer_thickness_m,
                expansion=infl.expansion if infl else sizing.layer_expansion,
                inflate=inflate_notes(inflates),
                layer_patches=[s.name for s in layer_specs] + list(mesh.gmsh_layer_patches),
                gmsh_layer_patches=mesh.gmsh_layer_patches,
            )

        _progress("gmshToFoam", wsl_case=wsl_case, layers=layers_requested)
        result = run_standard_pipeline(
            case_dir, wsl_case_name=wsl_case, timeout_total=float(args.timeout), allow_skew=True
        )
        layers_applied = host_layers or layers_requested
        if layers_requested and not result.check_ok:
            # Layers are an add-on: fall back to the layer-free mesh rather than
            # failing Generate. The retry reuses the host msh (no re-meshing).
            _progress("boundary_layers_retry", reason="layers_failed", prior_error=(result.summary or "")[:240])
            write_layers_case(case_dir, wall_patches=mesh.wall_patches, sizing=sizing, add_layers=False)
            result = run_standard_pipeline(
                case_dir, wsl_case_name=wsl_case, timeout_total=float(args.timeout), allow_skew=True
            )
            layers_applied = host_layers
        (case_dir / "log.standard_generate.txt").write_text(
            result.detail_text(), encoding="utf-8", errors="replace"
        )
        if not result.check_ok:
            return _result(
                False,
                error=result.summary,
                n_cells=result.n_cells,
                n_points=result.n_points,
                wall_s=result.wall_s,
                wsl_case=result.wsl_case,
                check_ok=False,
            )

        _progress("copy_back")
        copy_back_mesh(wsl_case, case_dir)
        bound = case_dir / "constant" / "polyMesh" / "boundary"
        if bound.is_file():
            apply_boundary_patch_types(bound, patch_types)
            coerce_gmsh_leftover_walls(bound)
        (case_dir / "case.foam").write_text("", encoding="ascii")

        counts = _poly_counts(case_dir / "constant" / "polyMesh")
        if counts["n_cells"] is None:
            counts["n_cells"] = result.n_cells
            counts["source"] = "checkMesh"
        if counts["n_points"] is None:
            counts["n_points"] = result.n_points
        total_wall = mesh.wall_s + result.wall_s
        (case_dir / "w21-counts.json").write_text(
            json.dumps(
                {**counts, "path_kind": PATH_KIND, "backend": BACKEND, "generate_id": args.generate_id},
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        meta = {
            "path_kind": PATH_KIND,
            "backend": BACKEND,
            "fineness": fineness,
            "hex_element_core": hex_core,
            "hex_core_applied": mesh.hex_core_applied,
            "hex_core_note": mesh.hex_core_note,
            "add_layers": add_layers,
            "layers_applied": layers_applied,
            "physics_based": physics_based,
            "sizing": {
                "bbox_m": list(sizing.bbox_m),
                "bbox_diag_m": sizing.diag_m,
                "surface_size_m": sizing.h_surface_m,
                "core_size_m": sizing.h_core_m,
                "small_feature_m": sizing.small_feature_m,
                "gap_refinement_factor": sizing.gap_refinement_factor,
                "gradation": sizing.gradation,
                "layers": {
                    "n": sizing.n_layers,
                    "total_thickness_m": sizing.layer_thickness_m,
                    "min_thickness_m": sizing.layer_min_thickness_m,
                    "expansion": sizing.layer_expansion,
                },
            },
            "host_mesh": {
                "n_nodes": mesh.n_nodes,
                "n_tets": mesh.n_tets,
                "n_hex": mesh.n_hex,
                "n_pyr": mesh.n_pyr,
                "n_prism": mesh.n_prism,
                "n_tris": mesh.n_tris,
                "gmsh_layer_patches": mesh.gmsh_layer_patches,
                "volume_error_rel": mesh.volume_error_rel,
                "wall_s": mesh.wall_s,
            },
            "patches": {"names": mesh.patch_names, "walls": mesh.wall_patches, "types": patch_types},
            "web_bcs": [
                {"name": b.get("name"), "bc_type": b.get("bc_type"), "faces": b.get("faces")} for b in web_bcs
            ],
            "surface_custom_sizing": ref_notes,
            "inflate_boundary_layer": inflate_notes(inflates),
            "wsl_case": result.wsl_case,
            "wall_s": total_wall,
        }
        (case_dir / "standard-meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        return _result(
            True,
            path_kind=PATH_KIND,
            backend=BACKEND,
            n_cells=counts["n_cells"],
            n_points=counts["n_points"],
            n_faces=counts["n_faces"],
            counts_source=counts["source"],
            wall_s=total_wall,
            wsl_case=result.wsl_case,
            case_dir=str(case_dir),
            mesh_path=str(case_dir / "constant" / "polyMesh"),
            hex_core=mesh.hex_core_applied,
            add_layers=add_layers,
            layers_applied=layers_applied,
            fineness=fineness,
            surface_size_m=sizing.h_surface_m,
            generate_id=args.generate_id,
        )
    except Exception as exc:
        traceback.print_exc()
        return _result(False, error=str(exc), traceback=traceback.format_exc()[-2000:])


if __name__ == "__main__":
    sys.exit(main())
