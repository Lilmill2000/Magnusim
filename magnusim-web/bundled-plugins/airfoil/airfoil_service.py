"""The Airfoil plugin's service: its backend, in the plugin's own environment.

The workspace reaches these methods with ``ws.service(name, params)``. Methods
that read or write a study's files take ``study_id``.

- ``defaults``: the settings a new study starts from.
- ``check``: ``{airfoil, conditions}`` checked, defaults filled in, and the
  section's coordinates and measures (the preview); errors are the answer's
  ``error`` (the message for the field) and ``field`` (its key, or null when no
  one field is to blame), never an exception.
- ``import_dat``: ``{study_id, text, filename}``: reads and checks a .dat file,
  saves it as the study's ``airfoil.dat`` and answers the airfoil block to store
  in the study, the section and what was changed on the way.
- ``warmup``: imports NeuralFoil and runs one point (the workspace calls it as it opens).
- ``neuralfoil_polar``: ``{study_id, airfoil, conditions, model_size?}``: the polar,
  saved as ``results/neuralfoil.json``.
- ``results``: ``{study_id}``: the saved results of every engine.
- ``xfoil_status``: whether the shipped XFOIL can run here, and why not when it cannot.
- ``openfoam_info``: the OpenFOAM 2D engine's mesh levels, Reynolds number range and model,
  and whether its mesher (Gmsh) is installed (``ready``, else ``reason``).
- ``openfoam_record``: ``{study_id, case_rel, compute_id}``: a case the workspace
  queued (written by the ``openfoam_2d`` job) joins the study's runs.
- ``openfoam_collect``: ``{study_id, case_rel, status, error?, code?}``: a case ended;
  its coefficients are read when it is done. Answers the runs.
- ``openfoam_delete``: ``{study_id, case_rel}``: a run that ended goes, case folder and all.
- ``openfoam_polar``: ``{study_id, airfoil, conditions, level}``: the polar of these inputs.
- ``export_csv``: ``{study_id}``: every saved polar as CSV text and a file name.
- ``export_dat``: ``{study_id, airfoil}``: the section as a Selig .dat file's text and a file name.
- ``migrate_study``: the host's upgrade of an older study record.
"""

from __future__ import annotations

import datetime as _dt
import importlib.util
import time
from typing import Any

from magnusim_sdk.data import PluginData
from magnusim_sdk.service import method

from airfoil import (
    cmesh,
    datfile,
    export,
    foamcase,
    geometry,
    naca,
    neural,
    openfoam,
    settings,
    store,
    xfoil,
)

# SPDX-License-Identifier: GPL-3.0-or-later


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def _data(scope: dict[str, Any]) -> PluginData:
    return PluginData.from_scope(scope)


def _preview(name: str, x: list[float], y: list[float]) -> dict[str, Any]:
    m = geometry.measures(x, y)
    return {
        "name": name,
        "x": x,
        "y": y,
        "points": len(x),
        "thickness": round(m["thickness"], 6),
        "thickness_at": round(m["thickness_at"], 4),
        "camber": round(m["camber"], 6),
        "camber_at": round(m["camber_at"], 4),
        "te_gap": round(m["te_gap"], 6),
    }


@method("defaults")
def defaults(params: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any]:
    return settings.defaults()


@method("check")
def check(params: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any]:
    try:
        airfoil = settings.normalize_airfoil(params.get("airfoil") or settings.DEFAULT_AIRFOIL)
        conditions = settings.normalize_conditions(params.get("conditions") or settings.DEFAULT_CONDITIONS)
    except settings.SettingsError as exc:
        return {"ok": False, "error": str(exc), "field": exc.field}
    try:
        if airfoil["source"] == "dat":
            sid = store.study_id(params.get("study_id"))
            name, x, y = store.section(_data(scope), sid, airfoil)
        else:
            name, x, y = store.section(None, "", airfoil)
    except (store.StoreError, datfile.DatError, naca.NacaError) as exc:
        return {"ok": False, "error": str(exc), "field": None}
    return {
        "ok": True,
        "airfoil": airfoil,
        "conditions": conditions,
        "alphas": settings.alpha_list(conditions),
        "section": _preview(name, x, y),
    }


@method("import_dat")
def import_dat(params: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any]:
    sid = store.study_id(params.get("study_id"))
    text = params.get("text")
    if not isinstance(text, str):
        raise ValueError("import_dat needs the file's text.")
    try:
        sec = datfile.parse(text, str(params.get("filename") or ""))
    except datfile.DatError as exc:
        return {"ok": False, "error": str(exc)}
    data = _data(scope)
    store.save_dat(data, sid, sec.name, sec.x, sec.y)
    airfoil = settings.normalize_airfoil({"source": "dat", "name": sec.name})
    return {"ok": True, "airfoil": airfoil, "layout": sec.layout, "warnings": sec.warnings, "section": _preview(sec.name, sec.x, sec.y)}


@method("warmup", timeout_s=180)
def warmup(params: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any]:
    try:
        info = neural.warm()
    except neural.NeuralFoilMissingError as exc:
        return {"ready": False, "error": str(exc)}
    return {"ready": True, **info}


@method("neuralfoil_polar", timeout_s=180)
def neuralfoil_polar(params: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any]:
    sid = store.study_id(params.get("study_id"))
    try:
        airfoil = settings.normalize_airfoil(params.get("airfoil") or settings.DEFAULT_AIRFOIL)
        conditions = settings.normalize_conditions(params.get("conditions") or settings.DEFAULT_CONDITIONS)
    except settings.SettingsError as exc:
        return {"ok": False, "error": str(exc)}
    model = str(params.get("model_size") or neural.DEFAULT_MODEL)
    data = _data(scope)
    try:
        name, x, y = store.section(data, sid, airfoil)
    except (store.StoreError, datfile.DatError, naca.NacaError) as exc:
        return {"ok": False, "error": str(exc)}
    alphas = settings.alpha_list(conditions)
    t0 = time.perf_counter()
    try:
        rows = neural.evaluate(name, x, y, alphas, conditions, model)
    except neural.NeuralFoilMissingError as exc:
        return {"ok": False, "error": str(exc)}
    doc = {
        "engine": "neuralfoil",
        "model_size": model,
        "airfoil": airfoil,
        "name": name,
        "conditions": conditions,
        "alphas": alphas,
        "rows": rows,
        "seconds": round(time.perf_counter() - t0, 4),
        "computed_at": _now(),
        "versions": neural.versions(),
    }
    store.write_result(data, sid, "neuralfoil", doc)
    return {"ok": True, **doc}


@method("results")
def results(params: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any]:
    sid = store.study_id(params.get("study_id"))
    return store.read_results(_data(scope), sid)


@method("xfoil_status")
def xfoil_status(params: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any]:
    reason = xfoil.unavailable_reason()
    if reason is None:
        return {"available": True}
    return {"available": False, "reason": reason}


@method("openfoam_info")
def openfoam_info(params: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any]:
    # The openfoam_2d job meshes with Gmsh, from this same environment.
    ready = importlib.util.find_spec("gmsh") is not None
    return {
        "ready": ready,
        "reason": "" if ready else "Gmsh is not installed in the Airfoil plugin's environment. Open Settings → Plugins and click Install dependencies.",
        "levels": [{"value": lv.key, "label": lv.label, "iterations": lv.iterations} for lv in cmesh.LEVELS.values()],
        "default_level": cmesh.DEFAULT_LEVEL,
        "re_range": list(foamcase.RE_RANGE),
        "re_reason": foamcase.reynolds_reason(),
        "alpha_range": list(foamcase.ALPHA_RANGE),
        "model": foamcase.MODEL,
        "app": foamcase.APP,
    }


def _runs_answer(doc: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "runs": openfoam.runs(doc)}


@method("openfoam_record")
def openfoam_record(params: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any]:
    sid = store.study_id(params.get("study_id"))
    try:
        doc = openfoam.record(_data(scope), sid, params.get("case_rel"), params.get("compute_id"))
    except openfoam.RunError as exc:
        return {"ok": False, "error": str(exc)}
    return _runs_answer(doc)


@method("openfoam_collect")
def openfoam_collect(params: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any]:
    sid = store.study_id(params.get("study_id"))
    try:
        doc = openfoam.collect(_data(scope), sid, params.get("case_rel"), params.get("status"), params.get("error"), params.get("code"))
    except openfoam.RunError as exc:
        return {"ok": False, "error": str(exc)}
    return _runs_answer(doc)


@method("openfoam_delete")
def openfoam_delete(params: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any]:
    sid = store.study_id(params.get("study_id"))
    try:
        doc = openfoam.delete(_data(scope), sid, params.get("case_rel"))
    except openfoam.RunError as exc:
        return {"ok": False, "error": str(exc)}
    return _runs_answer(doc)


@method("openfoam_polar")
def openfoam_polar(params: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any]:
    sid = store.study_id(params.get("study_id"))
    try:
        airfoil = settings.normalize_airfoil(params.get("airfoil") or settings.DEFAULT_AIRFOIL)
        conditions = settings.normalize_conditions(params.get("conditions") or settings.DEFAULT_CONDITIONS)
    except settings.SettingsError as exc:
        return {"ok": False, "error": str(exc)}
    level = str(params.get("level") or cmesh.DEFAULT_LEVEL)
    rows = openfoam.polar(openfoam.read(_data(scope), sid), airfoil, conditions["re"], level)
    return {"ok": True, "rows": rows, "level": level}


@method("export_csv")
def export_csv(params: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any]:
    sid = store.study_id(params.get("study_id"))
    saved = store.read_results(_data(scope), sid)
    if not export.has_polar(saved):
        return {"ok": False, "error": "No polar to export yet."}
    names = [d.get("name") for d in saved.values() if isinstance(d, dict) and d.get("name")]
    stem = export.file_stem(str(names[0])) if len(set(names)) == 1 else "Airfoil"
    return {"ok": True, "filename": f"{stem} polar.csv", "text": export.polar_csv(saved)}


@method("export_dat")
def export_dat(params: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any]:
    sid = store.study_id(params.get("study_id"))
    try:
        airfoil = settings.normalize_airfoil(params.get("airfoil") or settings.DEFAULT_AIRFOIL)
        name, x, y = store.section(_data(scope), sid, airfoil)
    except (settings.SettingsError, store.StoreError, datfile.DatError, naca.NacaError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "filename": f"{export.file_stem(name)}.dat", "text": export.section_dat(name, x, y)}


@method("migrate_study")
def migrate_study(params: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any]:
    study = params.get("study")
    if not isinstance(study, dict):
        raise ValueError("migrate_study needs the study record.")
    return settings.migrate(study, int(params.get("from_version") or 0), int(params.get("to_version") or settings.SCHEMA_VERSION))
