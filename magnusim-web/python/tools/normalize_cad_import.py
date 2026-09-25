#!/usr/bin/env python3
"""Turn IGES / BREP / STL / OBJ / PLY (or STEP) into geometry/source.step."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from cfddesk.cad.io import load_cad, write_geometry  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Normalize CAD/mesh files to STEP")
    ap.add_argument("--in", dest="src", type=Path, required=True)
    ap.add_argument("--out", dest="dest", type=Path, required=True)
    ap.add_argument("--unit", default="MM", help="Length unit of mesh coordinates (MM, CM, M, INCH)")
    args = ap.parse_args(argv)

    if not args.src.is_file():
        print(json.dumps({"ok": False, "error": f"missing input: {args.src}"}))
        return 2
    try:
        loaded = load_cad(args.src, length_unit=args.unit)
        defer = write_geometry(loaded, args.dest)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1
    payload = {"ok": True, "step_path": str(args.dest), "step_deferred": defer, **loaded.summary()}
    print("CAD_NORMALIZE_OK", json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main() or 0)
