"""mesh_input_fingerprint stability."""
from __future__ import annotations

import json
from dataclasses import replace

from cfddesk.project.model import Project
from cfddesk.project.settings import LOCATION_FINGERPRINT_QUANTUM_M, quantize_location_m
from tests.conftest import PROJECTS


def test_fingerprint_stable_roundtrip():
    doc = json.loads((PROJECTS / "v13.json").read_text(encoding="utf-8"))
    a = Project.from_dict(doc)
    fp1 = a.mesh_input_fingerprint()
    b = Project.from_dict(a.to_dict())
    assert b.mesh_input_fingerprint() == fp1


def test_fingerprint_changes_with_hex_core():
    doc = json.loads((PROJECTS / "v13.json").read_text(encoding="utf-8"))
    proj = Project.from_dict(doc)
    fp1 = proj.mesh_input_fingerprint()
    sim = proj.primary_simulation()
    assert sim and sim.meshes
    m0 = sim.meshes[0]
    new_mesh = replace(m0, settings=replace(m0.settings, hex_element_core=not bool(m0.settings.hex_element_core)))
    new_sim = replace(sim, meshes=[new_mesh])
    flipped = replace(
        proj,
        simulations=[new_sim if s.id == sim.id else s for s in proj.simulations],
    )
    assert flipped.mesh_input_fingerprint() != fp1


def test_location_quantum_helper():
    base = (0.1, 0.2, 0.3)
    delta = LOCATION_FINGERPRINT_QUANTUM_M * 0.1
    assert quantize_location_m(base) == quantize_location_m((base[0] + delta, base[1], base[2]))


def test_fingerprint_stable_under_sub_quantum_location_move():
    doc = json.loads((PROJECTS / "v13.json").read_text(encoding="utf-8"))
    proj = Project.from_dict(doc)
    sim = proj.primary_simulation()
    assert sim and sim.meshes
    m0 = sim.meshes[0]
    loc = m0.settings.location_in_mesh or (0.1, 0.2, 0.3)
    if m0.settings.location_in_mesh is None:
        m0 = replace(m0, settings=replace(m0.settings, location_in_mesh=loc))
        sim = replace(sim, meshes=[m0])
        proj = replace(
            proj,
            simulations=[sim if s.id == sim.id else s for s in proj.simulations],
        )
    fp1 = proj.mesh_input_fingerprint()
    delta = LOCATION_FINGERPRINT_QUANTUM_M * 0.1
    nudged = (loc[0] + delta, loc[1], loc[2])
    new_mesh = replace(m0, settings=replace(m0.settings, location_in_mesh=nudged))
    new_sim = replace(sim, meshes=[new_mesh])
    moved = replace(
        proj,
        simulations=[new_sim if s.id == sim.id else s for s in proj.simulations],
    )
    assert moved.mesh_input_fingerprint() == fp1
