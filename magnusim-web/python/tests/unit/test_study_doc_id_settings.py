"""A study's settings reach the solve the same before and after its id.json is trimmed.

Older versions kept a study's turbulence model in its folder's id.json as well as in
simulations.json, and the id.json value won. Reading the project in Node now moves
such settings into the simulations.json row (the id.json value still wins) and leaves
id.json identity-only (scripts/__tests__/study-id-settings-migration.test.mjs).
study_doc, what run_inputs and readiness read, gives the same settings for both.
"""

from __future__ import annotations

import json
from pathlib import Path

from cfddesk.project.paths import create_geometry_folder, create_study_folder
from cfddesk.project.readiness import study_doc

IDENTITY = {
    "id": "sim_1",
    "name": "Incompressible Steady-state",
    "geometry_id": "g1",
    "kind": "simulation",
    "analysis": "Incompressible",
    "analysis_type": "incompressible_steady",
    "time_dependency": "Steady-state",
    "algorithm": "SIMPLE",
}

ROW = {
    **{k: v for k, v in IDENTITY.items() if k != "kind"},
    "turbulence_model": "k-omega SST",
    "turbulence_model_key": "kOmegaSST",
    "residual_u": 0.0001,
}


def _seed(root: Path, *, id_json: dict, row: dict) -> Path:
    geom = create_geometry_folder(root, {"id": "g1", "name": "part", "original_filename": "part.step"})
    study = create_study_folder(root, geom["id"], {"id": "sim_1", "name": "Incompressible Steady-state"})
    (Path(study["dir"]) / "id.json").write_text(json.dumps(id_json), encoding="utf-8")
    (root / "simulations.json").write_text(
        json.dumps({"active_id": "sim_1", "simulations": [row]}), encoding="utf-8"
    )
    return Path(study["dir"])


def test_legacy_id_json_value_wins(tmp_path: Path) -> None:
    _seed(tmp_path, id_json={**IDENTITY, "turbulence_model": "kEpsilon"}, row=ROW)
    doc = study_doc(tmp_path, "sim_1")
    assert doc["turbulence_model"] == "kEpsilon"
    assert doc["turbulence_model_key"] == "kOmegaSST"
    assert doc["residual_u"] == 0.0001


def test_migrated_folder_gives_the_same_settings(tmp_path: Path) -> None:
    # What the read leaves: the row holds the id.json value, id.json the identity only.
    _seed(tmp_path, id_json=IDENTITY, row={**ROW, "turbulence_model": "kEpsilon"})
    doc = study_doc(tmp_path, "sim_1")
    assert doc["turbulence_model"] == "kEpsilon"
    assert doc["turbulence_model_key"] == "kOmegaSST"
    assert doc["residual_u"] == 0.0001
    assert doc["kind"] == "simulation"
