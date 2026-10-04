# SPDX-License-Identifier: GPL-3.0-or-later
"""Copy-paste plugin. Clone a registered builtin; do not import cfddesk.builtin."""

from __future__ import annotations

from dataclasses import replace

from cfddesk.registry.manifest import PluginManifest

PLUGIN = "template-demo"
# The host API this plugin is written for: the same as api_version in manifest.toml.
API_VERSION = "1.6"


def register(hub):
    steady = hub.registry("analysis").get("incompressible_steady")
    spec = replace(steady, key="template_demo", label="Template")
    hub.registry("analysis").register(spec, plugin=PLUGIN)
    return PluginManifest(
        key=PLUGIN,
        name="Template demo",
        version="0.1.0",
        description="Copy-paste plugin that clones the registered steady analysis",
        authors=["Magnusim"],
        api_version=API_VERSION,
        source="local",
    )
