"""Run health: how stable a solve is, from its solver's own log (RH1).

``HealthTracker`` reads an OpenFOAM (ESI v2606) solver log line by line, as the
relay streams it (``cfddesk.wsl.solve_run.stream_events_to_stdout``) or from a
file (``python -m magnusim_sdk.health replay``), and keeps a verdict:

- ``pending``: steps 1-5 (the start is never scored);
- ``healthy``: no check trips; it never means accurate or converged;
- ``watch``: a symptom check at watch, or a risk check out of range;
- ``unhealthy``: a symptom check at unhealthy;
- ``failed``: a fatal line after "Starting time loop", or a parsed value that is
  nan/inf. Final.

Scoring (spec section 2.2): steps 6 and later are scored. A continuous check
(``pv_coupling``, ``residuals_high``, ``speed_growth``, the observed Courant
number) is at a level when at least 3 of its last 5 scored steps reached it. An
event check (``velocity_clipped``, ``solver_at_limit``, ``turbulence_bounded``,
``continuity_bias``) uses its share over the last 50 scored steps. The verdict
worsens at once and improves only after 5 scored steps in a row at the better
verdict; while it waits, the checks that set it stay listed at its level (``held``), so a
verdict of watch or unhealthy always has a finding at warn or error that says why. Baselines come
from steps 6-25; the checks that need them start at step 26.

Memory is O(50): the last 50 scored steps, the baseline buffer, lifetime counters,
30 averaging bins and a timeline of at most 20 entries. The window's shares are
kept as running counts, so a step costs the same at step 10 and step 10 million.

``report()`` is the run record's ``health`` (at most 4 KB: ``shrink``), with the
generic finding words; an analysis's log parser may replace the words and fixes
(``health_advice(report, hints)``, ``HealthEmitter``).

Standard library only.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import re
import statistics
import sys
import time
from collections import deque
from collections.abc import Callable, Iterator
from typing import Any

from magnusim_sdk.numerics_advice import ADVICE, CO_PIMPLE, CO_PISO

RECORD_MAX = 4096
WINDOW = 50
SCORED_FROM = 6
BASELINE_TO = 25
BASELINE_CHECKS_FROM = BASELINE_TO + 1
IMPROVE_AFTER = 5
# After an unread middle (``gap()``), a verdict that turns unhealthy within this many scored steps
# may have begun in the middle: its onset is approximate. Later, the tail read shows it begin.
GAP_SETTLE = 5
# omega and epsilon peak at the walls, so their mean is set by a few near-wall cells, and an
# undershoot below zero in a few cells is routinely larger than a tenth of that mean on real
# meshes. Calibration (spec 2.6): Run_2's own 625k-cell mesh solved with the fix the Health block
# offers (3 outer correctors, Max Courant 5; fixture calib/run2-fixed) bounds omega in every step
# at min about -2x its mean, while the mean stays flat (0.8x its early value) and the flow is
# stable. For these fields a deep undershoot alone is not "Watch closely": the mean has to grow
# too, to this many times its early value. k keeps the spec's rule (it feeds the flow).
DISSIPATION_FIELDS = ("omega", "epsilon")
DISSIPATION_WATCH_GROWTH = 2.0
# residuals_stalled reads each field's first residual as the geometric mean of its last this many
# iterations, for the 1e-3 floor and for the samples taken every 50 iterations; the Unhealthy rule
# (a decade over the early peak) keeps the raw value, so a divergence is not delayed. Calibration
# (spec 2.6): the validation set's turbulent pipe (k-omega SST, Hex-dominant, 2,500 iterations)
# settles with omega's first residual alternating 1.06e-3 on odd and 0.90e-3 on even iterations,
# every other check quiet and the flow steady (inlet pressure within 6e-5 % over its last 10 %).
# Read one iteration at a time the stall switched on and off every iteration from 551 on, and the
# debounce held "Watch closely" to the end with no finding left to say why; the mean (about
# 0.98e-3) sits on the floor, not above it.
STALL_SMOOTH = 10
# How often (scored steps) the words of a check that sets the verdict are kept while it is on:
# the words a held finding shows (``held``) once it has cleared and the verdict has not eased yet.
WORDS_EVERY = 5
TIMELINE_MAX = 20

VERDICT_RANK = {"healthy": 0, "watch": 1, "unhealthy": 2, "failed": 3}
# The verdicts as the person and the Assistant read them (src/workbench/runHealthWords.ts
# VERDICT_WORDS, as CHECK_LABEL mirrors its CHECK_NAMES).
VERDICT_WORDS = {"healthy": "Healthy", "watch": "Watch closely", "unhealthy": "Unhealthy", "failed": "Failed"}
LEVEL_WORD = {0: "", 1: "warn", 2: "error"}
LEVEL_RANK = {"error": 0, "warn": 1, "info": 2}

# A number in a solver line: decimal or exponent form, or nan/inf (any case).
NUM = r"([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[-+]?(?i:nan|inf))"
RE_MPI = re.compile(r"^\s*\[\d+\]\s*")
RE_TIME = re.compile(rf"^Time\s*=\s*{NUM}s?\s*$")
RE_COURANT = re.compile(rf"^Courant Number mean:\s*{NUM}\s+max:\s*{NUM}")
RE_REGION_COURANT = re.compile(rf"^Region:\s*(\w+)\s+Courant Number mean:\s*{NUM}\s+max:\s*{NUM}")
RE_REGION_DIFFUSION = re.compile(rf"^Region:\s*(\w+)\s+Diffusion Number mean:\s*{NUM}\s+max:\s*{NUM}")
RE_DELTAT = re.compile(rf"^deltaT\s*=\s*{NUM}")
RE_SOLVE = re.compile(
    rf"^(\w+):\s+Solving for (\w+), Initial residual = {NUM}, Final residual = {NUM}, No Iterations (\d+)"
)
RE_LIMIT = re.compile(rf"^limitVelocity (\S+) Limited (\d+) \({NUM}%\) of cells, .*with max limit {NUM}")
RE_BOUND = re.compile(rf"^bounding (\w+), min: {NUM} max: {NUM} average: {NUM}")
RE_CONT = re.compile(
    rf"^time step continuity errors\s*(?:\((\w+)\))?\s*: sum local = {NUM}, global = {NUM}, cumulative = {NUM}"
)
RE_TIMING = re.compile(rf"^ExecutionTime = {NUM} s\s+ClockTime = {NUM} s")
RE_REGION_BLOCK = re.compile(r"^Solving for (?:fluid|solid) region (\w+)\s*$")
RE_MINMAX_T = re.compile(rf"^Min/max T:\s*{NUM}\s+{NUM}")
RE_MONITOR_HEAD = re.compile(r"^(\w+) (\S+) write:\s*$")
RE_MONITOR_VALUE = re.compile(r"^\s+(\w+)\((\S+)\) of (\w+) = (.+?)\s*$")
RE_SELECTED = re.compile(rf"selected (\d+) cell\(s\) with volume {NUM}")
RE_HOST = re.compile(r'^Host\s*:\s*"?([^"\s]+)"?\s*$')
# The pressure-velocity loop names as OpenFOAM prints them in the log and the plugin's
# health hints give them (``mode``). The tracker only reads them; it sets no numerics.
LOOP_PISO, LOOP_PIMPLE, LOOP_SIMPLE, LOOP_SIMPLEC = "PISO", "PIMPLE", "SIMPLE", "SIMPLEC"
TRANSIENT_LOOPS = (LOOP_PISO, LOOP_PIMPLE)
STEADY_LOOPS = (LOOP_SIMPLE, LOOP_SIMPLEC)
OUTER_PREFIX = LOOP_PIMPLE + ":"
STEADY_CONVERGED = LOOP_SIMPLE + " solution converged"
RE_PIMPLE_ITER = re.compile("^" + re.escape(OUTER_PREFIX) + r" [Ii]teration (\d+)")
RE_FATAL_HEAD = re.compile(r"^--> FOAM FATAL (?:IO )?ERROR")
RE_FATAL_FRAME = re.compile(r"^\s*#\d+\s+Foam::sig(?:Fpe|Segv)::sigHandler")
RE_WARNING = re.compile(r"^--> FOAM Warning\s*:?\s*(.*)$")
RE_SOLUTION_CONVERGED = re.compile(r"^\s*\w+ solution converged in \S+ iterations\s*$")

# Warnings every run of this app prints: never listed.
BENIGN_WARNINGS = ("allowSystemOperations",)
PRESSURE = frozenset({"p", "p_rgh"})
TURBULENCE = frozenset({"k", "omega", "epsilon", "nuTilda", "v2", "f"})
# Fields whose first residual tells how much a transient step changes them. Pressure
# is pv_coupling's; the turbulence equations' first residuals sit at 0.05-0.2 in a
# healthy transient RANS run (Run_2's k at step 6, before any instability, was 0.14),
# so they would make every turbulent run "Watch closely".
TRANSPORTED = frozenset({"U", "h", "T", "e"})
SOLVER_DEFAULT_MAX_ITER = 1000

CHECK_LABEL = {
    "velocity_clipped": "velocity clipping",
    "pv_coupling": "pressure-velocity coupling",
    "residuals_high": "residuals",
    "residuals_stalled": "residuals",
    "solver_at_limit": "linear solvers",
    "turbulence_bounded": "turbulence bounding",
    "speed_growth": "speed growth",
    "monitor_drift": "pressure-drop drift",
    "courant_mode": "Courant number",
    "courant_spread": "Courant spread",
    "continuity_bias": "continuity",
    "bounded_from_start": "bounding at the start",
    "not_settled": "settling",
    "failed": "solver errors",
    "diffusion_high": "diffusion number",
    "temperature_range": "temperature range",
}
# Checks whose watch or unhealthy level is a symptom of the run itself (the rest are risks).
SYMPTOMS = frozenset(
    {
        "velocity_clipped",
        "pv_coupling",
        "residuals_high",
        "residuals_stalled",
        "solver_at_limit",
        "turbulence_bounded",
        "speed_growth",
        "monitor_drift",
        "continuity_bias",
        "temperature_range",
    }
)
# The order findings are listed in when their levels are equal (the most telling first).
FINDING_ORDER = (
    "failed",
    "velocity_clipped",
    "pv_coupling",
    "turbulence_bounded",
    "speed_growth",
    "solver_at_limit",
    "residuals_high",
    "residuals_stalled",
    "monitor_drift",
    "temperature_range",
    "courant_mode",
    "diffusion_high",
    "continuity_bias",
    "courant_spread",
    "bounded_from_start",
    "not_settled",
)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _finite(x: float | None) -> bool:
    return x is not None and math.isfinite(x)


def line_key(raw: str) -> str:
    """The first 12 hex characters of the SHA-1 of a solver line as written (no LF)."""
    return hashlib.sha1(raw.encode("utf-8", errors="replace")).hexdigest()[:12]


def fmt(x: float | None, sig: int = 2) -> str:
    """A number as the panel writes it: ``sig`` significant figures, thousands
    separated (4,970), small ones in exponent form (7.4e-5)."""
    if x is None or not math.isfinite(x):
        return "?"
    if x == 0:
        return "0"
    a = abs(x)
    if a < 1e-3:
        mant, exp = f"{x:.{max(0, sig - 1)}e}".split("e")
        mant = mant.rstrip("0").rstrip(".") if "." in mant else mant
        return f"{mant}e{int(exp)}"
    digits = sig - 1 - int(math.floor(math.log10(a)))
    r = round(x, digits)
    if digits <= 0:
        return f"{int(round(r)):,}"
    s = f"{r:.{digits}f}"
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


def pct(x: float) -> str:
    """A share as a percentage: "100%", "57%", "8.2%", "0.08%"."""
    p = 100.0 * x
    if p >= 99.5:
        return "100%"
    if p >= 10:
        return f"{int(round(p))}%"
    return f"{fmt(p, 2)}%"


def cells_pct(p: float) -> str:
    """A percentage of cells as the limiter prints it, rounded: "57%", "8.2%"."""
    if p >= 10:
        return f"{int(round(p))}%"
    return f"{fmt(p, 2)}%"


def _level_at(levels: deque[int], need: int = 3) -> int:
    """The level at least ``need`` of the last 5 reached (0 when fewer than 3 were scored)."""
    if len(levels) < 3:
        return 0
    two = one = 0
    for x in levels:
        if x >= 2:
            two += 1
            one += 1
        elif x >= 1:
            one += 1
    return 2 if two >= need else 1 if one >= need else 0


class _Step:
    """One time step (or iteration) as its lines come in."""

    __slots__ = (
        "n",
        "t",
        "co_mean",
        "co_max",
        "dt",
        "outer",
        "first_init",
        "p_groups",
        "p_open",
        "cont",
        "clips",
        "bound",
        "solves",
        "clock",
        "exec",
        "ev",
        "di_max",
        "t_min",
        "t_max",
        "u_first",
    )

    def __init__(self, n: int, t: float, co: tuple[float, float] | None, dt: float | None) -> None:
        self.n = n
        self.t = t
        self.co_mean = co[0] if co else None
        self.co_max = co[1] if co else None
        self.dt = dt
        self.outer = 1
        # First Initial residual per field (U: the worst component).
        self.first_init: dict[str, float] = {}
        # Pressure solves grouped by corrector (closed by a continuity line): each the
        # group's first Initial and its line.
        self.p_groups: list[tuple[float, Any]] = []
        self.p_open = False
        # Continuity lines: (sum local, cumulative, line).
        self.cont: list[tuple[float, float, Any]] = []
        # Limiter calls: (name, cells %, cap, line).
        self.clips: list[tuple[str, float, float, Any]] = []
        # Bounding per field: (min, max, average, line).
        self.bound: dict[str, tuple[float, float, float, Any]] = {}
        # Solves per field: [n, capped, capped but converged, [final/tol of capped], worst line].
        self.solves: dict[str, list[Any]] = {}
        self.clock: float | None = None
        self.exec: float | None = None
        # Evidence lines by check code: (line, text, log_at, key).
        self.ev: dict[str, Any] = {}
        self.di_max: float | None = None
        self.t_min: float | None = None
        self.t_max: float | None = None
        self.u_first: dict[str, float] = {}


class _WinStep:
    """What the 50-step window keeps of a scored step."""

    __slots__ = (
        "n",
        "t",
        "clip_hit",
        "clip_over1",
        "clip_pred",
        "clip_corr",
        "clip_cap",
        "clip_name",
        "bound",
        "solves",
        "cont_final",
        "cum",
        "co_mean",
        "co_max",
        "dt",
        "first_init",
    )

    n: int
    t: float
    clip_hit: bool
    clip_over1: bool
    clip_pred: float | None
    clip_corr: float | None
    clip_cap: float | None
    clip_name: str | None
    bound: dict[str, tuple[float, float]]
    solves: dict[str, tuple[int, int, int, list[float], int]]
    cont_final: float | None
    cum: float | None
    co_mean: float | None
    co_max: float | None
    dt: float | None
    first_init: dict[str, float]


class HealthTracker:
    """A solver log's health, line by line. ``hints`` are the analysis's
    ``health_hints`` (w27-case.json), or None for an analysis that writes none."""

    def __init__(self, hints: dict[str, Any] | None = None) -> None:
        self.hints = dict(hints) if isinstance(hints, dict) else None
        h = self.hints or {}
        mode = str(h.get("mode") or "").upper() or None
        self.mode: str | None = mode if mode in TRANSIENT_LOOPS + STEADY_LOOPS else None
        self.n_outer = _int(h.get("n_outer"), None)
        self.n_correctors = _int(h.get("n_correctors"), None)
        self.max_co = _num(h.get("max_co"))
        self.end_time = _num(h.get("end_time"))
        self.average_from = _num(h.get("average_from"))
        self.uref = _num(h.get("uref"))
        self.fixed_inflow = h.get("fixed_inflow") if isinstance(h.get("fixed_inflow"), bool) else None
        limiter = h.get("limiter")
        self.limiter: dict[str, Any] | None = dict(limiter) if isinstance(limiter, dict) else None
        self.linsolve: dict[str, dict[str, Any]] = {
            str(k): dict(v) for k, v in (h.get("linsolve") or {}).items() if isinstance(v, dict)
        }
        mons = h.get("monitors")
        self.monitors: dict[str, str] | None = (
            {"inlet": str(mons["inlet"]), "outlet": str(mons["outlet"])}
            if isinstance(mons, dict) and mons.get("inlet") and mons.get("outlet")
            else None
        )
        self.turbulence = str(h.get("turbulence") or "") or None
        self.max_di = _num(h.get("max_di"))
        self.t_bc_max = _num(h.get("t_bc_max"))
        self.transient: bool | None = None
        if self.mode in TRANSIENT_LOOPS:
            self.transient = True
        elif self.mode in STEADY_LOOPS:
            self.transient = False
        if self.transient is None and self.hints is not None and "app" in h:
            app = str(h.get("app") or "")
            if "Simple" in app or app.startswith("simple"):
                self.transient = False
        # Parse state.
        self.host: str | None = None
        self.lines = 0
        self.time_loop = False
        self.region = ""
        self.pending_co: tuple[float, float] | None = None
        self.pending_dt: float | None = None
        self.cur: _Step | None = None
        self.steps = 0
        self.scored = 0
        self.mon_name: str | None = None
        self.cells: int | None = None
        self.volume: float | None = None
        self.limit_seen = False
        self.bound_seen = False
        self.warnings: dict[str, int] = {}
        self.converged_flag = False
        self.saved_times: list[float] = []
        self.gaps = 0
        self.after_gap = False
        self.gap_t: float | None = None
        self.since_gap = 0
        self.head_missing = False
        # Verdict.
        self.verdict = "pending"
        self.level: dict[str, int] = {}
        self.info: dict[str, bool] = {}
        self.since: dict[str, float] = {}
        self.evidence: dict[str, Any] = {}
        self.better_run = 0
        self.better_worst = "healthy"
        self.timeline: list[dict[str, Any]] = []
        self.first_unhealthy: dict[str, Any] | None = None
        self.failed_at: dict[str, Any] | None = None
        self.fatal_text: str | None = None
        # Continuous checks: their per-step levels, last 5.
        self.cont_levels: dict[str, deque[int]] = {
            k: deque(maxlen=5) for k in ("pv_coupling", "residuals_high", "speed_growth", "courant_obs")
        }
        # The 50-step window and its running counts.
        self.win: deque[_WinStep] = deque()
        self.agg = _Agg()
        # Baselines (steps 6-25).
        self.base_r: list[float] = []
        self.base_rmax: list[float] = []
        self.base_clock: list[float] = []
        self.base_bound: dict[str, list[float]] = {}
        self.base_resid: dict[str, float] = {}
        self.r0: float | None = None
        self.r0max: float | None = None
        self.s_per_step: float | None = None
        self.prev_dt: float | None = None
        self.dt_peak: float | None = None
        self.r_last: float | None = None
        self.mon_base: float | None = None
        self.mon_base_t: float | None = None
        self.mon_samples: deque[float] = deque(maxlen=2)
        self.mon_now: dict[str, float] = {}
        self.mon_step: dict[str, int] = {}
        self.mon_last_dp: float | None = None
        self.bins: dict[str, list[list[float]]] = {}
        # Steady residual history: one sample per 50 iterations, 11 kept (500 iterations), each the
        # geometric mean of the field's last STALL_SMOOTH first residuals (their log10s kept).
        self.stall_samples: dict[str, deque[float]] = {}
        self._resid_logs: dict[str, deque[float]] = {}
        # What residuals_stalled last found: the field, its level and its values (its words).
        self._stall_now: dict[str, Any] | None = None
        # While the debounce holds the verdict above what the checks now say (``held``): per
        # verdict rank (1 watch, 2 unhealthy), the checks at that rank at the last step the
        # checks reached it, with their level and since; when the checks first fell below it;
        # each such check's words from when it was on (text, level, scored step).
        self._drivers: dict[int, dict[str, tuple[int, float | None]]] = {1: {}, 2: {}}
        self._clear_t: dict[int, float | None] = {1: None, 2: None}
        self._words: dict[str, tuple[str, int, int]] = {}
        self.held: dict[str, dict[str, Any]] = {}
        self._held_rank = 0
        self.first_bounded: dict[str, tuple[float, float]] = {}
        self.extras_t_min: float | None = None
        self.extras_t_max: float | None = None
        self.extras_di: float | None = None
        # The final-corrector p Initial of the last 5 scored steps (the pv_coupling words).
        self._p_finals: deque[float] = deque(maxlen=5)
        # The transported fields' largest first residual of the last 10 steps (residuals_high).
        self._resid_hist: deque[float] = deque(maxlen=10)
        self._ls_cache: dict[str, tuple[int, float | None, float | None, float | None]] = {}
        self._rising_at = -1
        self._rising_was = False
        self._spread_at = -1
        self._spread_was = False
        # The last step that ended (scored or not): what the record's "last" values are.
        self.last_closed: _Step | None = None

    # ------------------------------------------------------------------ input

    def line(self, raw: str, offset: int | None = None) -> None:
        """One solver line as written (``offset``: its byte offset in the run's whole log)."""
        self.lines += 1
        if not raw:
            return
        s = raw
        if s[0] == "[" and "]" in s[:8]:
            s = RE_MPI.sub("", s)
        if not s:
            return
        c = s[0]
        if c == "T":
            if s.startswith("Time"):
                m = RE_TIME.match(s)
                if m:
                    self._time(float(m.group(1)))
            return
        if c == "C":
            if s.startswith("Courant Number"):
                if not self.time_loop:
                    return
                m = RE_COURANT.match(s)
                if m:
                    mean, mx = float(m.group(1)), float(m.group(2))
                    self._nan_check((mean, mx), raw, offset, "Courant")
                    self.pending_co = (mean, mx)
                    self.transient = True if self.transient is None else self.transient
            return
        if c == "d":
            if s.startswith("deltaT"):
                m = RE_DELTAT.match(s)
                if m:
                    self.pending_dt = float(m.group(1))
                    if self.transient is None:
                        self.transient = True
            return
        if c == "R":
            if s.startswith("Region:"):
                if not self.time_loop:
                    return
                m = RE_REGION_COURANT.match(s)
                if m:
                    mean, mx = float(m.group(2)), float(m.group(3))
                    self._nan_check((mean, mx), raw, offset, "Courant")
                    prev = self.pending_co
                    self.pending_co = (max(mean, prev[0]), max(mx, prev[1])) if prev else (mean, mx)
                    return
                m = RE_REGION_DIFFUSION.match(s)
                if m and self.cur is not None:
                    d = float(m.group(3))
                    if _finite(d):
                        self.cur.di_max = d if self.cur.di_max is None else max(self.cur.di_max, d)
            return
        if c == "l":
            if s.startswith("limitVelocity"):
                self.limit_seen = True
                m = RE_LIMIT.match(s)
                if m and self.cur is not None:
                    p = float(m.group(3))
                    cap = float(m.group(4))
                    self.cur.clips.append((m.group(1), p, cap, (self.lines, raw, offset)))
            return
        if c == "b":
            if s.startswith("bounding "):
                m = RE_BOUND.match(s)
                if m and self.cur is not None:
                    lo, hi, avg = float(m.group(2)), float(m.group(3)), float(m.group(4))
                    if self._nan_check((lo, hi, avg), raw, offset, m.group(1)):
                        return
                    self.bound_seen = True
                    key = self._key(m.group(1))
                    self.cur.bound[key] = (lo, hi, avg, (self.lines, raw, offset))
            return
        if c == "t":
            if s.startswith("time step continuity"):
                m = RE_CONT.match(s)
                if m and self.cur is not None:
                    local, cum = float(m.group(2)), float(m.group(4))
                    if self._nan_check((local, float(m.group(3)), cum), raw, offset, "continuity"):
                        return
                    self.cur.cont.append((local, cum, (self.lines, raw, offset)))
                    self.cur.p_open = False
            return
        if c == "E":
            if s.startswith("ExecutionTime"):
                m = RE_TIMING.match(s)
                if m and self.cur is not None:
                    self.cur.exec = float(m.group(1))
                    self.cur.clock = float(m.group(2))
            elif s.startswith("End") and s.strip() == "End":
                self._close()
            return
        if c == "P":
            if s.startswith(OUTER_PREFIX):
                if self.mode is None:
                    if "PISO mode" in s:
                        self.mode = LOOP_PISO
                    elif "iteration" in s.lower():
                        self.mode = LOOP_PIMPLE
                    if self.mode:
                        self.transient = True
                m = RE_PIMPLE_ITER.match(s)
                if m and self.cur is not None:
                    self.cur.outer = int(m.group(1))
            return
        if c == "S":
            if s.startswith("Starting time loop"):
                self.time_loop = True
            elif s.startswith(STEADY_CONVERGED) and RE_SOLUTION_CONVERGED.match(s):
                self.converged_flag = True
            elif s.startswith("Solving for "):
                m = RE_REGION_BLOCK.match(s)
                if m:
                    self.region = m.group(1)
            return
        if c == "H":
            if s.startswith("Host") and self.host is None:
                m = RE_HOST.match(s)
                if m:
                    self.host = m.group(1)
            return
        if c == "-":
            if s.startswith("--> FOAM"):
                if RE_FATAL_HEAD.match(s):
                    if self.time_loop:
                        self._fatal(raw, offset)
                    return
                m = RE_WARNING.match(s)
                if m:
                    text = m.group(1).strip()
                    if not any(text.startswith(b) for b in BENIGN_WARNINGS):
                        key = self._scrub(text)[:160]
                        if key in self.warnings or len(self.warnings) < 8:
                            self.warnings[key] = self.warnings.get(key, 0) + 1
            return
        if c == "M":
            if s.startswith("Min/max T:") and self.cur is not None:
                m = RE_MINMAX_T.match(s)
                if m:
                    lo, hi = float(m.group(1)), float(m.group(2))
                    if self._nan_check((lo, hi), raw, offset, "T"):
                        return
                    self.cur.t_min = lo if self.cur.t_min is None else min(lo, self.cur.t_min)
                    self.cur.t_max = hi if self.cur.t_max is None else max(hi, self.cur.t_max)
                return
            if self.time_loop and "MPI_ABORT was invoked" in s:
                self._fatal(raw, offset)
            return
        if c == " " or c == "\t" or c == "#":
            if self.time_loop and "sigHandler" in s and RE_FATAL_FRAME.match(s):
                self._fatal(raw, offset)
                return
            if self.mon_name is not None:
                m = RE_MONITOR_VALUE.match(s)
                if m:
                    self._monitor_value(m.group(3), m.group(4), raw, offset)
                    return
            if "selected" in s and self.cells is None:
                m = RE_SELECTED.search(s)
                if m:
                    self.cells = int(m.group(1))
                    self.volume = float(m.group(2))
            return
        # Solver lines start with the solver's name; monitor headers with the
        # function object's type.
        if "Solving for" in s:
            m = RE_SOLVE.match(s)
            if m and self.cur is not None:
                self._solve(m, raw, offset)
            return
        if s.endswith("write:"):
            m = RE_MONITOR_HEAD.match(s)
            self.mon_name = m.group(2) if m else None
            return
        if self.time_loop and "MPI_ABORT was invoked" in s:
            self._fatal(raw, offset)

    def gap(self) -> None:
        """The lines that come next do not follow the last ones (an unread middle)."""
        self._close()
        self.gaps += 1
        self.after_gap = True
        self.gap_t = self._last_t
        self.since_gap = 0
        for d in self.cont_levels.values():
            d.clear()
        self.win.clear()
        self.agg = _Agg()
        self.pending_co = None
        self.pending_dt = None
        self.prev_dt = None
        self.mon_samples.clear()
        self.mon_name = None
        self.region = ""
        # The lines after a gap are inside the time loop.
        self.time_loop = True

    def saved(self, t: float) -> None:
        """A result was saved at time ``t``."""
        if _finite(t):
            self.saved_times = (self.saved_times + [float(t)])[-50:]

    def converged(self) -> None:
        """The analysis's parser said the run converged (its ``converged`` event)."""
        self.converged_flag = True

    def missing_head(self) -> None:
        """The start of the log is gone (deleted parts): its onset is unknown."""
        self.head_missing = True

    # ------------------------------------------------------------------ parsing parts

    _last_t: float | None = None

    def _key(self, name: str) -> str:
        return f"{self.region}:{name}" if self.region else name

    def _scrub(self, text: str) -> str:
        if self.host and len(self.host) > 1:
            text = text.replace(self.host, "<host>")
        return text

    def _nan_check(self, values: tuple[float, ...], raw: str, offset: int | None, what: str) -> bool:
        isfinite = math.isfinite
        for v in values:
            if not isfinite(v):
                break
        else:
            return False
        if self.time_loop:
            self._fail(raw, offset, f"A {what} value became not-a-number")
        return True

    def _time(self, t: float) -> None:
        if not math.isfinite(t):
            return
        self._close()
        self.steps += 1
        if self.transient is None:
            self.transient = self.pending_dt is not None
        self.cur = _Step(self.steps, t, self.pending_co, self.pending_dt)
        self.pending_co = None
        self.pending_dt = None
        self.region = ""
        self.mon_name = None
        self._last_t = t

    def _solve(self, m: re.Match[str], raw: str, offset: int | None) -> None:
        cur = self.cur
        assert cur is not None
        name = m.group(2)
        init, final, iters = float(m.group(3)), float(m.group(4)), int(m.group(5))
        if not (math.isfinite(init) and math.isfinite(final)):
            self._nan_check((init, final), raw, offset, f"{name} residual")
            return
        field = "U" if name in ("Ux", "Uy", "Uz") else name
        key = f"{self.region}:{field}" if self.region else field
        ev = (self.lines, raw, offset)
        if field in PRESSURE:
            if not cur.p_open:
                cur.p_groups.append((init, ev))
                cur.p_open = True
        if field == "U":
            # The worst component's first residual, once per component.
            comp = self._key(name)
            if comp not in cur.u_first:
                cur.u_first[comp] = init
                if init > cur.first_init.get(key, -1.0):
                    cur.first_init[key] = init
                    cur.ev["resid:" + key] = ev
        elif key not in cur.first_init:
            cur.first_init[key] = init
            cur.ev["resid:" + key] = ev
        # The linear solver's cap and tolerance (the dictionary used: *Final in the
        # last outer loop, or always with 1 outer corrector).
        conf = self._ls_cache.get(name)
        if conf is None:
            ls = self.linsolve.get(field) or self.linsolve.get(name) or {}
            conf = self._ls_cache[name] = (
                _int(ls.get("max_iter"), SOLVER_DEFAULT_MAX_ITER) or SOLVER_DEFAULT_MAX_ITER,
                _num(ls.get("tol")),
                _num(ls.get("rel_tol")),
                _num(ls.get("final_rel_tol")),
            )
        max_iter, tol = conf[0], conf[1]
        st = cur.solves.get(key)
        if st is None:
            st = cur.solves[key] = [0, 0, 0, [], None, max_iter]
        st[0] += 1
        if iters >= max_iter:
            st[1] += 1
            final_iter = (self.n_outer or 1) <= 1 or cur.outer >= (self.n_outer or 1)
            rel = conf[3] if final_iter else conf[2]
            limit = max(tol or 0.0, (rel or 0.0) * init)
            if limit > 0 and final <= limit:
                st[2] += 1
            if tol and tol > 0:
                st[3].append(final / tol)
            if st[4] is None:
                st[4] = ev

    def _monitor_value(self, field: str, value: str, raw: str, offset: int | None) -> None:
        name = self.mon_name or ""
        v = value.strip()
        if v.startswith("("):
            parts = v.strip("()").split()
            try:
                nums = [float(x) for x in parts]
            except ValueError:
                return
            if any(not math.isfinite(x) for x in nums):
                if self.time_loop:
                    self._fail(raw, offset, f"The monitor {name} became not-a-number")
                return
            scalar = math.sqrt(sum(x * x for x in nums))
            key = f"{name}:|{field}|"
        else:
            try:
                scalar = float(v.split()[0])
            except (ValueError, IndexError):
                return
            if not math.isfinite(scalar):
                if self.time_loop:
                    self._fail(raw, offset, f"The monitor {name} became not-a-number")
                return
            key = f"{name}:{field}"
        self._bin(key, scalar)
        if field != "p" or self.monitors is None:
            return
        self.mon_now[name] = scalar
        self.mon_step[name] = self.steps
        inlet, outlet = self.monitors["inlet"], self.monitors["outlet"]
        if (
            inlet in self.mon_now
            and outlet in self.mon_now
            and self.mon_step.get(inlet) == self.mon_step.get(outlet) == self.steps
            and name in (inlet, outlet)
        ):
            dp = self.mon_now[inlet] - self.mon_now[outlet]
            if self.mon_last_dp is not None and self.mon_step.get("__dp") == self.steps:
                return
            self.mon_step["__dp"] = self.steps
            self.mon_last_dp = dp
            if self.steps > BASELINE_TO and self.mon_base is None:
                self.mon_base = dp
                self.mon_base_t = self._last_t
                self.evidence.setdefault("monitor_drift:base", (self.lines, raw, offset))
            elif self.mon_base is not None:
                self.mon_samples.append(dp)
                if self.cur is not None:
                    self.cur.ev["monitor_drift"] = (self.lines, raw, offset)

    def _bin(self, key: str, value: float) -> None:
        """30 time bins over [average_from, end_time] of a monitor (``not_settled``)."""
        if not self.transient or self._last_t is None or self.end_time is None:
            return
        start = self.average_from or 0.0
        span = self.end_time - start
        if span <= 0 or self._last_t < start:
            return
        i = min(29, int((self._last_t - start) / span * 30))
        bins = self.bins.get(key)
        if bins is None:
            if len(self.bins) >= 6:
                return
            bins = self.bins[key] = [[0.0, 0.0] for _ in range(30)]
        bins[i][0] += value
        bins[i][1] += 1.0

    def _fatal(self, raw: str, offset: int | None) -> None:
        self._fail(raw, offset, "The solver stopped with an error")

    def _fail(self, raw: str, offset: int | None, why: str) -> None:
        if self.verdict == "failed":
            return
        t = self.cur.t if self.cur is not None else self._last_t
        self.fatal_text = why
        self.failed_at = {"t": t, "step": self.steps}
        self.evidence["failed"] = (self.lines, raw, offset)
        self.level["failed"] = 2
        self.since["failed"] = t if t is not None else 0.0
        self._set_verdict("failed", t)

    # ------------------------------------------------------------------ a step ends

    def _close(self) -> None:
        cur = self.cur
        if cur is None:
            return
        self.cur = None
        self.last_closed = cur
        if self.verdict == "failed":
            return
        n = cur.n
        transient = bool(self.transient)
        # The mean convective cell rate: this step's Courant number over the step it was measured on.
        r = rmax = None
        if transient and cur.co_mean is not None and self.prev_dt and self.prev_dt > 0:
            r = cur.co_mean / self.prev_dt
            rmax = (cur.co_max or 0.0) / self.prev_dt
        if cur.dt is not None:
            self.prev_dt = cur.dt
        if n == 1 and cur.bound:
            for f, (lo, _hi, avg, ev) in cur.bound.items():
                if lo < 0:
                    self.first_bounded[f] = (lo, avg)
                    self.evidence.setdefault("bounded_from_start", ev)
        if n < SCORED_FROM and not self.after_gap:
            return
        self.scored += 1
        if self.after_gap:
            self.since_gap += 1
        if cur.clock is not None and n <= BASELINE_TO and not self.after_gap:
            self.base_clock.append(cur.clock)
        if not self.after_gap and n <= BASELINE_TO:
            if r is not None:
                self.base_r.append(r)
            if rmax is not None:
                self.base_rmax.append(rmax)
            for f, v in cur.first_init.items():
                self.base_resid[f] = max(self.base_resid.get(f, 0.0), v)
        for f, (_lo, _hi, avg, _ev) in cur.bound.items():
            b = self.base_bound.setdefault(f, [])
            if len(b) < 10 and (n <= BASELINE_TO or len(b) == 0 or self.r0 is None):
                b.append(avg)
        if n == BASELINE_TO or (self.r0 is None and n > BASELINE_TO and not self.after_gap):
            self._baselines()
        if transient and cur.dt is not None and cur.dt > 0:
            self.dt_peak = cur.dt if self.dt_peak is None else max(self.dt_peak, cur.dt)
        self.r_last = r
        self.extras(cur)
        w = self._win_step(cur)
        self._push(w)
        self._score(cur, w, r)

    def _baselines(self) -> None:
        if self.base_r:
            r0 = statistics.median(self.base_r)
            floor = None
            if self.uref and self.cells and self.volume and self.cells > 0 and self.volume > 0:
                floor = self.uref / (self.volume / self.cells) ** (1.0 / 3.0)
            self.r0 = max(r0, floor) if floor else r0
        if self.base_rmax:
            self.r0max = statistics.median(self.base_rmax)
        if len(self.base_clock) >= 2:
            span = self.base_clock[-1] - self.base_clock[0]
            if span > 0:
                self.s_per_step = span / (len(self.base_clock) - 1)

    def extras(self, cur: _Step) -> None:
        if cur.di_max is not None:
            self.extras_di = cur.di_max
        if cur.t_min is not None:
            self.extras_t_min = cur.t_min if self.extras_t_min is None else min(self.extras_t_min, cur.t_min)
        if cur.t_max is not None:
            self.extras_t_max = cur.t_max if self.extras_t_max is None else max(self.extras_t_max, cur.t_max)

    def _win_step(self, cur: _Step) -> _WinStep:
        w = _WinStep()
        w.n = cur.n
        w.t = cur.t
        clips = cur.clips
        w.clip_hit = any(p > 0 for _n, p, _c, _e in clips)
        w.clip_over1 = any(p >= 1.0 for _n, p, _c, _e in clips)
        w.clip_pred = clips[0][1] if clips else None
        w.clip_corr = clips[-1][1] if clips else None
        w.clip_cap = clips[0][2] if clips else None
        w.clip_name = clips[0][0] if clips else None
        if clips and w.clip_hit:
            worst = max(clips, key=lambda c: c[1])
            cur.ev["velocity_clipped"] = worst[3]
        w.bound = {f: (lo, avg) for f, (lo, _hi, avg, _e) in cur.bound.items()}
        for f, (_lo, _hi, _avg, ev) in cur.bound.items():
            cur.ev["bound:" + f] = ev
        w.solves = {k: (v[0], v[1], v[2], list(v[3])[:4], v[5]) for k, v in cur.solves.items()}
        for k, v in cur.solves.items():
            if v[4] is not None:
                cur.ev["limit:" + k] = v[4]
        w.cont_final = cur.cont[-1][0] if cur.cont else None
        w.cum = cur.cont[-1][1] if cur.cont else None
        if cur.cont:
            cur.ev["continuity"] = cur.cont[-1][2]
        w.co_mean = cur.co_mean
        w.co_max = cur.co_max
        w.dt = cur.dt
        w.first_init = dict(cur.first_init)
        return w

    def _push(self, w: _WinStep) -> None:
        self.win.append(w)
        self.agg.add(w, self.win[-2] if len(self.win) > 1 else None)
        if len(self.win) > WINDOW:
            old = self.win.popleft()
            self.agg.remove(old, self.win[0])

    # ------------------------------------------------------------------ checks

    def _score(self, cur: _Step, w: _WinStep, r: float | None) -> None:
        transient = bool(self.transient)
        n = cur.n
        late = n >= BASELINE_CHECKS_FROM or self.after_gap
        if cur.p_groups:
            self._p_finals.append(cur.p_groups[-1][0])
        lv: dict[str, int] = {}
        info: dict[str, bool] = {}
        # pv_coupling (PISO and PIMPLE only).
        if transient and (self.mode is None or self.mode in TRANSIENT_LOOPS) and cur.p_groups:
            p_final, p_ev = cur.p_groups[-1]
            one = (self.n_correctors or 0) == 1 or (self.n_correctors is None and len(cur.p_groups) == 1)
            lp = 2 if p_final >= (0.8 if one else 0.5) else 1 if p_final >= 0.1 else 0
            first_local = cur.cont[0][0] if cur.cont else 0.0
            ls = 2 if first_local >= 1e-3 else 1 if first_local >= 1e-4 else 0
            step_level = max(lp, ls)
            self.cont_levels["pv_coupling"].append(step_level)
            cur.ev["pv_coupling"] = p_ev if lp >= ls else (cur.cont[0][2] if cur.cont else p_ev)
        lv["pv_coupling"] = _level_at(self.cont_levels["pv_coupling"])
        # residuals_high (transient, from step 26): the transported fields' first residuals.
        top = max((v for f, v in cur.first_init.items() if _field(f) in TRANSPORTED), default=None)
        if top is not None:
            self._resid_hist.append(top)
        if transient and late:
            worst = 0
            settling = self._settling()
            for f, v in cur.first_init.items():
                if _field(f) not in TRANSPORTED or settling:
                    continue
                # Calibration: a run whose inflow ramps up or is pressure-driven starts from rest
                # with first residuals of 0.5-0.65 that fall below 0.05 within about 60 steps
                # (backward-facing step, table inlet and total-pressure inlet, PISO, Max Courant 1).
                # Only a fixed inflow makes 0.2 a symptom on its own.
                lvl = 2 if (v >= 0.2 and self.fixed_inflow) else 1 if v >= 0.05 else 0
                if lvl > worst:
                    worst = lvl
                    cur.ev["residuals_high"] = cur.ev.get("resid:" + f)
            if worst < 1 and len(self.win) >= 20:
                if self.scored - self._rising_at >= 5:
                    self._rising_at = self.scored
                    self._rising_was = self._rising()
                if self._rising_was:
                    worst = 1
            self.cont_levels["residuals_high"].append(worst)
        lv["residuals_high"] = _level_at(self.cont_levels["residuals_high"])
        # residuals_stalled (steady).
        if not transient:
            lv["residuals_stalled"] = self._stalled(cur)
        # speed_growth (transient, a fixed inflow, from step 26).
        if transient and self.fixed_inflow and late and self.r0:
            lr = 0
            if r is not None:
                ratio = r / self.r0
                lr = 2 if ratio >= 5 else 1 if ratio >= 2 else 0
            ld = 0
            if (
                self.max_co
                and cur.co_max is not None
                and cur.co_max >= 0.9 * self.max_co
                and cur.dt
                and self.dt_peak
            ):
                frac = cur.dt / self.dt_peak
                ld = 2 if frac < 0.1 else 1 if frac < 0.5 else 0
            self.cont_levels["speed_growth"].append(max(lr, ld))
            if max(lr, ld) > 0 and "speed_growth" not in cur.ev:
                cur.ev["speed_growth"] = None
        lv["speed_growth"] = _level_at(self.cont_levels["speed_growth"])
        # The observed Courant number against the mode.
        if transient and cur.co_max is not None:
            lim = self._co_watch()
            self.cont_levels["courant_obs"].append(1 if lim is not None and cur.co_max > lim else 0)
        obs = _level_at(self.cont_levels["courant_obs"])
        setting = self._co_setting_level()
        lv["courant_mode"] = max(obs, setting) if transient else 0
        # Event checks over the window.
        a = self.agg
        nwin = len(self.win)
        if nwin:
            if a.clip_hit:
                lv["velocity_clipped"] = 2 if (a.clip_hit / nwin >= 0.2 or a.clip_over1 > 0) else 1
            else:
                lv["velocity_clipped"] = 0
            lv["turbulence_bounded"] = self._bounded_level(nwin, late)
            lv["solver_at_limit"] = self._limit_level()
            # Transient only. Calibration (a steady backward-facing step): SIMPLE's cumulative
            # continuity error drifts one way for hundreds of iterations of a run that
            # converges; a steady run's continuity shows in its pressure residual.
            lv["continuity_bias"] = self._continuity_level(nwin, transient) if transient else 0
            if transient:
                if self.scored - self._spread_at >= 5 or self._spread_at < 0:
                    self._spread_at = self.scored
                    self._spread_was = self._spread()
                info["courant_spread"] = self._spread_was
        # monitor_drift (a fixed inflow, inlet and outlet monitors).
        if self.fixed_inflow and self.monitors and self.mon_base is not None:
            if len(self.mon_samples) >= 2:
                base = self._dp_base()
                ratios = [abs(x) / base for x in self.mon_samples]
                low = min(ratios)
                lv["monitor_drift"] = 2 if low >= 10 else 1 if low >= 2 else 0
            elif not (self.after_gap and len(self.win) < 3):
                # No 2 samples since an unread middle: its level is carried for the gap's first
                # steps only (below), like the window checks', never kept on with no words.
                lv["monitor_drift"] = 0
        # HT rules (hints max_di, t_bc_max).
        if self.max_di is not None and cur.di_max is not None:
            lv["diffusion_high"] = 1 if cur.di_max > self.max_di else 0
        if self.t_bc_max is not None and (cur.t_min is not None or cur.t_max is not None):
            bad = (cur.t_min is not None and cur.t_min < 0) or (cur.t_max is not None and cur.t_max > 2 * self.t_bc_max)
            lv["temperature_range"] = 2 if bad else 0
        info["bounded_from_start"] = bool(self.first_bounded)
        if self.after_gap:
            # Right after an unread middle a check needs its 3 steps again: until then it
            # keeps the level it had before the gap.
            for code, d in (("pv_coupling", "pv_coupling"), ("residuals_high", "residuals_high"), ("speed_growth", "speed_growth")):
                if len(self.cont_levels[d]) < 3 and code in self.level:
                    lv[code] = self.level[code]
            if len(self.win) < 3:
                for code in ("velocity_clipped", "turbulence_bounded", "solver_at_limit", "continuity_bias", "courant_mode", "monitor_drift"):
                    if code in self.level:
                        lv[code] = max(lv.get(code, 0), self.level[code])
        # Since when each check is at its level, and the evidence line of that step.
        for code, level in lv.items():
            before = self.level.get(code, 0)
            if level > before:
                held = self.held.get(code)
                if held is not None and held["since"] is not None and self._rank_of(code, level) <= held["level"]:
                    # Back on while the verdict it set still holds: the same episode, its onset.
                    self.since[code] = held["since"]
                else:
                    self.since[code] = cur.t
                ev = self._evidence_of(code, cur)
                if ev is not None:
                    self.evidence[code] = ev
            elif level == 0:
                self.since.pop(code, None)
        for code, on in info.items():
            if on and not self.info.get(code):
                self.since.setdefault(code, cur.t)
                ev = self._evidence_of(code, cur)
                if ev is not None:
                    self.evidence.setdefault(code, ev)
        self.level.update(lv)
        self.info.update(info)
        target = self._target()
        self._verdict_step(cur, target)
        self._hold_step(cur, target)

    def _evidence_of(self, code: str, cur: _Step) -> Any:
        if code in cur.ev and cur.ev[code] is not None:
            return cur.ev[code]
        if code == "turbulence_bounded":
            for f in self._bounded_fields():
                if "bound:" + f in cur.ev:
                    return cur.ev["bound:" + f]
            return next((v for k, v in cur.ev.items() if k.startswith("bound:")), None)
        if code == "solver_at_limit":
            return next((v for k, v in cur.ev.items() if k.startswith("limit:")), None)
        if code in ("speed_growth", "courant_mode", "courant_spread"):
            return None
        if code == "continuity_bias":
            return cur.ev.get("continuity")
        return None

    def _dp_base(self) -> float:
        """What the inlet-outlet pressure difference is measured against: its first value
        after step 25, at least ½Uref² (kinematic). Calibration (a backward-facing step at
        a fixed 10 m/s inflow, from rest): the difference changed sign and grew from 0.75
        to 7.4 m²/s² (10× its early value) as the flow developed, a healthy run; against
        ½Uref² = 50 it stays under 0.2. Run_2's grew to about 600× ½Uref²."""
        assert self.mon_base is not None
        return max(abs(self.mon_base), 0.5 * (self.uref or 1.0) ** 2)

    def _co_watch(self) -> float | None:
        if self.mode == LOOP_PISO or (self.n_outer is not None and self.n_outer <= 1):
            return 1.5
        if self.mode == LOOP_PIMPLE:
            return 7.5
        return None

    def _co_setting_level(self) -> int:
        if not self.transient or self.max_co is None:
            return 0
        lim = self._co_watch()
        return 1 if lim is not None and self.max_co > lim else 0

    def _co_high(self) -> bool:
        if self.max_co is None:
            return False
        lim = 5.0 if self._co_watch() == 1.5 else 20.0
        return self.max_co > lim

    def _settling(self) -> bool:
        """The first residuals fall fast (the last 5 steps' median under 0.7× the 5 before):
        the start settling, not a symptom (calibration: table and pressure-driven inlets)."""
        h = self._resid_hist
        if len(h) < 10:
            return False
        vals = list(h)
        before, last = statistics.median(vals[:5]), statistics.median(vals[5:])
        return before > 0 and last < 0.7 * before

    def _rising(self) -> bool:
        """A transported field's first residual rose more than half a decade over the window."""
        win = self.win
        for f in {f for w in (win[0], win[-1]) for f in w.first_init if _field(f) in TRANSPORTED}:
            early = [w.first_init[f] for w in list(win)[:5] if f in w.first_init]
            late = [w.first_init[f] for w in list(win)[-5:] if f in w.first_init]
            if early and late:
                a, b = statistics.median(early), statistics.median(late)
                # From 0.01 on: calibration (PIMPLE 3 outer, Max Courant 5) rose from 0.001 to
                # 0.006 as its flow developed, a healthy run.
                if a > 0 and b >= 0.01 and math.log10(b / a) > 0.5:
                    return True
        return False

    def _stalled(self, cur: _Step) -> int:
        """residuals_stalled (spec 2.4): a field's first residual 1 decade or more over its early
        peak (Unhealthy, the raw value), or flat (under 0.3 decade per 500 iterations) above 1e-3
        (Watch closely, the mean of its last STALL_SMOOTH iterations). Its words name the field
        that tripped (``_stall_now``): the most risen one, else the highest stalled one."""
        worst = 0
        pick: dict[str, Any] | None = None
        for f, v in cur.first_init.items():
            if v <= 0:
                continue
            early = self.base_resid.get(f)
            if early and early > 0 and cur.n > BASELINE_TO and math.log10(v / early) >= 1.0:
                if worst < 2 or (pick is not None and v / early > pick["v"] / pick["early"]):
                    pick = {"level": 2, "field": f, "v": v, "early": early}
                worst = 2
            logs = self._resid_logs.get(f)
            if logs is None:
                logs = self._resid_logs[f] = deque(maxlen=STALL_SMOOTH)
            logs.append(math.log10(v))
            mean = 10.0 ** (sum(logs) / len(logs))
            samples = self.stall_samples.setdefault(f, deque(maxlen=11))
            if cur.n % 50 == 0:
                samples.append(mean)
            if worst < 2 and len(samples) == 11 and mean > 1e-3:
                old = samples[0]
                if old > 0 and math.log10(old / mean) < 0.3 and (pick is None or mean > pick["mean"]):
                    pick = {"level": 1, "field": f, "mean": mean, "old": old}
                    worst = 1
        if pick is not None:
            cur.ev["residuals_stalled"] = cur.ev.get("resid:" + pick["field"])
            self._stall_now = pick
        return worst

    def _bounded_fields(self) -> list[str]:
        """The bounded fields, the one that grew most against its early mean first."""

        def growth(f: str) -> float:
            base = self._bound_base(f)
            last = self._bound_last(f)
            if base and base > 0 and last and last[1] > 0:
                return last[1] / base
            return 0.0

        return sorted(self.agg.bound_hit, key=lambda f: (-growth(f), -self.agg.bound_hit[f], f))

    def _bounded_level(self, nwin: int, late: bool) -> int:
        worst = 0
        for f, hit in self.agg.bound_hit.items():
            share = hit / nwin
            if share < 0.05:
                continue
            lvl = 1 if self.agg.bound_deep.get(f, 0) > 0 else 0
            if lvl and _field(f) in DISSIPATION_FIELDS:
                base = self._bound_base(f)
                last = self._bound_last(f)
                if not (last and base and base > 0 and last[1] / base >= DISSIPATION_WATCH_GROWTH):
                    lvl = 0
            if late and share >= 0.5:
                base = self._bound_base(f)
                last = self._bound_last(f)
                avg = last[1] if last else None
                grow = avg is not None and base is not None and base > 0 and avg / base >= 10
                fluct = (
                    _field(f) == "k"
                    and avg is not None
                    and self.uref is not None
                    and avg > 0
                    and math.sqrt(2.0 * avg / 3.0) >= self.uref
                )
                if grow or fluct:
                    lvl = 2
            worst = max(worst, lvl)
        return worst

    def _bound_last(self, f: str) -> tuple[float, float] | None:
        """The field's (min, average) of the newest step in the window that bounded it."""
        return next((w.bound[f] for w in reversed(self.win) if f in w.bound), None)

    def _bound_base(self, f: str) -> float | None:
        b = self.base_bound.get(f)
        return statistics.median(b) if b else None

    def _limit_level(self) -> int:
        worst = 0
        for f, (solves, capped, conv, ft_n, ft_hi) in self.agg.limits().items():
            if not solves or not capped:
                continue
            share = capped / solves
            lvl = 0
            if share >= 0.05 or _field(f) in PRESSURE or conv > 0:
                lvl = 1
            if share >= 0.5 and ft_n and ft_hi * 2 >= ft_n:
                lvl = 2
            worst = max(worst, lvl)
        return worst

    def _continuity_level(self, nwin: int, transient: bool) -> int:
        a = self.agg
        if transient and a.cont_n and a.cont_hi * 2 >= a.cont_n:
            return 1
        if nwin >= 10 and self.win[0].cum is not None and self.win[-1].cum is not None:
            moves = a.cum_pos + a.cum_neg
            if moves >= 9:
                drift = (self.win[-1].cum - self.win[0].cum) / max(1, nwin - 1)
                one_sided = max(a.cum_pos, a.cum_neg) >= 0.9 * moves
                if one_sided and abs(drift) >= 1e-6:
                    return 1
        return 0

    def _spread(self) -> bool:
        pairs = [(w.co_mean, w.co_max) for w in list(self.win)[-5:] if w.co_mean and w.co_max is not None]
        if len(pairs) < 3:
            return False
        ratio = statistics.median([(mx or 0.0) / (mean or 1.0) for mean, mx in pairs])
        mean_co = statistics.median([mean or 0.0 for mean, _mx in pairs])
        return ratio > 50 and mean_co < 1

    # ------------------------------------------------------------------ the verdict

    @staticmethod
    def _rank_of(code: str, level: int) -> int:
        """The verdict rank a check's level counts for: 2 (Unhealthy) for a symptom at 2, else 1
        (Watch closely) at 1 or more; ``failed`` is the verdict's own."""
        if code == "failed" or level <= 0:
            return 0
        return 2 if level >= 2 and code in SYMPTOMS else 1

    def _target(self) -> str:
        # _rank_of, inline (once per scored step).
        worst = 0
        for code, level in self.level.items():
            if code == "failed":
                continue
            if level >= 2 and code in SYMPTOMS:
                worst = 2
            elif level >= 1 and worst < 1:
                worst = 1
        return ("healthy", "watch", "unhealthy")[worst]

    def _verdict_step(self, cur: _Step, target: str | None = None) -> None:
        if self.verdict == "failed":
            return
        if target is None:
            target = self._target()
        if self.verdict == "pending":
            self._set_verdict(target, cur.t, cur)
            return
        if VERDICT_RANK[target] > VERDICT_RANK[self.verdict]:
            self.better_run = 0
            self._set_verdict(target, cur.t, cur)
        elif VERDICT_RANK[target] < VERDICT_RANK[self.verdict]:
            if self.better_run == 0 or VERDICT_RANK[target] > VERDICT_RANK[self.better_worst]:
                self.better_worst = target if self.better_run == 0 else self.better_worst
            if VERDICT_RANK[target] > VERDICT_RANK[self.better_worst]:
                self.better_worst = target
            self.better_run += 1
            if self.better_run >= IMPROVE_AFTER:
                self.better_run = 0
                self._set_verdict(self.better_worst, cur.t, cur)
        else:
            self.better_run = 0

    def _set_verdict(self, v: str, t: float | None, cur: _Step | None = None) -> None:
        if v == self.verdict:
            return
        self.verdict = v
        self.better_run = 0
        self.timeline.append({"t": t, "verdict": v})
        if len(self.timeline) > TIMELINE_MAX:
            self.timeline = self.timeline[:1] + self.timeline[-(TIMELINE_MAX - 1) :]
        if v in ("unhealthy", "failed") and self.first_unhealthy is None:
            # After an unread middle the steps counted are not the run's step numbers.
            step = None if self.gaps else (cur.n if cur is not None else self.steps)
            fu: dict[str, Any] = {"t": t, "step": step, "wall_s": cur.clock if cur is not None else None}
            if self.after_gap and self.gap_t is not None and self.since_gap <= GAP_SETTLE:
                # Unhealthy as soon as the tail is read: it may have begun anywhere in the unread
                # middle, between the gap's start and now. Later in the tail it begins where seen.
                fu = {"t": self.gap_t, "step": None, "wall_s": None, "approx": True, "by_t": t}
            self.first_unhealthy = fu

    def _hold_step(self, cur: _Step, target: str) -> None:
        """The checks that set a verdict the debounce still holds (``held``).

        The verdict improves only after IMPROVE_AFTER better steps in a row, while the findings
        show what the checks say now. So once the checks that set it clear, the verdict would
        stay with nothing at its level to say why. Those checks stay listed instead (``held``),
        at the level that set it (Watch closely: warn, Unhealthy: error), with their words from
        when they were on and their onset, until the verdict eases or they come back."""
        trank = VERDICT_RANK[target]
        if trank:
            steps = "steps" if self.transient else "iterations"
            for r in (1, 2):
                if trank < r:
                    if self._clear_t[r] is None:
                        self._clear_t[r] = cur.t
                    continue
                on: dict[str, tuple[int, float | None]] = {}
                for code, lv in self.level.items():
                    if self._rank_of(code, lv) < r:
                        continue
                    on[code] = (lv, self.since.get(code))
                    w = self._words.get(code)
                    if w is None or w[1] != lv or self.scored - w[2] >= WORDS_EVERY:
                        self._words[code] = (self._text(code, steps, False), lv, self.scored)
                self._drivers[r] = on
                self._clear_t[r] = None
        else:
            for r in (1, 2):
                if self._clear_t[r] is None:
                    self._clear_t[r] = cur.t
        vr = VERDICT_RANK.get(self.verdict, 0)
        if vr not in (1, 2) or trank >= vr:
            if self._held_rank:
                self.held = {}
                self._held_rank = 0
            return
        if self._held_rank != vr:
            self._held_rank = vr
            self.held = {
                code: {
                    "level": vr,
                    "since": since,
                    "cleared": self._clear_t[vr],
                    "words": (self._words.get(code) or ("",))[0],
                }
                for code, (_lv, since) in self._drivers[vr].items()
            }

    # ------------------------------------------------------------------ the record

    def codes(self) -> list[str]:
        """The codes at watch or worse, the info ones and the held ones, in finding order."""
        on = {c for c, lv in self.level.items() if lv > 0} | {c for c, x in self.info.items() if x}
        if self.held:
            on |= set(self.held)
        if self._co_setting_level() and self.transient:
            on.add("courant_mode")
        return [c for c in FINDING_ORDER if c in on]

    def restart(self, latest_saved: float | None = None) -> str | None:
        """Where Continue would go on from, against the onset (spec 3.6): ``from_zero``,
        ``continue_after_fix`` or None. It never says Continue will be healthy."""
        return restart_of(
            self.first_unhealthy,
            self.timeline,
            latest_saved if latest_saved is not None else (self.saved_times[-1] if self.saved_times else self._last_t),
            self.head_missing,
        )

    def report(self, *, latest_saved: float | None = None, final: bool = False) -> dict[str, Any]:
        """The run record's ``health`` (at most 4 KB, ``shrink``)."""
        if final:
            self._close()
        transient = bool(self.transient)
        unit = "time step" if transient else "iteration"
        nwin = len(self.win)
        last = self.win[-1] if nwin else None
        checked, skipped = self._checked()
        rec: dict[str, Any] = {
            "v": 1,
            "verdict": self.verdict,
            "at": _now_iso(),
            "step": self.steps,
            "t": self._last_t,
            "unit": unit,
            "window": nwin,
            "live": not final,
            "checked_steps": self.scored,
            "mode": self.mode,
            "n_outer": self.n_outer,
            "n_correctors": self.n_correctors,
            "checked": checked[:16],
            "skipped": skipped[:8],
            "courant": None,
            "delta_t": None,
            "rates": None,
            "clipping": [],
            "bounding": [],
            "at_limit": [],
            "residuals_last": {},
            "continuity": None,
            "warnings": [{"text": k[:160], "count": v} for k, v in list(self.warnings.items())[:3]],
            "findings": [],
            "timeline": list(self.timeline),
            "first_unhealthy": dict(self.first_unhealthy) if self.first_unhealthy else None,
            "restart": self.restart(latest_saved),
        }
        if self.head_missing:
            rec["head_missing"] = True
        if transient and last is not None and last.co_max is not None:
            rec["courant"] = {
                "mean": last.co_mean,
                "max": last.co_max,
                "max_window": max((w.co_max for w in self.win if w.co_max is not None), default=None),
                "limit": self.max_co,
            }
        if transient and last is not None and last.dt is not None:
            rec["delta_t"] = {
                "last": last.dt,
                "min_window": min((w.dt for w in self.win if w.dt), default=None),
                "peak": self.dt_peak,
            }
        if self.r0max is not None and self.s_per_step is not None:
            rec["rates"] = {
                "co_max_per_s": round(self.r0max, 6),
                "s_per_step": round(self.s_per_step, 6),
                "n_outer": self.n_outer or 1,
            }
        rec["clipping"] = self._clipping_rows()
        rec["bounding"] = self._bounding_rows()
        rec["at_limit"] = self._limit_rows()
        lc = self.last_closed
        if lc is not None and lc.first_init:
            rec["residuals_last"] = {k: _round(v) for k, v in list(lc.first_init.items())[:12]}
        if last is not None:
            if last.cont_final is not None:
                rec["continuity"] = {
                    "local_last": last.cont_final,
                    "cumulative_last": last.cum,
                    "drift": self._drift(),
                }
        rec["findings"] = self._findings(final)
        rec["_extras"] = {"di_max": self.extras_di, "t_min": self.extras_t_min, "t_max": self.extras_t_max}
        return rec

    def _checked(self) -> tuple[list[str], list[dict[str, str]]]:
        transient = bool(self.transient)
        no_hints = self.hints is None
        checked: list[str] = ["failed", "solver_at_limit"]
        if transient:
            checked.append("continuity_bias")
        skipped: list[dict[str, str]] = []

        def skip(code: str, why: str) -> None:
            skipped.append({"code": code, "why": why[:60]})

        if self.limiter is not None or self.limit_seen:
            checked.append("velocity_clipped")
        else:
            skip("velocity_clipped", "no health hints from this analysis" if no_hints else "no velocity limit")
        if transient:
            if self.mode in TRANSIENT_LOOPS or self.mode is None:
                checked.append("pv_coupling")
            checked.append("residuals_high")
            checked += ["courant_mode", "courant_spread"]
        else:
            checked.append("residuals_stalled")
            skip("courant_mode", "steady run")
        turbulent = (self.turbulence not in (None, "laminar")) or self.bound_seen
        if turbulent:
            checked += ["turbulence_bounded", "bounded_from_start"]
        if transient:
            if self.fixed_inflow:
                checked.append("speed_growth")
            else:
                skip("speed_growth", "no health hints from this analysis" if no_hints else "no fixed inflow")
        if self.fixed_inflow and self.monitors:
            checked.append("monitor_drift")
        elif no_hints:
            skip("monitor_drift", "no health hints from this analysis")
        elif not self.fixed_inflow:
            skip("monitor_drift", "no fixed inflow")
        else:
            skip("monitor_drift", "no inlet and outlet monitors")
        if self.max_di is not None:
            checked.append("diffusion_high")
        if self.t_bc_max is not None:
            checked.append("temperature_range")
        checked.append("not_settled")
        return checked, skipped

    def _clipping_rows(self) -> list[dict[str, Any]]:
        hits = [w for w in self.win if w.clip_pred is not None]
        if not hits:
            return []
        w0 = hits[-1]
        preds = [w.clip_pred for w in hits if w.clip_pred is not None]
        corrs = [w.clip_corr for w in hits if w.clip_corr is not None]
        return [
            {
                "name": str(w0.clip_name or "limitU")[:40],
                "cap": w0.clip_cap,
                "unit": "m/s",
                "predictor_pct": {"last": w0.clip_pred, "max": max(preds) if preds else None},
                "corrector_pct": {"last": w0.clip_corr, "max": max(corrs) if corrs else None},
                "steps_hit": self.agg.clip_hit,
            }
        ]

    def _bounding_rows(self) -> list[dict[str, Any]]:
        out = []
        for f in self._bounded_fields()[:6]:
            last = next((w.bound[f] for w in reversed(self.win) if f in w.bound), None)
            mins = [w.bound[f][0] for w in self.win if f in w.bound]
            out.append(
                {
                    "field": f[:40],
                    "min_last": _round(last[0]) if last else None,
                    "min_window": _round(min(mins)) if mins else None,
                    "avg_last": _round(last[1]) if last else None,
                    "avg_base": _round(self._bound_base(f)),
                    "steps_hit": self.agg.bound_hit.get(f, 0),
                }
            )
        return out

    def _limit_rows(self) -> list[dict[str, Any]]:
        out = []
        for f, (solves, capped, _conv, _n, _hi) in self.agg.limits().items():
            if not capped:
                continue
            fts = [ft for w in self.win for ft in (w.solves.get(f, (0, 0, 0, [], 0))[3])]
            limit = next((w.solves[f][4] for w in reversed(self.win) if f in w.solves), None)
            out.append(
                {
                    "field": f[:40],
                    "limit": limit,
                    "share": round(capped / solves, 4) if solves else 0,
                    "final_over_tol": _round(max(fts)) if fts else None,
                }
            )
        out.sort(key=lambda row: -float(row["share"] or 0))
        return out[:8]

    def _drift(self) -> float | None:
        if len(self.win) < 2 or self.win[0].cum is None or self.win[-1].cum is None:
            return None
        return (self.win[-1].cum - self.win[0].cum) / (len(self.win) - 1)

    # ------------------------------------------------------------------ findings

    def _findings(self, final: bool) -> list[dict[str, Any]]:
        steps = "steps" if self.transient else "iterations"
        out: list[dict[str, Any]] = []
        codes = self.codes()
        if final:
            ns = self._not_settled()
            if ns:
                codes.append("not_settled")
        cause = self._courant_cause()
        for code in codes:
            held = self.held.get(code)
            if held is not None:
                # It set the verdict the debounce still holds: listed at that level, saying so.
                lw = LEVEL_WORD[held["level"]]
                text = self._held_text(code, held, steps)
                since_t = held["since"]
            else:
                level = self.level.get(code, 0)
                if code == "courant_mode":
                    level = max(level, self._co_setting_level())
                if level >= 2 and code not in SYMPTOMS and code != "failed":
                    # A risk check is at most Watch closely in the verdict (_target): so is its row.
                    level = 1
                lw = LEVEL_WORD.get(level) or "info"
                text = self._text(code, steps, final)
                if not text and level >= 1:
                    # A check the verdict counts is never left out for want of words.
                    text = self._plain_words(code, level, steps)
                if not text:
                    continue
                since_t = self.since.get(code)
            ev = self.evidence.get(code)
            f: dict[str, Any] = {
                "code": code,
                "level": lw,
                "text": text[:240],
                "evidence": self._evidence_doc(ev),
                "since_t": since_t,
            }
            out.append(f)
        out.sort(key=lambda f: (LEVEL_RANK[f["level"]], FINDING_ORDER.index(f["code"])))
        if cause:
            # The likely cause stays among the six, after the five worst symptoms.
            at = next((i for i, f in enumerate(out) if f["code"] == "courant_mode"), None)
            if at is not None and at >= 6:
                out = out[:5] + [out[at]]
        fixes = self._fixes() if cause else []
        if fixes:
            for f in out:
                if f["code"] == "courant_mode":
                    f["fix"] = fixes
            first_error = next((f for f in out if f["level"] == "error"), None)
            if first_error is not None:
                first_error["fix"] = fixes
        return out[:6]

    def _held_text(self, code: str, held: dict[str, Any], steps: str) -> str:
        """A held check's words (``_hold_step``): its words from when it was on, then when it
        cleared and that the verdict stays until IMPROVE_AFTER better steps in a row, within the
        record's 240 characters (its last sentences go first)."""
        base = held["words"] or self._plain_words(code, held["level"], steps)
        t = held["cleared"]
        if t is None:
            at = f"the last {steps[:-1]}"
        elif self.transient:
            at = f"t = {fmt(t, 3)} s"
        else:
            at = f"iteration {int(round(t)):,}"
        verb = "eased" if self.level.get(code, 0) > 0 else "cleared"
        unit = "time steps" if self.transient else "iterations"
        word = VERDICT_WORDS.get(self.verdict, self.verdict)
        hold = f"It {verb} at {at}; {word} stays until {IMPROVE_AFTER} {unit} in a row are better ({self.better_run} so far)."
        room = 240 - len(hold) - 1
        while len(base) > room:
            cut = base.rstrip(".").rfind(". ")
            if cut <= 0:
                base = base[: max(0, room - 1)].rstrip() + "…"
                break
            base = base[: cut + 1]
        return f"{base} {hold}" if base else hold

    def _plain_words(self, code: str, level: int, steps: str) -> str:
        """Plain words for a check the verdict counts whose own words are empty: after an unread
        middle (a level carried over the gap), else its words from when it was on."""
        label = CHECK_LABEL.get(code, code.replace("_", " "))
        word = VERDICT_WORDS["unhealthy" if self._rank_of(code, level) >= 2 else "watch"]
        if self.after_gap and len(self.win) < 3:
            return (
                f"The {label} check was at {word} before the unread middle of the log; "
                f"the {steps} read after it do not show it yet."
            )
        snap = self._words.get(code)
        if snap and snap[0]:
            return snap[0]
        return f"The {label} check is at {word} over the last {max(1, len(self.win))} {steps}."

    def _evidence_doc(self, ev: Any) -> dict[str, Any] | None:
        if not ev:
            return None
        line_no, raw, offset = ev
        return {
            "line": line_no,
            "text": self._scrub(raw.rstrip("\r\n"))[:200],
            "log_at": offset,
            "key": line_key(raw.rstrip("\r\n")),
        }

    def _courant_cause(self) -> bool:
        """The Courant setting is the likely cause: out of its range for the mode."""
        return bool(self.transient) and self._co_setting_level() > 0

    def _fixes(self) -> list[dict[str, Any]]:
        """The new-run fixes for a Courant number out of range (A3: a new run from t = 0)."""
        n_outer = self.n_outer or 1
        out: list[dict[str, Any]] = []
        if n_outer <= 1:
            out.append(
                self._fix(
                    f"New run: 3 outer correctors, Max Courant {CO_PIMPLE}",
                    [("transient.n_outer_correctors", 3), ("transient.max_co", CO_PIMPLE)],
                    3,
                    CO_PIMPLE,
                )
            )
            out.append(self._fix(f"New run: Max Courant {CO_PISO}", [("transient.max_co", CO_PISO)], 1, CO_PISO))
        else:
            out.append(self._fix(f"New run: Max Courant {CO_PIMPLE}", [("transient.max_co", CO_PIMPLE)], n_outer, CO_PIMPLE))
        return out

    def _fix(self, label: str, values: list[tuple[str, Any]], n_outer_new: int, co_new: float) -> dict[str, Any]:
        cost = None
        if self.r0max and self.s_per_step and self.end_time and co_new > 0:
            steps = self.end_time * self.r0max / co_new
            wall = steps * self.s_per_step * n_outer_new / max(1, self.n_outer or 1)
            cost = {"steps": int(round(steps)), "wall_s": int(round(wall))}
        return {
            "label": label[:60],
            "target": "new_run",
            "values": [{"key": k, "value": v} for k, v in values][:4],
            "cost": cost,
        }

    def _text(self, code: str, steps: str, final: bool) -> str:
        nwin = max(1, len(self.win))
        a = self.agg
        if code == "failed":
            t = (self.failed_at or {}).get("t")
            at = f" at t = {fmt(t, 3)} s" if (t is not None and self.transient) else ""
            return f"{self.fatal_text or 'The solver stopped with an error'}{at}: the run diverged or crashed."
        if code == "velocity_clipped":
            rows = self._clipping_rows()
            if not rows:
                return ""
            r = rows[0]
            hits = [w for w in self.win if w.clip_hit]
            preds = [w.clip_pred for w in hits if w.clip_pred is not None]
            corrs = [w.clip_corr for w in hits if w.clip_corr is not None]
            cap = fmt(r["cap"], 3) if r["cap"] is not None else "?"
            share = a.clip_hit / nwin
            if self.level.get(code, 0) >= 2 and preds:
                return (
                    f"Velocity clipped in {pct(share)} of {steps}: the {cap} m/s limit caught "
                    f"{cells_pct(statistics.median(preds))} of cells after the momentum solve and "
                    f"{cells_pct(statistics.median(corrs) if corrs else 0.0)} after the last pressure solve. "
                    "Clipped cells hold no real result."
                )
            top = max([*preds, *corrs], default=0.0)
            return (
                f"Velocity clipped in {a.clip_hit} of the last {nwin} {steps}: the {cap} m/s limit caught "
                f"up to {cells_pct(top)} of cells. Clipped cells hold no real result."
            )
        if code == "pv_coupling":
            vals = self._p_final_recent()
            if vals:
                p = statistics.median(vals)
                if p >= 0.1:
                    return (
                        f"Pressure and velocity do not settle within a step: the last pressure solve starts "
                        f"at {fmt(p, 2)} (healthy is below 0.1)."
                    )
            return (
                "Pressure and velocity do not settle within a step: the first pressure solve leaves a "
                "continuity error above 1e-4."
            )
        if code == "residuals_high":
            last = self.win[-1] if self.win else None
            if last is None:
                return ""
            items = [(f, v) for f, v in last.first_init.items() if _field(f) in TRANSPORTED]
            if not items:
                return f"The residuals rose more than half a decade over the last {nwin} {steps}."
            f, v = max(items, key=lambda x: x[1])
            return (
                f"{f} changes a lot within each step: its first residual is {fmt(v, 2)} "
                "(a healthy transient run stays below 0.05)."
            )
        if code == "residuals_stalled":
            # The field that tripped (_stalled), not the largest residual of the last iteration.
            s = self._stall_now
            if not s:
                return ""
            if s["level"] >= 2:
                return (
                    f"The {s['field']} residual rose to {fmt(s['v'], 2)}, {fmt(s['v'] / s['early'], 2)}× its early peak: "
                    "the run is diverging."
                )
            return (
                f"The {s['field']} residual has stopped falling at about {fmt(s['mean'], 2)} ({fmt(s['old'], 2)} about "
                f"500 {steps} before); a steady run's residuals should keep falling."
            )
        if code == "solver_at_limit":
            rows = self._limit_rows()
            if not rows:
                return ""
            unhealthy = [r for r in rows if r["share"] >= 0.5]
            group = unhealthy or rows[:2]
            names = _join([r["field"] for r in group])
            limits = {r["limit"] for r in group}
            lim = f"{next(iter(limits))}-iteration limit" if len(limits) == 1 else "iteration limits"
            share = min(r["share"] for r in group)
            every = "every solve" if share >= 0.995 else f"{pct(share)} of solves"
            plural = len(group) > 1
            verb = "stop" if plural else "stops"
            its = "their" if plural else "its"
            fts = [r["final_over_tol"] for r in group if r["final_over_tol"] is not None]
            tail = f", up to {fmt(max(fts), 3)}× above tolerance" if fts else ""
            end = " Raising the limit will not fix this." if self.level.get(code, 0) >= 2 else ""
            return f"{names} {verb} at {its} {lim} in {every}{tail}.{end}"
        if code == "turbulence_bounded":
            fields = self._bounded_fields()
            if not fields:
                return ""
            f = fields[0]
            share = a.bound_hit.get(f, 0) / nwin
            bl = self._bound_last(f)
            bb = self._bound_base(f)
            text = f"{f} went negative and was reset in {pct(share)} of {steps}"
            if self.level.get(code, 0) >= 2 and bl and bb:
                text += f"; its mean is {fmt(bl[1] / bb, 3)}× its early value"
                if _field(f) == "k" and self.uref and bl[1] > 0:
                    up = math.sqrt(2.0 * bl[1] / 3.0)
                    flow = "inflow" if self.fixed_inflow else "reference speed"
                    text += f" (velocity fluctuation ≈ {fmt(up, 2)} m/s against a {fmt(self.uref, 3)} m/s {flow})"
                return text + "."
            mins = [w.bound[f] for w in self.win if f in w.bound]
            if mins:
                lo, avg = min(mins, key=lambda x: x[0])
                if avg:
                    text += f" (its lowest value was {fmt(abs(lo) / abs(avg), 2)}× its mean)"
            return text + "."
        if code == "speed_growth":
            last = self.win[-1] if self.win else None
            parts = []
            if last is not None and last.dt and self.dt_peak and last.dt < 0.5 * self.dt_peak:
                inv = self.dt_peak / last.dt
                parts.append(f"The time step fell to {fmt(last.dt, 2)} s, 1/{int(round(inv))} of its peak,")
            if self.r_last and self.r0 and self.r_last / self.r0 >= 2:
                rose = f"the mean convective cell rate (mean Courant number per second) rose {fmt(self.r_last / self.r0, 2)}×"
                parts.append(("while " + rose) if parts else rose[0].upper() + rose[1:])
            if not parts:
                return "The flow in the cells keeps speeding up at a fixed inflow."
            return " ".join(parts) + " at a fixed inflow: the flow in the cells keeps speeding up."
        if code == "monitor_drift":
            if self.mon_base is None or not self.mon_samples or not self.monitors:
                return ""
            dp_base = self._dp_base()
            ratio_dp = abs(self.mon_samples[-1]) / dp_base
            against = (
                f"its value at t = {fmt(self.mon_base_t, 2)} s"
                if abs(self.mon_base) >= dp_base and self.mon_base_t is not None
                else "the inflow's dynamic pressure"
            )
            return (
                f"The pressure difference between {self.monitors['inlet']} and {self.monitors['outlet']} "
                f"is {fmt(ratio_dp, 3)}× {against}, at a fixed inflow: the flow is not settling."
            )
        if code == "courant_mode":
            n_outer = self.n_outer or 1
            mode = self.mode or (LOOP_PISO if n_outer <= 1 else LOOP_PIMPLE)
            corr = f"{n_outer} outer corrector{'s' if n_outer != 1 else ''}"
            if self.max_co is not None and self._co_setting_level():
                lead = "Likely cause: " if self.verdict in ("unhealthy", "failed") else ""
                return f"{lead}Max Courant {fmt(self.max_co, 3)} with {corr} ({mode}). {ADVICE['max_co']['rule']}"
            co = max((w.co_max for w in list(self.win)[-5:] if w.co_max is not None), default=None)
            return (
                f"The largest cell Courant number reached {fmt(co, 3)} with {corr} ({mode}). "
                f"{ADVICE['max_co']['rule']}"
            )
        if code == "courant_spread":
            recent = [w for w in list(self.win)[-5:] if w.co_mean and w.co_max is not None]
            if not recent:
                return ""
            ratio = statistics.median([(w.co_max or 0.0) / (w.co_mean or 1.0) for w in recent])
            return (
                f"The largest cell Courant number is about {fmt(ratio, 2)}× the mean: a few small cells set "
                "the time step. This is a mesh matter."
            )
        if code == "continuity_bias":
            drift = self._drift()
            if drift is not None and abs(drift) >= 1e-6:
                sign = "+" if drift > 0 else "-"
                return f"The cumulative continuity error drifts {sign}{fmt(abs(drift), 2)} per {steps[:-1]}, one way in most {steps}."
            return f"The last pressure solve leaves a continuity error of 1e-6 or more in most {steps}."
        if code == "bounded_from_start":
            if not self.first_bounded:
                return ""
            f, (lo, avg) = next(iter(self.first_bounded.items()))
            return (
                f"{f} was negative from the first {steps[:-1]} (lowest {fmt(lo, 3)} against a mean of {fmt(avg, 3)}): "
                "check the inlet values or the mesh."
            )
        if code == "not_settled":
            return self._not_settled() or ""
        if code == "diffusion_high":
            return (
                f"A solid's diffusion number reached {fmt(self.extras_di, 2)}, above the {fmt(self.max_di, 2)} "
                "the solver is set for."
            )
        if code == "temperature_range":
            return (
                f"Temperature reached {fmt(self.extras_t_min, 3)} to {fmt(self.extras_t_max, 4)} K, outside 0 K to "
                f"twice the hottest boundary ({fmt((self.t_bc_max or 0) * 2, 4)} K): the energy solution is diverging."
            )
        return ""

    def _p_final_recent(self) -> list[float]:
        return list(self._p_finals)

    def _not_settled(self) -> str | None:
        if not self.transient:
            if self.converged_flag or not self.scored:
                return None
            return "It ended without its residuals meeting their targets: its results may not have settled."
        for key, bins in self.bins.items():
            mid = [b for b in bins[10:20] if b[1] > 0]
            late = [b for b in bins[20:30] if b[1] > 0]
            if len(mid) < 3 or len(late) < 3:
                continue
            a = sum(b[0] for b in mid) / sum(b[1] for b in mid)
            b = sum(b[0] for b in late) / sum(b[1] for b in late)
            floor = 0.01 * 0.5 * (self.uref or 0.0) ** 2
            if abs(b - a) > max(0.02 * abs(a), floor):
                name = key.split(":", 1)[0]
                return (
                    f"The monitor {name} averages {fmt(b, 3)} over the last third of the averaging time and "
                    f"{fmt(a, 3)} over the middle third: its mean has not settled."
                )
        return None


class _Agg:
    """Running counts over the 50-step window (added and removed as steps come and go)."""

    def __init__(self) -> None:
        self.clip_hit = 0
        self.clip_over1 = 0
        self.bound_hit: dict[str, int] = {}
        self.bound_deep: dict[str, int] = {}
        self.lim: dict[str, list[int]] = {}
        self.cont_n = 0
        self.cont_hi = 0
        self.cum_pos = 0
        self.cum_neg = 0

    def add(self, w: _WinStep, prev: _WinStep | None) -> None:
        self._apply(w, prev, 1)

    def remove(self, w: _WinStep, nxt: _WinStep) -> None:
        # The increment that leaves the window is the one between the removed step and the next.
        self._apply(w, None, -1)
        if w.cum is not None and nxt.cum is not None:
            d = nxt.cum - w.cum
            if d > 0:
                self.cum_pos -= 1
            elif d < 0:
                self.cum_neg -= 1

    def _apply(self, w: _WinStep, prev: _WinStep | None, s: int) -> None:
        if w.clip_hit:
            self.clip_hit += s
        if w.clip_over1:
            self.clip_over1 += s
        for f, (lo, avg) in w.bound.items():
            if lo < 0:
                self.bound_hit[f] = self.bound_hit.get(f, 0) + s
                if avg and abs(lo) / abs(avg) >= 0.1:
                    self.bound_deep[f] = self.bound_deep.get(f, 0) + s
                if self.bound_hit[f] <= 0:
                    self.bound_hit.pop(f, None)
                    self.bound_deep.pop(f, None)
        for f, (n, capped, conv, fts, _limit) in w.solves.items():
            row = self.lim.setdefault(f, [0, 0, 0, 0, 0])
            row[0] += s * n
            row[1] += s * capped
            row[2] += s * conv
            row[3] += s * len(fts)
            row[4] += s * sum(1 for x in fts if x >= 100)
        if w.cont_final is not None:
            self.cont_n += s
            if w.cont_final >= 1e-6:
                self.cont_hi += s
        if s > 0 and prev is not None and prev.cum is not None and w.cum is not None:
            d = w.cum - prev.cum
            if d > 0:
                self.cum_pos += 1
            elif d < 0:
                self.cum_neg += 1

    def limits(self) -> dict[str, tuple[int, int, int, int, int]]:
        return {f: (r[0], r[1], r[2], r[3], r[4]) for f, r in self.lim.items() if r[0] > 0}


def _field(key: str) -> str:
    return key.rsplit(":", 1)[-1]


def _join(names: list[str]) -> str:
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " and " + names[-1]


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or v is None or v == "":
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _int(v: Any, default: int | None) -> int | None:
    x = _num(v)
    return int(round(x)) if x is not None else default


def _round(x: float | None, sig: int = 4) -> float | None:
    if x is None or not math.isfinite(x) or x == 0:
        return x
    return float(f"{x:.{sig}g}")


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ---------------------------------------------------------------------------
# restart, the shrink and the emitter
# ---------------------------------------------------------------------------


def restart_of(
    first_unhealthy: dict[str, Any] | None,
    timeline: list[dict[str, Any]],
    latest_saved: float | None,
    head_missing: bool = False,
) -> str | None:
    """``from_zero``: the latest saved time is at or after the onset and the verdict was not
    Healthy again by then; ``continue_after_fix``: it is before the onset, or the verdict was
    Healthy again by then; None: never unhealthy, or the onset is unknown."""
    if head_missing or not first_unhealthy or first_unhealthy.get("t") is None:
        return None
    onset = float(first_unhealthy["t"])
    if latest_saved is None:
        return "from_zero"
    if latest_saved < onset:
        return "continue_after_fix"
    at = None
    for e in timeline:
        t = e.get("t")
        if t is not None and float(t) <= latest_saved:
            at = e.get("verdict")
    return "continue_after_fix" if at == "healthy" else "from_zero"


SHRINK_KEEP = ("v", "verdict", "at", "step", "t", "unit", "window", "checked", "skipped", "first_unhealthy", "restart")


def record_size(rec: dict[str, Any]) -> int:
    return len(json.dumps(rec, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def shrink(rec: dict[str, Any], limit: int = RECORD_MAX) -> dict[str, Any]:
    """The record within ``limit`` bytes (deterministic, spec 3.6): each step in turn until it fits."""
    out = {k: v for k, v in rec.items() if not k.startswith("_")}
    if record_size(out) <= limit:
        return out
    out["trimmed"] = True
    findings = [dict(f) for f in out.get("findings") or []]

    def fits() -> bool:
        out["findings"] = findings
        return record_size(out) <= limit

    # 1. evidence text
    for f in findings:
        if isinstance(f.get("evidence"), dict):
            f["evidence"] = {k: v for k, v in f["evidence"].items() if k != "text"}
    if fits():
        return out
    # 2. info findings
    findings = [f for f in findings if f.get("level") != "info"]
    if fits():
        return out
    # 3. fixes of non-error findings
    for f in findings:
        if f.get("level") != "error":
            f.pop("fix", None)
    if fits():
        return out
    # 4. the timeline: its first and last 3
    tl = out.get("timeline") or []
    if len(tl) > 6:
        out["timeline"] = tl[:3] + tl[-3:]
    if fits():
        return out
    # 5. finding words to 160
    for f in findings:
        if isinstance(f.get("text"), str):
            f["text"] = f["text"][:160]
    if fits():
        return out
    # 6. the core only; each finding as code, level and where its line is.
    core = {k: out.get(k) for k in SHRINK_KEEP}
    core["trimmed"] = True
    core["live"] = out.get("live")
    core["findings"] = [
        {
            "code": f.get("code"),
            "level": f.get("level"),
            "evidence": (
                {"log_at": f["evidence"].get("log_at"), "key": f["evidence"].get("key")}
                if isinstance(f.get("evidence"), dict)
                else None
            ),
        }
        for f in findings
    ]
    return core


def with_advice(rec: dict[str, Any], hints: dict[str, Any] | None, advice: Callable[..., Any] | None) -> dict[str, Any]:
    """The analysis's own words and fixes (``health_advice``), else the generic record."""
    if advice is None:
        return rec
    try:
        out = advice(json.loads(json.dumps(rec)), hints)
    except Exception:
        return rec
    return out if isinstance(out, dict) and out.get("v") == 1 else rec


class HealthEmitter:
    """When a ``health`` event goes out (spec 3.5 item 4): at once on a verdict change, on a
    change of the codes at most every ``change_s`` seconds, a refresh every ``refresh_s``
    seconds, and once at the end."""

    def __init__(
        self,
        tracker: HealthTracker,
        *,
        advice: Callable[..., Any] | None = None,
        clock: Callable[[], float] = time.monotonic,
        change_s: float = 15.0,
        refresh_s: float = 60.0,
    ) -> None:
        self.tracker = tracker
        self.advice = advice
        self.clock = clock
        self.change_s = change_s
        self.refresh_s = refresh_s
        self.sent_verdict: str | None = None
        self.sent_codes: tuple[str, ...] = ()
        self.sent_at: float | None = None
        self.seen_scored = -1

    def _payload(self, final: bool, latest_saved: float | None = None) -> dict[str, Any]:
        rec = self.tracker.report(final=final, latest_saved=latest_saved)
        rec = with_advice(rec, self.tracker.hints, self.advice)
        return {"event": "health", **shrink(rec)}

    def poll(self) -> dict[str, Any] | None:
        """After a line: the event to send now, else None (cheap when nothing changed)."""
        t = self.tracker
        if t.scored == self.seen_scored and t.verdict == self.sent_verdict:
            if self.sent_at is None or self.clock() - self.sent_at < self.refresh_s:
                return None
        self.seen_scored = t.scored
        now = self.clock()
        verdict = t.verdict
        if verdict == "pending" and self.sent_verdict is None and t.steps < 1:
            return None
        codes = tuple(t.codes())
        due = False
        if verdict != self.sent_verdict:
            due = True
        elif codes != self.sent_codes and (self.sent_at is None or now - self.sent_at >= self.change_s):
            due = True
        elif self.sent_at is not None and now - self.sent_at >= self.refresh_s:
            due = True
        if not due:
            return None
        self.sent_verdict = verdict
        self.sent_codes = codes
        self.sent_at = now
        return self._payload(False)

    def final(self, latest_saved: float | None = None) -> dict[str, Any]:
        """The last event, with the open step closed."""
        return self._payload(True, latest_saved)


# ---------------------------------------------------------------------------
# Reading a log file (replay, the old-run check)
# ---------------------------------------------------------------------------


def _open(path: str) -> Any:
    return gzip.open(path, "rb") if str(path).endswith(".gz") else open(path, "rb")


def iter_log_lines(path: str, *, start: int = 0, limit: int | None = None) -> Iterator[tuple[str, int]]:
    """``(line, offset)`` for each line of a log (``.gz`` too) from byte ``start``: the line
    as written (no LF, CR kept off) and its byte offset in the file."""
    with _open(path) as fh:
        if start:
            fh.seek(start)
        pos = start
        read = 0
        for raw in fh:
            n = len(raw)
            if limit is not None and read + n > limit:
                break
            read += n
            text = raw.decode("utf-8", errors="replace").rstrip("\n").rstrip("\r")
            yield text, pos
            pos += n


def check_log(
    parts: list[str],
    hints: dict[str, Any] | None,
    *,
    head_bytes: int = 16 * 1024 * 1024,
    tail_bytes: int = 16 * 1024 * 1024,
    head_missing: bool = False,
    latest_saved: float | None = None,
    advice: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    """An ended run's health from its log parts (oldest first, spec 3.9): the head of the
    oldest part and the tail of the newest, with ``gap()`` between them when the middle is
    not read. ``log_at`` is the line's position in the whole log (earlier parts' sizes added)."""
    import os

    tracker = HealthTracker(hints)
    if head_missing:
        tracker.missing_head()
    sizes = [os.path.getsize(p) for p in parts]
    total = sum(sizes)
    whole = total <= head_bytes + tail_bytes
    base = 0
    if whole:
        for p, size in zip(parts, sizes, strict=True):
            for text, off in iter_log_lines(p):
                tracker.line(text, base + off)
            base += size
    else:
        # The head: from the oldest part on, head_bytes in all.
        left = head_bytes
        for p, size in zip(parts, sizes, strict=True):
            if left <= 0:
                break
            for text, off in iter_log_lines(p, limit=left):
                tracker.line(text, base + off)
            left -= size
            base += size
        tracker.gap()
        # The tail: the last tail_bytes, from the start of a line.
        start_total = total - tail_bytes
        base = 0
        for p, size in zip(parts, sizes, strict=True):
            if base + size <= start_total:
                base += size
                continue
            start = max(0, start_total - base)
            first = start > 0
            for text, off in iter_log_lines(p, start=start):
                if first:
                    first = False
                    continue
                tracker.line(text, base + off)
            base += size
    rec = tracker.report(final=True, latest_saved=latest_saved)
    rec = with_advice(rec, hints, advice)
    return shrink(rec)


# ---------------------------------------------------------------------------
# CLI: python -m magnusim_sdk.health replay <log> [--hints json] [--pace ms] [--events]
# ---------------------------------------------------------------------------


def _replay(args: argparse.Namespace) -> int:
    hints = None
    if args.hints:
        text = args.hints
        if not text.lstrip().startswith("{"):
            with open(text, encoding="utf-8") as fh:
                text = fh.read()
        hints = json.loads(text)
    tracker = HealthTracker(hints)
    pace = max(0.0, float(args.pace or 0)) / 1000.0
    out = sys.stdout
    copy = open(args.copy_to, "ab") if args.copy_to else None
    every = max(1, int(args.every or 20))

    def send(doc: dict[str, Any]) -> None:
        out.write(json.dumps(doc, separators=(",", ":")) + "\n")
        out.flush()

    sent_verdict = None
    sent_codes: tuple[str, ...] = ()
    last_steps = 0
    try:
        for text, off in iter_log_lines(args.log):
            before = tracker.steps
            if copy is not None and text.startswith("Time") and before >= 1 and pace:
                time.sleep(pace)
            tracker.line(text, off)
            if copy is not None:
                copy.write((text + "\n").encode("utf-8"))
                copy.flush()
            if not args.events or tracker.steps == before:
                continue
            cur = tracker.cur
            if cur is not None and args.events:
                send(
                    {
                        "event": "progress",
                        "step": tracker.steps,
                        "time": cur.t,
                        "co_mean": cur.co_mean,
                        "co_max": cur.co_max,
                        "delta_t": cur.dt,
                    }
                )
            codes = tuple(tracker.codes())
            if tracker.verdict != sent_verdict or codes != sent_codes or tracker.steps - last_steps >= every:
                sent_verdict, sent_codes, last_steps = tracker.verdict, codes, tracker.steps
                if tracker.steps >= 1:
                    send({"event": "health", **shrink(tracker.report())})
    finally:
        if copy is not None:
            copy.close()
    final = shrink(tracker.report(final=True, latest_saved=args.latest_saved))
    if args.events:
        send({"event": "health", **final})
    else:
        send(final)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m magnusim_sdk.health")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("replay", help="read a solver log and print its health")
    r.add_argument("log")
    r.add_argument("--hints", default="", help="health hints: JSON text or a JSON file")
    r.add_argument("--pace", type=float, default=0.0, help="ms to wait before each time step")
    r.add_argument("--events", action="store_true", help="print health (and progress) events as it goes")
    r.add_argument("--every", type=int, default=20, help="with --events: a health event at least every N steps")
    r.add_argument("--copy-to", default="", help="append each line to this file as it is read")
    r.add_argument("--latest-saved", type=float, default=None, help="the run's latest saved time (restart)")
    args = ap.parse_args(argv)
    if args.cmd == "replay":
        return _replay(args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
