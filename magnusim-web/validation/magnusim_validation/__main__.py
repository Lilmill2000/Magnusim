"""python -m magnusim_validation (run from magnusim-web/validation, with the app's Python):

    list                                    the cases and their variants, as JSON
    plan <case> <variant> [--out DIR] [--coarse] [--cores N] [--mesh-only] [--mesh-settings JSON]
         [--study-settings JSON]            geometry.step and plan.json for one run (a mesh-only
                                            run or changed settings: results-probe/)
    evaluate <run dir> [--failed WHY]       result.json from the driver's raw answers
    report [--check]                        VALIDATION.md and the public page (docs/validation/)
                                            from the committed results; --check exits 1 when
                                            either is not what the results give, and both exit
                                            1 when a locked value fails its band (locks.py)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .paths import bootstrap, results_root


def _run_dir(case_id: str, variant: str, coarse: bool, probe: bool = False) -> Path:
    return results_root(coarse=coarse, probe=probe) / case_id / variant


def main(argv: list[str] | None = None) -> int:
    bootstrap()
    from . import cases

    p = argparse.ArgumentParser(prog="magnusim_validation", description=__doc__.split("\n\n", 1)[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    pp = sub.add_parser("plan")
    pp.add_argument("case")
    pp.add_argument("variant")
    pp.add_argument("--out", type=Path)
    pp.add_argument("--coarse", action="store_true")
    pp.add_argument("--cores", type=int, default=4)
    pp.add_argument("--mesh-only", action="store_true")
    pp.add_argument("--mesh-settings", default="", help="JSON merged into the case's mesh settings (a probe)")
    pp.add_argument("--study-settings", default="", help="JSON merged into the case's study settings (a probe)")
    pe = sub.add_parser("evaluate")
    pe.add_argument("dir", type=Path)
    pe.add_argument("--failed", default="")
    pr = sub.add_parser("report")
    pr.add_argument("--check", action="store_true")
    args = p.parse_args(argv)

    if args.cmd == "list":
        out = [{"case": m.ID, "title": m.TITLE, "variants": list(m.VARIANTS)} for m in cases.CASES.values()]
        print(json.dumps(out))
        return 0
    if args.cmd == "plan":
        from .plan import make_plan

        case = cases.get(args.case)
        over = json.loads(args.mesh_settings) if args.mesh_settings else None
        study_over = json.loads(args.study_settings) if args.study_settings else None
        for name, v in (("--mesh-settings", over), ("--study-settings", study_over)):
            if v is not None and not isinstance(v, dict):
                p.error(f"{name} takes a JSON object")
        probe = args.mesh_only or bool(over) or bool(study_over)
        out_dir = args.out or _run_dir(case.ID, args.variant, args.coarse, probe)
        plan = make_plan(case, args.variant, out_dir, coarse=args.coarse, cores=args.cores, mesh_settings=over,
                         study_settings=study_over)
        est = (plan.get("mesh") or {}).get("estimate") or {}
        print(json.dumps({"ok": True, "dir": str(out_dir), "case": plan["case"], "variant": plan["variant"],
                          "estimate_cells": est.get("n_cells"), "estimate_warnings": est.get("warnings") or []}))
        return 0
    if args.cmd == "evaluate":
        from .evaluate import evaluate_dir

        doc = evaluate_dir(args.dir, failed=args.failed)
        print(json.dumps({"ok": True, "status": doc["status"], "status_detail": doc.get("status_detail", ""),
                          "result": str(args.dir / "result.json")}))
        return 0
    if args.cmd == "report":
        from .report import build_all

        return build_all(check=args.check)
    return 2


if __name__ == "__main__":
    sys.exit(main())
