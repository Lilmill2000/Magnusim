"""Test plugin whose manifest key differs from its folder name (UI still loads)."""

from __future__ import annotations

from cfddesk.registry.manifest import PluginManifest

PLUGIN = "key-not-folder"


def register(hub):
    del hub
    return PluginManifest(
        key=PLUGIN,
        name="Key differs from folder",
        version="0.1.0",
        description="Test plugin whose manifest key is not its folder name",
        authors=["Magnusim"],
        api_version="1.0",
        ui="ui",
        source="local",
    )
