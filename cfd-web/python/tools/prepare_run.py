#!/usr/bin/env python3
"""Prepare a complete OpenFOAM run case from web-format project JSON.

CLI: tools/prepare_run.py --project-dir ... --run-id ... --out-dir ...
Uses cfddesk.project.web_adapter + AnalysisType.write_case (write_run_case).
Prints one JSON line: {"ok":true,"case_dir":...,"solver":...,"n_procs":...}
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

CFDDESK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CFDDESK_ROOT))

from cfddesk.project.web_adapter import load_run_spec
from cfddesk.registry.analysis import write_run_case


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

    spec = load_run_spec(
        args.project_dir,
        run_id=args.run_id,
        mesh_id=args.mesh_id,
        n_procs=args.n_procs,
        simulation_id=args.simulation_id,
        require_mesh=args.require_mesh,
        transient_override=transient_override,
    )
    if not spec.ok:
        print(json.dumps({"ok": False, "error": spec.error or "load_run_spec failed"}), flush=True)
        return 1

    if args.validate_only:
        print(
            json.dumps(
                {
                    "ok": True,
                    "run_id": spec.run_id,
                    "solver": spec.solver_app,
                    "n_procs": spec.n_procs,
                    "end_time": spec.end_time,
                    "write_interval": spec.write_interval,
                    "nu": spec.nu,
                    "rho": spec.rho,
                    "monitor_patches": spec.monitor_patches,
                    "patches": spec.patches,
                    "transient": spec.transient is not None,
                }
            ),
            flush=True,
        )
        return 0

    result = write_run_case(spec, args.out_dir)
    print(json.dumps(result), flush=True)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
