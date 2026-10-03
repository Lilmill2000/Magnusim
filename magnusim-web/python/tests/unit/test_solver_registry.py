"""Phase 2 land3-fix: SolverApp registry + OpenFOAM builtins + load_all validation."""

from __future__ import annotations

from pathlib import Path

import pytest

from cfddesk.registry import (
    RegistryError,
    SolverApp,
    get_registry,
    load_all,
    reset_for_tests,
    validate_analysis_solver_refs,
)
from cfddesk.registry.analysis import DEFAULT_STEADY_KEY, DEFAULT_TRANSIENT_KEY
from cfddesk.registry.discovery import get_hub, plugin_catalog

EXPECTED_SOLVER_KEYS = {"simpleFoam", "pimpleFoam"}


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_for_tests()
    yield
    reset_for_tests()


def test_project_settings_name_no_solver_backend():
    """The old solver block is opaque legacy data: project.settings has no
    SolverBackend (or solver settings class), and the registry's solver type is
    SolverApp."""
    from cfddesk import registry as reg_mod
    from cfddesk.project import settings

    assert not hasattr(settings, "SolverBackend")
    assert not hasattr(settings, "SolverSettings")
    assert hasattr(reg_mod, "SolverApp")
    assert not hasattr(reg_mod, "SolverBackend")


def test_load_all_registers_solver_keys():
    hub = load_all()
    reg = get_registry("solver")
    assert set(reg.keys()) == EXPECTED_SOLVER_KEYS
    assert hub.registry("solver") is reg


def test_solver_specs_shape():
    load_all()
    reg = get_registry("solver")
    simple = reg.get("simpleFoam")
    assert isinstance(simple, SolverApp)
    assert simple.application == "simpleFoam"
    assert simple.time_dependency == "steady"
    assert simple.parallel == "mpirun"
    assert simple.stop_strategy == "stopAt_writeNow"
    assert simple.script_template == "solve"

    pimple = reg.get("pimpleFoam")
    assert pimple.application == "pimpleFoam"
    assert pimple.time_dependency == "transient"
    assert pimple.parallel == "mpirun"


def test_analysis_solver_backends_resolve_from_registry():
    load_all()
    solver_keys = set(get_registry("solver").keys())
    analysis = get_registry("analysis")
    steady = analysis.get(DEFAULT_STEADY_KEY)
    transient = analysis.get(DEFAULT_TRANSIENT_KEY)
    for key in steady.solver_backends:
        assert key in solver_keys
    for key in transient.solver_backends:
        assert key in solver_keys
    assert steady.default_solver in solver_keys
    assert transient.default_solver in solver_keys
    # Explicit product mapping from land2
    assert "simpleFoam" in steady.solver_backends
    assert steady.solver_backends == ("simpleFoam",)
    assert transient.solver_backends == ("pimpleFoam",)


def test_validate_analysis_solver_refs_raises_on_unknown():
    load_all()
    hub = get_hub()
    # Corrupt: inject analysis with unknown solver bag key
    from dataclasses import replace

    bad = replace(
        get_registry("analysis").get("incompressible_steady"),
        key="incompressible_steady_bad",
        solver_backends=("notARealSolver",),
        default_solver="notARealSolver",
    )
    hub.registry("analysis").register(bad, plugin="builtin")
    with pytest.raises(RegistryError, match="unknown solver"):
        validate_analysis_solver_refs(hub)


def test_load_all_isolates_plugin_analysis_with_unknown_solver(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A plugin AnalysisType with an unknown solver key unloads that plugin only."""
    plugins = tmp_path / "plugins" / "badsolver"
    plugins.mkdir(parents=True)
    (plugins / "manifest.toml").write_text(
        'key = "badsolver"\nname = "Bad Solver Refs"\nversion = "0.1.0"\n',
        encoding="utf-8",
    )
    (plugins / "plugin.py").write_text(
        """
from dataclasses import dataclass
from cfddesk.registry.manifest import PluginManifest

@dataclass(frozen=True)
class Spec:
    key: str
    label: str
    solver_backends: tuple = ()
    default_solver: str = ""

def register(hub):
    hub.registry("analysis").register(
        Spec(
            key="plugin_bad_analysis",
            label="Bad",
            solver_backends=("totallyFakeSolver",),
            default_solver="totallyFakeSolver",
        ),
        plugin="badsolver",
    )
    return PluginManifest(key="badsolver", name="Bad Solver Refs", version="0.1.0")
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("CFDDESK_WEB_ROOT", str(tmp_path))
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(tmp_path / "plugins"))
    reset_for_tests()
    # gate:h6-bad-plugin-isolated: the bad plugin is unloaded and listed as an
    # error; builtins keep loading instead of the whole registry failing.
    hub = load_all(web_root=tmp_path)
    assert "plugin_bad_analysis" not in hub.registry("analysis").keys()
    assert "incompressible_steady" in hub.registry("analysis").keys()
    assert "badsolver" not in hub.manifests
    failed = {row["key"]: row for row in hub.failures}
    assert "unknown solver" in failed["badsolver"]["error"]
    rows = {row["key"]: row for row in plugin_catalog(tmp_path)}
    assert rows["badsolver"]["status"] == "error"


def test_describe_solver_includes_requires():
    load_all()
    desc = {d["key"]: d for d in get_registry("solver").describe()}
    assert desc["simpleFoam"]["plugin"] == "incompressible_flow"
    assert desc["simpleFoam"]["label"]
    assert desc["simpleFoam"].get("requires")


def test_load_all_idempotent_solvers():
    load_all()
    load_all()
    load_all(force=True)
    assert set(get_registry("solver").keys()) == EXPECTED_SOLVER_KEYS
