"""Plugin manifest dataclass."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from cfddesk.registry.requirements import Requirement


@dataclass
class UiManifest:
    """Optional UI contribution metadata (Phase 3+ consumes this)."""

    menu_label: str = ""
    icon: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class PluginManifest:
    key: str
    name: str
    version: str = "0.0.0"
    requires: list[Requirement] = field(default_factory=list)
    provides: dict[str, list[str]] = field(default_factory=dict)
    ui: UiManifest | None = None
