#!/usr/bin/env python3
"""Kill generate_* processes a server left running in its projects folder.

Only generators for projects under ``--projects-root``: other servers (the
user's app, e2e hosts on their own roots) and tests mesh on the same machine.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

CFDDESK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CFDDESK_ROOT))

from cfddesk.mesh.generate_guard import reap_generators_under_root


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--projects-root", required=True, help="the server's projects folder")
    p.add_argument(
        "--spare-descendants-of",
        type=int,
        default=None,
        help="the server's pid: generators it started itself are its own work",
    )
    args = p.parse_args(argv)
    killed = reap_generators_under_root(args.projects_root, spare_descendants_of=args.spare_descendants_of)
    print(json.dumps({"ok": True, "projects_root": args.projects_root, "killed": killed}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
