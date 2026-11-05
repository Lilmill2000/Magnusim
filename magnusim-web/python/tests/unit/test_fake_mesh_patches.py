"""The fake mesher's patches (tools/fake_mesh_generate.py, MAGNUSIM_TEST_COMPUTE=fake) are named
as the real generators name them: a BC's name slugified as the project model's
allocate_patch_name does ("Lid" meshes as "lid", "Inlet 2" as "inlet_2"), so a run's readiness
(map_bc_to_patch) finds a patch for each BC whatever its name's case. A BC named "Walls" joins
the default walls patch, as on a real mesh. Before, a BC named "Lid" got a patch "Lid" and the
fake run was refused with 'Mesh has no patch for "Lid" (looked for lid)'."""

from __future__ import annotations

import json
from pathlib import Path

from fake_mesh_generate import bc_patch_names
from magnusim_sdk.study import map_bc_to_patch


def _write(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")


def test_patch_names_are_slugified_as_the_real_mesh_names_them(tmp_path: Path):
    root = tmp_path / "p"
    geom = root / "geometries" / "Geometry_g"
    _write(geom / "id.json", {"id": "g", "kind": "geometry"})
    study = geom / "simulations" / "Study"
    _write(study / "id.json", {"id": "s1", "kind": "simulation"})
    bcs = [
        {"name": "Lid", "bc_type": "Wall", "wall_type": "Moving", "faces": ["face 4@Body1"]},
        {"name": "Walls", "bc_type": "Wall", "faces": ["face 1@Body1"]},
        {"name": "Inlet 2", "bc_type": "Velocity inlet", "faces": ["face 2@Body1"]},
        {"name": "velocity_outlet_1", "bc_type": "Velocity outlet", "faces": ["face 3@Body1"]},
    ]
    for i, bc in enumerate(bcs):
        _write(study / "boundary_conditions" / f"BC_{i}" / "bc.json", {"id": f"b{i}", "simulation_id": "s1", **bc})
    names = bc_patch_names(str(root), "s1", "")
    assert names == ["lid", "inlet_2", "velocity_outlet_1"]
    patches = set(names) | {"walls"}
    assert [map_bc_to_patch(bc, patches) for bc in bcs] == ["lid", "walls", "inlet_2", "velocity_outlet_1"]
