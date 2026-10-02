"""Shared fixtures for cfddesk Phase 0 tests."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parent / "fixtures"
PROJECTS = FIXTURES / "projects"
_JOB_ID_BEFORE = pytest.StashKey[str]()


def _job_id() -> str:
    # Only a real id matters: an empty value matches no process.
    return os.environ.get("MAGNUSIM_JOB_ID") or ""


@pytest.hookimpl(wrapper=True)
def pytest_runtest_setup(item):
    item.stash[_JOB_ID_BEFORE] = _job_id()
    return (yield)


@pytest.hookimpl(wrapper=True)
def pytest_runtest_teardown(item, nextitem):
    """A test that runs a relay or job in this process must give MAGNUSIM_JOB_ID back:
    a later kill by job id (foam_relay_ctl) ends every process carrying it, other pytest
    runs on this PC included. Checked after every fixture (monkeypatch too) is undone."""
    result = yield
    after = _job_id()
    if after and after != item.stash.get(_JOB_ID_BEFORE, ""):
        raise AssertionError(f"MAGNUSIM_JOB_ID left set to {after!r}")
    return result


@pytest.fixture(autouse=True)
def _own_local_json(request, tmp_path_factory, monkeypatch):
    """Each test reads an empty local JSON of its own, never this PC's settings: a
    plugin turned on in the app (plugins.enabled) would otherwise leak into the plugin
    tests. A test may still name its own file with either variable (this one uses the
    lower-precedence CFDDESK_LOCAL_JSON, so any test's choice wins). WSL tests keep the
    PC's file, which holds the toolchain settings they need."""
    if request.node.get_closest_marker("wsl"):
        return
    monkeypatch.delenv("MAGNUSIM_LOCAL_JSON", raising=False)
    monkeypatch.setenv("CFDDESK_LOCAL_JSON", str(tmp_path_factory.mktemp("local") / ".magnusim-local.json"))


@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES


@pytest.fixture
def tmp_case_dir(tmp_path: Path) -> Path:
    case = tmp_path / "case"
    (case / "0").mkdir(parents=True)
    (case / "constant").mkdir()
    (case / "system").mkdir()
    return case


@pytest.fixture
def sample_project_dict() -> dict:
    return json.loads((PROJECTS / "v13.json").read_text(encoding="utf-8"))


@pytest.fixture
def elbow_step_path() -> Path:
    p = FIXTURES / "elbow.step"
    if not p.is_file():
        pytest.skip("elbow.step fixture missing")
    return p


@pytest.fixture
def update_golden() -> bool:
    return os.environ.get("CFDDESK_UPDATE_GOLDEN", "").strip() in ("1", "true", "yes")


def normalize_foam(text: str) -> str:
    lines = []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("// *") or set(s) <= set("/* "):
            continue
        if "Date:" in line or "timestamp" in line.lower():
            continue
        lines.append(line.rstrip())
    return "\n".join(lines).strip() + "\n"


def compare_or_update(got: Path, golden: Path, *, update: bool) -> None:
    text = normalize_foam(got.read_text(encoding="utf-8"))
    if update:
        golden.parent.mkdir(parents=True, exist_ok=True)
        golden.write_text(text, encoding="utf-8")
        return
    assert golden.is_file(), f"missing golden {golden}"
    assert text == golden.read_text(encoding="utf-8"), f"mismatch vs {golden.name}"


def pytest_runtest_logreport(report):
    """On GitHub Actions, a failed test is also written as an error annotation, readable
    on the run page and through the API without signing in (the step log is not)."""
    if not os.environ.get("GITHUB_ACTIONS") or not report.failed:
        return
    path, line = report.location[0], (report.location[1] or 0) + 1
    text = str(report.longrepr)
    last = [ln for ln in text.splitlines() if ln.strip()][-1:] or [""]
    msg = f"{report.nodeid} ({report.when}): {last[0]}"
    msg = msg.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    print(f"\n::error file=magnusim-web/python/{path},line={line}::{msg}", flush=True)
