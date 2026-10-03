"""Job tool ``incompressible_flow.write_run_case``: write one run's case (API 1.5).

    python incompressible_flow/jobs/write_run_case.py --run-id <id> [--mesh-id <id>]
        [--time-dependency Steady-state|Transient] [--n-procs N] [--transient <json>]

The prepare step of an Incompressible Flow run (its ``LaunchSpec.prepare_job``).
The host runs it on the core's Python with MAGNUSIM_PROJECT_DIR,
MAGNUSIM_SIMULATION_ID and MAGNUSIM_CASE_DIR set. It writes only into that run's
own case folder (``<project>/.../simulation_runs/<run>/case``, so the jobs API
cannot point it anywhere else), gathers the run's inputs through
``cfddesk.registry.run_case``, checks the run with this plugin's own
``validate_ready`` and writes the case with ``run_case.write_case`` (the
analysis's writer inside the ``case.write`` hooks, which stamps
``w27-case.json``). What it wrote is kept in ``w27-case.json`` as
``prepare_report``.

Stage lines (MAGNUSIM_EVENT): ``inputs``, ``mesh``, ``fields``, ``written``.
The last line is the answer as JSON. Exit codes: 0 written, 1 failed, 2 refused
(bad arguments, a case folder that is not the run's, another plugin's analysis),
3 not ready (the readiness message is printed first).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

PLUGIN_DIR = Path(__file__).resolve().parents[2]
if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))

from cfddesk.registry import run_case  # noqa: E402
from cfddesk.registry.discovery import get_registry, load_all  # noqa: E402
from magnusim_sdk.events import emit  # noqa: E402

from incompressible_flow.contract import validate_ready  # noqa: E402

# SPDX-License-Identifier: GPL-3.0-or-later

PLUGIN = "incompressible_flow"


def _answer(doc: dict[str, Any], code: int) -> int:
    print(json.dumps(doc, default=str), flush=True)
    return code


def _issues(raw: list[Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for issue in raw or []:
        if isinstance(issue, str):
            out.append({"message": issue, "fix": None})
        elif isinstance(issue, dict) and issue.get("message"):
            out.append({"fix": None, **issue})
    return out


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Write an Incompressible Flow run's case into MAGNUSIM_CASE_DIR.")
    p.add_argument("--run-id", required=True)
    p.add_argument("--mesh-id", default=None)
    p.add_argument("--time-dependency", default=None)
    p.add_argument("--n-procs", type=int, default=1)
    p.add_argument("--transient", default=None, help="The run's transient settings as JSON text")
    p.add_argument(
        "--require-mesh",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Require the run's generated mesh (default). --no-require-mesh is for fixture projects.",
    )
    args = p.parse_args(argv)

    project = os.environ.get("MAGNUSIM_PROJECT_DIR") or ""
    case = os.environ.get("MAGNUSIM_CASE_DIR") or ""
    problem = run_case.case_dir_problem(project, args.run_id, case)
    if problem:
        return _answer({"ok": False, "error": problem}, run_case.EXIT_REFUSED)
    try:
        transient = run_case.transient_arg(args.transient)
    except ValueError as exc:
        return _answer({"ok": False, "error": f"transient: {exc}"}, run_case.EXIT_REFUSED)
    simulation_id = os.environ.get("MAGNUSIM_SIMULATION_ID") or None
    mesh_id = args.mesh_id or None

    inputs = run_case.run_inputs(
        project,
        run_id=args.run_id,
        simulation_id=simulation_id,
        mesh_id=mesh_id,
        time_dependency=args.time_dependency,
        n_procs=args.n_procs,
        transient=transient,
        require_mesh=args.require_mesh,
    )
    emit("stage", stage="inputs")
    load_all()
    analyses = get_registry("analysis")
    key = str(inputs.analysis_key or "")
    if key not in set(analyses.keys()) or analyses.owner(key) != PLUGIN:
        return _answer(
            {"ok": False, "error": f"This run's analysis ({key or 'none'}) is not one of Incompressible Flow's."},
            run_case.EXIT_REFUSED,
        )

    if args.require_mesh:
        if not inputs.mesh.get("ok"):
            return _answer({"ok": False, "error": str(inputs.mesh.get("error") or "mesh not ready")}, run_case.EXIT_FAILED)
        emit("stage", stage="mesh")
        ctx = run_case.ready_context(project, simulation_id=simulation_id, run_id=args.run_id, mesh_id=mesh_id or "")
        issues = _issues(validate_ready(ctx))
        if issues:
            first = issues[0]
            print(first["message"], flush=True)
            out: dict[str, Any] = {
                "ok": False,
                "not_ready": True,
                "error": first["message"],
                "fix": first.get("fix"),
                "issues": issues,
            }
            if first.get("patches") is not None:
                out["patches"] = first["patches"]
            return _answer(out, run_case.EXIT_NOT_READY)
    else:
        emit("stage", stage="mesh")

    emit("stage", stage="fields")
    Path(case).mkdir(parents=True, exist_ok=True)
    result = run_case.write_case(inputs, case, analysis_key=key)
    if not result.get("ok"):
        return _answer({"ok": False, **result}, run_case.EXIT_FAILED)
    run_case.stamp_prepare_report(case, result)
    emit("stage", stage="written")
    return _answer(result, run_case.EXIT_OK)


if __name__ == "__main__":
    sys.exit(main())
