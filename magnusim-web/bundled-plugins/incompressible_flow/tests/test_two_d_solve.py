"""One cell across (2D, Hex-dominant's setting; validation round's review of G5): the solve
makes the mesh's two ends ``empty``, so the flow is solved in the section's plane only.

As mirror planes (``symmetry``) OpenFOAM solved the velocity across the depth as well: zero to
round-off, its normalised residual stayed at 0.035 to 0.068 in the validation set's cavity, so a
steady run never met its residual targets and Run health read U (its largest component) as
stalled. Now:

- a patch the mesh facts' ``two_d`` names as an end, whose BC is a Symmetry and which holds
  nothing but end faces (one per cell for each end), is written ``empty`` in every field and
  in the boundary file, and no monitor reads it;
- a Symmetry that also holds side faces stays a mirror plane (an empty patch must be a multiple
  of the cells); a 3D mesh, facts written for another mesh, or an end whose BC is no longer a
  Symmetry: nothing changes;
- a later solve of the same folder with a 3D mesh opens the patch again (type ``patch``).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from cfddesk.registry import load_all, reset_for_tests

from incompressible_flow.runspec import RunSpec

SIDES = {"name": "Sides", "bc_type": "Symmetry", "faces": ["face 1@B", "face 2@B"]}
LID = {"name": "Lid", "bc_type": "Wall", "wall_type": "Moving", "wall_velocity": [1, 0, 0], "faces": ["face 4@B"]}
WALLS = {"name": "Walls", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["face 3@B", "face 5@B", "face 6@B"]}

HEADER = 'FoamFile\n{{\n    version     2.0;\n    format      ascii;\n    class       {cls};\n    {note}object      {obj};\n}}\n'


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _mesh(case: Path, patches: list[tuple[str, int]], *, two_d: bool = True, n_cells: int = 1) -> Path:
    """A one-cell cube (8 points, 6 boundary faces in ``patches`` order) and its mesh facts."""
    from magnusim_sdk import courant_rates
    from magnusim_sdk.mesh_facts import FACTS_FILE, FACTS_VERSION

    poly = case / "constant" / "polyMesh"
    poly.mkdir(parents=True, exist_ok=True)
    pts = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (0, 4, 7, 3), (1, 2, 6, 5)]
    note = 'note        "nPoints:8  nCells:1  nFaces:6  nInternalFaces:0";\n    '

    def write(name: str, cls: str, body: str, n: str = "") -> None:
        (poly / name).write_text(HEADER.format(cls=cls, obj=name, note=n) + body, encoding="utf-8")

    write("points", "vectorField", "\n8\n(\n" + "".join(f"({x} {y} {z})\n" for x, y, z in pts) + ")\n")
    write("faces", "faceList", "\n6\n(\n" + "".join(f"4({a} {b} {c} {d})\n" for a, b, c, d in faces) + ")\n")
    write("owner", "labelList", "\n6\n(\n0\n0\n0\n0\n0\n0\n)\n", note)
    write("neighbour", "labelList", "\n0\n(\n)\n", note)
    blocks, start = [], 0
    for name, n in patches:
        kind = "wall" if name == "walls" else "patch"
        blocks.append(f"    {name}\n    {{\n        type            {kind};\n        nFaces          {n};\n        startFace       {start};\n    }}\n")
        start += n
    write("boundary", "polyBoundaryMesh", f"\n{len(patches)}\n(\n" + "".join(blocks) + ")\n")
    facts = {"v": FACTS_VERSION, "n_cells": n_cells, "stamp": courant_rates.mesh_stamp(poly)}
    if two_d:
        facts["two_d"] = {
            "axis": "z",
            "depth_m": 1.0,
            "cells_across": 1,
            "front": {"faces": ["Face 1@B"], "bc": "Sides", "patch": "sides"},
            "back": {"faces": ["Face 2@B"], "bc": "Sides", "patch": "sides"},
        }
    (case / FACTS_FILE).write_text(json.dumps(facts), encoding="utf-8")
    return case


def _spec(mesh: Path, *bcs: dict, monitors: list[str] | None = None) -> RunSpec:
    return RunSpec(
        project_dir=Path("."),
        run_id="r1",
        mesh_case_dir=mesh,
        n_procs=1,
        solver_app="simpleFoam",
        end_time=200,
        write_interval=50,
        transient=None,
        nu=1e-3,
        rho=1.0,
        wall_default="No-slip",
        bcs=[],
        monitor_patches=list(monitors or []),
        face_props={},
        mapped=[{"bc": bc, "patch": str(bc["name"]).lower()} for bc in bcs],
    )


def _entry(field: Path, patch: str) -> str:
    text = field.read_text(encoding="utf-8")
    m = re.search(rf"\b{patch}\s*\{{([^}}]*)\}}", text.split("boundaryField", 1)[1])
    assert m, text
    return " ".join(m.group(1).split())


def _patch_type(boundary: Path, patch: str) -> str:
    m = re.search(rf"\b{patch}\s*\{{\s*type\s+(\w+);", boundary.read_text(encoding="utf-8"))
    assert m
    return m.group(1)


def test_the_ends_of_a_2d_mesh_are_its_empty_patches(tmp_path: Path):
    from incompressible_flow.writer import two_d_empty_patches

    mesh = _mesh(tmp_path / "m", [("sides", 2), ("lid", 1), ("walls", 3)])
    poly = mesh / "constant" / "polyMesh"
    assert two_d_empty_patches(_spec(mesh, SIDES, LID, WALLS), poly) == {"sides"}
    # The Symmetry also holds a side face: an empty patch must be a multiple of the cells.
    wide = _mesh(tmp_path / "w", [("sides", 3), ("lid", 1), ("walls", 2)])
    assert two_d_empty_patches(_spec(wide, SIDES, LID, WALLS), wide / "constant" / "polyMesh") == set()
    # Its BC is no longer a Symmetry (the pre-run check says the flow would not be 2D).
    walls = {**SIDES, "bc_type": "Wall", "wall_type": "No-slip"}
    assert two_d_empty_patches(_spec(mesh, walls, LID, WALLS), poly) == set()
    # A 3D mesh; facts left from another mesh (their stamp is not this mesh's); no facts.
    flat = _mesh(tmp_path / "f", [("sides", 2), ("lid", 1), ("walls", 3)], two_d=False)
    assert two_d_empty_patches(_spec(flat, SIDES, LID, WALLS), flat / "constant" / "polyMesh") == set()
    (poly / "points").write_text((poly / "points").read_text(encoding="utf-8") + "\n", encoding="utf-8")
    assert two_d_empty_patches(_spec(mesh, SIDES, LID, WALLS), poly) == set()
    assert two_d_empty_patches(_spec(tmp_path / "none", SIDES), None) == set()


def test_a_solve_on_a_2d_mesh_writes_its_ends_empty_and_monitors_nothing_there(tmp_path: Path):
    from incompressible_flow.writer import write_solve_case

    mesh = _mesh(tmp_path / "m", [("sides", 2), ("lid", 1), ("walls", 3)])
    case = tmp_path / "case"
    out = write_solve_case(_spec(mesh, SIDES, LID, WALLS, monitors=["sides"]), case)
    assert out.get("ok", True) is not False, out
    for field in ("U", "p"):
        assert _entry(case / "0" / field, "sides") == "type empty;"
    # The lid and walls are as on a 3D mesh.
    assert _entry(case / "0" / "U", "lid").startswith("type fixedValue; value uniform (1.0")
    assert _patch_type(case / "constant" / "polyMesh" / "boundary", "sides") == "empty"
    assert _patch_type(case / "constant" / "polyMesh" / "boundary", "lid") == "wall"
    control = (case / "system" / "controlDict").read_text(encoding="utf-8")
    assert "sides" not in control

    # The same folder solved again on a 3D mesh: the patch is a mirror plane again.
    flat = _mesh(tmp_path / "f", [("sides", 2), ("lid", 1), ("walls", 3)], two_d=False)
    write_solve_case(_spec(flat, SIDES, LID, WALLS), case)
    assert _entry(case / "0" / "U", "sides") == "type symmetry;"
    assert _patch_type(case / "constant" / "polyMesh" / "boundary", "sides") == "symmetry"


def test_a_turbulent_solve_on_a_2d_mesh_writes_every_turbulence_field_empty_there(tmp_path: Path):
    import dataclasses

    from incompressible_flow.physics import StudyPhysics
    from incompressible_flow.writer import write_solve_case

    mesh = _mesh(tmp_path / "m", [("sides", 2), ("lid", 1), ("walls", 3)])
    spec = dataclasses.replace(_spec(mesh, SIDES, LID, WALLS), physics=StudyPhysics(turbulence_model="kOmegaSST"))
    case = tmp_path / "case"
    write_solve_case(spec, case)
    for field in ("k", "omega", "nut"):
        assert _entry(case / "0" / field, "sides") == "type empty;", field
