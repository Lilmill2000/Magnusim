"""Conjugate heat transfer studies set up and solved the way the app does (the WSL tests).

- :func:`step_of` writes a STEP of solid bodies; touching bodies are General-Fused
  first, so they share their faces as a part with several bodies does;
- :func:`study` lays out a project as the app stores it: the part, one Heat
  Transfer study with its settings, materials and BCs, a mesh record;
- :func:`mesh` runs a mesher's Generate tool (Standard or Hex-dominant) and records
  the result as the app does (its regions);
- :func:`solve` hands a run to the runner's relay as a core solve (the plugin's
  own prepare job writes the case, the WSL pre-step splits it, solve.sh runs the
  solver), as Start does; :func:`solve` with ``restart_end`` continues it.
"""

from __future__ import annotations

import json
import math
import os
import secrets
import shlex
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

WEB = Path(__file__).resolve().parents[3]
PY = WEB / "python"
TOOLS = PY / "tools"
RUN_FOAM_CASE = TOOLS / "run_foam_case.py"


def _env() -> dict[str, str]:
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([str(PY), str(PY / "sdk")])
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env.pop("CFDDESK_UPDATE_GOLDEN", None)
    return env


def box(x: float, y: float, z: float, dx: float, dy: float, dz: float) -> Any:
    """A box (mm) from its corner and sizes."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt

    return BRepPrimAPI_MakeBox(gp_Pnt(x, y, z), dx, dy, dz).Shape()


def fuse_all(shapes: list[Any]) -> Any:
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse

    out = shapes[0]
    for s in shapes[1:]:
        op = BRepAlgoAPI_Fuse(out, s)
        op.Build()
        assert op.IsDone()
        out = op.Shape()
    from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain

    unify = ShapeUpgrade_UnifySameDomain(out, True, True, True)
    unify.Build()
    return unify.Shape()


def cut(a: Any, b: Any) -> Any:
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut

    op = BRepAlgoAPI_Cut(a, b)
    op.Build()
    assert op.IsDone()
    return op.Shape()


def step_of(path: Path, bodies: list[Any]) -> Path:
    """A STEP (mm) of ``bodies``; with more than one they are General-Fused, so a face two of
    them touch on is one face both share (as CAD's Enclosure + Combine leave a part)."""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_BuilderAlgo
    from OCP.Interface import Interface_Static
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
    from OCP.TopTools import TopTools_ListOfShape

    shape = bodies[0]
    if len(bodies) > 1:
        args = TopTools_ListOfShape()
        for b in bodies:
            args.Append(b)
        algo = BRepAlgoAPI_BuilderAlgo()
        algo.SetArguments(args)
        algo.Build()
        assert algo.IsDone()
        # The bodies in the order given (Body1 first): each input's image in the result.
        from OCP.BRep import BRep_Builder
        from OCP.TopoDS import TopoDS_Compound

        comp = TopoDS_Compound()
        builder = BRep_Builder()
        builder.MakeCompound(comp)
        for b in bodies:
            images = algo.Modified(b)
            if images.Size() == 0:
                builder.Add(comp, b)
            for img in images:
                builder.Add(comp, img)
        shape = comp
    w = STEPControl_Writer()
    Interface_Static.SetCVal_s("write.step.unit", "MM")
    w.Transfer(shape, STEPControl_AsIs)
    path.parent.mkdir(parents=True, exist_ok=True)
    w.Write(str(path))
    return path


def faces_of(step: Path) -> list[dict[str, Any]]:
    """The part's face table as the app numbers it (id, body, centroid mm, normal, area)."""
    from cfddesk.cad.io import read_step_shape
    from cfddesk.cad.preview import face_properties

    return face_properties(read_step_shape(step))


def face_at(rows: list[dict[str, Any]], axis: int, value_mm: float, sign: int, body: int | None = None) -> str:
    """The label of the face whose centroid lies at ``value_mm`` on ``axis`` with its outward
    normal along ``sign`` (of ``body`` when given)."""
    hits = [
        r
        for r in rows
        if abs(r["centroid"][axis] - value_mm) < 0.05
        and math.copysign(1, r["normal"][axis]) == sign
        and abs(r["normal"][axis]) > 0.99
        and (body is None or int(r["body"]) == body)
        and not r.get("shared_with")
    ]
    assert len(hits) == 1, (axis, value_mm, sign, body, [(h["id"], h["body"]) for h in hits])
    return f"face {hits[0]['id']}@Body{hits[0]['body']}"


def study(
    tmp: Path,
    step: Path,
    *,
    materials: list[dict[str, Any]],
    bcs: list[dict[str, Any]],
    settings: dict[str, Any],
    key: str = "heat_transfer_steady",
    control: dict[str, Any] | None = None,
) -> Path:
    """A project as the app stores it: the part, one Heat Transfer study (``settings`` on its
    record), these materials and BCs, and an empty mesh record."""
    import shutil

    from cfddesk.project import web_writes as ww
    from cfddesk.project.paths import (
        create_geometry_folder,
        create_mesh_folder,
        create_study_folder,
        find_study,
    )

    proj = tmp / "proj"
    proj.mkdir(parents=True)
    for f in (WEB / "e2e" / "fixtures" / "sample-project-steady-state").glob("*.json"):
        shutil.copy(f, proj / f.name)
    doc = {"defaults": {"wall_type": "No-slip"}, "boundary_conditions": [{**b, "simulation_id": "sim_1"} for b in bcs]}
    (proj / "boundary_conditions.json").write_text(json.dumps(doc), encoding="utf-8")
    geom = create_geometry_folder(proj, {"id": "geom-ht", "name": step.stem, "original_filename": step.name})
    shutil.copy(step, Path(geom["dir"]) / "source.step")
    create_study_folder(proj, "geom-ht", {"id": "sim_1", "name": "Heat transfer"})
    folder = Path(find_study(proj, "sim_1")["dir"])  # type: ignore[index]
    ident = folder / "id.json"
    td = "Transient" if key.endswith("_transient") else "Steady-state"
    ident.write_text(
        json.dumps({**json.loads(ident.read_text(encoding="utf-8")), "analysis_type": key, "time_dependency": td, **settings})
        + "\n",
        encoding="utf-8",
    )
    (folder / "simulation_control.json").write_text(json.dumps(control or {"endTime": 500, "writeInterval": 500}), encoding="utf-8")
    create_mesh_folder(proj, "sim_1", {"id": "mesh_1", "name": "Mesh 1"})
    mats = [{**m, "simulation_id": "sim_1"} for m in materials]
    ww.set_materials(proj, {"simulation_id": "sim_1", "materials": mats, "only_ids": [m["id"] for m in mats]}, sim_id="sim_1")
    return proj


def mesh(proj: Path, *, mesher: str = "standard", fineness: int = 3, extra: list[str] | None = None, threads: int = 4) -> dict[str, Any]:
    """Generate the study's mesh into its mesh folder and record it as the app does."""
    from cfddesk.project import web_writes as ww
    from cfddesk.project.paths import find_mesh
    from cfddesk.runner.cleanup import remove_wsl_case

    case = Path(find_mesh(proj, "mesh_1", "sim_1")["dir"]) / "case"  # type: ignore[index]
    wsl_case = f"cfddesk-ht5-mesh-{uuid.uuid4().hex[:8]}"
    argv = [
        "--project-dir", str(proj), "--case-dir", str(case), "--wsl-case", wsl_case, "--generate-id", "ht5",
        "--fineness", str(fineness), "--mesh-id", "mesh_1", "--simulation-id", "sim_1", *(extra or []),
    ]
    if mesher == "standard":
        tool = "generate_standard.py"
        argv += ["--threads", str(threads)]
    else:
        tool = "generate_snappy.py"
        step = next(proj.rglob("source.step"))
        r = subprocess.run(
            [sys.executable, str(TOOLS / "convert_step_to_stl.py"), "--step", str(step), "--out", str(step.with_name("Body1.stl")),
             "--cad-quality"],
            cwd=str(PY), capture_output=True, text=True, timeout=900, env=_env(),
        )
        assert r.returncode == 0, r.stderr[-2000:]
    try:
        r = subprocess.run([sys.executable, str(TOOLS / tool), *argv], cwd=str(PY), env=_env(), capture_output=True, text=True,
                           timeout=3600)
    finally:
        remove_wsl_case(wsl_case)
    events = [json.loads(line.split(" ", 1)[1]) for line in r.stdout.splitlines() if line.startswith("MAGNUSIM_EVENT ")]
    results = [e for e in events if e.get("event") == "result"]
    assert r.returncode == 0 and results and results[-1].get("ok"), (r.returncode, results[-1:], r.stderr[-3000:])
    res = results[-1]
    ww.mesh_result(proj, {"mesh_id": "mesh_1", "simulation_id": "sim_1", "live_mesh_result": {**res, "status": "done"}}, sim_id="sim_1")
    return res


def ready(proj: Path) -> list[dict[str, Any]]:
    """What Start's analysis check says of the study now."""
    from cfddesk.registry import load_all, reset_for_tests, run_case

    from heat_transfer.contract import validate_ready

    reset_for_tests()
    load_all()
    return list(validate_ready(run_case.ready_context(proj, simulation_id="sim_1", run_id="", mesh_id="mesh_1")))


def solve(
    proj: Path,
    root: str,
    *,
    n_procs: int = 1,
    rid: str | None = None,
    run: dict[str, Any] | None = None,
    transient: dict[str, Any] | None = None,
    restart_end: float | None = None,
    timeout: float = 5400,
) -> tuple[int, list[dict[str, Any]], Path, str]:
    """A run of the study through the relay as a core solve; (exit, events, case, run id)."""
    from cfddesk.project import web_writes as ww
    from cfddesk.registry import load_all, reset_for_tests, run_case

    reset_for_tests()
    load_all()
    rid = rid or "r" + secrets.token_hex(4)
    td = "Transient" if transient is not None else "Steady-state"
    rec = ww.run_upsert(
        proj,
        {"id": rid, "name": f"HT5 {rid}", "mesh_id": "mesh_1", "status": "draft", "time_dependency": td, **(run or {})},
        sim_id="sim_1",
    )
    case = Path(rec["case_dir"])
    case.mkdir(parents=True, exist_ok=True)
    restart = {"end_time": restart_end} if restart_end is not None else None
    plan = run_case.plan_run(proj, rid, simulation_id="sim_1", mesh_id="mesh_1", time_dependency=td, transient=transient,
                             n_procs=n_procs, restart=restart)
    assert plan.get("ok"), plan
    launch = plan["launch"]
    job = f"fc-{secrets.token_hex(4)}-{secrets.token_hex(3)}"
    args = ["--run-id", rid, "--mesh-id", "mesh_1", "--time-dependency", td, "--n-procs", str(n_procs)]
    if transient is not None:
        args += ["--transient", json.dumps(transient)]
    if restart is not None:
        args += ["--restart", json.dumps(restart)]
    spec = {
        "v": 1, "kind": "solve", "job_id": job, "token": secrets.token_hex(4), "project_id": proj.name,
        "case_dir": str(case), "case_base": str(case.parent), "case_parts": ["case"], "plugin": "heat_transfer",
        "run_id": rid, "simulation_id": "sim_1", "wsl_root": root, "n_procs": n_procs, "slots_hint": None,
        "prepare": {
            "job": plan["prepare_job"], "runtime": "core", "args": args,
            "env": {"MAGNUSIM_PLUGIN_KEY": "heat_transfer", "MAGNUSIM_JOB_ID": job, "MAGNUSIM_CASE_DIR": str(case),
                    "MAGNUSIM_PROJECT_DIR": str(proj), "MAGNUSIM_SIMULATION_ID": "sim_1"},
        },
        "pre": [],
        "solver": {"app": launch["app"], "keep_frames": launch["keep_frames"], "frame_fields": list(launch["frame_fields"]),
                   "process_names": list(launch["process_names"]), "stop_strategy": launch["stop_strategy"],
                   "parallel": "mpirun" if launch.get("parallel") else "none", "analysis": plan["analysis_key"],
                   **({"restart": True} if restart is not None else {})},
        "owner": None, "hooks": [], "wsl_case": f"cfddesk-w27-{rid}",
    }
    folder = proj.parent / ".cache" / "foam-specs"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{job}.json"
    path.write_text(json.dumps(spec), encoding="utf-8")
    env = {**_env(), "MAGNUSIM_PROJECTS_ROOT": str(proj.parent), "MAGNUSIM_WSL_CASE_ROOT": root}
    r = subprocess.run([sys.executable, str(RUN_FOAM_CASE), "--spec", str(path)], capture_output=True, text=True,
                       encoding="utf-8", env=env, timeout=timeout, cwd=str(PY))
    events = [json.loads(line[len("MAGNUSIM_EVENT "):]) for line in r.stdout.splitlines() if line.startswith("MAGNUSIM_EVENT ")]
    return r.returncode, events, case, rid


def ok(code: int, events: list[dict[str, Any]], case: Path) -> None:
    end = events[-1] if events else {}
    if code == 0 and end.get("event") == "relay_end" and (end.get("outcome") or {}).get("ok"):
        return
    tails = []
    for name in ("log.prepare", "log.splitMeshRegions.1", "log.chtMultiRegionSimpleFoam", "log.chtMultiRegionFoam",
                 "log.buoyantSimpleFoam", "log.buoyantPimpleFoam", "log.decomposePar", "log.reconstructPar"):
        p = case / name
        if p.is_file():
            tails.append(f"== {name}\n" + p.read_text(encoding="utf-8", errors="replace")[-3000:])
    raise AssertionError((code, end, [e for e in events if e.get("event") in ("error", "refused", "warning")][-5:], "\n".join(tails)))


def wsl_root() -> tuple[str, str]:
    """(cases root, base) of this test's own WSL folder (removed by :func:`drop_root`)."""
    from cfddesk.wsl.openfoam import run_wsl_bash

    base = f"/tmp/magnusim-ht5-wsl-{uuid.uuid4().hex[:10]}"
    root = f"{base}/cases"
    assert run_wsl_bash(f"mkdir -p {shlex.quote(root)}", timeout=120).returncode == 0
    return root, base


def drop_root(base: str) -> None:
    from cfddesk.wsl.openfoam import run_wsl_bash

    # Two calls: a pkill in the same shell as the rm would match that shell's own command line.
    run_wsl_bash(f"pkill -f {shlex.quote('[/]' + base[1:])}; true", timeout=300)
    run_wsl_bash(f"rm -rf -- {shlex.quote(base)}", timeout=300)


def internal_values(path: Path) -> Any:
    """A volScalarField's internal values (ascii or binary), numpy."""
    import numpy as np

    from heat_transfer.polymesh import _header, _list, _sizes

    raw = path.read_bytes()
    head, pos = _header(raw)
    binary, _label, scalar = _sizes(head)
    at = raw.find(b"internalField", pos)
    rest = raw[at + len(b"internalField"):]
    stripped = rest.lstrip()
    if stripped.startswith(b"uniform"):
        return np.array([float(stripped.split()[1].rstrip(b";"))])
    lst = raw.find(b"List<scalar>", at)
    vals, _end = _list(raw, lst + len(b"List<scalar>"), binary=binary, size=scalar, width=1, kind="f")
    return vals


def cell_centres(poly: Path) -> Any:
    """Each cell's centroid, numpy (n, 3), as OpenFOAM computes it: pyramids from an estimated
    centre (the mean of its face centres) to each face, their centroids weighted by volume."""
    import numpy as np

    from heat_transfer.polymesh import face_geometry, read_polymesh

    m = read_polymesh(poly)
    centre, area = face_geometry(m)
    est = np.zeros((m.n_cells, 3))
    n = np.zeros(m.n_cells)
    np.add.at(est, m.owner, centre)
    np.add.at(est, m.neighbour, centre[: m.n_internal])
    np.add.at(n, m.owner, 1)
    np.add.at(n, m.neighbour, 1)
    est /= n[:, None]
    vol = np.zeros(m.n_cells)
    acc = np.zeros((m.n_cells, 3))
    for cells, faces, sign in ((m.owner, slice(None), 1.0), (m.neighbour, slice(0, m.n_internal), -1.0)):
        fc = centre[faces]
        pv = sign * np.einsum("ij,ij->i", area[faces], fc - est[cells]) / 3.0
        pc = 0.75 * fc + 0.25 * est[cells]
        np.add.at(vol, cells, pv)
        np.add.at(acc, cells, pc * pv[:, None])
    good = np.abs(vol) > 0
    out = est.copy()
    out[good] = acc[good] / vol[good][:, None]
    return out
