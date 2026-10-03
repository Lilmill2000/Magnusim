"""A plugin that owns a boundary-condition family with a face field (gate:l2-kinds, gate:l2-rewrite).

The family ``Demo porous`` is what the BC panel offers: its records are saved with
``bc_type: "Demo porous"`` and the family's fields at the top level, as every family's
are (scripts/w19-boundary-conditions.js buildBc). Its field ``extra_faces`` (widget
``faces``) holds more faces; the family resolves a record to the BC type ``demo_porous``.
While this plugin is off or not installed, the host cannot tell which fields of such a
record hold faces, so a linked geometry's update is refused (``plugin_needed``); while it
is on, the update rewrites ``extra_faces`` like any face list.
"""

from __future__ import annotations

from cfddesk.registry import BcTypeSpec, SchemaField
from cfddesk.registry.bc import BcFamily

KEY = "bc-demo"


def _resolve(_record: dict) -> tuple[str, dict]:
    return "demo_porous", {}


def register(hub):
    hub.registry("bc").register(
        BcTypeSpec(
            key="demo_porous",
            label="Demo porous wall",
            semantic="wall",
            patch_type="wall",
            family="demo_porous",
        ),
        plugin=KEY,
    )
    hub.registry("bc_family").register(
        BcFamily(
            key="demo_porous",
            label="Demo porous",
            record_type="Demo porous",
            color="wall",
            hint="A wall with more faces of its own",
            variants=("demo_porous",),
            fields=(SchemaField(key="extra_faces", label="Extra faces", kind="raw_dict", widget="faces", optional=True),),
            resolve=_resolve,
        ),
        plugin=KEY,
    )
