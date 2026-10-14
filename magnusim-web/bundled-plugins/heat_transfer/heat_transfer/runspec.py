"""What a Heat Transfer run's case is written from (``HtSpec``).

``load_spec(inputs)`` reads the core's ``RunInputs`` of one run: the study's
material records (one fluid in this version), its settings
(heat_transfer.physics), its BC records, the run's monitors, settle stop and
time control, and the mesh.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Literal

from magnusim_sdk.study import bc_faces, list_bc_records, matches_study

from .materials import (
    FLUID_MODEL,
    SOLID_MODEL,
    FluidProps,
    fluid_props,
    record_bodies,
    study_materials,
)
from .monitors import monitor_records
from .physics import StudyPhysics, physics_from_record
from .settle import clean_settle
from .transient import STEADY_DEFAULTS, TransientControl, resolve_transient


@dataclass
class HtSpec:
    project_dir: Path
    run_id: str
    simulation_id: str | None
    mesh_case_dir: Path
    mesh_id: str | None
    n_cells: int | None
    n_procs: int
    time_dependency: Literal["steady", "transient"]
    end_time: float
    write_interval: float
    transient: TransientControl | None
    physics: StudyPhysics
    fluid: FluidProps | None
    fluid_records: list[dict[str, Any]]
    solid_records: list[dict[str, Any]]
    records: list[dict[str, Any]]
    monitors: list[dict[str, Any]]
    settle: dict[str, Any] | None
    inputs: Any = None
    face_props: dict[str, Any] = field(default_factory=dict)
    restart: dict[str, Any] | None = None
    analysis_key: str = ""
    ok: bool = True
    error: str | None = None

    @property
    def density_model(self) -> str:
        return self.physics.density_for(self.fluid)


def _mesh_cell_size(case_dir: Path, n_cells: int | None) -> float | None:
    """The mean cell size (m): the mesh's volume over its cells (standard-meta / log.checkMesh)."""
    total = None
    try:
        txt = (case_dir / "log.checkMesh").read_text(encoding="utf-8", errors="replace")
    except OSError:
        txt = ""
    import re

    m = re.search(r"Total volume\s*=\s*([0-9.eE+-]+)", txt)
    if m:
        try:
            total = float(m.group(1))
        except ValueError:
            total = None
    if total is None:
        try:
            meta = json.loads((case_dir / "standard-meta.json").read_text(encoding="utf-8"))
            bb = meta.get("bbox") or meta.get("bounding_box") if isinstance(meta, dict) else None
            if isinstance(bb, dict) and isinstance(bb.get("size"), list):
                s = [float(x) for x in bb["size"]]
                total = s[0] * s[1] * s[2]
        except (OSError, ValueError, TypeError):
            total = None
    if not total or not n_cells or total <= 0:
        return None
    return (total / float(n_cells)) ** (1.0 / 3.0)


def load_spec(inputs: Any) -> HtSpec:
    """The spec of one run from the core's RunInputs."""
    root = Path(inputs.project_dir)
    sim_id = inputs.simulation_id
    ctrl = inputs.simulation_control if isinstance(inputs.simulation_control, dict) else {}
    bcs_doc = inputs.bcs_doc if isinstance(inputs.bcs_doc, dict) else {}
    mats = study_materials(inputs.materials, sim_id)
    fluids = [m for m in mats if m.get("material_model") == FLUID_MODEL and record_bodies(m)]
    solids = [m for m in mats if m.get("material_model") == SOLID_MODEL and record_bodies(m)]
    fluid = fluid_props(fluids[0]) if fluids else None
    records = [b for b in list_bc_records(bcs_doc) if matches_study(b, sim_id, None) and bc_faces(b)]
    mesh = inputs.mesh or {}
    case_dir = Path(mesh.get("case_dir") or root)
    run = inputs.run or {}
    td: Literal["steady", "transient"] = "transient" if inputs.time_dependency == "transient" else "steady"
    spec = HtSpec(
        project_dir=root,
        run_id=str(inputs.run_id),
        simulation_id=sim_id,
        mesh_case_dir=case_dir,
        mesh_id=mesh.get("mesh_id"),
        n_cells=mesh.get("n_cells"),
        n_procs=int(inputs.n_procs or 1),
        time_dependency=td,
        end_time=float(ctrl.get("endTime") or STEADY_DEFAULTS["end_time"]),
        write_interval=float(ctrl.get("writeInterval") or STEADY_DEFAULTS["write_interval"]),
        transient=None,
        physics=physics_from_record(inputs.study or None),
        fluid=fluid,
        fluid_records=fluids,
        solid_records=solids,
        records=records,
        monitors=monitor_records(run.get("result_controls")),
        settle=clean_settle(run.get("settle"), transient=td == "transient"),
        inputs=inputs,
        face_props=dict(inputs.face_props or {}),
        restart=dict(inputs.restart) if getattr(inputs, "restart", None) else None,
        analysis_key=str(inputs.analysis_key or ""),
    )
    if not mesh.get("ok") and inputs.require_mesh:
        return replace(spec, ok=False, error=str(mesh.get("error") or "mesh not ready"))
    if spec.restart:
        spec = replace(
            spec,
            end_time=float(spec.restart["end_time"]),
            write_interval=float(spec.restart.get("write_interval") or spec.write_interval),
        )
    if td != "transient":
        return spec
    raw = inputs.transient_override if inputs.transient_override is not None else ctrl.get("transient")
    speed = _speed_scale(spec)
    tc = resolve_transient(raw if isinstance(raw, dict) else {}, h_m=_mesh_cell_size(case_dir, spec.n_cells), speed=speed)
    if spec.restart:
        tc = replace(tc, end_time=float(spec.restart["end_time"]))
    return replace(spec, transient=tc, end_time=tc.end_time, write_interval=tc.write_interval)


def convergence_stops_off(spec: Any) -> bool:
    """A run continued past its convergence: written without the stops that ended it
    (residualControl and the settle stop)."""
    restart = getattr(spec, "restart", None)
    return bool(isinstance(restart, dict) and restart.get("stops_off"))


def _speed_scale(spec: HtSpec) -> float:
    """A speed for the first time step: the fastest inlet's, else a buoyant velocity
    sqrt(g β ΔT L) with ΔT from the boundary temperatures and L = 0.1 m, at least 0.05 m/s."""
    from .contract import boundary_temperatures

    best = 0.0
    for rec in spec.records:
        try:
            v = abs(float(rec.get("value")))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            continue
        unit = str(rec.get("unit") or "").lower()
        if unit in ("m/s", "") and "inlet" in str(rec.get("bc_type") or "").lower():
            best = max(best, v)
    g = math.hypot(*spec.physics.g())
    temps = [t for _name, t in boundary_temperatures(spec.records)]
    if g > 0 and temps and spec.fluid is not None:
        dt = max(abs(t - spec.physics.reference_temperature) for t in temps)
        beta = spec.fluid.beta if spec.density_model == "boussinesq" else 1.0 / spec.physics.reference_temperature
        best = max(best, math.sqrt(g * beta * dt * 0.1))
    return max(best, 0.05)
