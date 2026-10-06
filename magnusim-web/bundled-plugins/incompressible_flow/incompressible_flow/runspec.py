"""The run specification Incompressible Flow writes a case from.

``load_run_spec(inputs)`` turns what the core gathered for a run
(``cfddesk.project.run_inputs.RunInputs``: the study's materials, boundary
conditions, result controls and run control, its mesh, face properties and
the run record) into a :class:`RunSpec`: the fluid, the boundary conditions
mapped to mesh patches, the monitors, the physics and, for a transient run,
the time step.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Literal

from magnusim_sdk.study import (
    bc_faces,
    is_pressure_bc,
    is_velocity_inlet,
    is_velocity_outlet,
    is_wall_bc,
    list_aa_faces,
    list_bc_records,
    map_bc_to_patch,
    matches_study,
    sanitize_patch_name,
    study_fluid,
    wall_treatment,
)

from .materials import LEGACY_AIR
from .monitors import custom_monitors, forces_monitor_records, probe_monitor_records
from .physics import StudyPhysics, physics_from_record
from .reference import reference_record
from .settle import clean_settle
from .transient import STEADY_DEFAULTS, TransientControl, load_mesh_meta, resolve_transient_control

__all__ = [
    "FaceProps",
    "RunSpec",
    "SolverAppName",
    "TransientControl",
    "WebBc",
    "air_from_materials",
    "bc_faces",
    "is_pressure_bc",
    "is_velocity_inlet",
    "is_velocity_outlet",
    "is_wall_bc",
    "load_run_spec",
    "transient_context",
    "wall_treatment",
]

SolverAppName = Literal["simpleFoam", "pimpleFoam"]


@dataclass
class FaceProps:
    area_m2: float | None = None
    normal: tuple[float, float, float] | None = None
    centroid: tuple[float, float, float] | None = None


@dataclass
class WebBc:
    """One boundary condition record (+ the mesh patch it landed on)."""

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
    """What the case writer needs to write a complete OpenFOAM case."""

    project_dir: Path
    run_id: str
    mesh_case_dir: Path
    n_procs: int
    solver_app: SolverAppName
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
    # Study panel physics (turbulence model + steady SIMPLE numerics).
    physics: StudyPhysics = field(default_factory=StudyPhysics)
    # This run's custom monitors: {"name", "faces"} (area average on any faces).
    custom_monitors: list[dict[str, Any]] = field(default_factory=list)
    # The study's reference values as saved (``ref_*`` keys, SI; incompressible_flow.reference).
    reference: dict[str, Any] = field(default_factory=dict)
    # This run's Forces monitors: {"id", "name", "boundaries"} (BC ids or names, "@walls").
    forces_monitors: list[dict[str, Any]] = field(default_factory=list)
    # This run's Point probes: {"id", "name", "points"} (metres, the mesh's coordinates).
    probe_monitors: list[dict[str, Any]] = field(default_factory=list)
    # The run's result controls as saved (the monitors a settle stop can watch).
    result_controls: list[dict[str, Any]] = field(default_factory=list)
    # "Stop when a monitor settles" (incompressible_flow.settle.clean_settle), or None.
    settle: dict[str, Any] | None = None
    analysis_key: str = ""
    time_dependency: Literal["steady", "transient"] = "steady"
    ok: bool = True
    error: str | None = None
    # A run continued from its latest saved time ({"end_time", "write_interval"};
    # RunInputs.restart): end_time and write_interval are already these.
    restart: dict[str, Any] | None = None


def air_from_materials(
    mats: dict | None, sim_id: str | None = None, legacy_id: str | None = None
) -> dict[str, Any] | None:
    """The study's fluid: name, nu, rho, and whether it is assigned to a volume.

    A record without a number reads LEGACY_AIR's (what older versions filled in),
    so an older project solves as it did; every record written now has its own.
    """
    lst = (mats or {}).get("materials") if isinstance(mats, dict) else None
    if not isinstance(lst, list):
        return None
    scoped = [m for m in lst if matches_study(m, sim_id, legacy_id)]
    air = study_fluid(scoped)
    if not air:
        return None
    vols = checked if isinstance((checked := air.get("assigned_volumes")), list) else []
    nu = float(air.get("kinematic_viscosity") or 0)
    rho = float(air.get("density") or 0)
    return {
        "name": air.get("name") or "Air",
        "nu": nu if math.isfinite(nu) and nu > 0 else LEGACY_AIR["nu"],
        "rho": rho if math.isfinite(rho) and rho > 0 else LEGACY_AIR["rho"],
        "assigned": len(vols) > 0 or bool(air.get("assigned_volume")),
    }


def _face_props(raw: dict[str, Any] | None) -> dict[str, FaceProps]:
    out: dict[str, FaceProps] = {}
    for key, row in (raw or {}).items():
        if isinstance(row, FaceProps):
            out[key] = row
        elif isinstance(row, dict):
            out[key] = FaceProps(
                area_m2=row.get("area_m2"),
                normal=tuple(row["normal"]) if row.get("normal") else None,
                centroid=tuple(row["centroid"]) if row.get("centroid") else None,
            )
    return out


def convergence_stops_off(spec: Any) -> bool:
    """A run continued past its convergence (RunInputs.restart ``stops_off``): its case
    is written without the stops that ended it (the residual targets' residualControl
    and the settle stop's runTimeControl), so it runs every iteration or to its new end."""
    restart = getattr(spec, "restart", None)
    return bool(isinstance(restart, dict) and restart.get("stops_off"))


def load_run_spec(inputs: Any) -> RunSpec:
    """Build a RunSpec from the core's RunInputs for this run."""
    root = Path(inputs.project_dir)
    sim_id = inputs.simulation_id
    mats = inputs.materials if isinstance(inputs.materials, dict) else {}
    bcs_doc = inputs.bcs_doc if isinstance(inputs.bcs_doc, dict) else {}
    aa = inputs.result_controls if isinstance(inputs.result_controls, dict) else {}
    ctrl = inputs.simulation_control if isinstance(inputs.simulation_control, dict) else {}

    air = air_from_materials(mats, sim_id)
    records = [b for b in list_bc_records(bcs_doc) if matches_study(b, sim_id, None)]

    mesh = inputs.mesh or {}
    if not mesh.get("ok") and inputs.require_mesh:
        return RunSpec(
            project_dir=root,
            run_id=inputs.run_id,
            mesh_case_dir=Path("."),
            n_procs=inputs.n_procs,
            solver_app="simpleFoam",
            end_time=float(ctrl.get("endTime") or STEADY_DEFAULTS["end_time"]),
            write_interval=float(ctrl.get("writeInterval") or STEADY_DEFAULTS["write_interval"]),
            transient=None,
            nu=(air or {}).get("nu", LEGACY_AIR["nu"]),
            rho=(air or {}).get("rho", LEGACY_AIR["rho"]),
            wall_default=wall_treatment(bcs_doc.get("defaults")),
            bcs=[],
            monitor_patches=[],
            face_props={},
            ok=False,
            error=str(mesh.get("error") or "mesh not ready"),
        )

    patch_names = set(mesh.get("patches") or [])
    # When no mesh is required / it has no patches, name them from the BCs (unit tests).
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

    from .function_objects import monitor_patches_from_mapped

    mon = monitor_patches_from_mapped(mapped, aa_faces=list_aa_faces(aa), patch_names=list(patch_names))

    td: Literal["steady", "transient"] = "transient" if inputs.time_dependency == "transient" else "steady"
    end_time = float(ctrl.get("endTime") or STEADY_DEFAULTS["end_time"])
    write_interval = float(ctrl.get("writeInterval") or STEADY_DEFAULTS["write_interval"])
    case_dir = mesh.get("case_dir") or root
    if not isinstance(case_dir, Path):
        case_dir = Path(case_dir)

    spec = RunSpec(
        project_dir=root,
        run_id=inputs.run_id,
        mesh_case_dir=case_dir,
        n_procs=int(inputs.n_procs),
        solver_app=inputs.solver_key,
        end_time=end_time,
        write_interval=write_interval,
        transient=None,
        nu=float((air or {}).get("nu", LEGACY_AIR["nu"])),
        rho=float((air or {}).get("rho", LEGACY_AIR["rho"])),
        wall_default=wall_treatment(bcs_doc.get("defaults")),
        bcs=web_bcs,
        monitor_patches=mon,
        face_props=_face_props(inputs.face_props),
        mesh_id=mesh.get("mesh_id"),
        simulation_id=sim_id,
        n_cells=mesh.get("n_cells"),
        patches=list(patch_names),
        speed_for_k=1.0,
        aa=aa,
        mapped=mapped,
        physics=physics_from_record(inputs.study or None),
        custom_monitors=custom_monitors((inputs.run or {}).get("result_controls")),
        reference=reference_record(inputs.study or None),
        forces_monitors=forces_monitor_records((inputs.run or {}).get("result_controls")),
        probe_monitors=probe_monitor_records((inputs.run or {}).get("result_controls")),
        result_controls=[r for r in (inputs.run or {}).get("result_controls") or [] if isinstance(r, dict)],
        settle=clean_settle((inputs.run or {}).get("settle"), transient=td == "transient"),
        analysis_key=inputs.analysis_key,
        time_dependency=td,
        ok=True,
        error=None,
    )
    restart = getattr(inputs, "restart", None)
    if restart:
        # Continued: to the new end, saving as the run did.
        spec = replace(
            spec,
            restart=dict(restart),
            end_time=float(restart["end_time"]),
            write_interval=float(restart.get("write_interval") or spec.write_interval),
        )
    if td != "transient":
        return spec
    raw = inputs.transient_override if inputs.transient_override is not None else ctrl.get("transient")
    transient = resolve_transient_control(raw if isinstance(raw, dict) else {}, transient_context(spec))
    if restart:
        transient = replace(
            transient,
            end_time=float(restart["end_time"]),
            write_interval=float(restart.get("write_interval") or transient.write_interval),
        )
    return replace(spec, transient=transient, end_time=transient.end_time, write_interval=transient.write_interval)


def transient_context(spec: RunSpec) -> dict[str, Any]:
    """What the time-step estimate needs: the mesh this run solves on and the
    case's reference speed (the same speed the turbulence inlet values use)."""
    from .writer import resolve_speed_and_dhyd

    speed_ref, _d_hyd = resolve_speed_and_dhyd(spec)
    return {
        "mesh_meta": load_mesh_meta(spec.mesh_case_dir),
        "n_cells": spec.n_cells,
        "speed_ref": speed_ref,
    }
