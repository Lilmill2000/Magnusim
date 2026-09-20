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


def check_requirements(manifest: Any, env: dict[str, Any] | None = None) -> list[Missing]:
    """Return Missing entries for requirements not satisfied by `env`.

    `env` is a plain dict used by tests and callers. Recognized keys:
    - `wsl_tools`: set/list/dict of available tool names
    - `python_packages`: set/list/dict of installed package names
    - `gpu`: bool or dict with `available`
    Real WSL probes are intentionally minimal this land; callers may pass a
    pre-built env from local config.
    """
    env = env or {}
    requires = list(getattr(manifest, "requires", None) or [])
    missing: list[Missing] = []
    wsl_tools = _as_name_set(env.get("wsl_tools"))
    py_pkgs = _as_name_set(env.get("python_packages"))
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
            if req.name not in wsl_tools:
                missing.append(Missing(req, f"wsl tool {req.name!r} not found"))
        elif req.kind == "python":
            if req.name not in py_pkgs:
                missing.append(Missing(req, f"python package {req.name!r} not found"))
        elif req.kind == "gpu":
            if not gpu_ok:
                missing.append(Missing(req, "gpu not available"))
    return missing


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
