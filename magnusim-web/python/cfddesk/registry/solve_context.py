"""What a solve hook is told about the run it watches (API 1.3).

Plugins import :class:`SolveContext` from here. The host builds it from the
run's owner text, ``core:<project_id>/<simulation_id>`` for a core run or
``plugin:<project_id>/<plugin>/<study_id>`` for a plugin's OpenFOAM case, each
id checked. A bad owner is logged once and turns hooks off for that run; it
never fails the run.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Literal

log = logging.getLogger(__name__)

# The same rules as magnusim_sdk.data (plugin keys, study ids).
PLUGIN_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")
STUDY_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
# A core study id (sim-<stamp>-<hex>, and older names such as "aoa-5").
SIMULATION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
# A project folder name: one path part, no control characters.
_PROJECT_BAD = re.compile(r"[/\\\x00-\x1f\x7f]")

OwnerKind = Literal["core", "plugin"]


@dataclass(frozen=True)
class SolveContext:
    """One solve run, as hooks see it. ``owner`` is ``core`` or ``plugin``."""

    owner: OwnerKind
    project_id: str
    simulation_id: str | None
    plugin: str | None
    study_id: str | None
    run_id: str | None
    app: str | None
    case_dir: str | None
    wsl_case: str
    n_procs: int | None


def _project_ok(pid: str) -> bool:
    return bool(pid) and len(pid) <= 200 and pid not in (".", "..") and not _PROJECT_BAD.search(pid)


def parse_owner(owner: str) -> dict[str, str | None] | None:
    """The ids an owner text names, or None when it is not a valid owner."""
    text = str(owner or "")
    kind, sep, rest = text.partition(":")
    if not sep:
        return None
    parts = rest.split("/")
    if kind == "core" and len(parts) == 2:
        pid, sid = parts
        if _project_ok(pid) and SIMULATION_ID_RE.match(sid):
            return {"owner": "core", "project_id": pid, "simulation_id": sid, "plugin": None, "study_id": None}
        return None
    if kind == "plugin" and len(parts) == 3:
        pid, plugin, sid = parts
        if _project_ok(pid) and PLUGIN_KEY_RE.match(plugin) and not plugin.endswith(".") and STUDY_ID_RE.match(sid):
            return {"owner": "plugin", "project_id": pid, "simulation_id": None, "plugin": plugin, "study_id": sid}
        return None
    return None


_SAID_BAD: set[str] = set()


def solve_context(
    owner: str,
    *,
    wsl_case: str,
    run_id: str | None = None,
    app: str | None = None,
    case_dir: str | None = None,
    n_procs: int | None = None,
) -> SolveContext | None:
    """The run's context, or None (logged once per owner text) when the owner is bad."""
    ids = parse_owner(owner)
    if ids is None:
        shown = str(owner or "")[:200]
        if shown not in _SAID_BAD:
            _SAID_BAD.add(shown)
            log.warning("solve hooks are off for this run: %r is not a valid owner", shown)
        return None
    kind: OwnerKind = "core" if ids["owner"] == "core" else "plugin"
    return SolveContext(
        owner=kind,
        project_id=str(ids["project_id"]),
        simulation_id=ids["simulation_id"],
        plugin=ids["plugin"],
        study_id=ids["study_id"],
        run_id=run_id,
        app=app,
        case_dir=case_dir,
        wsl_case=str(wsl_case or ""),
        n_procs=n_procs,
    )
