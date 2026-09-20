"""Phase 2 land12: AnalysisType.write_case goldens via registry (Phase 1 parity).

Calls builtin write_case (wired to write_web_solve_case) and asserts semantic
parity with fixtures/golden/js_steady|js_transient — same as test_prepare_run_golden.
write_case=None is a fail.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from cfddesk.registry import (
    DEFAULT_STEADY_KEY,
    DEFAULT_TRANSIENT_KEY,
    CaseContext,
    get_registry,
    load_all,
    reset_for_tests,
)
from tests.conftest import GOLDEN
from tests.unit.test_prepare_run_golden import _assert_golden

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "js-project"


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_for_tests()
    yield
    reset_for_tests()


@pytest.mark.parametrize(
    "mode,analysis_key",
    [
        ("steady", DEFAULT_STEADY_KEY),
        ("transient", DEFAULT_TRANSIENT_KEY),
    ],
)
def test_registry_write_case_matches_phase1_js_golden(
    tmp_path, update_golden, mode, analysis_key
):
    if not (FIX / "boundary_conditions.json").is_file():
        pytest.skip("js-project fixture missing")

    from cfddesk.project.web_adapter import load_run_spec

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
            "delta_t": 0.001,
            "max_delta_t": 0.1,
        }

    spec = load_run_spec(
        FIX,
        run_id=f"run-write-case-{mode}",
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

    load_all()
    analysis = get_registry("analysis").get(analysis_key)
    assert analysis.write_case is not None, f"{analysis_key}.write_case is None (fail)"
    assert callable(analysis.write_case)

    case = tmp_path / mode
    ctx = CaseContext(
        out_dir=case,
        run_spec=spec,
        mesh_case_dir=Path(spec.mesh_case_dir) if spec.mesh_case_dir else None,
        n_procs=int(spec.n_procs or 1),
    )
    analysis.write_case(ctx)

    gdir = GOLDEN / ("js_steady" if mode == "steady" else "js_transient")
    diffs = _assert_golden(case, gdir, update=update_golden)
    assert not diffs, f"write_case golden mismatch for {mode}/{analysis_key}: {diffs}"


def test_builtin_write_case_not_none():
    load_all()
    reg = get_registry("analysis")
    for key in (DEFAULT_STEADY_KEY, DEFAULT_TRANSIENT_KEY):
        spec = reg.get(key)
        assert spec.write_case is not None, f"{key}.write_case is None (fail)"
        assert callable(spec.write_case)
