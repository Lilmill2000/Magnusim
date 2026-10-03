"""A BC family of its own: a symmetry plane, offered by a steady analysis.

The analysis clones Incompressible Flow's steady one and adds ``symmetry_plane``
to its BC types. The ``symmetry`` family names no UI component, so the core's
BC editor draws its one choice field as a generic form. Its writer is minimal:
the e2e that uses it never solves.
"""

from __future__ import annotations

from dataclasses import replace

from cfddesk.registry.bc import BcFamily, BcTypeSpec
from cfddesk.registry.manifest import PluginManifest
from cfddesk.registry.schema import SchemaField

PLUGIN = "example-extra-bc"


def _symmetry(name: str, _settings: dict, _ctx: dict) -> str:
    return f"    {name}\n    {{\n        type            symmetryPlane;\n    }}\n"


def _resolve(_record: dict) -> tuple[str, dict]:
    return "symmetry_plane", {}


def register(hub):
    hub.registry("bc").register(
        BcTypeSpec(
            key="symmetry_plane",
            label="Symmetry",
            semantic="wall",
            patch_type="patch",
            write_U=_symmetry,
            write_p=_symmetry,
            family="symmetry",
        ),
        plugin=PLUGIN,
    )
    hub.registry("bc_family").register(
        BcFamily(
            key="symmetry",
            label="Symmetry",
            record_type="Symmetry",
            color="other",
            hint="Mirror plane: no flow through it",
            variants=("symmetry_plane",),
            defaults={"metric": {"mirror": "Plane"}, "imperial": {"mirror": "Plane"}},
            fields=(
                SchemaField(
                    "mirror",
                    "Mirror",
                    "choice",
                    default="Plane",
                    choices=("Plane", "Wedge"),
                    description="How the plane mirrors the flow.",
                ),
            ),
            resolve=_resolve,
        ),
        plugin=PLUGIN,
    )
    steady = hub.registry("analysis").get("incompressible_steady")
    hub.registry("analysis").register(
        replace(
            steady,
            key="extra_bc_steady",
            label="Extra BC",
            bc_types=(*tuple(steady.bc_types or ()), "symmetry_plane"),
        ),
        plugin=PLUGIN,
    )
    return PluginManifest(
        key=PLUGIN,
        name="Extra BC",
        version="0.1.0",
        description="Steady incompressible analysis that also offers a symmetry plane boundary condition",
        authors=["Magnusim"],
        api_version="1.4",
        source="local",
    )
