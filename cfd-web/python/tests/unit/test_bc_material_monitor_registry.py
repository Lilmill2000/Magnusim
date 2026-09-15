"""Phase 2 land5/land5-fix: BC wrap + MaterialModel + MonitorType registries."""

from __future__ import annotations

from dataclasses import fields, replace
from pathlib import Path

import pytest

from cfddesk.case.bc_registry import BC_TYPES, BcTypeSpec
from cfddesk.case import function_objects as fo
from cfddesk.registry import (
    MaterialModel,
    MonitorType,
    RegistryError,
    get_registry,
    load_all,
    reset_for_tests,
    validate_analysis_bc_refs,
    validate_analysis_material_refs,
    validate_analysis_monitor_refs,
)
from cfddesk.registry.analysis import DEFAULT_STEADY_KEY, DEFAULT_TRANSIENT_KEY
from cfddesk.registry.discovery import get_hub


EXPECTED_MATERIAL_KEYS = {"newtonian_incompressible"}
EXPECTED_MONITOR_KEYS = {"area_average", "flow_rate"}


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_for_tests()
    yield
    reset_for_tests()


def test_fo_monitor_spec_untouched_naming_collision():
    """registry.MonitorType must not replace function_objects.MonitorSpec."""
    assert {"patch", "kind"} <= {f.name for f in fields(fo.MonitorSpec)}
    assert {"key", "label", "target"} <= {f.name for f in fields(MonitorType)}
    assert fo.MonitorSpec is not MonitorType
    assert fo.MonitorKind.__args__ == ("area_average", "flow")


def test_load_all_registers_bc_material_monitor_keys():
    hub = load_all()
    bc = get_registry("bc")
    assert set(bc.keys()) == set(BC_TYPES.keys())
    assert len(bc.keys()) == 22
    # Same objects as product registry (wrap, do not duplicate definitions)
    for key, spec in BC_TYPES.items():
        assert bc.get(key) is spec
        assert isinstance(bc.get(key), BcTypeSpec)

    mat = get_registry("material")
    assert set(mat.keys()) == EXPECTED_MATERIAL_KEYS
    mon = get_registry("monitor")
    assert set(mon.keys()) == EXPECTED_MONITOR_KEYS
    assert hub.registry("bc") is bc


def test_material_spec_shape_and_library():
    load_all()
    spec = get_registry("material").get("newtonian_incompressible")
    assert isinstance(spec, MaterialModel)
    assert spec.label == "Newtonian (incompressible)"
    assert spec.write_files is None
    keys = {f.key for f in spec.properties_schema}
    assert "nu" in keys and "rho" in keys
    lib_keys = {row["key"] for row in spec.library}
    assert {"air", "water", "custom"} <= lib_keys
    assert len(spec.library) >= 8


def test_monitor_spec_shape_and_stubs():
    load_all()
    aa = get_registry("monitor").get("area_average")
    fr = get_registry("monitor").get("flow_rate")
    assert isinstance(aa, MonitorType)
    assert aa.target == "patch"
    assert callable(aa.write_function_object)
    assert callable(aa.parse_dat)
    assert fr.target == "patch"
    assert fr.label == "Flow rate"
    # Stub emits Phase 1-shaped FO body without moving call sites
    body = aa.write_function_object(None, "inlet", "writeControl    timeStep;\n        writeInterval   1;")
    assert "mon_inlet" in body
    assert "areaAverage" in body
    flow_body = fr.write_function_object(None, "outlet", "writeControl    timeStep;\n        writeInterval   1;")
    assert "flow_outlet" in flow_body
    assert "phi" in flow_body


def test_analysis_bags_resolve_from_registries():
    load_all()
    bc_keys = set(get_registry("bc").keys())
    mat_keys = set(get_registry("material").keys())
    mon_keys = set(get_registry("monitor").keys())
    for key in (DEFAULT_STEADY_KEY, DEFAULT_TRANSIENT_KEY):
        spec = get_registry("analysis").get(key)
        for k in spec.bc_types:
            assert k in bc_keys
        for k in spec.material_models:
            assert k in mat_keys
        for k in spec.monitors:
            assert k in mon_keys
        assert "flow_rate" in spec.monitors
        assert "flow" not in spec.monitors
        assert "newtonian_incompressible" in spec.material_models


def test_validate_bc_refs_raises_on_unknown():
    load_all()
    hub = get_hub()
    from cfddesk.builtin.incompressible import build_incompressible_steady

    bad = replace(
        build_incompressible_steady(),
        key="incompressible_steady_bad_bc",
        bc_types=("not_a_real_bc",),
    )
    hub.registry("analysis").register(bad, plugin="builtin")
    with pytest.raises(RegistryError, match="unknown bc"):
        validate_analysis_bc_refs(hub)


def test_validate_material_refs_raises_on_unknown():
    load_all()
    hub = get_hub()
    from cfddesk.builtin.incompressible import build_incompressible_steady

    bad = replace(
        build_incompressible_steady(),
        key="incompressible_steady_bad_mat",
        material_models=("not_a_real_material",),
    )
    hub.registry("analysis").register(bad, plugin="builtin")
    with pytest.raises(RegistryError, match="unknown material"):
        validate_analysis_material_refs(hub)


def test_validate_monitor_refs_raises_on_unknown():
    load_all()
    hub = get_hub()
    from cfddesk.builtin.incompressible import build_incompressible_steady

    bad = replace(
        build_incompressible_steady(),
        key="incompressible_steady_bad_mon",
        monitors=("not_a_real_monitor",),
    )
    hub.registry("analysis").register(bad, plugin="builtin")
    with pytest.raises(RegistryError, match="unknown monitor"):
        validate_analysis_monitor_refs(hub)


def test_load_all_rejects_plugin_analysis_with_unknown_bc(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    plugins = tmp_path / "plugins" / "badbc"
    plugins.mkdir(parents=True)
    (plugins / "manifest.toml").write_text(
        'key = "badbc"\nname = "Bad BC Refs"\nversion = "0.1.0"\n',
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
    bc_types: tuple = ()
    material_models: tuple = ()
    monitors: tuple = ()
    solver_backends: tuple = ("simpleFoam",)
    default_solver: str = "simpleFoam"

def register(hub):
    hub.registry("analysis").register(
        Spec(
            key="plugin_bad_bc_analysis",
            label="Bad",
            bc_types=("totallyFakeBc",),
        ),
        plugin="badbc",
    )
    return PluginManifest(key="badbc", name="Bad BC Refs", version="0.1.0")
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("CFDDESK_WEB_ROOT", str(tmp_path))
    reset_for_tests()
    with pytest.raises(RegistryError, match="unknown bc"):
        load_all(web_root=tmp_path)


def test_existing_bc_registry_api_still_works():
    """Do not rewrite bc_registry call sites ? product helpers stay green."""
    from cfddesk.case.bc_registry import default_settings, get_type, type_labels

    load_all()
    assert get_type("wall_noslip").key == "wall_noslip"
    assert isinstance(default_settings("velocity_inlet_fixed"), dict)
    assert len(type_labels()) == len(BC_TYPES)


def test_load_all_idempotent_bc_material_monitor():
    load_all()
    load_all()
    load_all(force=True)
    assert set(get_registry("bc").keys()) == set(BC_TYPES.keys())
    assert set(get_registry("material").keys()) == EXPECTED_MATERIAL_KEYS
    assert set(get_registry("monitor").keys()) == EXPECTED_MONITOR_KEYS
