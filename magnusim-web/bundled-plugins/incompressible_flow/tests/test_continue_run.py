"""F6: a run continued from its latest saved time (RunInputs.restart).

The writer keeps the case's saved times, mesh and log parts, starts the solver
from the latest time and runs it to the new end; it never adds steps that run
before the solver (pre_steps); readers merge what each start wrote.
"""

from __future__ import annotations

import dataclasses
import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest
from conftest import JS_PROJECT
from conftest import run_spec as load_run_spec
from test_turbulence_models import _project, channel_mesh  # noqa: F401  (fixture)
from wsl_tmp_case import log, run_steps

from incompressible_flow.analyses import _decision
from incompressible_flow.forces_results import read_dat
from incompressible_flow.writer import _steady_control_dict_body, write_solve_case


def _entry(text: str, key: str) -> str:
    return next(line.split(None, 1)[1].strip().rstrip(";") for line in text.splitlines() if line.startswith(key + " "))


def _save(case: Path, t: str) -> None:
    (case / t).mkdir()
    for f in ("U", "p", "k"):
        (case / t / f).write_text(f"saved {t}\n", encoding="utf-8")


def _first_run(case: Path, **kw) -> None:
    spec = load_run_spec(JS_PROJECT, run_id="r-cont", require_mesh=False, n_procs=1, **kw)
    assert spec.ok, spec.error
    assert write_solve_case(spec, case)["ok"] is True


def test_a_steady_restart_keeps_the_times_and_starts_from_the_latest(tmp_path: Path):
    case = tmp_path / "case"
    _first_run(case)
    _save(case, "50")
    _save(case, "100")
    (case / "log.simpleFoam").write_text("first\n", encoding="utf-8")
    (case / "log.simpleFoam.1").write_text("older\n", encoding="utf-8")
    (case / "postProcessing" / "mon" / "0").mkdir(parents=True)
    (case / ".frame-150.part").mkdir()
    spec = load_run_spec(
        JS_PROJECT, run_id="r-cont", require_mesh=False, n_procs=1, restart={"end_time": 250, "write_interval": 50}
    )
    assert (spec.end_time, spec.write_interval, spec.restart) == (250, 50, {"end_time": 250, "write_interval": 50})
    report = write_solve_case(spec, case)
    assert report["ok"] is True, report
    assert report["restart"] == {"from_time": 100.0, "end_time": 250.0}
    # The saved times, postProcessing and log parts stay; a half-copied frame goes.
    assert (case / "50" / "U").read_text(encoding="utf-8") == "saved 50\n"
    assert (case / "100" / "k").is_file()
    assert (case / "log.simpleFoam").is_file() and (case / "log.simpleFoam.1").is_file()
    assert (case / "postProcessing" / "mon" / "0").is_dir()
    assert not (case / ".frame-150.part").exists()
    control = (case / "system" / "controlDict").read_text(encoding="utf-8")
    assert _entry(control, "startFrom") == "latestTime"
    assert _entry(control, "endTime") == "250"
    # Writes count from the restart: 150, 200, 250 (the new end is written).
    assert _entry(control, "writeControl") == "runTime"
    assert _entry(control, "writeInterval") == "50"
    side = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    assert side["restart"] == {"from_time": 100.0, "end_time": 250.0}
    assert side["endTime"] == 250


def test_a_restart_has_no_pre_steps(tmp_path: Path):
    # Steps before the solver (a potentialFoam start) belong to a run written from
    # the start; a continued run starts from its saved fields.
    case = tmp_path / "case"
    _first_run(case)
    _save(case, "100")
    spec = load_run_spec(JS_PROJECT, run_id="r-cont", require_mesh=False, n_procs=1, restart={"end_time": 200})
    report = write_solve_case(spec, case)
    side = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    assert report["ok"] is True and "restart" in report
    assert "pre_steps" not in report and "pre_steps" not in side



def test_a_potential_flow_study_restarts_without_its_potential_flow_step(tmp_path: Path):
    # The study asks for a potential-flow start (F7): its first run lists potentialFoam
    # as a pre_step; the run continued from its saved fields lists none.
    case = tmp_path / "case"
    first = load_run_spec(JS_PROJECT, run_id="r-cont", require_mesh=False, n_procs=1)
    first = dataclasses.replace(first, physics=dataclasses.replace(first.physics, potential_flow=True))
    assert first.physics.uses_potential_flow()
    assert write_solve_case(first, case)["ok"] is True
    side = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    assert side["pre_steps"] == [{"tool": "potentialFoam", "args": ["-writephi", "-writep"]}]
    _save(case, "100")
    spec = load_run_spec(JS_PROJECT, run_id="r-cont", require_mesh=False, n_procs=1, restart={"end_time": 200})
    spec = dataclasses.replace(spec, physics=dataclasses.replace(spec.physics, potential_flow=True))
    report = write_solve_case(spec, case)
    side = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    assert report["ok"] is True and report["restart"] == {"from_time": 100.0, "end_time": 200.0}
    assert "pre_steps" not in report and "pre_steps" not in side


def test_a_restart_keeps_the_settle_stop(tmp_path: Path):
    # "Stop when settled" (F5) applies to the continued part too: the controlDict
    # starts from the latest time and still ends the solve when the monitor settles.
    case = tmp_path / "case"
    _first_run(case)
    _save(case, "100")
    spec = load_run_spec(JS_PROJECT, run_id="r-cont", require_mesh=False, n_procs=1, restart={"end_time": 300})
    spec = dataclasses.replace(
        spec,
        reference={"ref_area": 0.5},
        forces_monitors=[{"id": "rc-f", "name": "Forces 1", "boundaries": ["@walls"]}],
        result_controls=[{"id": "rc-f", "name": "Forces 1", "monitor_type": "forces", "boundaries": ["@walls"]}],
        settle={"source": "monitor", "id": "rc-f", "quantity": "Cd", "tolerance": 0.002, "window": 80},
    )
    assert write_solve_case(spec, case)["ok"] is True
    control = (case / "system" / "controlDict").read_text(encoding="utf-8")
    assert _entry(control, "startFrom") == "latestTime" and _entry(control, "endTime") == "300"
    assert "runTimeControl" in control and "fields          ( Cd );" in control
    side = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    assert side["restart"] == {"from_time": 100.0, "end_time": 300.0}
    assert side["settle"]["text"] == "Forces 1 · Cd stayed within 0.002 of its average over 80 iterations"

SETTLE = {"source": "monitor", "id": "rc-f", "quantity": "Cd", "tolerance": 0.002, "window": 80}


def _with_settle(spec):
    return dataclasses.replace(
        spec,
        reference={"ref_area": 0.5},
        forces_monitors=[{"id": "rc-f", "name": "Forces 1", "boundaries": ["@walls"]}],
        result_controls=[{"id": "rc-f", "name": "Forces 1", "monitor_type": "forces", "boundaries": ["@walls"]}],
        settle=dict(SETTLE),
    )


def test_a_run_continued_past_its_convergence_is_written_without_its_stops(tmp_path: Path):
    # It converged (residuals or its settle stop): its Continue runs past that, so the
    # case has no residualControl and no settle stop, and its plan says so.
    case = tmp_path / "case"
    _first_run(case)
    _save(case, "100")
    restart = {"end_time": 300, "stops_off": True}
    spec = _with_settle(load_run_spec(JS_PROJECT, run_id="r-cont", require_mesh=False, n_procs=1, restart=restart))
    report = write_solve_case(spec, case)
    assert report["ok"] is True and report["restart"] == {"from_time": 100.0, "end_time": 300.0, "stops_off": True}
    control = (case / "system" / "controlDict").read_text(encoding="utf-8")
    solution = (case / "system" / "fvSolution").read_text(encoding="utf-8")
    assert _entry(control, "startFrom") == "latestTime" and _entry(control, "endTime") == "300"
    assert "runTimeControl" not in control and "settleStop" not in control
    simple = re.search(r"^SIMPLE\s*\{(.*?)^\}", solution, re.M | re.S)
    assert simple and "residualControl" not in simple.group(1), solution
    side = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    assert side["restart"]["stops_off"] is True and "settle" not in side
    plan = _decision(spec, SimpleNamespace(inputs=None))
    assert plan["stops_off"] is True and "residual_control" not in plan and "stop_when" not in plan


def test_a_run_continued_without_converging_keeps_its_stops(tmp_path: Path):
    case = tmp_path / "case"
    _first_run(case)
    _save(case, "100")
    spec = _with_settle(load_run_spec(JS_PROJECT, run_id="r-cont", require_mesh=False, n_procs=1, restart={"end_time": 300}))
    report = write_solve_case(spec, case)
    assert "stops_off" not in report["restart"]
    assert "runTimeControl" in (case / "system" / "controlDict").read_text(encoding="utf-8")
    assert "residualControl" in (case / "system" / "fvSolution").read_text(encoding="utf-8")
    plan = _decision(spec, SimpleNamespace(inputs=None))
    assert plan["residual_control"] is True and "stop_when" in plan and "stops_off" not in plan


def _saved_times(case: Path) -> list[int]:
    return sorted(int(p.name) for p in case.iterdir() if p.is_dir() and p.name.isdigit() and p.name != "0")


@pytest.mark.wsl
def test_a_converged_run_continued_past_its_convergence_runs_every_iteration(tmp_path, channel_mesh):  # noqa: F811
    # Loose residual targets: the first part converges within a few iterations.
    root = _project(tmp_path, {"residual_u": 0.5, "residual_p": 0.5})
    first = load_run_spec(root, run_id="r-past", require_mesh=False, n_procs=1)
    first = dataclasses.replace(first, mesh_case_dir=channel_mesh, end_time=200, write_interval=200)
    case = tmp_path / "case"
    assert write_solve_case(first, case)["ok"] is True
    assert run_steps(case, ["simpleFoam"]) == 0, log(case, "simpleFoam")[-3000:]
    text = log(case, "simpleFoam")
    assert "SIMPLE solution converged in" in text, text[-3000:]
    converged_at = _saved_times(case)[-1]
    assert 0 < converged_at < 200

    def cont(extra: int, stops_off: bool) -> str:
        restart = {"end_time": converged_at + extra, **({"stops_off": True} if stops_off else {})}
        spec = load_run_spec(root, run_id="r-past", require_mesh=False, n_procs=1, restart=restart)
        spec = dataclasses.replace(spec, mesh_case_dir=channel_mesh)
        assert write_solve_case(spec, case)["ok"] is True
        assert run_steps(case, ["simpleFoam"]) == 0, log(case, "simpleFoam")[-3000:]
        return log(case, "simpleFoam")

    # With its stops kept it converges again at once (within two iterations).
    again = cont(20, stops_off=False)
    assert "SIMPLE solution converged in" in again
    assert len(re.findall(r"^Time = \d+\s*$", again, re.M)) <= 2, again[-3000:]
    converged_at = _saved_times(case)[-1]
    # Past its convergence: every one of the 20 iterations, to the new end.
    past = cont(20, stops_off=True)
    assert "converged in" not in past, past[-3000:]
    assert len(re.findall(r"^Time = \d+\s*$", past, re.M)) == 20, past[-3000:]
    assert re.search(rf"^Time = {converged_at + 20}\s*$", past, re.M)
    assert _saved_times(case)[-1] == converged_at + 20


def test_a_restart_keeps_the_mesh_its_fields_are_on(tmp_path: Path):
    case = tmp_path / "case"
    _first_run(case)
    _save(case, "100")
    owner = case / "constant" / "polyMesh" / "owner"
    owner.parent.mkdir(parents=True, exist_ok=True)
    owner.write_text("the mesh the run solved on\n", encoding="utf-8")
    spec = load_run_spec(JS_PROJECT, run_id="r-cont", require_mesh=False, n_procs=1, restart={"end_time": 200})
    assert write_solve_case(spec, case)["ok"] is True
    assert owner.read_text(encoding="utf-8") == "the mesh the run solved on\n"


def test_a_restart_needs_a_saved_time_and_a_later_end(tmp_path: Path):
    case = tmp_path / "case"
    _first_run(case)
    spec = load_run_spec(JS_PROJECT, run_id="r-cont", require_mesh=False, n_procs=1, restart={"end_time": 200})
    assert write_solve_case(spec, case) == {"ok": False, "error": "This run has no saved result to continue from."}
    # A time folder without the frame's fields is no saved result.
    (case / "100").mkdir()
    assert write_solve_case(spec, case)["ok"] is False
    _save(case, "300")
    out = write_solve_case(spec, case)
    assert out == {"ok": False, "error": "The new end (200) must be after the last saved time (300)."}
    assert (case / "300" / "U").is_file(), "a refused restart removes nothing"


def test_a_transient_restart_runs_to_the_new_end_with_the_runs_write_interval(tmp_path: Path):
    case = tmp_path / "case"
    settings = {"end_time": 1, "write_count": 10}
    _first_run(case, transient_override=settings)
    _save(case, "0.5")
    _save(case, "1")
    spec = load_run_spec(
        JS_PROJECT,
        run_id="r-cont",
        require_mesh=False,
        n_procs=1,
        transient_override={**settings, "end_time": 3},
        restart={"end_time": 3, "write_interval": 0.1},
    )
    assert spec.transient is not None and (spec.transient.end_time, spec.transient.write_interval) == (3, 0.1)
    report = write_solve_case(spec, case)
    assert report["ok"] is True and report["restart"] == {"from_time": 1.0, "end_time": 3.0}
    control = (case / "system" / "controlDict").read_text(encoding="utf-8")
    assert _entry(control, "startFrom") == "latestTime"
    assert _entry(control, "endTime") == "3"
    assert _entry(control, "writeInterval") == "0.1"
    assert (case / "0.5" / "U").is_file() and (case / "1" / "U").is_file()


def test_a_transient_restart_off_the_write_grid_still_saves_its_new_end(tmp_path: Path):
    # Stopped at t = 1.7 (a Stop saves the step it is on); on to 4 saving about every 0.5:
    # five intervals of 0.46, so 4 is written (adjustableRunTime counts from the restart).
    case = tmp_path / "case"
    settings = {"end_time": 2, "write_count": 4}
    _first_run(case, transient_override=settings)
    _save(case, "1.7")
    spec = load_run_spec(
        JS_PROJECT,
        run_id="r-cont",
        require_mesh=False,
        n_procs=1,
        transient_override={**settings, "end_time": 4},
        restart={"end_time": 4, "write_interval": 0.5},
    )
    report = write_solve_case(spec, case)
    assert report["ok"] is True and report["restart"] == {"from_time": 1.7, "end_time": 4.0}
    control = (case / "system" / "controlDict").read_text(encoding="utf-8")
    assert _entry(control, "writeInterval") == "0.46"
    side = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    assert side["transient"]["write_interval"] == 0.46


def test_restart_write_interval():
    from incompressible_flow.writer import restart_write_interval

    assert restart_write_interval(2.0, 0.1) == 0.1
    assert restart_write_interval(2.3, 0.5) == 0.46
    assert restart_write_interval(0.2, 0.5) == 0.2
    assert restart_write_interval(0.0, 0.5) == 0.5


def test_a_plain_start_removes_every_log_part(tmp_path: Path):
    case = tmp_path / "case"
    _first_run(case)
    _save(case, "100")
    for name in ("log.simpleFoam", "log.simpleFoam.1", "log.simpleFoam.2", "log.pimpleFoam.1", "log.prepare"):
        (case / name).write_text("x\n", encoding="utf-8")
    _first_run(case)
    assert not (case / "100").exists()
    left = sorted(p.name for p in case.iterdir() if p.name.startswith("log."))
    assert left == ["log.prepare"]


def test_the_steady_control_dict_of_a_restart():
    plain = _steady_control_dict_body(200, 50, "")
    assert _entry(plain, "startFrom") == "startTime" and _entry(plain, "writeControl") == "timeStep"
    text = _steady_control_dict_body(130, 50, "", restart_from=100)
    assert _entry(text, "startFrom") == "latestTime" and _entry(text, "writeControl") == "runTime"
    # Fewer extra iterations than the write interval: the new end is still written.
    assert _entry(text, "writeInterval") == "30"


@pytest.mark.parametrize("stem", ["force", "surfaceFieldValue"])
def test_readers_merge_a_restart_from_the_same_time(tmp_path: Path, stem: str):
    # Continued twice from t=2: OpenFOAM writes <stem>_2.dat beside the first file.
    from magnusim_sdk.foam import read_surface_field_value, restart_dat_files

    folder = tmp_path / "postProcessing" / "fo"
    head = "# Time\ttotal_x\n" if stem == "force" else "# Area : 1\n# Time\tareaAverage(p)\n"
    for t, rows in (("0", [1, 2, 3]), ("2", [3, 4]), ("2_", [3, 4, 5])):
        d = folder / t.rstrip("_")
        d.mkdir(parents=True, exist_ok=True)
        name = f"{stem}_2.dat" if t.endswith("_") else f"{stem}.dat"
        (d / name).write_text(head + "".join(f"{r}\t{r * 10}\n" for r in rows), encoding="utf-8")
    assert [p.name for p in restart_dat_files(folder, stem)] == [f"{stem}.dat", f"{stem}.dat", f"{stem}_2.dat"]
    if stem == "force":
        rows = read_dat(tmp_path, "fo", "force.dat")
        assert [(r["Time"], r["total_x"]) for r in rows] == [(1, 10), (2, 20), (3, 30), (4, 40), (5, 50)]
    else:
        got = read_surface_field_value(tmp_path, "fo")
        assert got is not None and [r[0] for r in got["rows"]] == [1, 2, 3, 4, 5]


def test_readers_take_times_with_an_exponent(tmp_path: Path):
    from magnusim_sdk.foam import restart_dat_files

    folder = tmp_path / "pp"
    for t in ("0", "5e-05", "0.001"):
        (folder / t).mkdir(parents=True)
        (folder / t / "force.dat").write_text("# Time\tx\n", encoding="utf-8")
    assert [p.parent.name for p in restart_dat_files(folder, "force")] == ["0", "5e-05", "0.001"]
