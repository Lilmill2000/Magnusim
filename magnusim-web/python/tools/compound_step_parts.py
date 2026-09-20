#!/usr/bin/env python3
"""Compound already-normalized part STEP files into geometry/source.step."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from cfddesk.cad.io import compound_step_files, write_step  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Compound part STEPs into one assembly STEP")
    ap.add_argument("--out", dest="dest", type=Path, required=True)
    ap.add_argument("--part", dest="parts", type=Path, action="append", required=True)
    args = ap.parse_args(argv)

    missing = [str(p) for p in args.parts if not p.is_file()]
    if missing:
        print(json.dumps({"ok": False, "error": "missing part STEP", "paths": missing}))
        return 2
    try:
        loaded = compound_step_files(args.parts)
        write_step(loaded.shape, args.dest, length_unit="MM")
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1
    payload = {
        "ok": True,
        "step_path": str(args.dest),
        "n_parts": len(args.parts),
        **loaded.summary(),
    }
    print("CAD_COMPOUND_OK", json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main() or 0)
