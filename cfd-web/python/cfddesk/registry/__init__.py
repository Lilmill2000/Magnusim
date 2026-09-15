"""cfddesk.registry — plugin registry core (Phase 2)."""

from __future__ import annotations

from cfddesk.registry.analysis import AnalysisType, ResultField, schema_defaults
from cfddesk.registry.base import Registry, RegistryError, Spec
from cfddesk.registry.discovery import (
    RegistryHub,
    get_hub,
    get_registry,
    load_all,
    reset_for_tests,
)
from cfddesk.registry.manifest import PluginManifest
from cfddesk.registry.requirements import Missing, Requirement, check_requirements
from cfddesk.registry.schema import SchemaField, to_json_schema, validate
from cfddesk.registry.solver import SolverBackend, validate_analysis_solver_refs

__all__ = [
    "AnalysisType",
    "ResultField",
    "SolverBackend",
    "validate_analysis_solver_refs",
    "Registry",
    "RegistryError",
    "RegistryHub",
    "Spec",
    "SchemaField",
    "to_json_schema",
    "validate",
    "schema_defaults",
    "PluginManifest",
    "Requirement",
    "Missing",
    "check_requirements",
    "get_registry",
    "get_hub",
    "load_all",
    "reset_for_tests",
]
