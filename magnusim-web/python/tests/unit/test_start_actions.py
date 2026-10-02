"""Start actions (API 1.4, gate:l1-manifest).

A plugin's ``[[start_actions]]`` table: the validation rules (a bad table fails
only that plugin, with "manifest [[start_actions]]: ..."), places a later host
may have (ignored with a warning on the plugin's Settings row), unknown keys,
``links_geometry`` (a kind may link a geometry only through a workspace), the
catalog rows (filled only for a plugin that is on) and the tree's kind rows,
and the workspace plugin template with its examples uncommented.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import pytest

from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.discovery import get_hub, plugin_catalog, study_kinds_from_meta
from cfddesk.registry.manifest import START_ACTION_PLACES
from cfddesk.worker import methods

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
START = FIXTURES / "start-plugins"
ENV_DEMO = FIXTURES / "env-plugins" / "env-demo"
TEMPLATE = Path(__file__).resolve().parents[3] / "templates" / "plugin-workspace"

HEAD = """key = "sa-test"
name = "Start test"
version = "1.0.0"
api_version = "1.4"

[[workspaces]]
key = "bench"
title = "Bench"
entry = "workspace/index.html"

[[workspaces]]
key = "long"
title = "A workspace title of thirty"
entry = "workspace/index.html"

[[study_kinds]]
key = "part"
title = "Part"
icon = "M1 1L2 2"
workspace = "bench"

[[study_kinds]]
key = "twin"
title = "Twin"
workspace = "bench"

[[study_kinds]]
key = "wide"
title = "Wide"
workspace = "long"

[[study_kinds]]
key = "bare"
title = "Bare"
"""


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    plugins = tmp_path / "plugins"
    plugins.mkdir()
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
    yield {"plugins": plugins, "local": local}
    reset_for_tests()


def _plugin(plugins: Path, body: str, key: str = "sa-test") -> Path:
    folder = plugins / key
    (folder / "workspace").mkdir(parents=True, exist_ok=True)
    (folder / "workspace" / "index.html").write_text("<!doctype html><title>x</title>", encoding="utf-8")
    (folder / "plugin.py").write_text("def register(hub):\n    return None\n", encoding="utf-8")
    (folder / "manifest.toml").write_text(body, encoding="utf-8")
    return folder


def _load() -> None:
    reset_for_tests()
    load_all(force=True)


def _failure(key: str = "sa-test") -> str:
    return next((f["error"] for f in get_hub().failures if f["key"] == key), "")


def _row(key: str) -> dict:
    return next(r for r in plugin_catalog() if r["key"] == key)


def _action(**fields: object) -> str:
    lines = ["[[start_actions]]"]
    for name, value in fields.items():
        lines.append(f"{name} = {json.dumps(value)}")
    return "\n" + "\n".join(lines) + "\n"


# (the [[start_actions]] tables, what the failure says)
BAD_TABLES = [
    (_action(label="No kind"), "each start action needs a study_kind"),
    (_action(study_kind="nope", label="X"), "study_kind 'nope' is not declared in [[study_kinds]]"),
    (_action(study_kind="bare", label="X"), "bare: its study kind has no workspace to open"),
    (_action(study_kind="part", label="One") + _action(study_kind="part", label="Two"), "part: has two start actions"),
    (_action(study_kind="part"), "part: needs a label"),
    (_action(study_kind="part", label="   "), "part: needs a label"),
    (_action(study_kind="part", label="x" * 41), "part: label is 41 characters; at most 40"),
    (_action(study_kind="part", label="Two\nlines"), "part: label must be one line of plain text"),
    (_action(study_kind="part", label="Right‮to left"), "part: label must be one line of plain text"),
    (_action(study_kind="part", label="Tab\there"), "part: label must be one line of plain text"),
    # Line and paragraph separators, isolates, direction marks and C1 controls too.
    (_action(study_kind="part", label="Line\u2028break"), "part: label must be one line of plain text"),
    (_action(study_kind="part", label="Para\u2029break"), "part: label must be one line of plain text"),
    (_action(study_kind="part", label="Isolate\u2066d"), "part: label must be one line of plain text"),
    (_action(study_kind="part", label="Mark\u200fed"), "part: label must be one line of plain text"),
    (_action(study_kind="part", label="Arabic\u061cmark"), "part: label must be one line of plain text"),
    (_action(study_kind="part", label="Next\u0085line"), "part: label must be one line of plain text"),
    (_action(study_kind="part", label="X", hint="Two\u2028lines"), "part: hint must be one line of plain text"),
    (_action(study_kind="part", label="X", home_label="Iso\u2069"), "part: home_label must be one line of plain text"),
    (_action(study_kind="part", label=7), "part: label must be text"),
    (_action(study_kind="part", label="X", hint="h" * 121), "part: hint is 121 characters; at most 120"),
    (_action(study_kind="part", label="X", home_label="h" * 41), "part: home_label is 41 characters; at most 40"),
    (_action(study_kind="part", label="X", home_label=""), "part: home_label is empty"),
    (_action(study_kind="part", label="X", header_label="h" * 25), "part: header_label is 25 characters; at most 24"),
    (
        _action(study_kind="part", label="X", header_label="P", places=["home"]),
        "part: header_label needs places to include header",
    ),
    (_action(study_kind="part", label="X", icon="<script>"), "part: icon must be one SVG path"),
    (_action(study_kind="part", label="X", places="home"), "part: places must be a list of names"),
    (_action(study_kind="part", label="X", places=["home", "home"]), "part: places names a place twice"),
    (_action(study_kind="part", label="X", places=["toolbar"]), "part: places names no place this app knows"),
    (_action(study_kind="part", label="X", places=[]), "part: places names no place this app knows"),
    (
        _action(study_kind="part", label="X") + _action(study_kind="twin", label="Y"),
        "twin: workspace 'bench' already has a header action (part); at most one",
    ),
    (
        _action(study_kind="wide", label="X"),
        "wide: the header button would show the workspace title 'A workspace title of thirty', "
        "longer than 24 characters; set header_label",
    ),
    ('\nstart_actions = "part"\n', "must be an array of tables"),
]


@pytest.mark.parametrize(("table", "why"), BAD_TABLES)
def test_a_bad_start_actions_table_fails_only_that_plugin(env, table: str, why: str):
    # A top-level key goes before the first table.
    top = table.startswith("\nstart_actions =")
    body = HEAD.replace("\n[[workspaces]]", table + "\n[[workspaces]]", 1) if top else HEAD + table
    _plugin(env["plugins"], body)
    shutil.copytree(START / "start-demo", env["plugins"] / "start-demo")
    _load()
    assert "sa-test" not in get_hub().manifests
    error = _failure()
    assert error.startswith("manifest [[start_actions]]: "), error
    assert why in error, error
    # The failure row says it; another plugin loads as before.
    row = _row("sa-test")
    assert row["status"] == "error" and row["error"] == error and row["start_actions"] == []
    assert "start-demo" in get_hub().manifests and _row("start-demo")["status"] == "enabled"


def test_good_tables_load_with_their_defaults(env):
    body = (
        HEAD
        + _action(study_kind="part", label="Design a part", home_label="New part", header_label="Parts", hint="Model it")
        + _action(study_kind="wide", label="Wide one", places=["home", "new_project", "empty_project"])
    )
    _plugin(env["plugins"], body)
    _load()
    assert _failure() == ""
    manifest = get_hub().manifests["sa-test"]
    part, wide = manifest.start_actions
    assert part.places == START_ACTION_PLACES == ("empty_project", "header", "new_project", "home")
    # The kind's icon when the action names none; texts never cut (a 24-character header label is fine).
    assert part.icon == "M1 1L2 2" and part.header_label == "Parts" and part.home_label == "New part"
    # No header place: a workspace title over 24 characters is fine.
    assert wide.places == ("home", "new_project", "empty_project") and wide.header_label == ""
    _plugin(env["plugins"], HEAD + _action(study_kind="wide", label="X", header_label="w" * 24))
    _load()
    assert _failure() == "" and get_hub().manifests["sa-test"].start_actions[0].header_label == "w" * 24


def test_unknown_places_are_ignored_with_a_warning_and_unknown_keys_are_ignored(env):
    shutil.copytree(START / "start-demo", env["plugins"] / "start-demo")
    shutil.copytree(START / "start-demo-2", env["plugins"] / "start-demo-2")
    _load()
    assert get_hub().failures == [] or all(f["key"] not in ("start-demo", "start-demo-2") for f in get_hub().failures)
    # start-demo's table has a key this host does not know ("colour"): it loads.
    demo = get_hub().manifests["start-demo"]
    assert [a.study_kind for a in demo.start_actions] == ["demo"]
    two = get_hub().manifests["start-demo-2"]
    alpha = next(a for a in two.start_actions if a.study_kind == "alpha")
    assert alpha.places == ("header", "empty_project", "new_project", "home")
    row = _row("start-demo-2")
    assert row["status"] == "enabled"
    warning = "manifest [[start_actions]]: place 'toolbar' is not known to this app; ignored"
    assert warning in row["notes"]
    assert [a["places"] for a in row["start_actions"] if a["study_kind"] == "alpha"] == [list(alpha.places)]
    assert _row("start-demo")["notes"] == []


def test_a_register_that_returns_its_manifest_keeps_the_start_actions_and_warnings(env):
    # templates/plugin/plugin.py returns a PluginManifest; the manifest's tables still count.
    for key in ("start-demo", "start-demo-2"):
        dest = env["plugins"] / key
        shutil.copytree(START / key, dest, ignore=shutil.ignore_patterns("__pycache__"))
        (dest / "plugin.py").write_text(
            "from cfddesk.registry.manifest import PluginManifest\n\n\n"
            "def register(hub):\n"
            f"    return PluginManifest(key={key!r}, name='X', version='1.0.0', api_version='1.4', source='local')\n",
            encoding="utf-8",
        )
    _load()
    assert all(f["key"] not in ("start-demo", "start-demo-2") for f in get_hub().failures)
    assert [a.study_kind for a in get_hub().manifests["start-demo"].start_actions] == ["demo"]
    assert [a["study_kind"] for a in _row("start-demo")["start_actions"]] == ["demo"]
    assert [a["study_kind"] for a in _row("start-demo-2")["start_actions"]] == ["alpha", "beta", "gamma"]
    warning = "manifest [[start_actions]]: place 'toolbar' is not known to this app; ignored"
    assert warning in _row("start-demo-2")["notes"]


def test_links_geometry_is_a_strict_boolean_that_needs_a_workspace(env):
    kinds = study_kinds_from_meta(
        {"study_kinds": [{"key": "part", "title": "Part", "workspace": "bench", "links_geometry": True}]}
    )
    assert kinds[0].links_geometry is True
    assert study_kinds_from_meta({"study_kinds": [{"key": "part", "title": "Part"}]})[0].links_geometry is False
    with pytest.raises(ValueError, match="part: links_geometry needs a workspace"):
        study_kinds_from_meta({"study_kinds": [{"key": "part", "title": "Part", "links_geometry": True}]})
    with pytest.raises(ValueError, match="part: links_geometry must be true or false"):
        study_kinds_from_meta(
            {"study_kinds": [{"key": "part", "title": "Part", "workspace": "bench", "links_geometry": "yes"}]}
        )
    # In a manifest: the plugin fails with the [[study_kinds]] text; the others load.
    _plugin(env["plugins"], HEAD.replace('key = "bare"\ntitle = "Bare"', 'key = "bare"\ntitle = "Bare"\nlinks_geometry = true'))
    _load()
    assert _failure() == "manifest [[study_kinds]]: bare: links_geometry needs a workspace"


def test_catalog_rows_carry_start_actions_only_for_plugins_that_are_on(env):
    shutil.copytree(START / "start-demo", env["plugins"] / "start-demo")
    _load()
    row = _row("start-demo")
    assert row["start_actions"] == [
        {
            "study_kind": "demo",
            "kind_title": "Demo",
            "workspace": "demo",
            "workspace_title": "Demo workspace",
            "label": "Design a demo",
            "home_label": "New demo",
            "header_label": "Demo",
            "hint": "Make a demo here, then simulate it",
            "icon": "M5 19V5h14v14z M9 9h6v6H9z",
            "places": ["empty_project", "header", "new_project", "home"],
        }
    ]
    # Off: listed with no start actions.
    env["local"].write_text(json.dumps({"plugins": {"disabled": ["start-demo"]}}), encoding="utf-8")
    _load()
    row = _row("start-demo")
    assert row["status"] == "disabled" and row["start_actions"] == []
    # Every other row has the field too (bundled ones and failures).
    assert all(r["start_actions"] == [] for r in plugin_catalog())


def test_a_plugin_that_needs_setup_publishes_no_start_action(env):
    folder = env["plugins"] / "env-demo"
    shutil.copytree(ENV_DEMO, folder, ignore=shutil.ignore_patterns("__pycache__"))
    (folder / "workspace").mkdir()
    (folder / "workspace" / "index.html").write_text("<!doctype html><title>x</title>", encoding="utf-8")
    text = (folder / "manifest.toml").read_text(encoding="utf-8")
    text = text.replace('schema_version = 2', 'schema_version = 2\nworkspace = "bench"')
    text += '\n[[workspaces]]\nkey = "bench"\ntitle = "Bench"\n\n[[start_actions]]\nstudy_kind = "demo_case"\nlabel = "Start a case"\n'
    (folder / "manifest.toml").write_text(text, encoding="utf-8")
    _load()
    assert "env-demo" in get_hub().manifests and get_hub().manifests["env-demo"].start_actions
    row = _row("env-demo")
    assert row["status"] == "needs setup" and row["start_actions"] == []
    assert methods.plugin_studies_list(project_id="proj-a")["kinds"] == []


def test_tree_kind_rows_carry_links_geometry_and_the_start_action_in_load_order(env):
    shutil.copytree(START / "start-demo-2", env["plugins"] / "start-demo-2")
    shutil.copytree(START / "start-demo", env["plugins"] / "start-demo")
    _load()
    kinds = methods.plugin_studies_list(project_id="proj-a")["kinds"]
    # Load order: user plugins by folder name, then manifest order.
    assert [(k["plugin"], k["key"]) for k in kinds] == [
        ("start-demo", "demo"),
        ("start-demo", "note"),
        ("start-demo-2", "alpha"),
        ("start-demo-2", "beta"),
        ("start-demo-2", "gamma"),
    ]
    assert list(get_hub().manifests).index("start-demo") < list(get_hub().manifests).index("start-demo-2")
    demo, note = kinds[0], kinds[1]
    assert demo["links_geometry"] is False and note["links_geometry"] is False
    assert note["start_action"] is None
    assert demo["start_action"] == _row("start-demo")["start_actions"][0]
    tree = methods.project_tree(project_id="proj-a")
    assert tree["plugin_study_kinds"] == kinds


def _uncommented_template() -> str:
    """The template's manifest with its commented examples turned on: every
    comment line that is a TOML table header or a key = value line."""
    out = []
    for line in (TEMPLATE / "manifest.toml").read_text(encoding="utf-8").splitlines():
        m = re.match(r"^# ?(\[\[[a-z_]+\]\]|[a-z_]+ = .*)$", line)
        out.append(m.group(1) if m else line)
    return "\n".join(out) + "\n"


def test_the_workspace_template_cites_only_sections_the_docs_have():
    docs = TEMPLATE.parents[1] / "docs" / "plugins"
    headings = {
        name: [ln.lstrip("#").strip() for ln in (docs / name).read_text(encoding="utf-8").splitlines() if ln.startswith("#")]
        for name in ("authoring.md", "compatibility.md")
    }
    cited = []
    for path in sorted(p for p in TEMPLATE.rglob("*") if p.is_file()):
        # A citation may run over two comment lines: join them first.
        text = re.sub(r"\s*\n\s*(?://|#)\s*", " ", path.read_text(encoding="utf-8"))
        for doc, section in re.findall(r"(authoring\.md|compatibility\.md),? \"([^\"]+)\"", text):
            cited.append((path.name, doc, section))
            assert section.lstrip("#").strip() in headings[doc], f"{path.name} cites {doc} \"{section}\", which it does not have"
    assert ("manifest.toml", "authoring.md", "Start actions (1.4)") in cited


def test_the_workspace_template_loads_as_is_and_with_its_examples(env):
    from cfddesk.registry import API_VERSION

    original = (TEMPLATE / "manifest.toml").read_text(encoding="utf-8")
    assert f'api_version = "{API_VERSION}"' in original
    on = _uncommented_template()
    assert "[[start_actions]]" in on and "\n# [[start_actions]]" in original
    assert "\nlinks_geometry = true" in on and "\n# links_geometry = true" in original
    for text, has_actions in ((original, False), (on, True)):
        dest = env["plugins"] / "workspace-template"
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(TEMPLATE, dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        (dest / "manifest.toml").write_text(text, encoding="utf-8")
        _load()
        key = "my-workspace"
        assert key in get_hub().manifests, [f["error"] for f in get_hub().failures]
        manifest = get_hub().manifests[key]
        assert manifest.workspaces and manifest.study_kinds[0].workspace == manifest.workspaces[0].key
        assert bool(manifest.start_actions) is has_actions
        assert manifest.study_kinds[0].links_geometry is has_actions
        assert _row(key)["status"] == "enabled"
        assert _row(key)["notes"] == []
