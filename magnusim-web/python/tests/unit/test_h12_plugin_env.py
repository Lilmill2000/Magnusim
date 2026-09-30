"""H12: a plugin's own environment, service and jobs.

gate:h12-venv-isolation — building a plugin's environment (with a package)
leaves the core's ``pip freeze`` byte-identical; gate:h12-sdk-only — inside it
``magnusim_sdk`` imports and ``cfddesk`` does not; a new lock hash puts the
plugin back to "needs setup"; a failed build keeps pip's error. The service
gates (crash, timeout) and the kill-tree gate are Node tests
(scripts/server/__tests__/plugin-services.test.js); the Settings flow is
e2e/h12-plugin-env.spec.js.
"""

from __future__ import annotations

import base64
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry import plugin_env as pe
from cfddesk.registry.discovery import get_hub, plugin_catalog
from cfddesk.registry.plugin_data import PluginData
from cfddesk.registry.requirements import Requirement, check_requirements
from cfddesk.worker import methods
from cfddesk.worker.rpc import RpcError

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "env-plugins" / "env-demo"
KEY = "env-demo"


def _wheel(folder: Path, name: str, version: str, body: str) -> Path:
    """A minimal pure-Python wheel (no network: pip installs it from find_links)."""
    folder.mkdir(parents=True, exist_ok=True)
    dist = f"{name}-{version}"
    path = folder / f"{dist}-py3-none-any.whl"
    files = {
        f"{name}/__init__.py": body,
        f"{dist}.dist-info/METADATA": f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n",
        f"{dist}.dist-info/WHEEL": "Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    }
    record = []
    for rel, text in files.items():
        data = text.encode()
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        record.append(f"{rel},sha256={digest},{len(data)}")
    record.append(f"{dist}.dist-info/RECORD,,")
    with zipfile.ZipFile(path, "w") as z:
        for rel, text in files.items():
            z.writestr(rel, text)
        z.writestr(f"{dist}.dist-info/RECORD", "\n".join(record) + "\n")
    return path


def _with_package(plugin: Path) -> None:
    """Give the plugin one pinned, hashed package from its own wheels folder."""
    wheel = _wheel(plugin / "wheels", "envdemo_dep", "1.0.0", "VALUE = 42\n")
    digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
    (plugin / "requirements.lock").write_text(f"envdemo_dep==1.0.0 --hash=sha256:{digest}\n", encoding="utf-8")
    manifest = plugin / "manifest.toml"
    text = manifest.read_text(encoding="utf-8").replace(
        'service = "env_demo_service"', 'service = "env_demo_service"\nfind_links = "wheels"'
    )
    manifest.write_text(text, encoding="utf-8")


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    plugins = tmp_path / "plugins"
    shutil.copytree(FIXTURE, plugins / KEY)
    projects = tmp_path / "projects"
    (projects / "proj-a").mkdir(parents=True)
    (projects / "proj-a" / "project.json").write_text(json.dumps({"id": "proj-a", "title": "A"}), encoding="utf-8")
    local = tmp_path / "local.json"
    local.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(plugins))
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(projects))
    monkeypatch.setenv("MAGNUSIM_PLUGIN_ENVS_DIR", str(tmp_path / "envs"))
    monkeypatch.setenv("CFDDESK_LOCAL_JSON", str(local))
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(local))
    reset_for_tests()
    load_all(force=True)
    yield {"plugin": plugins / KEY, "projects": projects, "envs": tmp_path / "envs", "root": tmp_path}
    reset_for_tests()


def _row(key: str = KEY) -> dict:
    return next(r for r in plugin_catalog() if r["key"] == key)


def _build(env: dict) -> dict:
    manifest = get_hub().manifests[KEY]
    return pe.create_env(env["root"], KEY, manifest.python_env, env["plugin"])


def test_manifest_python_table_is_checked(tmp_path: Path):
    plugin = tmp_path / "p"
    plugin.mkdir()
    (plugin / "requirements.lock").write_text("", encoding="utf-8")
    spec = pe.python_env_from_meta({"python": {"python": ">=3.10,<3.15", "service": "svc.main"}}, plugin)
    assert spec is not None and spec.service == "svc.main" and len(spec.lock_hash) == pe.LOCK_HASH_LEN
    assert pe.python_env_from_meta({}, plugin) is None
    for bad, why in (
        ({"requirements": "../outside.lock"}, "outside the plugin folder"),
        ({"requirements": "missing.lock"}, "is missing"),
        ({"service": "not a module"}, "not a module name"),
        ({"python": "3.10+"}, "is not like"),
        ({"find_links": "wheels"}, "is missing"),
    ):
        with pytest.raises(ValueError, match=why):
            pe.python_env_from_meta({"python": bad}, plugin)
    assert pe.python_in_range((3, 12, 1), ">=3.10,<3.13") and not pe.python_in_range((3, 13, 0), ">=3.10,<3.13")


def test_a_plugin_with_an_environment_needs_setup_first(env):
    row = _row()
    assert row["status"] == "needs setup" and row["enabled"] is False
    assert row["python_env"]["state"] == "needs_setup" and row["python_env"]["service"] is True
    assert "env_dir" not in row["python_env"], "no local paths in the page's rows"
    job = methods.jobs_describe(kind="env_demo_sleep")["job"]
    assert job["runtime"] == "plugin" and job["python"] is None and "needs setup" in job["python_error"]
    with pytest.raises(RpcError):
        methods.plugins_env(key="no-such-plugin")


# gate:h12-venv-isolation, gate:h12-sdk-only
def test_the_environment_is_its_own(env):
    _with_package(env["plugin"])
    reset_for_tests()
    load_all(force=True)
    freeze = [sys.executable, "-m", "pip", "freeze", "--disable-pip-version-check"]
    before = subprocess.run(freeze, capture_output=True, check=True).stdout
    status = _build(env)
    after = subprocess.run(freeze, capture_output=True, check=True).stdout
    assert before == after, "installing a plugin changed the core's packages"
    assert status["state"] == "ready" and "envdemo_dep" in status["installed"]
    probe = (
        "import importlib.util, json, sys, envdemo_dep, magnusim_sdk; "
        "print(json.dumps({'value': envdemo_dep.VALUE, 'cfddesk': importlib.util.find_spec('cfddesk') is not None, "
        "'prefix': sys.prefix}))"
    )
    seen = json.loads(subprocess.run([status["python"], "-I", "-c", probe], capture_output=True, text=True, check=True).stdout)
    assert seen["value"] == 42 and seen["cfddesk"] is False
    assert Path(seen["prefix"]).resolve() == Path(status["env_dir"]).resolve()
    ran = subprocess.run([status["python"], "-I", "-c", "import cfddesk"], capture_output=True, text=True)
    assert ran.returncode != 0 and "ModuleNotFoundError" in ran.stderr
    row = _row()
    assert row["status"] == "enabled" and row["python_env"]["state"] == "ready"
    job = methods.jobs_describe(kind="env_demo_sleep")["job"]
    assert job["python"] == status["python"] and Path(job["cwd"]) == env["plugin"].resolve()


def test_a_new_lock_needs_setup_again(env):
    first = _build(env)
    assert _row()["status"] == "enabled"
    lock = env["plugin"] / "requirements.lock"
    lock.write_text(lock.read_text(encoding="utf-8") + "# edited\n", encoding="utf-8")
    reset_for_tests()
    load_all(force=True)
    row = _row()
    assert row["status"] == "needs setup" and row["python_env"]["lock_hash"] != first["lock_hash"]
    second = _build(env)
    assert second["state"] == "ready" and not Path(first["env_dir"]).exists(), "the old environment was kept"


def test_a_failed_build_says_why_and_leaves_nothing(env):
    (env["plugin"] / "requirements.lock").write_text("envdemo_dep==1.0.0 --hash=sha256:" + "0" * 64 + "\n", encoding="utf-8")
    (env["plugin"] / "wheels").mkdir()
    manifest = env["plugin"] / "manifest.toml"
    manifest.write_text(
        manifest.read_text(encoding="utf-8").replace('service = "env_demo_service"', 'service = "env_demo_service"\nfind_links = "wheels"'),
        encoding="utf-8",
    )
    reset_for_tests()
    load_all(force=True)
    with pytest.raises(pe.EnvError, match="Installing dependencies failed") as err:
        _build(env)
    assert err.value.tail, "no pip output kept"
    row = _row()
    assert row["status"] == "needs setup" and row["python_env"]["state"] == "failed"
    assert "Installing dependencies failed" in row["python_env"]["error"]
    spec = get_hub().manifests[KEY].python_env
    assert not pe.env_dir(env["root"], KEY, spec).exists()
    assert methods.plugins_env_remove(key=KEY)["removed"], "the failure note stays until removed"
    assert _row()["python_env"]["state"] == "needs_setup"


def test_requirements_are_checked_for_real():
    manifest = type("M", (), {"requires": [Requirement("wsl_tool", "blockMesh"), Requirement("python", "Neural_Foil"), Requirement("gpu", "cuda")]})()
    missing = check_requirements(manifest, {"wsl_tools": None, "python_packages": ["neural-foil"], "gpu": False})
    assert [(m.requirement.kind, m.blocking) for m in missing] == [("gpu", False)], "unknown WSL tools are not missing"
    missing = check_requirements(manifest, {"wsl_tools": set(), "python_packages": [], "gpu": True})
    assert sorted(m.requirement.kind for m in missing) == ["python", "wsl_tool"]


def test_a_study_of_a_plugin_that_needs_setup_says_so(env):
    data = PluginData(env["projects"] / "proj-a", KEY)
    rec = data.create_study("demo_case", "Wing", plugin_version="2.0.0", schema_version=2)
    row = next(s for s in methods.plugin_studies_list(project_id="proj-a")["studies"] if s["id"] == rec["id"])
    assert row["available"] is False and "needs setup" in row["reason"] and "Settings > Plugins" in row["reason"]


def test_older_studies_are_upgraded_by_the_plugin(env):
    _build(env)
    data = PluginData(env["projects"] / "proj-a", KEY)
    old = data.create_study("demo_case", "Wing", plugin_version="1.0.0", schema_version=1)
    row = next(s for s in methods.plugin_studies_list(project_id="proj-a")["studies"] if s["id"] == old["id"])
    assert row["needs_migration"] is True and row["schema_version"] == 1 and row["kind_schema_version"] == 2
    full = methods.plugin_studies_get(project_id="proj-a", plugin=KEY, study_id=old["id"])["study"]
    upgraded = {**full, "title": "Wing (upgraded)", "units": "SI", "rev": 999, "kind": "other"}
    with pytest.raises(RpcError) as stale:
        methods.plugin_studies_migrated(project_id="proj-a", plugin=KEY, study_id=old["id"], rev=0, study=upgraded)
    assert stale.value.code == methods.RPC_CONFLICT
    done = methods.plugin_studies_migrated(project_id="proj-a", plugin=KEY, study_id=old["id"], rev=full["rev"], study=upgraded)
    assert done["study"]["title"] == "Wing (upgraded)" and done["study"]["needs_migration"] is False
    stored = data.study(old["id"])
    assert (stored["schema_version"], stored["plugin_version"], stored["units"], stored["kind"]) == (2, "2.0.0", "SI", "demo_case")
    assert stored["rev"] == full["rev"] + 1
