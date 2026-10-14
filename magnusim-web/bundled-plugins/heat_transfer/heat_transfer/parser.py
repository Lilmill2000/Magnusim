"""Heat Transfer's solver-output parser: residuals of the buoyant solvers, the run's
own end when it converged, and the plain reason a run died of a known cause.

Residuals: Ux, Uy, Uz, h (energy), p_rgh and the turbulence fields, the first
"Solving for" line of each per iteration (buoyantSimpleFoam / buoyantPimpleFoam,
OpenFOAM ESI v2606). With ``momentumPredictor no`` there are no U lines; none
of the series is required.

A ``converged`` event (API 1.4) when buoyantSimpleFoam's residualControl is met
("SIMPLE solution converged in N iterations") or the settle stop's condition is
met ("average: settle condition satisfied", then "Stopping calculation").

A ``failed_reason`` event only on fatal evidence (host API 1.8: the core
labels the run's failure with the last one): a Boussinesq case (its thermo
block names ``equationOfState Boussinesq``) whose density reached zero (the
"rho min/max" line: Boussinesq clips ρ₀ (1 − β ΔT) at 0 once β ΔT reaches 1)
and whose solver then dies (a floating point exception or a FOAM FATAL ERROR,
HT0). A density of zero alone, or in a perfect-gas case, emits nothing: a run
that recovers, or dies later of something else, is not blamed on it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from magnusim_sdk.events import Event
from magnusim_sdk.progress import RE_MPI_PREFIX, ProgressParser

from .settle import SETTLE_CONDITION

RESIDUAL_FIELDS = re.compile(r"Solving for (Ux|Uy|Uz|h|p_rgh|k|omega|epsilon), Initial residual = ([0-9.eE+-]+)")
RE_RESIDUALS_CONVERGED = re.compile(r"^\s*(\w+) solution converged in (\S+) iterations\s*$")
RE_CONDITION_MET = re.compile(r"^\s*average: (\w+) condition satisfied\s*$")
RE_STOPPING = re.compile(r"^\s*Stopping calculation\s*$")
RE_RHO = re.compile(r"(?:rho min/max\s*:|Min/max rho\s*:)\s*([0-9.eE+-]+)\s+([0-9.eE+-]+)")
RE_BOUSSINESQ = re.compile(r"^\s*equationOfState\s+Boussinesq\s*;")
# The solver dying: a floating point exception's stack, or OpenFOAM's fatal error.
RE_FATAL = re.compile(r"sigFpe|Floating point exception|FOAM FATAL (?:IO )?ERROR|FOAM aborting")

DENSITY_ZERO_REASON = "Boussinesq density reached zero: use incompressible perfect gas"


def _float(text: str) -> float | None:
    try:
        return float(text)
    except ValueError:
        return None


@dataclass
class HeatParser(ProgressParser):
    residual_re = RESIDUAL_FIELDS
    settle_met: bool = False
    converged: dict | None = None
    failed_reason: str | None = None
    boussinesq: bool = False
    density_zero: bool = False

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
        line = RE_MPI_PREFIX.sub("", str(raw or ""))
        if self.current is not None:
            hit = RESIDUAL_FIELDS.search(line)
            # Only the first residual of a field in each iteration counts (a second
            # one is a non-orthogonal or PIMPLE corrector).
            if hit and hit.group(1) in self.current:
                return []
        out = super().feed(raw)
        if RE_BOUSSINESQ.match(line):
            self.boussinesq = True
        rho = RE_RHO.search(line)
        if rho and self.boussinesq:
            low = _float(rho.group(1))
            if low is not None and low <= 0:
                self.density_zero = True
        if self.density_zero and self.failed_reason is None and RE_FATAL.search(line):
            self.failed_reason = DENSITY_ZERO_REASON
            out = [Event(event="failed_reason", fields={"reason": DENSITY_ZERO_REASON}), *out]
        if self.converged is not None:
            return out
        hit2 = RE_RESIDUALS_CONVERGED.match(line)
        if hit2:
            t = _float(hit2.group(2))
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
        if self.failed_reason:
            snap["failed_reason"] = self.failed_reason
        return snap
