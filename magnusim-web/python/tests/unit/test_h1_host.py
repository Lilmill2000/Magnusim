"""H1 host contracts.

gate:h1-no-stubs
gate:h1-goldens
gate:h1-override
gate:h1-hook
gate:h1-api-version
"""

from __future__ import annotations

import json
import os
from dataclasses import replace
from pathlib import Path

import pytest

from cfddesk.project.model import Project, _mesh_fingerprint_payload
from cfddesk.registry import API_VERSION, RegistryError, get_hooks, get_hub, get_registry, load_all
from cfddesk.registry.discovery import reset_for_tests
from cfddesk.registry.jobs import JobKind, ensure_tool_in_package

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "js-project"
BUILTIN = Path(__file__).resolve().parents[2] / "cfddesk" / "builtin"


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_for_tests()
    yield
    reset_for_tests()


def _steady_spec():
    from tests.conftest import run_spec as load_run_spec

    spec = load_run_spec(
        FIX,
        run_id="run-h1",
        require_mesh=False,
        n_procs=1,
    )
    assert spec.ok, spec.error
    return spec


def test_gate_h1_no_stubs(tmp_path, sample_project_dict):
    """gate:h1-no-stubs"""
    load_all()
    # A SolverApp names the program; the analysis writes the case (H9).
    for spec in get_registry("solver").items():
        assert spec.application and spec.script_template == "solve"

    project = Project.from_dict(sample_project_dict)
    expected = _mesh_fingerprint_payload(project)
    for spec in get_registry("mesher").items():
        assert spec.fingerprint_payload is not None
        assert spec.generate is not None
        assert spec.fingerprint_payload(project) == expected
        assert spec.multi_region is False
    standard = get_registry("mesher").get("standard")
    snappy = get_registry("mesher").get("snappy_hexdominant")
    assert standard.settings_schema
    assert snappy.settings_schema
    assert standard.generate() == "generate_standard.py"
    assert get_registry("mesher").get("cfmesh").frozen is True
    assert get_registry("mesher").get("cfmesh").generate() == "generate_cfmesh_standard.py"
    assert get_registry("job").get("solve").tool == "solve.sh"
    assert get_registry("job").get(standard.tool).scope == "study"


    plugin = Path(__file__).resolve().parents[3] / "bundled-plugins" / "incompressible_flow" / "incompressible_flow"
    for path in (plugin / "solvers.py", BUILTIN / "meshers.py", plugin / "materials.py"):
        text = path.read_text(encoding="utf-8")
        assert "NOT_yet_done" not in text
    # The word soft-pass is allowed in comments and must not fail this gate.
    solver_src = (
        Path(__file__).resolve().parents[2] / "cfddesk" / "registry" / "solver.py"
    ).read_text(encoding="utf-8")
    assert "soft-pass" in solver_src


def test_gate_h1_override(tmp_path):
    """gate:h1-override"""
    from registry_dump import dump_registry  # noqa: E402

    web = tmp_path / "web"
    plug = web / "plugins" / "h1_override"
    plug.mkdir(parents=True)
    (plug / "manifest.toml").write_text(
        '\n'.join(
            [
                'key = "h1_override"',
                'name = "H1 override"',
                'api_version = "1.0"',
                'overrides = "solver:simpleFoam"',
                "",
            ]
        ),
        encoding="utf-8",
    )
    (plug / "plugin.py").write_text(
        "\n".join(
            [
                "from dataclasses import replace",
                "from cfddesk.registry.base import RegistryError",
                "",
                "def register(hub):",
                "    current = hub.registry('solver').get('simpleFoam')",
                "    hub.replace(",
                "        'solver',",
                "        replace(current, label='H1 override simpleFoam'),",
                "        plugin='h1_override',",
                "    )",
                "    try:",
                "        hub.unregister('mesher', 'cfmesh', plugin='h1_override')",
                "    except RegistryError:",
                "        return None",
                "    raise RuntimeError('cfmesh unregister should have been refused')",
                "",
            ]
        ),
        encoding="utf-8",
    )
    hub = load_all(web_root=web)
    dumped = dump_registry(web_root=web, force=False)
    owners = {row["key"]: row["plugin"] for row in dumped["solver"]}
    assert owners["simpleFoam"] == "h1_override"
    assert get_registry("solver").get("simpleFoam").label == "H1 override simpleFoam"
    assert get_registry("mesher").owner("cfmesh") == "builtin"
    with pytest.raises(RegistryError, match="protected"):
        hub.unregister("mesher", "cfmesh", plugin="h1_override")
    assert "cfmesh" in get_registry("mesher").keys()

    # The test's own settings file (named, so it is the only one read).
    os.environ["CFDDESK_LOCAL_JSON"] = str(web / ".cfddesk-local.json")
    (web / ".cfddesk-local.json").write_text(
        json.dumps({"plugins": {"disabled": ["h1_override"]}}),
        encoding="utf-8",
    )
    reset_for_tests()
    load_all(web_root=web)
    restored = dump_registry(web_root=web, force=False)
    owners = {row["key"]: row["plugin"] for row in restored["solver"]}
    assert owners["simpleFoam"] == "incompressible_flow"
    assert get_registry("mesher").owner("cfmesh") == "builtin"


def test_gate_h1_hook(tmp_path):
    """gate:h1-hook"""
    if not (FIX / "boundary_conditions.json").is_file():
        pytest.skip("js-project fixture missing")
    web = tmp_path / "web"
    plug = web / "plugins" / "h1_hook"
    plug.mkdir(parents=True)
    (plug / "manifest.toml").write_text(
        'key = "h1_hook"\nname = "H1 hook"\napi_version = "1.0"\n',
        encoding="utf-8",
    )
    (plug / "plugin.py").write_text(
        "\n".join(
            [
                "from pathlib import Path",
                "from cfddesk.registry.hooks import get_hooks",
                "",
                "def _on_written(**kwargs):",
                "    ctx = kwargs['ctx']",
                "    path = Path(ctx.out_dir) / 'system' / 'controlDict'",
                "    text = path.read_text(encoding='utf-8')",
                "    if 'h1Probe' in text:",
                "        return",
                "    path.write_text(",
                "        text + '\\nfunctions\\n{\\n    h1Probe\\n    {\\n        type probes;\\n    }\\n}\\n',",
                "        encoding='utf-8',",
                "    )",
                "",
                "def register(hub):",
                "    get_hooks().on('case.written', _on_written, plugin='h1_hook')",
                "    return None",
                "",
            ]
        ),
        encoding="utf-8",
    )
    from cfddesk.registry.analysis import write_run_case

    load_all(web_root=web)
    spec = _steady_spec()
    case = tmp_path / "hooked"
    result = write_run_case(spec, case)
    assert result["ok"]
    hooked = (case / "system" / "controlDict").read_text(encoding="utf-8")
    assert "h1Probe" in hooked

    # The test's own settings file (named, so it is the only one read).
    os.environ["CFDDESK_LOCAL_JSON"] = str(web / ".cfddesk-local.json")
    (web / ".cfddesk-local.json").write_text(
        json.dumps({"plugins": {"disabled": ["h1_hook"]}}),
        encoding="utf-8",
    )
    reset_for_tests()
    load_all(web_root=web)
    plain = tmp_path / "plain"
    result = write_run_case(spec, plain)
    assert result["ok"]
    assert "h1Probe" not in (plain / "system" / "controlDict").read_text(encoding="utf-8")
    # Disabled means no effect: the same bytes as with no plugin folder at all
    # (Incompressible Flow's goldens pin those bytes, in its own tests).
    reset_for_tests()
    load_all(web_root=tmp_path / "no-plugins")
    base = tmp_path / "base"
    assert write_run_case(spec, base)["ok"]
    written = sorted(p.relative_to(plain) for p in plain.rglob("*") if p.is_file())
    assert written == sorted(p.relative_to(base) for p in base.rglob("*") if p.is_file())
    for rel in written:
        if rel.name == "w27-case.json":
            continue  # records the absolute case folder
        assert (plain / rel).read_bytes() == (base / rel).read_bytes(), rel


def test_gate_h1_api_version(tmp_path):
    """gate:h1-api-version"""
    web = tmp_path / "web"
    plug = web / "plugins" / "h1_future"
    plug.mkdir(parents=True)
    (plug / "manifest.toml").write_text(
        'key = "h1_future"\nname = "Future"\napi_version = "2.0"\n',
        encoding="utf-8",
    )
    (plug / "plugin.py").write_text(
        "def register(hub):\n    raise RuntimeError('incompatible plugin must not register')\n",
        encoding="utf-8",
    )
    hub = load_all(web_root=web)
    assert API_VERSION == "1.3"
    assert any(row["key"] == "h1_future" and row["api_version"] == "2.0" for row in hub.incompatible)
    assert "h1_future" not in hub.manifests
    assert get_registry("solver").owner("simpleFoam") == "incompressible_flow"
    assert get_registry("mesher").get("cfmesh").frozen is True


def test_job_tool_stays_inside_plugin_package(tmp_path):
    pkg = tmp_path / "pkg"
    pkg.mkdir()
    (pkg / "probe.py").write_text("print('ok')\n", encoding="utf-8")
    ensure_tool_in_package("probe.py", pkg)
    hub = load_all()
    hub.register_job(
        JobKind("h1_probe_job", "probe.py", "project", ("project_id",)),
        plugin="h1",
        package_dir=pkg,
    )
    assert get_registry("job").get("h1_probe_job").tool == "probe.py"
    with pytest.raises(RegistryError, match="outside"):
        hub.register_job(
            JobKind("h1_escape", "../outside.py", "project"),
            plugin="h1",
            package_dir=pkg,
        )
    # gate:h6-job-containment: a plugin job named like a core tool, but not in its
    # own folder, is refused (it would otherwise run the core solve.sh).
    with pytest.raises(RegistryError, match="not in the plugin folder"):
        hub.register_job(
            JobKind("h6_core_name", "solve.sh", "project"),
            plugin="h1",
            package_dir=pkg,
        )


def test_bc_extend_keeps_builtin_velocity_writer():
    load_all()
    hub = get_hub()
    spec = get_registry("bc").get("wall_noslip")

    def write_t(*_args, **_kwargs):
        return "T"

    def write_u(*_args, **_kwargs):
        return "replaced"

    hub.bc.extend("wall_noslip", "T", write_t, plugin="h1")
    hub.bc.extend("wall_noslip", "U", write_u, plugin="h1")
    assert hub.bc.writer("wall_noslip", "U") is spec.write_U
    assert hub.bc.writer("wall_noslip", "p") is spec.write_p
    assert hub.bc.writer("wall_noslip", "T") is write_t


def test_hooks_run_in_priority_order():
    seen: list[str] = []
    bus = get_hooks()
    bus.on("results.load", lambda **_kwargs: seen.append("late"), priority=10, plugin="h1")
    bus.on("results.load", lambda **_kwargs: seen.append("early"), priority=0, plugin="h1")
    bus.call("results.load")
    assert seen == ["early", "late"]

    def outer(proceed, **kwargs):
        return "A" + proceed(**kwargs)

    bus.around("case.write", outer, plugin="h1")
    assert bus.apply("case.write", lambda **_kwargs: "B") == "AB"
    bus.clear_plugin("h1")
    assert bus.apply("case.write", lambda **_kwargs: "B") == "B"
    with pytest.raises(RegistryError, match="unknown hook"):
        bus.on("not.a.hook", lambda **_kwargs: None)


def test_protected_unregister_restores_builtin_when_allowed():
    load_all()
    hub = get_hub()
    hub.note_overrides("h1_allow", ["mesher:cfmesh"])
    current = get_registry("mesher").get("cfmesh")
    hub.replace("mesher", replace(current, label="temp cfmesh"), plugin="h1_allow")
    assert get_registry("mesher").owner("cfmesh") == "h1_allow"
    with pytest.raises(RegistryError, match="protected"):
        hub.unregister("mesher", "cfmesh", plugin="h1_allow")
    assert get_registry("mesher").owner("cfmesh") == "h1_allow"
    hub.unregister("mesher", "cfmesh", plugin="h1_allow", allow_protected=True)
    restored = get_registry("mesher").get("cfmesh")
    assert get_registry("mesher").owner("cfmesh") == "builtin"
    assert restored.frozen is True
    assert restored.label == "cfMesh cartesianMesh (legacy)"


def test_replace_requires_override_token():
    load_all()
    current = get_registry("solver").get("simpleFoam")
    with pytest.raises(RegistryError, match="overrides"):
        get_registry("solver").replace(
            replace(current, label="nope"),
            plugin="stranger",
        )
    assert get_registry("solver").owner("simpleFoam") == "incompressible_flow"
