"""The pre-run check (run health, RH2): what a run's settings, its mesh and its physics
predict before it starts, as rows the Run panel's "Before you start" block and the
Assistant's ``read_results precheck`` show, with the always-shown estimate line.

:func:`check` takes the run's inputs as plain values (an analysis gathers them: its
``RunModel.check`` hook, contract API 1.9) and returns ``{"checks": [...], "estimate": ...}``.

A row is ``{code, level, text, short, fix, alt, kept}``:

- ``level``: ``error``, ``warn`` or ``info`` (the health finding scale). **No row blocks
  Start**, and the Courant rows (``piso_high_co``, ``pimple_co_vs_outer``, ``fixed_step_co``)
  are ``warn`` at any value: Max Courant has no cap (Daniel, A1).
- ``text``: the sentence the person and the Assistant read; ``short``: a few words for
  "Checked at start: 1 warning (Max Courant 100 with PISO)".
- ``fix`` and ``alt``: ``{label, target, values, cost}`` or None. ``target`` is ``run``
  (``values`` are the run's catalog keys: ``transient.max_co``, ``endTime``, ...),
  ``study`` (the study's settings keys), ``mesh`` (open the mesh), ``bcs`` (open the
  boundary conditions) or ``steady_copy`` (a copy of the study, set steady). ``cost`` is
  ``{steps, wall_s}`` of a run with the fix, when it can be estimated. A fix that needs
  settings the app does not offer yet (schemes, linear-solver limits, the velocity limit)
  is named in the text and has no fix.
- ``kept``: the person (or the Assistant) chose "Keep as set" for this code (the run's
  ``checks_kept``).

The estimate (transient): ``Δt = maxCo / (U · 1.5 · rate)`` from the mesh's Courant-rate
table (:mod:`magnusim_sdk.run_estimate`), the steps to the end, the wall time on this PC
and one flow-through time; ``line`` is the sentence the block always shows. It feeds only
what is shown and these rows: no case is written from it.

Standard library only.
"""

from __future__ import annotations

import math
from typing import Any

from .health import fmt
from .numerics_advice import CO_PIMPLE, CO_PISO, rule
from .run_estimate import DEFAULT_S_PER_CELL_STEP, SPEED_FACTOR, courant_at, estimate_run

LEVEL_ORDER = {"error": 0, "warn": 1, "info": 2}
# The order rows of one level are shown in.
CODE_ORDER = (
    "mesh_failed",
    "piso_high_co",
    "pimple_co_vs_outer",
    "fixed_step_co",
    "piso_correctors",
    "non_ortho_correctors",
    "mesh_skew",
    "layers_dropped",
    "yplus_model",
    "laminar_turbulent",
    "mach",
    "steady_relax",
    "average_startup",
    "duration_vs_ftt",
    "long_run",
    "steady_for_mean",
    "outer_unneeded",
    "still_start",
    "steady_short",
    "quality_unknown",
)
COURANT_CODES = frozenset({"piso_high_co", "pimple_co_vs_outer", "fixed_step_co"})

# The steady run the "steady copy" estimate counts on, in iterations.
STEADY_ITERATIONS = 1500
# Flow-throughs before the averages may start: from rest, and from the inlet's velocity or
# potential flow.
STARTUP_FTT_STILL = 3.0
STARTUP_FTT_MOVING = 2.0
# Flow-throughs of averaging: under the first is too few; over the second (RANS with a
# steady inflow) more than a mean needs; a fix aims at the third after the start-up.
AVERAGE_FTT_MIN = 5.0
AVERAGE_FTT_MAX = 40.0
AVERAGE_FTT_FIX = 20.0
# long_run: a note above 4 hours, a warning above 24.
LONG_INFO_S = 4 * 3600.0
LONG_WARN_S = 24 * 3600.0
# steady_for_mean warns when the transient run is over 12 hours and a steady one under a
# 20th of it.
STEADY_WARN_S = 12 * 3600.0
STEADY_WARN_RATIO = 20.0
MACH_SPEED = 100.0
RE_DH_TURBULENT = 2300.0
RE_L_TURBULENT = 5e5
YPLUS_WALL_FN_MIN = 15.0
YPLUS_MAX = 300.0
STEADY_SHORT_ITERATIONS = 200
STEADY_SHORT_CELLS = 200_000

# ---------------------------------------------------------------------------
# Words
# ---------------------------------------------------------------------------


def num_words(x: float | None) -> str:
    """A setting as the person typed it: 100, 0.8, 1e-4."""
    if x is None or not math.isfinite(float(x)):
        return "?"
    return f"{float(x):g}"


def wall_words(s: float | None) -> str:
    """A wall time: "about 15 minutes", "about 6 hours", "about 6 days"."""
    if s is None or not math.isfinite(s) or s < 0:
        return "unknown"
    if s < 60:
        return "under a minute"
    if s < 3600:
        m = max(1, round(s / 60))
        return f"about {m} minute{'' if m == 1 else 's'}"
    h = s / 3600
    if h < 48:
        n = max(1, round(h))
        return f"about {n} hour{'' if n == 1 else 's'}"
    return f"about {round(h / 24)} days"


def steps_words(n: float | None) -> str:
    """Steps to 2 significant figures ("900,000")."""
    if n is None or not n > 0:
        return "0"
    p = 10 ** max(0, int(math.floor(math.log10(n))) - 1)
    return f"{int(round(n / p) * p):,}"


def time_words(t: float | None) -> str:
    """A simulated time: 3 significant figures, in seconds ("0.177 s", "1.1e-5 s")."""
    return f"{fmt(t, 3)} s" if t is not None else "? s"


def cores_words(ranks: int) -> str:
    return "1 core" if ranks <= 1 else f"{ranks} cores"


def _pos(x: Any) -> float | None:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) and v > 0 else None


def _int(x: Any, fallback: int) -> int:
    try:
        return int(round(float(x)))
    except (TypeError, ValueError):
        return fallback


def _round_sig(x: float, sig: int = 2, up: bool = False) -> float:
    if x <= 0:
        return x
    p = 10 ** (int(math.floor(math.log10(x))) - (sig - 1))
    n = x / p
    return (math.ceil(n - 1e-9) if up else round(n)) * p


def _clean(x: float) -> float:
    """A float without binary noise (0.30000000000000004 → 0.3)."""
    return float(f"{x:.6g}")


def _fix(label: str, target: str, values: dict[str, Any] | None = None, cost: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "label": label,
        "target": target,
        "values": [{"key": k, "value": v} for k, v in (values or {}).items()],
        "cost": cost,
    }


def _dict(v: Any) -> dict[str, Any]:
    return v if isinstance(v, dict) else {}


def _row(code: str, level: str, text: str, short: str, fix: dict[str, Any] | None = None, alt: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"code": code, "level": level, "text": text, "short": short, "fix": fix, "alt": alt, "kept": False}


# ---------------------------------------------------------------------------
# The inputs
# ---------------------------------------------------------------------------


class _Run:
    """The inputs, read once with their defaults."""

    def __init__(self, inputs: dict[str, Any]) -> None:
        i = inputs if isinstance(inputs, dict) else {}
        self.i = i
        self.transient = str(i.get("time_dependency") or "").lower().startswith("transient")
        s = _dict(i.get("settings"))
        self.s = s
        self.end_time = _pos(s.get("end_time"))
        self.write_count = max(1, _int(s.get("write_count"), 50))
        self.fixed = str(s.get("time_step_mode") or "adjustable") == "fixed"
        self.max_co = _pos(s.get("max_co")) or 1.0
        # The fixed step set (or the one a blank fixed step is written with); self.delta_t
        # below is it as the case is written: at most one frame (IF transient.py).
        self.delta_t_set = _pos(s.get("delta_t")) or _pos(i.get("delta_t_written"))
        self.max_delta_t = _pos(s.get("max_delta_t"))
        self.n_outer = max(1, _int(s.get("n_outer_correctors"), 1))
        self.n_correctors = max(1, _int(s.get("n_correctors"), 2))
        self.n_non_orth = _int(s.get("n_non_orth_correctors"), 0) if "n_non_orth_correctors" in s else None
        self.averaging = "average_from" in s
        self.average_from = float(s.get("average_from") or 0.0) if self.averaging else 0.0
        self.cells = _pos(i.get("n_cells"))
        self.ranks = max(1, _int(i.get("ranks"), 1))
        self.s_per_cell_step = _pos(i.get("s_per_cell_step")) or DEFAULT_S_PER_CELL_STEP
        self.measured = str(i.get("rate_source") or "") == "measured"
        raw_mesh = i.get("mesh")
        mesh: dict[str, Any] | None = raw_mesh if isinstance(raw_mesh, dict) else None
        self.mesh = mesh
        q = _dict(mesh.get("quality")) if mesh else {}
        self.quality: dict[str, Any] | None = q if q.get("known") else None
        raw_rates = i.get("rates")
        self.rates: dict[str, Any] | None = raw_rates if isinstance(raw_rates, dict) else None
        self.speed = _pos(i.get("speed"))
        raw_dir = i.get("direction")
        self.direction: Any = raw_dir if isinstance(raw_dir, (list, tuple)) and len(raw_dir) == 3 else (1.0, 0.0, 0.0)
        self.inlet = str(i.get("inlet") or "")
        self.cap = _pos(i.get("velocity_cap"))
        self.time_varying = bool(i.get("time_varying"))
        self.moving = bool(i.get("moving"))
        # The turbulence model as the analysis describes it (the core names no model).
        t = _dict(i.get("turbulence"))
        self.turbulence = t
        self.laminar = bool(t.get("laminar"))
        self.turbulent = bool(t) and not self.laminar
        self.model_label = str(t.get("label") or "")
        self.model_fields = str(t.get("fields") or "")
        self.wall_functions = bool(t.get("wall_functions"))
        mf = _dict(t.get("any_yplus"))
        self.model_fix: dict[str, Any] | None = mf if mf.get("label") and mf.get("key") else None
        self.algorithm = str(i.get("steady_algorithm") or "")
        self.nu = _pos(i.get("nu"))
        self.d_hyd = _pos(i.get("d_hyd"))
        self.initial_flow = str(i.get("initial_flow") or "")
        self.potential_flow = i.get("potential_flow")
        self.inlet_driven = bool(i.get("inlet_driven"))
        n = _dict(i.get("numerics"))
        self.numerics = n
        self.steady_copy = bool(i.get("steady_copy"))
        self.kept = {str(c) for c in (i.get("kept") or []) if isinstance(c, str)}
        # False when the analysis could read only the run's settings (no mesh yet): its mesh
        # and physics were not checked, and "nothing found" must not say they were.
        self.complete = i.get("inputs_complete") is not False
        self.unchecked = "" if self.complete else str(i.get("unchecked") or "its mesh and physics were not checked")
        self.delta_t = self._fixed_step(self.end_time)

    @property
    def frame(self) -> float | None:
        return self.end_time / self.write_count if self.end_time else None

    def _fixed_step(self, end_time: float | None) -> float | None:
        """The fixed step the case is written with: the one set, at most one frame."""
        frame = end_time / self.write_count if end_time else None
        if self.delta_t_set and frame:
            return min(self.delta_t_set, frame)
        return self.delta_t_set

    def _step_cap(self, end_time: float | None) -> tuple[float | None, str]:
        """The largest step an adjustable run takes, as the case is written: its Max time
        step, at most one frame. (step, "max_dt" | "frame" | "")."""
        frame = end_time / self.write_count if end_time else None
        if self.max_delta_t and (not frame or self.max_delta_t <= frame):
            return self.max_delta_t, "max_dt"
        if frame:
            return frame, "frame"
        return None, ""

    def estimate(self, *, max_co: float | None = None, n_outer: int | None = None, end_time: float | None = None, fixed: bool | None = None) -> dict[str, Any] | None:
        """The transient estimate with these settings in place of the run's.

        An adjustable step is counted at the Courant number the outer correctors allow (1
        with 1 outer corrector, 5 with more) when Max Courant is set above it: a higher
        Max Courant is not a speed setting on its own, so a run set above it does not take
        fewer steps, it becomes unstable."""
        if not self.speed:
            return None
        use_fixed = self.fixed if fixed is None else fixed
        outer = self.n_outer if n_outer is None else n_outer
        co = self.max_co if max_co is None else max_co
        end = self.end_time if end_time is None else end_time
        cap, capped_by = self._step_cap(end)
        e = estimate_run(
            self.rates,
            max_co=min(co, co_allowed(outer)),
            speed=self.speed,
            direction=self.direction,
            end_time=end,
            cells=int(self.cells) if self.cells else None,
            ranks=self.ranks,
            n_outer=outer,
            s_per_cell_step=self.s_per_cell_step,
            bbox_m=_dict(self.mesh).get("bbox_m") or None,
            delta_t=self._fixed_step(end) if use_fixed else None,
            max_delta_t=None if use_fixed else cap,
        )
        if e is not None:
            e["capped_by"] = capped_by if e.get("capped") else ""
            return e
        # No Courant-rate table: no time step, but the flow-through time from the box still
        # tells when a mean may start and how long it averages.
        length = self.length()
        if not length:
            return None
        return {
            "delta_t_s": None,
            "co": None,
            "steps": None,
            "wall_s": None,
            "flow_through_s": length / self.speed,
            "rate_per_m": None,
            "speed_factor": SPEED_FACTOR,
            "capped": False,
            "capped_by": "",
        }

    def steady_wall(self, iterations: float) -> float | None:
        if not self.cells:
            return None
        return iterations * self.s_per_cell_step * (self.cells / self.ranks)

    def length(self) -> float | None:
        """The domain's length along the flow (its box)."""
        bbox = _dict(self.mesh).get("bbox_m")
        size = bbox.get("size") if isinstance(bbox, dict) else None
        if not isinstance(size, list) or len(size) != 3:
            return None
        try:
            d = [abs(float(v)) for v in self.direction]
            s = [abs(float(v)) for v in size]
        except (TypeError, ValueError):
            return None
        n = math.sqrt(sum(v * v for v in d)) or 1.0
        val = sum(d[k] / n * s[k] for k in range(3))
        return val if val > 0 else None

    def reynolds(self) -> tuple[float | None, str]:
        """(Re, "dh" | "L"): on the inlet's hydraulic diameter when it has one, else on the
        domain's length along the flow."""
        if not self.speed or not self.nu:
            return None, ""
        if self.d_hyd:
            return self.speed * self.d_hyd / self.nu, "dh"
        length = self.length()
        if length:
            return self.speed * length / self.nu, "L"
        return None, ""

    def first_cell(self) -> tuple[float | None, bool]:
        """(the wall cells' first height in m, whether it is a boundary layer)."""
        mesh = _dict(self.mesh)
        layers = _dict(mesh.get("layers"))
        first = _pos(layers.get("first_m"))
        if first and layers.get("applied") is not False:
            return first, True
        return _pos(mesh.get("surface_cell_m")), False

    def yplus(self, first: float | None) -> float | None:
        """y+ at the wall cells' centre: a turbulent flat plate's skin friction at the
        domain's length (Cf = 0.058 Re_L^-0.2)."""
        if not first or not self.speed or not self.nu:
            return None
        length = self.length() or self.d_hyd
        if not length:
            return None
        re_l = self.speed * length / self.nu
        if re_l <= 0:
            return None
        cf = 0.058 * re_l ** -0.2
        u_tau = self.speed * math.sqrt(cf / 2.0)
        return (first / 2.0) * u_tau / self.nu


def co_allowed(n_outer: int) -> float:
    """The largest Courant number the advice allows: 1 with 1 outer corrector (PISO), about 5
    with 2 or more (numerics_advice)."""
    return float(CO_PISO if n_outer <= 1 else CO_PIMPLE)


def _cost(e: dict[str, Any] | None) -> dict[str, Any] | None:
    if not e or e.get("steps") is None or e.get("wall_s") is None:
        return None
    return {"steps": int(e["steps"]), "wall_s": int(round(float(e["wall_s"])))}


def _cost_words(c: dict[str, Any] | None) -> str:
    """" (~180,000 steps, about 4 days)" or ""."""
    if not c:
        return ""
    return f" (~{steps_words(c['steps'])} steps, {wall_words(c['wall_s'])})"


# ---------------------------------------------------------------------------
# The rules
# ---------------------------------------------------------------------------


def _courant_rows(r: _Run, *, max_co: float, n_outer: int, fixed: bool) -> list[str]:
    """The Courant codes these settings trip (for long_run's "keeps the Courant checks clean")."""
    out: list[str] = []
    if fixed:
        co = courant_at(r.rates, speed=r.speed or 0, direction=r.direction, delta_t=r.delta_t or 0) if r.speed and r.delta_t else None
        if co is not None and co > (CO_PISO if n_outer <= 1 else CO_PIMPLE):
            out.append("fixed_step_co")
        return out
    if n_outer <= 1 and max_co > CO_PISO:
        out.append("piso_high_co")
    if n_outer >= 2 and max_co > CO_PIMPLE:
        out.append("pimple_co_vs_outer")
    return out


def _transient_rows(r: _Run, est: dict[str, Any] | None, rows: list[dict[str, Any]]) -> None:
    co = r.max_co
    # piso_high_co: PISO above Courant 1 (A1: warn at any value).
    if not r.fixed and r.n_outer <= 1 and co > CO_PISO:
        tail = ""
        fields = r.model_fields
        if r.cap:
            tail = f" At {num_words(co)} expect the {fmt(r.cap, 3)} m/s velocity limit to clip cells" + (f" and {fields} to go negative." if fields else ".")
        elif fields:
            tail = f" At {num_words(co)} expect {fields} to go negative and the run to become unstable."
        else:
            tail = f" At {num_words(co)} expect the run to become unstable."
        fix_cost = _cost(r.estimate(max_co=CO_PIMPLE, n_outer=3))
        alt_cost = _cost(r.estimate(max_co=CO_PISO, n_outer=1))
        rows.append(
            _row(
                "piso_high_co",
                "warn",
                f"Max Courant {num_words(co)} with 1 outer corrector. {rule('max_co')}{tail}",
                f"Max Courant {num_words(co)} with PISO",
                _fix(f"3 outer correctors, Max Courant {CO_PIMPLE}", "run", {"transient.n_outer_correctors": 3, "transient.max_co": CO_PIMPLE}, fix_cost),
                _fix(f"Max Courant {CO_PISO}", "run", {"transient.max_co": CO_PISO}, alt_cost),
            )
        )
    # pimple_co_vs_outer: outer correctors with a Courant number above about 5.
    if not r.fixed and r.n_outer >= 2 and co > CO_PIMPLE:
        rows.append(
            _row(
                "pimple_co_vs_outer",
                "warn",
                f"Max Courant {num_words(co)} with {r.n_outer} outer correctors: above about {CO_PIMPLE} each step stops converging.",
                f"Max Courant {num_words(co)} with {r.n_outer} outer correctors",
                _fix(f"Max Courant {CO_PIMPLE}", "run", {"transient.max_co": CO_PIMPLE}, _cost(r.estimate(max_co=CO_PIMPLE))),
            )
        )
    # outer_unneeded: outer loops that cost and change nothing at a Courant number of 1 or less.
    fixed_co = courant_at(r.rates, speed=r.speed or 0, direction=r.direction, delta_t=r.delta_t or 0) if r.fixed and r.speed and r.delta_t else None
    low_co = (not r.fixed and co <= CO_PISO) or (fixed_co is not None and fixed_co <= CO_PISO)
    if low_co and r.n_outer > 1:
        times = {2: "nearly double", 3: "nearly triple"}.get(r.n_outer, f"multiply by about {r.n_outer}")
        rows.append(
            _row(
                "outer_unneeded",
                "info",
                f"{r.n_outer} outer correctors at a Courant number of 1 or less {times} each step's cost and change nothing.",
                f"{r.n_outer} outer correctors at Courant 1 or less",
                _fix("1 outer corrector", "run", {"transient.n_outer_correctors": 1}, _cost(r.estimate(n_outer=1))),
            )
        )
    # piso_correctors: PISO needs 2 pressure correctors.
    if r.n_outer <= 1 and r.n_correctors < 2:
        rows.append(
            _row(
                "piso_correctors",
                "warn",
                "PISO needs at least 2 pressure correctors per step.",
                "1 pressure corrector with PISO",
                _fix("2 pressure correctors", "run", {"transient.n_correctors": 2}),
            )
        )
    # fixed_step_co: a fixed step's Courant number in the smallest cells.
    if fixed_co is not None:
        limit = CO_PISO if r.n_outer <= 1 else CO_PIMPLE
        if fixed_co > limit:
            rows.append(
                _row(
                    "fixed_step_co",
                    "warn",
                    f"A fixed step of {fmt(r.delta_t, 2)} s gives a Courant number of about {fmt(fixed_co, 2)} in the smallest cells.",
                    f"fixed step at Courant ≈ {fmt(fixed_co, 2)}",
                    _fix(
                        f"Adjustable time step, Max Courant {CO_PISO}",
                        "run",
                        {"transient.time_step_mode": "adjustable", "transient.max_co": CO_PISO},
                        _cost(r.estimate(max_co=CO_PISO, fixed=False)),
                    ),
                )
            )
    ftt = (est or {}).get("flow_through_s") if est else None
    # average_startup: the averages start inside the start-up.
    still = r.initial_flow == "still" and not r.potential_flow
    startup_ftt = STARTUP_FTT_STILL if still else STARTUP_FTT_MOVING
    startup = startup_ftt * ftt if ftt else None
    if r.averaging and ftt and startup and r.end_time and r.average_from < startup:
        frame = r.frame or 0
        want = math.ceil(startup / frame - 1e-9) * frame if frame > 0 else startup
        want = _clean(want)
        part = "the start-up" if r.average_from <= 0 else "part of the start-up"
        fix = _fix(f"Average from {fmt(want, 4)} s", "run", {"transient.average_from": want}) if want < r.end_time else None
        rows.append(
            _row(
                "average_startup",
                "warn",
                f"Mean velocity and Mean pressure average from {fmt(r.average_from, 4) if r.average_from > 0 else '0'} s, so they include {part}. "
                f"One flow-through ≈ {time_words(ftt)}; averaging from {time_words(startup)} leaves it out.",
                "averages include the start-up",
                fix,
            )
        )
    # duration_vs_ftt: the averaged span against the flow-through time.
    if ftt and r.end_time:
        start = max(r.average_from, 0.0)
        span = r.end_time - start
        n = span / ftt
        rans = r.turbulent
        level = "warn" if n < AVERAGE_FTT_MIN else ("info" if n > AVERAGE_FTT_MAX and rans and not r.time_varying else "")
        if level:
            target_start = max(start, startup or 0.0)
            end = _clean(_round_sig(target_start + AVERAGE_FTT_FIX * ftt, 2, up=True))
            what = f"{time_words(r.end_time)}" if start <= 0 else f"Averaging from {time_words(start)} to {time_words(r.end_time)}"
            fix = None
            if abs(end - r.end_time) > 1e-12 * max(1.0, r.end_time):
                fix = _fix(f"Simulation time {fmt(end, 3)} s", "run", {"transient.end_time": end}, _cost(r.estimate(end_time=end)))
            rows.append(
                _row(
                    "duration_vs_ftt",
                    level,
                    f"{what} is about {fmt(n, 2)} flow-throughs; a mean usually settles within 10-20 after the start-up.",
                    f"about {fmt(n, 2)} flow-throughs",
                    fix,
                )
            )
    # steady_for_mean: a steady run solves for the mean directly.
    wall = (est or {}).get("wall_s") if est else None
    steady_wall = r.steady_wall(STEADY_ITERATIONS)
    if r.turbulent and not r.time_varying and not r.moving and r.steady_copy and wall and steady_wall:
        level = "warn" if wall > STEADY_WARN_S and steady_wall < wall / STEADY_WARN_RATIO else "info"
        rows.append(
            _row(
                "steady_for_mean",
                level,
                f"If you need the mean flow, a steady {r.model_label + ' ' if r.model_label else ''}run solves for it directly: about {STEADY_ITERATIONS:,} iterations, "
                f"roughly {wall_words(steady_wall).removeprefix('about ')} here, against {wall_words(wall)} for this run. Keep this run for shedding or a time history.",
                "a steady run gives the mean sooner",
                _fix("Make a steady copy", "steady_copy", {}, {"steps": STEADY_ITERATIONS, "wall_s": int(round(steady_wall))}),
            )
        )


def _long_run(r: _Run, est: dict[str, Any] | None, rows: list[dict[str, Any]]) -> None:
    """long_run, with the cheapest fix of piso_high_co, duration_vs_ftt and steady_for_mean
    that keeps the Courant checks clean (never a higher Courant number with 1 outer corrector)."""
    wall = (est or {}).get("wall_s") if est else None
    steps = (est or {}).get("steps") if est else None
    if not wall or not steps or wall <= LONG_INFO_S:
        return
    level = "warn" if wall > LONG_WARN_S else "info"
    whose = "this PC's last runs" if r.measured else "a typical speed: no run has finished on this PC yet"
    best: tuple[float, dict[str, Any]] | None = None
    by_code = {row["code"]: row for row in rows}
    for code in ("piso_high_co", "duration_vs_ftt", "steady_for_mean"):
        row = by_code.get(code)
        fix = row.get("fix") if row else None
        if not fix or not fix.get("cost"):
            continue
        vals = {v["key"]: v["value"] for v in fix["values"]}
        if fix["target"] == "run":
            co = float(vals.get("transient.max_co", r.max_co))
            outer = int(vals.get("transient.n_outer_correctors", r.n_outer))
            fixed = vals.get("transient.time_step_mode", "fixed" if r.fixed else "adjustable") == "fixed"
            if outer <= 1 and co > r.max_co:
                continue
            if _courant_rows(r, max_co=co, n_outer=outer, fixed=fixed):
                continue
        cost = float(fix["cost"]["wall_s"])
        if cost < wall and (best is None or cost < best[0]):
            best = (cost, fix)
    fix = dict(best[1]) if best else None
    rows.append(
        _row(
            "long_run",
            level,
            f"About {steps_words(steps)} time steps, roughly {wall_words(wall).removeprefix('about ')} on {cores_words(r.ranks)} ({whose}).",
            f"about {wall_words(wall).removeprefix('about ')}",
            fix,
        )
    )


def _mesh_rows(r: _Run, rows: list[dict[str, Any]]) -> None:
    q = r.quality
    if q is None:
        if r.i.get("mesh_ready"):
            rows.append(_row("quality_unknown", "info", "This mesh has no quality numbers.", "no mesh quality numbers"))
        return
    bad = [f for f in q.get("failed") or [] if isinstance(f, dict) and not f.get("accepted")]
    if bad:
        n = len(bad)
        rows.append(
            _row(
                "mesh_failed",
                "error",
                f"checkMesh failed {n} check{'' if n == 1 else 's'}: {', '.join(failed_words(f) for f in bad)}. The solve will likely fail.",
                f"checkMesh failed {n} check{'' if n == 1 else 's'}",
                _fix("Open mesh", "mesh"),
            )
        )
    ortho = _pos(q.get("max_non_orthogonality"))
    if ortho:
        # A transient run's own correctors (its run settings), else the study's.
        on_run = r.transient and r.n_non_orth is not None
        have = r.n_non_orth if on_run else _int(r.numerics.get("n_non_orthogonal"), 0) if "n_non_orthogonal" in r.numerics else None
        if have is not None and ((ortho > 70 and have == 0) or (ortho > 80 and have < 2)):
            need = 2 if ortho > 80 else 1
            uses = "no non-orthogonal correctors" if have == 0 else f"{have} non-orthogonal corrector{'' if have == 1 else 's'}"
            fix = (
                _fix(f"{need} non-orthogonal corrector{'' if need == 1 else 's'}", "run", {"transient.n_non_orth_correctors": need})
                if on_run
                else _fix("2 non-orthogonal correctors", "study", {"n_non_orthogonal": 2})
            )
            rows.append(
                _row(
                    "non_ortho_correctors",
                    "warn",
                    f"The worst cells are {round(ortho)}° non-orthogonal and the run uses {uses}.",
                    f"{round(ortho)}° non-orthogonal cells",
                    fix,
                )
            )
    skew = _pos(q.get("max_skewness"))
    if (skew and skew > 4) or (ortho and ortho > 85):
        what = f"Skewness reaches {fmt(skew, 2)}" if skew and skew > 4 else f"Non-orthogonality reaches {round(ortho or 0)}°"
        robust = None
        if not r.transient and str(r.numerics.get("numerics_preset") or "") not in ("", "robust") and "numerics_preset" in r.numerics:
            robust = _fix("Robust numerics", "study", {"numerics_preset": "robust"})
        rows.append(
            _row(
                "mesh_skew",
                "warn",
                f"{what}; expect a less stable run near those cells.",
                what.lower(),
                _fix("Open mesh", "mesh"),
                robust,
            )
        )


def failed_words(f: dict[str, Any]) -> str:
    """One failed checkMesh check in the Mesh panel's words (src/panels/mesh/meshQuality.ts)."""
    n = f.get("count")
    names = {
        "skewness": ("highly skewed face", "highly skewed faces"),
        "aspect_ratio": ("cell with a high aspect ratio", "cells with a high aspect ratio"),
        "negative_volume": ("cell with a negative volume", "cells with a negative volume"),
        "non_orthogonality": ("face over 90° non-orthogonal", "faces over 90° non-orthogonal"),
        "face_pyramids": ("wrongly oriented face", "wrongly oriented faces"),
        "face_area": ("face with no area", "faces with no area"),
        "open_cells": ("open cell", "open cells"),
        "non_aligned_edges": ("edge out of line with the 2D directions", "edges out of line with the 2D directions"),
        "face_order": ("face out of order", "faces out of order"),
    }
    check = str(f.get("check") or "")
    if check == "boundary_openness":
        return "the boundary is not closed"
    if check in names:
        one, many = names[check]
        if not isinstance(n, int):
            return many
        return f"{n:,} {one if n == 1 else many}"
    return " ".join(str(f.get("text") or "another check").split())


def _physics_rows(r: _Run, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """The flow's rows (y+, laminar or turbulent, Mach, layers) and what the estimate line
    says of it."""
    out: dict[str, Any] = {"re": None, "re_on": "", "yplus": None}
    re_val, re_on = r.reynolds()
    out["re"], out["re_on"] = re_val, re_on
    first, layered = r.first_cell()
    yp = r.yplus(first)
    out["yplus"] = yp if r.turbulent else None
    mesh = _dict(r.mesh)
    layers = _dict(mesh.get("layers"))
    if layers.get("asked") and layers.get("applied") is False:
        wall = _pos(mesh.get("surface_cell_m"))
        yw = r.yplus(wall) if r.turbulent else None
        size = f"; wall cells are {fmt(wall * 1000, 2)} mm" if wall else ""
        rows.append(
            _row(
                "layers_dropped",
                "warn",
                f"Boundary layers were asked for but the mesher dropped them{size}{f' (y+ ≈ {fmt(yw, 2)})' if yw else ''}.",
                "boundary layers dropped",
                _fix("Open mesh", "mesh"),
            )
        )
    if r.turbulent and yp is not None and first:
        mm = fmt(first * 1000, 2)
        if r.wall_functions and yp < YPLUS_WALL_FN_MIN:
            said = f"Estimated y+ ≈ {fmt(yp, 2)} (first cell {mm} mm). {r.model_label or 'This model'}'s wall functions assume y+ above about 30"
            said += f"; {r.model_fix['label']} handles any y+." if r.model_fix else "."
            rows.append(
                _row(
                    "yplus_model",
                    "warn",
                    said,
                    f"y+ ≈ {fmt(yp, 2)} with {r.model_label or 'wall functions'}",
                    _model_fix(r),
                )
            )
        elif yp > YPLUS_MAX and not any(row["code"] == "layers_dropped" for row in rows):
            rows.append(
                _row(
                    "yplus_model",
                    "warn",
                    f"Estimated y+ ≈ {fmt(yp, 2)} (first cell {mm} mm). Above about 300 the wall cells are too coarse even for wall functions; boundary layers or a finer surface mesh fix it.",
                    f"y+ ≈ {fmt(yp, 2)}",
                    _fix("Open mesh", "mesh"),
                )
            )
    if r.laminar and re_val is not None:
        limit = RE_DH_TURBULENT if re_on == "dh" else RE_L_TURBULENT
        if re_val > limit:
            rows.append(
                _row(
                    "laminar_turbulent",
                    "warn",
                    f"Re ≈ {fmt(re_val, 2)} is turbulent; a laminar model will not settle.",
                    f"laminar at Re ≈ {fmt(re_val, 2)}",
                    _model_fix(r),
                )
            )
    if r.speed and r.speed > MACH_SPEED:
        rows.append(
            _row(
                "mach",
                "warn",
                f"{fmt(r.speed, 3)} m/s is above Mach 0.3; incompressible results will be off.",
                f"{fmt(r.speed, 3)} m/s",
                _fix("Open boundary conditions", "bcs"),
            )
        )
    return out


def _model_fix(r: _Run) -> dict[str, Any] | None:
    """The study's turbulence model the analysis offers for any y+ (its own words and key)."""
    if not r.model_fix:
        return None
    return _fix(str(r.model_fix["label"]), "study", {str(r.model_fix["key"]): r.model_fix.get("value")})


def _steady_rows(r: _Run, rows: list[dict[str, Any]]) -> None:
    iters = _pos(r.s.get("end_time"))
    if iters is not None and iters <= STEADY_SHORT_ITERATIONS and r.cells and r.cells > STEADY_SHORT_CELLS:
        rows.append(
            _row(
                "steady_short",
                "info",
                f"{int(iters):,} iterations is rarely enough for {_cells_words(r.cells)} cells; the residual targets still stop it early.",
                f"{int(iters):,} iterations",
                _fix("1,000 iterations", "run", {"endTime": 1000}),
            )
        )
    n = r.numerics
    if n and not n.get("simplec"):
        rp = _pos(n.get("relax_p"))
        ru = _pos(n.get("relax_u"))
        if (rp and rp > 0.5) or (ru and ru > 0.9):
            what = f"Relaxation p {num_words(rp)}" if rp and rp > 0.5 else f"Relaxation U {num_words(ru)}"
            rows.append(
                _row(
                    "steady_relax",
                    "warn",
                    f"{what} often diverges{' with ' + r.algorithm if r.algorithm else ''}.",
                    what,
                    _fix("Relaxation p 0.3, U 0.7", "study", {"relax_p": 0.3, "relax_u": 0.7}),
                )
            )


def _cells_words(n: float) -> str:
    """625k, 1.2M."""
    if n >= 1e6:
        return f"{fmt(n / 1e6, 2)}M"
    if n >= 1e3:
        return f"{fmt(n / 1e3, 3)}k"
    return f"{int(n)}"


def _start_rows(r: _Run, rows: list[dict[str, Any]]) -> None:
    if r.initial_flow == "still" and r.potential_flow is False and r.inlet_driven:
        rows.append(
            _row(
                "still_start",
                "info",
                "The run starts from rest; starting from potential flow shortens the start-up.",
                "starts from rest",
                _fix("Start from potential flow", "study", {"potential_flow": True}),
            )
        )


def _estimate_line(r: _Run, est: dict[str, Any] | None, phys: dict[str, Any]) -> str:
    """The line "Before you start" always shows."""
    bits: list[str] = []
    if r.transient:
        if est and est.get("delta_t_s"):
            dt = fmt(est["delta_t_s"], 2)
            where = f"smallest cells at {fmt(r.speed, 3)} m/s" + (f', inlet "{r.inlet}"' if r.inlet else "")
            if r.fixed:
                bits.append(f"Δt {dt} s (fixed; Courant ≈ {fmt(est.get('co'), 2)} in the {where})")
            elif est.get("capped"):
                cap = "its Max time step" if est.get("capped_by") == "max_dt" else "one frame"
                bits.append(f"Δt ≈ {dt} s, {cap} (Courant ≈ {fmt(est.get('co'), 2)} in the {where})")
            elif r.max_co > co_allowed(r.n_outer):
                outer = "1 outer corrector allows" if r.n_outer <= 1 else f"{r.n_outer} outer correctors allow"
                bits.append(f"Δt ≈ {dt} s at Max Courant {num_words(co_allowed(r.n_outer))}, as {outer} ({where})")
            else:
                bits.append(f"Δt ≈ {dt} s at Max Courant {num_words(r.max_co)} ({where})")
            if est.get("steps"):
                bits.append(f"~{steps_words(est['steps'])} steps")
            if est.get("wall_s") is not None:
                bits.append(f"~{wall_words(est['wall_s']).removeprefix('about ')} on {cores_words(r.ranks)}")
        else:
            bits.append(_no_estimate_words(r))
        if est and est.get("flow_through_s"):
            bits.append(f"one flow-through ≈ {time_words(est['flow_through_s'])}")
    else:
        iters = _pos(r.s.get("end_time"))
        if iters:
            wall = r.steady_wall(iters)
            bits.append(f"{int(iters):,} iterations at most" + (f" · ~{wall_words(wall).removeprefix('about ')} on {cores_words(r.ranks)}" if wall else ""))
    if phys.get("re") is not None:
        bits.append(f"Re ≈ {fmt(phys['re'], 2)}")
    if phys.get("yplus") is not None:
        bits.append(f"y+ ≈ {fmt(phys['yplus'], 2)}")
    return " · ".join(bits)


def _no_estimate_words(r: _Run) -> str:
    """Why a transient run's line has no time step."""
    if r.i.get("no_estimate"):
        return str(r.i["no_estimate"])
    if not r.speed:
        return "No time-step estimate: no inlet speed or pressure difference sets a flow speed"
    if not r.rates:
        skipped = str(_dict(_dict(r.mesh).get("courant_rates")).get("skipped") or "")
        if skipped.startswith("over "):
            # courant_rates.write_rates skips meshes this large: generating again cannot help.
            return f"No time-step estimate for a mesh {skipped}"
        if skipped:
            return "No time-step estimate: the mesh's cells could not be read"
        return "No time-step estimate: this mesh has no Courant rates (generate it again to get them)"
    return "No time-step estimate"


def check(inputs: dict[str, Any]) -> dict[str, Any]:
    """The pre-run check of a run: ``{"checks": [rows], "estimate": {...}}``.

    ``inputs`` (every key optional): ``time_dependency`` ("transient" or "steady");
    ``settings`` (the run's transient block, or ``{end_time}`` in iterations);
    ``delta_t_written`` (the fixed Δt the case is written with when ``delta_t`` is
    blank); ``n_cells``, ``ranks``, ``s_per_cell_step``, ``rate_source`` (``measured`` or
    ``default``); ``mesh`` (``mesh-facts.json``) and ``rates`` (``courant-rates.json``);
    ``speed`` (m/s), ``direction`` and ``inlet`` (its name); ``velocity_cap`` (m/s, the
    velocity limit, None without one); ``time_varying``, ``moving``; ``turbulence`` (the
    analysis's words for its model: ``laminar``, ``label``, ``fields`` that can go negative,
    ``wall_functions``, and ``any_yplus``: ``{label, key, value}``, the study setting of a model
    that handles any y+); ``steady_algorithm`` (its steady pressure-velocity algorithm's name);
    ``nu`` (m²/s); ``d_hyd`` (m, the inlet's hydraulic diameter); ``initial_flow``,
    ``potential_flow`` (None when the analysis has none), ``inlet_driven``; ``numerics``
    (the study's: ``relax_p``, ``relax_u``, ``simplec``, ``n_non_orthogonal``,
    ``numerics_preset``); ``steady_copy`` (a steady analysis of the family exists);
    ``kept`` (the codes kept as set); ``no_estimate`` (the line's words when the analysis
    gives no time step); ``inputs_complete`` (False when only the run's settings could be
    read, as before a mesh: the estimate's ``complete`` then says the mesh and physics were
    not checked, and ``unchecked`` says so in the analysis's words, from ``unchecked``).
    """
    r = _Run(inputs)
    rows: list[dict[str, Any]] = []
    est = r.estimate() if r.transient else None
    phys = _physics_rows(r, rows)
    _mesh_rows(r, rows)
    if r.transient:
        _transient_rows(r, est, rows)
        _long_run(r, est, rows)
    else:
        _steady_rows(r, rows)
    _start_rows(r, rows)
    for row in rows:
        row["kept"] = row["code"] in r.kept
    order = {c: n for n, c in enumerate(CODE_ORDER)}
    rows.sort(key=lambda x: (LEVEL_ORDER.get(x["level"], 3), order.get(x["code"], 99)))
    estimate: dict[str, Any] = {
        "line": _estimate_line(r, est, phys),
        "ranks": r.ranks,
        "re": phys.get("re"),
        "yplus": phys.get("yplus"),
        "rate_source": "measured" if r.measured else "default",
        "velocity_cap": r.cap,
        "complete": r.complete,
    }
    if not r.complete:
        estimate["unchecked"] = r.unchecked
    if r.transient:
        estimate.update(
            {
                "delta_t_s": (est or {}).get("delta_t_s"),
                "co": (est or {}).get("co"),
                "steps": (est or {}).get("steps"),
                "wall_s": (est or {}).get("wall_s"),
                "flow_through_s": (est or {}).get("flow_through_s"),
                "speed": r.speed,
                "inlet": r.inlet or None,
                "max_co": r.max_co,
                "co_used": None if r.fixed else min(r.max_co, co_allowed(r.n_outer)),
                "fixed": r.fixed,
                "capped": bool((est or {}).get("capped")),
            }
        )
    else:
        iters = _pos(r.s.get("end_time"))
        estimate.update({"iterations": int(iters) if iters else None, "wall_s": r.steady_wall(iters) if iters else None})
    return {"checks": rows, "estimate": estimate}


def counts(rows: list[dict[str, Any]] | None, *, kept: bool = False) -> dict[str, int]:
    """How many rows of each level (kept ones left out unless ``kept``)."""
    out = {"error": 0, "warn": 0, "info": 0}
    for row in rows or []:
        if not isinstance(row, dict) or (row.get("kept") and not kept):
            continue
        lvl = str(row.get("level") or "")
        if lvl in out:
            out[lvl] += 1
    return out
