"""Incompressible Flow's solver-output parser: the SDK engine, residuals of its fields,
and the run's own end when it converged (API 1.4 ``converged`` event).

Two ends are converged, from OpenFOAM ESI v2606's own lines:

- residuals: simpleFoam's residualControl is met ("SIMPLE solution converged in
  285 iterations", simpleControl::loop); the run writes and ends.
- monitor: the run's "Stop when a monitor settles" (incompressible_flow.settle):
  its runTimeControl prints "average: settle condition satisfied" and then
  "Stopping calculation" before it writes and ends.

Either gives one ``converged`` event: ``{by: "residuals" | "monitor", time}``
(``time`` is the iteration of a steady run). PIMPLE's per-step "PIMPLE:
converged in 3 iterations" is not a run's end and is not one.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from magnusim_sdk.events import Event
from magnusim_sdk.progress import RE_MPI_PREFIX, ProgressParser

from .settle import SETTLE_CONDITION

RESIDUAL_FIELDS = re.compile(
    r"Solving for (Ux|Uy|Uz|p|omega|k|epsilon|nuTilda|R(?:xx|xy|xz|yy|yz|zz)), Initial residual = ([0-9.eE+-]+)"
)
RE_RESIDUALS_CONVERGED = re.compile(r"^\s*(\w+) solution converged in (\S+) iterations\s*$")
RE_CONDITION_MET = re.compile(r"^\s*average: (\w+) condition satisfied\s*$")
RE_STOPPING = re.compile(r"^\s*Stopping calculation\s*$")


def _float(text: str) -> float | None:
    try:
        return float(text)
    except ValueError:
        return None


@dataclass
class IncompressibleParser(ProgressParser):
    """Velocity, pressure and turbulence residuals and a converged end; everything else as ProgressParser."""

    residual_re = RESIDUAL_FIELDS
    settle_met: bool = False
    converged: dict | None = None

    def _converged(self, by: str, time: float | None) -> Event:
        fields: dict = {"by": by}
        if time is not None:
            fields["time"] = time
        self.converged = dict(fields)
        return Event(event="converged", fields=fields)

    def _now(self) -> float | None:
        t = (self.current or {}).get("t")
        return float(t) if isinstance(t, (int, float)) else None

    def feed(self, raw: str) -> list[Event]:
        out = super().feed(raw)
        if self.converged is not None:
            return out
        line = RE_MPI_PREFIX.sub("", str(raw or ""))
        hit = RE_RESIDUALS_CONVERGED.match(line)
        if hit:
            t = _float(hit.group(2))
            return [self._converged("residuals", t if t is not None else self._now()), *out]
        met = RE_CONDITION_MET.match(line)
        if met:
            self.settle_met = met.group(1) == SETTLE_CONDITION
            return out
        if self.settle_met and RE_STOPPING.match(line):
            return [self._converged("monitor", self._now()), *out]
        return out

    def snapshot(self) -> dict:
        snap = super().snapshot()
        if self.converged is not None:
            snap["converged"] = dict(self.converged)
        return snap
