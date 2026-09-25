"""JobKind specs. Plugin tool paths must stay inside the plugin package."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from cfddesk.registry.base import RegistryError

JobScope = Literal["project", "geometry", "study"]


@dataclass(frozen=True)
class JobKind:
    """A host job. ``tool`` is a script name or a path inside a plugin package."""

    key: str
    tool: str
    scope: JobScope
    args_from_params: tuple[str, ...] = ()


def ensure_tool_in_package(tool: str, package_dir: Path) -> None:
    """Refuse a plugin tool path that resolves outside ``package_dir``."""
    text = str(tool or "").strip()
    if not text:
        raise RegistryError("JobKind tool is empty")
    normalized = text.replace("\\", "/")
    if "/" not in normalized and ".." not in normalized:
        return
    root = package_dir.resolve()
    candidate = Path(text)
    resolved = candidate.resolve() if candidate.is_absolute() else (root / candidate).resolve()
    if resolved != root and root not in resolved.parents:
        raise RegistryError(f"JobKind tool {text!r} is outside the plugin package")
