"""What the core gathers for a run before its analysis writes the case.

The core reads the project (study, materials, boundary conditions, result
controls, run control, mesh, face properties, the run record) and decides the
run's time dependency and analysis. The analysis turns these plain records
into its own case (``AnalysisType.write_case``); it never reads project files
itself.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal


@dataclass(frozen=True)
class RunInputs:
    project_dir: Path
    run_id: str
    simulation_id: str | None
    mesh_id: str | None
    n_procs: int
    require_mesh: bool
    time_dependency: Literal["steady", "transient"]
    analysis_key: str
    solver_key: str
    materials: dict[str, Any] = field(default_factory=dict)
    bcs_doc: dict[str, Any] = field(default_factory=dict)
    result_controls: dict[str, Any] = field(default_factory=dict)
    simulation_control: dict[str, Any] = field(default_factory=dict)
    mesh: dict[str, Any] = field(default_factory=dict)
    face_props: dict[str, dict[str, Any]] = field(default_factory=dict)
    study: dict[str, Any] = field(default_factory=dict)
    run: dict[str, Any] = field(default_factory=dict)
    transient_override: dict[str, Any] | None = None


def gather_run_inputs(
    project_dir: str | Path,
    *,
    run_id: str = "run-1",
    mesh_id: str | None = None,
    n_procs: int = 1,
    simulation_id: str | None = None,
    require_mesh: bool = True,
    transient_override: dict | None = None,
    time_dependency: str | None = None,
) -> RunInputs:
    """Everything a run's analysis needs, read from the project folder.

    ``time_dependency`` is the decision the caller already made (Node passes
    the run's). Without it: transient when transient settings are given, else
    the run's stamp, else its study's.
    """
    from cfddesk.project.paths import (
        assemble_study_bc_defaults,
        assemble_study_bcs,
        find_run,
        study_json_path,
    )
    from cfddesk.project.readiness import study_doc
    from cfddesk.project.web_adapter import (
        _active_sim_id,
        _analysis_and_app,
        _read_json,
        _td,
        load_face_props,
        resolve_mesh,
        run_time_dependency,
    )

    root = Path(project_dir)
    sim_id = _active_sim_id(root, simulation_id)

    def _study_or_root(name: str) -> dict:
        path = study_json_path(root, sim_id, name) if sim_id else None
        if path is not None:
            data = _read_json(path)
            if isinstance(data, dict):
                return data
        data = _read_json(root / name)
        return data if isinstance(data, dict) else {}

    assembled = assemble_study_bcs(root, sim_id)
    leftover = _study_or_root("boundary_conditions.json") if not assembled else {}
    bcs_doc = {
        **leftover,
        "boundary_conditions": assembled or leftover.get("boundary_conditions") or [],
        "defaults": assemble_study_bc_defaults(root, sim_id),
    }
    aa = _study_or_root("result_controls.json") or _study_or_root("area_average.json")

    if time_dependency:
        td = _td(time_dependency)
    elif transient_override is not None:
        td = "transient"
    else:
        td = run_time_dependency(root, run_id, sim_id)
    analysis_key, solver_key = _analysis_and_app(root, sim_id, td)

    try:
        run = find_run(root, run_id, sim_id) or {}
    except Exception:
        run = {}
    return RunInputs(
        project_dir=root,
        run_id=run_id,
        simulation_id=sim_id,
        mesh_id=mesh_id,
        n_procs=int(n_procs),
        require_mesh=require_mesh,
        time_dependency=td,
        analysis_key=analysis_key,
        solver_key=solver_key,
        materials=_study_or_root("materials.json"),
        bcs_doc=bcs_doc,
        result_controls=aa if isinstance(aa, dict) else {},
        simulation_control=_study_or_root("simulation_control.json"),
        mesh=resolve_mesh(root, mesh_id=mesh_id, simulation_id=sim_id, require_poly=require_mesh),
        face_props=load_face_props(root),
        study=study_doc(root, sim_id),
        run={k: v for k, v in dict(run).items() if k != "dir"},
        transient_override=transient_override,
    )
