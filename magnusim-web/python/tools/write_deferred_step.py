#!/usr/bin/env python3
"""Write source.step for a geometry imported with only its binary sidecar.

Mesh imports (STL/OBJ/PLY) store ``source.bbrep`` first so the model shows in
seconds; the server runs this afterwards, off the request path. Until it
finishes every reader uses the sidecar (``cfddesk.cad.io.read_step_shape``).

    python tools/write_deferred_step.py --step <geometry dir>/source.step
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--step", type=Path, required=True)
    args = ap.parse_args(argv)
    from cfddesk.cad.io import step_sidecar_path, write_deferred_step

    if args.step.is_file():
        print(json.dumps({"ok": True, "step_path": str(args.step), "skipped": "already written"}))
        return 0
    if not step_sidecar_path(args.step).is_file():
        print(json.dumps({"ok": False, "error": f"no sidecar for {args.step}"}))
        return 2
    try:
        write_deferred_step(args.step)
    except Exception as exc:  # noqa: BLE001 — report and exit non-zero; the sidecar still serves readers
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1
    print(json.dumps({"ok": True, "step_path": str(args.step)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
