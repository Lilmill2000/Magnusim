"""Bridge web-format project JSON (w18/w19/w20/w22/w27) → RunSpec.

Throwaway for Phase 2 once Project schema absorbs the web files. Phase 1 needs
this so prepare_run can delete the JS writer without rewriting UI persistence.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from cfddesk.project.transient import TransientControl, resolve_transient_control

SolverApp = Literal["simpleFoam", "pimpleFoam"]


@dataclass
class FaceProps:
    area_m2: float | None = None
    normal: tuple[float, float, float] | None = None
    centroid: tuple[float, float, float] | None = None


@dataclass
class WebBc:
    """One boundary_conditions.json record (+ resolved patch name)."""

    name: str
    bc_type: str
    faces: list[str] = field(default_factory=list)
    value: float | None = None
    unit: str = ""
    velocity_type: str = ""
    flow_rate_type: str = ""
    direction: str = ""
    vector: list[float] | None = None
    wall_type: str = ""
    patch: str = ""
    simulation_id: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class RunSpec:
    """Inputs prepare_run needs to write a complete OpenFOAM case."""

    project_dir: Path
    run_id: str
    mesh_case_dir: Path
    n_procs: int
    solver_app: SolverApp
    end_time: float
    write_interval: float
    transient: TransientControl | None
    nu: float
    rho: float
    wall_default: str
    bcs: list[WebBc]
    monitor_patches: list[str]
    face_props: dict[str, FaceProps]
    mesh_id: str | None = None
    simulation_id: str | None = None
    n_cells: int | None = None
    patches: list[str] = field(default_factory=list)
    speed_for_k: float = 1.0
    aa: dict[str, Any] | None = None
    mapped: list[dict[str, Any]] = field(default_factory=list)
    ok: bool = True
    error: str | None = None


def _read_json(path: Path) -> dict | list | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None


def sanitize_patch_name(label: str) -> str:
    """Match w27 sanitizePatchName: non-alnum → _, collapse, trim."""
    s = re.sub(r"[^A-Za-z0-9_]+", "_", str(label or ""))
    s = re.sub(r"_+", "_", s).strip("_")
    if not s:
        return "patch"
    if s[0].isdigit():
        s = "p_" + s
    return s


def list_bc_records(bcs: dict | None) -> list[dict]:
    if not bcs:
        return []
    arr = bcs.get("boundary_conditions")
    if not isinstance(arr, list):
        return []
    return [b for b in arr if b]


def bc_faces(bc: dict | None) -> list[str]:
    if not bc:
        return []
    faces = list(bc.get("faces") or [])
    if bc.get("face") and bc["face"] not in faces:
        faces.append(bc["face"])
    return [f for f in faces if f]


def is_velocity_inlet(bc: dict | None) -> bool:
    return bool(re.search(r"velocity\s*inlet", str((bc or {}).get("bc_type") or ""), re.I))


def is_velocity_outlet(bc: dict | None) -> bool:
    return bool(re.search(r"velocity\s*outlet", str((bc or {}).get("bc_type") or ""), re.I))


def is_pressure_bc(bc: dict | None) -> bool:
    return bool(re.match(r"pressure", str((bc or {}).get("bc_type") or ""), re.I))


def is_wall_bc(bc: dict | None) -> bool:
    return bool(re.match(r"^wall$", str((bc or {}).get("bc_type") or "").strip(), re.I))


def wall_treatment(rec: dict | None) -> str:
    t = re.sub(r"[\s_-]+", "", str((rec or {}).get("wall_type") or "").lower())
    return "Slip" if t == "slip" else "No-slip"


def matches_study(rec: dict | None, sim_id: str | None, legacy_id: str | None = None) -> bool:
    if not rec:
        return False
    sid = rec.get("simulation_id") or rec.get("study_id")
    if sid is None or sid == "":
        return True
    if sim_id is not None and str(sid) == str(sim_id):
        return True
    if legacy_id is not None and str(sid) == str(legacy_id):
        return True
    return False


def air_from_materials(
    mats: dict | None, sim_id: str | None = None, legacy_id: str | None = None
) -> dict[str, Any] | None:
    """Port of w27 airFromMaterials."""
    lst = (mats or {}).get("materials") if isinstance(mats, dict) else None
    if not isinstance(lst, list):
        return None
    scoped = [m for m in lst if matches_study(m, sim_id, legacy_id)]
    air = next((m for m in scoped if re.search(r"air", str(m.get("name") or ""), re.I)), None)
    if not air:
        return None
    vols = air.get("assigned_volumes") if isinstance(air.get("assigned_volumes"), list) else []
    nu = float(air.get("kinematic_viscosity") or 0)
    rho = float(air.get("density") or 0)
    return {
        "name": air.get("name") or "Air",
        "nu": nu if math.isfinite(nu) and nu > 0 else 1.529e-5,
        "rho": rho if math.isfinite(rho) and rho > 0 else 1.196,
        "assigned": len(vols) > 0 or bool(air.get("assigned_volume")),
    }


def load_face_props(project_dir: Path) -> dict[str, FaceProps]:
    """Port of w27 loadFaceProps (read-only; no STEP regen)."""
    meta = _read_json(project_dir / "geometry" / "cad_preview.json")
    out: dict[str, FaceProps] = {}
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
        out[key] = FaceProps(
            area_m2=(float(area) * s * s) if area is not None else None,
            centroid=(
                tuple(float(c) * s for c in cent)  # type: ignore[misc]
                if isinstance(cent, (list, tuple)) and len(cent) >= 3
                else None
            ),
            normal=(
                tuple(float(c) for c in norm)  # type: ignore[misc]
                if isinstance(norm, (list, tuple)) and len(norm) >= 3
                else None
            ),
        )
    return out


def list_aa_faces(aa: dict | None) -> list[str]:
    """Faces named by area-average result controls (w27 listAaFaces)."""
    if not aa:
        return []
    recs: list[dict] = []
    if aa.get("area_average_1"):
        recs.append(aa["area_average_1"])
    if isinstance(aa.get("result_controls"), list):
        for rec in aa["result_controls"]:
            if not rec:
                continue
            kind = str(rec.get("kind") or "")
            name = str(rec.get("name") or "")
            if re.search(r"area average", kind, re.I) or re.search(r"area average", name, re.I):
                recs.append(rec)
    faces: list[str] = []
    for rec in recs:
        for f in rec.get("faces") or []:
            if f and f not in faces:
                faces.append(f)
    return faces


def _parse_boundary_patches(boundary_path: Path) -> list[str]:
    if not boundary_path.is_file():
        return []
    text = boundary_path.read_text(encoding="utf-8", errors="replace")
    # OpenFOAM boundary: patchName\n{\n    type ...
    names: list[str] = []
    for m in re.finditer(r"(?m)^([A-Za-z_][\w]*)\s*\n\s*\{", text):
        name = m.group(1)
        if name not in ("FoamFile",):
            names.append(name)
    return names


def resolve_mesh(
    project_dir: Path,
    *,
    mesh_id: str | None = None,
    simulation_id: str | None = None,
    require_poly: bool = True,
) -> dict[str, Any]:
    """Subset of w27 resolveProjectMesh for prepare_run / validate."""
    mesh_doc = _read_json(project_dir / "mesh.json")
    if not isinstance(mesh_doc, dict):
        return {"ok": False, "error": "mesh.json missing — generate a mesh first"}
    meshes = mesh_doc.get("meshes") if isinstance(mesh_doc.get("meshes"), list) else []
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
    case_dir = Path(live["case_dir"]) if isinstance(live, dict) and live.get("case_dir") else None
    poly = None
    if isinstance(live, dict):
        if live.get("mesh_path"):
            poly = Path(live["mesh_path"])
        elif case_dir:
            poly = case_dir / "constant" / "polyMesh"
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


def map_bc_to_patch(bc: dict, patch_names: set[str], web_bcs: list[dict] | None = None) -> str:
    want = sanitize_patch_name(str(bc.get("name") or ""))
    if want in patch_names:
        return want
    for f in bc_faces(bc):
        alt = sanitize_patch_name(f)
        if alt in patch_names:
            return alt
    face_set = set(bc_faces(bc))
    for baked in web_bcs or []:
        baked_faces = set(bc_faces(baked))
        if face_set & baked_faces:
            from_baked = sanitize_patch_name(str(baked.get("name") or ""))
            if from_baked in patch_names:
                return from_baked
    return want


def web_bc_to_registry(bc: WebBc | dict) -> tuple[str, dict[str, Any]]:
    """Map web BC record → (bc_registry key, settings dict).

    Values are converted to SI using the record's ``unit`` field where possible.
    """
    if isinstance(bc, WebBc):
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

    bct = str(d.get("bc_type") or "")
    unit = str(d.get("unit") or "")
    val = d.get("value")
    settings: dict[str, Any] = {}

    def _to(q: str, v: Any, u: str, default_u: str) -> float | None:
        if v is None:
            return None
        try:
            from cfddesk.units.convert import to_si

            use = u if u else default_u
            # Alias ft3/min → CFM table key
            aliases = {
                "ft3/min": "CFM",
                "ft³/min": "CFM",
                "m3/s": "m³/s",
                "m^3/s": "m³/s",
                "m3/h": "m³/h",
                "m^3/h": "m³/h",
            }
            use = aliases.get(use, use)
            try:
                return float(to_si(q, float(v), use))  # type: ignore[arg-type]
            except ValueError:
                return float(v)
        except Exception:
            return float(v)

    if is_wall_bc(d):
        wt = wall_treatment(d)
        return ("wall_slip" if wt == "Slip" else "wall_noslip"), settings

    if is_velocity_inlet(d):
        vtype = str(d.get("velocity_type") or "")
        if re.search(r"flow\s*rate", vtype, re.I) or re.search(
            r"ft3/min|ft³/min|m3/s|m³/s|kg/s|lb/s", unit, re.I
        ):
            if re.search(r"mass", str(d.get("flow_rate_type") or ""), re.I) or (
                _to("mass_flow", val, unit, "kg/s") is not None
                and _to("volumetric_flow", val, unit, "m³/s") is None
            ):
                settings["mass_flow_rate"] = _to("mass_flow", val, unit, "kg/s") or 0.0
                return "velocity_inlet_mass_flow", settings
            settings["volumetric_flow_rate"] = _to("volumetric_flow", val, unit, "m³/s") or 0.0
            return "velocity_inlet_volumetric", settings
        speed = _to("velocity", val, unit, "m/s")
        if speed is None:
            speed = 1.0
        if re.search(r"vector", str(d.get("direction") or ""), re.I) and isinstance(
            d.get("vector"), (list, tuple)
        ):
            vec = [float(x) for x in d["vector"][:3]]
            mag = math.hypot(*vec) or 1.0
            settings["direction_mode"] = "vector"
            settings["velocity"] = [speed * (vec[0] / mag), speed * (vec[1] / mag), speed * (vec[2] / mag)]
        else:
            settings["direction_mode"] = "normal"
            settings["speed"] = speed
        return "velocity_inlet_fixed", settings

    if is_velocity_outlet(d):
        return "velocity_outlet", settings

    if is_pressure_bc(d):
        p = _to("pressure", val, unit, "Pa")
        settings["gauge_pressure"] = 0.0 if p is None else p
        # Distinguish inlet vs outlet by type string when present
        if re.search(r"inlet", bct, re.I):
            return "pressure_inlet_gauge", settings
        return "pressure_outlet_gauge", settings

    # Fallback: wall
    return "wall_noslip", settings


def _active_sim_id(project_dir: Path, simulation_id: str | None) -> str | None:
    if simulation_id:
        return simulation_id
    sim = _read_json(project_dir / "simulation.json")
    if isinstance(sim, dict) and sim.get("id"):
        return str(sim["id"])
    sims = _read_json(project_dir / "simulations.json")
    if isinstance(sims, dict):
        arr = sims.get("simulations")
        if isinstance(arr, list) and arr:
            return str(arr[0].get("id") or "") or None
    return None


def _sim_is_transient(project_dir: Path, sim_id: str | None) -> bool:
    sim = _read_json(project_dir / "simulation.json")
    if isinstance(sim, dict):
        if re.search(r"transient", str(sim.get("time_dependency") or ""), re.I):
            return True
    ctrl = _read_json(project_dir / "simulation_control.json")
    if isinstance(ctrl, dict) and ctrl.get("transient"):
        # presence alone is not enough; check sim label above first
        pass
    sims = _read_json(project_dir / "simulations.json")
    if isinstance(sims, dict) and isinstance(sims.get("simulations"), list):
        for s in sims["simulations"]:
            if sim_id and str(s.get("id")) != str(sim_id):
                continue
            if re.search(r"transient", str(s.get("time_dependency") or ""), re.I):
                return True
    return False


def load_run_spec(
    project_dir: str | Path,
    *,
    run_id: str = "run-1",
    mesh_id: str | None = None,
    n_procs: int = 1,
    simulation_id: str | None = None,
    require_mesh: bool = True,
    transient_override: dict | None = None,
) -> RunSpec:
    """Build a RunSpec from web JSON files under ``project_dir``.

    Mirrors the data gathering in w27 validateSolveReady + writeSolveCase
    preamble (materials, BCs, mesh, monitors, transient).
    """
    root = Path(project_dir)
    sim_id = _active_sim_id(root, simulation_id)
    mats = _read_json(root / "materials.json")
    bcs_doc = _read_json(root / "boundary_conditions.json")
    aa = _read_json(root / "area_average.json") or _read_json(root / "result_controls.json")
    if not isinstance(aa, dict):
        aa = {}
    ctrl = _read_json(root / "simulation_control.json")
    if not isinstance(ctrl, dict):
        ctrl = {}

    air = air_from_materials(mats if isinstance(mats, dict) else None, sim_id)
    records = [
        b
        for b in list_bc_records(bcs_doc if isinstance(bcs_doc, dict) else None)
        if matches_study(b, sim_id, None)
    ]

    mesh = resolve_mesh(root, mesh_id=mesh_id, simulation_id=sim_id, require_poly=require_mesh)
    if not mesh.get("ok") and require_mesh:
        return RunSpec(
            project_dir=root,
            run_id=run_id,
            mesh_case_dir=Path("."),
            n_procs=n_procs,
            solver_app="simpleFoam",
            end_time=float(ctrl.get("endTime") or 200),
            write_interval=float(ctrl.get("writeInterval") or 50),
            transient=None,
            nu=(air or {}).get("nu", 1.529e-5),
            rho=(air or {}).get("rho", 1.196),
            wall_default=wall_treatment((bcs_doc or {}).get("defaults") if isinstance(bcs_doc, dict) else None),
            bcs=[],
            monitor_patches=[],
            face_props={},
            ok=False,
            error=str(mesh.get("error") or "mesh not ready"),
        )

    patch_names = set(mesh.get("patches") or [])
    # When mesh not required / empty patches, invent from BC names so monitors work in unit tests
    if not patch_names:
        patch_names = {sanitize_patch_name(str(b.get("name") or "")) for b in records if bc_faces(b)}

    mapped: list[dict[str, Any]] = []
    web_bcs: list[WebBc] = []
    for bc in records:
        if not bc_faces(bc):
            continue
        patch = map_bc_to_patch(bc, patch_names)
        mapped.append({"bc": bc, "patch": patch})
        web_bcs.append(
            WebBc(
                name=str(bc.get("name") or patch),
                bc_type=str(bc.get("bc_type") or ""),
                faces=bc_faces(bc),
                value=float(bc["value"]) if bc.get("value") is not None else None,
                unit=str(bc.get("unit") or ""),
                velocity_type=str(bc.get("velocity_type") or ""),
                flow_rate_type=str(bc.get("flow_rate_type") or ""),
                direction=str(bc.get("direction") or ""),
                vector=list(bc["vector"]) if isinstance(bc.get("vector"), list) else None,
                wall_type=str(bc.get("wall_type") or ""),
                patch=patch,
                simulation_id=str(bc["simulation_id"]) if bc.get("simulation_id") is not None else None,
                raw=dict(bc),
            )
        )

    from cfddesk.case.function_objects import monitor_patches_from_mapped

    mon = monitor_patches_from_mapped(
        mapped,
        aa_faces=list_aa_faces(aa),
        patch_names=list(patch_names),
    )

    is_trans = _sim_is_transient(root, sim_id) or bool(transient_override)
    transient: TransientControl | None = None
    end_time = float(ctrl.get("endTime") or 200)
    write_interval = float(ctrl.get("writeInterval") or 50)
    if is_trans:
        t_raw = transient_override if transient_override is not None else ctrl.get("transient")
        transient = resolve_transient_control(
            t_raw if isinstance(t_raw, dict) else {},
            {
                "n_cells": mesh.get("n_cells"),
                "speed_ref": 1.0,
            },
        )
        end_time = transient.end_time
        write_interval = transient.write_interval

    wall_default = wall_treatment(
        (bcs_doc or {}).get("defaults") if isinstance(bcs_doc, dict) else None
    )
    case_dir = mesh.get("case_dir") or root
    if not isinstance(case_dir, Path):
        case_dir = Path(case_dir)

    return RunSpec(
        project_dir=root,
        run_id=run_id,
        mesh_case_dir=case_dir,
        n_procs=int(n_procs),
        solver_app="pimpleFoam" if is_trans else "simpleFoam",
        end_time=end_time,
        write_interval=write_interval,
        transient=transient,
        nu=float((air or {}).get("nu", 1.529e-5)),
        rho=float((air or {}).get("rho", 1.196)),
        wall_default=wall_default,
        bcs=web_bcs,
        monitor_patches=mon,
        face_props=load_face_props(root),
        mesh_id=mesh.get("mesh_id"),
        simulation_id=sim_id,
        n_cells=mesh.get("n_cells"),
        patches=list(patch_names),
        speed_for_k=1.0,
        aa=aa,
        mapped=mapped,
        ok=True,
        error=None,
    )
