"""Folder-plugin demo: register one AnalysisType through discovery.

Key is not incompressible_* so W17 stays gated to the built-in family.
write_case reuses the built-in steady path (passthrough, not a new physics).
"""

from __future__ import annotations

from dataclasses import replace

from cfddesk.builtin.incompressible import build_incompressible_steady
from cfddesk.registry.manifest import PluginManifest


EXAMPLE_ANALYSIS_KEY = "example_passthrough"


def register(hub) -> PluginManifest:
    spec = replace(
        build_incompressible_steady(),
        key=EXAMPLE_ANALYSIS_KEY,
        label="Example plugin (passthrough)",
    )
    hub.registry("analysis").register(spec, plugin="example")
    return PluginManifest(
        key="example",
        name="Example plugin",
        version="0.1.0",
        requires=[],
        provides={"analysis": [EXAMPLE_ANALYSIS_KEY]},
        ui="ui",
    )
