"""Reading the web-format project files: meshes, studies, runs, face properties.

The core's side of a run: which mesh and study it uses, its time dependency
and analysis (``cfddesk.project.run_inputs`` gathers the rest). The analysis
owns the case (``AnalysisType.write_case``).
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Literal

from magnusim_sdk.foam import boundary_patch_names as _parse_boundary_patches
from magnusim_sdk.study import (  # noqa: F401  (the core's BC-record helpers; one copy in the SDK)
    bc_faces,
    is_pressure_bc,
    is_velocity_inlet,
    is_velocity_outlet,
    is_wall_bc,
    list_aa_faces,
    list_bc_records,
    map_bc_to_patch,
    matches_study,
    run_custom_monitors,
    sanitize_patch_name,
    study_fluid,
    unique_numbered_patch,
    wall_treatment,
)

from cfddesk.project.readiness import study_record


def _read_json(path: Path) -> dict | list | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None


























def load_face_props(project_dir: Path) -> dict[str, dict[str, Any]]:
    """Port of w27 loadFaceProps (read-only; no STEP regen)."""
    from cfddesk.project.paths import walk_geometries

    meta: dict | list | None = None
    for g in walk_geometries(project_dir):
        cand = _read_json(Path(g["dir"]) / "cad_preview.json")
        if isinstance(cand, dict) and isinstance(cand.get("faces"), list) and cand["faces"]:
            meta = cand
            break
    if meta is None:
        meta = _read_json(project_dir / "geometry" / "cad_preview.json")
    out: dict[str, dict[str, Any]] = {}
    if not isinstance(meta, dict) or not isinstance(meta.get("faces"), list):
        return out
    unit = str(meta.get("faces_length_unit") or "mm").lower()
    s = 1.0 if unit == "m" else (0.0254 if unit == "in" else 0.001)
    bodies = meta.get("bodies")
    body = bodies[0] if isinstance(bodies, list) and bodies else "Body1"
    for f in meta["faces"]:
        if not f or f.get("id") is None:
            continue
        key = f"face {f['id']}@{body}"
        area = f.get("area")
        cent = f.get("centroid")
        norm = f.get("normal")
        out[key] = dict(
            area_m2=(float(area) * s * s) if area is not None else None,
            centroid=(
                (float(cent[0]) * s, float(cent[1]) * s, float(cent[2]) * s)
                if isinstance(cent, (list, tuple)) and len(cent) >= 3
                else None
            ),
            normal=(
                (float(norm[0]), float(norm[1]), float(norm[2]))
                if isinstance(norm, (list, tuple)) and len(norm) >= 3
                else None
            ),
        )
    return out








def resolve_mesh(
    project_dir: Path,
    *,
    mesh_id: str | None = None,
    simulation_id: str | None = None,
    require_poly: bool = True,
) -> dict[str, Any]:
    """Subset of w27 resolveProjectMesh for prepare_run / validate."""
    from cfddesk.project.web_writes import assemble_mesh_doc

    mesh_doc: dict | list | None
    if simulation_id:
        mesh_doc = assemble_mesh_doc(project_dir, str(simulation_id), mesh_id)
        meshes = checked if isinstance((checked := mesh_doc.get("meshes")), list) else []
        scoped = [m for m in meshes if matches_study(m, simulation_id, None)]
    else:
        mesh_doc = _read_json(project_dir / "mesh.json")
        if not isinstance(mesh_doc, dict):
            return {"ok": False, "error": "mesh.json missing — generate a mesh first"}
        meshes = checked if isinstance((checked := mesh_doc.get("meshes")), list) else []
        scoped = [m for m in meshes if matches_study(m, simulation_id, None)]
    wanted = None
    if mesh_id:
        wanted = next((m for m in scoped if str(m.get("id")) == str(mesh_id)), None)
        if not wanted:
            return {"ok": False, "error": "mesh not found in this study", "mesh_id": mesh_id}
    else:
        active = mesh_doc.get("active_id")
        wanted = next((m for m in scoped if str(m.get("id")) == str(active)), None)
        if not wanted and scoped:
            wanted = scoped[0]

    live = (wanted or {}).get("live_mesh_result") if wanted else None
    case_dir = None
    if wanted and wanted.get("case_dir"):
        case_dir = Path(wanted["case_dir"])
    elif isinstance(live, dict) and live.get("case_dir"):
        case_dir = Path(live["case_dir"])
    poly_from_case = (case_dir / "constant" / "polyMesh") if case_dir else None
    poly_from_live = (
        Path(live["mesh_path"]) if isinstance(live, dict) and live.get("mesh_path") else None
    )

    def _poly_complete(path: Path | None) -> bool:
        return bool(path and (path / "owner").is_file() and (path / "points").is_file())

    # Prefer the study folder's polyMesh. mesh.json still carries the path from
    # before the study folder was renamed (Incompressible_Steady-state → _1).
    if _poly_complete(poly_from_case):
        poly = poly_from_case
    elif _poly_complete(poly_from_live):
        poly = poly_from_live
    else:
        poly = poly_from_case or poly_from_live
    if require_poly:
        if not case_dir or not case_dir.is_dir():
            return {
                "ok": False,
                "error": "Generated mesh case missing — generate a mesh first",
                "case_dir": str(case_dir) if case_dir else None,
            }
        if not poly or not (poly / "owner").is_file() or not (poly / "points").is_file():
            return {
                "ok": False,
                "error": "polyMesh incomplete (owner/points)",
                "case_dir": str(case_dir),
                "mesh_path": str(poly) if poly else None,
            }
    patches = _parse_boundary_patches(poly / "boundary") if poly else []
    return {
        "ok": True,
        "case_dir": case_dir,
        "mesh_path": poly,
        "n_cells": (live or {}).get("n_cells") if isinstance(live, dict) else None,
        "patches": patches,
        "mesh_id": (wanted or {}).get("id") if wanted else None,
        "mesh_name": (wanted or {}).get("name") if wanted else None,
        "wsl_case": (live or {}).get("wsl_case") if isinstance(live, dict) else None,
    }




def _bc_type_text(raw: Any) -> str:
    """A bc_type compared without case or spaces ("velocity inlet" = "Velocity inlet")."""
    return re.sub(r"\s+", "", str(raw or "")).lower()


def bc_family_for(bc_type: Any) -> Any | None:
    """The registered BC family whose record_type or an alias is ``bc_type``."""
    from cfddesk.case.bc_registry import _bc_registry
    from cfddesk.registry.discovery import get_hub

    want = _bc_type_text(bc_type)
    if not want:
        return None
    _bc_registry()  # loads the registry once when it is still empty
    for fam in get_hub().registry("bc_family").items():
        names = (getattr(fam, "record_type", ""), *(getattr(fam, "aliases", ()) or ()))
        if any(_bc_type_text(n) == want for n in names):
            return fam
    return None


def web_bc_to_registry(bc: Any) -> tuple[str, dict[str, Any]]:
    """Map web BC record -> (BC type key, settings dict in SI units).

    The family the record's ``bc_type`` names resolves it (``BcFamily.resolve``,
    from the plugin that registers it). A record of no registered family reads
    as a no-slip wall.
    """
    if not isinstance(bc, dict):
        d = {
            "bc_type": bc.bc_type,
            "value": bc.value,
            "unit": bc.unit,
            "velocity_type": bc.velocity_type,
            "flow_rate_type": bc.flow_rate_type,
            "direction": bc.direction,
            "vector": bc.vector,
            "wall_type": bc.wall_type,
            "name": bc.name,
        }
    else:
        d = dict(bc)
    fam = bc_family_for(d.get("bc_type"))
    resolve = getattr(fam, "resolve", None) if fam is not None else None
    if callable(resolve):
        key, settings = resolve(d)
        return str(key), dict(settings)
    # Fallback: wall
    return "wall_noslip", {}


def web_bc_mesh_entry(bc: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """(BC type key, SI settings) a web BC record meshes as.

    The record's ``bc_type`` (or ``type``; an alias reads as its family's
    record_type) must name a registered BC family, else ValueError. A record
    whose values the family cannot resolve (a bad direction vector) still
    meshes, as the family's first variant: meshing needs only its patch type.
    """
    raw = str(bc.get("bc_type") or bc.get("type") or "")
    fam = bc_family_for(raw) or bc_family_for(raw.replace("_", " "))
    if fam is None:
        raise ValueError(f"unsupported boundary condition type: {bc.get('bc_type')!r}")
    try:
        return web_bc_to_registry({**bc, "bc_type": fam.record_type})
    except ValueError:
        return str(fam.variants[0]), {}


def web_bc_patch_name(bc: dict[str, Any], reg_key: str) -> str:
    """Patch name a web BC record meshes under: its name, else its BC type's semantic.

    An unnamed velocity outlet keeps the name the meshers gave it before 1.4
    ("velocity_outlet"), so it does not share "outlet" with a pressure outlet.
    """
    if bc.get("name"):
        return str(bc["name"])
    if reg_key == "velocity_outlet":
        return "velocity_outlet"
    from cfddesk.case.bc_registry import get_type

    return get_type(reg_key).semantic


def _active_sim_id(project_dir: Path, simulation_id: str | None) -> str | None:
    if simulation_id:
        return simulation_id
    sim = _read_json(project_dir / "simulation.json")
    if isinstance(sim, dict) and sim.get("id"):
        return str(sim["id"])
    sims = _read_json(project_dir / "simulations.json")
    if isinstance(sims, dict):
        if sims.get("active_id"):
            return str(sims["active_id"])
        arr = sims.get("simulations")
        if isinstance(arr, list) and arr:
            return str(arr[0].get("id") or "") or None
    return None


def resolve_study_id(
    project_dir: Path | str,
    simulation_id: str | None = None,
    mesh_id: str | None = None,
) -> str | None:
    """Active study for a generate/solve: explicit id, then the mesh record, then catalog."""
    root = Path(project_dir)
    if simulation_id:
        return str(simulation_id)
    mid = str(mesh_id or "").strip()
    if mid:
        from cfddesk.project.paths import find_mesh

        found = find_mesh(root, mid)
        if found and found.get("simulation_id"):
            return str(found["simulation_id"])
        mesh_doc = _read_json(root / "mesh.json")
        if isinstance(mesh_doc, dict):
            for m in mesh_doc.get("meshes") or []:
                if isinstance(m, dict) and str(m.get("id") or "") == mid:
                    sid = str(m.get("simulation_id") or "").strip()
                    if sid:
                        return sid
            sid = str(mesh_doc.get("simulation_id") or "").strip()
            if sid:
                return sid
    return _active_sim_id(root, None)


def study_web_bcs(
    project_dir: Path | str,
    web_bcs: list | None,
    *,
    simulation_id: str | None = None,
    mesh_id: str | None = None,
) -> list[dict]:
    """BCs that belong to one study. Other studies' Pressure 1/2 must not share this mesh.

    Folder ``boundary_conditions/BC_*/bc.json`` rows win over an empty leftover
    ``boundary_conditions.json`` list (the file generate used to read alone).
    """
    from cfddesk.project.paths import assemble_study_bcs

    sim_id = resolve_study_id(project_dir, simulation_id, mesh_id)
    assembled = assemble_study_bcs(project_dir, sim_id)
    have = {str(b.get("id")) for b in assembled if isinstance(b, dict) and b.get("id") is not None}
    names = {str(b.get("name")) for b in assembled if isinstance(b, dict) and b.get("name")}
    for b in web_bcs or []:
        if not isinstance(b, dict) or not matches_study(b, sim_id):
            continue
        bid = b.get("id")
        if bid is not None and str(bid) in have:
            continue
        if bid is None and b.get("name") and str(b.get("name")) in names:
            continue
        assembled.append(b)
        if bid is not None:
            have.add(str(bid))
        if b.get("name"):
            names.add(str(b.get("name")))
    return [b for b in assembled if isinstance(b, dict) and matches_study(b, sim_id)]




def _td(value: Any) -> Literal["steady", "transient"]:
    return "transient" if re.search(r"transient", str(value or ""), re.I) else "steady"


def run_time_dependency(
    project_dir: Path | str, run_id: str | None, sim_id: str | None
) -> Literal["steady", "transient"]:
    """The time dependency a run solves with (the same rule Node and the Run panel use).

    The run's own stamp wins: a run that has started keeps the mode it solved
    with, and draft runs are restamped when their study changes. A run without
    one follows its study. Never another study's: the project-level
    simulation.json mirror is the *active* study, which is only used for a
    legacy single-study project with no study id.
    """
    from cfddesk.project.paths import find_run, find_study

    root = Path(project_dir)
    run = find_run(root, run_id, sim_id) if run_id else None
    stamped = str((run or {}).get("time_dependency") or "").strip()
    if stamped:
        return _td(stamped)
    if sim_id:
        study = find_study(root, sim_id) or study_record(root, sim_id)
        return _td((study or {}).get("time_dependency"))
    mirror = _read_json(root / "simulation.json")
    return _td(mirror.get("time_dependency") if isinstance(mirror, dict) else "")


def _study_analysis_type(root: Path, sim_id: str | None) -> str:
    from cfddesk.project.paths import find_study

    study = (find_study(root, sim_id) if sim_id else None) or study_record(root, sim_id) or {}
    return str(study.get("analysis_type") or study.get("analysis") or "")


def _analysis_and_app(root: Path, sim_id: str | None, td: str) -> tuple[str, str]:
    """AnalysisType key (study family + time dependency) and its solver app."""
    from cfddesk.registry.analysis import analysis_key_for
    from cfddesk.registry.discovery import get_registry, load_all

    load_all()
    reg = get_registry("analysis")
    key = analysis_key_for(_study_analysis_type(root, sim_id), td, reg)
    try:
        app = str(getattr(reg.get(key), "default_solver", "") or "")
    except Exception:
        app = ""
    return key, app








# Phase 2 land8 re-exports (Project <-> web sibling mirrors)
from cfddesk.project.web_mirrors import (  # noqa: E402
    WEB_SIBLING_RELS as WEB_SIBLING_RELS,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    apply_web_sibling_to_project as apply_web_sibling_to_project,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    from_web_boundary_conditions as from_web_boundary_conditions,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    from_web_materials as from_web_materials,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    from_web_mesh as from_web_mesh,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    from_web_mesh_refinements as from_web_mesh_refinements,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    from_web_result_controls as from_web_result_controls,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    from_web_runs_catalog as from_web_runs_catalog,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    from_web_simulation_control as from_web_simulation_control,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    from_web_simulations as from_web_simulations,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    ingest_web_siblings_if_newer as ingest_web_siblings_if_newer,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    is_python_project_doc as is_python_project_doc,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    load_or_synthesize_project as load_or_synthesize_project,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    mark_web_mirrors_derived as mark_web_mirrors_derived,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    regenerate_web_mirrors as regenerate_web_mirrors,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    to_web_boundary_conditions as to_web_boundary_conditions,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    to_web_materials as to_web_materials,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    to_web_mesh as to_web_mesh,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    to_web_mesh_refinements as to_web_mesh_refinements,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    to_web_result_controls as to_web_result_controls,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    to_web_runs_catalog as to_web_runs_catalog,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    to_web_simulation_control as to_web_simulation_control,
)
from cfddesk.project.web_mirrors import (  # noqa: E402 — public compatibility exports after local definitions
    to_web_simulations as to_web_simulations,
)
