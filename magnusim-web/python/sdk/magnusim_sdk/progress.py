"""Solver log -> job events (MAGNUSIM_EVENT): the engine every log parser uses.

``ProgressParser`` passes solve.sh events through, times the solve phases from
their ``t_wall`` stamps, and turns OpenFOAM ``Time =``, Courant, deltaT and
``Solving for`` lines into ``progress``, ``courant`` and ``residual`` events.
``RegionProgressParser`` reads a multi-region solver's log (host API 1.8, e.g.
chtMultiRegionSimpleFoam): its residuals are keyed ``<region>:<field>``.
Standard library only.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from magnusim_sdk.events import Event, parse_line

RE_TIME = re.compile(r"^Time\s*=\s*([0-9.+-eE]+)\s*$")
RE_COURANT = re.compile(r"^Courant Number mean:\s*([0-9.eE+-]+)\s+max:\s*([0-9.eE+-]+)")
RE_DELTAT = re.compile(r"^deltaT\s*=\s*([0-9.eE+-]+)")
RE_MPI_PREFIX = re.compile(r"^\s*\[\d+\]\s*")
# Any solver's residual line: the field is whatever it solves for.
RE_RESIDUAL_ANY = re.compile(r"Solving for (\w+), Initial residual = ([0-9.eE+-]+)")
# A multi-region solver's block header, and its per-region Courant line (transient).
RE_REGION_BLOCK = re.compile(r"^Solving for (fluid|solid) region (\w+)\s*$")
RE_REGION_COURANT = re.compile(r"^Region:\s*(\w+)\s+Courant Number mean:\s*([0-9.eE+-]+)\s+max:\s*([0-9.eE+-]+)")
# Joins a region and a field in a residual key: "air:h".
REGION_KEY_SEP = ":"

# solve.sh stage that starts each timed phase; any later stage/result ends it.
PHASE_OF_STAGE = {
    "copy_to_wsl": "copy_in",
    "decompose": "decompose",
    "solve": "solve",
    "reconstruct": "reconstruct",
    "copy": "copy_back",
}


def parse_residual_line(line: str, pattern: re.Pattern[str] = RE_RESIDUAL_ANY) -> dict[str, Any] | None:
    """One OpenFOAM 'Solving for … Initial residual' line, or None."""
    cleaned = RE_MPI_PREFIX.sub("", str(line or ""))
    match = pattern.search(cleaned)
    if not match:
        return None
    try:
        value = float(match.group(2))
    except ValueError:
        return None
    name = match.group(1)
    return {"field": name, "initial": value, "fields": {name: value}}


def region_key(region: str, field_name: str) -> str:
    """The residual key of ``field_name`` solved in ``region``: ``<region>:<field>``."""
    return f"{region}{REGION_KEY_SEP}{field_name}"


def split_region_key(key: str) -> tuple[str, str]:
    """``(region, field)`` of a residual key; region '' for a key of a one-region run."""
    region, sep, name = str(key).partition(REGION_KEY_SEP)
    return (region, name) if sep else ("", region)


def parse_extra_line(line: str) -> dict[str, Any] | None:
    """Courant or deltaT line, or None."""
    cleaned = RE_MPI_PREFIX.sub("", str(line or ""))
    courant = RE_COURANT.match(cleaned)
    if courant:
        return {
            "kind": "courant",
            "mean": float(courant.group(1)),
            "max": float(courant.group(2)),
        }
    delta = RE_DELTAT.match(cleaned)
    if delta:
        return {"kind": "delta_t", "delta_t": float(delta.group(1))}
    return None


@dataclass
class ProgressParser:
    """Solver output -> job events: the one parser (Node only aggregates events).

    solve.sh protocol events pass through (stage and result events also close
    the timed ``phase``); OpenFOAM ``Time =`` lines become ``progress``, Courant
    and deltaT lines ``courant``, and ``Solving for`` lines ``residual`` for the
    fields ``residual_re`` matches (any field here; an analysis's subclass may
    narrow it). An analysis names its parser in its launch spec.
    """

    residual_re = RE_RESIDUAL_ANY

    stage: str = "starting"
    current: dict | None = None
    pending: dict = field(default_factory=dict)
    series: list[dict] = field(default_factory=list)
    saved_times: list[float] = field(default_factory=list)
    solve_started: bool = False
    phases: dict = field(default_factory=dict)
    _phase: str | None = None
    _phase_t0: float | None = None

    def _clock_phase(self, ev: Event) -> Event | None:
        """Close the running phase at this stage/result event; start the next one."""
        raw = ev.fields.get("t_wall")
        try:
            t = float(raw) if raw is not None else None
        except (TypeError, ValueError):
            t = None
        if t is None:
            return None
        done = None
        if self._phase is not None and self._phase_t0 is not None:
            secs = round(max(0.0, t - self._phase_t0), 3)
            self.phases[self._phase] = secs
            done = Event(event="phase", fields={"phase": self._phase, "seconds": secs})
        nxt = PHASE_OF_STAGE.get(str(ev.fields.get("stage") or "")) if ev.event == "stage" else None
        self._phase = nxt
        self._phase_t0 = t if nxt else None
        return done

    def _enter_solve(self) -> None:
        if self.stage in ("starting", "decompose", "copy", ""):
            self.stage = "solve"

    def feed(self, raw: str) -> list[Event]:
        line = RE_MPI_PREFIX.sub("", str(raw or ""))
        out: list[Event] = []

        # Prefer explicit protocol events from the bash template.
        ev = parse_line(line)
        if ev is not None:
            if ev.event in ("stage", "result"):
                phase = self._clock_phase(ev)
                if phase is not None:
                    out.append(phase)
            if ev.event == "stage":
                st = str(ev.fields.get("stage") or "")
                if st == "decompose":
                    self.stage = "decompose"
                elif st == "solve":
                    self.stage = "solve"
                elif st in ("reconstruct", "solve_end"):
                    self.stage = "reconstruct" if st == "reconstruct" else self.stage
                    if st == "solve_end":
                        self.stage = "reconstruct"
                elif st == "copy":
                    self.stage = "copy"
                elif st == "copy_to_wsl":
                    self.stage = "copy"
            if ev.event == "time_saved":
                t = ev.fields.get("t")
                try:
                    tf = float(t) if t is not None else None
                except (TypeError, ValueError):
                    tf = None
                if tf is not None and tf not in self.saved_times:
                    self.saved_times.append(tf)
                if tf is not None:
                    self._enter_solve()
            if ev.event in ("progress", "residual", "courant"):
                self._enter_solve()
            out.append(ev)
            return out

        # OpenFOAM progress lines → residual / courant / progress events
        tm = RE_TIME.match(line)
        if tm:
            self._enter_solve()
            if self.stage != "solve":
                return out
            if self.current and isinstance(self.current.get("t"), (int, float)):
                self.series.append(dict(self.current))
            t = float(tm.group(1))
            prev = self.current or {}
            pend = self.pending or {}
            self.pending = {}
            self.current = {"t": t}
            for k in ("delta_t", "co_max", "co_mean"):
                if isinstance(pend.get(k), (int, float)):
                    self.current[k] = pend[k]
                elif isinstance(prev.get(k), (int, float)):
                    self.current[k] = prev[k]
            if not self.solve_started and t > 0:
                self.solve_started = True
            fields: dict[str, Any] = {"time": t, "sim_time": t}
            for k in ("delta_t", "co_max", "co_mean"):
                if k in self.current:
                    fields[k] = self.current[k]
            out.append(Event(event="progress", fields=fields))
            return out

        extra = parse_extra_line(line)
        if extra is not None and extra.get("kind") == "courant":
            self._enter_solve()
            if self.stage == "solve":
                mean = float(extra["mean"])
                mx = float(extra["max"])
                self.pending["co_mean"] = mean
                self.pending["co_max"] = mx
                out.append(
                    Event(event="courant", fields={"mean": mean, "max": mx})
                )
            return out
        if extra is not None and extra.get("kind") == "delta_t":
            self._enter_solve()
            if self.stage == "solve":
                v = float(extra["delta_t"])
                self.pending["delta_t"] = v
                out.append(Event(event="courant", fields={"delta_t": v}))
            return out

        residual = parse_residual_line(line, self.residual_re)
        if residual and self.current is not None:
            out.append(self.residual_event(str(residual["field"]), float(residual["initial"])))
            return out

        # Pass through non-empty solver lines as log (skip blank)
        if line.strip():
            out.append(Event(event="log", fields={"line": line[:2000]}))
        return out

    def residual_event(self, name: str, value: float) -> Event:
        """A ``residual`` event for the open step (``name`` already keyed); kept in the step."""
        assert self.current is not None
        self.current[name] = value
        return Event(
            event="residual",
            fields={"time": self.current.get("t"), "field": name, "initial": value, "fields": {name: value}},
        )

    def snapshot(self) -> dict:
        cur = self.current or {}
        residuals = []
        for s in self.series:
            residuals.append(dict(s))
        if cur and "t" in cur:
            residuals.append(dict(cur))
        return {
            "stage": self.stage,
            "iteration": cur.get("t"),
            "sim_time": cur.get("t"),
            "n_steps": len(self.series) + (1 if cur else 0),
            "residuals": residuals,
            "saved_times": list(self.saved_times),
            "co_max": cur.get("co_max"),
            "delta_t": cur.get("delta_t"),
            "phases": dict(self.phases),
        }


@dataclass
class RegionProgressParser(ProgressParser):
    """A multi-region solver's log (chtMultiRegionSimpleFoam, chtMultiRegionFoam).

    Each step solves its regions in blocks headed ``Solving for fluid region <r>``
    or ``Solving for solid region <r>``. A residual is keyed ``<region>:<field>``
    (``air:h``, ``heater:h``; :func:`region_key`), and only the FIRST residual of a
    field in a region per step is kept: a solid's header repeats for each
    non-orthogonal corrector, and a later pass's residual is not the step's.
    A transient run's ``Region: <r> Courant Number`` lines give the step the
    largest Courant number of its regions. Every other line reads as in
    :class:`ProgressParser`. An analysis names it as its log parser
    (``LogParserRef("magnusim_sdk.progress", "RegionProgressParser")``) or
    subclasses it (``residual_re`` narrows the fields).
    """

    region: str = ""
    _taken: set[str] = field(default_factory=set)
    _co_max: float | None = None

    def feed(self, raw: str) -> list[Event]:
        line = RE_MPI_PREFIX.sub("", str(raw or ""))
        block = RE_REGION_BLOCK.match(line.strip())
        if block:
            self.region = block.group(2)
            return []
        if RE_TIME.match(line):
            out = super().feed(raw)
            # A new step: no region yet, nothing taken, the Courant lines before it were its own.
            self.region = ""
            self._taken = set()
            self._co_max = None
            return out
        courant = RE_REGION_COURANT.match(line)
        if courant:
            self._enter_solve()
            if self.stage != "solve":
                return []
            mx = float(courant.group(3))
            mean = float(courant.group(2))
            # Regions print in turn before the step's Time line: the step shows the largest.
            if self._co_max is not None and mx < self._co_max:
                return []
            self._co_max = mx
            self.pending["co_mean"] = mean
            self.pending["co_max"] = mx
            return [Event(event="courant", fields={"mean": mean, "max": mx})]
        if self.region:
            residual = parse_residual_line(line, self.residual_re)
            if residual is not None:
                if self.current is None:
                    return []
                key = region_key(self.region, str(residual["field"]))
                if key in self._taken:
                    return []
                self._taken.add(key)
                return [self.residual_event(key, float(residual["initial"]))]
        return super().feed(raw)
