#!/usr/bin/env python3
"""Graceful or force stop of a WSL solve (Phase 1 Step 5)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

CFDDESK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CFDDESK_ROOT))

from cfddesk.wsl.solve_run import kill_solve, stop_solve


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Stop a running cfddesk WSL solve.")
    p.add_argument("--wsl-case", required=True)
    p.add_argument("--run-id", default=None)
    p.add_argument("--force", action="store_true", help="Skip writeNow; kill immediately")
    args = p.parse_args(argv)
    try:
        if args.force:
            kill_solve(args.wsl_case, args.run_id)
        else:
            stop_solve(args.wsl_case, graceful=True)
        print(json.dumps({"ok": True, "wsl_case": args.wsl_case, "forced": bool(args.force)}), flush=True)
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
