#!/usr/bin/env python3
"""Remove finished WSL scratch cases (the server runs this in the background).

CLI: tools/prune_wsl_cases.py [--max-age-hours H] [--dry-run]
Prints one JSON line: {"ok", "removed", "freed_kb", "kept_recent", "kept_busy", ...}.
What is kept: cfddesk/runner/cleanup.py and cfddesk/wsl/templates/prune_cases.sh.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

CFDDESK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CFDDESK_ROOT))

from cfddesk.runner.cleanup import DEFAULT_MAX_AGE_HOURS, prune_wsl_cases


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Remove finished Magnusim cases under the WSL case root.")
    p.add_argument(
        "--max-age-hours",
        type=float,
        default=DEFAULT_MAX_AGE_HOURS,
        help="Keep a case changed within this many hours (default %(default)s)",
    )
    p.add_argument("--dry-run", action="store_true", help="Only count what would be removed")
    args = p.parse_args(argv)
    if args.max_age_hours < 0:
        print(json.dumps({"ok": False, "error": "--max-age-hours must be >= 0"}), flush=True)
        return 2
    doc = prune_wsl_cases(max_age_hours=args.max_age_hours, dry_run=args.dry_run)
    print(json.dumps(doc, separators=(",", ":")), flush=True)
    return 0 if doc.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
