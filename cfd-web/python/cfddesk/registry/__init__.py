"""cfddesk.registry — plugin registry core (Phase 2 land1)."""

from __future__ import annotations

from cfddesk.registry.base import Registry, RegistryError, Spec
from cfddesk.registry.discovery import (
    RegistryHub,
    get_hub,
    get_registry,
    load_all,
    reset_for_tests,
)
from cfddesk.registry.manifest import PluginManifest, UiManifest
from cfddesk.registry.requirements import Missing, Requirement, check_requirements
from cfddesk.registry.schema import SchemaField, to_json_schema, validate

__all__ = [
    "Registry",
    "RegistryError",
    "RegistryHub",
    "Spec",
    "SchemaField",
    "to_json_schema",
    "validate",
    "PluginManifest",
    "UiManifest",
    "Requirement",
    "Missing",
    "check_requirements",
    "get_registry",
    "get_hub",
    "load_all",
    "reset_for_tests",
]
