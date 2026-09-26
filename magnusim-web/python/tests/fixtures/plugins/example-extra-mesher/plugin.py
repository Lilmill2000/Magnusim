"""Mesh backend that reuses the standard generate tool with a new default."""

from __future__ import annotations

from dataclasses import replace

from cfddesk.registry.manifest import PluginManifest

PLUGIN = "example-extra-mesher"


def register(hub):
    standard = hub.registry("mesher").get("standard")
    fields = []
    for field in standard.settings_schema:
        if field.key == "fineness":
            fields.append(replace(field, default=3))
        else:
            fields.append(field)
    spec = replace(
        standard,
        key="example_extra_mesher",
        label="Extra mesher",
        settings_schema=tuple(fields),
        frozen=False,
        multi_region=False,
    )
    hub.registry("mesher").register(spec, plugin=PLUGIN)
    return PluginManifest(
        key=PLUGIN,
        name="Extra mesher",
        version="0.1.0",
        description="Standard mesher with a different fineness default",
        authors=["Magnusim"],
        api_version="1.0",
        source="local",
    )
