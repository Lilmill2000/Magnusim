"""A run's case (API 1.5): plan it, gather its inputs and write it.

The core's entry points for a run's case. They live in ``cfddesk.registry`` so
that an analysis plugin's own prepare job (``LaunchSpec.prepare_job``) reaches
them without importing the core's other packages:

- :func:`plan_run`: what a run would be written with (the analysis's plan,
  its launch spec and plugin), writing nothing. The ``analysis.plan_run`` RPC
  and ``prepare_run.py --validate-only`` answer with it.
- :func:`prepare_case`: gather, check and write: ``tools/prepare_run.py``, the
  builtin ``solve.prepare`` job (the case writer of an analysis that names no
  ``prepare_job``).
- :func:`run_inputs`, :func:`ready_context` and :func:`write_case`: the steps
  of :func:`prepare_case`, for a plugin's prepare job to call itself.
- :func:`case_dir_problem`: why a folder is not a run's own case folder (a
  prepare job refuses to write anywhere else).
- :func:`stamp_prepare_report`: what the prepare job wrote, kept in the case's
  ``w27-case.json`` as ``prepare_report``.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from cfddesk.registry import contract

# The keys prepare_run adds to the analysis's report (its plan, or what it wrote).
DECISION_KEYS: tuple[str, ...] = ("app", "launch", "time_dependency", "analysis_key")

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_REFUSED = 2  # bad arguments, or a case folder that is not the run's
EXIT_NOT_READY = 3


def run_inputs(
    project_dir: str | Path,
    *,
    run_id: str,
    simulation_id: str | None = None,
    mesh_id: str | None = None,
    time_dependency: str | None = None,
    n_procs: int = 1,
    transient: dict[str, Any] | None = None,
    require_mesh: bool = True,
    restart: dict[str, Any] | None = None,
) -> Any:
    """What the core gathers for a run (``RunInputs``): the study's documents,
    its mesh, the run's settings and the analysis it solves with.

    ``transient`` holds the run's transient settings (they win over the stored
    ones); ``time_dependency`` is the run's decision ("Steady-state" or
    "Transient"; None: the run's stamp, else its study's). ``restart``
    (:func:`restart_arg`) continues the run from its latest saved time: the
    case keeps its saved times, starts from the latest and runs to
    ``restart["end_time"]``.
    """
    from cfddesk.project.run_inputs import gather_run_inputs

    return gather_run_inputs(
        Path(project_dir),
        run_id=str(run_id),
        mesh_id=mesh_id or None,
        n_procs=int(n_procs),
        simulation_id=simulation_id or None,
        require_mesh=require_mesh,
        transient_override=transient,
        time_dependency=time_dependency or None,
        restart=restart,
    )


def ready_context(
    project_dir: str | Path,
    *,
    simulation_id: str | None,
    run_id: str = "",
    mesh_id: str | None = "",
) -> contract.ReadyContext:
    """What an analysis's ``validate_ready`` looks at for this run."""
    from cfddesk.project.readiness import ready_context as _ready_context

    return _ready_context(Path(project_dir), simulation_id=simulation_id or None, run_id=run_id, mesh_id=mesh_id or "")


def write_case(inputs: Any, out_dir: str | Path, *, analysis_key: str | None = None) -> dict[str, Any]:
    """Write the run's case into ``out_dir``: its analysis's ``write_case``,
    inside the ``case.write`` hooks, and the case's ``w27-case.json`` stamped
    (analysis key, frame fields, ...). Returns the analysis's report."""
    from cfddesk.registry.analysis import write_run_case

    return write_run_case(inputs, out_dir, analysis_key=analysis_key or getattr(inputs, "analysis_key", None))


def _decide(
    project_dir: Path,
    inputs: Any,
    *,
    simulation_id: str | None,
    run_id: str,
    mesh_id: str | None,
    require_mesh: bool,
) -> tuple[dict[str, Any] | None, Any, contract.LaunchSpec | None, dict[str, Any]]:
    """(failure, analysis, launch spec, decision): a failure answer when the run
    cannot be written, else the analysis and how it runs."""
    from cfddesk.registry.discovery import get_registry, load_all

    if require_mesh and not inputs.mesh.get("ok"):
        return {"ok": False, "error": str(inputs.mesh.get("error") or "mesh not ready")}, None, None, {}
    load_all()
    analyses = get_registry("analysis")
    key = str(inputs.analysis_key or "")
    if key not in set(analyses.keys()):
        return (
            {
                "ok": False,
                "error": f"This run's analysis ({key or 'none'}) is not available: its plugin is off or did not load.",
                "fix": {"go": "plugins"},
            },
            None,
            None,
            {},
        )
    analysis = analyses.get(key)
    if require_mesh:
        # What blocks this run, as its analysis sees it (the core checked the
        # study and the mesh). Nothing is written when a run is not ready.
        ctx = ready_context(project_dir, simulation_id=simulation_id, run_id=run_id, mesh_id=mesh_id or "")
        issues = contract.validate_ready(analysis, ctx)
        if issues:
            first = issues[0]
            out = {"ok": False, "not_ready": True, "error": first["message"], "fix": first.get("fix"), "issues": issues}
            if first.get("patches") is not None:
                out["patches"] = first["patches"]
            return out, None, None, {}
    try:
        launch = contract.launch_spec(analysis, get_registry("solver"), solver_key=inputs.solver_key)
    except contract.ContractError as exc:
        return {"ok": False, "error": f"{key}: {exc}"}, None, None, {}
    decision = {
        "app": launch.app,
        "launch": launch.to_json(),
        "time_dependency": "Transient" if inputs.time_dependency == "transient" else "Steady-state",
        "analysis_key": key,
    }
    return None, analysis, launch, decision


def plan_run(
    project_dir: str | Path,
    run_id: str,
    simulation_id: str | None = None,
    mesh_id: str | None = None,
    time_dependency: str | None = None,
    transient: dict[str, Any] | None = None,
    *,
    n_procs: int = 1,
    require_mesh: bool = True,
    restart: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """What the run would be written with, writing nothing.

    ``restart`` (:func:`restart_arg`) plans a run continued from its latest saved
    time, as its prepare job will write it (its new end; ``stops_off``).

    Ready: ``{ok, analysis_key, plugin, app, time_dependency, launch,
    prepare_job, serial_below_cells, plan}``, where ``plan`` is the analysis's
    ``plan_case`` report (the BC mapping, the wall default, the transient
    numbers, the run note's physics and algorithm, ...), ``prepare_job`` the
    JobKind that writes the case (the launch spec's, else ``solve.prepare``)
    and ``serial_below_cells`` the cell count under which the run is serial.
    Not ready: ``{ok: false, not_ready: true, error, fix, issues, patches?}``
    (what its analysis's ``validate_ready`` said first); otherwise
    ``{ok: false, error, fix?}``.
    """
    from cfddesk.registry.analysis import plan_run_case
    from cfddesk.registry.discovery import get_registry

    root = Path(project_dir)
    inputs = run_inputs(
        root,
        run_id=run_id,
        simulation_id=simulation_id,
        mesh_id=mesh_id,
        time_dependency=time_dependency,
        n_procs=n_procs,
        transient=transient,
        require_mesh=require_mesh,
        restart=restart,
    )
    failed, _analysis, launch, decision = _decide(
        root, inputs, simulation_id=simulation_id, run_id=run_id, mesh_id=mesh_id, require_mesh=require_mesh
    )
    if failed is not None or launch is None:
        return failed or {"ok": False, "error": "the run cannot be planned"}
    planned = plan_run_case(inputs, analysis_key=decision["analysis_key"])
    out: dict[str, Any] = {
        "ok": bool(planned.get("ok")),
        "analysis_key": decision["analysis_key"],
        "plugin": get_registry("analysis").owner(decision["analysis_key"]),
        "app": decision["app"],
        "time_dependency": decision["time_dependency"],
        "launch": decision["launch"],
        "prepare_job": contract.effective_prepare_job(launch),
        "serial_below_cells": contract.serial_below_cells(launch, inputs.time_dependency),
        "plan": planned,
    }
    if not out["ok"]:
        out["error"] = str(planned.get("error") or "the run is not ready")
    return out


def validate_only_answer(planned: dict[str, Any]) -> dict[str, Any]:
    """``prepare_run.py --validate-only``'s line from a :func:`plan_run` answer:
    the analysis's plan with the decision keys (app, launch, time dependency,
    analysis key) over it; a failure as it is."""
    if "plan" not in planned:
        return planned
    return {**planned["plan"], **{k: planned[k] for k in DECISION_KEYS}}


def prepare_case(
    project_dir: str | Path,
    run_id: str,
    out_dir: str | Path,
    simulation_id: str | None = None,
    mesh_id: str | None = None,
    time_dependency: str | None = None,
    transient: dict[str, Any] | None = None,
    *,
    n_procs: int = 1,
    require_mesh: bool = True,
    on_stage: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Gather the run's inputs, check it is ready and write its case into
    ``out_dir``: the analysis's report with the decision keys (app, launch,
    time dependency, analysis key) over it, or a failure as :func:`plan_run`
    gives it. ``on_stage`` is told ``inputs``, ``written``."""
    root = Path(project_dir)
    stage = on_stage or (lambda _name: None)
    inputs = run_inputs(
        root,
        run_id=run_id,
        simulation_id=simulation_id,
        mesh_id=mesh_id,
        time_dependency=time_dependency,
        n_procs=n_procs,
        transient=transient,
        require_mesh=require_mesh,
    )
    stage("inputs")
    failed, _analysis, _launch, decision = _decide(
        root, inputs, simulation_id=simulation_id, run_id=run_id, mesh_id=mesh_id, require_mesh=require_mesh
    )
    if failed is not None:
        return failed
    result = write_case(inputs, out_dir, analysis_key=decision["analysis_key"])
    stage("written")
    return {**result, **decision}


def exit_code(answer: dict[str, Any]) -> int:
    """A prepare tool's exit code for an answer: 0 written, 3 not ready, else 1."""
    if answer.get("not_ready"):
        return EXIT_NOT_READY
    return EXIT_OK if answer.get("ok") else EXIT_FAILED


def _run_identity(run_dir: Path) -> str:
    """The run id a run folder holds: its ``id.json`` id, else its ``run.json`` id or run_id."""

    def read(name: str) -> dict[str, Any]:
        try:
            doc = json.loads((run_dir / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return doc if isinstance(doc, dict) else {}

    ident = read("id.json")
    if ident.get("id"):
        return str(ident["id"])
    run = read("run.json")
    return str(run.get("id") or run.get("run_id") or "")


def case_dir_problem(project_dir: str | Path | None, run_id: str | None, case_dir: str | Path | None) -> str | None:
    """Why ``case_dir`` is not the case folder of run ``run_id`` of the project
    in ``project_dir``; None when it is.

    A run's case folder is ``<run folder>/case``, and its run folder is a folder
    in a ``simulation_runs`` folder inside the project whose ``id.json`` (else
    ``run.json``) names the run. Links are resolved first.
    """
    if not str(project_dir or "").strip():
        return "The project folder is not given (MAGNUSIM_PROJECT_DIR)."
    if not str(case_dir or "").strip():
        return "The case folder is not given (MAGNUSIM_CASE_DIR)."
    if not str(run_id or "").strip():
        return "The run is not given."
    root = Path(os.path.realpath(str(project_dir)))
    case = Path(os.path.realpath(str(case_dir)))
    if case.name != "case" or case.parent.parent.name != "simulation_runs":
        return f"{case_dir} is not a run's case folder (simulation_runs/<run>/case)."
    if not root.is_dir() or case == root or not case.is_relative_to(root):
        return f"{case_dir} is not inside the project folder."
    if _run_identity(case.parent) != str(run_id):
        return f"{case_dir} is not the case folder of run {run_id}."
    return None


def stamp_prepare_report(case_dir: str | Path, report: dict[str, Any]) -> None:
    """Keep what the prepare job wrote (its report) in the case's ``w27-case.json`` as ``prepare_report``."""
    sidecar = Path(case_dir) / "w27-case.json"
    doc: dict[str, Any] = {}
    if sidecar.is_file():
        try:
            loaded = json.loads(sidecar.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            loaded = {}
        if isinstance(loaded, dict):
            doc = loaded
    doc["prepare_report"] = json.loads(json.dumps(report, default=str))
    sidecar.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")


def transient_arg(text: str | None) -> dict[str, Any] | None:
    """A prepare job's ``--transient`` value (JSON text): the run's transient
    settings, or None when empty. Raises ValueError when it is not a JSON object."""
    raw = str(text or "").strip()
    if not raw:
        return None
    value = json.loads(raw)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("--transient must be a JSON object")
    return value


def restart_arg(text: str | None) -> dict[str, Any] | None:
    """A prepare job's ``--restart`` value (JSON text): ``{"end_time", "write_interval"?,
    "stops_off"?}`` for a run continued from its latest saved time (``end_time`` the new
    end, in the run's time unit; ``write_interval`` how often it saves, None to keep the
    run's; ``stops_off`` true: it continues past its convergence, written without the
    stops that ended it), or None when empty. Raises ValueError for anything else."""
    import math

    raw = str(text or "").strip()
    if not raw:
        return None
    value = json.loads(raw)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("--restart must be a JSON object")

    def positive(key: str) -> float | None:
        v = value.get(key)
        if v is None:
            return None
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v <= 0:
            raise ValueError(f"--restart {key} must be a number above 0")
        return float(v)

    end = positive("end_time")
    if end is None:
        raise ValueError("--restart needs end_time")
    stops_off = value.get("stops_off", False)
    if not isinstance(stops_off, bool):
        raise ValueError("--restart stops_off must be true or false")
    out: dict[str, Any] = {"end_time": end, "write_interval": positive("write_interval")}
    if stops_off:
        out["stops_off"] = True
    return out
