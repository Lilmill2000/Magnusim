"""Shared fixtures for cfddesk Phase 0 tests."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parent / "fixtures"
PROJECTS = FIXTURES / "projects"
GOLDEN = FIXTURES / "golden"


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
