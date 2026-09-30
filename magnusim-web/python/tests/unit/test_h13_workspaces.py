"""H13: plugin workspaces, and the calls a workspace's bridge makes.

``[[workspaces]]`` is validated (an .html entry inside the plugin's
``workspace/`` folder, the only folder the host serves to the frame); a study
kind names a declared workspace; the catalog and the tree say which workspace
opens a study. The bridge's study and data calls stay inside the plugin's
folder in the called project: a study saves only its own fields with the
current rev, a deleted study is "not found" (the workspace closes), and no
spelling of a path reaches a study's record.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest

from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.discovery import get_hub, workspaces_from_meta
from cfddesk.worker import methods
from cfddesk.worker.rpc import RpcError

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "workspace-plugins" / "ws-demo"
KEY = "ws-demo"


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    plugins = tmp_path / "plugins"
    shutil.copytree(FIXTURE, plugins / KEY)
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
    yield {"plugins": plugins, "projects": projects, "local": local}
    reset_for_tests()


def _bench(title: str = "Wing") -> dict:
    return methods.plugin_studies_create(project_id="proj-a", plugin=KEY, kind="bench_case", title=title)["study"]


def _refused(fn, *args, **kwargs) -> RpcError:
    with pytest.raises(RpcError) as err:
        fn(*args, **kwargs)
    return err.value


def test_workspaces_are_validated(tmp_path: Path):
    (tmp_path / "workspace").mkdir()
    (tmp_path / "workspace" / "index.html").write_text("<!doctype html>", encoding="utf-8")
    (tmp_path / "workspace" / "main.js").write_text("", encoding="utf-8")
    (tmp_path / "ui").mkdir()
    (tmp_path / "ui" / "index.html").write_text("", encoding="utf-8")
    (tmp_path / "top.html").write_text("", encoding="utf-8")
    good = workspaces_from_meta({"workspaces": [{"key": "bench", "title": "Bench", "icon": "M1 1L2 2"}]}, tmp_path)
    assert [(w.key, w.title, w.entry) for w in good] == [("bench", "Bench", "workspace/index.html")]
    for bad, why in (
        ([{"key": "Bench", "title": "x"}], "lower_snake_case"),
        ([{"key": "bench"}], "needs a title"),
        ([{"key": "bench", "title": "x", "icon": "<script>"}], "one SVG path"),
        ([{"key": "bench", "title": "x"}, {"key": "bench", "title": "y"}], "twice"),
        ([{"key": "bench", "title": "x", "entry": "ui/index.html"}], "workspace/ folder"),
        ([{"key": "bench", "title": "x", "entry": "workspace/../top.html"}], "workspace/ folder"),
        ([{"key": "bench", "title": "x", "entry": "workspace/main.js"}], "workspace/ folder"),
        ([{"key": "bench", "title": "x", "entry": "workspace/gone.html"}], "missing"),
    ):
        with pytest.raises(ValueError, match=why):
            workspaces_from_meta({"workspaces": bad}, tmp_path)


def test_catalog_and_tree_say_which_workspace_opens_a_study(env):
    rows = {r["key"]: r for r in methods.plugins_list()["plugins"]}
    assert rows[KEY]["status"] == "enabled"
    assert [(w["key"], w["entry"]) for w in rows[KEY]["workspaces"]] == [
        ("bench", "workspace/index.html"),
        ("silent", "workspace/silent.html"),
    ]
    kinds = {k["key"]: k["workspace"] for k in methods.plugin_studies_list(project_id="proj-a")["kinds"]}
    assert kinds == {"bench_case": "bench", "silent_case": "silent"}
    st = _bench()
    tree = methods.project_tree(project_id="proj-a")
    assert [(s["id"], s["workspace"]) for s in tree["plugin_studies"]] == [(st["id"], "bench")]


def test_a_kind_naming_an_undeclared_workspace_fails_only_that_plugin(env):
    manifest = env["plugins"] / KEY / "manifest.toml"
    manifest.write_text(manifest.read_text(encoding="utf-8").replace('workspace = "silent"', 'workspace = "nowhere"'), encoding="utf-8")
    reset_for_tests()
    hub = load_all(force=True)
    assert KEY not in hub.manifests
    assert any(f["key"] == KEY and "not declared" in f["error"] for f in hub.failures)
    assert "incompressible_steady" in hub.registry("analysis").keys()


def test_study_update_saves_own_fields_with_the_current_rev(env):
    st = _bench()
    out = methods.plugin_studies_update(
        project_id="proj-a",
        plugin=KEY,
        study_id=st["id"],
        rev=st["rev"],
        patch={"chord_mm": 120, "id": "st-other", "rev": 99, "kind": "silent_case", "plugin": "other"},
    )["study"]
    # The host keeps its own fields; the plugin's are saved; rev moves on.
    assert out["chord_mm"] == 120 and out["rev"] == st["rev"] + 1
    assert (out["id"], out["kind"], out["plugin"]) == (st["id"], "bench_case", KEY)
    got = methods.plugin_studies_get(project_id="proj-a", plugin=KEY, study_id=st["id"])["study"]
    assert got["chord_mm"] == 120 and got["rev"] == out["rev"]
    # A second tab holding the old rev.
    err = _refused(methods.plugin_studies_update, project_id="proj-a", plugin=KEY, study_id=st["id"], rev=st["rev"], patch={"x": 1})
    assert err.code == methods.RPC_CONFLICT
    err = _refused(methods.plugin_studies_update, project_id="proj-a", plugin=KEY, study_id=st["id"], rev=out["rev"], patch=None)
    assert "patch" in err.message
    # The same id in another project is another (missing) study.
    err = _refused(methods.plugin_studies_update, project_id="proj-b", plugin=KEY, study_id=st["id"], rev=out["rev"], patch={"x": 1})
    assert err.code == -32004


def test_a_deleted_study_is_not_found(env):
    st = _bench()
    methods.plugin_studies_delete(project_id="proj-a", plugin=KEY, study_id=st["id"])
    for call in (
        lambda: methods.plugin_studies_get(project_id="proj-a", plugin=KEY, study_id=st["id"]),
        lambda: methods.plugin_studies_update(project_id="proj-a", plugin=KEY, study_id=st["id"], rev=1, patch={}),
        lambda: methods.plugin_studies_rename(project_id="proj-a", plugin=KEY, study_id=st["id"], title="x", rev=1),
    ):
        err = _refused(call)
        assert err.code == -32004, err.message


def test_study_update_refused_while_the_plugin_is_off(env):
    st = _bench()
    env["local"].write_text(json.dumps({"plugins": {"disabled": [KEY]}}), encoding="utf-8")
    reset_for_tests()
    load_all(force=True)
    assert KEY not in get_hub().manifests
    err = _refused(methods.plugin_studies_update, project_id="proj-a", plugin=KEY, study_id=st["id"], rev=st["rev"], patch={"x": 1})
    assert "Requires the" in err.message


def test_data_read_write_stay_in_the_plugins_folder_of_that_project(env):
    assert methods.plugin_data_read(project_id="proj-a", plugin=KEY, rel="notes/n.json")["doc"] is None
    methods.plugin_data_write(project_id="proj-a", plugin=KEY, rel="notes/n.json", doc={"text": "kept"})
    assert (env["projects"] / "proj-a" / "plugins" / KEY / "notes" / "n.json").is_file()
    assert methods.plugin_data_read(project_id="proj-a", plugin=KEY, rel="notes/./n.json")["doc"] == {"text": "kept"}
    assert methods.plugin_data_read(project_id="proj-b", plugin=KEY, rel="notes/n.json")["doc"] is None
    # A study's own files (not its record) are the plugin's to write.
    st = _bench()
    methods.plugin_data_write(project_id="proj-a", plugin=KEY, rel=f"studies/{st['id']}/polar.json", doc=[1, 2])
    for rel in ("../other/x.json", "notes/../../x.json", "/abs.json", "C:/x.json", "", "   "):
        assert _refused(methods.plugin_data_write, project_id="proj-a", plugin=KEY, rel=rel, doc={}).code == -32602, rel
        assert _refused(methods.plugin_data_read, project_id="proj-a", plugin=KEY, rel=rel).code == -32602, rel
    err = _refused(methods.plugin_data_write, project_id="proj-a", plugin="../ws-demo", rel="x.json", doc={})
    assert err.code == -32602
    big = "x" * (8 * 1024 * 1024 + 1)
    assert "8 MB" in _refused(methods.plugin_data_write, project_id="proj-a", plugin=KEY, rel="big.json", doc=big).message


def test_no_spelling_of_a_path_writes_a_study_record(env):
    st = _bench()
    sid = st["id"]
    record = env["projects"] / "proj-a" / "plugins" / KEY / "studies" / sid / "study.json"
    before = record.read_bytes()
    spellings = [
        f"studies/{sid}/study.json",
        f"notes/../studies/{sid}/study.json",
        f"./studies//{sid}/./study.json",
        f"Studies/{sid}/Study.JSON",
        f"studies/{sid}/study.json.",
        f"studies/{sid}/study.json ",
        f"studies/{sid}/study.json::$DATA",
        f"studies\\{sid}\\study.json",
        "studies/ST-XXX~1/STUDY~1.JSO",
    ]
    for rel in spellings:
        err = _refused(methods.plugin_data_write, project_id="proj-a", plugin=KEY, rel=rel, doc={"rev": 99})
        assert err.code == -32602, rel
    assert record.read_bytes() == before


@pytest.mark.skipif(os.name != "nt", reason="8.3 short names are a Windows alias")
def test_a_short_name_alias_is_caught_where_it_lands(env):
    import ctypes

    from cfddesk.registry.plugin_data import PluginData

    st = _bench()
    record = env["projects"] / "proj-a" / "plugins" / KEY / "studies" / st["id"] / "study.json"
    buf = ctypes.create_unicode_buffer(1024)
    if not ctypes.windll.kernel32.GetShortPathNameW(str(record), buf, 1024):
        pytest.skip("GetShortPathNameW failed")
    short = Path(buf.value).name
    if short.lower() == "study.json":
        pytest.skip("8.3 names are off on this volume")
    # The path check refuses `~` outright; the write is also checked where it
    # lands, and the resolved path carries the long name, so the alias is caught there too.
    data = PluginData(env["projects"] / "proj-a", KEY)
    landed = data.path(f"studies/{st['id']}/{short}")
    assert landed.name.lower() == "study.json"
    assert methods._is_study_record(landed.relative_to(data.root.resolve()).parts)
    before = record.read_bytes()
    err = _refused(methods.plugin_data_write, project_id="proj-a", plugin=KEY, rel=f"studies/{st['id']}/{short}", doc={})
    assert err.code == -32602
    assert record.read_bytes() == before
