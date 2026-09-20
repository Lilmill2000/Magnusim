#!/usr/bin/env python3
"""CLI wrapper around cfddesk.cad.preview."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

CFDDESK_ROOT = Path(__file__).resolve().parents[1]
if str(CFDDESK_ROOT) not in sys.path:
    sys.path.insert(0, str(CFDDESK_ROOT))

from cfddesk.cad.preview import (  # noqa: E402
    export_preview,
    write_com_into_meta,
    write_faces_into_meta,
)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Export STEP with OCCT visualization mesher (Prs3d)")
    ap.add_argument("--step", type=Path, required=True)
    ap.add_argument("--edges", type=Path, required=False)
    ap.add_argument("--faces", type=Path, required=False)
    ap.add_argument("--meta", type=Path, default=None)
    ap.add_argument("--com-only", action="store_true")
    ap.add_argument("--faces-only", action="store_true")
    args = ap.parse_args(argv)

    if not args.step.is_file():
        print("MISSING STEP", args.step, file=sys.stderr)
        return 2

    if args.faces_only:
        meta_path = args.meta if args.meta is not None else (
            args.edges.with_name("cad_preview.json") if args.edges is not None else args.step.with_name("cad_preview.json")
        )
        meta = write_faces_into_meta(args.step, meta_path)
        print("CAD_FACES_OK", json.dumps({"n_faces": len(meta.get("faces") or [])}))
        return 0 if meta.get("faces") else 4

    if args.com_only:
        meta_path = args.meta if args.meta is not None else (
            args.edges.with_name("cad_preview.json") if args.edges is not None else args.step.with_name("cad_preview.json")
        )
        meta = write_com_into_meta(args.step, meta_path)
        print("CAD_COM_OK", json.dumps({"center_of_mass": meta.get("center_of_mass"), "kind": meta.get("center_of_mass_kind")}))
        return 0 if meta.get("center_of_mass") else 4

    if args.edges is None or args.faces is None:
        print("MISSING --edges/--faces (or use --com-only)", file=sys.stderr)
        return 2

    meta = export_preview(args.step, args.edges, args.faces, args.meta)
    print(
        "CAD_PREVIEW_OK",
        json.dumps({k: meta[k] for k in ("preview_version", "linear_deflection", "angular_deflection", "n_display_tris") if k in meta}),
    )
    if int(meta.get("n_faces") or 0) < 1 and int(meta.get("n_edge_polylines") or 0) < 1:
        print("FAIL: empty STEP shape", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main() or 0)
