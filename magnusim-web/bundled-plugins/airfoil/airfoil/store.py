"""Where a study's files live in the plugin's folder of the project.

    studies/<sid>/study.json             the record (the host's; changed only through ws.study)
    studies/<sid>/airfoil.dat            an imported section, checked, in Selig order
    studies/<sid>/results/neuralfoil.json
    studies/<sid>/results/xfoil.json     the polar, the points that did not converge, Cp(x)
    studies/<sid>/results/openfoam.json  every OpenFOAM 2D run (airfoil.openfoam)
    studies/<sid>/openfoam/run-<n>-a<α>/ an OpenFOAM 2D case, as the host ran it

Every result says which settings made it (``airfoil``, ``conditions``), so a page
can tell a result that no longer matches the inputs.
"""

from __future__ import annotations

import json
import re
from typing import Any

from magnusim_sdk.data import PluginData

from airfoil import datfile, naca

# SPDX-License-Identifier: GPL-3.0-or-later

ENGINES = ("neuralfoil", "xfoil", "openfoam")
_STUDY_ID = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$")


class StoreError(ValueError):
    """A study id or file that cannot be used."""


def study_id(raw: Any) -> str:
    sid = str(raw or "")
    if not _STUDY_ID.match(sid):
        raise StoreError("This call needs the study's id (study_id).")
    return sid


def dat_rel(sid: str) -> str:
    return f"studies/{study_id(sid)}/airfoil.dat"


def result_rel(sid: str, engine: str) -> str:
    if engine not in ENGINES:
        raise StoreError(f"Unknown engine {engine!r}.")
    return f"studies/{study_id(sid)}/results/{engine}.json"


def section(data: PluginData | None, sid: str, airfoil: dict[str, Any]) -> tuple[str, list[float], list[float]]:
    """The study's section as (name, x, y) in Selig order (``data`` is needed for an imported one)."""
    if airfoil.get("source") == "naca":
        sec = naca.generate(str(airfoil["code"]), int(airfoil["points_per_side"]), bool(airfoil.get("closed_te")))
        return sec.name, sec.x, sec.y
    if data is None:
        raise StoreError("An imported airfoil is read from the open project.")
    raw = data.read_bytes(dat_rel(sid))
    if raw is None:
        raise StoreError("This study's imported airfoil file is missing. Import the .dat file again.")
    parsed = datfile.parse(raw.decode("utf-8", "replace"))
    return str(airfoil.get("name") or parsed.name), parsed.x, parsed.y


def save_dat(data: PluginData, sid: str, name: str, x: list[float], y: list[float]) -> None:
    data.write_bytes(dat_rel(sid), datfile.write(name, x, y).encode("utf-8"))


def write_result(data: PluginData, sid: str, engine: str, doc: dict[str, Any]) -> None:
    """Save one engine's result (in one step; refused when the study was deleted meanwhile)."""
    text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    data.write_bytes(result_rel(sid, engine), text.encode("utf-8"))


def read_result(data: PluginData, sid: str, engine: str) -> dict[str, Any] | None:
    raw = data.read_bytes(result_rel(sid, engine))
    if raw is None:
        return None
    try:
        doc = json.loads(raw.decode("utf-8"))
    except ValueError:
        return None
    return doc if isinstance(doc, dict) else None


def read_results(data: PluginData, sid: str) -> dict[str, Any]:
    return {engine: read_result(data, sid, engine) for engine in ENGINES}
