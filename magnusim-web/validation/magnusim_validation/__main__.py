"""python -m magnusim_validation (run from magnusim-web/validation, with the app's Python):

    list                                    the cases and their variants, as JSON
    plan <case> <variant> [--out DIR] [--coarse] [--cores N]
                                            geometry.step and plan.json for one run
    evaluate <run dir> [--failed WHY]       result.json from the driver's raw answers
    report [--check]                        VALIDATION.md and the public page (docs/validation/)
                                            from the committed results; --check exits 1 when
                                            either is not what the results give
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .paths import RESULTS, RESULTS_COARSE, bootstrap


def _run_dir(case_id: str, variant: str, coarse: bool) -> Path:
    return (RESULTS_COARSE if coarse else RESULTS) / case_id / variant


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
        out_dir = args.out or _run_dir(case.ID, args.variant, args.coarse)
        plan = make_plan(case, args.variant, out_dir, coarse=args.coarse, cores=args.cores)
        print(json.dumps({"ok": True, "dir": str(out_dir), "case": plan["case"], "variant": plan["variant"]}))
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
