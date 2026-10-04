#!/usr/bin/env python3
"""Hex-dominant (snappyHexMesh) generate — Phase 1 Step 6.

Host prep (scale Body1 + write dicts) then WSL bash template
``snappy_hexdominant.sh``. Emits MAGNUSIM_EVENT JSONL (optional
``--legacy-markers`` for CFMESH_* dual emission).
"""
from __future__ import annotations

import argparse
import atexit
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

CFDDESK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CFDDESK_ROOT))

from cfddesk.jobs import legacy_markers as _legacy  # noqa: E402
from cfddesk.jobs.events import emit  # noqa: E402
from cfddesk.mesh.generate_guard import claim_generate_case, release_generate_case  # noqa: E402
from cfddesk.mesh.snappy_hexdominant import (  # noqa: E402
    base_cell_size,
    fineness_params,
    read_feature_marks,
    read_polymesh_counts,
    scale_body1_stl,
    write_hexdominant_dicts,
)
from cfddesk.runner.case_id import validate_wsl_case_id, wsl_case_path  # noqa: E402
from cfddesk.runner.cleanup import remove_wsl_case  # noqa: E402
from cfddesk.runner.sync import sync_to_wsl  # noqa: E402
from cfddesk.wsl.config import get_wsl_distro  # noqa: E402
from cfddesk.wsl.mesh_run import windows_to_wsl_path  # noqa: E402

_TEMPLATES = CFDDESK_ROOT / "cfddesk" / "wsl" / "templates"
_SNAPPY_SH = _TEMPLATES / "snappy_hexdominant.sh"

PATH_KIND = "snappyHexMesh"

# Test hook (inert unless set; read once): prepare_input waits while this file exists,
# so a test can see the stage in the mesh panel. e2e/link-mesh-input.spec.js.
_PREPARE_PAUSE = os.environ.get("MAGNUSIM_TEST_PREPARE_INPUT_PAUSE", "").strip()


def _progress(stage: str, **extra) -> None:
    _legacy.progress(stage, **extra)


def _result(ok: bool, **extra) -> int:
    return _legacy.result(ok, path_kind=PATH_KIND, **extra)



def _read_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _sha256_file(path: Path) -> str:
    import hashlib

    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def mesh_input_fresh(body1: Path, shape_sha256: str) -> bool:
    """``Body1.stl`` is this shape's CAD-quality mesh input (its ``Body1.json`` says so)."""
    meta = _read_json(body1.with_suffix(".json"))
    return (
        body1.is_file()
        and body1.stat().st_size >= 100
        and meta.get("cad_quality") is True
        and bool(shape_sha256)
        and meta.get("shape_sha256") == shape_sha256
    )


def prepare_input(step: Path, body1: Path, shape_sha256: str) -> dict | None:
    """The first stage of a linked or display-budgeted geometry's Generate (LINK 5.9).

    The server never builds ``Body1.stl`` for such a geometry (``ensureBody1Stl``
    answers ``deferred``); this mesh process does, inside the mesh's own slot claim,
    when the file is missing or was made from another shape (``Body1.json``'s
    ``shape_sha256``, not the rev, so a names-only update keeps it). Built from the
    shape at CAD quality, sized by the preview's bounds (``build_mesh_input``, which
    needs to know whether they are the display budget's triangle box).
    Returns the new file's meta, or None when it was fresh (no stage is shown).
    """
    if mesh_input_fresh(body1, shape_sha256):
        return None
    _progress("prepare_input", msg="Building the mesh input")
    if _PREPARE_PAUSE:
        import time

        waited = 0.0
        while Path(_PREPARE_PAUSE).exists() and waited < 600:
            time.sleep(0.2)
            waited += 0.2
    from convert_step_to_stl import build_mesh_input

    preview = _read_json(step.parent / "cad_preview.json")
    bounds = preview.get("bounds")
    if not isinstance(bounds, dict) or any(k not in bounds for k in ("xmin", "xmax", "ymin", "ymax", "zmin", "zmax")):
        bounds = None
    return build_mesh_input(
        step, body1, bounds=bounds, shape_sha256=shape_sha256, display_budget=preview.get("display_budget") is True
    )


def render_snappy_script(*, dst: str, win_out: str, generate_id: str) -> str:
    raw = _SNAPPY_SH.read_text(encoding="utf-8")
    if raw.startswith("\ufeff"):
        raw = raw.lstrip("\ufeff")
    text = (
        raw.replace("__DST__", str(dst))
        .replace("__WIN_OUT__", str(win_out))
        .replace("__GENERATE_ID__", str(generate_id))
    )
    return text.replace("\r\n", "\n").replace("\r", "\n")


def boundary_patches(
    project_dir: Path,
    step: Path,
    tri_dir: Path,
    simulation_id: str = "",
    *,
    mesh_id: str = "",
    base_m: float | None = None,
    walls_level: int = 1,
    add_layers: bool = False,
) -> dict:
    """BC patches as one STL each in ``tri_dir``, a point inside the fluid, and
    the mesh's refinements.

    Same face -> patch map as the Standard mesher (``generate_standard``): the
    study's BCs, each Inflate boundary layer's faces on their own wall patch,
    then every other face on ``walls``. Surface custom sizing faces get a
    refinement-only STL each. Returns ``patches`` / ``location_m`` /
    ``layer_specs`` / ``refine_regions`` for ``write_hexdominant_dicts``, plus
    notes for the log.
    """
    import numpy as np
    from generate_standard import _add_default_walls, _apply_web_bcs

    from cfddesk.cad.location import find_location_in_mesh
    from cfddesk.cad.shared_faces import bc_refusal, face_bodies, shared_face_ids
    from cfddesk.cad.step import load_step, tessellate_faces
    from cfddesk.mesh.gmsh_standard import _face_to_patch_map, emitted_patch_types
    from cfddesk.mesh.snappy_hexdominant import (
        refinement_level_for_size,
        write_patch_stls,
        write_refine_stls,
    )
    from cfddesk.mesh.web_refinements import (
        bind_inflate_patches,
        drop_inside_faces,
        face_ids_from_web_bc,
        inflate_notes,
        layer_specs_for_generate,
        leftover_faces,
        load_inflate_refs,
        load_surface_custom_sizes,
    )
    from cfddesk.project.model import Project
    from cfddesk.project.web_adapter import study_web_bcs

    solid = load_step(step)
    units = solid.units
    scale = float(
        getattr(units, "proposed_scale_to_metres", None) or getattr(units, "scale_to_metres", None) or 0.001
    )
    n_faces = len(solid.faces)
    pts, tris, fids = tessellate_faces(solid)
    pts_m = np.asarray(pts, dtype=np.float64) * scale
    diag_m = float(np.linalg.norm(pts_m.max(axis=0) - pts_m.min(axis=0))) if len(pts_m) else 1.0
    h_wall_m = (base_m or diag_m / 20.0) / (2 ** max(0, int(walls_level)))

    project = Project.from_solid(solid, scale_to_metres=scale, units_confirmed=True)
    web_bcs = study_web_bcs(project_dir, None, simulation_id=simulation_id or None)
    inside = shared_face_ids(solid)
    refusal = bc_refusal(
        ((str(b.get("name") or "a boundary condition"), face_ids_from_web_bc(b, n_faces)) for b in web_bcs),
        inside,
        face_bodies(solid),
    )
    if refusal:
        raise RuntimeError(refusal)
    project = _apply_web_bcs(project, web_bcs, n_faces)
    sizes, _mins, size_notes = load_surface_custom_sizes(project_dir, mesh_id, n_faces, diag_m)
    inflates = load_inflate_refs(project_dir, mesh_id, n_faces, h_wall_m, extra_face_sizes=sizes)
    drop_inside_faces(inside, sizes, _mins, size_notes, inflates)
    project, inflates = bind_inflate_patches(project, inflates, n_faces)
    project = _add_default_walls(project, leftover_faces(project, n_faces, inside))
    patch_types = emitted_patch_types(project)
    patches = write_patch_stls(
        tri_dir, pts_m, tris, fids, _face_to_patch_map(project), patch_types, inside=inside
    )

    layer_specs = None
    if inflates or add_layers:
        wall_patches = [p["name"] for p in patches if p["type"] == "wall"]
        automatic = [] if not add_layers else [_AutoLayers(name) for name in wall_patches]
        inflate_names = {s.patch_name for s in inflates if s.patch_name}
        layer_specs = [a for a in automatic if a.name not in inflate_names] + layer_specs_for_generate(
            wall_patches=wall_patches,
            inflate=inflates,
            add_layers=False,
            default_n=2,
            default_thickness_m=0.0,
            default_expansion=1.1,
            default_min_m=0.0,
        )

    regions = []
    if base_m:
        groups = [
            {
                "face_ids": n["face_ids"],
                "size_m": float(n["size_m"]),
                "level": refinement_level_for_size(base_m, float(n["size_m"])),
                # Refine about three target cells out from the faces.
                "distance_m": 3.0 * float(n["size_m"]),
                "source": n.get("name"),
            }
            for n in size_notes
        ]
        regions = write_refine_stls(tri_dir, pts_m, tris, fids, groups)
    location = find_location_in_mesh(solid, scale)
    return {
        "patches": patches,
        "location_m": location.point_metres,
        "layer_specs": layer_specs,
        "refine_regions": regions,
        "inflate": inflate_notes(inflates),
        "surface_custom": [
            {"name": r.get("source"), "size_m": r["size_m"], "level": r["level"], "faces": len(r["face_ids"])}
            for r in regions
        ],
    }


class _AutoLayers:
    """Automatic BL on a wall patch: two layers sized relative to the local cell."""

    def __init__(self, name: str):
        self.name = name
        self.n_layers = 2
        self.thickness_m = None
        self.first_layer_m = None
        self.expansion = None
        self.min_thickness_m = None
        self.specify = "total"
        self.honor_absolute = False


def main() -> int:
    p = argparse.ArgumentParser(description="Hex-dominant snappyHexMesh generate")
    p.add_argument("--project-dir", required=True)
    p.add_argument("--case-dir", required=True)
    p.add_argument("--wsl-case", required=True)
    p.add_argument("--generate-id", required=True)
    p.add_argument("--fineness", type=int, default=5)
    p.add_argument("--add-layers", type=int, default=0)
    p.add_argument("--physics-based", type=int, default=1)
    p.add_argument(
        "--legacy-markers",
        action="store_true",
        help="Also emit CFMESH_PROGRESS/CFMESH_RESULT lines.",
    )
    p.add_argument("--timeout", type=float, default=3600.0)
    p.add_argument(
        "--render-only",
        action="store_true",
        help="Host-prep + render bash only (no WSL).",
    )
    p.add_argument("--simulation-id", default="")
    p.add_argument("--mesh-id", default="")
    p.add_argument(
        "--input-shape-sha256",
        default="",
        help="A linked or display-budgeted geometry: build Body1.stl here (prepare_input) unless "
        "Body1.json says it was made from this shape.",
    )
    args = p.parse_args()
    _legacy.set_legacy_markers(bool(args.legacy_markers))

    project_dir = Path(args.project_dir).resolve()
    case_dir = Path(args.case_dir).resolve()
    claim_generate_case(case_dir, generate_id=str(args.generate_id))
    atexit.register(release_generate_case, case_dir, generate_id=str(args.generate_id))
    wsl_case = validate_wsl_case_id(str(args.wsl_case))
    generate_id = str(args.generate_id)
    add_layers = bool(int(args.add_layers))
    physics_based = bool(int(args.physics_based))

    if wsl_case.startswith("cfddesk-manual-") or wsl_case == "cfddesk-cfmesh":
        return _result(False, error=f"refusing reserved WSL case id {wsl_case}")
    if "HEXCORE-PROCESS-BACKUP" in str(case_dir):
        return _result(False, error="refusing to write into HEXCORE-PROCESS-BACKUP")

    from cfddesk.project.paths import find_study, resolve_step

    geom_id = None
    sid = str(getattr(args, "simulation_id", "") or "").strip()
    if sid:
        study = find_study(project_dir, sid)
        if study:
            geom_id = study.get("geometry_id")
    step = resolve_step(project_dir, geom_id)
    body1 = (step.parent / "Body1.stl") if step else None
    from cfddesk.cad.io import geometry_file_exists

    if not step or not geometry_file_exists(step):
        return _result(False, error=f"missing source.step: {step}")
    mesh_input: dict = {}
    if args.input_shape_sha256 and body1 is not None:
        try:
            built = prepare_input(step, body1, str(args.input_shape_sha256))
        except Exception as exc:
            return _result(False, error=f"Couldn't prepare the mesh input: {exc}")
        if built is not None:
            mesh_input = {
                "mesh_input_built": True,
                "mesh_input_seconds": built.get("seconds"),
                "mesh_input_ntri": (built.get("bounds") or {}).get("ntri"),
            }
        # The input's hash, which the server did not read (LINK 5.9).
        mesh_input["body1_sha256"] = (
            (built or {}).get("stl_sha256") or _read_json(body1.with_suffix(".json")).get("stl_sha256") or _sha256_file(body1)
        )
        mesh_input["body1_path"] = str(body1)
    if not body1 or not body1.is_file():
        return _result(False, error=f"missing Body1.stl: {body1}")
    if not _SNAPPY_SH.is_file():
        return _result(False, error=f"missing template: {_SNAPPY_SH}")

    try:
        _progress("load_geometry", step=str(step), body1=str(body1))
        # Fresh case dir
        if case_dir.exists():
            shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)
        tri = case_dir / "constant" / "triSurface"
        tri.mkdir(parents=True, exist_ok=True)
        for pth in list(tri.glob("*")):
            if pth.is_file():
                pth.unlink()
            else:
                shutil.rmtree(pth, ignore_errors=True)

        scaled = scale_body1_stl(body1, tri / "Body1.stl")
        bounds = scaled["bounds_m"]
        # Body1.stl stays the source of feature edges; the mesh itself is built
        # from one surface per BC patch so the solver finds its patches.
        params = fineness_params(
            int(args.fineness), physics_based=physics_based, bounds_m=bounds
        )
        prep = boundary_patches(
            project_dir,
            step,
            tri,
            sid,
            mesh_id=str(args.mesh_id or ""),
            base_m=base_cell_size(int(args.fineness), bounds),
            walls_level=params["walls_level"],
            add_layers=add_layers,
        )
        patches, location_m = prep["patches"], prep["location_m"]
        _progress(
            "patches",
            patches=[p["name"] for p in patches],
            location_m=list(location_m),
            surface_custom=prep["surface_custom"],
            inflate=prep["inflate"],
        )
        _progress(
            "write_dicts",
            block=params["block"],
            feature_level=params["feature_level"],
            walls_level=params["walls_level"],
            add_layers=add_layers,
            snappy_geometry_rev=params["snappy_geometry_rev"],
        )
        meta = write_hexdominant_dicts(
            case_dir,
            block=params["block"],
            feature_level=params["feature_level"],
            walls_level=params["walls_level"],
            add_layers=add_layers,
            snap=params["snap"],
            bounds_m=bounds,
            patches=patches,
            location_m=location_m,
            layer_specs=prep["layer_specs"],
            refine_regions=prep["refine_regions"],
        )
        meta_doc = {
            "increment": "W25",
            "project_id": project_dir.name,
            "step_path": str(step),
            "body1_path_src": str(body1),
            "body1_bytes_scaled": scaled["body1_bytes"],
            "bounds_m": bounds,
            "mtp1_silent_copy": False,
            "geometry_source": "W16_project_STEP_Body1",
            **meta,
        }
        (case_dir / "w23-geometry-meta.json").write_text(
            json.dumps(meta_doc, indent=2), encoding="utf-8"
        )

        dst = wsl_case_path(wsl_case)
        win_out_wsl = windows_to_wsl_path(case_dir)
        script_body = render_snappy_script(
            dst=dst, win_out=win_out_wsl, generate_id=generate_id
        )
        if args.render_only:
            out = case_dir / "generate_snappy.render.sh"
            out.write_bytes(script_body.encode("utf-8"))
            return _result(
                True,
                render_only=True,
                script=str(out),
                **mesh_input,
                **{k: params[k] for k in ("block", "feature_level", "walls_level", "snappy_geometry_rev")},
                snap=params["snap"],
                add_layers=add_layers,
            )

        _progress("sync_to_wsl", wsl_case=wsl_case)
        sync_to_wsl(case_dir, wsl_case, timeout=600.0)

        with tempfile.TemporaryDirectory(prefix="cfddesk-snappy-") as tmp:
            sh_path = Path(tmp) / f"generate-{generate_id}.sh"
            sh_path.write_bytes(script_body.encode("utf-8"))
            wsl_sh = windows_to_wsl_path(sh_path)
            argv = [
                "wsl",
                "-d",
                get_wsl_distro(),
                "--",
                "bash",
                wsl_sh,
            ]
            _progress("snappy_pipeline", argv=" ".join(argv))
            proc = subprocess.Popen(
                argv,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            assert proc.stdout is not None
            last_result = None
            for line in proc.stdout:
                line = line.rstrip("\n")
                if line.startswith("MAGNUSIM_EVENT ") or line.startswith("CFDDESK_EVENT "):
                    # Re-emit bare protocol already on stdout from bash; also dual legacy if asked
                    print(line, flush=True)
                    try:
                        payload = line.split(" ", 1)[1]
                        data = json.loads(payload)
                        if data.get("event") == "result":
                            last_result = data
                        if _legacy.legacy_enabled() and data.get("event") == "progress":
                            print(
                                "CFMESH_PROGRESS "
                                + json.dumps(
                                    {"stage": data.get("stage"), **{k: v for k, v in data.items() if k not in ("event",)}},
                                    separators=(",", ":"),
                                ),
                                flush=True,
                            )
                    except Exception:
                        pass
                elif line.strip():
                    emit("log", line=line[:500])
            rc = proc.wait(timeout=float(args.timeout))

        counts = read_polymesh_counts(case_dir)
        (case_dir / "w21-counts.json").write_text(
            json.dumps(counts, indent=2), encoding="utf-8"
        )
        marks = read_feature_marks(case_dir / "log.snappyHexMesh")
        (case_dir / "w21-feature-marks.json").write_text(
            json.dumps(marks, indent=2), encoding="utf-8"
        )
        if marks["total"] < 1 and rc == 0:
            return _result(
                False,
                error="zero explicit feature refinement",
                exit_code=44,
                **counts,
                feature_marks_total=marks["total"],
            )

        ok = rc == 0 and (last_result is None or bool(last_result.get("ok", True)))
        if ok:
            # The script copied the mesh and logs to Windows; the WSL copy is done.
            remove_wsl_case(wsl_case)
        return _result(
            ok,
            exit_code=rc,
            n_cells=counts.get("n_cells"),
            n_points=counts.get("n_points"),
            n_faces=counts.get("n_faces"),
            counts_source=counts.get("source"),
            feature_marks_total=marks["total"],
            block=params["block"],
            feature_level=params["feature_level"],
            walls_level=params["walls_level"],
            add_layers=add_layers,
            snap=params["snap"],
            snappy_geometry_rev=params["snappy_geometry_rev"],
            generate_id=generate_id,
            wsl_case=wsl_case,
            case_dir=str(case_dir),
            **mesh_input,
        )
    except Exception as exc:
        return _result(False, error=str(exc), traceback=traceback.format_exc()[-2000:])


if __name__ == "__main__":
    raise SystemExit(main())
