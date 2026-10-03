"""OpenFOAM 2D runs (airfoil.openfoam, the openfoam_2d job and the service's openfoam_* methods):
a case written per angle, recorded when queued, read when it ends, its polar, its export, its delete.

The job meshes with Gmsh (the plugin's environment, and the app's own Python); without it
those tests are skipped with that reason. What the host does with the case (WSL, the
queue, simpleFoam) is the e2e's gate:h17-openfoam-2d and test_openfoam_wsl.py.
"""

from __future__ import annotations

import csv
import importlib.util
import io
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

import airfoil_service as svc
from airfoil import cmesh, export, foamcase, openfoam, store
from airfoil_env import need_plugin_env

PLUGIN_DIR = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "openfoam"
HAS_GMSH = importlib.util.find_spec("gmsh") is not None
needs_gmsh = pytest.mark.skipif(not HAS_GMSH, reason="Gmsh is not installed in this Python")


def _job():
    spec = importlib.util.spec_from_file_location("openfoam_2d_job", PLUGIN_DIR / "jobs" / "openfoam_2d.py")
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _write(data, sid, alpha=4.0, level="coarse"):
    events: list[tuple[str, dict]] = []
    code = _job().run_job(sid, alpha, level, data, emit_fn=lambda ev, **kw: events.append((ev, kw)))
    return code, events


def csv_rows(text: str):
    return csv.reader(io.StringIO(text))


def _finish(data, sid, rel, *, coefficients=True):
    """What the host leaves in a case it ran: the forceCoeffs file (a real run's) and the solver log."""
    folder = data.path("studies", sid, *rel.split("/"))
    if coefficients:
        target = folder / "postProcessing" / "forceCoeffs" / "0"
        target.mkdir(parents=True)
        shutil.copyfile(FIXTURES / "coefficient.dat", target / "coefficient.dat")
    (folder / "log.simpleFoam").write_text("Time = 1500\nEnd\n", encoding="utf-8")


@needs_gmsh
def test_the_job_writes_a_case_the_host_can_run_and_hands_back_its_submit(project):
    data, _scope, sid = project
    code, events = _write(data, sid, alpha=-4.0, level="coarse")
    assert code == 0, events
    stages = [kw["stage"] for ev, kw in events if ev == "stage"]
    assert stages == ["prepare", "mesh", "write"]
    result = [kw for ev, kw in events if ev == "result"][0]
    assert result["case_rel"] == "openfoam/run-1-a-4"
    assert result["level"] == "coarse" and 14_000 < result["cells"] < 17_000
    assert result["submit"] == foamcase.submit_options("openfoam/run-1-a-4")
    files = sorted(f["rel"].split("run-1-a-4/")[1] for f in data.list_files(f"studies/{sid}/openfoam"))
    assert files == [
        "0/U",
        "0/k",
        "0/nut",
        "0/omega",
        "0/p",
        "case.json",
        "constant/transportProperties",
        "constant/turbulenceProperties",
        "mesh.msh",
        "system/controlDict",
        "system/createPatchDict",
        "system/extrudeMeshDict",
        "system/fvSchemes",
        "system/fvSolution",
    ]
    # Every file the steps and the solver read, as the case module writes them for this study.
    for rel, text in foamcase.case_files(1e6, -4.0, cmesh.LEVELS["coarse"].iterations).items():
        assert data.read_bytes(f"studies/{sid}/openfoam/run-1-a-4/{rel}") == text.encode("ascii"), rel
    meta = json.loads(data.read_bytes(f"studies/{sid}/openfoam/run-1-a-4/case.json"))
    assert meta["alpha"] == -4.0 and meta["name"] == "NACA 2412" and meta["conditions"]["re"] == 1e6
    assert meta["first_cell"] == pytest.approx(cmesh.first_cell_height(1e6))
    msh = data.read_bytes(f"studies/{sid}/openfoam/run-1-a-4/mesh.msh").decode("ascii")
    assert msh.startswith("$MeshFormat\n2.2 0 8\n")
    # The next run gets the next number, whatever its angle.
    code, events = _write(data, sid, alpha=2.5)
    assert [kw["case_rel"] for ev, kw in events if ev == "result"] == ["openfoam/run-2-a2.5"]


def test_the_job_tool_runs_as_the_host_starts_it(project):
    """``<plugin env python> jobs/openfoam_2d.py --study-id <sid> --alpha 4 --level coarse`` in
    the plugin's folder, with the host's variables and no PYTHONPATH (scripts/server/
    registered-tool.js): the case is written and its result names it. Nothing else runs
    the tool's command line outside the WSL tier."""
    data, _scope, sid = project
    py = need_plugin_env()
    env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON")}
    env.update(MAGNUSIM_PROJECT_DIR=str(data.project_dir), MAGNUSIM_PLUGIN_KEY="airfoil", MAGNUSIM_JOB_ID="job-of-1")
    args = ["--study-id", sid, "--alpha", "4", "--level", "coarse"]  # plugin.py's args_from_params, in order
    done = subprocess.run(
        [str(py), str(PLUGIN_DIR / "jobs" / "openfoam_2d.py"), *args],
        cwd=str(PLUGIN_DIR),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=300,
    )
    assert done.returncode == 0, done.stdout[-2000:] + done.stderr[-2000:]
    events = [json.loads(ln.split(" ", 1)[1]) for ln in done.stdout.splitlines() if ln.startswith("MAGNUSIM_EVENT ")]
    assert [e["stage"] for e in events if e["event"] == "stage"] == ["prepare", "mesh", "write"]
    result = events[-1]
    assert result["event"] == "result" and result["case_rel"] == "openfoam/run-1-a4", events
    assert result["alpha"] == 4.0 and result["level"] == "coarse" and 14_000 < result["cells"] < 17_000
    assert result["submit"] == foamcase.submit_options("openfoam/run-1-a4")
    meta = json.loads(data.read_bytes(f"studies/{sid}/openfoam/run-1-a4/case.json"))
    assert meta["alpha"] == 4.0 and meta["level"] == "coarse" and meta["cells"] == result["cells"]
    assert data.read_bytes(f"studies/{sid}/openfoam/run-1-a4/mesh.msh").startswith(b"$MeshFormat\n2.2 0 8\n")


@needs_gmsh
def test_the_job_refuses_what_openfoam_2d_cannot_run_before_meshing(project):
    data, _scope, sid = project
    study = data.study(sid)
    data.update_study(sid, {"conditions": {**svc.settings.DEFAULT_CONDITIONS, "re": 5e4}}, study["rev"])
    code, events = _write(data, sid)
    assert code == 1
    assert events[-1] == ("error", {"message": foamcase.reynolds_reason()})
    assert "mesh" not in [kw.get("stage") for ev, kw in events]
    assert data.list_files(f"studies/{sid}/openfoam") == []
    study = data.study(sid)
    data.update_study(sid, {"conditions": dict(svc.settings.DEFAULT_CONDITIONS)}, study["rev"])
    code, events = _write(data, sid, level="huge")
    assert code == 1 and "Unknown mesh level" in events[-1][1]["message"]


@needs_gmsh
def test_a_queued_case_is_recorded_and_its_end_read_from_its_folder(project):
    data, scope, sid = project
    _write(data, sid, alpha=4.0)
    rel = "openfoam/run-1-a4"
    got = svc.openfoam_record({"study_id": sid, "case_rel": rel, "compute_id": "fc-abc123-0a1b2c"}, scope)
    assert got["ok"] is True
    [run] = got["runs"]
    assert run["status"] == "queued" and run["compute_id"] == "fc-abc123-0a1b2c" and run["alpha"] == 4.0
    assert run["level"] == "coarse" and run["name"] == "NACA 2412"
    _finish(data, sid, rel)
    got = svc.openfoam_collect({"study_id": sid, "case_rel": rel, "status": "done"}, scope)
    [run] = got["runs"]
    assert run["status"] == "done" and run["steady"] is True and run["iterations"] == 1500
    assert run["cl"] == pytest.approx(0.6256, abs=1e-4) and run["cd"] == pytest.approx(0.01343, abs=1e-5)
    # It is saved: a reopened page reads it back.
    assert svc.results({"study_id": sid}, scope)["openfoam"]["runs"] == got["runs"]
    # The polar of these inputs on this mesh: that angle.
    polar = svc.openfoam_polar({"study_id": sid, "level": "coarse"}, scope)
    assert polar["ok"] is True and [r["alpha"] for r in polar["rows"]] == [4.0]
    assert polar["rows"][0]["cl"] == run["cl"] and polar["rows"][0]["name"] == "NACA 2412"
    # Other inputs, or another mesh: not this polar.
    other = {"source": "naca", "code": "0012", "points_per_side": 81, "closed_te": False}
    assert svc.openfoam_polar({"study_id": sid, "level": "coarse", "airfoil": other}, scope)["rows"] == []
    assert svc.openfoam_polar({"study_id": sid, "level": "medium"}, scope)["rows"] == []
    re2 = {**svc.settings.DEFAULT_CONDITIONS, "re": 2e6}
    assert svc.openfoam_polar({"study_id": sid, "level": "coarse", "conditions": re2}, scope)["rows"] == []
    # Mach, Ncrit and the trips are not OpenFOAM's: they leave its polar as it is.
    c2 = {**svc.settings.DEFAULT_CONDITIONS, "mach": 0.3, "ncrit": 5, "xtr_top": 0.05, "xtr_bottom": 0.05}
    assert len(svc.openfoam_polar({"study_id": sid, "level": "coarse", "conditions": c2}, scope)["rows"]) == 1


@needs_gmsh
def test_a_run_that_did_not_finish_stays_listed_with_its_reason(project):
    data, scope, sid = project
    _write(data, sid, alpha=4.0)
    _write(data, sid, alpha=6.0)
    _write(data, sid, alpha=8.0)
    for n, a in ((1, "4"), (2, "6"), (3, "8")):
        svc.openfoam_record({"study_id": sid, "case_rel": f"openfoam/run-{n}-a{a}", "compute_id": f"fc-x{n}"}, scope)
    svc.openfoam_collect(
        {"study_id": sid, "case_rel": "openfoam/run-1-a4", "status": "failed", "error": "gmshToFoam failed (exit 1). See log.gmshToFoam.1 in the case folder", "code": ""},
        scope,
    )
    svc.openfoam_collect({"study_id": sid, "case_rel": "openfoam/run-2-a6", "status": "stopped"}, scope)
    # Done, but the solver wrote no coefficients: failed, and it says where to look.
    _finish(data, sid, "openfoam/run-3-a8", coefficients=False)
    got = svc.openfoam_collect({"study_id": sid, "case_rel": "openfoam/run-3-a8", "status": "done"}, scope)
    runs = {r["case_rel"]: r for r in got["runs"]}
    assert runs["openfoam/run-1-a4"]["status"] == "failed"
    assert runs["openfoam/run-1-a4"]["error"].startswith("gmshToFoam failed")
    assert runs["openfoam/run-2-a6"]["status"] == "stopped"
    assert runs["openfoam/run-3-a8"]["status"] == "failed"
    assert runs["openfoam/run-3-a8"]["error"] == "The case wrote no force coefficients. See log.simpleFoam in the case folder."
    for run in runs.values():
        assert "cl" not in run
    assert svc.openfoam_polar({"study_id": sid, "level": "coarse"}, scope)["rows"] == []
    # The CSV keeps each of them, with how it ended and no numbers.
    got_csv = svc.export_csv({"study_id": sid}, scope)
    assert got_csv["ok"] is True
    lines = list(csv_rows(got_csv["text"]))[1:]
    assert [(r[0], r[8], r[9], r[10]) for r in lines] == [
        ("OpenFOAM 2D", "4", "failed", ""),
        ("OpenFOAM 2D", "6", "stopped", ""),
        ("OpenFOAM 2D", "8", "failed", ""),
    ]


@needs_gmsh
def test_the_latest_finished_run_at_an_angle_is_its_point_and_the_csv_names_each_run(project):
    data, scope, sid = project
    for n in (1, 2):
        _write(data, sid, alpha=4.0)
        rel = f"openfoam/run-{n}-a4"
        svc.openfoam_record({"study_id": sid, "case_rel": rel, "compute_id": f"fc-y{n}"}, scope)
        _finish(data, sid, rel)
        svc.openfoam_collect({"study_id": sid, "case_rel": rel, "status": "done"}, scope)
    rows = svc.openfoam_polar({"study_id": sid, "level": "coarse"}, scope)["rows"]
    assert [r["case_rel"] for r in rows] == ["openfoam/run-2-a4"]
    table = list(csv_rows(svc.export_csv({"study_id": sid}, scope)["text"]))
    assert table[0] == list(export.COLUMNS)
    of = [row for row in table[1:] if row[0] == "OpenFOAM 2D"]
    assert len(of) == 2
    for row in of:
        cells = dict(zip(export.COLUMNS, row, strict=True))
        assert cells["model"] == "k-ω SST, coarse mesh" and cells["airfoil"] == "NACA 2412" and cells["re"] == "1000000"
        assert cells["status"] == "steady" and float(cells["cl"]) == pytest.approx(0.6256, abs=1e-4)
        assert cells["mach"] == cells["ncrit"] == cells["trip_top_x_c"] == ""


@needs_gmsh
def test_a_run_that_ended_can_be_deleted_and_a_live_one_cannot(project):
    data, scope, sid = project
    _write(data, sid, alpha=4.0)
    rel = "openfoam/run-1-a4"
    svc.openfoam_record({"study_id": sid, "case_rel": rel, "compute_id": "fc-z1"}, scope)
    got = svc.openfoam_delete({"study_id": sid, "case_rel": rel}, scope)
    assert got == {"ok": False, "error": "This run is still queued or running. Stop it before deleting it."}
    assert data.list_files(f"studies/{sid}/{rel}")
    svc.openfoam_collect({"study_id": sid, "case_rel": rel, "status": "stopped"}, scope)
    got = svc.openfoam_delete({"study_id": sid, "case_rel": rel}, scope)
    assert got == {"ok": True, "runs": []}
    assert data.list_files(f"studies/{sid}/{rel}") == []
    # A new run after a delete does not reuse a number another run had.
    _write(data, sid, alpha=4.0)
    assert [f["rel"] for f in data.list_files(f"studies/{sid}/openfoam")][0].startswith(f"studies/{sid}/openfoam/run-1-a4/")


BAD_CASE_RELS = ("openfoam/../study.json", "results", "openfoam/run-1-a4/0", "openfoam/run-x-a4", "../x/openfoam/run-1-a4", "", None)


def test_only_this_plugins_run_folders_are_accepted(project):
    data, scope, sid = project
    # What a wrong folder name could reach: the study's other results and its record.
    store.write_result(data, sid, "xfoil", {"engine": "xfoil", "rows": []})
    kept = {f["rel"]: data.read_bytes(f["rel"]) for f in data.list_files(f"studies/{sid}")}
    assert f"studies/{sid}/results/xfoil.json" in kept and f"studies/{sid}/study.json" in kept
    for bad in BAD_CASE_RELS:
        for name, params in (
            ("openfoam_collect", {"status": "done"}),
            ("openfoam_record", {"compute_id": "fc-1"}),
            ("openfoam_delete", {}),
        ):
            got = getattr(svc, name)({"study_id": sid, "case_rel": bad, **params}, scope)
            assert got["ok"] is False and "Not an OpenFOAM run" in got["error"], (name, bad, got)
    # Nothing was deleted or written on the way (delete removes folders recursively).
    assert {f["rel"]: data.read_bytes(f["rel"]) for f in data.list_files(f"studies/{sid}")} == kept
    got = svc.openfoam_record({"study_id": sid, "case_rel": "openfoam/run-1-a4", "compute_id": "fc-1"}, scope)
    assert got == {"ok": False, "error": "openfoam/run-1-a4 has no case.json: it was not written by this plugin."}
    got = svc.openfoam_record({"study_id": sid, "case_rel": "openfoam/run-1-a4", "compute_id": "a b"}, scope)
    assert got["ok"] is False and "compute_id" in got["error"]
    got = svc.openfoam_collect({"study_id": sid, "case_rel": "openfoam/run-1-a4", "status": "running"}, scope)
    assert got["ok"] is False and "how the case ended" in got["error"]


def test_info_names_the_levels_and_the_reynolds_range():
    info = svc.openfoam_info({}, {})
    assert [lv["value"] for lv in info["levels"]] == ["coarse", "medium", "fine"]
    assert [lv["iterations"] for lv in info["levels"]] == [1200, 1500, 2500]
    assert info["default_level"] == "medium" and info["re_range"] == [1e5, 5e7]
    assert info["re_reason"] == "OpenFOAM 2D runs fully turbulent (k-ω SST): use a Reynolds number from 1e5 to 5e7."
    assert info["app"] == "simpleFoam"


def test_angles_name_their_case_folders():
    assert [openfoam.alpha_tag(a) for a in (4, -4, 2.5, -0.25, 0, -0.0, 10.125)] == ["4", "-4", "2.5", "-0.25", "0", "0", "10.125"]
    for a in (4, -4, 2.5, 0, 10.125):
        assert openfoam.check_case_rel(openfoam.case_rel(7, a)) == openfoam.case_rel(7, a)
