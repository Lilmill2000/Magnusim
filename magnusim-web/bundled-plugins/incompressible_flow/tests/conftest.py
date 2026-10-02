"""Incompressible Flow's tests: their own settings file, project fixtures and goldens.

Nothing here is loaded from the core's tests (python/tests), so this folder runs on
its own (``pytest`` from the plugin folder) and inside the core's ``pytest`` alike.
The core package itself (cfddesk) is still imported; both pytest configs put it on
the path.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
# Both pytest configs already list the plugin folder; this covers any other way of
# running these tests. Appended, not put first: the plugin folder also has a
# ``tests`` folder, which must not hide the core's ``tests.conftest`` when the core
# runs these tests with its own.
if not any(p and Path(p).resolve() == PLUGIN_ROOT for p in sys.path):
    sys.path.append(str(PLUGIN_ROOT))

FIXTURES = Path(__file__).resolve().parent / "fixtures"
GOLDEN = Path(__file__).resolve().parent / "goldens"
JS_PROJECT = FIXTURES / "js-project"


@pytest.fixture(autouse=True)
def _own_local_json(request, tmp_path_factory, monkeypatch):
    """Each test reads an empty local JSON of its own, never this PC's settings: a
    plugin turned on or off in the app would otherwise leak into these tests. A test
    may still name its own file with either variable (this one uses the
    lower-precedence CFDDESK_LOCAL_JSON, so any test's choice wins). WSL tests keep the
    PC's file, which holds the toolchain settings they need."""
    if request.node.get_closest_marker("wsl"):
        return
    monkeypatch.delenv("MAGNUSIM_LOCAL_JSON", raising=False)
    monkeypatch.setenv("CFDDESK_LOCAL_JSON", str(tmp_path_factory.mktemp("local") / ".magnusim-local.json"))


@pytest.fixture
def update_golden() -> bool:
    return os.environ.get("CFDDESK_UPDATE_GOLDEN", "").strip() in ("1", "true", "yes")


def normalize_foam(text: str) -> str:
    """OpenFOAM dictionary text without its banner, separator and date lines."""
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


def run_spec(project_dir, **kw):
    """The incompressible RunSpec for a project: what the core gathers, as the plugin reads it."""
    from cfddesk.project.run_inputs import gather_run_inputs

    from incompressible_flow.runspec import load_run_spec

    return load_run_spec(gather_run_inputs(project_dir, **kw))
