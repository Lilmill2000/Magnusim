"""The XFOIL engine with a stand-in program (tests/fake_xfoil.py): the session it
sends, what it reads back, progress per α, points that do not converge, the
time limit, and the xfoil_polar job end to end on a study."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from airfoil import naca, settings, store, xfoil
from jobs import xfoil_polar  # noqa: E402  (the job tool, imported as a module)

POLAR_699 = """
       XFOIL         Version 6.99

 Calculated polar for: NACA 2412

 1 1 Reynolds number fixed          Mach number fixed

 xtrf =   1.000 (top)        1.000 (bottom)
 Mach =   0.000     Re =     1.000 e 6     Ncrit =   9.000

  alpha    CL        CD       CDp       CM     Top_Xtr  Bot_Xtr
  ------ -------- --------- --------- -------- -------- --------
   0.000   0.2401   0.00586   0.00104  -0.0530   0.6433   0.9894
   1.000   0.3505   0.00599   0.00113  -0.0532   0.6064   1.0000
"""


def _conditions(**patch):
    return settings.normalize_conditions({**settings.DEFAULT_CONDITIONS, **patch})


def test_session_turns_graphics_off_first_and_ends_with_quit():
    order = xfoil.sweep_order([-4.0, -3.0, -2.0, -1.0, 0.0, 1.0, 2.0])
    text = xfoil.build_script(order, _conditions(mach=0.3, ncrit=5, xtr_top=0.1, xtr_bottom=0.4))
    assert text.endswith("PACC\n\nQUIT\n")
    script = text.splitlines()
    assert script[:3] == ["PLOP", "G", ""]
    assert script[3:6] == ["LOAD airfoil.dat", "PANE", "OPER"]
    # Every condition reaches XFOIL, before the first angle.
    first_alfa = next(i for i, line in enumerate(script) if line.startswith("ALFA"))
    for line in ("VISC 1000000", "MACH 0.3", f"ITER {xfoil.ITERATIONS}", "N 5", "XTR 0.1 0.4"):
        assert line in script, line
        assert script.index(line) < first_alfa, line
    assert script.index("VPAR") < script.index("N 5") < script.index("XTR 0.1 0.4")
    alfa = [line for line in script if line.startswith("ALFA")]
    assert alfa == ["ALFA 0", "ALFA 1", "ALFA 2", "ALFA -1", "ALFA -2", "ALFA -3", "ALFA -4"]
    # The boundary layer starts again once, where the sweep turns back to the lower
    # angles; the rest of the downward leg starts from its converged neighbour.
    assert script.count("INIT") == 1
    assert script[script.index("ALFA -1") - 1] == "INIT"


def test_no_init_when_the_sweep_never_turns_back():
    script = xfoil.build_script(xfoil.sweep_order([2.0, 3.0, 4.0]), _conditions()).splitlines()
    assert "INIT" not in script
    for alphas in ([-6.0, -5.0], [-6.0, -5.0, -4.0], [-0.5, 0.5], [-2.0, -1.0, 0.0]):
        script = xfoil.build_script(xfoil.sweep_order(alphas), _conditions()).splitlines()
        assert "INIT" not in script, alphas
    script = xfoil.build_script(xfoil.sweep_order([-2.0, -1.0, 0.0, 1.0]), _conditions()).splitlines()
    assert script.count("INIT") == 1 and script[script.index("ALFA -1") - 1] == "INIT"


def test_sweep_order_starts_nearest_zero():
    assert xfoil.sweep_order([-4, -3, -2, -1, 0, 1, 2]) == [0, 1, 2, -1, -2, -3, -4]
    assert xfoil.sweep_order([2, 3, 4]) == [2, 3, 4]
    assert xfoil.sweep_order([-6, -5]) == [-5, -6]
    assert xfoil.sweep_order([-0.5, 0.5]) == [0.5, -0.5]


def test_polar_and_cp_files_are_read():
    rows = xfoil.parse_polar(POLAR_699)
    assert rows == [
        {"alpha": 0.0, "cl": 0.2401, "cd": 0.00586, "cdp": 0.00104, "cm": -0.053, "top_xtr": 0.6433, "bot_xtr": 0.9894},
        {"alpha": 1.0, "cl": 0.3505, "cd": 0.00599, "cdp": 0.00113, "cm": -0.0532, "top_xtr": 0.6064, "bot_xtr": 1.0},
    ]
    assert xfoil.parse_polar("no polar here") == []
    cp = xfoil.parse_cp("#    x        Cp  \n  1.00000   0.25000\n  0.50000  -0.40000\n")
    assert cp == {"x": [1.0, 0.5], "cp": [0.25, -0.4]}
    cp3 = xfoil.parse_cp("#    x          y          Cp\n  1.0  0.0  0.2\n")
    assert cp3 == {"x": [1.0], "cp": [0.2]}


def _run(tmp_path, fake, alphas, **kw):
    sec = naca.generate("2412")
    return xfoil.run(sec.name, sec.x, sec.y, alphas, _conditions(), tmp_path / "run", exe=fake, **kw)


def test_run_reads_the_polar_and_lists_every_alpha_that_did_not_converge(tmp_path, fake_xfoil, monkeypatch):
    monkeypatch.setenv("FAKE_XFOIL_FAIL", "8,10")
    log = tmp_path / "commands.txt"
    monkeypatch.setenv("FAKE_XFOIL_LOG", str(log))
    seen = []
    alphas = [float(a) for a in range(-4, 11)]
    got = _run(tmp_path, fake_xfoil, alphas, on_progress=lambda done, a, total: seen.append((done, a, total)))
    assert [r["alpha"] for r in got.rows] == [a for a in alphas if a not in (8.0, 10.0)]
    assert got.not_converged == [8.0, 10.0]
    assert got.failed_reported == 2
    assert xfoil.describe_not_converged(got.not_converged) == ["α = 8°: did not converge", "α = 10°: did not converge"]
    row4 = next(r for r in got.rows if r["alpha"] == 4.0)
    assert row4["cl"] == pytest.approx(0.11 * 6.1, abs=1e-4)
    assert row4["cl_cd"] == pytest.approx(row4["cl"] / row4["cd"], rel=1e-4)
    # One progress call per α, in the order XFOIL ran them, the failed ones included.
    assert [s[0] for s in seen] == list(range(1, 16))
    assert [s[1] for s in seen] == xfoil.sweep_order(alphas)
    assert all(s[2] == 15 for s in seen)
    # Cp(x) comes back for the converged angles only.
    assert sorted(got.cp, key=float) == [xfoil._fmt(a) for a in alphas if a not in (8.0, 10.0)]
    assert len(got.cp["4"]["x"]) == 161
    sent = log.read_text(encoding="utf-8").splitlines()
    assert sent[:3] == ["PLOP", "G", ""]


def test_an_angle_with_more_than_three_decimals_is_matched_to_xfoils_echo(tmp_path, fake_xfoil):
    """XFOIL writes α with 3 decimals. k/16° angles (0.0625, 3.8125) sit exactly on the
    rounding tie, so a 5e-4 tolerance called them "did not converge" though they had."""
    alphas = [0.0625, 0.1875, 3.8125, -3.5625]
    got = _run(tmp_path, fake_xfoil, alphas)
    assert got.not_converged == []
    assert len(got.rows) == 4
    assert len(got.cp) == 4
    assert [r["alpha"] for r in got.rows] == sorted(round(a, 3) for a in alphas)


def test_alpha_is_sent_as_xfoil_writes_it_and_matched_with_room():
    """Both halves of the fix on their own: α goes to XFOIL with 3 decimals, and the
    match tolerates a 3-decimal echo yet stays far below the smallest step (0.05°)."""
    assert xfoil.sweep_order([0.0625, 1.0, -3.8125]) == [0.062, 1.0, -3.812]
    assert "ALFA 0.062" in xfoil.build_script(xfoil.sweep_order([0.0625]), _conditions()).splitlines()
    assert xfoil.sweep_order([1.0, 1.0004]) == [1.0]
    assert xfoil._match(0.0625, [0.062]) and xfoil._match(-3.8125, [-3.813])
    assert not xfoil._match(0.0, [0.05]) and not xfoil._match(0.0, [-0.05])


def test_progress_arrives_while_xfoil_runs(tmp_path, fake_xfoil, monkeypatch):
    monkeypatch.setenv("FAKE_XFOIL_DELAY", "0.3")
    stamps = []
    t0 = time.perf_counter()
    got = _run(tmp_path, fake_xfoil, [0.0, 1.0, 2.0, 3.0], on_progress=lambda d, a, t: stamps.append(time.perf_counter() - t0), poll_s=0.05)
    assert len(got.rows) == 4
    assert len(stamps) == 4
    # Not all at the end: the first α was reported well before the last one finished.
    assert stamps[-1] - stamps[0] > 0.5


def test_graphics_left_on_is_caught_by_the_stand_in(tmp_path, fake_xfoil, monkeypatch):
    """Fail-proof for the PLOP / G check: a session without it ends the stand-in with an error."""
    sec = naca.generate("2412")
    work = tmp_path / "raw"
    work.mkdir()
    (work / "airfoil.dat").write_text("NACA 2412\n" + "\n".join(f"{x} {y}" for x, y in zip(sec.x, sec.y, strict=True)), encoding="ascii")
    script = xfoil.build_script([0.0], _conditions()).replace("PLOP\nG\n\n", "", 1)
    done = subprocess.run(fake_xfoil, input=script, cwd=str(work), capture_output=True, text=True, timeout=60)
    assert done.returncode == 3 and "graphics window would open" in done.stdout


@pytest.mark.parametrize("dropped", ["PANE", "VISC 1000000", "MACH 0.3", f"ITER {xfoil.ITERATIONS}"])
def test_a_session_missing_a_setting_is_caught_by_the_stand_in(tmp_path, fake_xfoil, dropped):
    """Fail-proof for the session's settings: without PANE, VISC, MACH or ITER the real
    XFOIL would quietly run on its defaults; the stand-in refuses (exit 6)."""
    sec = naca.generate("2412")
    work = tmp_path / "raw"
    work.mkdir()
    (work / "airfoil.dat").write_text("NACA 2412\n" + "\n".join(f"{x} {y}" for x, y in zip(sec.x, sec.y, strict=True)), encoding="ascii")
    lines = xfoil.build_script([0.0], _conditions(mach=0.3)).split("\n")
    lines.remove(dropped)
    whole = subprocess.run(fake_xfoil, input=xfoil.build_script([0.0], _conditions(mach=0.3)), cwd=str(work), capture_output=True, text=True, timeout=60)
    assert whole.returncode == 0, whole.stdout
    done = subprocess.run(fake_xfoil, input="\n".join(lines), cwd=str(work), capture_output=True, text=True, timeout=60)
    assert done.returncode == 6, done.stdout


def test_time_limit_stops_xfoil_and_what_it_started(tmp_path, fake_xfoil, monkeypatch):
    child_file = tmp_path / "child.pid"
    monkeypatch.setenv("FAKE_XFOIL_HANG", "1")
    monkeypatch.setenv("FAKE_XFOIL_CHILD", str(child_file))
    t0 = time.perf_counter()
    with pytest.raises(xfoil.XfoilError, match=r"ran longer than 3 s and was stopped"):
        _run(tmp_path, fake_xfoil, [0.0, 1.0], timeout_s=3)
    assert time.perf_counter() - t0 < 30
    pid = int(child_file.read_text(encoding="ascii"))
    assert not _alive(pid), "the stand-in's child process outlived the time limit"


def _alive(pid: int) -> bool:
    for _ in range(50):
        if sys.platform == "win32":
            out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
            alive = str(pid) in out
        else:
            try:
                os.kill(pid, 0)
                alive = True
            except OSError:
                alive = False
        if not alive:
            return False
        time.sleep(0.1)
    return True


def test_missing_program_says_so(tmp_path, monkeypatch):
    monkeypatch.setattr(xfoil, "default_exe", lambda: tmp_path / "nothing" / "xfoil.exe")
    sec = naca.generate("2412")
    with pytest.raises(xfoil.XfoilError, match=r"XFOIL is missing from this copy of the Airfoil plugin \(xfoil/bin/xfoil.exe\)"):
        xfoil.run(sec.name, sec.x, sec.y, [0.0], _conditions(), tmp_path / "w")


def test_the_windows_program_is_refused_elsewhere_with_the_reason(tmp_path, monkeypatch):
    exe = tmp_path / "xfoil.exe"
    exe.write_bytes(b"MZ")
    monkeypatch.setattr(xfoil, "default_exe", lambda: exe)
    monkeypatch.setattr(xfoil.sys, "platform", "linux")
    assert xfoil.unavailable_reason() == "XFOIL ships as a Windows program (xfoil.exe), so it runs on Windows only."
    sec = naca.generate("2412")
    with pytest.raises(xfoil.XfoilError, match="runs on Windows only"):
        xfoil.run(sec.name, sec.x, sec.y, [0.0], _conditions(), tmp_path / "w")
    monkeypatch.setattr(xfoil.sys, "platform", "win32")
    assert xfoil.unavailable_reason() is None


def _dat_points(path: Path) -> list[tuple[float, float]]:
    return [tuple(float(v) for v in ln.split()) for ln in path.read_text(encoding="ascii").splitlines()[1:] if ln.strip()]


@pytest.mark.parametrize("pps", [151, 200, 250])
def test_a_fine_section_is_thinned_for_xfoil_keeping_its_ends(tmp_path, fake_xfoil, pps):
    """Points per side above 150 (up to 250 in the page) give more than XFOIL's 300."""
    sec = naca.generate("2412", pps)
    got = xfoil.run(sec.name, sec.x, sec.y, [0.0, 4.0], _conditions(), tmp_path / "run", exe=fake_xfoil)
    assert [r["alpha"] for r in got.rows] == [0.0, 4.0]
    sent = _dat_points(tmp_path / "run" / xfoil.DAT_NAME)
    assert len(sec.x) > xfoil.MAX_INPUT_POINTS >= len(sent) >= xfoil.MAX_INPUT_POINTS - 2
    assert sent[0] == pytest.approx((sec.x[0], sec.y[0]), abs=1e-6)
    assert sent[-1] == pytest.approx((sec.x[-1], sec.y[-1]), abs=1e-6)
    assert min(p[0] for p in sent) == pytest.approx(min(sec.x), abs=1e-6)  # the leading edge kept


def test_job_runs_an_imported_section_of_600_points(project, fake_xfoil):
    """An imported .dat may hold up to 1000 points: the job thins it and runs."""
    data, scope, sid = project
    import airfoil_service as svc

    sec = naca.generate("4412", 250)
    fine = [(sec.x[i], sec.y[i]) for i in range(0, len(sec.x))]
    # 499 points from the formula, and one more in every fourth gap: about 620, still a section.
    pts = []
    for (x0, y0), (x1, y1) in zip(fine[:-1], fine[1:], strict=True):
        pts.append((x0, y0))
        if len(pts) % 5 == 0:
            pts.append(((x0 + x1) / 2, (y0 + y1) / 2))
    pts.append(fine[-1])
    assert 600 <= len(pts) <= 630
    text = "Fine 4412\n" + "".join(f"{x:.7f} {y:.7f}\n" for x, y in pts)
    got = svc.import_dat({"study_id": sid, "text": text, "filename": "fine.dat"}, scope)
    assert got["ok"] is True, got
    data.update_study(sid, {"airfoil": got["airfoil"], "conditions": {"alpha_start": 0, "alpha_end": 4, "alpha_step": 2}}, 1)
    ev = Events()
    assert xfoil_polar.run_job(sid, data, exe=fake_xfoil, emit_fn=ev) == 0, ev.items
    assert ev.kinds("result")[0]["converged"] == 3
    assert store.read_result(data, sid, "xfoil")["name"] == "Fine 4412"


def test_a_program_that_cannot_start_is_reported_by_the_job(project, tmp_path, monkeypatch):
    """A blocked or broken xfoil.exe: an XfoilError with the reason, and the job's error event."""
    data, _scope, sid = project
    missing = [str(tmp_path / "no-such-folder" / "xfoil.exe")]
    sec = naca.generate("2412")
    with pytest.raises(xfoil.XfoilError, match="XFOIL could not be started: "):
        xfoil.run(sec.name, sec.x, sec.y, [0.0], _conditions(), tmp_path / "w", exe=missing)

    def refuse(*_a, **_k):
        raise PermissionError("Access is denied")

    monkeypatch.setattr(xfoil, "run_exe", refuse)
    ev = Events()
    assert xfoil_polar.run_job(sid, data, exe=[sys.executable, "-c", "pass"], emit_fn=ev) == 1
    assert ev.kinds("error") == [{"event": "error", "message": "XFOIL could not be started: Access is denied"}]
    assert store.read_result(data, sid, "xfoil") is None


def test_no_polar_file_is_an_error_with_xfoils_last_words(tmp_path):
    quits = [sys.executable, "-c", "print('Airfoil file not found'); import sys; sys.stdin.read()"]
    with pytest.raises(xfoil.XfoilError, match="XFOIL wrote no polar. Its last output: Airfoil file not found"):
        _run(tmp_path, quits, [0.0])


# -- the job ----------------------------------------------------------------


class Events:
    def __init__(self):
        self.items = []

    def __call__(self, event, **fields):
        self.items.append({"event": event, **fields})

    def kinds(self, kind):
        return [e for e in self.items if e["event"] == kind]


def test_job_saves_the_polar_in_the_study(project, fake_xfoil, monkeypatch):
    data, _scope, sid = project
    data.update_study(sid, {"airfoil": {"source": "naca", "code": "0012"}, "conditions": {"alpha_start": 0, "alpha_end": 12, "alpha_step": 2}}, 1)
    monkeypatch.setenv("FAKE_XFOIL_FAIL", "12")
    ev = Events()
    assert xfoil_polar.run_job(sid, data, exe=fake_xfoil, emit_fn=ev) == 0
    progress = ev.kinds("progress")
    assert [p["done"] for p in progress] == [1, 2, 3, 4, 5, 6, 7]
    assert progress[-1]["fraction"] == 1.0
    assert [e["line"] for e in ev.kinds("log")] == ["α = 12°: did not converge"]
    result = ev.kinds("result")[0]
    assert result == {"event": "result", "engine": "xfoil", "total": 7, "converged": 6, "not_converged": [12.0]}
    saved = store.read_result(data, sid, "xfoil")
    assert saved["name"] == "NACA 0012"
    assert saved["not_converged"] == [12.0]
    assert [r["alpha"] for r in saved["rows"]] == [0.0, 2.0, 4.0, 6.0, 8.0, 10.0]
    assert saved["conditions"]["alpha_end"] == 12.0
    assert saved["airfoil"]["code"] == "0012"
    assert ev.kinds("error") == []


def test_job_on_a_deleted_study_reports_an_error(project, fake_xfoil):
    data, _scope, sid = project
    data.delete_study(sid)
    ev = Events()
    assert xfoil_polar.run_job(sid, data, exe=fake_xfoil, emit_fn=ev) == 1
    assert ev.kinds("error")[0]["message"].startswith("no study")


def test_job_tool_command_line(project, tmp_path):
    """The job as the host starts it: its own folder as cwd, the project from the environment."""
    data, _scope, sid = project
    plugin = Path(xfoil_polar.__file__).resolve().parents[1]
    env = dict(os.environ)
    env.update(MAGNUSIM_PROJECT_DIR=str(data.project_dir), MAGNUSIM_PLUGIN_KEY="airfoil", MAGNUSIM_JOB_ID="job-1")
    sdk = plugin.parents[1] / "python" / "sdk"
    env["PYTHONPATH"] = str(sdk) + os.pathsep + env.get("PYTHONPATH", "")
    done = subprocess.run(
        [sys.executable, "jobs/xfoil_polar.py", "--study-id", sid], cwd=str(plugin), env=env, capture_output=True, text=True, timeout=120
    )
    lines = [json.loads(ln.split(" ", 1)[1]) for ln in done.stdout.splitlines() if ln.startswith("MAGNUSIM_EVENT ")]
    assert lines[0] == {"event": "stage", "stage": "prepare", "label": "Preparing the polar"}
    # The job finds the shipped program by itself (no path given): it runs on Windows,
    # and says why not elsewhere.
    assert (plugin / "xfoil" / "bin" / "xfoil.exe").is_file()
    if sys.platform == "win32":
        assert done.returncode == 0, done.stdout + done.stderr
        assert lines[-1] == {"event": "result", "engine": "xfoil", "total": 15, "converged": 15, "not_converged": []}
        assert sum(1 for e in lines if e["event"] == "progress") == 15
    else:
        assert done.returncode == 1
        assert lines[-1]["event"] == "error"
        assert "runs on Windows only" in lines[-1]["message"]
