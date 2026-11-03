"""An old run's "Check its log" (RH1, spec 3.9): the head of the oldest log part and the tail
of the newest, with the middle left out (magnusim_sdk.health.check_log, tools/log_health.py)."""

from __future__ import annotations

import gzip
import json
import subprocess
import sys
from pathlib import Path

from magnusim_sdk.health import check_log, line_key

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "health"
HINTS = json.loads((FIX / "run2.hints.json").read_text(encoding="utf-8"))
TOOL = Path(__file__).resolve().parents[2] / "tools" / "log_health.py"


def _parts(tmp: Path) -> tuple[Path, Path]:
    head = gzip.decompress((FIX / "run2-head.log.gz").read_bytes())
    tail = gzip.decompress((FIX / "run2-tail.log.gz").read_bytes())
    p1 = tmp / "log.pimpleFoam.1"
    p1.write_bytes(head)
    p2 = tmp / "log.pimpleFoam"
    p2.write_bytes(tail)
    return p1, p2


def test_head_and_tail_keep_the_baselines_and_the_onset(tmp_path: Path):
    p1, p2 = _parts(tmp_path)
    rec = check_log([str(p1), str(p2)], HINTS, head_bytes=120_000, tail_bytes=150_000, latest_saved=0.16666667)
    assert rec["verdict"] == "unhealthy"
    assert rec["first_unhealthy"]["t"] == 0.0069061069 and not rec["first_unhealthy"].get("approx")
    assert rec["rates"]["co_max_per_s"] > 8e4
    assert rec["restart"] == "from_zero"
    # log_at is the line's place in the whole log: the earlier part's size added.
    whole = p1.read_bytes() + p2.read_bytes()
    for f in rec["findings"]:
        ev = f.get("evidence")
        if ev:
            end = whole.index(b"\n", ev["log_at"])
            assert line_key(whole[ev["log_at"] : end].decode("utf-8")) == ev["key"]


def test_the_onset_in_the_unread_middle_is_approximate(tmp_path: Path):
    p1, p2 = _parts(tmp_path)
    # The head read ends before step 25: the onset is in the gap.
    rec = check_log([str(p1), str(p2)], HINTS, head_bytes=20_000, tail_bytes=150_000)
    fu = rec["first_unhealthy"]
    assert fu["approx"] is True
    assert fu["t"] < 0.0069061069 < fu["by_t"]


def test_a_missing_head_has_no_onset_and_no_restart(tmp_path: Path):
    _p1, p2 = _parts(tmp_path)
    rec = check_log([str(p2)], HINTS, head_missing=True)
    assert rec["head_missing"] is True
    assert rec["restart"] is None
    assert rec["checked_steps"] > 100


def test_the_tool_reads_the_case_folder(tmp_path: Path):
    _parts(tmp_path)
    (tmp_path / "w27-case.json").write_text(json.dumps({"health_hints": HINTS}), encoding="utf-8")
    r = subprocess.run(
        [sys.executable, str(TOOL), "--case", str(tmp_path), "--app", "pimpleFoam", "--latest-saved", "0.16666667"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
    )
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert out["ok"] is True, out
    assert out["health"]["verdict"] == "unhealthy"
    gone = subprocess.run([sys.executable, str(TOOL), "--case", str(tmp_path / "none"), "--app", "pimpleFoam"], capture_output=True, text=True)
    assert json.loads(gone.stdout)["ok"] is False
    # log.<app>.2 without .1: the head is gone.
    (tmp_path / "log.pimpleFoam.1").rename(tmp_path / "log.pimpleFoam.2")
    r2 = subprocess.run([sys.executable, str(TOOL), "--case", str(tmp_path), "--app", "pimpleFoam"], capture_output=True, text=True, encoding="utf-8")
    assert json.loads(r2.stdout)["health"]["head_missing"] is True


def test_an_onset_well_inside_the_read_tail_is_exact(tmp_path: Path):
    # A healthy run's log, then Run_2's head: the middle of the healthy part is not read, and the
    # problem begins about 300 KB into the tail that is. Its onset is where it is seen, exact.
    healthy = gzip.decompress((FIX / "calib" / "bfs-piso-co1.log.gz").read_bytes())
    head = gzip.decompress((FIX / "run2-head.log.gz").read_bytes())
    p1 = tmp_path / "log.pimpleFoam.1"
    p1.write_bytes(healthy)
    p2 = tmp_path / "log.pimpleFoam"
    p2.write_bytes(head)
    assert len(healthy) > 400_000
    rec = check_log([str(p1), str(p2)], HINTS, head_bytes=100_000, tail_bytes=len(head) + 300_000)
    fu = rec["first_unhealthy"]
    assert not fu.get("approx"), fu
    assert fu["t"] == 0.0069061069
    assert fu["step"] is None  # the steps counted after a gap are not the run's step numbers


def test_the_tree_keeps_a_span_onset_and_whether_a_fix_is_offered():
    # The tree's slim health (tree badge, Start's question when the run is not the open one).
    from cfddesk.project.scope import _run_health

    fix = {"label": "New run: Max Courant 1", "target": "new_run", "values": [{"key": "transient.max_co", "value": 1}]}
    run = {
        "health": {
            "v": 1,
            "verdict": "unhealthy",
            "unit": "time step",
            "first_unhealthy": {"t": 0.0031, "step": None, "wall_s": None, "approx": True, "by_t": 0.0069},
            "findings": [{"code": "courant_mode", "level": "warn", "fix": [fix]}],
        }
    }
    slim = _run_health(run)["health"]
    assert slim == {"verdict": "unhealthy", "unit": "time step", "first_unhealthy": {"t": 0.0031, "approx": True, "by_t": 0.0069}, "has_fix": True}
    run["health"]["findings"] = [{"code": "pv_coupling", "level": "error"}]
    run["health"]["first_unhealthy"] = {"t": 0.0069, "step": 25, "wall_s": 15}
    assert _run_health(run)["health"] == {"verdict": "unhealthy", "unit": "time step", "first_unhealthy": {"t": 0.0069}}
