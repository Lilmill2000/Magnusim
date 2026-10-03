"""The service's methods, called as the host calls them (params, scope), and the
service process itself (python -I -m magnusim_sdk.service airfoil_service)."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

import airfoil_service as svc
from airfoil import datfile, naca, settings, store
from airfoil_env import need_plugin_env

PLUGIN_DIR = Path(__file__).resolve().parents[1]
HAS_NEURALFOIL = importlib.util.find_spec("neuralfoil") is not None


def test_check_answers_the_preview(project):
    _data, scope, sid = project
    got = svc.check({"study_id": sid}, scope)
    assert got["ok"] is True
    assert got["airfoil"]["code"] == "2412"
    assert got["alphas"][0] == -4.0 and got["alphas"][-1] == 10.0 and len(got["alphas"]) == 15
    sec = got["section"]
    assert sec["name"] == "NACA 2412" and sec["points"] == 161
    assert sec["thickness"] == pytest.approx(0.12, abs=1e-3)
    assert sec["camber"] == pytest.approx(0.02, abs=5e-4)


def test_check_reports_a_bad_field_as_the_answer(project):
    _data, scope, sid = project
    got = svc.check({"study_id": sid, "airfoil": {"source": "naca", "code": "2490x"}}, scope)
    assert got == {"ok": False, "error": "Enter a NACA 4-digit or 5-digit designation, such as 2412 or 23012.", "field": "code"}
    got = svc.check({"study_id": sid, "conditions": {"re": 5}}, scope)
    assert got["ok"] is False and "Reynolds number" in got["error"] and got["field"] == "re"
    # The field the page sends the user to (its "Fix the inputs first" link), for every check.
    for patch, field in (
        ({"airfoil": {"source": "naca", "code": "2412", "points_per_side": 5}}, "points_per_side"),
        ({"conditions": {"mach": 0.9}}, "mach"),
        ({"conditions": {"alpha_start": "x"}}, "alpha_start"),
        ({"conditions": {"alpha_start": 10, "alpha_end": 0}}, "alpha_end"),
        ({"conditions": {"alpha_start": -30, "alpha_end": 30, "alpha_step": 0.05}}, "alpha_step"),
        ({"conditions": {"alpha_step": 20}}, "alpha_step"),
        ({"conditions": {"ncrit": 20}}, "ncrit"),
        ({"conditions": {"xtr_top": 2}}, "xtr_top"),
        ({"conditions": {"xtr_bottom": -1}}, "xtr_bottom"),
        ({"airfoil": {"source": "stl"}}, None),
    ):
        got = svc.check({"study_id": sid, **patch}, scope)
        assert got["ok"] is False and got["field"] == field, (patch, got)
    got = svc.check({"study_id": sid, "airfoil": {"source": "dat", "name": "x"}}, scope)
    assert got == {"ok": False, "error": "This study's imported airfoil file is missing. Import the .dat file again.", "field": None}


def test_import_dat_saves_the_section_and_check_reads_it_back(project):
    data, scope, sid = project
    sec = naca.generate("4415", 51, closed_te=True)
    text = datfile.write("My 4415", sec.x[::-1], sec.y[::-1])  # lower surface first
    got = svc.import_dat({"study_id": sid, "text": text, "filename": "my4415.dat"}, scope)
    assert got["ok"] is True
    assert got["airfoil"] == {"source": "dat", "name": "My 4415", "file": "airfoil.dat"}
    assert any("reversed" in w for w in got["warnings"])
    saved = data.read_bytes(f"studies/{sid}/airfoil.dat")
    assert saved is not None and saved.decode().startswith("My 4415\n")
    back = svc.check({"study_id": sid, "airfoil": got["airfoil"]}, scope)
    assert back["ok"] is True
    assert back["section"]["x"] == pytest.approx(sec.x, abs=1e-7)


def test_import_dat_refusal_is_the_answer_and_saves_nothing(project):
    data, scope, sid = project
    got = svc.import_dat({"study_id": sid, "text": "Bad\n1 0\nzz 1\n"}, scope)
    assert got["ok"] is False and got["error"].startswith("Line 3:")
    assert data.read_bytes(f"studies/{sid}/airfoil.dat") is None


def test_a_dat_study_without_its_file_says_so(project):
    _data, scope, sid = project
    got = svc.check({"study_id": sid, "airfoil": {"source": "dat", "name": "Gone"}}, scope)
    assert got == {"ok": False, "error": "This study's imported airfoil file is missing. Import the .dat file again.", "field": None}


def test_results_start_empty_and_need_the_study_id(project):
    _data, scope, sid = project
    assert svc.results({"study_id": sid}, scope) == {"neuralfoil": None, "xfoil": None, "openfoam": None}
    with pytest.raises(store.StoreError, match="study_id"):
        svc.results({}, scope)


def test_a_result_for_a_deleted_study_is_not_written(project):
    data, scope, sid = project
    data.delete_study(sid)
    from magnusim_sdk.data import StudyNotFoundError

    with pytest.raises(StudyNotFoundError):
        store.write_result(data, sid, "neuralfoil", {"rows": []})
    assert not (data.root / "studies" / sid).exists()


def test_migrate_study_method(project):
    _data, scope, _sid = project
    got = svc.migrate_study({"study": {"id": "st-x", "airfoil": "23012"}, "from_version": 0, "to_version": 1}, scope)
    assert got["airfoil"]["code"] == "23012" and got["conditions"]["re"] == 1e6


def test_xfoil_status_matches_the_shipped_program(tmp_path, monkeypatch):
    # The plugin ships xfoil.exe (MIT's Windows build): on Windows it is available.
    assert (PLUGIN_DIR / "xfoil" / "bin" / "xfoil.exe").is_file(), "xfoil/bin/xfoil.exe is not shipped"
    got = svc.xfoil_status({}, {})
    if sys.platform == "win32":
        assert got == {"available": True}
    else:
        assert got == {"available": False, "reason": "XFOIL ships as a Windows program (xfoil.exe), so it runs on Windows only."}
    from airfoil import xfoil

    monkeypatch.setattr(xfoil, "default_exe", lambda: tmp_path / "xfoil.exe")
    got = svc.xfoil_status({}, {})
    assert got["available"] is False and got["reason"].startswith("XFOIL is missing from this copy of the Airfoil plugin")


@pytest.mark.skipif(HAS_NEURALFOIL, reason="this interpreter has NeuralFoil; the polar is checked below")
def test_neuralfoil_polar_without_neuralfoil_says_how_to_install_it(project):
    data, scope, sid = project
    got = svc.neuralfoil_polar({"study_id": sid}, scope)
    assert got["ok"] is False
    assert "Install dependencies" in got["error"]
    assert data.read_bytes(f"studies/{sid}/results/neuralfoil.json") is None
    warm = svc.warmup({}, scope)
    assert warm["ready"] is False and "Install dependencies" in warm["error"]


def test_neuralfoil_in_the_plugin_env(tmp_path):
    py = need_plugin_env()
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    env["PYTHONPATH"] = str(PLUGIN_DIR)
    code = (
        "import json; from airfoil import naca, neural, settings;"
        "s = naca.generate('2412');"
        "c = settings.normalize_conditions({});"
        "m = settings.normalize_conditions({'mach': 0.5});"
        "print(json.dumps([neural.evaluate(s.name, s.x, s.y, settings.alpha_list(k), k) for k in (c, m)]))"
    )
    done = subprocess.run([str(py), "-c", code], cwd=str(PLUGIN_DIR), env=env, capture_output=True, text=True, timeout=300)
    assert done.returncode == 0, done.stderr[-2000:]
    low, high = ({r["alpha"]: r for r in rows} for rows in json.loads(done.stdout.strip().splitlines()[-1]))
    assert 0.55 < low[4.0]["cl"] < 0.8
    assert 0.004 < low[4.0]["cd"] < 0.012
    # A condition other than the defaults reaches the network: Mach 0.5 raises the
    # lift slope (compressibility), so Cl at 4° is clearly higher than at Mach 0.
    assert high[4.0]["cl"] > 1.05 * low[4.0]["cl"]


class _Service:
    """The service as the host runs it: ``<env python> -I -m magnusim_sdk.service
    airfoil_service`` in the plugin's folder, one JSON request per line."""

    def __init__(self, python: Path, log: Path):
        self._log = open(log, "w", encoding="utf-8")  # noqa: SIM115 - closed in stop()
        self.proc = subprocess.Popen(
            [str(python), "-I", "-m", "magnusim_sdk.service", "airfoil_service"],
            cwd=str(PLUGIN_DIR),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._log,
            text=True,
            encoding="utf-8",
        )
        self.ready = json.loads(self.proc.stdout.readline())
        self._id = 0

    def call(self, method: str, params: dict, scope: dict) -> tuple[dict, float]:
        """(the result, seconds from sending the request to reading the reply)."""
        self._id += 1
        t0 = time.perf_counter()
        self.proc.stdin.write(json.dumps({"id": self._id, "method": method, "params": {"params": params, "scope": scope}}) + "\n")
        self.proc.stdin.flush()
        reply = json.loads(self.proc.stdout.readline())
        seconds = time.perf_counter() - t0
        assert reply.get("id") == self._id and "result" in reply, reply
        return reply["result"], seconds

    def stop(self) -> None:
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=30)
        finally:
            if self.proc.poll() is None:
                self.proc.kill()
            self._log.close()


WARM_REDRAW_S = 1.0  # gate:h17-e2e: with the service warm, the polar redraws within 1 s


def test_neuralfoil_warm_service_answers_a_polar_within_1_s(project, tmp_path):
    """The real environment, the real service process: warmed up as the workspace does
    when it opens, a new input's check and NeuralFoil polar (what the page asks for on
    each change) come back within 1 s, with NACA 2412's numbers, and are saved."""
    py = need_plugin_env()
    data, scope, sid = project
    service = _Service(py, tmp_path / "service.log")
    try:
        assert service.ready["method"] == "ready", (tmp_path / "service.log").read_text(encoding="utf-8")[-2000:]
        warm, warm_s = service.call("warmup", {}, scope)
        assert warm["ready"] is True, warm
        assert (warm["neuralfoil"], warm["aerosandbox"], warm["numpy"]) == ("0.3.3", "4.2.10", "2.2.6")

        def redraw(airfoil: dict, conditions: dict) -> tuple[dict, float]:
            checked, s1 = service.call("check", {"study_id": sid, "airfoil": airfoil, "conditions": conditions}, scope)
            assert checked["ok"] is True, checked
            polar, s2 = service.call(
                "neuralfoil_polar", {"study_id": sid, "airfoil": checked["airfoil"], "conditions": checked["conditions"]}, scope
            )
            assert polar["ok"] is True, polar
            return polar, s1 + s2

        conditions = settings.normalize_conditions({})
        timings = []
        polar, s = redraw({"source": "naca", "code": "2412"}, conditions)
        timings.append(s)
        rows = {r["alpha"]: r for r in polar["rows"]}
        assert sorted(rows) == [float(a) for a in range(-4, 11)]
        # NACA 2412, Re 1e6: lift-curve slope about 0.1 per degree, zero lift near -2°.
        assert 0.65 < rows[4.0]["cl"] < 0.78
        assert -0.1 < rows[-2.0]["cl"] < 0.1
        assert 0.004 < rows[4.0]["cd"] < 0.012
        assert rows[4.0]["confidence"] > 0.8
        assert polar["model_size"] == "xlarge" and polar["versions"]["neuralfoil"] == "0.3.3"
        saved = store.read_result(data, sid, "neuralfoil")
        assert saved is not None and saved["rows"] == polar["rows"]
        cl_2412 = rows[4.0]["cl"]

        # Input changes, each a full redraw: more camber, then a higher Reynolds number.
        polar, s = redraw({"source": "naca", "code": "4412"}, conditions)
        timings.append(s)
        cl_4412 = next(r["cl"] for r in polar["rows"] if r["alpha"] == 4.0)
        assert cl_4412 > cl_2412 + 0.15
        polar, s = redraw({"source": "naca", "code": "4412"}, settings.normalize_conditions({"re": 3e6}))
        timings.append(s)
        assert polar["conditions"]["re"] == 3e6
        assert store.read_result(data, sid, "neuralfoil")["airfoil"]["code"] == "4412"
        print(f"NeuralFoil service: warm-up {warm_s:.2f} s, warm redraws {[round(x, 3) for x in timings]} s")
        assert max(timings) < WARM_REDRAW_S, f"warm redraws took {[round(x, 3) for x in timings]} s (warm-up {warm_s:.2f} s)"
    finally:
        service.stop()


def test_service_process_starts_and_lists_its_methods(tmp_path):
    """The host's own start line: isolated mode (-I), in the plugin's folder, no cfddesk."""
    env = dict(os.environ)
    done = subprocess.run(
        [sys.executable, "-I", "-m", "magnusim_sdk.service", "airfoil_service"],
        cwd=str(PLUGIN_DIR),
        input="",
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
    )
    first = done.stdout.splitlines()[0] if done.stdout else ""
    if "No module named magnusim_sdk" in done.stderr or "No module named 'magnusim_sdk'" in done.stderr:
        pytest.skip("magnusim_sdk is not installed in this interpreter (the plugin environment gets it)")
    ready = json.loads(first)
    assert ready["method"] == "ready", done.stderr[-2000:]
    assert set(ready["params"]["methods"]) == {
        "check",
        "defaults",
        "export_csv",
        "export_dat",
        "import_dat",
        "migrate_study",
        "neuralfoil_polar",
        "openfoam_collect",
        "openfoam_delete",
        "openfoam_info",
        "openfoam_polar",
        "openfoam_record",
        "results",
        "warmup",
        "xfoil_status",
    }
    assert ready["params"]["methods"]["neuralfoil_polar"]["timeout_s"] == 180
