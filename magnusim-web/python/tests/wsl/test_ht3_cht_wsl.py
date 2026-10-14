"""HT3, WSL half: a two-region conjugate heat transfer case solved through the core
solve path, end to end.

The stub CHT test analysis (``fixtures/cht-plugins/stub-cht``) on the two-box part:
Air on Body1, Aluminium 6061 on Body2, meshed by Standard with one cellZone per
region (HT2). A core solve's spec goes to the relay, which runs, as the app does:
the prepare job (``solve.prepare``: the analysis writes the case), the WSL step its
``w27-case.json`` asks for (``splitMeshRegions -cellZones -overwrite``, then
``foam_pre.sh`` brings each region's folders back) and ``solve.sh`` with
``chtMultiRegionSimpleFoam``. The frame comes back with a folder per region, the
residuals are keyed ``<region>:<field>``, both postProcessing path shapes are
written, and the results tools read both regions as one volume (T in both, U in
the air only). Serial, then on 2 ranks (``decomposePar``/``reconstructPar
-allRegions``). The serial run then continues (``solver.restart``, the stub's own
prepare job with ``--restart``): its sidecar still names the split, which does
not run again; the solver goes on from 20 to 40 on the split mesh. ``pytest -m
wsl``; a few minutes.
"""

from __future__ import annotations

import json
import os
import secrets
import shlex
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from cfddesk.project import web_writes as ww
from cfddesk.project.paths import find_mesh, find_study
from cfddesk.registry import reset_for_tests
from cfddesk.wsl.openfoam import run_wsl_bash
from tests.unit.test_shared_faces import _project
from tests.wsl.test_mesh_wsl import PY, TOOLS, _run

pytestmark = [pytest.mark.wsl, pytest.mark.occt, pytest.mark.slow]

CHT = Path(__file__).resolve().parents[1] / "fixtures" / "cht-plugins"
RUN_FOAM_CASE = PY / "tools" / "run_foam_case.py"
APP = "chtMultiRegionSimpleFoam"
REGIONS = ["air", "aluminium_6061"]


def _sh(cmd: str, timeout: float = 120) -> subprocess.CompletedProcess:
    r = run_wsl_bash(cmd, timeout=timeout)
    return subprocess.CompletedProcess([], r.returncode, r.stdout, r.stderr)


@pytest.fixture
def world(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(CHT))
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(tmp_path / "local.json"))
    reset_for_tests()
    base = f"/tmp/magnusim-ht3-wsl-{uuid.uuid4().hex[:10]}"
    root = f"{base}/cases"
    assert _sh(f"mkdir -p {shlex.quote(root)}").returncode == 0
    try:
        yield {"tmp": tmp_path, "root": root}
    finally:
        _sh(f"pkill -f {shlex.quote('[/]' + base[1:])}; true")
        _sh(f"rm -rf -- {shlex.quote(base)}")
        reset_for_tests()


def _mat(mid: str, name: str, model: str, bodies: list[str]) -> dict:
    return {"id": mid, "name": name, "material_model": model, "assigned_volumes": bodies, "simulation_id": "sim_1"}


def cht_project(tmp: Path) -> Path:
    """The two-box part in a study of the stub CHT analysis: Air on Body1, Aluminium on Body2, meshed."""
    proj = _project(tmp, "face 8@Body2")
    ident = Path(find_study(proj, "sim_1")["dir"]) / "id.json"  # type: ignore[index]
    doc = json.loads(ident.read_text(encoding="utf-8"))
    ident.write_text(json.dumps({**doc, "analysis_type": "stub_cht_steady"}) + "\n", encoding="utf-8")
    mats = [
        _mat("m-air", "Air", "stub_cht_fluid", ["Body1"]),
        _mat("m-al", "Aluminium 6061", "stub_cht_solid", ["Body2"]),
    ]
    ww.set_materials(proj, {"simulation_id": "sim_1", "materials": mats, "only_ids": [m["id"] for m in mats]}, sim_id="sim_1")
    mesh_dir = Path(find_mesh(proj, "mesh_1", "sim_1")["dir"])  # type: ignore[index]
    wsl_case = f"cfddesk-ht3-mesh-{uuid.uuid4().hex[:8]}"
    res = _run(
        [
            str(TOOLS / "generate_standard.py"),
            "--project-dir", str(proj), "--case-dir", str(mesh_dir / "case"), "--wsl-case", wsl_case,
            "--generate-id", "ht3", "--fineness", "2", "--hex-core", "0", "--add-layers", "0",
            "--threads", "4", "--mesh-id", "mesh_1", "--simulation-id", "sim_1",
        ]
    )
    _sh(f"rm -rf ~/cases/{wsl_case}; true")
    assert [r["name"] for r in res["regions"]] == REGIONS
    ww.mesh_result(proj, {"mesh_id": "mesh_1", "simulation_id": "sim_1", "live_mesh_result": {**res, "status": "done"}}, sim_id="sim_1")
    return proj


def solve(
    proj: Path, w: dict[str, Any], *, n_procs: int, rid: str | None = None, restart_end: int | None = None
) -> tuple[int, list[dict[str, Any]], Path]:
    """A run's spec through the relay. ``rid`` and ``restart_end``: continue that run
    to ``restart_end`` (the stub's own prepare job with ``--restart``)."""
    rid = rid or "r" + secrets.token_hex(4)
    run = ww.run_upsert(
        proj,
        {"id": rid, "name": f"CHT {n_procs}", "mesh_id": "mesh_1", "endTime": 20, "writeInterval": 20, "status": "draft"},
        sim_id="sim_1",
    )
    case = Path(run["case_dir"])
    case.mkdir(parents=True, exist_ok=True)
    job = f"fc-{secrets.token_hex(4)}-{secrets.token_hex(3)}"
    prepare: dict[str, Any] = {
        "job": "solve.prepare", "runtime": "core",
        "args": ["--run-id", rid, "--mesh-id", "mesh_1", "--simulation-id", "sim_1", "--n-procs", str(n_procs)],
        "env": {"MAGNUSIM_PLUGIN_KEY": "builtin", "MAGNUSIM_JOB_ID": job, "MAGNUSIM_CASE_DIR": str(case),
                "MAGNUSIM_PROJECT_DIR": str(proj)},
    }
    if restart_end is not None:
        prepare = {
            "job": "stub-cht.write_run_case", "runtime": "core",
            "args": ["--run-id", rid, "--mesh-id", "mesh_1", "--n-procs", str(n_procs),
                     "--restart", json.dumps({"end_time": restart_end})],
            "env": {"MAGNUSIM_PLUGIN_KEY": "stub-cht", "MAGNUSIM_JOB_ID": job, "MAGNUSIM_CASE_DIR": str(case),
                    "MAGNUSIM_PROJECT_DIR": str(proj), "MAGNUSIM_SIMULATION_ID": "sim_1"},
        }
    spec = {
        "v": 1, "kind": "solve", "job_id": job, "token": secrets.token_hex(4), "project_id": proj.name,
        "case_dir": str(case), "case_base": str(case.parent), "case_parts": ["case"], "plugin": "stub-cht",
        "run_id": rid, "simulation_id": "sim_1", "wsl_root": w["root"], "n_procs": n_procs, "slots_hint": None,
        "prepare": prepare,
        "pre": [],
        "solver": {"app": APP, "keep_frames": "latest", "frame_fields": ["T"], "process_names": [APP],
                   "stop_strategy": "stopAt_writeNow", "parallel": "mpirun", "analysis": "stub_cht_steady",
                   **({"restart": True} if restart_end is not None else {})},
        "owner": None, "hooks": [],
    }
    spec["wsl_case"] = f"cfddesk-w27-{rid}"
    folder = w["tmp"] / ".cache" / "foam-specs"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{job}.json"
    path.write_text(json.dumps(spec), encoding="utf-8")
    env = {
        **os.environ,
        "MAGNUSIM_PROJECTS_ROOT": str(proj.parent),
        "MAGNUSIM_PLUGINS_DIR": str(CHT),
        "MAGNUSIM_WSL_CASE_ROOT": w["root"],
        "PYTHONPATH": os.pathsep.join([str(PY), str(PY / "sdk")]),
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
    }
    r = subprocess.run([sys.executable, str(RUN_FOAM_CASE), "--spec", str(path)], capture_output=True, text=True,
                       encoding="utf-8", env=env, timeout=1500, cwd=str(PY))
    events = [json.loads(line[len("MAGNUSIM_EVENT "):]) for line in r.stdout.splitlines() if line.startswith("MAGNUSIM_EVENT ")]
    return r.returncode, events, case


def _run_id(case: Path) -> str:
    """The run a case folder is the case of (its run folder's id.json, else run.json)."""
    for name in ("id.json", "run.json"):
        p = case.parent / name
        if p.is_file():
            doc = json.loads(p.read_text(encoding="utf-8"))
            if doc.get("id"):
                return str(doc["id"])
    raise AssertionError(f"no run id beside {case}")


def _times(case: Path) -> list[str]:
    return sorted((d.name for d in case.iterdir() if d.is_dir() and d.name.replace(".", "").isdigit() and d.name != "0"), key=float)


def _tail(case: Path) -> str:
    out = []
    for name in ("log.prepare", f"log.{APP}", "log.splitMeshRegions.1", "log.decomposePar", "log.reconstructPar"):
        p = case / name
        if p.is_file():
            out.append(f"== {name}\n" + p.read_text(encoding="utf-8", errors="replace")[-3000:])
    return "\n".join(out)


def _check_solved(code: int, events: list[dict[str, Any]], case: Path, *, n_procs: int) -> None:
    end = events[-1] if events else {}
    assert code == 0 and end.get("event") == "relay_end" and end["outcome"]["ok"], (end, _tail(case))
    # The case its writer wrote: regions in the sidecar, no top-level 0/ field, the split asked for.
    side = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    assert side["regions"] == [{"name": "air", "role": "fluid"}, {"name": "aluminium_6061", "role": "solid"}]
    assert side["frame_fields"] == ["T"]
    assert not [f for f in (case / "0").iterdir() if f.is_file()]
    # The WSL step ran and brought every region back, without cellToRegion.
    assert {"event": "pre", "tool": "splitMeshRegions", "index": 1, "exit_code": 0, "parallel": False, "n_procs": 1} in events
    for r in REGIONS:
        assert (case / "constant" / r / "polyMesh" / "owner").is_file()
        assert not (case / "0" / r / "cellToRegion").exists()
    assert not (case / "0" / "cellToRegion").exists()
    if n_procs > 1:
        for r in REGIONS:
            assert "numberOfSubdomains 2;" in (case / "system" / r / "decomposeParDict").read_text(encoding="utf-8")
    # The frame came back with a folder per region: T in both, U in the air only.
    times = _times(case)
    assert times == ["20"], times
    t = case / "20"
    assert (t / "air" / "T").is_file() and (t / "air" / "U").is_file()
    assert (t / "aluminium_6061" / "T").is_file() and not (t / "aluminium_6061" / "U").exists()
    log = (case / f"log.{APP}").read_text(encoding="utf-8", errors="replace")
    assert "Solving for solid region aluminium_6061" in log and "End" in log
    if n_procs > 1:
        # decomposePar -allRegions split each region over the ranks.
        dec = (case / "log.decomposePar").read_text(encoding="utf-8", errors="replace")
        assert all(r in dec for r in REGIONS), dec[-3000:]
    # Residuals keyed <region>:<field> (RegionProgressParser), per region.
    res = {e["field"] for e in events if e.get("event") == "residual"}
    assert {"air:h", "air:Ux", "air:p_rgh", "aluminium_6061:h"} <= res, sorted(res)
    assert not [f for f in res if ":" not in f], sorted(res)
    # Both postProcessing path shapes, read by the SDK's generic helper.
    from magnusim_sdk.foam import function_object_files

    for r in REGIONS:
        assert function_object_files(case, f"Tmax_{r}", "volFieldValue.dat", r), r
    probe = function_object_files(case, "probes_aluminium_6061", "T", "aluminium_6061")
    assert probe and probe[0].parts[-4:-1] == ("probes_aluminium_6061", "aluminium_6061", "0"), probe


def _check_results(case: Path) -> dict[str, Any]:
    """The results tools read both regions as one volume."""
    sys.path.insert(0, str(TOOLS))
    from case_volume import load_volume
    from export_case_field import export_field
    from export_cut_plane import export_cut_plane

    from cfddesk.results.regions import REGION_ARRAY

    mesh, _src = load_volume(case, "20", use_cache=False)
    n_cells = {r: int((case / "constant" / r / "polyMesh" / "owner").read_text(errors="replace").split("nCells:")[1].split()[0]) for r in REGIONS}
    assert mesh.n_cells == sum(n_cells.values()), (mesh.n_cells, n_cells)
    region = np.asarray(mesh.cell_data[REGION_ARRAY])
    assert {int(v) for v in np.unique(region)} == {0, 1}
    t = np.asarray(mesh.cell_data["T"])
    u = np.asarray(mesh.cell_data["U"])
    assert np.isfinite(t).all()
    assert np.isfinite(u[region == 0]).all() and np.isnan(u[region == 1]).all()
    assert u.dtype == np.float32
    # T between the walls' 300 K and 350 K; the solid warmer than the air.
    assert 299.0 < float(t.min()) and float(t.max()) < 351.0
    assert float(t[region == 1].mean()) > float(t[region == 0].mean())
    meta = export_field(case, "20", "magU", case.parent / "out-field")
    assert meta["regions_without_field"] == [{"name": "aluminium_6061", "role": "solid"}]
    assert "magU" in meta["fields_available"] and "T" in meta["fields_available"]
    b = mesh.bounds
    cut = export_cut_plane(case, "20", case.parent / "out-cut", ox=(b[0] + b[1]) / 2, oy=(b[2] + b[3]) / 2,
                           oz=(b[4] + b[5]) / 2, nx=0, ny=0, nz=1, field="T")
    assert not cut["empty"]
    return {"cells": n_cells, "T": [float(t.min()), float(t.max())], "cut_T": [cut["umin"], cut["umax"]]}


def test_a_two_region_case_runs_through_the_core_solve_path(world, record_property):
    proj = cht_project(world["tmp"])
    code, events, case = solve(proj, world, n_procs=1)
    _check_solved(code, events, case, n_procs=1)
    numbers = _check_results(case)
    record_property("serial", json.dumps(numbers))
    print("serial", numbers)

    # Continue it to 40: the split is not run again, the solver goes on from 20.
    split_log = case / "log.splitMeshRegions.1"
    split_at = split_log.stat().st_mtime_ns
    code, events, case = solve(proj, world, n_procs=1, rid=_run_id(case), restart_end=40)
    end = events[-1] if events else {}
    assert code == 0 and end.get("event") == "relay_end" and end["outcome"]["ok"], (end, _tail(case))
    assert not [e for e in events if e.get("event") in ("pre", "refused")], [e for e in events if e.get("event") in ("pre", "refused")]
    assert split_log.stat().st_mtime_ns == split_at
    assert _times(case) == ["20", "40"], _times(case)
    assert (case / "40" / "aluminium_6061" / "T").is_file() and (case / "40" / "air" / "U").is_file()
    assert (case / f"log.{APP}.1").is_file() and "Time = 21" in (case / f"log.{APP}").read_text(encoding="utf-8", errors="replace")
    side = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    assert side["pre_steps"] and side["prepare_report"]["restart"] == {"from_time": 20, "end_time": 40}
    record_property("continued", json.dumps(_times(case)))

    code, events, case = solve(proj, world, n_procs=2)
    _check_solved(code, events, case, n_procs=2)
    assert {"event": "ranks", "n_procs": 2} in events
    numbers = _check_results(case)
    record_property("parallel", json.dumps(numbers))
    print("parallel", numbers)
