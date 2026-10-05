"""Incompressible Flow's monitors: the MonitorType specs, the quantities its
run monitors carry, and which result controls are custom monitors.

``area_average`` (area-averaged velocity and pressure on a patch or on faces
the user picks), ``flow_rate`` (volumetric flow through a patch), ``forces``
(force, moment and their coefficients on whole wall boundaries) and ``probe``
(velocity and pressure at points in the fluid).
The case writer emits their function objects (incompressible_flow.function_objects,
incompressible_flow.force_objects); the ``write_function_object`` hooks here
give the same text for one patch.
"""

from __future__ import annotations

import math
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
    # Forces monitors (incompressible_flow.forces_results): drag, lift and side
    # force along the study's reference directions, the total force, its pressure
    # and viscous parts, the moment about the centre of rotation, and the
    # coefficients when the study has a reference area (and length, for Cm).
    MonitorQuantity(
        "Fd", "Drag force", "Fd_N", unit_quantity="force", unit="N", color="#d92d20",
        headline=True, csv="drag_N",
    ),
    MonitorQuantity(
        "Fl", "Lift force", "Fl_N", unit_quantity="force", unit="N", color="#1570ef",
        headline=True, csv="lift_N",
    ),
    MonitorQuantity("Fs", "Side force", "Fs_N", unit_quantity="force", unit="N", color="#7a5af8", csv="side_N"),
    MonitorQuantity("Fdp", "Pressure drag", "Fdp_N", unit_quantity="force", unit="N", csv="pressure_drag_N"),
    MonitorQuantity("Fdv", "Viscous drag", "Fdv_N", unit_quantity="force", unit="N", csv="viscous_drag_N"),
    MonitorQuantity("Fx", "Force X", "F_N", component=0, unit_quantity="force", unit="N", csv="Fx_N"),
    MonitorQuantity("Fy", "Force Y", "F_N", component=1, unit_quantity="force", unit="N", csv="Fy_N"),
    MonitorQuantity("Fz", "Force Z", "F_N", component=2, unit_quantity="force", unit="N", csv="Fz_N"),
    MonitorQuantity(
        "Fpx", "Pressure force X", "Fp_N", component=0, unit_quantity="force", unit="N", plot=False, csv="Fpx_N",
    ),
    MonitorQuantity(
        "Fpy", "Pressure force Y", "Fp_N", component=1, unit_quantity="force", unit="N", plot=False, csv="Fpy_N",
    ),
    MonitorQuantity(
        "Fpz", "Pressure force Z", "Fp_N", component=2, unit_quantity="force", unit="N", plot=False, csv="Fpz_N",
    ),
    MonitorQuantity(
        "Fvx", "Viscous force X", "Fv_N", component=0, unit_quantity="force", unit="N", plot=False, csv="Fvx_N",
    ),
    MonitorQuantity(
        "Fvy", "Viscous force Y", "Fv_N", component=1, unit_quantity="force", unit="N", plot=False, csv="Fvy_N",
    ),
    MonitorQuantity(
        "Fvz", "Viscous force Z", "Fv_N", component=2, unit_quantity="force", unit="N", plot=False, csv="Fvz_N",
    ),
    MonitorQuantity("Mx", "Moment X", "M_Nm", component=0, unit_quantity="moment", unit="N·m", csv="Mx_Nm"),
    MonitorQuantity("My", "Moment Y", "M_Nm", component=1, unit_quantity="moment", unit="N·m", csv="My_Nm"),
    MonitorQuantity("Mz", "Moment Z", "M_Nm", component=2, unit_quantity="moment", unit="N·m", csv="Mz_Nm"),
    MonitorQuantity("Cd", "Drag coefficient", "Cd", color="#d92d20", headline=True, csv="Cd"),
    MonitorQuantity("Cl", "Lift coefficient", "Cl", color="#1570ef", headline=True, csv="Cl"),
    MonitorQuantity("Cs", "Side force coefficient", "Cs", color="#7a5af8", csv="Cs"),
    MonitorQuantity("Cm", "Pitching moment coefficient", "CmPitch", csv="Cm_pitch"),
    # Point probes (incompressible_flow.probes_results): Pressure (p) and the
    # velocity components (Ux, Uy, Uz) above, and the speed at the point.
    MonitorQuantity(
        "Upt", "Velocity magnitude", "Upt_m_s", unit_quantity="velocity", unit="m/s", headline=True,
        csv="velocity_magnitude_m_s",
    ),
)

# The quantities a boundary (mon_/flow_) row and an area-average monitor's row
# carry: the table before Forces monitors, so their plots, details and CSV
# columns stay as they were.
AREA_AVERAGE_QUANTITY_KEYS: tuple[str, ...] = ("p", "Umag", "Ux", "Uy", "Uz", "Un", "Q", "mdot")

FORCE_QUANTITY_KEYS: tuple[str, ...] = (
    "Fd", "Fl", "Fs", "Fdp", "Fdv", "Fx", "Fy", "Fz",
    "Fpx", "Fpy", "Fpz", "Fvx", "Fvy", "Fvz", "Mx", "My", "Mz",
)
PROBE_QUANTITY_KEYS: tuple[str, ...] = ("p", "Upt", "Ux", "Uy", "Uz")
FORCE_COEFFICIENT_KEYS: tuple[str, ...] = ("Cd", "Cl", "Cs")
MOMENT_COEFFICIENT_KEYS: tuple[str, ...] = ("Cm",)

# What a Forces monitor stores in ``boundaries`` for the walls no BC claims (the
# mesh's ``walls`` patch); its other entries are BC ids (a BC without one: its name).
DEFAULT_WALLS = "@walls"
DEFAULT_WALLS_PATCH = "walls"
DEFAULT_WALLS_LABEL = "Walls with no boundary condition"

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

    A record that names ``monitor_type: "area_average"`` is one; one that names
    another type is not. A record saved before monitor types is one when its
    kind, type, name or category mentions one of the area average's names
    ("Area average", "Surface data", any case).
    """
    words = [a.lower() for a in AREA_AVERAGE_ALIASES]
    out: list[dict[str, Any]] = []
    for rec in result_controls or []:
        if not isinstance(rec, dict):
            continue
        if rec.get("monitor_type") == "area_average":
            out.append(rec)
            continue
        if rec.get("monitor_type"):
            continue
        label = " ".join(str(rec.get(k) or "") for k in ("kind", "type", "name", "category")).lower()
        if any(w in label for w in words):
            out.append(rec)
    return out


def build_forces() -> MonitorType:
    return MonitorType(
        key="forces",
        label="Forces",
        target="boundary",
        description=(
            "Force and moment on the walls you pick, along the study's drag and lift directions, "
            "and their coefficients once the study has a reference area, at every saved step."
        ),
        user_creatable=True,
        quantities=FORCE_QUANTITY_KEYS + FORCE_COEFFICIENT_KEYS + MOMENT_COEFFICIENT_KEYS,
        boundary_kinds=("wall",),
        study_note="Uses the study's reference values: speed, area, length, directions and centre of rotation.",
    )


def forces_monitor_records(result_controls: list | None) -> list[dict[str, Any]]:
    """The result controls that are Forces monitors (``monitor_type: "forces"``):
    ``{id, name, boundaries}`` each, in order, with or without boundaries."""
    out: list[dict[str, Any]] = []
    for rec in result_controls or []:
        if isinstance(rec, dict) and rec.get("monitor_type") == "forces":
            boundaries = [str(b) for b in (rec.get("boundaries") or []) if b]
            out.append({"id": rec.get("id"), "name": str(rec.get("name") or "Forces"), "boundaries": boundaries})
    return out


def build_probe() -> MonitorType:
    return MonitorType(
        key="probe",
        label="Point probe",
        target="point",
        description="Pressure and velocity at points you place in the fluid, at every saved step.",
        user_creatable=True,
        quantities=PROBE_QUANTITY_KEYS,
    )


def _point(p: Any) -> list[float] | None:
    if not isinstance(p, (list, tuple)) or len(p) != 3:
        return None
    try:
        out = [float(c) for c in p]
    except (TypeError, ValueError):
        return None
    return out if all(math.isfinite(c) for c in out) else None


def probe_monitor_records(result_controls: list | None) -> list[dict[str, Any]]:
    """The result controls that are Point probes (``monitor_type: "probe"``):
    ``{id, name, points}`` each (points in metres; a malformed one is left out)."""
    out: list[dict[str, Any]] = []
    for rec in result_controls or []:
        if isinstance(rec, dict) and rec.get("monitor_type") == "probe":
            points = [q for q in (_point(p) for p in rec.get("points") or []) if q is not None]
            out.append({"id": rec.get("id"), "name": str(rec.get("name") or "Point probe"), "points": points})
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

