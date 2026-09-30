"""Plugin requirement declarations and environment checks."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

RequirementKind = Literal["wsl_tool", "python", "gpu"]


@dataclass(frozen=True)
class Requirement:
    kind: RequirementKind
    name: str
    version_spec: str = ""


@dataclass(frozen=True)
class Missing:
    requirement: Requirement
    reason: str
    # False for what is only reported (a GPU): the plugin still runs.
    blocking: bool = True


def check_requirements(manifest: Any, env: dict[str, Any] | None = None) -> list[Missing]:
    """Return Missing entries for requirements not satisfied by `env`.

    `env` keys (a key left out means none available):
    - `wsl_tools`: names of the programs the WSL toolchain has; None while it
      has not been probed (then no wsl_tool requirement is reported)
    - `python_packages`: packages installed in the plugin's own environment
    - `gpu`: bool or dict with `available`; a missing GPU is only reported
      (``blocking=False``)

    ``plugin_catalog`` passes the real ones (a cached WSL probe, the
    environment's ready stamp).
    """
    env = env or {}
    requires = list(getattr(manifest, "requires", None) or [])
    missing: list[Missing] = []
    wsl_unknown = "wsl_tools" in env and env.get("wsl_tools") is None
    wsl_tools = _as_name_set(env.get("wsl_tools"))
    py_pkgs = {_dist_name(n) for n in _as_name_set(env.get("python_packages"))}
    gpu_ok = _gpu_available(env.get("gpu"))

    for req in requires:
        if not isinstance(req, Requirement):
            # accept dict-like
            if isinstance(req, dict):
                req = Requirement(
                    kind=req.get("kind", "wsl_tool"),
                    name=str(req.get("name", "")),
                    version_spec=str(req.get("version_spec", "") or ""),
                )
            else:
                continue
        if req.kind == "wsl_tool":
            if not wsl_unknown and req.name not in wsl_tools:
                missing.append(Missing(req, f"wsl tool {req.name!r} not found"))
        elif req.kind == "python":
            if _dist_name(req.name) not in py_pkgs:
                missing.append(Missing(req, f"python package {req.name!r} not found"))
        elif req.kind == "gpu":
            if not gpu_ok:
                missing.append(Missing(req, "no GPU found (the plugin runs without one)", blocking=False))
    return missing


def _dist_name(name: str) -> str:
    """Package names compare the way pip does: case and ``-_.`` runs ignored."""
    import re

    return re.sub(r"[-_.]+", "-", str(name or "")).lower()


def _as_name_set(value: Any) -> set[str]:
    if value is None:
        return set()
    if isinstance(value, dict):
        return {str(k) for k, v in value.items() if v}
    if isinstance(value, (set, list, tuple, frozenset)):
        return {str(x) for x in value}
    return {str(value)}


def _gpu_available(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, dict):
        return bool(value.get("available", value.get("gpu", False)))
    return bool(value)
