#!/usr/bin/env python3
"""Probe or end the processes of one WSL case copy (cfddesk.wsl.case_procs).

CLI:
  tools/wsl_case_procs.py probe --wsl-case <id> [--script <name> ...]
      -> {"ok": true, "live": bool}
  tools/wsl_case_procs.py kill --wsl-case <id> [--script <name> ...] [--names a,b]
      -> {"ok": true, "killed": n}

``{"ok": false}`` when WSL did not answer (Node reads it as "unknown"); an id
``start_solve`` would refuse answers ``{"ok": true, "live": false, "invalid_id": true}``.
The case root comes from MAGNUSIM_WSL_CASE_ROOT (Node always passes it), else
the configured one; a root that fails the root rule answers ``{"ok": false}``.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

CFDDESK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CFDDESK_ROOT))

from cfddesk.wsl import case_procs


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Probe or end the processes of one WSL case copy.")
    p.add_argument("mode", choices=("probe", "kill"))
    p.add_argument("--wsl-case", required=True)
    p.add_argument("--script", action="append", default=[], help="A run script name (repeatable)")
    p.add_argument("--names", default="", help="kill: only processes with these names (comma list)")
    args = p.parse_args(argv)
    names = [n.strip() for n in args.names.split(",") if n.strip()]
    try:
        if args.mode == "probe":
            doc = case_procs.probe(args.wsl_case, args.script)
        else:
            doc = case_procs.kill(args.wsl_case, args.script, names=names or None)
    except Exception as exc:
        doc = {"ok": False, "error": str(exc)}
    print(json.dumps(doc), flush=True)
    return 0 if doc.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
