#!/usr/bin/env python3
"""Dump what the worker answers when CAD is the only plugin (the CAD edition).

CLI: tools/cad_edition_dump.py

Prints JSON: {"describe": registry.describe, "plugins": plugins.list, "kinds":
plugin_studies.list's study kinds, "schema_versions": {plugin: {kind: n}}}, made by the
real worker methods with a bundled folder that holds only bundled-plugins/cad's
manifest.toml, plugin.py and workspace entry and commands file, no user plugins and an empty local.json. The CAD
edition has no Python: scripts/gen-cad-edition.mjs turns this into the registry
its server answers (scripts/generated/cad-edition-registry.json).
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

CFDDESK_ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = Path(__file__).resolve().parents[2]
for p in (CFDDESK_ROOT / "sdk", CFDDESK_ROOT):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="magnusim-cad-edition-") as tmp:
        base = Path(tmp)
        bundled = base / "bundled" / "cad"
        bundled.mkdir(parents=True)
        src = WEB_ROOT / "bundled-plugins" / "cad"
        # The manifest, plugin.py, and each workspace's entry and commands file (discovery checks
        # they are there).
        (bundled / "workspace").mkdir()
        names = {"manifest.toml", "plugin.py"}
        from cfddesk.registry.discovery import _parse_toml

        manifest = _parse_toml((src / "manifest.toml").read_text(encoding="utf-8"))[0] or {}
        for row in manifest.get("workspaces") or []:
            for field, default in (("entry", "workspace/index.html"), ("commands", "")):
                rel = str(row.get(field) or default).strip().replace("\\", "/")
                if rel:
                    names.add(rel)
        for name in sorted(names):
            (bundled / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src / name, bundled / name)
        (base / "user").mkdir()
        local = base / "local.json"
        local.write_text("{}", encoding="utf-8")
        os.environ["MAGNUSIM_BUNDLED_DIR"] = str(base / "bundled")
        os.environ["MAGNUSIM_PLUGINS_DIR"] = str(base / "user")
        os.environ["MAGNUSIM_LOCAL_JSON"] = str(local)
        # An empty project: plugin_studies.list answers the study kinds a project can make.
        projects = base / "projects"
        (projects / "p-empty").mkdir(parents=True)
        (projects / "p-empty" / "project.json").write_text('{"id": "p-empty"}', encoding="utf-8")
        os.environ["MAGNUSIM_PROJECTS_ROOT"] = str(projects)

        from cfddesk.registry import load_all
        from cfddesk.registry.discovery import reset_for_tests
        from cfddesk.worker import methods

        reset_for_tests()
        hub = load_all(force=True)
        doc = {
            "describe": methods.registry_describe(),
            "plugins": methods.plugins_list()["plugins"],
            "kinds": methods.plugin_studies_list("p-empty")["kinds"],
            # What plugins.list leaves out: each study kind's schema version.
            "schema_versions": {
                key: {k.key: int(k.schema_version) for k in m.study_kinds} for key, m in hub.manifests.items()
            },
        }
    sys.stdout.write(json.dumps(doc, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
