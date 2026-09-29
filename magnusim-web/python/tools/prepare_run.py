#!/usr/bin/env python3
"""Prepare a complete OpenFOAM run case from web-format project JSON.

CLI: tools/prepare_run.py --project-dir ... --run-id ... --out-dir ...
The core gathers the run's inputs (cfddesk.project.run_inputs); the run's
analysis checks readiness and writes the case (analysis contract).
Prints one JSON line: {"ok":true,"case_dir":...,"solver":...,"n_procs":...,
"app":..., "time_dependency":..., "analysis_key":..., "transient_control":...}

``app`` is the solver the written case is for; Node launches exactly that.
``transient_control`` holds the resolved numbers written to controlDict (the
same numbers the Run panel preview shows), or null for a steady run.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

CFDDESK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CFDDESK_ROOT))

from cfddesk.project.run_inputs import gather_run_inputs
from cfddesk.registry.analysis import plan_run_case, write_run_case


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Write a complete OpenFOAM run case (Phase 1 prepare_run).")
    p.add_argument("--project-dir", required=True, type=Path)
    p.add_argument("--run-id", default="run-1")
    p.add_argument("--mesh-id", default=None)
    p.add_argument("--n-procs", type=int, default=1)
    p.add_argument("--out-dir", required=True, type=Path)
    p.add_argument("--simulation-id", default=None)
    p.add_argument("--transient-json", type=Path, default=None, help="Optional override JSON for transient control")
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
            print(json.dumps({"ok": False, "error": "transient-json must be an object"}), flush=True)
            return 2

    inputs = gather_run_inputs(
        args.project_dir,
        run_id=args.run_id,
        mesh_id=args.mesh_id,
        n_procs=args.n_procs,
        simulation_id=args.simulation_id,
        require_mesh=args.require_mesh,
        transient_override=transient_override,
        time_dependency=args.time_dependency,
    )
    if args.require_mesh and not inputs.mesh.get("ok"):
        print(json.dumps({"ok": False, "error": str(inputs.mesh.get("error") or "mesh not ready")}), flush=True)
        return 1

    from cfddesk.registry import contract
    from cfddesk.registry.discovery import get_registry

    analysis = get_registry("analysis").get(inputs.analysis_key)
    if args.require_mesh:
        # What blocks this run, as its analysis sees it (the core checked the
        # study and the mesh). Nothing is written when a run is not ready.
        from cfddesk.project.readiness import ready_context

        ctx = ready_context(
            args.project_dir,
            simulation_id=args.simulation_id,
            run_id=args.run_id,
            mesh_id=args.mesh_id or "",
        )
        issues = contract.validate_ready(analysis, ctx)
        if issues:
            first = issues[0]
            out = {"ok": False, "not_ready": True, "error": first["message"], "fix": first.get("fix"), "issues": issues}
            if first.get("patches") is not None:
                out["patches"] = first["patches"]
            print(json.dumps(out), flush=True)
            return 3
    launch = contract.launch_spec(analysis, get_registry("solver"), solver_key=inputs.solver_key)
    decision = {
        "app": launch.app,
        "launch": launch.to_json(),
        "time_dependency": "Transient" if inputs.time_dependency == "transient" else "Steady-state",
        "analysis_key": inputs.analysis_key,
    }
    if args.validate_only:
        planned = plan_run_case(inputs, analysis_key=inputs.analysis_key)
        print(json.dumps({**planned, **decision}), flush=True)
        return 0 if planned.get("ok") else 1

    result = write_run_case(inputs, args.out_dir, analysis_key=inputs.analysis_key)
    print(json.dumps({**result, **decision}), flush=True)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
