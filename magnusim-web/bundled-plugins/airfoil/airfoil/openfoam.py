"""OpenFOAM 2D runs of a study: writing a case, recording it, reading its result, its polar.

One run is one angle of attack: a case folder ``studies/<sid>/openfoam/run-<n>-a<α>``
(the mesh, the dictionaries and ``case.json``, written by the ``openfoam_2d`` job),
which the workspace queues with ``ws.compute.submitOpenFOAM``. The study's
``results/openfoam.json`` keeps every run::

    {"engine": "openfoam", "runs": [{case_rel, alpha, name, airfoil, conditions, level,
      cells, compute_id, status, error, code, written_at, finished_at,
      cl, cd, cm, cl_cd, cl_change, iterations, averaged, steady, residuals}, ...]}

``status`` is the host's (``queued``, ``running``, ``done``, ``failed``,
``stopped``, ``lost``); the coefficients are there once a run is ``done``. A
run that failed or was stopped stays listed with its reason: nothing is
dropped. The polar of the current inputs is the latest finished run at each
angle among those of the same section, Reynolds number and mesh level.
"""

from __future__ import annotations

import datetime as _dt
import json
import re
from typing import Any

from magnusim_sdk.data import PluginData

from airfoil import cmesh, foamcase, store

# SPDX-License-Identifier: GPL-3.0-or-later

CASES = "openfoam"
CASE_META = "case.json"
FINAL = ("done", "failed", "stopped", "lost")
_RUN_DIR = re.compile(r"^run-(\d+)-a")


class RunError(ValueError):
    """A run that cannot be written, recorded or read (the message says why)."""


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def alpha_tag(alpha: float) -> str:
    """An angle as a case folder writes it: "4", "-2", "2.5"."""
    text = f"{round(float(alpha), 3):.3f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def case_rel(n: int, alpha: float) -> str:
    return f"{CASES}/run-{int(n)}-a{alpha_tag(alpha)}"


def study_rel(sid: str, rel: str) -> str:
    return f"studies/{store.study_id(sid)}/{rel}"


def check_case_rel(rel: Any) -> str:
    """A run's folder as the workspace names it (``openfoam/run-<n>-a<α>``), or RunError."""
    text = str(rel or "")
    parts = text.split("/")
    if len(parts) != 2 or parts[0] != CASES or not re.fullmatch(r"run-\d{1,6}-a-?\d{1,3}(\.\d{1,3})?", parts[1]):
        raise RunError(f"Not an OpenFOAM run of this study: {text!r}.")
    return text


def next_case_rel(data: PluginData, sid: str, alpha: float) -> str:
    """The next run's folder: one past the highest run number in the study's ``openfoam`` folder."""
    highest = 0
    for info in data.list_files(study_rel(sid, CASES)):
        parts = info["rel"].split("/")
        if len(parts) > 3:
            m = _RUN_DIR.match(parts[3])
            if m:
                highest = max(highest, int(m.group(1)))
    for run in runs(read(data, sid)):
        m = _RUN_DIR.match(str(run.get("case_rel", "")).split("/")[-1])
        if m:
            highest = max(highest, int(m.group(1)))
    return case_rel(highest + 1, alpha)


def write_case(
    data: PluginData,
    sid: str,
    *,
    name: str,
    x: list[float],
    y: list[float],
    airfoil: dict[str, Any],
    conditions: dict[str, Any],
    alpha: float,
    level: str,
    gmsh: Any,
    on_stage: Any = None,
) -> dict[str, Any]:
    """Mesh the section and write the case of one angle; returns its ``case.json``.

    ``gmsh`` is the module, initialised by the caller (``initialize_gmsh``).
    """
    if level not in cmesh.LEVELS:
        raise RunError(f"Unknown mesh level {level!r}: use coarse, medium or fine.")
    lv = cmesh.LEVELS[level]
    re_ = float(conditions["re"])
    files = foamcase.case_files(re_, alpha, lv.iterations)  # checks Re and α first
    rel = next_case_rel(data, sid, alpha)
    if on_stage:
        on_stage("mesh", f"Meshing {name}: {lv.label.lower()} C-mesh")
    plane = cmesh.build(x, y, cmesh.MeshSpec(lv, re_), gmsh)
    if on_stage:
        on_stage("write", f"Writing the case ({plane['cells']:,} cells)".replace(",", " "))
    with data.atomic_path(study_rel(sid, f"{rel}/{foamcase.MSH_FILE}")) as tmp:
        cmesh.write_msh(tmp, plane, foamcase.SPAN)
    for path, text in files.items():
        data.write_bytes(study_rel(sid, f"{rel}/{path}"), text.encode("ascii"))
    flow = foamcase.flow(re_, alpha)
    meta = {
        "case_rel": rel,
        "alpha": round(float(alpha), 3),
        "name": name,
        "airfoil": airfoil,
        "conditions": conditions,
        "level": level,
        "cells": plane["cells"],
        "first_cell": plane["h0"],
        "sharp_te": plane["sharp"],
        "speed": flow["speed"],
        "span": foamcase.SPAN,
        "iterations_planned": lv.iterations,
        "model": foamcase.MODEL,
        "written_at": _now(),
        "submit": foamcase.submit_options(rel),
    }
    data.write_bytes(study_rel(sid, f"{rel}/{CASE_META}"), json.dumps(meta, ensure_ascii=False, indent=1).encode("utf-8"))
    return meta


# ---------------------------------------------------------------------------
# The study's record of its runs
# ---------------------------------------------------------------------------


def read(data: PluginData, sid: str) -> dict[str, Any]:
    doc = store.read_result(data, sid, "openfoam")
    if not isinstance(doc, dict) or not isinstance(doc.get("runs"), list):
        return {"engine": "openfoam", "runs": []}
    return doc


def runs(doc: dict[str, Any]) -> list[dict[str, Any]]:
    return [r for r in doc.get("runs") or [] if isinstance(r, dict)]


def _save(data: PluginData, sid: str, doc: dict[str, Any]) -> dict[str, Any]:
    doc = {"engine": "openfoam", "runs": runs(doc)}
    store.write_result(data, sid, "openfoam", doc)
    return doc


def _meta(data: PluginData, sid: str, rel: str) -> dict[str, Any]:
    raw = data.read_bytes(study_rel(sid, f"{rel}/{CASE_META}"))
    if raw is None:
        raise RunError(f"{rel} has no case.json: it was not written by this plugin.")
    try:
        meta = json.loads(raw.decode("utf-8"))
    except ValueError:
        raise RunError(f"{rel}/case.json cannot be read.") from None
    if not isinstance(meta, dict):
        raise RunError(f"{rel}/case.json cannot be read.")
    return meta


def record(data: PluginData, sid: str, rel: Any, compute_id: Any) -> dict[str, Any]:
    """The case was queued (``compute_id`` is the host's id): list it in the study's runs."""
    rel = check_case_rel(rel)
    cid = str(compute_id or "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", cid):
        raise RunError("record needs the host's id of the queued case (compute_id).")
    meta = _meta(data, sid, rel)
    doc = read(data, sid)
    kept = [r for r in runs(doc) if r.get("case_rel") != rel]
    run = {key: meta.get(key) for key in ("case_rel", "alpha", "name", "airfoil", "conditions", "level", "cells", "written_at")}
    run.update(compute_id=cid, status="queued", error="", code="")
    kept.append(run)
    return _save(data, sid, {"runs": kept})


def collect(data: PluginData, sid: str, rel: Any, status: Any, error: Any = "", code: Any = "") -> dict[str, Any]:
    """The case ended (``status`` from the host's ``end`` event): read its coefficients when it is done."""
    rel = check_case_rel(rel)
    status = str(status or "")
    if status not in FINAL:
        raise RunError(f"collect needs how the case ended ({', '.join(FINAL)}), not {status!r}.")
    doc = read(data, sid)
    found = [r for r in runs(doc) if r.get("case_rel") == rel]
    run = found[-1] if found else None
    if run is None:
        meta = _meta(data, sid, rel)
        run = {key: meta.get(key) for key in ("case_rel", "alpha", "name", "airfoil", "conditions", "level", "cells", "written_at")}
        doc["runs"] = [*runs(doc), run]
    run.update(status=status, error=str(error or ""), code=str(code or ""), finished_at=_now())
    for key in ("cl", "cd", "cm", "cl_cd", "cl_change", "iterations", "steady", "residuals", "residuals_met", "averaged"):
        run.pop(key, None)
    if status == "done":
        raw = data.read_bytes(study_rel(sid, f"{rel}/{foamcase.COEFFICIENTS_REL}"))
        log = data.read_bytes(study_rel(sid, f"{rel}/{foamcase.SOLVER_LOG}"))
        try:
            rows = foamcase.parse_coefficients(raw.decode("utf-8", "replace") if raw else "")
            run.update(foamcase.summarize(rows, log.decode("utf-8", "replace") if log else ""))
        except foamcase.CaseError as exc:
            run.update(status="failed", error=f"{exc} See {foamcase.SOLVER_LOG} in the case folder.")
    return _save(data, sid, doc)


def delete(data: PluginData, sid: str, rel: Any) -> dict[str, Any]:
    """Remove a run that has ended: its case folder and its line in the study's runs."""
    rel = check_case_rel(rel)
    doc = read(data, sid)
    live = [r for r in runs(doc) if r.get("case_rel") == rel and r.get("status") not in FINAL]
    if live:
        raise RunError("This run is still queued or running. Stop it before deleting it.")
    data.delete_file(study_rel(sid, rel), recursive=True)
    doc["runs"] = [r for r in runs(doc) if r.get("case_rel") != rel]
    return _save(data, sid, doc)


def _same(a: Any, b: Any) -> bool:
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def polar(doc: dict[str, Any], airfoil: dict[str, Any], re: float, level: str) -> list[dict[str, Any]]:
    """The polar of these inputs: the latest finished run at each angle (same section, Re and mesh level)."""
    best: dict[float, dict[str, Any]] = {}
    for run in runs(doc):
        if run.get("status") != "done" or run.get("level") != level or not isinstance(run.get("cl"), (int, float)):
            continue
        if not _same(run.get("airfoil"), airfoil) or float((run.get("conditions") or {}).get("re", -1)) != float(re):
            continue
        alpha = float(run["alpha"])
        if alpha not in best or str(run.get("finished_at", "")) >= str(best[alpha].get("finished_at", "")):
            best[alpha] = run
    return [
        {
            "alpha": a,
            "cl": r["cl"],
            "cd": r["cd"],
            "cm": r["cm"],
            "cl_cd": r.get("cl_cd"),
            "iterations": r.get("iterations"),
            "steady": r.get("steady"),
            "case_rel": r.get("case_rel"),
            "name": r.get("name"),
        }
        for a, r in sorted(best.items())
    ]
