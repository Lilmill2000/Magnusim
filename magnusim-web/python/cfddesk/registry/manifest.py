"""Plugin manifest dataclass."""

from __future__ import annotations

from dataclasses import dataclass, field

from cfddesk.registry.requirements import Requirement


@dataclass
class PluginManifest:
    key: str
    name: str
    version: str = "0.0.0"
    requires: list[Requirement] = field(default_factory=list)
    provides: dict[str, list[str]] = field(default_factory=dict)
    ui: str | None = None  # relative dir under the plugin folder, e.g. "ui"
