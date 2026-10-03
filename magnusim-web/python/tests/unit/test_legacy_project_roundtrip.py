"""Goldens for every old project.json shape: what loading one must keep.

Incompressible-flow physics is moving out of the core Project model into a
bundled plugin. These goldens pin what ``Project.from_dict`` makes of each
fixture in ``tests/fixtures/projects`` (v4..v15), so the move cannot change an
old project without a test saying so. Each golden, in
``tests/fixtures/projects/goldens/<name>.json``, holds per simulation:

- the analysis type;
- each BC's type, variant, settings, face ids, patch name and refinement level;
- each mesh's stored and current mesh input fingerprint;
- each run's id, name, settings snapshot and unrecoverable keys;
- the keys of ``simulation_control``;
- the ``solver``, ``boundary``, ``initial_conditions`` and ``numerics`` blocks
  as ``Simulation.to_dict`` writes them.

Ids the load makes up (a v4/v5 file has no simulation, so its recovered run
gets a new id) are written as ``<new id>``. Nothing else is normalised: no
golden field holds a path or a timestamp.

``v11_seed_*`` are v11.json with another stored turbulence model or backend,
recorded before the v12 seed moved to ``legacy_sim``: they pin what that seed
gives each model.

``bc_registry_v4.json`` holds ``bc_registry.default_settings`` for the three
BC types the v4 migration makes.

Refresh after a deliberate change: ``CFDDESK_UPDATE_GOLDEN=1 pytest
tests/unit/test_legacy_project_roundtrip.py``, then review ``git diff``.
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any

import pytest

from cfddesk.case.bc_registry import default_settings
from cfddesk.project.model import PROJECT_VERSION, Project
from tests.conftest import PROJECTS

GOLDEN = PROJECTS / "goldens"
UPDATE = os.environ.get("CFDDESK_UPDATE_GOLDEN", "").strip() in ("1", "true", "yes")
VERSIONS = list(range(4, PROJECT_VERSION + 1))
NEW_ID = "<new id>"
BC_KEYS = ("type", "variant", "settings", "face_ids", "patch_name", "refinement_level")
RUN_KEYS = ("id", "name", "settings_snapshot", "unrecoverable")
LEGACY_BLOCKS = ("solver", "boundary", "initial_conditions", "numerics")
V4_BC_TYPES = ("velocity_inlet_fixed", "pressure_outlet_gauge", "wall_noslip")


def _fixture(version: int) -> dict[str, Any]:
    return json.loads((PROJECTS / f"v{version}.json").read_text(encoding="utf-8"))


def _ids_in(doc: Any) -> set[str]:
    """Every ``id`` value anywhere in a project.json document."""
    out: set[str] = set()
    if isinstance(doc, dict):
        for key, value in doc.items():
            if key == "id" and isinstance(value, str):
                out.add(value)
            out |= _ids_in(value)
    elif isinstance(doc, list):
        for item in doc:
            out |= _ids_in(item)
    return out


def snapshot(project: Project, source: dict[str, Any]) -> dict[str, Any]:
    """What must never change when ``source`` loads as ``project``."""
    known = _ids_in(source)
    sims: list[dict[str, Any]] = []
    for sim in project.simulations:
        d = sim.to_dict()
        runs = []
        for run in d["runs"]:
            row = {k: run[k] for k in RUN_KEYS}
            if row["id"] not in known:
                row["id"] = NEW_ID
            runs.append(row)
        sims.append(
            {
                "analysis_type": sim.analysis_type,
                "boundary_conditions": [
                    {k: bc.get(k) for k in BC_KEYS} for bc in d["boundary_conditions"]
                ],
                "meshes": [
                    {
                        "last_mesh_fingerprint": m.last_mesh_fingerprint,
                        "mesh_input_fingerprint": project.mesh_input_fingerprint(mesh_id=m.id),
                    }
                    for m in sim.meshes
                ],
                "runs": runs,
                "simulation_control_keys": sorted(d["simulation_control"]),
                "legacy_blocks": {k: d[k] for k in LEGACY_BLOCKS},
            }
        )
    return {"version": project.version, "simulations": sims}


def _text(doc: Any) -> str:
    return json.dumps(doc, indent=1, sort_keys=True) + "\n"


def check(name: str, doc: Any) -> None:
    """Compare ``doc`` with goldens/<name>.json (or record it)."""
    got = _text(doc)
    golden = GOLDEN / f"{name}.json"
    if UPDATE:
        golden.parent.mkdir(parents=True, exist_ok=True)
        golden.write_text(got, encoding="utf-8", newline="\n")
        return
    assert golden.is_file(), f"no golden {golden.name}: record it with CFDDESK_UPDATE_GOLDEN=1"
    want = golden.read_text(encoding="utf-8")
    assert json.loads(got) == json.loads(want), f"{name} differs from its golden"
    assert got == want, f"{name} differs from its golden (formatting or float text)"


def _with_results(tmp_path: Path) -> Path:
    """A project folder whose results tree the viewer can open."""
    (tmp_path / "results" / "constant" / "polyMesh").mkdir(parents=True)
    return tmp_path


def _v11_seeded(turbulence: str, *, backend: str = "cpu", vector_inlet: bool = False) -> dict[str, Any]:
    """v11.json with another stored turbulence model (what the v12 seed reads)."""
    doc = _fixture(11)
    sim = doc["simulations"][0]
    sim["solver"].update(turbulence=turbulence, backend=backend, turbulence_intensity_pct=7.5)
    if vector_inlet:
        sim["boundary_conditions"][0]["settings"].update(
            direction_mode="vector", velocity=[3.0, 4.0, 0.0]
        )
    return doc


# Pre-v12 files whose v12 seed differs: the initial conditions follow the stored
# turbulence model, the numerics the stored backend.
SEED_CASES: dict[str, Any] = {
    "v11_seed_kEpsilon": lambda: _v11_seeded("kEpsilon"),
    "v11_seed_LRR": lambda: _v11_seeded("LRR"),
    "v11_seed_SSG_amgx": lambda: _v11_seeded("SSG", backend="amgx"),
    "v11_seed_kOmegaSST_vector": lambda: _v11_seeded("kOmegaSST", vector_inlet=True),
}


def load_case(name: str, tmp_path: Path) -> tuple[Project, dict[str, Any]]:
    """Load one golden case: ``v<N>``, a seed case, or a v5 file next to a results tree."""
    if name.startswith("v") and name[1:].isdigit():
        doc = _fixture(int(name[1:]))
        return Project.from_dict(copy.deepcopy(doc)), doc
    if name in SEED_CASES:
        doc = SEED_CASES[name]()
        return Project.from_dict(copy.deepcopy(doc)), doc
    doc = _fixture(5)
    if name == "v5_recovered_run_no_solver":
        doc.pop("solver")
    return Project.from_dict(copy.deepcopy(doc), project_dir=_with_results(tmp_path)), doc


CASES = [f"v{v}" for v in VERSIONS] + ["v5_recovered_run", "v5_recovered_run_no_solver", *SEED_CASES]


@pytest.mark.parametrize("version", VERSIONS)
def test_fixture_is_the_version_it_names(version: int):
    doc = _fixture(version)
    assert doc["version"] == version
    if version == 4:
        # The v4 shape: flat faces with roles, a boundary block, no BCs.
        assert "boundary_conditions" not in doc and "simulations" not in doc
        assert {f["role"] for f in doc["faces"]} == {"inlet", "outlet", "walls", "unassigned"}
        assert doc["boundary"]["outlet_p"] != 0.0


@pytest.mark.parametrize("name", CASES)
def test_old_project_loads_as_its_golden(name: str, tmp_path: Path):
    project, doc = load_case(name, tmp_path)
    assert project.version == PROJECT_VERSION
    check(name, snapshot(project, doc))


@pytest.mark.parametrize("name", CASES)
def test_saved_project_reloads_the_same(name: str, tmp_path: Path):
    project, doc = load_case(name, tmp_path / "first")
    saved = json.loads(json.dumps(project.to_dict()))
    again = Project.from_dict(copy.deepcopy(saved))
    assert snapshot(again, saved) == snapshot(project, saved)


def test_v4_outlet_pressure_is_converted(tmp_path: Path):
    project, _doc = load_case("v4", tmp_path)
    [sim] = project.simulations
    outlet = next(bc for bc in sim.boundary_conditions if bc.patch_name == "outlet")
    # 2.5 m^2/s^2 kinematic at 1.204 kg/m^3.
    assert outlet.settings["gauge_pressure"] == pytest.approx(2.5 * 1.204)
    assert sim.legacy["boundary"]["outlet_p"] == pytest.approx(2.5 * 1.204)


def test_recovered_run_snapshot_assumes_air_density(tmp_path: Path):
    project, _doc = load_case("v5_recovered_run", tmp_path)
    [run] = project.primary_simulation().runs
    assert run.settings_snapshot["density_kg_m3"] == 1.204
    assert run.settings_snapshot["density_backfill"] == "RHO_AIR_assumed"


def test_bc_registry_defaults_for_v4_types():
    check("bc_registry_v4", {t: default_settings(t) for t in V4_BC_TYPES})


def test_v15_file_saves_its_legacy_blocks_unchanged(tmp_path: Path):
    """Load, save, load and save a v15 file: the same bytes, and each study's
    solver / boundary / numerics / initial_conditions blocks as the file has them."""
    doc = _fixture(15)
    first = tmp_path / "first" / "project.json"
    Project.from_dict(copy.deepcopy(doc)).save(first)
    second = tmp_path / "second" / "project.json"
    Project.from_dict(json.loads(first.read_text(encoding="utf-8"))).save(second)
    assert first.read_bytes() == second.read_bytes()
    saved = json.loads(first.read_text(encoding="utf-8"))
    for stored, written in zip(doc["simulations"], saved["simulations"], strict=True):
        for key in LEGACY_BLOCKS:
            assert json.dumps(written[key]) == json.dumps(stored[key]), key


def test_legacy_blocks_pass_through_values_the_core_does_not_know():
    """The core keeps the blocks as stored: no value is checked or coerced."""
    doc = _fixture(15)
    sim = doc["simulations"][0]
    sim["solver"].update(turbulence="someOtherModel", backend="gpu", extra={"a": [1, 2]})
    sim["boundary"] = {"inlet_speed_m_s": "fast"}
    sim["numerics"] = {"anything": True}
    project = Project.from_dict(copy.deepcopy(doc))
    written = project.to_dict()["simulations"][0]
    for key in LEGACY_BLOCKS:
        assert written[key] == sim[key], key


def test_pre_v12_unknown_turbulence_is_kept_and_seeds_no_turbulence_fields():
    """An old solver.turbulence is an opaque string: kept as stored, and the v12
    seed gives a value it does not know the laminar initial conditions."""
    doc = _fixture(11)
    doc["simulations"][0]["solver"]["turbulence"] = "someOtherModel"
    [sim] = Project.from_dict(copy.deepcopy(doc)).to_dict()["simulations"]
    assert sim["solver"]["turbulence"] == "someOtherModel"
    assert sorted(sim["initial_conditions"]) == ["U", "p", "subdomains_stub", "uref_m_s"]


def test_new_study_has_no_legacy_blocks():
    """A study made since the split stores none of the old blocks."""
    from cfddesk.cad.step import load_step

    solid = load_step(PROJECTS.parent / "elbow.step")
    project = Project.from_solid(solid, scale_to_metres=0.001, units_confirmed=True)
    [sim] = project.to_dict()["simulations"]
    assert not set(LEGACY_BLOCKS) & set(sim)
    again = Project.from_dict(project.to_dict())
    assert not set(LEGACY_BLOCKS) & set(again.to_dict()["simulations"][0])
