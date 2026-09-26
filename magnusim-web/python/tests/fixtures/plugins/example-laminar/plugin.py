"""Steady laminar analysis. Clones the registered incompressible writer."""

from __future__ import annotations

from dataclasses import replace

from cfddesk.registry.manifest import PluginManifest

PLUGIN = "example-laminar"


def register(hub):
    steady = hub.registry("analysis").get("incompressible_steady")
    settings = []
    for field in steady.settings_schema:
        if field.key == "turbulence_model":
            settings.append(replace(field, default="laminar", choices=("laminar",), choice_labels=("Laminar",)))
        else:
            settings.append(field)
    spec = replace(
        steady,
        key="laminar_steady",
        label="Laminar",
        default_turbulence="laminar",
        turbulence_models=("laminar",),
        settings_schema=tuple(settings),
    )
    hub.registry("analysis").register(spec, plugin=PLUGIN)
    return PluginManifest(
        key=PLUGIN,
        name="Laminar example",
        version="0.1.0",
        description="Steady laminar analysis using the built-in incompressible writer",
        authors=["Magnusim"],
        api_version="1.0",
        source="local",
    )
