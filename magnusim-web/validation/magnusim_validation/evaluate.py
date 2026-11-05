"""``result.json`` of one run, from what the driver saved: the route answers in ``raw/`` and
``driver.json``. The case module measures its quantities from them; this module adds what
every result records: the app and the PC, the setup as sent, the mesh (cells, quality and
layers asked and applied, from RH2's mesh facts), the pre-run check, the run (iterations,
convergence, run time, ranks, numerics as written) and its health (RH1), and the status.

A run's status is ``ok`` only when it produced every compared value and, if steady, settled;
otherwise it says where it stopped (``setup_failed``, ``mesh_failed``, ``layers_not_applied``,
``solve_failed``, ``not_settled``, ``extract_failed``), with the app's words in
``status_detail``. A steady run that reached its residual targets is settled; one that stopped
at its iteration limit is settled only when the case's monitor histories (``SETTLE``) moved
less than ``SETTLE_DRIFT`` over its last 10 % of iterations.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from . import SCHEMA_RESULT
from .extract import last_drift
from .model import compare
from .plan import read_plan
from .result import write_result
from .sampling import sample_run

SAMPLE_PROBLEMS = "sample-problems"

# Where each driver step's failure leaves the run.
STEP_STATUS = {
    "setup": "setup_failed",
    "project": "setup_failed",
    "import": "setup_failed",
    "faces": "setup_failed",
    "study": "setup_failed",
    "material": "setup_failed",
    "bcs": "setup_failed",
    "mesh-settings": "setup_failed",
    "refinements": "setup_failed",
    "mesh": "mesh_failed",
    "mesh-facts": "mesh_failed",
    "run-settings": "setup_failed",
    "ready": "setup_failed",
    "solve": "solve_failed",
    "results": "solve_failed",
    "lines": "extract_failed",
}


def _read(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _f(v: Any) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if x == x and abs(x) != float("inf") else None


class Raw:
    """The driver's saved answers of one run."""

    def __init__(self, run_dir: Path) -> None:
        self.dir = run_dir / "raw"

    def get(self, name: str) -> Any:
        return _read(self.dir / f"{name}.json")

    def text(self, name: str) -> str:
        try:
            return (self.dir / name).read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""

    def line(self, key: str) -> dict[str, Any] | None:
        doc = self.get(f"line_{key}")
        return doc if isinstance(doc, dict) else None

    def sample(self, key: str) -> dict[str, Any] | None:
        """What the harness read from the run's case folder (sampling.py), when it could."""
        doc = self.get(f"sample_{key}")
        return doc if isinstance(doc, dict) else None

    def sample_problem(self, key: str) -> str:
        """Why a sample is missing, in words."""
        doc = self.get(SAMPLE_PROBLEMS) or {}
        for line in doc.get("problems") or []:
            if str(line).startswith(f"{key}:"):
                return str(line)
        return f"{key}: not read"

    def run(self) -> dict[str, Any]:
        """The run as its status route last answered."""
        st = self.get("run-status") or {}
        run = st.get("run") if isinstance(st, dict) else None
        drv = self.get_driver()
        rid = str((drv or {}).get("ids", {}).get("run_id") or "")
        if isinstance(run, dict) and str(run.get("run_id") or run.get("id")) == rid:
            return run
        for r in (st.get("runs") or []) if isinstance(st, dict) else []:
            if str(r.get("id") or r.get("run_id")) == rid:
                return r
        return run if isinstance(run, dict) else {}

    def get_driver(self) -> dict[str, Any] | None:
        doc = _read(self.dir.parent / "driver.json")
        return doc if isinstance(doc, dict) else None

    def monitor_rows(self) -> list[dict[str, Any]]:
        """Every monitor of the run's monitors answer (the patch monitors and the custom ones)."""
        doc = self.get("monitors") or {}
        out: list[dict[str, Any]] = []
        for key in ("monitors", "custom", "patches", "rows"):
            v = doc.get(key) if isinstance(doc, dict) else None
            if isinstance(v, list):
                out.extend(x for x in v if isinstance(x, dict))
        return out

    def _last_point(self, mon: dict[str, Any]) -> dict[str, Any] | None:
        for key in ("series", "points", "rows", "values"):
            v = mon.get(key)
            if isinstance(v, list) and v and isinstance(v[-1], dict):
                return v[-1]
        last = mon.get("last")
        return last if isinstance(last, dict) else None

    def monitor_series(self, key: str, sample: str, component: int | None = None) -> list[float]:
        """A monitor's history of one sample (a vector's component when asked), step by step."""
        for mon in self.monitor_rows():
            if str(mon.get("key") or "") != key:
                continue
            out: list[float] = []
            for row in mon.get("series") or []:
                v = row.get(sample) if isinstance(row, dict) else None
                if component is not None:
                    v = v[component] if isinstance(v, list) and len(v) > component else None
                x = _f(v)
                if x is not None:
                    out.append(x)
            return out
        return []

    def patch_flow(self, patch: str) -> float | None:
        """The last volumetric flow (m³/s, its magnitude) through a patch's flow monitor."""
        for mon in self.monitor_rows():
            key = str(mon.get("key") or mon.get("id") or "")
            name = str(mon.get("patch") or mon.get("name") or "")
            if key in (f"flow_{patch}", f"mon_{patch}") or name == patch:
                last = self._last_point(mon)
                q = _f((last or {}).get("Q_m3s"))
                if q is not None:
                    return abs(q)
        return None

    def patch_pressure(self, patch: str) -> float | None:
        """A patch monitor's last area-averaged pressure (Pa)."""
        for mon in self.monitor_rows():
            if str(mon.get("key") or "") == f"mon_{patch}" or str(mon.get("patch") or "") == patch:
                return _f((self._last_point(mon) or {}).get("p_Pa"))
        return None

    def flow_balance(self) -> dict[str, float] | None:
        """The monitors' flow balance: in, out (m³/s) and the imbalance (out - in, m³/s)."""
        doc = self.get("monitors") or {}
        bal = doc.get("balance") if isinstance(doc, dict) else None
        if not isinstance(bal, dict):
            return None
        vals = {k: _f(bal.get(k)) for k in ("in_m3s", "out_m3s", "imbalance")}
        return {k: v for k, v in vals.items() if v is not None} or None

    def patch_area(self, patch: str) -> float | None:
        """A patch monitor's mesh area (m²): the sum of its faces' areas."""
        for mon in self.monitor_rows():
            if str(mon.get("key") or "") == f"mon_{patch}" or str(mon.get("patch") or "") == patch:
                a = _f(mon.get("area_m2"))
                if a is not None and a > 0:
                    return a
        return None

    def probe_values(self, name: str, component: int = 0) -> list[tuple[float, float]]:
        """(x, U component) at each point of a Point probe monitor's last saved step."""
        out: list[tuple[float, float]] = []
        slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
        for mon in self.monitor_rows():
            key = str(mon.get("key") or "")
            if not key.startswith(f"probes_{slug}_"):
                continue
            last = self._last_point(mon)
            u = (last or {}).get("U")
            pt = mon.get("point") or mon.get("location") or (last or {}).get("point")
            if isinstance(u, list) and len(u) > component and isinstance(pt, list) and pt:
                ux = _f(u[component])
                x = _f(pt[0])
                if ux is not None and x is not None:
                    out.append((x, ux))
        return sorted(out)


def openfoam_version(log_start: Any) -> str | None:
    """"v2606 (build _481094f-20260618)" from the solver log's header."""
    text = ""
    if isinstance(log_start, dict):
        lines = log_start.get("lines") or log_start.get("text") or log_start.get("excerpt") or ""
        text = "\n".join(lines) if isinstance(lines, list) else str(lines)
    v = re.search(r"Version:\s*(\S+)", text)
    b = re.search(r"Build\s*:\s*(\S+)", text)
    if not v:
        return None
    ver = v.group(1) if not v.group(1).isdigit() else f"v{v.group(1)}"
    return f"{ver} (build {b.group(1)})" if b else ver


def _log_text(doc: Any) -> str:
    if not isinstance(doc, dict):
        return ""
    lines = doc.get("lines") or doc.get("text") or doc.get("excerpt") or ""
    return "\n".join(lines) if isinstance(lines, list) else str(lines)


def converged_at(log_end: Any) -> int | None:
    """The iteration of simpleFoam's "SIMPLE solution converged in N iterations", if any."""
    m = re.search(r"converged in\s+(\d+)\s+iterations", _log_text(log_end))
    return int(m.group(1)) if m else None


def background_block(block_mesh_dict: str) -> dict[str, Any] | None:
    """The background block's cell counts and size (blockMeshDict's first hex), when found."""
    m = re.search(r"hex\s*\([^)]*\)\s*\((\d+)\s+(\d+)\s+(\d+)\)", block_mesh_dict)
    if not m:
        return None
    return {"block": [int(m.group(i)) for i in (1, 2, 3)]}


def _seconds(a: Any, b: Any) -> float | None:
    try:
        ta = datetime.fromisoformat(str(a).replace("Z", "+00:00"))
        tb = datetime.fromisoformat(str(b).replace("Z", "+00:00"))
    except ValueError:
        return None
    return round((tb - ta).total_seconds(), 1)


def residual_series(hist: list[dict[str, Any]], n_max: int = 300) -> dict[str, list[float]]:
    """The residual history (initial residuals per iteration), at most ``n_max`` steps."""
    step = max(1, -(-len(hist) // n_max))
    rows = hist[::step]
    if rows[-1] is not hist[-1]:
        rows.append(hist[-1])
    out: dict[str, list[float]] = {"t": [float(r["t"]) for r in rows]}
    for key in sorted({k for r in hist for k in r if k != "t"}):
        vals = [_f(r.get(key)) for r in rows]
        if all(v is not None for v in vals):
            out[key] = [float(f"{v:.4g}") for v in vals if v is not None]
    return out


def mesh_section(raw: Raw, plan: dict[str, Any], drv: dict[str, Any] | None) -> dict[str, Any]:
    mesh = (raw.get("mesh") or {}).get("mesh") or {}
    live = mesh.get("live_mesh_result") or {}
    facts = raw.get("mesh-facts") or {}
    if facts.get("missing"):
        facts = {}
    layers = facts.get("layers") or {}
    q = facts.get("quality") or live.get("quality") or {}
    return {
        "mesher": (plan.get("mesh") or {}).get("settings", {}).get("advanced", {}).get("mesh_engine"),
        "n_cells": live.get("n_cells") or facts.get("n_cells"),
        "n_points": live.get("n_points"),
        "generate_s": ((drv or {}).get("timings_s") or {}).get("mesh"),
        "background": background_block(raw.text("blockMeshDict.txt")),
        "surface_cell_m": facts.get("surface_cell_m"),
        # Each custom size's band as the mesher wrote it (Hex-dominant; with a Refine out to, its reach).
        **({"refined": facts["refined"]} if facts.get("refined") else {}),
        "quality": {
            "known": q.get("known"),
            "ok": q.get("ok"),
            "n_failed": q.get("n_failed"),
            "failed": q.get("failed"),
            "max_non_orthogonality": q.get("max_non_orthogonality"),
            "max_skewness": q.get("max_skewness"),
            "max_aspect_ratio": q.get("max_aspect_ratio"),
        },
        "layers": {
            "asked": layers.get("asked"),
            "applied": layers.get("applied"),
            "first_m": layers.get("first_m"),
            "walls": layers.get("walls") or [],
        },
        "layers_applied": live.get("layers_applied"),
        "hex_core_applied": live.get("hex_core_applied"),
        "facts_found": bool(facts),
    }


def run_section(raw: Raw, plan: dict[str, Any], drv: dict[str, Any] | None) -> dict[str, Any]:
    run = raw.run()
    health_doc = raw.get("health") or {}
    health = health_doc.get("health") if isinstance(health_doc.get("health"), dict) else health_doc
    findings = health.get("findings") if isinstance(health, dict) else None
    log_end = raw.get("solver-log-end")
    conv = converged_at(log_end)
    iterations = run.get("iteration") or run.get("last_saved_iteration")
    residuals = [r for r in (run.get("residuals") or []) if isinstance(r, dict)]
    return {
        "status": run.get("status"),
        "iterations": iterations,
        "end_time_set": (plan.get("run") or {}).get("endTime"),
        "converged": conv is not None,
        "converged_at": conv,
        "residuals_final": residuals[-1] if residuals else None,
        "wall_s": _seconds(run.get("started_at"), run.get("finished_at")),
        "driver_solve_s": ((drv or {}).get("timings_s") or {}).get("solve"),
        "cores_set": (plan.get("run") or {}).get("cores"),
        "n_procs": run.get("n_procs"),
        "numerics_used": run.get("numerics_used"),
        "health": {
            "verdict": (health or {}).get("verdict") if isinstance(health, dict) else None,
            "findings": [
                {k: f.get(k) for k in ("code", "level", "title", "text", "message") if k in f}
                for f in (findings or [])
                if isinstance(f, dict)
            ],
        },
        "log_end_tail": _log_text(log_end).splitlines()[-12:],
    }


def _drift_text(drift: float | None) -> str:
    return "unknown" if drift is None else f"{100 * drift:.3g} %"


def settle_section(raw: Raw, case: Any, plan: dict[str, Any], run: dict[str, Any]) -> dict[str, Any]:
    """Whether a steady run settled: it reached its residual targets, or the case's monitor
    histories moved less than its drift limit over the run's last 10 % of iterations."""
    steady = str((plan.get("study") or {}).get("time_dependency") or "") == "Steady-state"
    limit = float(getattr(case, "SETTLE_DRIFT", 1e-3))
    histories = []
    for h in getattr(case, "SETTLE", ()):
        vals = raw.monitor_series(h["monitor"], h["sample"], h.get("component"))
        histories.append({"label": h["label"], "monitor": h["monitor"], "n": len(vals), "drift": last_drift(vals)})
    if not steady:
        settled = None
    elif run.get("converged"):
        settled = True
    else:
        settled = bool(histories) and all(x["drift"] is not None and x["drift"] <= limit for x in histories)
    return {"steady": steady, "converged": bool(run.get("converged")), "drift_limit": limit,
            "histories": histories, "settled": settled}


def precheck_section(raw: Raw) -> dict[str, Any]:
    doc = raw.get("precheck") or {}
    body = doc.get("body") if isinstance(doc, dict) else None
    body = body if isinstance(body, dict) else {}
    rows = body.get("rows") or body.get("checks") or []
    return {
        "http_status": doc.get("status") if isinstance(doc, dict) else None,
        "rows": [
            {k: r.get(k) for k in ("code", "level", "text", "title") if k in r} for r in rows if isinstance(r, dict)
        ],
        "estimate": body.get("estimate"),
    }


def evaluate_dir(run_dir: Path, *, failed: str = "") -> dict[str, Any]:
    """Write ``result.json`` of the run in ``run_dir``; return it."""
    from . import cases

    plan = read_plan(run_dir)
    case = cases.get(plan["case"])
    raw = Raw(run_dir)
    drv = raw.get_driver()
    log_start = raw.get("solver-log-start")
    status, detail = "ok", ""
    outcome = (drv or {}).get("outcome")
    if failed or outcome == "failed" or not drv:
        step = (drv or {}).get("failed_step") or "setup"
        status = STEP_STATUS.get(str(step), "setup_failed")
        detail = (drv or {}).get("error") or failed or "the driver left no record"
    elif outcome == "mesh_only":
        status = "mesh_only"
    mesh = mesh_section(raw, plan, drv)
    run = run_section(raw, plan, drv)
    warnings: list[str] = []
    if status == "ok":
        # The cell values and saved fields the case reads from the run's case folder, kept in raw/.
        ids = (drv or {}).get("ids") or {}
        probs = sample_run(run_dir, plan, ids.get("run_case_dir"), ids.get("latest_time"))
        if probs:
            (run_dir / "raw" / f"{SAMPLE_PROBLEMS}.json").write_text(
                json.dumps({"problems": probs}) + "\n", encoding="utf-8", newline="\n")
    expect = (plan.get("mesh") or {}).get("expect") or {}
    if status in ("ok", "mesh_only") and expect.get("layers"):
        applied = mesh["layers"]["applied"]
        if applied is not True or mesh["layers_applied"] is False:
            status = "layers_not_applied"
            detail = (f"layers were asked and not applied (mesh facts: applied {applied}; "
                      f"mesh record: layers_applied {mesh['layers_applied']})")
    cells = mesh.get("n_cells")
    lo_hi = expect.get("n_cells")
    if isinstance(cells, (int, float)) and isinstance(lo_hi, list) and not (lo_hi[0] <= cells <= lo_hi[1]):
        warnings.append(f"{int(cells)} cells, outside the expected {lo_hi[0]} to {lo_hi[1]}")
    measured: dict[str, Any] = {"quantities": [], "series": {}, "shown": {}, "warnings": []}
    if status == "ok":
        measured = case.evaluate(plan, raw)
        missing = [q["key"] for q in measured["quantities"] if q["value"] is None]
        if missing:
            status, detail = "extract_failed", f"no value for {', '.join(missing)}: " + "; ".join(measured["warnings"])
        verdict = (run["health"] or {}).get("verdict")
        if status == "ok" and verdict == "failed":
            status, detail = "solve_failed", "run health: failed"
    run["settle"] = settle_section(raw, case, plan, run)
    if status == "ok" and run["settle"]["settled"] is False:
        moved = "; ".join(f"{h['label']} {_drift_text(h['drift'])}"
                          for h in run["settle"]["histories"]) or "no monitor history to judge by"
        status = "not_settled"
        detail = (f"stopped at its iteration limit ({run.get('end_time_set')}) without reaching its residual targets, "
                  f"and its monitors moved more than {100 * run['settle']['drift_limit']:.3g} % over the last 10 % "
                  f"of iterations: {moved}")
    elif status == "ok" and run["settle"]["steady"] and not run["settle"]["converged"]:
        warnings.append("the run stopped at its iteration limit without reaching its residual targets; its monitors "
                        f"moved less than {100 * run['settle']['drift_limit']:.3g} % over the last 10 % of iterations")
    hist = [r for r in (raw.run().get("residuals") or []) if isinstance(r, dict) and "t" in r]
    if hist:
        measured["series"]["residuals"] = residual_series(hist)
    if not measured["quantities"]:
        measured["quantities"] = [compare(spec, None) for spec in case.QUANTITIES.values()]
    app = dict((drv or {}).get("app") or {})
    app["openfoam"] = openfoam_version(log_start)
    doc: dict[str, Any] = {
        "schema": SCHEMA_RESULT,
        "case": plan["case"],
        "variant": plan["variant"],
        "title": plan["title"],
        "group": case.GROUP,
        "status": status,
        "status_detail": detail,
        "coarse": bool(plan.get("coarse")),
        # Mesh settings changed by hand (a probe, never reported).
        "overrides": plan.get("overrides") or {},
        "when": {"started": (drv or {}).get("started_at"), "finished": (drv or {}).get("finished_at")},
        "app": app,
        "setup": {
            "words": "",
            "geometry": {k: plan["geometry"][k] for k in ("file", "sha256", "units", "builder", "labels")},
            "study": plan.get("study"),
            "material": plan.get("material"),
            "bcs": plan.get("bcs"),
            "mesh": {k: v for k, v in (plan.get("mesh") or {}).items() if k != "expect"},
            "run": {k: v for k, v in (plan.get("run") or {}).items() if k != "result_controls"},
        },
        "mesh": mesh,
        "precheck": precheck_section(raw),
        "run": run,
        "timings_s": (drv or {}).get("timings_s") or {},
        "quantities": measured["quantities"],
        "series": measured["series"],
        "shown": measured["shown"],
        "warnings": warnings + list(measured["warnings"]),
    }
    doc["setup"]["words"] = case.setup_words(doc)
    doc["setup"]["mesh_words"] = case.mesh_words(doc)
    write_result(doc, run_dir / "result.json")
    return doc
