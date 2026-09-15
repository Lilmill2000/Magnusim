#!/usr/bin/env python3
"""cfd-web Standard + Hex element core Generate — isolated cfMesh remesh.

Product mapping (STATUS.md): Standard + hex core ON = cartesianMesh.
Does not touch HEXCORE-PROCESS-BACKUP or the live MTP1 WSL case.
Writes only to the caller-supplied case dir + ``cfddesk-cfdweb-*`` WSL id.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import traceback
from pathlib import Path

# cfd-web/python: the cfddesk library package lives one level up from tools/.
CFDDESK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CFDDESK_ROOT))

from cfddesk.jobs.events import emit

_LEGACY_MARKERS = False  # set by main() from --legacy-markers
from cfddesk.cad.location import find_location_in_mesh
from cfddesk.cad.passage import check_passage_cells, measure_role_passages
from cfddesk.cad.step import load_step
from cfddesk.cad.units import shape_bbox
from cfddesk.mesh.case_writer import prepare_standard_mesh_case
from cfddesk.mesh.cfmesh_standard import (
    hexcore_first_layer_thickness_m,
    hexcore_surface_cell_m,
    hexcore_uniform_cell_m,
    inject_named_local_refinement,
    replace_boundary_layers_block,
)
from cfddesk.mesh.web_refinements import (
    bind_inflate_patches,
    bind_surface_custom_patches,
    inflate_notes,
    leftover_faces,
    load_inflate_refs,
    load_surface_custom_sizes,
    web_face_to_cfddesk,
)
from cfddesk.mesh.gmsh_standard import apply_boundary_patch_types, emitted_patch_types
from cfddesk.project.mesh_sizing import (
    characteristic_aabb_length_m,
    clamp_fineness,
    physics_refinement_for_fineness,
)
from cfddesk.project.model import Project
from cfddesk.project.settings import MeshRefinement, MeshSettings
from cfddesk.runner.case_id import validate_wsl_case_id
from cfddesk.runner.sync import RESULTS_MARKER, copy_back
from cfddesk.wsl.mesh_run import run_cfmesh_pipeline

# SimScale Standard tutorial: Automatic BL default is 3 layers.
# Global nLayers stays 0 — walls.* only.
_SIMSCALE_AUTO_BL_LAYERS = 3
_SIMSCALE_AUTO_BL_RATIO = 1.2
_BANNED_WSL = frozenset(
    {
        "cfddesk-manual-test-project-1",
        "cfddesk-cfmesh",
    }
)


def _progress(stage: str, **extra) -> None:
    """Emit progress via job protocol; optional legacy CFMESH_PROGRESS line."""
    payload = {"stage": stage, **extra}
    emit("progress", **payload)
    if _LEGACY_MARKERS:
        print("CFMESH_PROGRESS " + json.dumps(payload, separators=(",", ":")), flush=True)


def _result(ok: bool, **extra) -> int:
    """Emit result via job protocol; optional legacy CFMESH_RESULT line."""
    payload = {"ok": bool(ok), **extra}
    emit("result", **payload)
    if _LEGACY_MARKERS:
        print("CFMESH_RESULT " + json.dumps(payload, separators=(",", ":")), flush=True)
    return 0 if ok else 1


def _read_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _web_bc_kind(bc: dict) -> str:
    raw = str(bc.get("bc_type") or bc.get("type") or "").strip().lower()
    if raw in ("velocity inlet", "velocity_inlet"):
        return "inlet"
    if raw in ("velocity outlet", "velocity_outlet"):
        return "velocity_outlet"
    if raw.startswith("pressure"):
        return "outlet"
    if raw in ("wall", "slip wall", "no-slip wall"):
        return "wall"
    raise ValueError(f"unsupported web BC type: {bc.get('bc_type')!r}")


def _web_wall_reg_type(bc: dict) -> str:
    """Registry key for an explicit web Wall BC: ``wall_slip`` or ``wall_noslip``."""
    raw = str(bc.get("wall_type") or "").strip().lower().replace("-", "").replace("_", "").replace(" ", "")
    return "wall_slip" if raw == "slip" else "wall_noslip"


def _apply_web_bcs(project: Project, bcs: list[dict], n_faces: int) -> Project:
    assigned: set[int] = set()
    for bc in bcs:
        labels = list(bc.get("faces") or [])
        if bc.get("face") and bc["face"] not in labels:
            labels.append(bc["face"])
        fids = []
        for lab in labels:
            fid = web_face_to_cfddesk(lab)
            if fid < 0 or fid >= n_faces:
                raise ValueError(
                    f"face {lab!r} maps to cfddesk id {fid} (n_faces={n_faces})"
                )
            fids.append(fid)
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
            project, _ = project.add_bc(
                name=name,
                bc_type="velocity_outlet",
                face_ids=fids,
            )
        elif kind == "wall":
            # Explicit wall BC: its own patch (type wall) so the solver can give
            # these faces slip / no-slip independently of the leftover `walls`.
            project, _ = project.add_bc(
                name=name,
                bc_type=_web_wall_reg_type(bc),
                face_ids=fids,
            )
        else:
            p = float(bc.get("value") if bc.get("value") is not None else 0.0)
            project, _ = project.add_bc(
                name=name,
                bc_type="pressure_outlet_gauge",
                face_ids=fids,
                settings={"gauge_pressure": p},
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
    out = {"n_cells": None, "n_points": None, "n_faces": None, "source": None}
    points = poly / "points"
    owner = poly / "owner"
    if not points.is_file() or not owner.is_file():
        return out

    def first_int(path: Path) -> int | None:
        past = False
        for i, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines()):
            s = line.strip()
            if not past:
                if s == "}" or s.startswith("// *****"):
                    past = True
                continue
            if s.isdigit() and i > 5:
                return int(s)
        return None

    n_points = first_int(points)
    n_faces = first_int(owner)
    n_cells = None
    if owner.is_file():
        vals: list[int] = []
        mode = "seek"
        for i, line in enumerate(owner.read_text(encoding="utf-8", errors="replace").splitlines()):
            s = line.strip()
            if mode == "seek":
                if s.isdigit() and i > 10:
                    mode = "paren"
                continue
            if mode == "paren":
                if s == "(":
                    mode = "vals"
                continue
            if mode == "vals":
                if s == ")":
                    break
                if s.lstrip("-").isdigit():
                    vals.append(int(s))
        if vals:
            n_cells = max(vals) + 1
    out.update(
        {
            "n_cells": n_cells,
            "n_points": n_points,
            "n_faces": n_faces,
            "source": "polyMesh/points+owner",
        }
    )
    return out


def main() -> int:
    p = argparse.ArgumentParser(description="Isolated Standard+hexcore cfMesh generate")
    p.add_argument("--project-dir", required=True)
    p.add_argument("--case-dir", required=True)
    p.add_argument("--wsl-case", required=True)
    p.add_argument("--generate-id", required=True)
    p.add_argument("--fineness", type=int, default=5)
    p.add_argument("--add-layers", type=int, default=1)
    p.add_argument("--physics-based", type=int, default=1)
    p.add_argument("--timeout", type=float, default=18000.0)
    p.add_argument("--mesh-id", default="", help="W20 mesh id — only that mesh's refinements")
    p.add_argument(
        "--legacy-markers",
        action="store_true",
        help="Also emit CFMESH_PROGRESS/CFMESH_RESULT lines (one-phase frontend compat).",
    )
    args = p.parse_args()
    global _LEGACY_MARKERS
    _LEGACY_MARKERS = bool(args.legacy_markers)

    project_dir = Path(args.project_dir).resolve()
    case_dir = Path(args.case_dir).resolve()
    wsl_case = validate_wsl_case_id(str(args.wsl_case))
    if wsl_case in _BANNED_WSL or wsl_case.startswith("cfddesk-manual-"):
        return _result(False, error=f"refusing banned WSL case id {wsl_case}")
    if "HEXCORE-PROCESS-BACKUP" in str(case_dir):
        return _result(False, error="refusing to write into HEXCORE-PROCESS-BACKUP")

    step = project_dir / "geometry" / "source.step"
    if not step.is_file():
        proj = _read_json(project_dir / "project.json")
        geom = (proj.get("geometry") or {}) if isinstance(proj, dict) else {}
        alt = geom.get("step_path")
        if alt:
            step = Path(alt)
    if not step.is_file():
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

        project = Project.from_solid(
            solid, scale_to_metres=scale, units_confirmed=True
        )
        bc_doc = _read_json(project_dir / "boundary_conditions.json")
        web_bcs = list(bc_doc.get("boundary_conditions") or [])
        project = _apply_web_bcs(project, web_bcs, n_faces)

        bbox = shape_bbox(solid.shape, unit="native")
        dx = (bbox.xmax - bbox.xmin) * scale
        dy = (bbox.ymax - bbox.ymin) * scale
        dz = (bbox.zmax - bbox.zmin) * scale
        diag = math.sqrt(dx * dx + dy * dy + dz * dz)
        fineness = clamp_fineness(int(args.fineness))
        char_len = characteristic_aabb_length_m(dx, dy, dz)
        if char_len <= 1e-6:
            char_len = diag if diag > 0 else 1e-3
        base_cell = hexcore_uniform_cell_m(char_len_m=char_len, fineness=fineness)
        if int(args.physics_based):
            refinement = physics_refinement_for_fineness(fineness)
        else:
            refinement = MeshRefinement(inlet=1, outlet=1, walls=1)
        add_layers = bool(int(args.add_layers))
        mesh_id = str(args.mesh_id or "")
        extra_face_sizes, _extra_mins, ref_notes = load_surface_custom_sizes(
            project_dir, mesh_id, n_faces, diag
        )
        h_surf = hexcore_surface_cell_m(base_cell)
        inflates = load_inflate_refs(
            project_dir, mesh_id, n_faces, h_surf, extra_face_sizes=extra_face_sizes
        )
        project, inflates = bind_inflate_patches(project, inflates, n_faces)
        project, ref_notes = bind_surface_custom_patches(project, ref_notes, n_faces)
        project = _add_default_walls(project, leftover_faces(project, n_faces))
        extra_patch_layers = {
            s.patch_name: s.n_layers for s in inflates if s.patch_name and s.n_layers > 0
        }
        project = project.with_mesh(
            MeshSettings(
                base_cell_m=base_cell,
                refinement=refinement,
                fineness=fineness,
                sizing_mode="automatic",
                physics_based=bool(int(args.physics_based)),
                add_layers=add_layers,
                algorithm="standard",
                hex_element_core=True,
                hexcore_backend="cfmesh",
                max_meshing_runtime_s=float(args.timeout),
            )
        )

        _progress(
            "sizing",
            fineness=fineness,
            char_len_m=char_len,
            base_cell_m=base_cell,
            bbox_m=[dx, dy, dz],
            bbox_diag_m=diag,
            add_layers=add_layers,
            surface_custom_faces=len(extra_face_sizes),
            surface_custom=ref_notes,
            inflate=inflate_notes(inflates),
        )

        loc = find_location_in_mesh(solid, scale)
        if not loc.ok:
            return _result(False, error="locationInMesh not inside solid")
        passages = measure_role_passages(solid, project)
        passage = check_passage_cells(
            passages,
            base_cell_m=base_cell,
            refinement_level=max(refinement.inlet, refinement.outlet),
            min_cells=project.mesh.min_cells_across_passage,
        )
        if not passage.ok:
            return _result(False, error=passage.message)

        case_dir.mkdir(parents=True, exist_ok=True)
        marker = case_dir / RESULTS_MARKER
        if not marker.is_file():
            marker.write_text(
                "cfddesk results directory - safe for copy_back clear\n",
                encoding="ascii",
            )

        _progress("write_case", case_dir=str(case_dir))
        prep = prepare_standard_mesh_case(
            solid,
            project,
            case_dir,
            location=loc,
            passage_check=passage,
            base_cell_m=base_cell,
            refinement=refinement,
        )
        layers_applied = False
        first_layer = None
        wall_layers = _SIMSCALE_AUTO_BL_LAYERS if add_layers else 0
        if wall_layers or extra_patch_layers:
            extents = [s for s in (dx, dy, dz) if s > 0]
            min_extent = min(extents) if extents else char_len
            n_for_first = max([wall_layers] + list(extra_patch_layers.values()) or [3])
            first_layer = hexcore_first_layer_thickness_m(
                surface_cell_m=hexcore_surface_cell_m(base_cell),
                min_extent_m=min_extent,
                n_layers=n_for_first or _SIMSCALE_AUTO_BL_LAYERS,
                thickness_ratio=_SIMSCALE_AUTO_BL_RATIO,
            )
            replace_boundary_layers_block(
                case_dir / "system" / "meshDict",
                wall_layers=wall_layers,
                thickness_ratio=_SIMSCALE_AUTO_BL_RATIO,
                max_first_layer_m=first_layer,
                extra_patch_layers=extra_patch_layers,
            )
            layers_applied = True
            _progress(
                "boundary_layers",
                wall_layers=wall_layers,
                extra_patch_layers=extra_patch_layers,
                thickness_ratio=_SIMSCALE_AUTO_BL_RATIO,
                max_first_layer_m=first_layer,
                min_extent_m=min_extent,
                inflate=inflate_notes(inflates),
            )
        named_refs = []
        for n in ref_notes:
            size = n.get("size_m")
            if not size:
                continue
            for p in n.get("patches") or ([n["patch"]] if n.get("patch") else []):
                named_refs.append((p, float(size)))
        if named_refs:
            inject_named_local_refinement(case_dir / "system" / "meshDict", named_refs)

        _progress("cartesianMesh", wsl_case=wsl_case)
        result = run_cfmesh_pipeline(
            case_dir,
            wsl_case_name=wsl_case,
            timeout_total=float(args.timeout),
            allow_skew=True,
        )
        # cfMesh hex-cut walls often collapse 3 prisms into open / zero-area
        # cells on small parts. Retry once without prisms so Generate still
        # returns a valid mesh at any scale.
        if layers_applied and not result.check_ok:
            replace_boundary_layers_block(
                case_dir / "system" / "meshDict",
                wall_layers=0,
            )
            _progress(
                "boundary_layers_retry",
                reason="prism_quality",
                prior_error=(result.summary or "")[:240],
            )
            result = run_cfmesh_pipeline(
                case_dir,
                wsl_case_name=wsl_case,
                timeout_total=float(args.timeout),
                allow_skew=True,
            )
            layers_applied = False
        detail = result.detail_text()
        (case_dir / "log.cfmesh_generate.txt").write_text(
            detail, encoding="utf-8", errors="replace"
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
        copy_back(wsl_case, case_dir)
        bound = case_dir / "constant" / "polyMesh" / "boundary"
        if bound.is_file():
            apply_boundary_patch_types(bound, emitted_patch_types(project))
        (case_dir / "case.foam").write_text("", encoding="ascii")

        counts = _poly_counts(case_dir / "constant" / "polyMesh")
        if counts["n_cells"] is None:
            counts["n_cells"] = result.n_cells
        if counts["n_points"] is None:
            counts["n_points"] = result.n_points
        (case_dir / "w21-counts.json").write_text(
            json.dumps(
                {
                    **counts,
                    "path_kind": "cartesianMesh",
                    "backend": "cfmesh",
                    "generate_id": args.generate_id,
                    "increment": "W28",
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        meta = {
            "increment": "W28",
            "path_kind": "cartesianMesh",
            "backend": "cfmesh",
            "hex_element_core": True,
            "add_layers": add_layers,
            "layers_applied": layers_applied,
            "first_layer_m": first_layer,
            "wall_boundary_layers": _SIMSCALE_AUTO_BL_LAYERS if layers_applied else 0,
            "fineness": fineness,
            "base_cell_m": base_cell,
            "prep": {
                k: prep.get(k)
                for k in (
                    "max_cell_m",
                    "boundary_cell_m",
                    "skin_cell_m",
                    "stl_triangles",
                    "cad_feature_edges",
                    "gap_count",
                )
                if k in prep
            },
            "web_bcs": [
                {"name": b.get("name"), "bc_type": b.get("bc_type"), "faces": b.get("faces")}
                for b in web_bcs
            ],
            "surface_custom_sizing": ref_notes,
            "inflate_boundary_layer": inflate_notes(inflates),
            "wsl_case": result.wsl_case,
            "wall_s": result.wall_s,
            "mtp1_silent_copy": False,
        }
        (case_dir / "w28-cfmesh-meta.json").write_text(
            json.dumps(meta, indent=2) + "\n", encoding="utf-8"
        )
        return _result(
            True,
            path_kind="cartesianMesh",
            backend="cfmesh",
            n_cells=counts["n_cells"],
            n_points=counts["n_points"],
            n_faces=counts["n_faces"],
            counts_source=counts["source"],
            wall_s=result.wall_s,
            wsl_case=result.wsl_case,
            case_dir=str(case_dir),
            mesh_path=str(case_dir / "constant" / "polyMesh"),
            add_layers=add_layers,
            layers_applied=layers_applied,
            fineness=fineness,
            generate_id=args.generate_id,
            increment="W28",
        )
    except Exception as exc:
        traceback.print_exc()
        return _result(False, error=str(exc), traceback=traceback.format_exc()[-2000:])


if __name__ == "__main__":
    sys.exit(main())
