"""cfddesk.registry ? plugin registry core (Phase 2)."""

from __future__ import annotations

from typing import Any

from cfddesk.registry.analysis import AnalysisType, ResultField, schema_defaults
from cfddesk.registry.base import Registry, RegistryError, Spec
from cfddesk.registry.bc import validate_analysis_bc_refs
from cfddesk.registry.discovery import (
    RegistryHub,
    get_hub,
    get_registry,
    load_all,
    reset_for_tests,
)
from cfddesk.registry.manifest import PluginManifest
from cfddesk.registry.material import MaterialModel, validate_analysis_material_refs
from cfddesk.registry.mesher import MeshBackend, analysis_has_mesh_bags, validate_multi_region_meshing
from cfddesk.registry.monitor import MonitorType, validate_analysis_monitor_refs
from cfddesk.registry.result_filter import ResultFilterType, analysis_has_filter_bags
from cfddesk.registry.requirements import Missing, Requirement, check_requirements
from cfddesk.registry.schema import SchemaField, to_json_schema, validate
from cfddesk.registry.solver import SolverApp, validate_analysis_solver_refs

__all__ = [
    "AnalysisType",
    "ResultField",
    "SolverApp",
    "validate_analysis_solver_refs",
    "MeshBackend",
    "analysis_has_mesh_bags",
    "validate_multi_region_meshing",
    "BcTypeSpec",
    "validate_analysis_bc_refs",
    "MaterialModel",
    "validate_analysis_material_refs",
    "MonitorType",
    "validate_analysis_monitor_refs",
    "ResultFilterType",
    "analysis_has_filter_bags",
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


def __getattr__(name: str) -> Any:
    """Lazy BcTypeSpec ? avoids circular import with case.bc_registry."""
    if name == "BcTypeSpec":
        from cfddesk.case.bc_registry import BcTypeSpec

        return BcTypeSpec
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
