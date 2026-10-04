"""gate:l4-mesh-input, the Python half (LINK proposal revision 7, 5.9 and section 9 L4).

A linked geometry, or a plain import whose preview has the display budget, gets its
Hex-dominant mesh input (``Body1.stl``) from the mesh job's first stage,
``prepare_input`` in ``tools/generate_snappy.py``, never from the server: built from the
shape at CAD quality when ``Body1.json`` is missing or names another shape, left alone
when it is current. Run here with ``--render-only`` (no WSL). The node half is
``scripts/server/__tests__/link-build.test.js`` (the real worker and link jobs with
``generate_snappy.py --render-only``) and ``scripts/__tests__/link-build.test.mjs`` (its
"the mesh input" describe: what the server defers and never reads); the e2e part is
``e2e/link-mesh-input.spec.js``. The Hex-dominant goldens (``test_mesh_goldens.py``)
keep a plain import's input byte-identical.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from tests.conftest import FIXTURES

pytestmark = pytest.mark.occt

PY = Path(__file__).resolve().parents[2]
WEB = PY.parent
TOOLS = PY / "tools"
ELBOW = FIXTURES / "elbow.step"
SHAPE = "e" * 64


def _env(**extra: str) -> dict[str, str]:
    env = dict(os.environ)
    env["MAGNUSIM_WSL_CASE_ROOT"] = "/home/golden/cases"
    env["PYTHONPATH"] = os.pathsep.join([str(PY), str(PY / "sdk")])
    env.pop("MAGNUSIM_TEST_PREPARE_INPUT_PAUSE", None)
    env.update(extra)
    return env


def _bbrep(src: Path, dest: Path) -> None:
    from OCP.BinTools import BinTools, BinTools_FormatVersion

    from cfddesk.cad.io import _load_step

    BinTools.Write_s(_load_step(src), str(dest), False, False, BinTools_FormatVersion.BinTools_FormatVersion_CURRENT)


def _project(tmp: Path, *, linked: bool) -> tuple[Path, Path, Path]:
    """The goldens' sample project on the elbow. ``linked``: the geometry is what a link
    leaves (source.bbrep, link/state.json, no source.step); else a plain STEP import
    whose preview has the display budget. Returns (project, geometry folder, mesh)."""
    from cfddesk.cad import preview
    from cfddesk.project.paths import (
        create_geometry_folder,
        create_mesh_folder,
        create_study_folder,
    )

    proj = tmp / "proj"
    proj.mkdir(parents=True)
    for f in (WEB / "e2e" / "fixtures" / "sample-project-steady-state").glob("*.json"):
        shutil.copy(f, proj / f.name)
    doc = json.loads((proj / "boundary_conditions.json").read_text(encoding="utf-8"))
    doc["boundary_conditions"][0]["faces"] = ["face 10@Body1"]
    doc["boundary_conditions"][1]["faces"] = ["face 13@Body1"]
    (proj / "boundary_conditions.json").write_text(json.dumps(doc), encoding="utf-8")
    geom = Path(create_geometry_folder(proj, {"id": "geom-e2e", "name": "elbow", "original_filename": "elbow.step"})["dir"])
    shape = preview.load_step(ELBOW)
    bounds, _box = preview.shape_bounds(shape)
    if linked:
        _bbrep(ELBOW, geom / "source.bbrep")
        (geom / "link").mkdir()
        (geom / "link" / "state.json").write_text(json.dumps({"rev": 1, "name": "elbow", "shape_sha256": SHAPE, "bounds": bounds}), encoding="utf-8")
        meta = {"preview_version": 8, "bounds": bounds}
    else:
        shutil.copy(ELBOW, geom / "source.step")
        meta = {"preview_version": 8, "bounds": bounds, "display_budget": True, "shape_sha256": SHAPE}
    (geom / "cad_preview.json").write_text(json.dumps(meta), encoding="utf-8")
    create_study_folder(proj, "geom-e2e", {"id": "sim_1", "name": "Incompressible Steady-state"})
    mesh = Path(create_mesh_folder(proj, "sim_1", {"id": "mesh_1", "name": "Mesh 1"})["dir"])
    return proj, geom, mesh


def _render(proj: Path, mesh: Path, shape: str | None = SHAPE, **env: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    argv = [
        sys.executable, str(TOOLS / "generate_snappy.py"),
        "--project-dir", str(proj), "--case-dir", str(mesh / "case"), "--wsl-case", "cfddesk-w25-l4test",
        "--generate-id", "l4", "--fineness", "5", "--add-layers", "0",
        "--mesh-id", "mesh_1", "--simulation-id", "sim_1", "--render-only",
    ]
    if shape is not None:
        argv += ["--input-shape-sha256", shape]
    r = subprocess.run(argv, cwd=str(PY), env=_env(**env), capture_output=True, text=True, timeout=600)
    events = [json.loads(line.split(" ", 1)[1]) for line in r.stdout.splitlines() if line.startswith("MAGNUSIM_EVENT ")]
    results = [e for e in events if e.get("event") == "result"]
    assert results, (r.returncode, r.stderr[-2000:])
    return results[-1], [e for e in events if e.get("event") == "progress"]


def _cli_cad_quality(geom: Path, out: Path) -> bytes:
    """What ``convert_step_to_stl.py --step <geometry> --cad-quality`` writes for it."""
    r = subprocess.run(
        [sys.executable, str(TOOLS / "convert_step_to_stl.py"), "--step", str(geom / "source.step"), "--out", str(out), "--cad-quality"],
        cwd=str(PY), env=_env(), capture_output=True, text=True, timeout=600,
    )
    assert r.returncode == 0, r.stderr[-2000:]
    return out.read_bytes()


def _stages(progress: list[dict[str, Any]]) -> list[str]:
    return [str(p.get("stage")) for p in progress]


def test_linked_geometry_builds_its_input_in_prepare_input(tmp_path: Path):
    proj, geom, mesh = _project(tmp_path, linked=True)
    assert not (geom / "Body1.stl").exists()
    res, progress = _render(proj, mesh)
    assert res.get("ok") is True, res
    assert _stages(progress)[:2] == ["prepare_input", "load_geometry"]
    body1 = geom / "Body1.stl"
    meta = json.loads(body1.with_suffix(".json").read_text(encoding="utf-8"))
    assert meta["cad_quality"] is True and meta["shape_sha256"] == SHAPE and meta["prepared_by"] == "prepare_input"
    # At the --cad-quality triangle count: the same bytes the CLI writes for this shape.
    assert body1.read_bytes() == _cli_cad_quality(geom, tmp_path / "cli.stl")
    assert res["mesh_input_built"] is True and res["mesh_input_ntri"] == meta["bounds"]["ntri"]
    assert res["body1_sha256"] == hashlib.sha256(body1.read_bytes()).hexdigest() == meta["stl_sha256"]
    assert not list(geom.glob("*.tmp.*"))


def test_a_current_input_is_left_alone_and_a_stale_one_rebuilt(tmp_path: Path):
    proj, geom, mesh = _project(tmp_path, linked=True)
    _render(proj, mesh)
    body1 = geom / "Body1.stl"
    stamp = body1.stat().st_mtime_ns
    # Current (a names-only update keeps the shape hash): no stage, not rebuilt.
    res, progress = _render(proj, mesh)
    assert res.get("ok") is True and "prepare_input" not in _stages(progress)
    assert body1.stat().st_mtime_ns == stamp and "mesh_input_built" not in res
    assert res["body1_sha256"] == hashlib.sha256(body1.read_bytes()).hexdigest()
    # Another shape: rebuilt, and Body1.json names it.
    res, progress = _render(proj, mesh, "f" * 64)
    assert "prepare_input" in _stages(progress) and res["mesh_input_built"] is True
    assert json.loads(body1.with_suffix(".json").read_text(encoding="utf-8"))["shape_sha256"] == "f" * 64
    # An input without cad_quality (made from the display mesh before L4): rebuilt.
    meta = json.loads(body1.with_suffix(".json").read_text(encoding="utf-8"))
    meta["cad_quality"] = False
    body1.with_suffix(".json").write_text(json.dumps(meta), encoding="utf-8")
    _res, progress = _render(proj, mesh, "f" * 64)
    assert "prepare_input" in _stages(progress)


@pytest.mark.parametrize("damage", ["deleted", "truncated"])
def test_an_input_whose_file_is_gone_or_cut_is_rebuilt(damage: str, tmp_path: Path):
    """Body1.json still names the shape, but Body1.stl is gone (or under 100 bytes): the
    next Generate builds it again in prepare_input, it does not fail on a missing file."""
    proj, geom, mesh = _project(tmp_path, linked=True)
    _render(proj, mesh)
    body1 = geom / "Body1.stl"
    good = body1.read_bytes()
    if damage == "deleted":
        body1.unlink()
    else:
        body1.write_bytes(good[:80])
    assert json.loads(body1.with_suffix(".json").read_text(encoding="utf-8"))["shape_sha256"] == SHAPE
    res, progress = _render(proj, mesh)
    assert res.get("ok") is True, res
    assert "prepare_input" in _stages(progress) and res["mesh_input_built"] is True
    assert body1.read_bytes() == good


def _triangulated_link(tmp: Path) -> tuple[Path, Path, Path, dict[str, Any]]:
    """A linked elbow sent as a text BREP written from a meshed shape (every face keeps its
    triangulation, as ``BRepTools::Write`` writes by default; the link contract takes
    it), through the link job's own preview (``link_preview.build``)."""
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRepTools import BRepTools

    from cfddesk.cad import link_preview, preview
    from cfddesk.cad.io import _load_step

    proj, geom, mesh = _project(tmp, linked=True)
    shape = _load_step(ELBOW)
    BRepMesh_IncrementalMesh(shape, 2.0, False, 0.8, False)
    text = tmp / "meshed.brep"
    BRepTools.Write_s(shape, str(text))
    built = tmp / "built"
    link_preview.build(text, "brep", None, None, built)
    for name in ("source.bbrep", "cad_preview.json"):
        shutil.copy(built / name, geom / name)
    meta = json.loads((geom / "cad_preview.json").read_text(encoding="utf-8"))
    assert meta.get("display_budget") is not True
    geometric, _box = preview.shape_bounds(_load_step(ELBOW))
    return proj, geom, mesh, {"preview": meta["bounds"], "geometric": geometric}


def test_a_linked_shape_with_a_stored_triangulation_gets_the_clis_bytes(tmp_path: Path):
    """The preview takes AddOptimal's box before it cleans the shape, so for a shape that
    carries a triangulation that box is the triangulation's, not the geometry's.
    prepare_input does not size the input from it: the input is the CLI's, byte for byte."""
    proj, geom, mesh, bounds = _triangulated_link(tmp_path)
    # The scenario bites: the stored box is not the geometry's.
    assert bounds["preview"] != bounds["geometric"]
    res, progress = _render(proj, mesh)
    assert res.get("ok") is True, res
    assert "prepare_input" in _stages(progress)
    assert (geom / "Body1.stl").read_bytes() == _cli_cad_quality(geom, tmp_path / "cli.stl")


def test_budgeted_plain_import_builds_from_the_shape_not_the_vtp(tmp_path: Path):
    proj, geom, mesh = _project(tmp_path, linked=False)
    # A display VTP is there; prepare_input never reads it.
    (geom / "cad_faces.vtp").write_bytes(b"not a vtp")
    res, progress = _render(proj, mesh)
    assert res.get("ok") is True, res
    assert "prepare_input" in _stages(progress)
    body1 = geom / "Body1.stl"
    assert body1.read_bytes() == _cli_cad_quality(geom, tmp_path / "cli.stl")
    assert json.loads(body1.with_suffix(".json").read_text(encoding="utf-8"))["shape_sha256"] == SHAPE


def test_a_failing_prepare_input_fails_the_mesh_with_its_message(tmp_path: Path):
    proj, geom, mesh = _project(tmp_path, linked=True)
    (geom / "source.bbrep").write_bytes(b"Open CASCADE Topology V3 (c) Open Cascade\nnot a shape")
    res, progress = _render(proj, mesh)
    assert res.get("ok") is False
    assert str(res.get("error")).startswith("Couldn't prepare the mesh input: "), res
    assert "prepare_input" in _stages(progress)
    assert not (geom / "Body1.stl").exists() and not (geom / "Body1.json").exists()


def test_without_the_flag_nothing_is_built(tmp_path: Path):
    """A plain import below the budget: the server made Body1.stl before; the generator
    builds nothing (today's path), and with no file it fails as before."""
    proj, geom, mesh = _project(tmp_path, linked=False)
    res, progress = _render(proj, mesh, None)
    assert res.get("ok") is False and str(res.get("error")).startswith("missing Body1.stl")
    assert "prepare_input" not in _stages(progress)


def test_pause_hook_is_inert_unless_set(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("MAGNUSIM_TEST_PREPARE_INPUT_PAUSE", raising=False)
    monkeypatch.syspath_prepend(str(TOOLS))
    sys.modules.pop("generate_snappy", None)
    import generate_snappy

    assert generate_snappy._PREPARE_PAUSE == ""
    # Set: prepare_input waits while the file exists (released here at once).
    hold = tmp_path / "hold"
    proj, _geom, mesh = _project(tmp_path, linked=True)
    res, _progress = _render(proj, mesh, MAGNUSIM_TEST_PREPARE_INPUT_PAUSE=str(hold))
    assert res.get("ok") is True


def test_the_stage_has_its_words_in_the_mesh_panel():
    """The Mesh panel names a stage by the mesher's registry row (src/mesher.ts stageText)."""
    from cfddesk.builtin.meshers import build_snappy_hexdominant

    labels = dict(build_snappy_hexdominant().stage_labels)
    assert labels["prepare_input"] == "Building the mesh input"


def test_the_input_is_sized_from_the_previews_bounds_not_addoptimal(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """prepare_input sizes the deflection from the bounds it is given (98 s of AddOptimal
    on the 11,776-face part); it reads the shape, never the display VTP."""
    from OCP.BRepBndLib import BRepBndLib

    monkeypatch.syspath_prepend(str(TOOLS))
    import convert_step_to_stl as conv

    _proj, geom, _mesh = _project(tmp_path, linked=True)
    bounds = json.loads((geom / "cad_preview.json").read_text(encoding="utf-8"))["bounds"]

    def refuse(*_a: Any, **_k: Any) -> None:
        raise AssertionError("AddOptimal was called")

    monkeypatch.setattr(BRepBndLib, "AddOptimal_s", refuse)
    meta = conv.build_mesh_input(geom / "source.step", geom / "Body1.stl", bounds=bounds, shape_sha256=SHAPE)
    assert meta["cad_quality"] is True and meta["bounds"]["ntri"] > 100


def test_the_deferred_path_keeps_the_shared_face_refusal(tmp_path: Path):
    """The meshing session's condition 3: on a linked geometry (the input deferred to the
    mesh job) a boundary condition on a face two bodies share is still refused, after
    prepare_input, by the same rule (cad.shared_faces.bc_refusal)."""
    proj, geom, mesh = _project(tmp_path, linked=True)
    shared = FIXTURES / "link-contract" / "a-shared" / "shape.bbrep"
    shutil.copy(shared, geom / "source.bbrep")
    from cfddesk.cad import preview

    bounds, _box = preview.shape_bounds(preview.read_bbrep(shared))
    (geom / "cad_preview.json").write_text(json.dumps({"preview_version": 8, "bounds": bounds}), encoding="utf-8")
    doc = json.loads((proj / "boundary_conditions.json").read_text(encoding="utf-8"))
    doc["boundary_conditions"][0]["faces"] = ["face 1@Body1"]
    doc["boundary_conditions"][1]["faces"] = ["face 2@Body1"]  # Body1's +x: Body2 shares it
    (proj / "boundary_conditions.json").write_text(json.dumps(doc), encoding="utf-8")
    res, progress = _render(proj, mesh)
    assert "prepare_input" in _stages(progress)
    assert res.get("ok") is False
    assert "is inside the part (Body1 and Body2 share it), so it can't take a boundary condition" in str(res.get("error")), res
