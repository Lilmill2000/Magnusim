#!/usr/bin/env python3
"""Prepare a complete OpenFOAM run case from web-format project JSON.

CLI: tools/prepare_run.py --project-dir ... --run-id ... --out-dir ...
A thin command line over cfddesk.registry.run_case: the core gathers the run's
inputs (cfddesk.project.run_inputs); the run's analysis checks readiness and
writes the case (analysis contract).
Prints one JSON line: {"ok":true,"case_dir":...,"solver":...,"n_procs":...,
"app":..., "time_dependency":..., "analysis_key":..., "transient_control":...}

``app`` is the solver the written case is for; Node launches exactly that.
``transient_control`` holds the resolved numbers written to controlDict (the
same numbers the Run panel preview shows), or null for a steady run.

It is also the builtin JobKind ``solve.prepare`` (API 1.5): the prepare step of
a core solve whose analysis names no ``LaunchSpec.prepare_job``. Run so, it is
given the run's params (``--run-id``, ``--mesh-id``, ``--simulation-id``,
``--time-dependency``, ``--n-procs``, ``--transient <json>``) and reads the
project and case folders from MAGNUSIM_PROJECT_DIR and MAGNUSIM_CASE_DIR; it
writes only into the run's own case folder, prints stage lines (``inputs``,
``written``) and keeps its report in the case's ``w27-case.json``.
Exit codes: 0 written (or planned), 1 failed, 2 bad arguments, 3 not ready.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

CFDDESK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CFDDESK_ROOT))

from cfddesk.registry import run_case


def _stage(name: str) -> None:
    print("MAGNUSIM_EVENT " + json.dumps({"event": "stage", "stage": name}), flush=True)


def _fail(error: str, code: int = run_case.EXIT_REFUSED) -> int:
    print(json.dumps({"ok": False, "error": error}), flush=True)
    return code


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Write a complete OpenFOAM run case (Phase 1 prepare_run).")
    p.add_argument(
        "--project-dir",
        type=Path,
        default=None,
        help="The project folder (default: MAGNUSIM_PROJECT_DIR, as the solve.prepare job is run).",
    )
    p.add_argument("--run-id", default="run-1")
    p.add_argument("--mesh-id", default=None)
    p.add_argument("--n-procs", type=int, default=1)
    p.add_argument(
        "--out-dir",
        type=Path,
        default=None,
        help="Where to write the case (default: MAGNUSIM_CASE_DIR, which must be the run's own case folder).",
    )
    p.add_argument("--simulation-id", default=None)
    p.add_argument("--transient-json", type=Path, default=None, help="Optional override JSON for transient control")
    p.add_argument("--transient", default=None, help="The run's transient settings as JSON text (the job's param)")
    p.add_argument(
        "--time-dependency",
        default=None,
        help="Steady-state or Transient: the run's decision (Node passes it). Default: the run's, else its study's.",
    )
    p.add_argument(
        "--require-mesh",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Require live polyMesh (default true). Use --no-require-mesh for fixture/golden runs.",
    )
    p.add_argument("--validate-only", action="store_true", help="Load RunSpec and print JSON; do not write.")
    args = p.parse_args(argv)

    transient_override = None
    if args.transient_json is not None:
        transient_override = json.loads(Path(args.transient_json).read_text(encoding="utf-8"))
        if not isinstance(transient_override, dict):
            return _fail("transient-json must be an object")
    elif args.transient is not None:
        try:
            transient_override = run_case.transient_arg(args.transient)
        except ValueError as exc:
            return _fail(f"transient: {exc}")

    project_text = str(args.project_dir or os.environ.get("MAGNUSIM_PROJECT_DIR") or "").strip()
    if not project_text:
        return _fail("--project-dir is required (or MAGNUSIM_PROJECT_DIR)")
    project_dir = Path(project_text)
    simulation_id = args.simulation_id or os.environ.get("MAGNUSIM_SIMULATION_ID") or None
    common = {
        "simulation_id": simulation_id,
        "mesh_id": args.mesh_id,
        "time_dependency": args.time_dependency,
        "transient": transient_override,
        "n_procs": args.n_procs,
        "require_mesh": args.require_mesh,
    }

    if args.validate_only:
        planned = run_case.plan_run(project_dir, args.run_id, **common)
        answer = run_case.validate_only_answer(planned)
        print(json.dumps(answer), flush=True)
        return run_case.exit_code(answer)

    # Run as the solve.prepare job: only into the run's own case folder.
    as_job = args.out_dir is None
    out_dir = args.out_dir
    if as_job:
        case_env = os.environ.get("MAGNUSIM_CASE_DIR") or ""
        problem = run_case.case_dir_problem(project_dir, args.run_id, case_env)
        if problem:
            return _fail(problem)
        out_dir = Path(case_env)
        out_dir.mkdir(parents=True, exist_ok=True)
    assert out_dir is not None
    result = run_case.prepare_case(project_dir, args.run_id, out_dir, on_stage=_stage if as_job else None, **common)
    if as_job and result.get("ok"):
        run_case.stamp_prepare_report(out_dir, result)
    print(json.dumps(result), flush=True)
    return run_case.exit_code(result)


if __name__ == "__main__":
    raise SystemExit(main())
