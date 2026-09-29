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
