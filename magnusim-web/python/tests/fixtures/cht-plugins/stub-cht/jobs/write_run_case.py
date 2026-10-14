"""Job tool ``stub-cht.write_run_case``: write one run's case (a test analysis).

    python jobs/write_run_case.py --run-id <id> [--mesh-id <id>] [--n-procs N] [--restart <json>]

The prepare step of a stub conjugate heat transfer run (its ``LaunchSpec.prepare_job``),
on the core's Python with MAGNUSIM_PROJECT_DIR, MAGNUSIM_SIMULATION_ID and
MAGNUSIM_CASE_DIR set: it gathers the run's inputs through
``cfddesk.registry.run_case`` and writes the case with ``run_case.write_case``.
``--restart {"end_time", ...}`` continues the run from its latest saved time (the
case keeps its saved times; see plugin.write_case). The last line is the answer as
JSON. Exit codes: 0 written, 1 failed, 2 refused.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

from cfddesk.registry import run_case


def _answer(doc: dict[str, Any], code: int) -> int:
    print(json.dumps(doc, default=str), flush=True)
    return code


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Write a stub CHT run's case into MAGNUSIM_CASE_DIR.")
    p.add_argument("--run-id", required=True)
    p.add_argument("--mesh-id", default=None)
    p.add_argument("--n-procs", type=int, default=1)
    p.add_argument("--restart", default=None)
    args = p.parse_args(argv)
    project = os.environ.get("MAGNUSIM_PROJECT_DIR") or ""
    case = os.environ.get("MAGNUSIM_CASE_DIR") or ""
    problem = run_case.case_dir_problem(project, args.run_id, case)
    if problem:
        return _answer({"ok": False, "error": problem}, run_case.EXIT_REFUSED)
    try:
        restart = run_case.restart_arg(args.restart)
    except ValueError as exc:
        return _answer({"ok": False, "error": f"restart: {exc}"}, run_case.EXIT_REFUSED)
    inputs = run_case.run_inputs(
        project,
        run_id=args.run_id,
        simulation_id=os.environ.get("MAGNUSIM_SIMULATION_ID") or None,
        mesh_id=args.mesh_id or None,
        n_procs=args.n_procs,
        restart=restart,
    )
    if not inputs.mesh.get("ok"):
        return _answer({"ok": False, "error": str(inputs.mesh.get("error") or "mesh not ready")}, run_case.EXIT_FAILED)
    result = run_case.write_case(inputs, case, analysis_key=str(inputs.analysis_key or ""))
    if not result.get("ok"):
        return _answer({"ok": False, **result}, run_case.EXIT_FAILED)
    run_case.stamp_prepare_report(case, result)
    return _answer(result, run_case.EXIT_OK)


if __name__ == "__main__":
    sys.exit(main())
