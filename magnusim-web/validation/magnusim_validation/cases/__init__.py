"""The validation cases, by id. Each module holds its geometry, its requests (study, fluid,
BCs, mesh per variant, run, what to read), its references and tolerances, and its
extraction and figures."""

from __future__ import annotations

from types import ModuleType

from . import c1_laminar_pipe, c2_turbulent_pipe, c3_lid_cavity, c4_backward_step

CASES: dict[str, ModuleType] = {m.ID: m for m in (c1_laminar_pipe, c2_turbulent_pipe, c3_lid_cavity, c4_backward_step)}
# Short names the command line takes ("c1" for "c1_laminar_pipe").
ALIASES: dict[str, str] = {cid.split("_", 1)[0]: cid for cid in CASES}


def get(name: str) -> ModuleType:
    cid = ALIASES.get(name, name)
    if cid not in CASES:
        raise KeyError(f"no case {name!r} (have: {', '.join(CASES)})")
    return CASES[cid]
