"""A record's rev (Assistant phase 5, C2): a save made from an older copy is refused.

``persist_child_item`` stamps ``rev`` (+ 1 on a change, kept when nothing changed) and
refuses a ``base_rev`` that is not the stored rev. ``set_bcs`` / ``set_materials`` with
``only_id(s)`` write the named records onto the **stored** list, so a stale copy of another
record in the sent list is ignored rather than written over a newer one; ``set_bcs`` honours
``only_ids`` too. The worker answers a refusal as -32012, which the app server maps to 409.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from cfddesk.project.paths import (
    assemble_study_bcs,
    assemble_study_materials,
    create_geometry_folder,
    create_run_folder,
    create_study_folder,
    find_study,
    persist_child_item,
)
from cfddesk.project.record_rev import STALE_RECORD_RPC, StaleRecordError, first_stale, stamp_rev
from cfddesk.project.web_writes import run_upsert, set_bcs, set_materials


def _tree(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "project.json").write_text(json.dumps({"id": root.name, "name": "P"}), encoding="utf-8")
    (root / "simulations.json").write_text(
        json.dumps({"active_id": "s1", "simulations": [{"id": "s1", "name": "Study"}]}), encoding="utf-8"
    )
    create_geometry_folder(root, {"id": "geom-1", "name": "part.step", "original_filename": "part.step"})
    create_study_folder(root, "geom-1", {"id": "s1", "name": "Study"})
    return root


def _bc(bid: str, name: str, value: float, **extra: object) -> dict:
    return {
        "id": bid,
        "name": name,
        "bc_type": "Velocity inlet",
        "velocity": value,
        "faces": [f"face {len(bid)}@Body1"],
        "simulation_id": "s1",
        **extra,
    }


def _bcs(root: Path) -> dict[str, dict]:
    return {b["id"]: b for b in assemble_study_bcs(root, "s1")}


def _parent(root: Path, sub: str) -> Path:
    return Path(find_study(root, "s1")["dir"]) / sub  # type: ignore[index]


def test_persist_child_item_counts_changes_and_keeps_an_unchanged_rev(tmp_path: Path) -> None:
    root = _tree(tmp_path / "p")
    parent = _parent(root, "boundary_conditions")
    assert persist_child_item(parent, "bc", _bc("bc-1", "Inlet", 1.0))["rev"] == 1
    assert persist_child_item(parent, "bc", _bc("bc-1", "Inlet", 2.0))["rev"] == 2
    # The same values again (a newer updated_at only): nothing changed, the rev stays.
    assert persist_child_item(parent, "bc", {**_bc("bc-1", "Inlet", 2.0), "updated_at": "later"})["rev"] == 2
    # A rev the save sends is never taken as the record's: the writer counts.
    assert persist_child_item(parent, "bc", _bc("bc-1", "Inlet", 3.0, rev=40))["rev"] == 3


def test_persist_child_item_refuses_a_stale_base_rev_and_writes_nothing(tmp_path: Path) -> None:
    root = _tree(tmp_path / "p")
    parent = _parent(root, "boundary_conditions")
    persist_child_item(parent, "bc", _bc("bc-1", "Inlet", 1.0))
    persist_child_item(parent, "bc", _bc("bc-1", "Inlet", 10.0, base_rev=1))
    with pytest.raises(StaleRecordError) as caught:
        persist_child_item(parent, "bc", _bc("bc-1", "Inlet", 12.0, base_rev=1))
    assert caught.value.data() == {"code": "stale_record", "kind": "bc", "id": "bc-1", "rev": 2}
    stored = _bcs(root)["bc-1"]
    assert (stored["velocity"], stored["rev"]) == (10.0, 2)
    assert "base_rev" not in stored


def test_a_save_without_base_rev_is_written_as_before(tmp_path: Path) -> None:
    root = _tree(tmp_path / "p")
    parent = _parent(root, "boundary_conditions")
    persist_child_item(parent, "bc", _bc("bc-1", "Inlet", 1.0))
    persist_child_item(parent, "bc", _bc("bc-1", "Inlet", 5.0))
    assert (_bcs(root)["bc-1"]["velocity"], _bcs(root)["bc-1"]["rev"]) == (5.0, 2)


def test_a_record_written_before_revs_starts_at_one(tmp_path: Path) -> None:
    root = _tree(tmp_path / "p")
    parent = _parent(root, "boundary_conditions")
    persist_child_item(parent, "bc", _bc("bc-1", "Inlet", 1.0))
    folder = next(p for p in parent.iterdir() if p.is_dir())
    rec = json.loads((folder / "bc.json").read_text(encoding="utf-8"))
    rec.pop("rev")
    (folder / "bc.json").write_text(json.dumps(rec), encoding="utf-8")
    # The page read it with no rev: base_rev 0 matches.
    assert persist_child_item(parent, "bc", _bc("bc-1", "Inlet", 1.0, base_rev=0))["rev"] == 1


def test_set_bcs_only_id_rebases_onto_the_stored_list(tmp_path: Path) -> None:
    """The person's panel sends its whole list (with a stale Outlet) and only_id Inlet: the
    Outlet the AI saved meanwhile is kept, and project.json's model holds it too."""
    root = _tree(tmp_path / "p")
    set_bcs(root, {"simulation_id": "s1", "boundary_conditions": [_bc("bc-in", "Inlet", 1.0), _bc("bc-out", "Outlet", 1.0)]}, sim_id="s1")
    # The AI writes Outlet 9 (one record, only_id).
    set_bcs(root, {"simulation_id": "s1", "boundary_conditions": [_bc("bc-out", "Outlet", 9.0, base_rev=1)], "only_id": "bc-out"}, sim_id="s1")
    stale_list = [_bc("bc-in", "Inlet", 4.0, base_rev=1), _bc("bc-out", "Outlet", 1.0, base_rev=1)]
    doc = set_bcs(root, {"simulation_id": "s1", "boundary_conditions": stale_list, "only_id": "bc-in"}, sim_id="s1")
    rows = _bcs(root)
    assert (rows["bc-in"]["velocity"], rows["bc-in"]["rev"]) == (4.0, 2)
    assert (rows["bc-out"]["velocity"], rows["bc-out"]["rev"]) == (9.0, 2)
    assert {b["id"]: b["rev"] for b in doc["boundary_conditions"]} == {"bc-in": 2, "bc-out": 2}
    # The project model (project.json's mirror) holds the AI's Outlet, not the stale copy.
    study_doc = json.loads((_parent(root, "boundary_conditions.json")).read_text(encoding="utf-8"))
    assert {b["id"]: b["velocity"] for b in study_doc["boundary_conditions"]}["bc-out"] == 9.0


def test_set_bcs_only_ids_writes_every_named_record(tmp_path: Path) -> None:
    """Finding 4: set_bcs read only only_id, while the stamp check read both."""
    root = _tree(tmp_path / "p")
    set_bcs(root, {"simulation_id": "s1", "boundary_conditions": [_bc("a", "A", 1.0), _bc("b", "B", 1.0), _bc("c", "C", 1.0)]}, sim_id="s1")
    sent = [_bc("a", "A", 2.0), _bc("b", "B", 2.0), _bc("c", "C", 2.0)]
    set_bcs(root, {"simulation_id": "s1", "boundary_conditions": sent, "only_ids": ["a", "b"]}, sim_id="s1")
    assert {k: v["velocity"] for k, v in _bcs(root).items()} == {"a": 2.0, "b": 2.0, "c": 1.0}


def test_set_bcs_refuses_a_stale_named_record(tmp_path: Path) -> None:
    root = _tree(tmp_path / "p")
    set_bcs(root, {"simulation_id": "s1", "boundary_conditions": [_bc("bc-in", "Inlet", 1.0)]}, sim_id="s1")
    set_bcs(root, {"simulation_id": "s1", "boundary_conditions": [_bc("bc-in", "Inlet", 10.0, base_rev=1)], "only_id": "bc-in"}, sim_id="s1")
    with pytest.raises(StaleRecordError) as caught:
        set_bcs(root, {"simulation_id": "s1", "boundary_conditions": [_bc("bc-in", "Inlet", 12.0, base_rev=1)], "only_id": "bc-in"}, sim_id="s1")
    assert (caught.value.kind, caught.value.id, caught.value.rev) == ("bc", "bc-in", 2)
    assert _bcs(root)["bc-in"]["velocity"] == 10.0


def test_a_legacy_whole_list_save_still_checks_each_base_rev(tmp_path: Path) -> None:
    root = _tree(tmp_path / "p")
    set_bcs(root, {"simulation_id": "s1", "boundary_conditions": [_bc("a", "A", 1.0), _bc("b", "B", 1.0)]}, sim_id="s1")
    set_bcs(root, {"simulation_id": "s1", "boundary_conditions": [_bc("b", "B", 3.0)], "only_id": "b"}, sim_id="s1")
    with pytest.raises(StaleRecordError):
        set_bcs(root, {"simulation_id": "s1", "boundary_conditions": [_bc("a", "A", 2.0, base_rev=1), _bc("b", "B", 1.0, base_rev=1)]}, sim_id="s1")
    assert {k: v["velocity"] for k, v in _bcs(root).items()} == {"a": 1.0, "b": 3.0}
    # Without base_rev the legacy whole list is written as sent.
    set_bcs(root, {"simulation_id": "s1", "boundary_conditions": [_bc("a", "A", 2.0), _bc("b", "B", 1.0)]}, sim_id="s1")
    assert {k: v["velocity"] for k, v in _bcs(root).items()} == {"a": 2.0, "b": 1.0}


def test_set_bcs_keeps_the_defaults_rev(tmp_path: Path) -> None:
    root = _tree(tmp_path / "p")
    defaults = _parent(root, "boundary_conditions") / "defaults.json"
    defaults.parent.mkdir(parents=True, exist_ok=True)
    defaults.write_text(json.dumps({"defaults": {"wall_type": "Slip"}, "defaults_rev": 3}), encoding="utf-8")
    doc = set_bcs(root, {"simulation_id": "s1", "boundary_conditions": [_bc("a", "A", 1.0)]}, sim_id="s1")
    assert doc["defaults_rev"] == 3
    assert json.loads(defaults.read_text(encoding="utf-8"))["defaults_rev"] == 3


def _mat(mid: str, name: str, rho: float, **extra: object) -> dict:
    return {"id": mid, "name": name, "density": rho, "assigned_volumes": ["Body1"], "simulation_id": "s1", **extra}


def test_set_materials_only_id_rebases_and_refuses_stale(tmp_path: Path) -> None:
    root = _tree(tmp_path / "p")
    set_materials(root, {"simulation_id": "s1", "materials": [_mat("m-air", "Air", 1.2), _mat("m-w", "Water", 998.0)], "only_ids": ["m-air", "m-w"]}, sim_id="s1")
    revs = {m["id"]: m["rev"] for m in assemble_study_materials(root, "s1")}
    assert revs == {"m-air": 1, "m-w": 1}
    # The AI changes Water; the panel then saves Air with its stale Water beside it.
    set_materials(root, {"simulation_id": "s1", "materials": [_mat("m-w", "Water", 1000.0, base_rev=1)], "only_id": "m-w"}, sim_id="s1")
    doc = set_materials(
        root,
        {"simulation_id": "s1", "materials": [_mat("m-w", "Water", 998.0, base_rev=1), _mat("m-air", "Air", 1.25, base_rev=1)],
         "air": _mat("m-air", "Air", 1.25, base_rev=1), "only_id": "m-air"},
        sim_id="s1",
    )
    rows = {m["id"]: m for m in assemble_study_materials(root, "s1")}
    assert (rows["m-air"]["density"], rows["m-air"]["rev"]) == (1.25, 2)
    assert (rows["m-w"]["density"], rows["m-w"]["rev"]) == (1000.0, 2)
    # The answer carries the revs as written, so the panel's next save sends the new one.
    saved = {m["id"]: m.get("rev") for m in doc["materials"]}
    assert saved["m-air"] == 2
    with pytest.raises(StaleRecordError) as caught:
        set_materials(root, {"simulation_id": "s1", "materials": [_mat("m-air", "Air", 9.0, base_rev=1)], "only_id": "m-air"}, sim_id="s1")
    assert caught.value.data()["kind"] == "material"
    assert {m["id"]: m["density"] for m in assemble_study_materials(root, "s1")}["m-air"] == 1.25


def test_run_upsert_keeps_the_stored_rev(tmp_path: Path) -> None:
    """Only the run settings save (Node) moves a run's rev: a status write never rewinds it."""
    root = _tree(tmp_path / "p")
    folder = create_run_folder(root, "s1", {"id": "run-1", "name": "Run 1"})
    run_json = Path(folder["dir"]) / "run.json"
    run_json.write_text(json.dumps({"id": "run-1", "name": "Run 1", "rev": 5}), encoding="utf-8")
    run_upsert(root, {"id": "run-1", "status": "running", "rev": 2, "base_rev": 2}, sim_id="s1", run_id="run-1")
    stored = json.loads(run_json.read_text(encoding="utf-8"))
    assert (stored["rev"], stored["status"]) == (5, "running")
    assert "base_rev" not in stored


def test_stamp_and_first_stale_helpers() -> None:
    assert stamp_rev({"a": 1}, None) == {"a": 1, "rev": 1}
    assert stamp_rev({"a": 1, "base_rev": 3}, {"a": 1, "rev": 3}) == {"a": 1, "rev": 3}
    assert stamp_rev({"a": 2}, {"a": 1, "rev": 3})["rev"] == 4
    assert stamp_rev({"a": 2, "rev": 9}, {"a": 1, "rev": 3}, bump=False)["rev"] == 3
    assert "rev" not in stamp_rev({"a": 2, "rev": 9}, None, bump=False)
    stored = [{"id": "x", "rev": 2}]
    assert first_stale("bc", stored, [{"id": "x", "base_rev": 2}, {"id": "new"}]) is None
    gone = first_stale("bc", stored, [{"id": "y", "base_rev": 1}])
    assert gone is not None and (gone.id, gone.rev) == ("y", 0)
    assert STALE_RECORD_RPC == -32012


def test_the_worker_answers_a_stale_save_as_32012(tmp_path: Path) -> None:
    from cfddesk.worker.methods import bcs_set
    from cfddesk.worker.rpc import RpcError

    root = _tree(tmp_path / "p")
    set_bcs(root, {"simulation_id": "s1", "boundary_conditions": [_bc("bc-in", "Inlet", 1.0)]}, sim_id="s1")
    set_bcs(root, {"simulation_id": "s1", "boundary_conditions": [_bc("bc-in", "Inlet", 2.0)], "only_id": "bc-in"}, sim_id="s1")
    with pytest.raises(RpcError) as caught:
        bcs_set(project_dir=str(root), body={"simulation_id": "s1", "boundary_conditions": [_bc("bc-in", "Inlet", 3.0, base_rev=1)], "only_id": "bc-in"}, sim_id="s1")
    assert caught.value.code == -32012
    assert caught.value.data == {"code": "stale_record", "kind": "bc", "id": "bc-in", "rev": 2}
