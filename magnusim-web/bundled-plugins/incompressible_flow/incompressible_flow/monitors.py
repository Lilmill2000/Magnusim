"""Incompressible Flow's monitors: the MonitorType specs, the quantities its
run monitors carry, and which result controls are custom monitors.

``area_average`` (area-averaged velocity and pressure on a patch or on faces
the user picks) and ``flow_rate`` (volumetric flow through a patch). The case
writer emits their function objects (incompressible_flow.function_objects);
the ``write_function_object`` hooks here give the same text for one patch.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from cfddesk.registry.monitor import MonitorQuantity, MonitorType
from cfddesk.registry.schema import SchemaField

# The quantities run_monitors series carry, in the order the page lists them
# (results.run_monitors writes p_Pa, Umag, U, Un_m_s, Q_m3s and mdot_kgs per
# point). The same table the page used before analyses declared their own.
MONITOR_QUANTITIES: tuple[MonitorQuantity, ...] = (
    MonitorQuantity(
        "p", "Pressure", "p_Pa", unit_quantity="pressure", unit="Pa", color="#6941c6",
        headline=True, csv="pressure_Pa",
    ),
    MonitorQuantity(
        "Umag", "Mean velocity", "Umag", unit_quantity="velocity", unit="m/s",
        headline=True, csv="mean_velocity_m_s",
    ),
    MonitorQuantity("Ux", "Velocity X", "U", component=0, unit_quantity="velocity", unit="m/s", csv="Ux_m_s"),
    MonitorQuantity("Uy", "Velocity Y", "U", component=1, unit_quantity="velocity", unit="m/s", csv="Uy_m_s"),
    MonitorQuantity("Uz", "Velocity Z", "U", component=2, unit_quantity="velocity", unit="m/s", csv="Uz_m_s"),
    MonitorQuantity(
        "Un", "Normal velocity", "Un_m_s", unit_quantity="velocity", unit="m/s", magnitude=True,
        direction_from="Q_m3s", direction=("in", "out"), plot=False, csv="Un_m_s",
    ),
    MonitorQuantity(
        "Q", "Flow rate", "Q_m3s", unit_quantity="volumetric_flow", unit="m³/s", magnitude=True,
        direction_from="Q_m3s", direction=("in", "out"), plot=False, headline=True, csv="flow_m3_s",
    ),
    MonitorQuantity(
        "mdot", "Mass flow", "mdot_kgs", unit_quantity="mass_flow", unit="kg/s", magnitude=True,
        plot=False, csv="mass_kg_s",
    ),
)

# Other names an area-average monitor is saved under: result controls name
# their kind ("Area average") or category ("Surface data").
AREA_AVERAGE_ALIASES: tuple[str, ...] = ("Area average", "Surface data")


def _write_area_average(
    _ctx: Any,
    target_ref: str,
    write_control_text: str,
    *,
    fields: Sequence[str] = ("U", "p"),
) -> str:
    """The area-average function object for one patch (``mon_<patch>``)."""
    from .function_objects import surface_field_value_block

    patch = str(target_ref)
    return surface_field_value_block(
        f"mon_{patch}",
        patch,
        operation="areaAverage",
        fields=fields,
        write_control_text=write_control_text,
        log=True,
    )


def _write_flow_rate(
    _ctx: Any,
    target_ref: str,
    write_control_text: str,
    *,
    fields: Sequence[str] = ("phi",),
) -> str:
    """The flow-rate function object for one patch (``flow_<patch>``, sum of phi)."""
    from .function_objects import surface_field_value_block

    patch = str(target_ref)
    return surface_field_value_block(
        f"flow_{patch}",
        patch,
        operation="sum",
        fields=fields,
        write_control_text=write_control_text,
        log=False,
    )


def build_area_average() -> MonitorType:
    return MonitorType(
        key="area_average",
        label="Area average",
        target="patch",
        fields_schema=(
            SchemaField(
                "fields",
                "Fields",
                "text",
                default="U p",
                group="monitor",
            ),
        ),
        write_function_object=_write_area_average,
        description="Average velocity and pressure over the faces it is assigned to, at every saved step.",
        aliases=AREA_AVERAGE_ALIASES,
        user_creatable=True,
        quantities=("p", "Umag", "Ux", "Uy", "Uz"),
    )


def build_flow_rate() -> MonitorType:
    return MonitorType(
        key="flow_rate",
        label="Flow rate",
        target="patch",
        fields_schema=(
            SchemaField(
                "fields",
                "Fields",
                "text",
                default="phi",
                group="monitor",
            ),
        ),
        write_function_object=_write_flow_rate,
        description="Volume and mass flow through a boundary, at every saved step.",
        quantities=("Q", "mdot", "Un"),
    )


def custom_monitor_records(result_controls: list | None) -> list[dict[str, Any]]:
    """The result controls that are area-average monitors, in order.

    A record that names ``monitor_type: "area_average"`` is one. A record saved
    before monitor types is one when its kind, type, name or category mentions
    one of the area average's names ("Area average", "Surface data", any case).
    """
    words = [a.lower() for a in AREA_AVERAGE_ALIASES]
    out: list[dict[str, Any]] = []
    for rec in result_controls or []:
        if not isinstance(rec, dict):
            continue
        if rec.get("monitor_type") == "area_average":
            out.append(rec)
            continue
        label = " ".join(str(rec.get(k) or "") for k in ("kind", "type", "name", "category")).lower()
        if any(w in label for w in words):
            out.append(rec)
    return out


def custom_monitors(result_controls: list | None) -> list[dict[str, Any]]:
    """The custom monitors a run carries: ``{id, name, faces}`` for each
    area-average result control with faces assigned, in order."""
    out: list[dict[str, Any]] = []
    for rec in custom_monitor_records(result_controls):
        faces = [str(f) for f in (rec.get("faces") or []) if f]
        if faces:
            out.append({"id": rec.get("id"), "name": str(rec.get("name") or "Monitor"), "faces": faces})
    return out

