"""The pre-run check's inputs (run health, RH2): what the core gathers before a run's
analysis checks it (contract API 1.9 ``RunModel.check``).

The analysis gets what its preview gets (:func:`cfddesk.project.run_inputs.gather_run_inputs`,
the run's settings with any proposed change) and ``context``:

- ``mesh`` and ``rates``: the mesh's facts (``mesh-facts.json``) and Courant-rate table
  (``courant-rates.json``) beside it (:mod:`magnusim_sdk.mesh_facts`);
- ``ranks``: the ranks the run would get, by the rule the Start uses (Node's ``runRanks``:
  the run's Cores, else serial below the analysis's ``serial_below_cells``, else every
  rank this PC allows);
- ``s_per_cell_step`` and ``rate_source``: this PC's solve rate (Node passes it; without it,
  the machine settings' own samples, :func:`magnusim_sdk.run_estimate.pc_solve_rate`);
- ``kept``: the codes kept as set (the run's ``checks_kept``).

:func:`run_check` answers ``{checks, estimate, numerics, earlier, ranks, ...}`` for the precheck route
(RH3: ``numerics`` is "Numerics as written", from the run's ``numerics_used`` once it has one),
reading files only, except that a mesh made before mesh facts existed gets them made once
(``build``), as a mesher would have.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# The rule Node's runRanks uses for an analysis that names no serial threshold (API 1.4).
LEGACY_SERIAL_BELOW_CELLS = {"steady": 200_000, "transient": 50_000}
# The codes a run keeps as set: at most this many, each at most 40 characters.
KEPT_MAX = 32
# ``cores`` when the caller gives none: the run's saved Cores. A given ``None`` is Auto, as
# the panel shows it while its save is still on its way (Node always sends the value).
SAVED_CORES = "saved"


def check_ranks(
    n_cells: Any,
    *,
    cores: Any = None,
    rank_cap: Any = None,
    serial_below_cells: Any = None,
    parallel: Any = True,
    transient: bool = False,
) -> int:
    """The ranks a run gets (scripts/w27-solve.js runRanks): its Cores (1 = serial; a launch
    that is not parallel stays serial), at most ``rank_cap`` (this PC's physical cores and
    the WSL slots Settings saved); else serial below the analysis's threshold, else
    ``rank_cap``."""
    cap = max(1, int(rank_cap)) if isinstance(rank_cap, (int, float)) and rank_cap >= 1 else 1
    if isinstance(cores, (int, float)) and not isinstance(cores, bool) and int(cores) >= 1 and float(cores) == int(cores):
        if parallel is False or int(cores) == 1:
            return 1
        return max(1, min(cap, int(cores)))
    below = serial_below_cells
    if not isinstance(below, (int, float)) or isinstance(below, bool):
        below = LEGACY_SERIAL_BELOW_CELLS["transient" if transient else "steady"]
    try:
        cells = int(n_cells or 0)
    except (TypeError, ValueError):
        cells = 0
    if parallel is False or (0 < cells < below):
        return 1
    return cap


def _serial_below(launch: Any, transient: bool) -> int | None:
    if launch is None:
        return None
    from cfddesk.registry import contract

    return contract.serial_below_cells(launch, "transient" if transient else "steady")


def kept_codes(run: dict[str, Any] | None) -> list[str]:
    """The run's ``checks_kept``, cleaned."""
    raw = (run or {}).get("checks_kept") if isinstance(run, dict) else None
    out: list[str] = []
    for c in raw if isinstance(raw, list) else []:
        if isinstance(c, str) and c.strip() and c.strip()[:40] not in out:
            out.append(c.strip()[:40])
    return out[:KEPT_MAX]


def _local_rate() -> dict[str, Any]:
    from magnusim_sdk.run_estimate import pc_solve_rate

    from cfddesk.wsl.config import local_json_path

    try:
        doc = json.loads(Path(local_json_path()).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 (no machine settings: the default rate)
        doc = {}
    return pc_solve_rate(doc if isinstance(doc, dict) else {})


def earlier_run(project_dir: Path, simulation_id: str | None, run_id: str) -> dict[str, Any] | None:
    """The study's latest other run with a health verdict: ``{run_id, name, verdict, codes}``."""
    from cfddesk.project.paths import walk_runs

    if not simulation_id:
        return None
    best: tuple[str, dict[str, Any]] | None = None
    for rec in walk_runs(Path(project_dir), simulation_id):
        rid = str(rec.get("id") or "")
        h = rec.get("health")
        if rid == str(run_id) or not isinstance(h, dict) or h.get("verdict") in (None, "pending"):
            continue
        when = str(rec.get("finished_at") or rec.get("started_at") or "")
        if best is None or when > best[0]:
            best = (when, rec)
    if best is None:
        return None
    rec = best[1]
    h = rec["health"]
    return {
        "run_id": str(rec.get("id") or ""),
        "name": str(rec.get("name") or "")[:64],
        "verdict": str(h.get("verdict")),
        "codes": [str(f.get("code")) for f in h.get("findings") or [] if isinstance(f, dict) and f.get("code")][:6],
    }


def check_context(
    inputs: Any,
    *,
    launch: Any = None,
    cores: Any = SAVED_CORES,
    rank_cap: Any = None,
    s_per_cell_step: Any = None,
    rate_source: str | None = None,
    build: bool = False,
) -> dict[str, Any]:
    """What the core adds to a run's inputs for its check (module docstring)."""
    from magnusim_sdk.courant_rates import read_rates
    from magnusim_sdk.mesh_facts import load_mesh_facts

    mesh = inputs.mesh if isinstance(getattr(inputs, "mesh", None), dict) else {}
    ready = bool(mesh.get("ok"))
    case = mesh.get("case_dir") if ready else None
    facts = load_mesh_facts(case, build=build) if case else None
    rates = read_rates(case) if case else None
    n_cells = mesh.get("n_cells") or (facts or {}).get("n_cells")
    transient = getattr(inputs, "time_dependency", "steady") == "transient"
    run = getattr(inputs, "run", None) or {}
    use_cores = run.get("cores") if cores == SAVED_CORES else cores
    ranks = check_ranks(
        n_cells,
        cores=use_cores,
        rank_cap=rank_cap,
        serial_below_cells=_serial_below(launch, transient),
        parallel=getattr(launch, "parallel", True) if launch is not None else True,
        transient=transient,
    )
    rate = _local_rate() if s_per_cell_step is None else {"s_per_cell_step": float(s_per_cell_step), "source": rate_source or "measured"}
    return {
        "mesh": facts,
        "mesh_ready": ready,
        "rates": rates,
        "n_cells": n_cells,
        "ranks": ranks,
        "s_per_cell_step": rate.get("s_per_cell_step"),
        "rate_source": rate.get("source") or "default",
        "kept": kept_codes(run),
    }


def run_check(
    project_dir: str | Path,
    *,
    run_id: str,
    simulation_id: str | None = None,
    mesh_id: str | None = None,
    time_dependency: str | None = None,
    settings: dict[str, Any] | None = None,
    cores: Any = SAVED_CORES,
    rank_cap: Any = None,
    s_per_cell_step: Any = None,
    rate_source: str | None = None,
    analysis_key: str = "",
) -> dict[str, Any]:
    """The pre-run check of a run with ``settings`` (its own, with proposed changes over
    them): ``{ok, analysis_key, checked, checks, estimate, earlier, ranks, n_cells,
    mesh_ready}``."""
    from cfddesk.project.run_inputs import gather_run_inputs
    from cfddesk.registry import contract
    from cfddesk.registry.discovery import get_registry

    root = Path(project_dir)
    spec = get_registry("analysis").get(analysis_key)
    transient = spec.time_dependency == "transient"
    raw = settings if isinstance(settings, dict) else {}
    inputs = gather_run_inputs(
        root,
        run_id=run_id or "precheck",
        mesh_id=mesh_id or None,
        simulation_id=simulation_id or None,
        require_mesh=True,
        transient_override=raw if transient else None,
        time_dependency=spec.time_dependency,
    )
    inputs = with_numerics_used(inputs)
    launch = None
    try:
        launch = contract.launch_spec(spec, get_registry("solver"), inputs=inputs)
    except Exception:  # noqa: BLE001 (no launch spec: the rule before API 1.5)
        launch = None
    context = check_context(
        inputs,
        launch=launch,
        cores=cores,
        rank_cap=rank_cap,
        s_per_cell_step=s_per_cell_step,
        rate_source=rate_source,
        build=True,
    )
    out = contract.run_check(spec, inputs=inputs, settings=raw, context=context)
    return {
        "ok": True,
        "analysis_key": analysis_key,
        **out,
        "earlier": earlier_run(root, simulation_id, run_id),
        "ranks": context["ranks"],
        "n_cells": context["n_cells"],
        "mesh_ready": context["mesh_ready"],
        "mesh": _mesh_summary(context["mesh"]),
        "kept": context["kept"],
    }


def with_numerics_used(inputs: Any) -> Any:
    """A started run's inputs with the numerics it started with (RH3: ``run.numerics_used``,
    ``{analysis, mode, at, values}``) in place of the study's, so "Numerics as written" shows
    what its case was written with; a draft, or a run started before RH3 (none recorded),
    reads the study's."""
    import dataclasses

    run = getattr(inputs, "run", None)
    used = run.get("numerics_used") if isinstance(run, dict) else None
    values = used.get("values") if isinstance(used, dict) else None
    if not isinstance(values, dict):
        return inputs
    study = dict(getattr(inputs, "study", None) or {})
    for key, value in values.items():
        if value is None:
            study.pop(str(key), None)
        else:
            study[str(key)] = value
    return dataclasses.replace(inputs, study=study)


def _mesh_summary(facts: dict[str, Any] | None) -> dict[str, Any] | None:
    """The mesh as the precheck answer names it: its cells and worst cells."""
    if not isinstance(facts, dict):
        return None
    raw = facts.get("quality")
    q: dict[str, Any] = raw if isinstance(raw, dict) else {}
    return {
        "cells": facts.get("n_cells"),
        "max_non_orthogonality": q.get("max_non_orthogonality"),
        "max_skewness": q.get("max_skewness"),
        "max_aspect_ratio": q.get("max_aspect_ratio"),
    }
