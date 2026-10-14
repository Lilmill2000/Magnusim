"""Heat Transfer's monitors: the MonitorType specs, the quantities its run
monitors carry, and which of a run's result controls are its monitors.

- ``ht_wall_heat_flux`` (boundaries): the heat through the walls you pick, in W,
  and its mean and largest flux per area, at every iteration (or time step);
- ``ht_surface_temperature`` (boundaries): the area-averaged and the highest
  temperature on the boundaries you pick;
- ``ht_thermocouple`` (points): the temperature at points in the fluid over
  time.

Every run also gets the energy balance: the heat in and out through the walls
and the heat the flow carries out through the openings, shown under the
monitors when the run ends (heat_transfer.results). Temperatures are K in the
samples (the page shows them in °C or °F).
"""

from __future__ import annotations

import math
from typing import Any

from cfddesk.registry.monitor import MonitorQuantity, MonitorType

WALL_HEAT_FLUX = "ht_wall_heat_flux"
SURFACE_TEMPERATURE = "ht_surface_temperature"
THERMOCOUPLE = "ht_thermocouple"
MONITOR_KEYS: tuple[str, ...] = (WALL_HEAT_FLUX, SURFACE_TEMPERATURE, THERMOCOUPLE)

# What a boundary monitor stores for the walls no BC claims (the mesh's "walls" patch).
DEFAULT_WALLS = "@walls"
DEFAULT_WALLS_PATCH = "walls"

MONITOR_QUANTITIES: tuple[MonitorQuantity, ...] = (
    MonitorQuantity(
        "Q", "Heat flow", "Q_W", unit_quantity="power", unit="W", color="#d92d20", headline=True, csv="heat_W",
    ),
    MonitorQuantity(
        "q_avg", "Mean heat flux", "q_avg_W_m2", unit_quantity="heat_flux", unit="W/m²", color="#f79009",
        csv="mean_heat_flux_W_m2",
    ),
    MonitorQuantity(
        # The face flux of largest magnitude, its sign kept (negative: out of the fluid).
        "q_max", "Largest heat flux", "q_max_W_m2", unit_quantity="heat_flux", unit="W/m²", color="#dc6803",
        csv="max_heat_flux_W_m2",
    ),
    MonitorQuantity(
        "T_avg", "Average temperature", "T_avg_K", unit_quantity="temperature", unit="K", color="#1570ef",
        headline=True, csv="average_temperature_K",
    ),
    MonitorQuantity(
        "T_max", "Highest temperature", "T_max_K", unit_quantity="temperature", unit="K", color="#d92d20",
        csv="max_temperature_K",
    ),
    MonitorQuantity(
        "T_pt", "Temperature", "T_K", unit_quantity="temperature", unit="K", color="#d92d20", headline=True,
        csv="temperature_K",
    ),
    # The energy balance (every run): heat in and out through walls and openings.
    MonitorQuantity(
        "Q_in", "Heat in", "Q_in_W", unit_quantity="power", unit="W", color="#d92d20", headline=True, csv="heat_in_W",
    ),
    MonitorQuantity(
        "Q_out", "Heat out", "Q_out_W", unit_quantity="power", unit="W", color="#1570ef", headline=True,
        csv="heat_out_W",
    ),
    MonitorQuantity("imbalance", "Imbalance", "imbalance_pct", unit="%", color="#667085", csv="imbalance_pct"),
)

WALL_HEAT_FLUX_QUANTITIES: tuple[str, ...] = ("Q", "q_avg", "q_max")
SURFACE_TEMPERATURE_QUANTITIES: tuple[str, ...] = ("T_avg", "T_max")
THERMOCOUPLE_QUANTITIES: tuple[str, ...] = ("T_pt",)
BALANCE_QUANTITIES: tuple[str, ...] = ("Q_in", "Q_out", "imbalance")
BALANCE_KEY = "ht_energy_balance"


def build_wall_heat_flux() -> MonitorType:
    return MonitorType(
        key=WALL_HEAT_FLUX,
        label="Wall heat flux",
        target="boundary",
        description=(
            "The heat through the walls you pick (W, positive into the fluid) and its mean and largest "
            "flux per area, at every saved step."
        ),
        user_creatable=True,
        quantities=WALL_HEAT_FLUX_QUANTITIES,
        boundary_kinds=("wall",),
    )


def build_surface_temperature() -> MonitorType:
    return MonitorType(
        key=SURFACE_TEMPERATURE,
        label="Surface temperature",
        target="boundary",
        description="The average and the highest temperature on the boundaries you pick, at every saved step.",
        user_creatable=True,
        quantities=SURFACE_TEMPERATURE_QUANTITIES,
    )


def build_thermocouple() -> MonitorType:
    return MonitorType(
        key=THERMOCOUPLE,
        label="Thermocouple",
        target="point",
        description="The temperature at points you place in the fluid, over the run.",
        user_creatable=True,
        quantities=THERMOCOUPLE_QUANTITIES,
    )


def _point(p: Any) -> list[float] | None:
    if not isinstance(p, (list, tuple)) or len(p) != 3:
        return None
    try:
        out = [float(c) for c in p]
    except (TypeError, ValueError):
        return None
    return out if all(math.isfinite(c) for c in out) else None


def monitor_records(result_controls: Any) -> list[dict[str, Any]]:
    """The run's Heat Transfer monitors, in order: ``{id, name, type, boundaries | points}``."""
    out: list[dict[str, Any]] = []
    for rec in result_controls or []:
        if not isinstance(rec, dict):
            continue
        kind = str(rec.get("monitor_type") or "")
        if kind not in MONITOR_KEYS:
            continue
        row: dict[str, Any] = {"id": rec.get("id"), "name": str(rec.get("name") or "Monitor"), "type": kind}
        if kind == THERMOCOUPLE:
            row["points"] = [q for q in (_point(p) for p in rec.get("points") or []) if q is not None]
        else:
            row["boundaries"] = [str(b) for b in rec.get("boundaries") or [] if b]
        out.append(row)
    return out
