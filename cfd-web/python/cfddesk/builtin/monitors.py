"""Built-in MonitorSpec specs (Phase 2 land5).

Keys area_average / flow_rate match plan Step 5. Phase 1 function_objects still
uses MonitorKind Literal "area_average"|"flow" for instance descriptors — that
path is not moved this land (soft-pass: wrap/register only).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Sequence

from cfddesk.registry.monitor import MonitorSpec
from cfddesk.registry.schema import SchemaField

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub


def _write_area_average(
    _ctx: Any,
    target_ref: str,
    write_control_text: str,
    *,
    fields: Sequence[str] = ("U", "p"),
) -> str:
    """Stub pointing at Phase 1 surfaceFieldValue helper (no call-site move)."""
    from cfddesk.case.function_objects import surface_field_value_block

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
    """Stub for flow_<patch> sum(phi) FO (Phase 1 function_objects)."""
    from cfddesk.case.function_objects import surface_field_value_block

    patch = str(target_ref)
    return surface_field_value_block(
        f"flow_{patch}",
        patch,
        operation="sum",
        fields=fields,
        write_control_text=write_control_text,
        log=False,
    )


def _parse_dat_stub(text: str) -> list[dict[str, Any]]:
    """Minimal .dat line parse stub — full w27 parser stays in UI/Phase 1 paths."""
    rows: list[dict[str, Any]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        try:
            rows.append({"t": float(parts[0]), "value": float(parts[1])})
        except ValueError:
            continue
    return rows


def build_area_average() -> MonitorSpec:
    return MonitorSpec(
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
        parse_dat=_parse_dat_stub,
    )


def build_flow_rate() -> MonitorSpec:
    return MonitorSpec(
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
        parse_dat=_parse_dat_stub,
    )


def register_monitors(hub: "RegistryHub") -> None:
    """Register area_average + flow_rate (idempotent same-plugin)."""
    reg = hub.registry("monitor")
    reg.register(build_area_average(), plugin="builtin")
    reg.register(build_flow_rate(), plugin="builtin")
