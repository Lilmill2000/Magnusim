"""Study physics the solve reads: turbulence model and steady SIMPLE numerics.

The study panel saves these keys on the study's record in ``simulations.json``
(``sim.catalog.set``). ``load_run_spec`` reads them here so the written case
matches what the panel shows. Defaults are the values the web writer used
before these settings were wired, so studies that never touched them solve
exactly as before.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

TURBULENCE_MODELS: tuple[str, ...] = ("laminar", "kEpsilon", "kOmegaSST", "LRR", "SSG")
RSM_MODELS: frozenset[str] = frozenset({"LRR", "SSG"})
DEFAULT_TURBULENCE = "kOmegaSST"

# Display names used by V0.1.0 records ("k-omega SST") and loose spellings.
_ALIASES: dict[str, str] = {
    "laminar": "laminar",
    "kepsilon": "kEpsilon",
    "komegasst": "kOmegaSST",
    "sst": "kOmegaSST",
    "lrr": "LRR",
    "ssg": "SSG",
}


def normalize_turbulence(value: Any) -> str | None:
    """Canonical OpenFOAM model name, or None when ``value`` names no known model."""
    key = re.sub(r"[^a-z]", "", str(value or "").lower())
    return _ALIASES.get(key)


def turbulence_fields(model: str) -> tuple[str, ...]:
    """0/ turbulence fields a model reads (U and p are always written)."""
    if model == "laminar":
        return ()
    if model == "kOmegaSST":
        return ("k", "omega", "nut")
    if model in RSM_MODELS:
        return ("k", "epsilon", "R", "nut")
    return ("k", "epsilon", "nut")


def solved_turbulence_fields(model: str) -> tuple[str, ...]:
    """Transport equations the model solves (for solvers, residuals and relaxation)."""
    if model == "kOmegaSST":
        return ("k", "omega")
    if model in RSM_MODELS:
        return ("R", "epsilon")
    if model == "kEpsilon":
        return ("k", "epsilon")
    return ()


@dataclass(frozen=True)
class StudyPhysics:
    turbulence_model: str = DEFAULT_TURBULENCE
    residual_u: float = 1e-4
    residual_p: float = 1e-4
    relax_u: float = 0.7
    relax_p: float = 0.3
    n_non_orthogonal: int = 3


DEFAULT_PHYSICS = StudyPhysics()


def _num(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def physics_from_record(rec: dict[str, Any] | None) -> StudyPhysics:
    """Read panel keys from one study record; bad or missing values keep the default."""
    rec = rec if isinstance(rec, dict) else {}
    defaults = rec.get("defaults") if isinstance(rec.get("defaults"), dict) else {}
    model = (
        normalize_turbulence(rec.get("turbulence_model"))
        or normalize_turbulence(rec.get("turbulence_model_key"))
        or normalize_turbulence(defaults.get("turbulence_model"))
        or DEFAULT_TURBULENCE
    )
    d = DEFAULT_PHYSICS

    def positive(key: str, fallback: float) -> float:
        v = _num(rec.get(key))
        return v if v is not None and v > 0 else fallback

    def fraction(key: str, fallback: float) -> float:
        v = _num(rec.get(key))
        return v if v is not None and 0 < v <= 1 else fallback

    n = _num(rec.get("n_non_orthogonal"))
    n_non_orth = int(n) if n is not None and 0 <= n <= 20 else d.n_non_orthogonal
    return StudyPhysics(
        turbulence_model=model,
        residual_u=positive("residual_u", d.residual_u),
        residual_p=positive("residual_p", d.residual_p),
        relax_u=fraction("relax_u", d.relax_u),
        relax_p=fraction("relax_p", d.relax_p),
        n_non_orthogonal=n_non_orth,
    )


def _read(path: Path) -> Any:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None


def study_record(project_dir: Path, sim_id: str | None) -> dict[str, Any] | None:
    """The study's record: its ``simulations.json`` entry, else a matching ``simulation.json``."""
    root = Path(project_dir)
    catalog = _read(root / "simulations.json")
    if isinstance(catalog, dict) and isinstance(catalog.get("simulations"), list):
        want = sim_id or catalog.get("active_id")
        for rec in catalog["simulations"]:
            if isinstance(rec, dict) and want and str(rec.get("id")) == str(want):
                return rec
    single = _read(root / "simulation.json")
    if isinstance(single, dict) and (not sim_id or str(single.get("id") or "") == str(sim_id)):
        return single
    return None


def load_study_physics(project_dir: Path, sim_id: str | None) -> StudyPhysics:
    return physics_from_record(study_record(project_dir, sim_id))
