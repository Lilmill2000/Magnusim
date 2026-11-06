#!/usr/bin/env python3
"""Whether a study's part can be meshed one cell across (2D), and how.

GET /api/mesh/two-d (scripts/w20-mesh.js) runs this for the Mesh panel's note under One cell
across (2D) and the Assistant's ``read_setup mesh``; the fake mesher (tests) asks the same.
Generate (generate_snappy.py) plans from the same rule (cfddesk.mesh.two_d.plan_two_d).

Prints one JSON line: ``{"ok": true, "available": true, "two_d": {axis, depth_m, cells_across,
front, back}}`` or ``{"ok": true, "available": false, "reason": "..."}``; ``{"ok": false,
"error": ...}`` when the study or its geometry can't be read.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

CFDDESK_ROOT = Path(__file__).resolve().parents[1]
# This checkout's cfddesk and SDK first (as a job's PYTHONPATH has them, job-runner.js
# corePythonPath): the route spawns this tool with the server's own environment.
for _p in (Path(__file__).resolve().parent, CFDDESK_ROOT / "sdk", CFDDESK_ROOT):
    if str(_p) not in sys.path[:3]:
        sys.path.insert(0, str(_p))


def study_two_d(project_dir: Path | str, simulation_id: str) -> dict[str, Any]:
    """The part of study ``simulation_id`` meshed one cell across: ``{available, two_d}`` or
    ``{available: False, reason}``."""
    from generate_standard import _apply_web_bcs

    from cfddesk.cad.shared_faces import face_bodies
    from cfddesk.cad.step import load_step
    from cfddesk.mesh import two_d
    from cfddesk.mesh.gmsh_standard import _face_to_patch_map
    from cfddesk.project.model import Project
    from cfddesk.project.paths import find_study, resolve_step
    from cfddesk.project.regions import mesh_regions
    from cfddesk.project.web_adapter import study_web_bcs

    root = Path(project_dir)
    study = find_study(root, simulation_id) if simulation_id else None
    step = resolve_step(root, (study or {}).get("geometry_id"))
    if step is None:
        raise FileNotFoundError("the study has no geometry")
    solid = load_step(step)
    units = solid.units
    scale = float(getattr(units, "proposed_scale_to_metres", None) or getattr(units, "scale_to_metres", None) or 0.001)
    n_faces = len(solid.faces)
    web_bcs = study_web_bcs(root, None, simulation_id=simulation_id or None)
    regions = mesh_regions(root, simulation_id, solid)
    if regions is not None:
        reason = regions if isinstance(regions, str) else "The study meshes several regions (its materials): one cell across meshes one region."
        return {"available": False, "reason": reason}
    project = _apply_web_bcs(Project.from_solid(solid, scale_to_metres=scale, units_confirmed=True), web_bcs, n_faces)
    plan = two_d.plan_two_d(solid, scale, two_d.bc_faces_of(web_bcs, n_faces), _face_to_patch_map(project), bodies=face_bodies(solid))
    if isinstance(plan, str):
        return {"available": False, "reason": plan}
    summary = plan.summary()
    return {"available": True, "two_d": {k: summary[k] for k in ("axis", "depth_m", "cells_across", "front", "back")}}


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--project-dir", required=True)
    p.add_argument("--simulation-id", default="")
    args = p.parse_args(argv)
    try:
        out: dict[str, Any] = {"ok": True, **study_two_d(args.project_dir, args.simulation_id)}
    except Exception as exc:  # noqa: BLE001 (the answer says why; the route passes it on)
        out = {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:400]}
    print(json.dumps(out), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
