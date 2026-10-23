#!/usr/bin/env python3
"""Tests only: a stand-in for the mesh generators (MAGNUSIM_TEST_COMPUTE=fake).

w21-mesh-generate.js runs this in place of generate_standard.py, generate_snappy.py or
generate_cfmesh_standard.py when the server runs with MAGNUSIM_TEST_COMPUTE=fake, with
the same arguments. It meshes nothing and needs no WSL: it reports a few stages over
MAGNUSIM_TEST_MESH_SECONDS (default 6), then writes a one-cell polyMesh into
<case-dir>/constant/polyMesh and the result line a real generator ends with. So the app's
own paths run as with a real mesher (the live job, the compute slot, the queue, Stop,
the record's end), quickly and the same on every PC.

MAGNUSIM_TEST_MESH_SECONDS: how long it "meshes" (0 to 600 s).
MAGNUSIM_TEST_MESH_RESULT=fail: it ends failed ("Fake mesher failed"), exit 1.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

STAGES = ("load_step", "surface_mesh", "gmsh", "gmshToFoam", "copy_back")

HEADER = """FoamFile
{{
    version     2.0;
    format      ascii;
    class       {cls};
    {note}location    "constant/polyMesh";
    object      {obj};
}}
"""


def _event(kind: str, **payload: object) -> None:
    print("MAGNUSIM_EVENT " + json.dumps({"event": kind, **payload}, separators=(",", ":")), flush=True)


def _seconds() -> float:
    try:
        value = float(os.environ.get("MAGNUSIM_TEST_MESH_SECONDS", "6"))
    except ValueError:
        value = 6.0
    return min(600.0, max(0.0, value))


def _write(path: Path, cls: str, obj: str, body: str, note: str = "") -> None:
    path.write_text(HEADER.format(cls=cls, obj=obj, note=note) + body, encoding="utf-8")


def write_one_cell_mesh(case_dir: Path) -> dict[str, int]:
    """A unit cube as one hex cell: 8 points, 6 boundary faces in one wall patch."""
    poly = case_dir / "constant" / "polyMesh"
    poly.mkdir(parents=True, exist_ok=True)
    points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (0, 4, 7, 3), (1, 2, 6, 5)]
    note = 'note        "nPoints:8  nCells:1  nFaces:6  nInternalFaces:0";\n    '
    _write(poly / "points", "vectorField", "points", "\n8\n(\n" + "".join(f"({x} {y} {z})\n" for x, y, z in points) + ")\n")
    _write(poly / "faces", "faceList", "faces", "\n6\n(\n" + "".join(f"4({a} {b} {c} {d})\n" for a, b, c, d in faces) + ")\n")
    _write(poly / "owner", "labelList", "owner", "\n6\n(\n0\n0\n0\n0\n0\n0\n)\n", note)
    _write(poly / "neighbour", "labelList", "neighbour", "\n0\n(\n)\n", note)
    _write(
        poly / "boundary",
        "polyBoundaryMesh",
        "boundary",
        "\n1\n(\n    walls\n    {\n        type            wall;\n        nFaces          6;\n        startFace       0;\n    }\n)\n",
    )
    return {"n_cells": 1, "n_points": 8, "n_faces": 6}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case-dir", required=True)
    parser.add_argument("--generate-id", default="")
    args, _rest = parser.parse_known_args(argv)
    case_dir = Path(args.case_dir)
    case_dir.mkdir(parents=True, exist_ok=True)
    per_stage = _seconds() / len(STAGES)
    for stage in STAGES:
        _event("progress", stage=stage, msg="fake mesher (tests)")
        end = time.monotonic() + per_stage
        while time.monotonic() < end:
            time.sleep(min(0.1, max(0.0, end - time.monotonic())))
    if os.environ.get("MAGNUSIM_TEST_MESH_RESULT", "").strip() == "fail":
        _event("result", ok=False, error="Fake mesher failed")
        return 1
    counts = write_one_cell_mesh(case_dir)
    (case_dir / "w21-counts.json").write_text(
        json.dumps({**counts, "generate_id": args.generate_id, "source": "fake mesher"}), encoding="utf-8"
    )
    (case_dir / "log.standard_generate.txt").write_text("fake mesher (tests)\nMESH_SCRIPT_OK\n", encoding="utf-8")
    _event("result", ok=True, counts_source="fake mesher", **counts)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
