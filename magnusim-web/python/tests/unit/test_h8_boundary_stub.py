"""H8: the plugin import boundary, and the stub analysis driven only through the contract."""

from __future__ import annotations

import shutil
from pathlib import Path
from types import SimpleNamespace

import plugin_boundary
import pytest

from cfddesk.registry import contract, load_all, reset_for_tests
from cfddesk.registry.discovery import get_registry

WEB = Path(__file__).resolve().parents[3]
STUB = Path(__file__).resolve().parents[1] / "fixtures" / "plugins" / "stub-analysis"


def test_repo_respects_the_boundary():
    """gate:h8-plugin-boundary (the same check the CI job runs)."""
    report = plugin_boundary.run(WEB)
    assert report["ok"], report["problems"]
    assert "python/tests/fixtures/plugins/stub-analysis" in report["plugins"]
    assert "bundled-plugins/incompressible_flow" in report["plugins"]
    assert {
        "python/tests/fixtures/workspace-plugins/ws-demo",
        "python/tests/fixtures/env-plugins/env-demo",
        "python/tests/fixtures/optional-plugins/opt-demo",
        "python/tests/fixtures/kit-plugins/kit-demo",
    } <= set(report["plugins"])


def _web(tmp_path: Path) -> Path:
    web = tmp_path / "web"
    (web / "python" / "cfddesk").mkdir(parents=True)
    (web / "python" / "tools").mkdir(parents=True)
    (web / "bundled-plugins").mkdir()
    return web


def _plugin(parent: Path, name: str, body: str) -> Path:
    d = parent / name
    d.mkdir(parents=True)
    (d / "manifest.toml").write_text(f'key = "{name}"\n', encoding="utf-8")
    (d / "plugin.py").write_text(body, encoding="utf-8")
    return d


def test_boundary_catches_core_imports_in_a_plugin(tmp_path: Path):
    web = _web(tmp_path)
    _plugin(web / "bundled-plugins", "bad", "from cfddesk.project.web_adapter import resolve_mesh\n")
    _plugin(web / "bundled-plugins", "eager", "import numpy\n")
    _plugin(web / "bundled-plugins", "lazy", "def f():\n    import numpy\n    return numpy\n")
    _plugin(web / "bundled-plugins", "fine", "import json\nfrom magnusim_sdk.foam import foam_header\nfrom cfddesk.registry.contract import AnalysisFamily\n")
    report = plugin_boundary.run(web)
    bad = {Path(p["file"]).parent.name: p["problem"] for p in report["problems"]}
    assert set(bad) == {"bad", "eager"}
    assert "cfddesk.project.web_adapter" in bad["bad"] and "inside the function" in bad["eager"]


def test_boundary_catches_the_core_importing_a_bundled_plugin(tmp_path: Path):
    web = _web(tmp_path)
    _plugin(web / "bundled-plugins", "incompressible_flow", "")
    (web / "python" / "cfddesk" / "leak.py").write_text("import incompressible_flow\n", encoding="utf-8")
    report = plugin_boundary.run(web)
    assert [p["problem"] for p in report["problems"]] == ["the core imports a bundled plugin"]


# ---------------------------------------------------------------------------
# The stub analysis (a user plugin the core knows nothing about)
# ---------------------------------------------------------------------------


@pytest.fixture
def stub(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    plugins = tmp_path / "plugins"
    shutil.copytree(STUB, plugins / "stub-analysis")
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(plugins))
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(tmp_path / "local.json"))
    reset_for_tests()
    load_all()
    yield get_registry("analysis").get("stub_diffusion_steady")
    reset_for_tests()


def _ctx(study: dict) -> contract.ReadyContext:
    return contract.ReadyContext(
        project_dir=Path("."), simulation_id="s", run_id="r", mesh_id="m", mesh_case_dir=None,
        patches=("walls",), study=study, read_study=lambda _n: None,
    )


def test_stub_contract(stub):
    assert contract.validate_ready(stub, _ctx({"diffusivity": 0})) == [
        {"message": "Set the diffusivity above 0 m²/s", "fix": {"go": "study"}}
    ]
    assert contract.validate_ready(stub, _ctx({"diffusivity": 1e-3})) == []
    launch = contract.launch_spec(stub, get_registry("solver"))
    assert (launch.app, launch.keep_frames, launch.process_names, launch.frame_fields) == (
        "laplacianFoam", "latest", ("laplacianFoam",), ("T",)
    )
    assert launch.log_parser == contract.GENERIC_LOG_PARSER
    row = {r["key"]: r for r in get_registry("analysis").describe()}["stub_diffusion_steady"]
    assert row["family"]["label"] == "Scalar diffusion (stub)" and row["study_defaults"]["algorithm"] == "Laplacian"
    assert row["study_defaults"]["analysis_title"] == "Scalar diffusion (stub)" and row["study_defaults"]["diffusivity"] == 0.0
    # It declares no kinematic fields (API 1.4): null in describe and in its launch spec.
    assert row["contract"] == "1.4" and row["kinematic_fields"] is None
    assert launch.kinematic_fields is None and launch.to_json()["kinematic_fields"] is None


def test_stub_writes_its_own_case(stub, tmp_path: Path):
    mesh = tmp_path / "mesh"
    poly = mesh / "constant" / "polyMesh"
    poly.mkdir(parents=True)
    (poly / "boundary").write_text(
        "FoamFile\n{\n    version 2.0;\n}\n\n2\n(\n    hot\n    {\n        type patch;\n    }\n    walls\n    {\n        type wall;\n    }\n)\n",
        encoding="utf-8",
    )
    out = tmp_path / "case"
    ctx = SimpleNamespace(
        out_dir=out, mesh_case_dir=mesh, n_procs=2, simulation={"diffusivity": 0.002},
        run_spec=SimpleNamespace(end_time=7, write_interval=7),
    )
    result = stub.write_case(ctx)
    assert result["solver"] == "laplacianFoam" and result["patches"] == ["hot", "walls"]
    t = (out / "0" / "T").read_text(encoding="utf-8")
    assert "hot" in t and "uniform 1" in t and "walls" in t
    assert "DT              0.002;" in (out / "constant" / "transportProperties").read_text(encoding="utf-8")
    cd = (out / "system" / "controlDict").read_text(encoding="utf-8")
    assert "application     laplacianFoam;" in cd and "endTime         7;" in cd
    assert "numberOfSubdomains 2;" in (out / "system" / "decomposeParDict").read_text(encoding="utf-8")
