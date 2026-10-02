"""The plugin UI kit demo (gate:h14-field-widget-kit, gate:h14-workspace-kit).

Its mesher is the standard one, with the fineness field drawn by this plugin's
own widget (ui/index.tsx, a kit NumberUnitInput). Its workspace draws kit
controls in a sandboxed frame. The manifest comes from manifest.toml.
"""

from __future__ import annotations

from dataclasses import replace

PLUGIN = "kit-demo"


def register(hub):
    standard = hub.registry("mesher").get("standard")
    fields = []
    for field in standard.settings_schema:
        if field.key == "fineness":
            fields.append(replace(field, widget="kit-demo.number"))
        else:
            fields.append(field)
    spec = replace(
        standard,
        key="kit_demo_mesher",
        label="Kit demo mesher",
        settings_schema=tuple(fields),
        frozen=False,
        multi_region=False,
    )
    hub.registry("mesher").register(spec, plugin=PLUGIN)
    return None
