"""H11: a plugin's project data and its project-level studies.

gate:h11-plugin-data-scope — a plugin reaches only its own folder in the
project it was called for; gate:h11-stale-rev — a rename with an old rev is
refused (HTTP 409 at the route); a study whose plugin is off stays on disk,
unchanged, and is listed greyed.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest

from cfddesk.project.scope import parse_plugin_scope, plugin_study_scope
from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.discovery import get_hub, study_kinds_from_meta
from cfddesk.registry.plugin_data import PluginData, PluginDataError, StaleRevisionError
from cfddesk.worker import methods
from cfddesk.worker.rpc import RpcError

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "plugins" / "study-demo"


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    plugins = tmp_path / "plugins"
    shutil.copytree(FIXTURE, plugins / "study-demo")
    projects = tmp_path / "projects"
    for pid in ("proj-a", "proj-b"):
        (projects / pid).mkdir(parents=True)
        (projects / pid / "project.json").write_text(json.dumps({"id": pid, "title": pid}), encoding="utf-8")
    local = tmp_path / "local.json"
    local.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(plugins))
    monkeypatch.setenv("MAGNUSIM_PROJECTS_ROOT", str(projects))
    monkeypatch.setenv("CFDDESK_LOCAL_JSON", str(local))
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(local))
    reset_for_tests()
    load_all(force=True)
    yield {"projects": projects, "local": local}
    reset_for_tests()


def _tree_hash(folder: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(folder.rglob("*")):
        if p.is_file():
            h.update(p.relative_to(folder).as_posix().encode())
            h.update(p.read_bytes())
    return h.hexdigest()


def test_scope_key_round_trip():
    key = plugin_study_scope("proj", "study-demo", "st-1")
    assert key == "p:proj/plugin:study-demo/study:st-1"
    assert parse_plugin_scope(key) == {"project_id": "proj", "plugin": "study-demo", "study_id": "st-1"}
    assert parse_plugin_scope("p:proj/g:g1/s:sim_1") is None


def test_study_kinds_are_validated():
    kinds = study_kinds_from_meta({"study_kinds": [{"key": "demo", "title": "Demo", "icon": "M1 1L2 2"}]})
    assert kinds[0].key == "demo" and kinds[0].schema_version == 1
    for bad, why in (
        ([{"key": "Demo", "title": "x"}], "lower_snake_case"),
        ([{"key": "demo"}], "needs a title"),
        ([{"key": "demo", "title": "x", "icon": "<script>"}], "one SVG path"),
        ([{"key": "demo", "title": "x"}, {"key": "demo", "title": "y"}], "twice"),
    ):
        with pytest.raises(ValueError, match=why):
            study_kinds_from_meta({"study_kinds": bad})


def test_bad_study_kinds_fail_only_that_plugin(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    plugins = tmp_path / "plugins"
    shutil.copytree(FIXTURE, plugins / "study-demo")
    manifest = plugins / "study-demo" / "manifest.toml"
    manifest.write_text(manifest.read_text(encoding="utf-8").replace('key = "demo_analysis"', 'key = "Bad Key"'), encoding="utf-8")
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(plugins))
    reset_for_tests()
    try:
        hub = load_all(force=True)
        assert "study-demo" not in hub.manifests
        assert any(f["key"] == "study-demo" and "study_kinds" in f["error"] for f in hub.failures)
        assert "incompressible_steady" in hub.registry("analysis").keys()
    finally:
        reset_for_tests()


def test_gate_h11_plugin_data_scope(env):
    projects = env["projects"]
    a = PluginData(projects / "proj-a", "study-demo")
    a.write_json("notes/x.json", {"n": 1})
    assert (projects / "proj-a" / "plugins" / "study-demo" / "notes" / "x.json").is_file()
    for escape in ("../other-plugin/x.json", "../../proj-b/plugins/study-demo/x.json", "../../../x.json"):
        with pytest.raises(PluginDataError):
            a.write_json(escape, {"n": 2})
    with pytest.raises(PluginDataError):
        PluginData(projects / "proj-a", "../proj-b")

    # Through the worker: the plugin's method gets its own folder in the called project only.
    out = methods.plugin_dispatch("study-demo", "notes/write", {"rel": "notes/n.json", "text": "hi"}, {"project_id": "proj-a"})
    assert out["ok"]
    assert (projects / "proj-a" / "plugins" / "study-demo" / "notes" / "n.json").is_file()
    assert not (projects / "proj-b" / "plugins").exists()
    with pytest.raises(PluginDataError):
        methods.plugin_dispatch("study-demo", "notes/write", {"rel": "../example-laminar/n.json"}, {"project_id": "proj-a"})
    read_b = methods.plugin_dispatch("study-demo", "notes/read", {"rel": "notes/n.json"}, {"project_id": "proj-b"})
    assert read_b["doc"] is None
    # Another plugin's key cannot be passed as its own.
    with pytest.raises(RpcError):
        methods.plugin_studies_create(project_id="proj-a", plugin="../study-demo", kind="demo_analysis", title="x")


def test_studies_create_list_rename_delete_and_stale_rev(env):
    made = methods.plugin_studies_create(project_id="proj-a", plugin="study-demo", kind="demo_analysis", title="Wing 1")
    st = made["study"]
    assert st["title"] == "Wing 1" and st["rev"] == 1 and st["available"] and not st["read_only"]
    assert st["scope_key"] == f"p:proj-a/plugin:study-demo/study:{st['id']}"
    assert st["kind_title"] == "Demo analysis" and st["icon"].startswith("M4")
    rec = json.loads(
        (env["projects"] / "proj-a" / "plugins" / "study-demo" / "studies" / st["id"] / "study.json").read_text(encoding="utf-8")
    )
    assert {k: rec[k] for k in ("kind", "schema_version", "plugin", "plugin_version", "rev")} == {
        "kind": "demo_analysis",
        "schema_version": 1,
        "plugin": "study-demo",
        "plugin_version": "1.0.0",
        "rev": 1,
    }

    listed = methods.plugin_studies_list(project_id="proj-a")
    assert [s["title"] for s in listed["studies"]] == ["Wing 1"]
    assert listed["kinds"] == [
        {
            "plugin": "study-demo",
            "plugin_name": "Study demo",
            "key": "demo_analysis",
            "title": "Demo analysis",
            "icon": st["icon"],
            # No workspace declared: its studies do not open in one (H13).
            "workspace": "",
        }
    ]
    assert methods.plugin_studies_list(project_id="proj-b")["studies"] == []

    renamed = methods.plugin_studies_rename(project_id="proj-a", plugin="study-demo", study_id=st["id"], title="Wing 2", rev=1)
    assert renamed["study"]["title"] == "Wing 2" and renamed["study"]["rev"] == 2
    # gate:h11-stale-rev: a second tab still holding rev 1.
    with pytest.raises(RpcError) as err:
        methods.plugin_studies_rename(project_id="proj-a", plugin="study-demo", study_id=st["id"], title="Wing 3", rev=1)
    assert err.value.code == methods.RPC_CONFLICT
    assert err.value.message == "This study changed in another tab. Reload to continue."

    # The tree carries the group.
    tree = methods.project_tree(project_id="proj-a")
    assert [s["title"] for s in tree["plugin_studies"]] == ["Wing 2"]
    assert tree["plugin_study_kinds"][0]["key"] == "demo_analysis"

    methods.plugin_studies_delete(project_id="proj-a", plugin="study-demo", study_id=st["id"])
    assert methods.plugin_studies_list(project_id="proj-a")["studies"] == []


def test_disabled_plugin_study_is_kept_greyed_and_deletable(env):
    st = methods.plugin_studies_create(project_id="proj-a", plugin="study-demo", kind="demo_analysis", title="Kept")["study"]
    folder = env["projects"] / "proj-a" / "plugins" / "study-demo"
    before = _tree_hash(folder)
    env["local"].write_text(json.dumps({"plugins": {"disabled": ["study-demo"]}}), encoding="utf-8")
    reset_for_tests()
    load_all(force=True)
    assert "study-demo" not in get_hub().manifests
    listed = methods.plugin_studies_list(project_id="proj-a")
    row = listed["studies"][0]
    assert row["available"] is False and row["reason"] == "Requires the Study demo plugin"
    assert listed["kinds"] == []
    with pytest.raises(RpcError):
        methods.plugin_studies_rename(project_id="proj-a", plugin="study-demo", study_id=st["id"], title="x", rev=1)
    with pytest.raises(RpcError):
        methods.plugin_studies_create(project_id="proj-a", plugin="study-demo", kind="demo_analysis", title="x")
    assert _tree_hash(folder) == before

    env["local"].write_text("{}", encoding="utf-8")
    reset_for_tests()
    load_all(force=True)
    assert methods.plugin_studies_list(project_id="proj-a")["studies"][0]["available"] is True
    env["local"].write_text(json.dumps({"plugins": {"disabled": ["study-demo"]}}), encoding="utf-8")
    reset_for_tests()
    load_all(force=True)
    methods.plugin_studies_delete(project_id="proj-a", plugin="study-demo", study_id=st["id"])
    assert not (folder / "studies" / st["id"]).exists()


def test_newer_plugin_version_opens_read_only(env):
    data = PluginData(env["projects"] / "proj-a", "study-demo")
    rec = data.create_study("demo_analysis", "Future", plugin_version="9.0.0")
    row = methods.plugin_studies_list(project_id="proj-a")["studies"][0]
    assert row["read_only"] is True
    with pytest.raises(RpcError, match="newer version"):
        methods.plugin_studies_rename(project_id="proj-a", plugin="study-demo", study_id=rec["id"], title="x", rev=1)


def test_update_needs_the_current_rev():
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        data = PluginData(tmp, "p")
        rec = data.create_study("k", "T")
        with pytest.raises(StaleRevisionError):
            data.rename_study(rec["id"], "U", None)
        assert data.rename_study(rec["id"], "U", 1)["rev"] == 2
