"""Phase 2 land8/land15: Project <-> web sibling JSON mirrors (v15).

land15: split god-module into owned converters + ops; public import path unchanged.

`web_adapter` re-exports these `to_web_*` / `from_web_*` helpers so project_cli
can write Project then regenerate sibling mirrors.
"""
from __future__ import annotations

from cfddesk.project.web_mirrors._common import WEB_SIBLING_RELS
from cfddesk.project.web_mirrors.bcs import (
    from_web_boundary_conditions,
    to_web_boundary_conditions,
)
from cfddesk.project.web_mirrors.controls import (
    from_web_result_controls,
    from_web_simulation_control,
    to_web_result_controls,
    to_web_simulation_control,
)
from cfddesk.project.web_mirrors.materials import from_web_materials, to_web_materials
from cfddesk.project.web_mirrors.mesh import (
    from_web_mesh,
    from_web_mesh_refinements,
    to_web_mesh,
    to_web_mesh_refinements,
)
from cfddesk.project.web_mirrors.ops import (
    apply_web_sibling_to_project,
    ingest_web_siblings_if_newer,
    is_python_project_doc,
    load_or_synthesize_project,
    mark_web_mirrors_derived,
    project_updated_at,
    regenerate_web_mirrors,
    sibling_updated_at,
)
from cfddesk.project.web_mirrors.simulations import (
    from_web_runs_catalog,
    from_web_simulations,
    to_web_runs_catalog,
    to_web_simulations,
)

__all__ = [
    "WEB_SIBLING_RELS",
    "apply_web_sibling_to_project",
    "from_web_boundary_conditions",
    "from_web_materials",
    "from_web_mesh",
    "from_web_mesh_refinements",
    "from_web_result_controls",
    "from_web_runs_catalog",
    "from_web_simulation_control",
    "from_web_simulations",
    "ingest_web_siblings_if_newer",
    "is_python_project_doc",
    "load_or_synthesize_project",
    "mark_web_mirrors_derived",
    "project_updated_at",
    "regenerate_web_mirrors",
    "sibling_updated_at",
    "to_web_boundary_conditions",
    "to_web_materials",
    "to_web_mesh",
    "to_web_mesh_refinements",
    "to_web_result_controls",
    "to_web_runs_catalog",
    "to_web_simulation_control",
    "to_web_simulations",
]
