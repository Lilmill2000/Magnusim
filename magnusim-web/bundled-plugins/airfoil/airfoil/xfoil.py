"""XFOIL: a viscous polar from the panel code, run as a program (``xfoil.exe``).

XFOIL (Mark Drela, MIT; GPL) is a separate program the plugin ships in
``xfoil/bin/`` with its source and licence (``xfoil/README.md``). It is driven
through its command prompt: the whole session is written to its standard
input, and it is run with :func:`magnusim_sdk.proc.run_exe`, which ends it and
everything it started when it runs past its time.

The session turns the graphics off first (``PLOP`` / ``G``), loads the section,
re-panels it, sets the conditions, accumulates the polar into a file
(``PACC``), and for each α runs ``ALFA`` then ``CPWR`` (the Cp(x) file). The
angles go from the one nearest 0 upwards, then from the one nearest 0 downwards,
the order in which XFOIL converges best: each angle starts from the converged
boundary layer of its neighbour. Only where the sweep turns back from the
highest angle to the lower ones does ``INIT`` start the boundary layer again,
once.

α is sent with at most 3 decimals, as XFOIL writes it back in the polar file,
so every angle matches its own row exactly.

XFOIL adds a point to the polar file only when it converged, so an α that is
not in the file did not converge; it is reported, never dropped. (XFOIL also
prints "VISCAL:  Convergence failed" for each such α; the boundary-layer
marches print other "Convergence failed" lines while an α still converges,
which say nothing about the result.) While it runs, each Cp file that appears
is one α done (a converged one or not), which is what the progress events count.

The program is MIT's own Windows build of XFOIL 6.99 (``xfoil/README.md``), so
it runs on Windows only.
"""

from __future__ import annotations

import math
import re
import sys
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from magnusim_sdk.proc import ExeResult, run_exe

from airfoil import datfile, geometry

# SPDX-License-Identifier: GPL-3.0-or-later

ITERATIONS = 100
MAX_INPUT_POINTS = 300
ALPHA_DECIMALS = 3  # XFOIL writes α with 3 decimals
# α is rounded to ALPHA_DECIMALS before it is sent, so XFOIL's echo is exact; the
# tolerance only absorbs float noise and stays far below the smallest α step (0.05°).
ALPHA_MATCH = 0.01
DAT_NAME = "airfoil.dat"
POLAR_NAME = "polar.txt"


class XfoilError(RuntimeError):
    """XFOIL could not run the polar (the message says why)."""


@dataclass
class XfoilPolar:
    rows: list[dict[str, float]]
    not_converged: list[float]
    cp: dict[str, dict[str, list[float]]] = field(default_factory=dict)
    failed_reported: int = 0  # α XFOIL itself reported as failed ("VISCAL:  Convergence failed")
    seconds: float = 0.0
    log_tail: list[str] = field(default_factory=list)


def plugin_dir() -> Path:
    return Path(__file__).resolve().parents[1]


def default_exe() -> Path:
    return plugin_dir() / "xfoil" / "bin" / "xfoil.exe"


def unavailable_reason(exe: Path | None = None) -> str | None:
    """Why the shipped XFOIL cannot run here, or None when it can."""
    exe = exe or default_exe()
    if not exe.is_file():
        return "XFOIL is missing from this copy of the Airfoil plugin (xfoil/bin/xfoil.exe). Reinstall Magnusim to get it back."
    if sys.platform != "win32":
        return "XFOIL ships as a Windows program (xfoil.exe), so it runs on Windows only."
    return None


def sweep_order(alphas: Sequence[float]) -> list[float]:
    """Angles from the one nearest 0 upwards, then from the next one down.

    Each α is rounded to the 3 decimals XFOIL writes (duplicates dropped).
    """
    ordered = sorted({round(float(a), ALPHA_DECIMALS) for a in alphas})
    if not ordered:
        return []
    start = min(range(len(ordered)), key=lambda i: (abs(ordered[i]), -ordered[i]))
    return ordered[start:] + list(reversed(ordered[:start]))


def _fmt(v: float) -> str:
    text = f"{v:.6f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def cp_name(index: int) -> str:
    return f"cp_{index:03d}.txt"


def build_script(order: Sequence[float], conditions: dict[str, float], iterations: int = ITERATIONS) -> str:
    """The whole XFOIL session, one command per line (a blank line leaves a menu)."""
    lines = [
        "PLOP",
        "G",  # graphics off: XFOIL never opens a window
        "",
        f"LOAD {DAT_NAME}",
        "PANE",
        "OPER",
        f"VISC {_fmt(conditions['re'])}",
        f"MACH {_fmt(conditions['mach'])}",
        f"ITER {int(iterations)}",
        "VPAR",
        f"N {_fmt(conditions['ncrit'])}",
        f"XTR {_fmt(conditions['xtr_top'])} {_fmt(conditions['xtr_bottom'])}",
        "",
        "PACC",
        POLAR_NAME,
        "",  # no dump file
    ]
    turned = False
    for i, a in enumerate(order):
        # Where the sweep turns back from the highest angle to the one below the
        # first, the last converged boundary layer is far away: start it again,
        # once. Every later angle starts from its converged neighbour. (A sweep
        # whose upward leg is a single angle steps straight to that neighbour.)
        if not turned and i > 0 and a < order[i - 1]:
            turned = True
            if i >= 2:
                lines.append("INIT")
        lines.append(f"ALFA {_fmt(a)}")
        lines.append(f"CPWR {cp_name(i)}")
    lines += ["PACC", "", "QUIT", ""]
    return "\n".join(lines)


_HEADER = re.compile(r"^\s*alpha\s+CL\s+CD\b", re.IGNORECASE)


def parse_polar(text: str) -> list[dict[str, float]]:
    """The rows of an XFOIL polar file, keyed by its column names in lower case."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if _HEADER.match(line):
            names = [n.lower() for n in line.split()]
            rows: list[dict[str, float]] = []
            for raw in lines[i + 1 :]:
                if not raw.strip() or set(raw.strip()) <= {"-", " "}:
                    continue
                parts = raw.split()
                try:
                    values = [float(p) for p in parts]
                except ValueError:
                    continue
                if len(values) < len(names):
                    continue
                rows.append(dict(zip(names, values, strict=False)))
            return rows
    return []


def parse_cp(text: str) -> dict[str, list[float]]:
    """x and Cp from a CPWR file (two columns, or three with y; '#' lines are headers)."""
    xs: list[float] = []
    cps: list[float] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            values = [float(p) for p in line.split()]
        except ValueError:
            continue
        if len(values) >= 2:
            xs.append(values[0])
            cps.append(values[-1])
    return {"x": xs, "cp": cps}


def _row(raw: dict[str, float]) -> dict[str, float]:
    cl, cd = raw.get("cl", math.nan), raw.get("cd", math.nan)
    out = {
        "alpha": raw.get("alpha", math.nan),
        "cl": cl,
        "cd": cd,
        "cdp": raw.get("cdp", math.nan),
        "cm": raw.get("cm", math.nan),
        "xtr_top": raw.get("top_xtr", math.nan),
        "xtr_bottom": raw.get("bot_xtr", math.nan),
    }
    out["cl_cd"] = cl / cd if cd else math.nan
    return {k: float(f"{v:.6g}") for k, v in out.items() if math.isfinite(v)}


def _match(alpha: float, found: Sequence[float]) -> bool:
    return any(abs(alpha - f) <= ALPHA_MATCH for f in found)


ProgressFn = Callable[[int, float, int], None]


def run(
    name: str,
    x: Sequence[float],
    y: Sequence[float],
    alphas: Sequence[float],
    conditions: dict[str, float],
    workdir: Path,
    *,
    exe: Sequence[str] | None = None,
    timeout_s: float | None = None,
    on_progress: ProgressFn | None = None,
    poll_s: float = 0.2,
) -> XfoilPolar:
    """Run the polar in ``workdir`` (an empty folder of its own) and read what XFOIL wrote.

    ``on_progress(done, alpha, total)`` is called once for each α XFOIL has
    finished, in the order it ran them. Raises :class:`XfoilError` when XFOIL is
    missing, ran out of time, or wrote no polar at all.
    """
    command = list(exe) if exe else [str(default_exe())]
    if not exe:
        reason = unavailable_reason(Path(command[0]))
        if reason:
            raise XfoilError(reason)
    order = sweep_order(alphas)
    if not order:
        raise XfoilError("No angles to run.")
    workdir.mkdir(parents=True, exist_ok=True)
    px, py = geometry.decimate(list(x), list(y), MAX_INPUT_POINTS)
    # XFOIL reads names of at most 48 characters and stops at a blank one.
    label = re.sub(r"[^A-Za-z0-9 ._+-]", "", name)[:40].strip() or "Airfoil"
    (workdir / DAT_NAME).write_text(datfile.write(label, px, py), encoding="ascii", errors="replace")
    script = build_script(order, conditions)
    limit = float(timeout_s) if timeout_s is not None else min(600.0, 30.0 + 10.0 * len(order))

    box: dict[str, Any] = {}

    def target() -> None:
        try:
            box["result"] = run_exe(command, stdin=script, timeout=limit, cwd=workdir)
        except Exception as exc:  # noqa: BLE001 - reported below
            box["error"] = exc

    t0 = time.perf_counter()
    worker = threading.Thread(target=target, name="xfoil", daemon=True)
    worker.start()
    seen = 0

    def report_new() -> None:
        nonlocal seen
        while seen < len(order) and (workdir / cp_name(seen)).is_file():
            if on_progress is not None:
                on_progress(seen + 1, order[seen], len(order))
            seen += 1

    while worker.is_alive():
        report_new()
        worker.join(poll_s)
    report_new()
    seconds = time.perf_counter() - t0
    if "error" in box:
        raise XfoilError(f"XFOIL could not be started: {box['error']}")
    result: ExeResult = box["result"]
    out_lines = (result.stdout or "").splitlines()
    tail = [ln.rstrip() for ln in out_lines if ln.strip()][-12:]
    if result.timed_out:
        raise XfoilError(f"XFOIL ran longer than {limit:g} s and was stopped.")
    polar_path = workdir / POLAR_NAME
    if not polar_path.is_file():
        detail = " ".join(tail[-3:])
        raise XfoilError(f"XFOIL wrote no polar. Its last output: {detail}" if detail else "XFOIL wrote no polar.")
    raw_rows = parse_polar(polar_path.read_text(encoding="ascii", errors="replace"))
    found = [r["alpha"] for r in raw_rows if "alpha" in r]
    rows = sorted((_row(r) for r in raw_rows), key=lambda r: r["alpha"])
    not_converged = sorted(a for a in order if not _match(a, found))
    cp: dict[str, dict[str, list[float]]] = {}
    for i, a in enumerate(order):
        f = workdir / cp_name(i)
        if _match(a, found) and f.is_file():
            cp[_fmt(a)] = parse_cp(f.read_text(encoding="ascii", errors="replace"))
    failed = sum(1 for ln in out_lines if re.search(r"VISCAL:\s+Convergence failed", ln, re.IGNORECASE))
    return XfoilPolar(
        rows=rows,
        not_converged=not_converged,
        cp=cp,
        failed_reported=failed,
        seconds=round(seconds, 3),
        log_tail=tail,
    )


def describe_not_converged(alphas: Sequence[float]) -> list[str]:
    """One line per α, as the page and the job's log show them: "α = 12°: did not converge"."""
    return [f"α = {_fmt(a)}°: did not converge" for a in alphas]
