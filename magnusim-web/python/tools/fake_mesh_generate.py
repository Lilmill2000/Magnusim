#!/usr/bin/env python3
"""Tests only: a stand-in for the mesh generators (MAGNUSIM_TEST_COMPUTE=fake).

w21-mesh-generate.js runs this in place of generate_standard.py, generate_snappy.py or
generate_cfmesh_standard.py when the server runs with MAGNUSIM_TEST_COMPUTE=fake, with
the same arguments. It meshes nothing and needs no WSL: it reports a few stages over
MAGNUSIM_TEST_MESH_SECONDS (default 6), then writes a one-cell polyMesh into
<case-dir>/constant/polyMesh (a patch for each of the study's boundary conditions, so a
run's checks pass) and the result line a real generator ends with. So the app's
own paths run as with a real mesher (the live job, the compute slot, the queue, Stop,
the record's end), quickly and the same on every PC.

MAGNUSIM_TEST_MESH_SECONDS: how long it "meshes" (0 to 600 s).
MAGNUSIM_TEST_MESH_RESULT=fail: it ends failed ("Fake mesher failed"), exit 1.
MAGNUSIM_TEST_MESH_CHECKMESH=<file>: a real checkMesh report it puts in the case as
log.checkMesh; like the real generators it then writes the mesh's facts
(cfddesk.mesh.facts) and its result carries their quality.
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


def bc_patch_names(project_dir: str, simulation_id: str, mesh_id: str) -> list[str]:
    """The patches the study's boundary conditions mesh under, named as the real generators
    name them (web_bc_patch_name), so a run's checks find a patch for each. [] when unknown."""
    if not project_dir:
        return []
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from cfddesk.project.web_adapter import study_web_bcs, web_bc_mesh_entry, web_bc_patch_name

        names: list[str] = []
        for bc in study_web_bcs(project_dir, None, simulation_id=simulation_id or None, mesh_id=mesh_id or None):
            reg_key, _settings = web_bc_mesh_entry(bc)
            name = web_bc_patch_name(bc, reg_key)
            if name and name not in names and name != "walls":
                names.append(name)
        return names
    except Exception:
        return []


def write_one_cell_mesh(case_dir: Path, patches: list[str] | None = None) -> dict[str, int]:
    """A unit cube as one hex cell: 8 points and 6 boundary faces, one face for each named
    patch (at most five), the rest in `walls`."""
    poly = case_dir / "constant" / "polyMesh"
    poly.mkdir(parents=True, exist_ok=True)
    points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (0, 4, 7, 3), (1, 2, 6, 5)]
    named = (patches or [])[:5]
    rows = [(name, "patch", 1) for name in named] + [("walls", "wall", 6 - len(named))]
    blocks = []
    start = 0
    for name, kind, n in rows:
        blocks.append(f"    {name}\n    {{\n        type            {kind};\n        nFaces          {n};\n        startFace       {start};\n    }}\n")
        start += n
    note = 'note        "nPoints:8  nCells:1  nFaces:6  nInternalFaces:0";\n    '
    _write(poly / "points", "vectorField", "points", "\n8\n(\n" + "".join(f"({x} {y} {z})\n" for x, y, z in points) + ")\n")
    _write(poly / "faces", "faceList", "faces", "\n6\n(\n" + "".join(f"4({a} {b} {c} {d})\n" for a, b, c, d in faces) + ")\n")
    _write(poly / "owner", "labelList", "owner", "\n6\n(\n0\n0\n0\n0\n0\n0\n)\n", note)
    _write(poly / "neighbour", "labelList", "neighbour", "\n0\n(\n)\n", note)
    _write(poly / "boundary", "polyBoundaryMesh", "boundary", f"\n{len(rows)}\n(\n" + "".join(blocks) + ")\n")
    return {"n_cells": 1, "n_points": 8, "n_faces": 6}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case-dir", required=True)
    parser.add_argument("--generate-id", default="")
    parser.add_argument("--project-dir", default="")
    parser.add_argument("--simulation-id", default="")
    parser.add_argument("--mesh-id", default="")
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
    counts = write_one_cell_mesh(case_dir, bc_patch_names(args.project_dir, args.simulation_id, args.mesh_id))
    (case_dir / "w21-counts.json").write_text(
        json.dumps({**counts, "generate_id": args.generate_id, "source": "fake mesher"}), encoding="utf-8"
    )
    (case_dir / "log.standard_generate.txt").write_text("fake mesher (tests)\nMESH_SCRIPT_OK\n", encoding="utf-8")
    quality = mesh_facts(case_dir, os.environ.get("MAGNUSIM_TEST_MESH_CHECKMESH", "").strip())
    _event("result", ok=True, counts_source="fake mesher", **counts, **({"quality": quality} if quality else {}))
    return 0


def mesh_facts(case_dir: Path, checkmesh: str) -> dict | None:
    """With a checkMesh report (MAGNUSIM_TEST_MESH_CHECKMESH), the mesh's facts as the real
    generators write them, and the quality its record keeps; None without one."""
    if not checkmesh:
        return None
    (case_dir / "log.checkMesh").write_bytes(Path(checkmesh).read_bytes())
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from cfddesk.mesh.facts import finish_mesh_facts

    return finish_mesh_facts(case_dir, None, lambda stage: _event("progress", stage=stage, msg="fake mesher (tests)"))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
