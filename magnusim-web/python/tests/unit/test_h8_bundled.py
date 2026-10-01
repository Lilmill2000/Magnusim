"""H8: the bundled plugin tier (required plugins, dependency order, protected keys)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.base import RegistryError
from cfddesk.registry.discovery import get_hub, get_registry, plugin_catalog

WEB = Path(__file__).resolve().parents[3]


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    # A private off list, so a developer's own settings never leak in.
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(tmp_path / "local.json"))
    reset_for_tests()
    yield
    reset_for_tests()


def _plugin(folder: Path, key: str, body: str = "def register(hub):\n    return None\n", **meta) -> Path:
    d = folder / key
    d.mkdir(parents=True)
    lines = [f'key = "{key}"', f'name = "{key.title()}"', 'api_version = "1.1"']
    for k, v in meta.items():
        lines.append(f"{k} = {json.dumps(v)}")
    (d / "manifest.toml").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (d / "plugin.py").write_text(body, encoding="utf-8")
    return d


def test_incompressible_flow_comes_from_the_bundled_plugin():
    hub = load_all()
    m = hub.manifests["incompressible_flow"]
    assert (m.tier, m.required, m.source) == ("bundled", True, "bundled")
    assert get_registry("analysis").owner("incompressible_steady") == "incompressible_flow"
    assert get_registry("solver").owner("pimpleFoam") == "incompressible_flow"
    assert hub.required_failures == []
    row = {r["key"]: r for r in plugin_catalog()}["incompressible_flow"]
    assert (row["tier"], row["required"], row["status"]) == ("bundled", True, "enabled")


def test_the_core_alone_registers_no_simulation_type():
    from cfddesk.builtin import register_builtins
    from cfddesk.registry.discovery import RegistryHub

    hub = RegistryHub()
    register_builtins(hub)
    assert hub.registry("analysis").keys() == [] and hub.registry("solver").keys() == []


def test_missing_required_plugin_is_reported(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """gate:h8-required-plugin-missing (Python side): an empty bundled folder."""
    empty = tmp_path / "empty-bundled"
    empty.mkdir()
    monkeypatch.setenv("MAGNUSIM_BUNDLED_DIR", str(empty))
    hub = load_all()
    assert "incompressible_steady" not in get_registry("analysis").keys()
    [row] = hub.required_failures
    assert row["key"] == "incompressible_flow" and row["name"] == "Incompressible Flow"
    assert str(empty) in row["error"] and row["log"].endswith("plugins.log")
    from cfddesk.worker import methods

    assert methods.registry_describe()["required_missing"][0]["key"] == "incompressible_flow"
    cat = {r["key"]: r for r in plugin_catalog()}["incompressible_flow"]
    assert (cat["status"], cat["required"]) == ("error", True)


def _legacy_study(tmp_path: Path) -> Path:
    """A project with one study saved before analysis keys (no analysis_type)."""
    root = tmp_path / "p"
    study = root / "geometries" / "Geometry_g" / "simulations" / "Study"
    study.mkdir(parents=True)
    (root / "geometries" / "Geometry_g" / "id.json").write_text(json.dumps({"id": "g", "kind": "geometry"}), encoding="utf-8")
    (study / "id.json").write_text(json.dumps({"id": "s1", "kind": "simulation", "time_dependency": "Steady-state"}), encoding="utf-8")
    return root


def test_a_run_without_its_plugin_says_why_it_cannot_start(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """The Run panel's Start gate and the Graphs panel ask the run's analysis.
    Without its plugin they used to fail with a 500 ("analysis ... is not
    installed"), so Start stayed off with no reason and monitors vanished."""
    empty = tmp_path / "empty-bundled"
    empty.mkdir()
    monkeypatch.setenv("MAGNUSIM_BUNDLED_DIR", str(empty))
    load_all()
    from cfddesk.worker import methods

    root = _legacy_study(tmp_path)
    out = methods.analysis_validate_ready(project_dir=str(root), simulation_id="s1", run_id="r1")
    assert out["ok"] is True and out["ready"] is False
    assert out["issues"] == [
        {"message": "Incompressible Flow failed to load, so this run can't start.", "fix": {"go": "plugins"}}
    ]
    mon = methods.analysis_run_monitors(project_dir=str(root), simulation_id="s1", run_id="r1")
    assert mon["ok"] is True and mon["monitors"] == [] and mon["balance"] is None
    assert mon["unavailable"] == "Incompressible Flow failed to load, so this run can't start."


def test_broken_required_plugin_is_reported_with_its_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    bundled = tmp_path / "bundled"
    _plugin(bundled, "incompressible_flow", "raise RuntimeError('boom at import')\n", tier="bundled", required=True)
    monkeypatch.setenv("MAGNUSIM_BUNDLED_DIR", str(bundled))
    hub = load_all()
    assert "boom at import" in hub.required_failures[0]["error"]


def test_required_plugin_ignores_the_off_list_and_cannot_be_turned_off(tmp_path: Path):
    (tmp_path / "local.json").write_text(json.dumps({"plugins": {"disabled": ["incompressible_flow"]}}), encoding="utf-8")
    load_all()
    assert "incompressible_steady" in get_registry("analysis").keys()
    from cfddesk.worker import methods
    from cfddesk.worker.rpc import RpcError

    with pytest.raises(RpcError, match="required and cannot be turned off"):
        methods.plugins_disable(key="incompressible_flow")


def test_dependency_order_cycles_and_versions(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    bundled = tmp_path / "bundled"
    for key in ("incompressible_flow",):
        # The real one, so the app still has its required plugin.
        import shutil

        shutil.copytree(WEB / "bundled-plugins" / key, bundled / key)
    order_body = (
        "import cfddesk.registry.discovery as d\n"
        "def register(hub):\n"
        "    d.__dict__.setdefault('_h8_order', []).append(__name__.rsplit('.', 1)[-1])\n"
    )
    # zz_base is found last alphabetically but loads before aa_user, which requires it.
    _plugin(bundled, "aa_user", order_body, version="1.0.0", requires_plugins=["zz_base>=2.0"])
    _plugin(bundled, "zz_base", order_body, version="2.1.0")
    _plugin(bundled, "too_new", order_body, requires_plugins=["zz_base>=3"])
    _plugin(bundled, "cyc_a", order_body, requires_plugins=["cyc_b"])
    _plugin(bundled, "cyc_b", order_body, requires_plugins=["cyc_a"])
    monkeypatch.setenv("MAGNUSIM_BUNDLED_DIR", str(bundled))
    import cfddesk.registry.discovery as d

    d.__dict__.pop("_h8_order", None)
    hub = load_all()
    order = d.__dict__.pop("_h8_order")
    assert order.index("zz_base") < order.index("aa_user")
    failures = {f["key"]: f["error"] for f in hub.failures}
    assert "needs zz_base >= 3" in failures["too_new"]
    assert "dependency cycle" in failures["cyc_a"] and "dependency cycle" in failures["cyc_b"]
    assert "too_new" not in order and "cyc_a" not in order


def test_bundled_protected_keys(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """PROTECTED_KEYS moved to the owning plugin's manifest (protected = [...])."""
    from cfddesk.registry.base import PROTECTED_KEYS, is_protected

    assert ("analysis", "incompressible_steady") not in PROTECTED_KEYS
    load_all()
    assert is_protected("analysis", "incompressible_steady") and is_protected("solver", "simpleFoam")
    with pytest.raises(RegistryError, match="protected"):
        get_hub().unregister("analysis", "incompressible_steady", plugin="someone")
    # A user plugin cannot take over a key the bundled plugin owns.
    with pytest.raises(RegistryError, match="duplicate key"):
        get_registry("analysis").register(get_registry("analysis").get("incompressible_steady"), plugin="stranger")


def test_user_plugin_may_require_the_bundled_one(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    user = tmp_path / "plugins"
    body = (
        "from dataclasses import replace\n"
        "def register(hub):\n"
        "    base = hub.registry('analysis').get('incompressible_steady')\n"
        "    hub.registry('analysis').register(replace(base, key='mine_steady', label='Mine'), plugin='mine')\n"
    )
    _plugin(user, "mine", body, requires_plugins=["incompressible_flow>=1.0"])
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(user))
    load_all()
    assert "mine_steady" in get_registry("analysis").keys()


def test_the_default_analysis_comes_from_the_required_plugins_manifest(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """The core names no simulation type: the analysis a study gets when none is
    named, and the old "incompressible" study name, are the plugin's manifest's."""
    from cfddesk.registry import (
        DEFAULT_STEADY_KEY,
        DEFAULT_TRANSIENT_KEY,
        LEGACY_ANALYSIS_ALIAS,
        resolve_analysis_key,
    )
    from cfddesk.registry.analysis import default_analysis_key
    from cfddesk.registry.discovery import default_analysis
    from cfddesk.worker import methods

    load_all()
    want = {"steady": "incompressible_steady", "transient": "incompressible_transient", "aliases": ["incompressible"]}
    assert default_analysis() == want
    assert methods.registry_describe()["default_analysis"] == want
    assert (DEFAULT_STEADY_KEY, DEFAULT_TRANSIENT_KEY, LEGACY_ANALYSIS_ALIAS) == (
        "incompressible_steady",
        "incompressible_transient",
        "incompressible",
    )
    assert resolve_analysis_key("Incompressible", transient=True) == "incompressible_transient"
    assert resolve_analysis_key("") == "incompressible_steady"
    # Without the plugin the app has no default analysis to offer.
    empty = tmp_path / "empty-bundled"
    empty.mkdir()
    monkeypatch.setenv("MAGNUSIM_BUNDLED_DIR", str(empty))
    load_all(force=True)
    assert default_analysis() is None and methods.registry_describe()["default_analysis"] is None
    assert default_analysis_key() == ""


def test_only_a_required_bundled_plugin_names_the_default_analysis(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    user = tmp_path / "plugins"
    d = _plugin(user, "grabby")
    with (d / "manifest.toml").open("a", encoding="utf-8") as fh:
        fh.write('default_analysis = { steady = "grabby_steady" }\n')
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(user))
    hub = load_all()
    failed = {row["key"]: row["error"] for row in hub.failures}
    assert "only for a required bundled plugin" in failed["grabby"]
    assert hub.manifests["incompressible_flow"].default_analysis["steady"] == "incompressible_steady"


def test_a_default_analysis_the_plugin_does_not_register_fails_it(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    import shutil

    bundled = tmp_path / "bundled"
    shutil.copytree(WEB / "bundled-plugins" / "incompressible_flow", bundled / "incompressible_flow")
    manifest = bundled / "incompressible_flow" / "manifest.toml"
    manifest.write_text(manifest.read_text(encoding="utf-8").replace('steady = "incompressible_steady"', 'steady = "no_such_steady"'), encoding="utf-8")
    monkeypatch.setenv("MAGNUSIM_BUNDLED_DIR", str(bundled))
    hub = load_all()
    [row] = hub.required_failures
    assert "no_such_steady" in row["error"] and "is not one of its analyses" in row["error"]


def test_siblings_follow_the_family_when_names_do_not_pair():
    """A family whose keys are not <x>_steady / <x>_transient still swaps by
    family; a clone that kept another analysis's family gets no sibling."""
    from dataclasses import replace

    from cfddesk.registry.analysis import analysis_key_for
    from cfddesk.registry.contract import AnalysisFamily

    load_all()
    reg = get_registry("analysis")
    steady, transient = reg.get("incompressible_steady"), reg.get("incompressible_transient")
    fam = AnalysisFamily(key="heat", label="Heat", title="Heat", description="")
    reg.register(replace(steady, key="heat", label="Heat", family=fam), plugin="sib-test")
    reg.register(replace(transient, key="heat_unsteady", label="Heat", family=fam), plugin="sib-test")
    reg.register(replace(steady, key="clone", label="Clone"), plugin="sib-test")
    try:
        assert analysis_key_for("heat", "Transient", reg) == "heat_unsteady"
        assert analysis_key_for("heat_unsteady", "Steady-state", reg) == "heat"
        assert analysis_key_for("clone", "Transient", reg) == "clone"
        assert analysis_key_for("incompressible_steady", "Transient", reg) == "incompressible_transient"
    finally:
        reg.drop_plugin("sib-test")


def test_the_plugins_material_and_monitors_are_protected():
    """Its analyses need them, so no other plugin may drop them."""
    from cfddesk.registry.base import is_protected

    load_all()
    for kind, key in (("material", "newtonian_incompressible"), ("monitor", "area_average"), ("monitor", "flow_rate")):
        assert is_protected(kind, key), (kind, key)
        with pytest.raises(RegistryError, match="protected"):
            get_hub().unregister(kind, key, plugin="someone")


def test_a_required_plugin_unloaded_by_cross_refs_is_reported(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """A user plugin drops a BC type the required analyses use: cross-reference
    validation unloads Incompressible Flow, and the app must say so (it used to
    list nothing, so the page showed an empty picker and no banner)."""
    user = tmp_path / "plugins"
    body = "def register(hub):\n    hub.unregister('bc', 'wall_slip', plugin='dropper')\n"
    _plugin(user, "dropper", body, overrides=["bc:wall_slip"])
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(user))
    hub = load_all()
    assert "incompressible_steady" not in get_registry("analysis").keys()
    [row] = hub.required_failures
    assert row["key"] == "incompressible_flow" and "wall_slip" in row["error"]
    assert row["log"].endswith("plugins.log")
    from cfddesk.worker import methods

    missing = methods.registry_describe()["required_missing"]
    assert [r["key"] for r in missing] == ["incompressible_flow"]
    # Loading again does not add a second row.
    load_all(force=True)
    assert [r["key"] for r in get_hub().required_failures] == ["incompressible_flow"]
