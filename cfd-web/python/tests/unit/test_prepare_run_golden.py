"""Golden equivalence: prepare_run / web_case vs fixtures/golden/js_steady|js_transient."""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from cfddesk.case.web_case import write_web_solve_case
from cfddesk.project.web_adapter import load_run_spec
from tests.conftest import GOLDEN, normalize_foam

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "js-project"

# Files present in both js_steady and js_transient goldens
GOLDEN_NAMES = (
    "U",
    "p",
    "k",
    "omega",
    "nut",
    "transportProperties",
    "turbulenceProperties",
    "controlDict",
    "fvSchemes",
    "fvSolution",
)


def _collapse_ws(text: str) -> str:
    """Strip // comments, collapse whitespace (plan Step 4 normalizer)."""
    lines = []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("//"):
            continue
        if s.startswith("// *") or set(s) <= set("/* "):
            continue
        if "Date:" in line or "timestamp" in line.lower():
            continue
        # collapse internal runs of spaces (JS vs Python padding)
        lines.append(re.sub(r"[ \t]+", " ", line.rstrip()))
    body = "\n".join(lines).strip() + "\n"
    return body


def _sort_functions_blocks(text: str) -> str:
    """Ignore FO key order inside functions { } by sorting top-level FO blocks."""
    m = re.search(r"(functions\s*\{)(.*)(\n\})", text, flags=re.S)
    if not m:
        return text
    head, mid, tail = m.group(1), m.group(2), m.group(3)
    # Split into FO blocks: "    name\n    { ... }"
    blocks = re.findall(
        r"(^[ \t]+[A-Za-z_][\w]*\s*\n[ \t]*\{.*?\n[ \t]*\})",
        mid,
        flags=re.S | re.M,
    )
    if not blocks:
        return text
    # Keep non-block preamble (comments) if any
    sorted_blocks = sorted(blocks, key=lambda b: re.match(r"\s*(\S+)", b).group(1) if re.match(r"\s*(\S+)", b) else b)
    new_mid = "\n" + "\n".join(sorted_blocks) + "\n"
    return text[: m.start()] + head + new_mid + tail + text[m.end() :]


def normalize_prepare_run(text: str) -> str:
    t = normalize_foam(text)
    t = _sort_functions_blocks(t)
    return _collapse_ws(t)


def _relocate_got(case: Path, name: str) -> Path:
    if name in ("U", "p", "k", "omega", "nut"):
        return case / "0" / name
    if name in ("transportProperties", "turbulenceProperties"):
        return case / "constant" / name
    return case / "system" / name


def _assert_golden(case: Path, gdir: Path, *, update: bool) -> list[str]:
    diffs: list[str] = []
    for name in GOLDEN_NAMES:
        got = _relocate_got(case, name)
        golden = gdir / name
        assert got.is_file(), f"missing written file {got}"
        assert golden.is_file(), f"missing golden {golden}"
        if update:
            golden.write_text(normalize_prepare_run(got.read_text(encoding="utf-8")), encoding="utf-8")
            continue
        a = normalize_prepare_run(got.read_text(encoding="utf-8"))
        b = normalize_prepare_run(golden.read_text(encoding="utf-8"))
        if a != b:
            diffs.append(name)
    return diffs


@pytest.mark.parametrize("mode", ["steady", "transient"])
def test_prepare_run_matches_js_golden(tmp_path, update_golden, mode):
    if not (FIX / "boundary_conditions.json").is_file():
        pytest.skip("js-project fixture missing")

    transient_override = None
    if mode == "transient":
        transient_override = {
            "end_time": 5,
            "write_count": 50,
            "time_step_mode": "adjustable",
            "max_co": 1,
            "time_scheme": "Euler",
            "n_outer_correctors": 1,
            "n_correctors": 2,
            "n_non_orth_correctors": 0,
            # Pin auto dt so golden deltaT matches capture (no mesh sizing)
            "delta_t": 0.001,
            "max_delta_t": 0.1,
        }

    spec = load_run_spec(
        FIX,
        run_id=f"run-golden-{mode}",
        require_mesh=False,
        n_procs=1,
        transient_override=transient_override,
    )
    assert spec.ok, spec.error
    if mode == "steady":
        assert spec.solver_app == "simpleFoam"
        assert spec.transient is None
    else:
        assert spec.solver_app == "pimpleFoam"
        assert spec.transient is not None

    case = tmp_path / mode
    result = write_web_solve_case(spec, case)
    assert result["ok"]

    gdir = GOLDEN / ("js_steady" if mode == "steady" else "js_transient")
    diffs = _assert_golden(case, gdir, update=update_golden)
    assert not diffs, f"golden mismatch for {mode}: {diffs}"


def test_prepare_run_cli_json(tmp_path):
    """CLI prints one JSON line and writes case.foam + w27-case.json."""
    import json
    import subprocess
    import sys

    out = tmp_path / "cli_case"
    script = Path(__file__).resolve().parents[2] / "tools" / "prepare_run.py"
    proc = subprocess.run(
        [
            sys.executable,
            str(script),
            "--project-dir",
            str(FIX),
            "--run-id",
            "run-cli",
            "--out-dir",
            str(out),
            "--no-require-mesh",
            "--n-procs",
            "2",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr + proc.stdout
    line = proc.stdout.strip().splitlines()[-1]
    payload = json.loads(line)
    assert payload.get("ok") is True
    assert (out / "case.foam").is_file()
    assert (out / "w27-case.json").is_file()
    assert (out / "system" / "decomposeParDict").is_file()
    assert (out / "system" / "fvOptions").is_file()
