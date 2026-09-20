"""OpenFOAM case writers: UI/prepare_run (write_solve_case) and CLI/AmgX (write_simplefoam_case).

``write_solve_case`` is the product path (js_steady / js_transient goldens).
``write_simplefoam_case`` stays for CLI/AmgX goldens in this same module.
``write_web_solve_case`` is an alias of ``write_solve_case``.
"""

from __future__ import annotations

import json
import math
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from cfddesk.case.bc_registry import get_type
from cfddesk.case.ras import (
    DEFAULT_HYDRAULIC_DIAMETER_M,
    TurbulenceModel,
    fv_solution_turbulence_block,
    write_ras_fields,
)
from cfddesk.case.ras import (
    write_turbulence_properties as write_turbulence_properties_model,
)
from cfddesk.materials.library import NU_AIR
from cfddesk.mesh.case_writer import _foam_header, _write_foam
from cfddesk.units.pressure import pa_to_kinematic

# Runtime imports stay lazy; static analysis sees the real exported types.
if TYPE_CHECKING:
    from cfddesk.cad.step import LoadedSolid
    from cfddesk.case.function_objects import js_to_precision, monitors_functions_text
    from cfddesk.project.model import Project
    from cfddesk.project.transient import TransientControl
    from cfddesk.project.web_adapter import (
        FaceProps,
        RunSpec,
        WebBc,
        bc_faces,
        is_pressure_bc,
        is_velocity_inlet,
        is_velocity_outlet,
        is_wall_bc,
        wall_treatment,
    )

# Re-export library constant for gate scripts that import NU_AIR from writer.
__all_nu__ = NU_AIR

_PRESSURE_KEYS = (
    "gauge_pressure",
    "pressure",
)

# Design inlet (informational / A5 caveats). A4 FO gate uses FO_INLET_SPEED.
INLET_U = (-20.0, 0.0, 0.0)
INLET_SPEED = 20.0

# A4 FO gate: laminar-valid converging case (Re ≈ 1700).
FO_INLET_SPEED = 0.5
FO_INLET_U = (-0.5, 0.0, 0.0)
FO_RESIDUAL_TOL = 1e-5
FO_END_TIME = 5000


@dataclass(frozen=True)
class GuardrailReport:
    pRefValue: float
    momentumPredictor: bool
    outlet_fixes_p: bool
    amgx_on_p: bool
    ok: bool
    messages: tuple[str, ...]


def _vec(v: tuple[float, float, float]) -> str:
    return f"({v[0]:g} {v[1]:g} {v[2]:g})"


def _patch_semantics_from_project(project: Project) -> dict[str, str]:
    from cfddesk.case.bc_menu import registry_key_for_bc

    out: dict[str, str] = {}
    for bc in project.boundary_conditions:
        if not bc.face_ids:
            continue
        out[bc.patch_name] = get_type(registry_key_for_bc(bc)).semantic
    return out


def _bc_contexts(
    project: Project,
    solid: LoadedSolid | None,
    *,
    inlet_u_fallback: tuple[float, float, float] | None = None,
) -> dict[str, dict[str, Any]]:
    """Per-patch writer context (e.g. inward_normal for velocity_inlet_fixed)."""
    from cfddesk.cad.normals import inlet_velocity_from_face
    from cfddesk.case.bc_menu import registry_key_for_bc

    contexts: dict[str, dict[str, Any]] = {}
    for bc in project.boundary_conditions:
        if not bc.face_ids:
            continue
        ctx: dict[str, Any] = {}
        if registry_key_for_bc(bc) == "velocity_inlet_fixed":
            mode = str(bc.settings.get("direction_mode", "normal"))
            speed = float(bc.settings.get("speed_m_s", 0.0))
            if mode == "normal" and solid is not None and bc.face_ids:
                face = next(
                    (fr.face for fr in solid.faces if fr.face_id == bc.face_ids[0]),
                    None,
                )
                if face is not None:
                    u = inlet_velocity_from_face(
                        face, speed, project.scale_to_metres
                    )
                    mag = math.sqrt(u[0] ** 2 + u[1] ** 2 + u[2] ** 2) or 1.0
                    ctx["inward_normal"] = (u[0] / mag, u[1] / mag, u[2] / mag)
                elif inlet_u_fallback is not None:
                    u = inlet_u_fallback
                    mag = math.sqrt(u[0] ** 2 + u[1] ** 2 + u[2] ** 2) or 1.0
                    ctx["inward_normal"] = (u[0] / mag, u[1] / mag, u[2] / mag)
            elif mode == "normal" and inlet_u_fallback is not None:
                u = inlet_u_fallback
                mag = math.sqrt(u[0] ** 2 + u[1] ** 2 + u[2] ** 2) or 1.0
                ctx["inward_normal"] = (u[0] / mag, u[1] / mag, u[2] / mag)
        contexts[bc.patch_name] = ctx
    return contexts


def write_transport_properties(path: Path, *, nu: float) -> None:
    """Write constant/transportProperties. ``nu`` is required (no silent air default)."""
    _write_foam(
        path,
        _foam_header("transportProperties")
        + f"""
transportModel  Newtonian;
nu              [0 2 -1 0 0 0 0] {nu:g};

// ************************************************************************* //
""",
    )


def _require_assigned_material(project: Project) -> dict[str, Any]:
    mat = project.assigned_material()
    if mat is None:
        raise RuntimeError(
            "No material assigned to a volume — assign a fluid before writing the case"
        )
    if mat.get("nu") is None:
        raise RuntimeError("Assigned material is missing kinematic viscosity (nu)")
    return mat


def _settings_pa_to_kinematic(settings: dict[str, Any], rho: float) -> dict[str, Any]:
    out = dict(settings)
    for key in _PRESSURE_KEYS:
        if key in out and out[key] is not None:
            out[key] = pa_to_kinematic(float(out[key]), rho)
    return out


def write_turbulence_properties(
    path: Path, model: TurbulenceModel = "laminar"
) -> None:
    write_turbulence_properties_model(path, model)


def write_U(
    path: Path,
    *,
    inlet_u: tuple[float, float, float] | None = None,
    project: Project | None = None,
    solid: LoadedSolid | None = None,
    contexts: dict[str, dict[str, Any]] | None = None,
    internal_u: tuple[float, float, float] | None = None,
) -> None:
    iu = internal_u if internal_u is not None else (0.0, 0.0, 0.0)
    if project is not None:
        from cfddesk.mesh.patches import emit_all_patches

        ctx_map = contexts or _bc_contexts(project, solid, inlet_u_fallback=inlet_u)
        bc_by_id = {bc.id: bc for bc in project.boundary_conditions}
        entries: list[str] = []
        from cfddesk.case.bc_menu import registry_key_for_bc

        for ep in emit_all_patches(project):
            bc = bc_by_id.get(ep.bc_id)
            if bc is None:
                continue
            spec = get_type(registry_key_for_bc(bc))
            if spec.write_U is None:
                continue
            # Context keyed by parent patch name; reuse for extensive _1…N.
            ctx = ctx_map.get(bc.patch_name, {}) or ctx_map.get(ep.name, {})
            entries.append(spec.write_U(ep.name, bc.settings, ctx))
        body = "".join(entries)
        text = f"""FoamFile
{{
    version     2.0;
    format      ascii;
    class       volVectorField;
    object      U;
}}
dimensions      [0 1 -1 0 0 0 0];
internalField   uniform {_vec(iu)};
boundaryField
{{
{body}}}
"""
        _write_foam(path, text)
        return

    u = inlet_u if inlet_u is not None else INLET_U
    text = f"""FoamFile
{{
    version     2.0;
    format      ascii;
    class       volVectorField;
    object      U;
}}
dimensions      [0 1 -1 0 0 0 0];
internalField   uniform {_vec(iu)};
boundaryField
{{
    inlet
    {{
        type            fixedValue;
        value           uniform {_vec(u)};
    }}
    outlet
    {{
        type            zeroGradient;
    }}
    walls
    {{
        type            noSlip;
    }}
}}
"""
    _write_foam(path, text)


def write_p(
    path: Path,
    *,
    outlet_p: float = 0.0,
    project: Project | None = None,
    contexts: dict[str, dict[str, Any]] | None = None,
    density_kg_m3: float | None = None,
    internal_p_kinematic: float | None = None,
) -> None:
    """Write 0/p. Project pressures are Pa; FOAM values are kinematic (÷ρ).

    Legacy path (no project): ``outlet_p`` is already kinematic.
    """
    ip = 0.0 if internal_p_kinematic is None else float(internal_p_kinematic)
    if project is not None:
        from cfddesk.mesh.patches import emit_all_patches

        rho = density_kg_m3
        if rho is None:
            mat = _require_assigned_material(project)
            rho = float(mat["rho"])
        ctx_map = contexts or {}
        from cfddesk.case.bc_menu import registry_key_for_bc

        bc_by_id = {bc.id: bc for bc in project.boundary_conditions}
        entries: list[str] = []
        for ep in emit_all_patches(project):
            bc = bc_by_id.get(ep.bc_id)
            if bc is None:
                continue
            spec = get_type(registry_key_for_bc(bc))
            if spec.write_p is None:
                continue
            foam_settings = _settings_pa_to_kinematic(bc.settings, rho)
            ctx = ctx_map.get(bc.patch_name, {}) or ctx_map.get(ep.name, {})
            entries.append(spec.write_p(ep.name, foam_settings, ctx))
        body = "".join(entries)
        text = f"""FoamFile
{{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      p;
}}
dimensions      [0 2 -2 0 0 0 0];
internalField   uniform {ip:g};
boundaryField
{{
{body}}}
"""
        _write_foam(path, text)
        return

    text = f"""FoamFile
{{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      p;
}}
dimensions      [0 2 -2 0 0 0 0];
internalField   uniform {ip:g};
boundaryField
{{
    inlet
    {{
        type            zeroGradient;
    }}
    outlet
    {{
        type            fixedValue;
        value           uniform {outlet_p:g};
    }}
    walls
    {{
        type            zeroGradient;
    }}
}}
"""
    _write_foam(path, text)


def write_T(
    path: Path,
    *,
    project: Project,
    contexts: dict[str, dict[str, Any]] | None = None,
) -> None:
    from cfddesk.case.bc_menu import registry_key_for_bc
    from cfddesk.mesh.patches import emit_all_patches

    ctx_map = contexts or {}
    bc_by_id = {bc.id: bc for bc in project.boundary_conditions}
    entries: list[str] = []
    for ep in emit_all_patches(project):
        bc = bc_by_id.get(ep.bc_id)
        if bc is None:
            continue
        spec = get_type(registry_key_for_bc(bc))
        writer = spec.write_T
        ctx = ctx_map.get(bc.patch_name, {}) or ctx_map.get(ep.name, {})
        if writer is None:
            entries.append(
                f"""    {ep.name}
    {{
        type            zeroGradient;
    }}
"""
            )
            continue
        entries.append(writer(ep.name, bc.settings, ctx))
    body = "".join(entries)
    text = f"""FoamFile
{{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      T;
}}
dimensions      [0 0 0 1 0 0 0];
internalField   uniform 293.15;
boundaryField
{{
{body}}}
"""
    _write_foam(path, text)


def parse_boundary_patch_types(path: Path) -> dict[str, str]:
    """Parse patch name → type from constant/polyMesh/boundary."""
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    text = re.sub(r"FoamFile\s*\{.*?\}\s*", "", text, count=1, flags=re.S)
    types: dict[str, str] = {}
    for m in re.finditer(
        r"(?m)^\s*([A-Za-z_][\w]*)\s*\n\s*\{\s*\n\s*type\s+([A-Za-z_]\w*)\s*;",
        text,
    ):
        types[m.group(1)] = m.group(2)
    return types


def assert_boundary_patch_types(
    case_dir: Path,
    project: Project,
    *,
    stage: Literal["snappy", "final"] = "final",
) -> None:
    """Hard-fail if polyMesh boundary types disagree with emitted patch types.

    Asserts every name from ``emit_all_patches`` (intensive merge or extensive
    ``<patch>_1…N``). Periodic halves are ``patch`` at the snappy stage.

    ``stage="final"`` is for post-``createPatch`` meshes, where periodic halves
    become ``cyclic``. Do not call ``stage="final"`` immediately after snappy
    when periodic pairs exist and createPatch has not run.
    """
    from cfddesk.case.bc_menu import registry_key_for_bc
    from cfddesk.case.bc_registry import patch_type_for
    from cfddesk.mesh.create_patch import is_periodic_bc
    from cfddesk.mesh.patches import emit_all_patches

    boundary = Path(case_dir) / "constant" / "polyMesh" / "boundary"
    if not boundary.is_file():
        raise RuntimeError(f"missing polyMesh boundary file: {boundary}")
    actual = parse_boundary_patch_types(boundary)
    bc_by_id = {bc.id: bc for bc in project.boundary_conditions}
    mismatches: list[str] = []
    for ep in emit_all_patches(project):
        bc = bc_by_id.get(ep.bc_id)
        if stage == "final" and bc is not None and is_periodic_bc(bc):
            expected = "cyclic"
        elif stage == "final" and bc is not None:
            reg = registry_key_for_bc(bc)
            settings = bc.settings if isinstance(bc.settings, dict) else {}
            expected = str(patch_type_for(reg, settings))
        else:
            expected = ep.patch_type
        got = actual.get(ep.name)
        if got is None:
            mismatches.append(f"{ep.name}: missing from mesh (expected {expected})")
        elif got != expected:
            mismatches.append(
                f"{ep.name}: mesh type={got!r} expected={expected!r} "
                f"(bc_id={ep.bc_id})"
            )
    if mismatches:
        raise RuntimeError(
            "boundary patch type mismatch after mesh:\n  " + "\n  ".join(mismatches)
        )


def write_fv_schemes(
    path: Path,
    *,
    turbulence: TurbulenceModel = "laminar",
    numerics: Any | None = None,
    for_potential: bool = False,
    transient: Any | None = None,
) -> None:
    """Write system/fvSchemes from NumericsSettings.schemes (inc24a.1).

    UI Schemes labels are mapped to OpenFOAM tokens via
    ``cfddesk.project.numerics.map_*_ui_to_of``. Named gradient / laplacian /
    interpolation rows from the Schemes form are emitted so written case matches
    UI intent (no UI/writer drift).

    When ``transient`` is set, emit the compact w30 / js_transient schemes
    (Euler|backward ddt, no bounded div) via ``write_fv_schemes_transient``.
    """
    if transient is not None:
        write_fv_schemes_transient(path, ctrl=transient)
        return
    from cfddesk.project.numerics import (
        NumericsSettings,
        SchemesSettings,
        map_divergence_scheme_ui_to_of,
        map_gradient_scheme_ui_to_of,
        map_interpolation_scheme_ui_to_of,
        map_laplacian_scheme_ui_to_of,
        map_sn_grad_scheme_ui_to_of,
        map_time_scheme_ui_to_of,
    )

    n = numerics if isinstance(numerics, NumericsSettings) else NumericsSettings()
    n.sync_schemes_to_writer_flats()
    s = n.schemes if isinstance(n.schemes, SchemesSettings) else SchemesSettings()

    ddt = map_time_scheme_ui_to_of(s.time_default)
    grad_default = map_gradient_scheme_ui_to_of(
        s.gradient_default.scheme, s.gradient_default.limiter_coefficient
    )
    grad_p = map_gradient_scheme_ui_to_of(s.grad_p.scheme, s.grad_p.limiter_coefficient)
    grad_U = map_gradient_scheme_ui_to_of(s.grad_U.scheme, s.grad_U.limiter_coefficient)
    div_default = map_divergence_scheme_ui_to_of(s.divergence_default)
    div_phi_u = map_divergence_scheme_ui_to_of(s.div_phi_U)
    div_phi_k = map_divergence_scheme_ui_to_of(s.div_phi_k)
    div_phi_omega = map_divergence_scheme_ui_to_of(s.div_phi_omega)
    lap_default = map_laplacian_scheme_ui_to_of(
        s.laplacian_default.scheme, s.laplacian_default.limiter_coefficient
    )
    lap_nuEff = map_laplacian_scheme_ui_to_of(
        s.laplacian_nuEff_U.scheme, s.laplacian_nuEff_U.limiter_coefficient
    )
    lap_1AU = map_laplacian_scheme_ui_to_of(
        s.laplacian_1AU_p.scheme, s.laplacian_1AU_p.limiter_coefficient
    )
    lap_nu = map_laplacian_scheme_ui_to_of(
        s.laplacian_nu_U.scheme, s.laplacian_nu_U.limiter_coefficient
    )
    interp_default = map_interpolation_scheme_ui_to_of(s.interpolation_default)
    interp_HbyA = map_interpolation_scheme_ui_to_of(s.interpolate_HbyA)
    sn_grad = map_sn_grad_scheme_ui_to_of(
        s.sn_grad_default, s.sn_grad_limiter_coefficient
    )

    # Turbulence extras: k/omega from Schemes UI; epsilon/R keep prior RAS parity.
    if turbulence == "laminar":
        turb_div = ""
    else:
        turb_lines = [
            f"    div(phi,k)      {div_phi_k};",
            f"    div(phi,epsilon) {div_phi_k};",
            f"    div(phi,omega)  {div_phi_omega};",
            "    div(phi,R)      bounded Gauss upwind;",
            "    div(R)          Gauss linear;",
        ]
        turb_div = "\n".join(turb_lines) + "\n"

    pot_div = (
        "    div(div(phi,U)) Gauss linear;\n" if for_potential else ""
    )
    pot_grad = "    grad(Phi)       Gauss linear;\n" if for_potential else ""
    pot_lap = (
        "    laplacian(1,Phi) Gauss linear corrected;\n"
        "    laplacian(p)     Gauss linear corrected;\n"
        if for_potential
        else ""
    )
    _write_foam(
        path,
        _foam_header("fvSchemes")
        + f"""
ddtSchemes
{{
    default         {ddt};
}}

gradSchemes
{{
    default         {grad_default};
    grad(p)         {grad_p};
    grad(U)         {grad_U};
{pot_grad}}}

divSchemes
{{
    default         {div_default};
    div(phi,U)      {div_phi_u};
    div((nuEff*dev2(T(grad(U))))) {n.div_nu_eff};
{pot_div}{turb_div}}}

laplacianSchemes
{{
    default         {lap_default};
    laplacian(nuEff,U) {lap_nuEff};
    laplacian((1|A(U)),p) {lap_1AU};
    laplacian(nu,U) {lap_nu};
{pot_lap}}}

interpolationSchemes
{{
    default         {interp_default};
    interpolate(HbyA) {interp_HbyA};
}}

snGradSchemes
{{
    default         {sn_grad};
}}

wallDist
{{
    method          {n.wall_dist_method};
}}

// ************************************************************************* //
""",
    )


def _p_solver_block_cpu(p_solver: str) -> str:
    if p_solver == "PBiCGStab":
        return """    p
    {
        solver          PBiCGStab;
        preconditioner  DILU;
        tolerance       1e-7;
        relTol          0.01;
    }
"""
    # GAMG (default — pre-P4)
    return """    p
    {
        solver          GAMG;
        tolerance       1e-7;
        relTol          0.01;
        smoother        GaussSeidel;
    }
"""


def _u_solver_block(u_solver: str) -> str:
    if u_solver == "PBiCGStab":
        return """    U
    {
        solver          PBiCGStab;
        preconditioner  DILU;
        tolerance       1e-8;
        relTol          0.1;
    }
"""
    return """    U
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-8;
        relTol          0.1;
    }
"""


def _phi_solver_block(*, for_potential: bool) -> str:
    if not for_potential:
        return ""
    return """    Phi
    {
        solver          GAMG;
        tolerance       1e-7;
        relTol          0.01;
        smoother        GaussSeidel;
    }
"""


def write_fv_solution_cpu(
    path: Path,
    *,
    residual_u: float = 1e-5,
    residual_p: float | None = 1e-5,
    turbulence: TurbulenceModel = "laminar",
    numerics: Any | None = None,
    p_ref_value_kinematic: float = 0.0,
    include_phi: bool = False,
) -> None:
    from cfddesk.project.numerics import NumericsSettings

    n = numerics if isinstance(numerics, NumericsSettings) else NumericsSettings()
    if residual_p is None:
        p_line = "        // p omitted for identical stop vs AmgX (p judged by FO)\n"
    else:
        p_line = f"        p               {residual_p:g};\n"
    turb_solvers, _, _ = fv_solution_turbulence_block(turbulence)
    p_solver = n.p_solver if n.p_solver != "amgx" else "GAMG"
    turb_relax = _turb_relax_lines(n, turbulence)
    _write_foam(
        path,
        _foam_header("fvSolution")
        + f"""
solvers
{{
{_p_solver_block_cpu(p_solver)}    pFinal
    {{
        $p;
        relTol          0;
    }}
{_u_solver_block(n.u_solver)}{_phi_solver_block(for_potential=include_phi)}{turb_solvers}}}

SIMPLE
{{
    nNonOrthogonalCorrectors {int(n.n_non_orthogonal)};
    consistent      yes;
    momentumPredictor yes;

    residualControl
    {{
        U               {residual_u:g};
{p_line}    }}

    pRefCell        {int(n.p_ref_cell)};
    pRefValue       {p_ref_value_kinematic:g};
}}

relaxationFactors
{{
    fields
    {{
        p               {n.relax_p:g};
    }}
    equations
    {{
        U               {n.relax_u:g};
{turb_relax}    }}
}}

cache
{{
    grad(U);
}}

// ************************************************************************* //
""",
    )


def write_fv_solution_amgx(
    path: Path,
    *,
    residual_u: float = 1e-5,
    turbulence: TurbulenceModel = "laminar",
    numerics: Any | None = None,
    p_ref_value_kinematic: float = 0.0,
    include_phi: bool = False,
) -> None:
    """AmgX on kinematic p / pFinal. residualControl keys on U only (not AmgX p)."""
    from cfddesk.project.numerics import NumericsSettings

    n = numerics if isinstance(numerics, NumericsSettings) else NumericsSettings()
    turb_solvers, _, _ = fv_solution_turbulence_block(turbulence)
    turb_relax = _turb_relax_lines(n, turbulence)
    _write_foam(
        path,
        _foam_header("fvSolution")
        + f"""
solvers
{{
    p
    {{
        solver          amgx;
        tolerance       1e-7;
        relTol          0.01;
        amgx
        {{
            dict        p;
            caching
            {{
                matrix
                {{
                    update      always;
                }}
                preconditioner
                {{
                    update      always;
                }}
            }}
        }}
    }}
    pFinal
    {{
        $p;
        relTol          0;
    }}
{_u_solver_block(n.u_solver)}{_phi_solver_block(for_potential=include_phi)}{turb_solvers}}}

SIMPLE
{{
    nNonOrthogonalCorrectors {int(n.n_non_orthogonal)};
    consistent      yes;
    momentumPredictor yes;

    // residualControl on U only - AmgX p residual reports 0 (TRANSLATION section 3).
    // Target U and p residuals 1e-5; p judged via FO/continuity on AmgX branch.
    residualControl
    {{
        U               {residual_u:g};
    }}

    pRefCell        {int(n.p_ref_cell)};
    pRefValue       {p_ref_value_kinematic:g};
}}

relaxationFactors
{{
    fields
    {{
        p               {n.relax_p:g};
    }}
    equations
    {{
        U               {n.relax_u:g};
{turb_relax}    }}
}}

cache
{{
    grad(U);
}}

// ************************************************************************* //
""",
    )


def _turb_relax_lines(n: Any, turbulence: TurbulenceModel) -> str:
    from cfddesk.project.numerics import relax_for_turbulence

    relax = relax_for_turbulence(n, turbulence)
    if not relax:
        return ""
    return "".join(f"        {k:<15} {v:g};\n" for k, v in relax.items())


def write_decompose_par_dict(
    path: Path, *, n_subdomains: int, method: str = "scotch"
) -> None:
    _write_foam(
        path,
        _foam_header("decomposeParDict")
        + f"""
numberOfSubdomains {int(n_subdomains)};

method          {method};

// ************************************************************************* //
""",
    )


def project_has_pressure_fixing_patch(project: Project) -> bool:
    """True if any BC writes a fixed/total/mean pressure on a patch."""
    from cfddesk.case.bc_menu import registry_key_for_bc

    for bc in project.boundary_conditions:
        if not bc.face_ids:
            continue
        try:
            key = registry_key_for_bc(bc)
        except KeyError:
            continue
        if key.startswith("pressure"):
            return True
    return False


def validate_p_ref_value(project: Project, p_ref_value_pa: float) -> str | None:
    """Return an error message if pRefValue is incompatible; else None."""
    if abs(float(p_ref_value_pa)) < 1e-30:
        return None
    if project_has_pressure_fixing_patch(project):
        return (
            "Non-zero pressure reference value is refused while a boundary "
            "condition fixes pressure (Case 1 divergence guardrail). "
            "Set pRefValue to 0 Pa, or remove the pressure-fixing patch."
        )
    return None


def write_control_dict(
    path: Path,
    *,
    amgx: bool = False,
    end_time: int = 2000,
    write_interval: int = 100,
    delta_t: float = 1.0,
    write_control: str = "timeStep",
    inlet_patch: str | None = None,
    outlet_patch: str | None = None,
    application: str | None = None,
    transient: Any | None = None,
    functions_text: str | None = None,
) -> None:
    """Write system/controlDict.

    Steady (default): simpleFoam + optional pInlet/pOutlet (legacy CLI).
    Transient: delegates to ``write_control_dict_transient`` (pimpleFoam / w30).
    When ``functions_text`` is provided (steady), it replaces the default
    minMax + pInlet/pOutlet block — used by the web mon_/flow_ path.
    """
    if transient is not None:
        write_control_dict_transient(
            path,
            ctrl=transient,
            functions_text=functions_text or "",
        )
        return
    from cfddesk.case.surface_averages import control_dict_surface_p_block

    libs_line = (
        "libs            (amgxFoam fieldFunctionObjects);\n"
        if amgx
        else "libs            (fieldFunctionObjects);\n"
    )
    app = application or "simpleFoam"
    if functions_text is not None:
        extra_fn = functions_text
        if not amgx:
            libs_line = ""
    else:
        extra_fn = ""
        if inlet_patch and outlet_patch:
            extra_fn = control_dict_surface_p_block(inlet_patch, outlet_patch)
    if functions_text is None:
        functions_body = f"""    minMax
    {{
        type            fieldMinMax;
        libs            (fieldFunctionObjects);
        fields          (U p);
        mode            magnitude;
        writeControl    writeTime;
        log             true;
    }}
    volIntU
    {{
        type            volFieldValue;
        libs            (fieldFunctionObjects);
        fields          (U);
        operation       volIntegrate;
        writeFields     false;
        writeControl    writeTime;
        log             true;
    }}
    volIntP
    {{
        type            volFieldValue;
        libs            (fieldFunctionObjects);
        fields          (p);
        operation       volIntegrate;
        writeFields     false;
        writeControl    writeTime;
        log             true;
    }}
{extra_fn}"""
    else:
        functions_body = extra_fn
    _write_foam(
        path,
        _foam_header("controlDict")
        + f"""
application     {app};
{libs_line}startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         {end_time};
deltaT          {delta_t:g};
writeControl    {write_control};
writeInterval   {write_interval};
purgeWrite      2;
writeFormat     ascii;
writePrecision  12;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable true;

functions
{{
{functions_body}
}}

// ************************************************************************* //
""",
    )



def write_fv_options_limit_u(path: Path, *, max_u: float) -> None:
    """Velocity cap FO (w27 limitU) — 10x expected speed, floor 50 m/s."""
    u = float(max_u)
    # Match JS Number.toPrecision(6) for the max value
    from cfddesk.case.function_objects import js_to_precision

    max_s = js_to_precision(u, 6)
    _write_foam(
        path,
        _foam_header("fvOptions")
        + f"""
limitU
{{
    type            limitVelocity;
    active          yes;
    selectionMode   all;
    max             {max_s};
}}

// ************************************************************************* //
""",
    )


def write_fv_solution_pimple(
    path: Path,
    *,
    ctrl: TransientControl,
    turbulence: TurbulenceModel = "kOmegaSST",
    numerics: Any | None = None,
) -> None:
    """pimpleFoam fvSolution matching w30.transientFvSolution."""
    n_outer = max(1, int(round(ctrl.n_outer_correctors)))
    n_corr = max(1, int(round(ctrl.n_correctors)))
    n_non_orth = max(0, int(round(ctrl.n_non_orthogonal_correctors)))
    if n_outer > 1:
        relax = """relaxationFactors
{
    fields
    {
        p               0.3;
        pFinal          1;
    }
    equations
    {
        "(U|k|omega)"   0.7;
        "(U|k|omega)Final" 1;
    }
}"""
    else:
        relax = """relaxationFactors
{
    equations
    {
        ".*"            1;
    }
}"""
    # turbulence / numerics reserved for Phase 2 unification; w30 hard-codes U|k|omega.
    _ = (turbulence, numerics)
    _write_foam(
        path,
        _foam_header("fvSolution")
        + f"""
solvers
{{
    p
    {{
        solver          GAMG;
        tolerance       1e-7;
        relTol          0.01;
        smoother        GaussSeidel;
        nCellsInCoarsestLevel 20;
        maxIter         200;
    }}
    pFinal
    {{
        $p;
        relTol          0;
    }}
    "(U|k|omega)"
    {{
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-8;
        relTol          0.1;
        maxIter         50;
    }}
    "(U|k|omega)Final"
    {{
        $U;
        relTol          0;
    }}
}}
PIMPLE
{{
    momentumPredictor   yes;
    nOuterCorrectors    {n_outer};
    nCorrectors         {n_corr};
    nNonOrthogonalCorrectors {n_non_orth};
    turbOnFinalIterOnly yes;
    consistent          no;
}}
{relax}

// ************************************************************************* //
""",
    )


def write_fv_schemes_transient(path: Path, *, ctrl: TransientControl) -> None:
    """Compact transient fvSchemes matching w30.transientFvSchemes / js_transient golden."""
    from cfddesk.project.transient import foam_num  # noqa: F401 — unused; scheme is token

    ddt = "backward" if ctrl.time_scheme == "backward" else "Euler"
    _write_foam(
        path,
        _foam_header("fvSchemes")
        + f"""
ddtSchemes {{ default {ddt}; }}
gradSchemes
{{
    default         Gauss linear;
    grad(U)         cellLimited Gauss linear 1;
    grad(k)         cellLimited Gauss linear 1;
    grad(omega)     cellLimited Gauss linear 1;
}}
divSchemes
{{
    default         none;
    div(phi,U)      Gauss linearUpwind grad(U);
    div(phi,k)      Gauss limitedLinear 1;
    div(phi,omega)  Gauss limitedLinear 1;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}}
laplacianSchemes {{ default Gauss linear limited corrected 0.5; }}
interpolationSchemes {{ default linear; }}
snGradSchemes {{ default limited corrected 0.5; }}
wallDist {{ method meshWave; }}

// ************************************************************************* //
""",
    )


def write_control_dict_transient(
    path: Path,
    *,
    ctrl: TransientControl,
    functions_text: str = "",
) -> None:
    """pimpleFoam controlDict matching w30.transientControlDict / js_transient golden."""
    from cfddesk.project.transient import foam_num

    adjust = ctrl.adjust_time_step
    body = f"""application     pimpleFoam;
startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         {foam_num(ctrl.end_time)};
deltaT          {foam_num(ctrl.delta_t)};
writeControl    {"adjustableRunTime" if adjust else "runTime"};
writeInterval   {foam_num(ctrl.write_interval)};
purgeWrite      0;
writeFormat     ascii;
writePrecision  8;
writeCompression off;
timeFormat      general;
timePrecision   8;
runTimeModifiable true;

adjustTimeStep  {"yes" if adjust else "no"};
maxCo           {foam_num(ctrl.max_co)};
maxDeltaT       {foam_num(ctrl.max_delta_t)};

functions
{{
{functions_text or "    // no area-average probes"}
}}
"""
    _write_foam(path, _foam_header("controlDict") + "\n" + body)


def write_amgxp_options(path: Path, json_src: Path) -> None:
    data = json.loads(json_src.read_text(encoding="utf-8"))
    # OpenFOAM amgxFoam expects the JSON content as the amgxpOptions file body.
    path.write_bytes(
        (json.dumps(data, indent=4) + "\n").encode("ascii")
    )


def write_foam_marker(case_dir: Path) -> Path:
    """Always-written ParaView escape hatch."""
    marker = case_dir / f"{case_dir.name}.foam"
    marker.write_text("", encoding="ascii")
    return marker


def write_run_amgx_sh(path: Path) -> None:
    text = """#!/usr/bin/env bash
# AmgX GPU run for cfddesk vortex slice-1 (simpleFoam, AmgX on p).
# At ~14k cells AmgX is expected to be slower than CPU (setup-dominated) -
# A4 tests routing/correctness only, not performance.
set -euo pipefail
CASE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$CASE_DIR"

export AMGX_DIR="${AMGX_DIR:-$HOME/cfd/builds/amgx-install}"
export PETSC_DIR="${PETSC_DIR:-$HOME/cfd/builds/petsc}"
export PETSC_ARCH="${PETSC_ARCH:-linux-gnu-cuda-opt}"
export PETSC_OPTIONS="-use_gpu_aware_mpi 0"
export CUDA_VISIBLE_DEVICES=0

openfoam2606 bash -c '
  export LD_LIBRARY_PATH=$AMGX_DIR/lib:$PETSC_DIR/$PETSC_ARCH/lib:${FOAM_USER_LIBBIN}:/usr/local/cuda/lib64:$LD_LIBRARY_PATH
  cd "'"$CASE_DIR"'"
  # Prefer AmgX fvSolution if present as sibling
  if [[ -f system/fvSolution.amgx ]]; then
    cp -f system/fvSolution.amgx system/fvSolution
  fi
  simpleFoam 2>&1 | tee log.simpleFoam.amgx
'
"""
    path.write_bytes(text.replace("\r\n", "\n").encode("ascii"))


def write_run_cpu_sh(path: Path) -> None:
    text = """#!/usr/bin/env bash
set -euo pipefail
CASE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$CASE_DIR"
openfoam2606 bash -c '
  cd "'"$CASE_DIR"'"
  if [[ -f system/fvSolution.cpu ]]; then
    cp -f system/fvSolution.cpu system/fvSolution
  fi
  # Strip amgxFoam lib if controlDict has it
  simpleFoam 2>&1 | tee log.simpleFoam.cpu
'
"""
    path.write_bytes(text.replace("\r\n", "\n").encode("ascii"))


def assert_guardrails(
    case_dir: Path,
    *,
    allow_nonzero_pref: bool = False,
    expected_pref: float = 0.0,
) -> GuardrailReport:
    """Parse written dicts and assert pressure-datum + momentumPredictor guardrails."""
    msgs: list[str] = []
    fv = (case_dir / "system" / "fvSolution").read_text(encoding="utf-8")
    p_field = (case_dir / "0" / "p").read_text(encoding="utf-8")
    ctrl = (case_dir / "system" / "controlDict").read_text(encoding="utf-8")

    # pRefValue — default 0; non-zero only when caller opted in (no p-fixing patch).
    pref_vals: list[float] = []
    for line in fv.splitlines():
        if "pRefValue" in line:
            try:
                pref_vals.append(float(line.split()[-1].rstrip(";")))
            except ValueError:
                pass
    if not pref_vals:
        ok_pref = False
        msgs.append("FAIL: pRefValue missing")
    else:
        got = pref_vals[0]
        if allow_nonzero_pref:
            ok_pref = abs(got - float(expected_pref)) <= 1e-12 * max(1.0, abs(expected_pref))
            if not ok_pref:
                msgs.append(
                    f"FAIL: pRefValue {got:g} != expected kinematic {expected_pref:g}"
                )
        else:
            ok_pref = abs(got) < 1e-30
            if not ok_pref:
                msgs.append("FAIL: pRefValue is not 0")

    # momentumPredictor yes
    ok_mom = any(
        "momentumPredictor" in line and "yes" in line
        for line in fv.splitlines()
    )
    if not ok_mom:
        msgs.append("FAIL: momentumPredictor is not yes")

    # outlet fixes p
    # crude block parse: outlet section contains fixedValue + an explicit value.
    # Slice-2: outlet_p is a user setting and may be any float, not only 0 —
    # guardrail only asserts the outlet BC *type*, not a specific magnitude.
    outlet_idx = p_field.find("outlet")
    ok_outlet = False
    if outlet_idx >= 0:
        chunk = p_field[outlet_idx : outlet_idx + 200]
        ok_outlet = "fixedValue" in chunk and "value" in chunk
    if not ok_outlet:
        msgs.append("FAIL: outlet does not fix p (fixedValue)")

    # Never absolute operating pressure written as the FOAM (kinematic) pRefValue.
    # Case 1 failure mode: pRefValue 101325 in fvSolution (Pa mistaken for kinematic).
    # Correct Pa→kinematic conversion yields ~84157 for air — that is NOT this bug.
    bad_pref = any(
        "pRefValue" in line and "101325" in line for line in fv.splitlines()
    )
    if bad_pref:
        msgs.append("FAIL: pRefValue set to absolute operating pressure")

    amgx_on_p = "solver          amgx" in fv or "solver amgx" in fv.replace(" ", " ")
    if "amgxFoam" in ctrl and not amgx_on_p:
        # check .amgx sibling
        amgx_fv = case_dir / "system" / "fvSolution.amgx"
        if amgx_fv.is_file():
            amgx_on_p = "amgx" in amgx_fv.read_text(encoding="utf-8")

    ok = not msgs
    if ok:
        msgs.append("guardrails PASS: pRefValue 0, momentumPredictor yes, outlet fixedValue p")
    return GuardrailReport(
        pRefValue=0.0,
        momentumPredictor=ok_mom,
        outlet_fixes_p=ok_outlet,
        amgx_on_p=bool(amgx_on_p),
        ok=ok,
        messages=tuple(msgs),
    )


# Safety-net endTime for end_condition="residual": the actual stop is meant
# to be residualControl (in fvSolution/SIMPLE), not this iteration count —
# it only guards against a run that never satisfies residualControl.
RESIDUAL_END_TIME_SAFETY = 100_000


def write_simplefoam_case(
    case_dir: Path,
    *,
    amgx_json: Path,
    default_backend: str = "amgx",
    inlet_u: tuple[float, float, float] | None = None,
    outlet_p: float = 0.0,
    residual_u: float = 1e-5,
    residual_p: float | None = 1e-5,
    end_condition: str = "residual",
    end_time: int | None = None,
    write_interval: int = 100,
    turbulence: TurbulenceModel = "laminar",
    turbulence_intensity_pct: float = 5.0,
    hydraulic_diameter_m: float = DEFAULT_HYDRAULIC_DIAMETER_M,
    project: Project | None = None,
    solid: LoadedSolid | None = None,
) -> dict:
    """Write 0/, constant/physics, system/ solve dicts into an existing mesh case.

    When ``project`` is given, U/p/(T) and RAS patches come from
    ``project.boundary_conditions`` via the BC registry. Otherwise the legacy
    inlet/outlet/walls layout is written (gates A3/A4).

    ``end_condition`` / ``end_time`` (inc25b Sim control wire):
    - When ``project`` is given and ``end_time`` is None, controlDict endTime
      comes from Simulation control UI / ``project.solver.end_time`` (still
      default 1000) — hard UI->case match; never soft-pass the legacy
      residual safety cap over the UI value.
    - Legacy (no project): "residual" uses :data:`RESIDUAL_END_TIME_SAFETY`;
      "iterations" defaults to 2000 if ``end_time`` is omitted.
    - Residual stop is still driven by fvSolution residualControl; endTime is
      the user-visible iteration/time cap from Sim control.

    ``residual_p`` is ignored (reported as ``None``) when
    ``default_backend == "amgx"``: AmgX reports the p residual as 0
    (TRANSLATION §3), so the active fvSolution's residualControl keys on U
    only — see :func:`write_fv_solution_amgx`.
    """
    # Inc25b: with a Project, Sim control End time (solver.end_time) is
    # authoritative for controlDict endTime — including residual end_condition.
    # Legacy no-project path keeps the residual safety cap / iterations default.
    if end_time is None:
        if project is not None:
            end_time = int(project.solver.end_time)
        else:
            end_time = (
                RESIDUAL_END_TIME_SAFETY if end_condition == "residual" else 2000
            )

    case_dir = Path(case_dir)
    (case_dir / "0").mkdir(parents=True, exist_ok=True)
    (case_dir / "constant").mkdir(parents=True, exist_ok=True)
    (case_dir / "system").mkdir(parents=True, exist_ok=True)

    from cfddesk.project.numerics import NumericsSettings, SimulationControlSettings

    u = inlet_u if inlet_u is not None else INLET_U
    u_ref = math.sqrt(u[0] * u[0] + u[1] * u[1] + u[2] * u[2])
    patch_semantics = None
    nu_written: float
    rho_written: float | None = None
    numerics = NumericsSettings()
    sim_ctrl = SimulationControlSettings()
    include_phi = False
    internal_u = (0.0, 0.0, 0.0)
    internal_p_kin = 0.0
    p_ref_kin = 0.0
    ic_overrides: dict[str, float] = {}
    n_subdomains = 1

    if project is not None:
        mat = _require_assigned_material(project)
        nu_written = float(mat["nu"])
        rho_written = float(mat["rho"])
        numerics = project.numerics_settings()
        sim_ctrl = project.simulation_control_settings()
        include_phi = bool(sim_ctrl.potential_flow_init)
        # backend is authoritative — never let default p_solver demote AmgX.
        if default_backend != project.solver.backend:
            default_backend = project.solver.backend
        pref_err = validate_p_ref_value(project, numerics.p_ref_value_pa)
        if pref_err:
            raise RuntimeError(pref_err)
        p_ref_kin = pa_to_kinematic(numerics.p_ref_value_pa, rho_written)
        sim = project.primary_simulation()
        ic = (sim.initial_conditions if sim else {}) or {}
        from cfddesk.project.initial_conditions import (
            ic_internal_p_kinematic,
            ic_internal_u,
        )

        if ic:
            internal_u = ic_internal_u(ic)
            internal_p_kin = ic_internal_p_kinematic(ic, rho_written)
            if isinstance(ic.get("k"), dict):
                ic_overrides["k"] = float(ic["k"]["global"])
            if isinstance(ic.get("omega"), dict):
                ic_overrides["omega"] = float(ic["omega"]["global"])
            if isinstance(ic.get("epsilon"), dict):
                ic_overrides["epsilon"] = float(ic["epsilon"]["global"])
            if isinstance(ic.get("R"), dict):
                from cfddesk.project.initial_conditions import normalize_r_diag

                ic_overrides["R_diag"] = normalize_r_diag(ic["R"].get("global_diag"))
        residual_u = float(numerics.residual_u)
        if default_backend != "amgx":
            residual_p = float(numerics.residual_p)
        write_interval = int(sim_ctrl.write_interval)
        n_subdomains = sim_ctrl.resolve_n_cpus(backend=default_backend)
        if default_backend == "amgx" and n_subdomains > 1:
            raise RuntimeError(
                "AmgX runs serial on one GPU (N=1). Multi-rank AmgX is unsupported."
            )
        ctx = _bc_contexts(project, solid, inlet_u_fallback=u)
        write_U(
            case_dir / "0" / "U",
            inlet_u=u,
            project=project,
            solid=solid,
            contexts=ctx,
            internal_u=internal_u,
        )
        write_p(
            case_dir / "0" / "p",
            outlet_p=outlet_p,
            project=project,
            contexts=ctx,
            density_kg_m3=rho_written,
            internal_p_kinematic=internal_p_kin,
        )
        if project.solver.energy:
            write_T(case_dir / "0" / "T", project=project, contexts=ctx)
        patch_semantics = _patch_semantics_from_project(project)
    else:
        # Legacy gate path (no Project) — explicit library Air ν.
        nu_written = NU_AIR
        write_U(case_dir / "0" / "U", inlet_u=u)
        write_p(case_dir / "0" / "p", outlet_p=outlet_p)
    turb_scalars = write_ras_fields(
        case_dir,
        turbulence,
        U_ref=u_ref,
        intensity_pct=turbulence_intensity_pct,
        D_h=hydraulic_diameter_m,
        patch_semantics=patch_semantics,
        internal_overrides=ic_overrides or None,
    )
    write_transport_properties(
        case_dir / "constant" / "transportProperties", nu=nu_written
    )
    write_turbulence_properties(
        case_dir / "constant" / "turbulenceProperties", turbulence
    )
    write_fv_schemes(
        case_dir / "system" / "fvSchemes",
        turbulence=turbulence,
        numerics=numerics,
        for_potential=include_phi,
    )
    write_fv_solution_cpu(
        case_dir / "system" / "fvSolution.cpu",
        residual_u=residual_u,
        residual_p=residual_p,
        turbulence=turbulence,
        numerics=numerics,
        p_ref_value_kinematic=p_ref_kin,
        include_phi=include_phi,
    )
    write_fv_solution_amgx(
        case_dir / "system" / "fvSolution.amgx",
        residual_u=residual_u,
        turbulence=turbulence,
        numerics=numerics,
        p_ref_value_kinematic=p_ref_kin,
        include_phi=include_phi,
    )
    write_decompose_par_dict(
        case_dir / "system" / "decomposeParDict",
        n_subdomains=n_subdomains,
        method=sim_ctrl.decompose_method,
    )
    inlet_patch = outlet_patch = None
    if project is not None:
        from cfddesk.case.surface_averages import inlet_outlet_patch_names

        pair = inlet_outlet_patch_names(project)
        if pair is not None:
            inlet_patch, outlet_patch = pair

    if default_backend == "amgx":
        shutil.copyfile(
            case_dir / "system" / "fvSolution.amgx",
            case_dir / "system" / "fvSolution",
        )
        write_control_dict(
            case_dir / "system" / "controlDict",
            amgx=True,
            end_time=end_time,
            write_interval=write_interval,
            delta_t=sim_ctrl.delta_t,
            write_control=sim_ctrl.write_control,
            inlet_patch=inlet_patch,
            outlet_patch=outlet_patch,
        )
    else:
        shutil.copyfile(
            case_dir / "system" / "fvSolution.cpu",
            case_dir / "system" / "fvSolution",
        )
        write_control_dict(
            case_dir / "system" / "controlDict",
            amgx=False,
            end_time=end_time,
            write_interval=write_interval,
            delta_t=sim_ctrl.delta_t,
            write_control=sim_ctrl.write_control,
            inlet_patch=inlet_patch,
            outlet_patch=outlet_patch,
        )

    write_amgxp_options(case_dir / "system" / "amgxpOptions", amgx_json)
    foam = write_foam_marker(case_dir)
    write_run_amgx_sh(case_dir / "run_amgx.sh")
    write_run_cpu_sh(case_dir / "run_cpu.sh")

    guard = assert_guardrails(
        case_dir,
        allow_nonzero_pref=(
            project is not None
            and abs(numerics.p_ref_value_pa) > 0
            and not project_has_pressure_fixing_patch(project)
        ),
        expected_pref=p_ref_kin,
    )
    if not guard.ok:
        raise RuntimeError("; ".join(guard.messages))

    # AmgX branch never uses a p residual target (see docstring) — report
    # that explicitly rather than echoing back a value that was not applied.
    reported_residual_p = None if default_backend == "amgx" else residual_p

    return {
        "case_dir": str(case_dir),
        "foam": str(foam),
        "inlet_U": list(u),
        "outlet_p": outlet_p,
        "nu": nu_written,
        "density_kg_m3": rho_written,
        "turbulence": turbulence,
        "turbulence_intensity_pct": turbulence_intensity_pct,
        "hydraulic_diameter_m": hydraulic_diameter_m,
        "turbulence_scalars": (
            None
            if turb_scalars is None
            else {
                "k": turb_scalars.k,
                "epsilon": turb_scalars.epsilon,
                "omega": turb_scalars.omega,
                "nut": turb_scalars.nut,
            }
        ),
        "end_condition": end_condition,
        "end_time": end_time,
        "residual_u": residual_u,
        "residual_p": reported_residual_p,
        "guardrails": {
            "pRefValue": guard.pRefValue,
            "momentumPredictor": guard.momentumPredictor,
            "outlet_fixes_p": guard.outlet_fixes_p,
            "amgx_on_p": guard.amgx_on_p,
            "messages": list(guard.messages),
        },
    }


def _ensure_web_imports() -> None:
    """Load UI/prepare_run helpers without pulling OCCT on writer import."""
    g = globals()
    if g.get("_WEB_READY"):
        return
    from cfddesk.case.function_objects import js_to_precision, monitors_functions_text
    from cfddesk.project.web_adapter import (
        FaceProps,
        RunSpec,
        WebBc,
        bc_faces,
        is_pressure_bc,
        is_velocity_inlet,
        is_velocity_outlet,
        is_wall_bc,
        wall_treatment,
    )

    g.update(
        {
            "js_to_precision": js_to_precision,
            "monitors_functions_text": monitors_functions_text,
            "FaceProps": FaceProps,
            "RunSpec": RunSpec,
            "WebBc": WebBc,
            "bc_faces": bc_faces,
            "is_pressure_bc": is_pressure_bc,
            "is_velocity_inlet": is_velocity_inlet,
            "is_velocity_outlet": is_velocity_outlet,
            "is_wall_bc": is_wall_bc,
            "wall_treatment": wall_treatment,
            "_WEB_READY": True,
        }
    )


# ---------------------------------------------------------------------------
# Foam I/O (match JS foamHeader / writeVolField spacing — no C++ banner)
# ---------------------------------------------------------------------------


def _write_bytes(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.replace("\r\n", "\n").encode("utf-8"))


def foam_header(cls: str, obj: str) -> str:
    return (
        "FoamFile\n"
        "{\n"
        "    version     2.0;\n"
        "    format      ascii;\n"
        f"    class       {cls};\n"
        f"    object      {obj};\n"
        "}\n"
    )


def write_foam_dict(path: Path, cls: str, obj: str, body: str) -> None:
    _write_bytes(path, foam_header(cls, obj) + "\n" + body.strip() + "\n")


def write_vol_field(
    path: Path,
    *,
    object_name: str,
    cls: str,
    dims: str,
    internal: str,
    patches: dict[str, dict[str, str]],
) -> None:
    lines = [
        foam_header(cls, object_name).rstrip("\n"),
        "",
        f"dimensions      {dims};",
        "",
        f"internalField   {internal};",
        "",
        "boundaryField",
        "{",
    ]
    for name, block in patches.items():
        lines.append(f"    {name}")
        lines.append("    {")
        for k, v in block.items():
            lines.append(f"        {k}          {v};")
        lines.append("    }")
    lines.append("}")
    lines.append("")
    _write_bytes(path, "\n".join(lines))


def js_plain_float(v: float) -> str:
    """Approximate Node's default number→string for Foam dict values."""
    if not math.isfinite(v):
        return "0"
    if v == 0:
        return "0"
    s = format(float(v), ".15f")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s or "0"


# ---------------------------------------------------------------------------
# Turbulence scales (exact w27 kOmegaFromScales)
# ---------------------------------------------------------------------------


def k_omega_from_scales(speed: float, d_hyd: float | None) -> dict[str, float]:
    u = max(abs(float(speed) or 0.0), 0.1)
    intensity = 0.05
    k = 1.5 * (intensity * u) * (intensity * u)
    length = max(0.07 * (float(d_hyd) if d_hyd else 0.0), 1e-3)
    omega = math.sqrt(k) / ((0.09**0.25) * length)
    return {"k": k, "omega": omega, "I": intensity, "L": length}


# ---------------------------------------------------------------------------
# Face / BC helpers (web FaceProps.area_m2)
# ---------------------------------------------------------------------------


def _props_area(fp: FaceProps | None) -> float:
    if fp is None or fp.area_m2 is None:
        return 0.0
    a = float(fp.area_m2)
    return a if math.isfinite(a) else 0.0


def faces_area(faces: list[str], props: dict[str, FaceProps]) -> float:
    return sum(_props_area(props.get(f)) for f in faces or [])


def hydraulic_diameter(faces: list[str], props: dict[str, FaceProps]) -> float | None:
    a = faces_area(faces, props)
    return 2.0 * math.sqrt(a / math.pi) if a > 0 else None


def _bc_dict(bc: WebBc | dict) -> dict[str, Any]:
    _ensure_web_imports()
    if isinstance(bc, WebBc):
        return {
            "name": bc.name,
            "bc_type": bc.bc_type,
            "faces": list(bc.faces),
            "value": bc.value,
            "unit": bc.unit,
            "velocity_type": bc.velocity_type,
            "flow_rate_type": bc.flow_rate_type,
            "direction": bc.direction,
            "vector": bc.vector,
            "wall_type": bc.wall_type,
            **(bc.raw or {}),
        }
    return dict(bc)


def inlet_speed_ms(bc: dict) -> float:
    try:
        v = float(bc["value"]) if bc.get("value") is not None else float("nan")
    except (TypeError, ValueError):
        return 1.0
    if not math.isfinite(v):
        return 1.0
    unit = str(bc.get("unit") or "").lower()
    if unit in ("m/s", "m s-1", ""):
        return v
    if unit == "ft/s":
        return v * 0.3048
    if unit in ("ft/min", "fpm"):
        return v * 0.3048 / 60.0
    if unit == "km/h":
        return v / 3.6
    if unit == "mph":
        return v * 0.44704
    return v


def pressure_pa(bc: dict) -> float:
    try:
        v = float(bc["value"]) if bc.get("value") is not None else float("nan")
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(v):
        return 0.0
    unit = str(bc.get("unit") or "Pa").lower()
    if unit in ("pa", ""):
        return v
    if unit == "kpa":
        return v * 1e3
    if unit == "bar":
        return v * 1e5
    if unit == "psi":
        return v * 6894.757
    if unit in ("inh2o", "in h2o", "inwc"):
        return v * 249.089
    if unit == "mmh2o":
        return v * 9.80665
    return v


def uses_flow_rate(bc: dict) -> bool:
    if re.search(r"flow\s*rate", str(bc.get("velocity_type") or ""), re.I):
        return True
    return bool(re.search(r"ft3/min|ft³/min|m3/s|m³/s|kg/s|lb/s", str(bc.get("unit") or ""), re.I))


def uses_vector(bc: dict) -> bool:
    return bool(re.search(r"vector", str(bc.get("direction") or ""), re.I)) and isinstance(
        bc.get("vector"), (list, tuple)
    )


def volumetric_m3s(bc: dict) -> float | None:
    try:
        v = float(bc["value"]) if bc.get("value") is not None else float("nan")
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    unit = str(bc.get("unit") or "").lower()
    if "ft" in unit and "min" in unit:
        return v * 0.00047194745
    if "l/min" in unit:
        return v / 60000.0
    if "l/s" in unit:
        return v / 1000.0
    if "m3" in unit or "m³" in unit or "m^3" in unit:
        return v
    return None


def mass_flow_kgs(bc: dict) -> float | None:
    try:
        v = float(bc["value"]) if bc.get("value") is not None else float("nan")
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    unit = str(bc.get("unit") or "").lower()
    if unit == "kg/s":
        return v
    if unit == "lb/s":
        return v * 0.45359237
    if unit == "kg/h":
        return v / 3600.0
    return None


def is_mass_flow(bc: dict) -> bool:
    if re.search(r"mass", str(bc.get("flow_rate_type") or ""), re.I):
        return True
    return mass_flow_kgs(bc) is not None and volumetric_m3s(bc) is None


def inlet_direction(bc: dict) -> list[float] | None:
    if not uses_vector(bc):
        return None
    v = [float(x) or 0.0 for x in (bc.get("vector") or [])[:3]]
    while len(v) < 3:
        v.append(0.0)
    m = math.hypot(v[0], v[1], v[2])
    if not (m > 0):
        return None
    return [x / m for x in v]


def vector_inlet_velocity(bc: dict, face_props: dict[str, FaceProps]) -> dict[str, Any] | None:
    spd = abs(inlet_speed_ms(bc))
    direction = inlet_direction(bc)
    if direction is None:
        return None
    return {
        "U": [d * spd for d in direction],
        "magnitude": spd,
    }


def inlet_ref_speed(bc: dict, face_area: float, rho: float) -> float:
    if uses_flow_rate(bc):
        q = (
            (mass_flow_kgs(bc) or 0.0) / (rho or 1.2)
            if is_mass_flow(bc)
            else (volumetric_m3s(bc) or 0.0)
        )
        n = max(1, len(bc_faces(bc)))
        if face_area > 0:
            return abs(q) * n / face_area
        return max(1.0, abs(q) * 1000.0)
    return abs(inlet_speed_ms(bc))


def resolve_speed_and_dhyd(spec: RunSpec) -> tuple[float, float]:
    """Port of writeSolveCase speedRef / dHyd selection."""
    _ensure_web_imports()
    rho = float(spec.rho) or 1.196
    props = spec.face_props or {}
    speed_ref = 1.0
    d_hyd: float | None = None
    inlets = [(m.get("bc"), m.get("patch")) for m in (spec.mapped or []) if is_velocity_inlet(m.get("bc"))]
    if inlets:
        best = 0.0
        best_area = 0.0
        for bc_raw, _patch in inlets:
            bc = _bc_dict(bc_raw)  # type: ignore[arg-type]
            faces = bc_faces(bc)
            area = faces_area(faces, props)
            s = inlet_ref_speed(bc, area / max(1, len(faces)), rho)
            if s > best:
                best = s
            if area > best_area:
                best_area = area
        speed_ref = max(best, 0.1)
        d_hyd = 2.0 * math.sqrt(best_area / math.pi) if best_area > 0 else None
    else:
        pm = [m.get("bc") for m in (spec.mapped or []) if is_pressure_bc(m.get("bc"))]
        pvals = [pressure_pa(_bc_dict(b)) for b in pm if b]
        if len(pvals) >= 2:
            dp = max(pvals) - min(pvals)
            speed_ref = max(1.0, math.sqrt((2.0 * abs(dp)) / rho))
        min_area = float("inf")
        for b in pm:
            if not b:
                continue
            a = faces_area(bc_faces(_bc_dict(b)), props)
            if a > 0 and a < min_area:
                min_area = a
        d_hyd = 2.0 * math.sqrt(min_area / math.pi) if math.isfinite(min_area) else None
    if not d_hyd or not (d_hyd > 0):
        d_hyd = 0.05
    return float(speed_ref), float(d_hyd)


# ---------------------------------------------------------------------------
# Patch role map + field dicts
# ---------------------------------------------------------------------------


def _patch_names(spec: RunSpec, poly_dst: Path | None) -> list[str]:
    """Prefer polyMesh boundary order; else walls + mapped BC order (w27)."""
    names: list[str] = []
    if poly_dst and (poly_dst / "boundary").is_file():
        from cfddesk.project.web_adapter import _parse_boundary_patches

        names = _parse_boundary_patches(poly_dst / "boundary")
    if not names:
        # Invent: walls first (unclaimed mesh default), then mapped patch order
        names = ["walls"]
        for m in spec.mapped or []:
            patch = str(m.get("patch") or "")
            if patch and patch not in names:
                names.append(patch)
        for b in spec.bcs:
            patch = b.patch or b.name
            if patch and patch not in names:
                names.append(patch)
        for n in spec.patches or []:
            if n and n not in names:
                names.append(n)
    elif "walls" not in names:
        names = ["walls"] + names
    seen: set[str] = set()
    out: list[str] = []
    for n in names:
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def _build_field_patches(
    spec: RunSpec, patch_names: list[str], *, k_str: str, w_str: str
) -> tuple[dict, dict, dict, dict, dict]:
    _ensure_web_imports()
    rho = float(spec.rho) or 1.196
    wall_default = spec.wall_default or "No-slip"
    props = spec.face_props or {}
    role: dict[str, dict[str, Any]] = {}
    for m in spec.mapped or []:
        bc = m.get("bc")
        patch = str(m.get("patch") or "")
        if not bc or not patch:
            continue
        b = _bc_dict(bc)
        if is_velocity_inlet(b):
            role[patch] = {"kind": "inlet", "bc": b}
        elif is_pressure_bc(b):
            role[patch] = {"kind": "pressure", "bc": b}
        elif is_velocity_outlet(b):
            role[patch] = {"kind": "velOutlet", "bc": b}
        elif is_wall_bc(b):
            role[patch] = {"kind": "wall", "bc": b, "treatment": wall_treatment(b)}

    U: dict[str, dict[str, str]] = {}
    p: dict[str, dict[str, str]] = {}
    k: dict[str, dict[str, str]] = {}
    omega: dict[str, dict[str, str]] = {}
    nut: dict[str, dict[str, str]] = {}

    for name in patch_names:
        r = role.get(name)
        kind = r["kind"] if r else "wall"
        if kind == "inlet":
            bc = r["bc"]  # type: ignore[index]
            n_faces = max(1, len(bc_faces(bc)))
            if uses_flow_rate(bc) and is_mass_flow(bc) and mass_flow_kgs(bc) is not None:
                rate = (mass_flow_kgs(bc) or 0.0) * n_faces
                U[name] = {
                    "type": "flowRateInletVelocity",
                    "massFlowRate": f"constant {js_to_precision(rate, 8)}",
                    "rhoInlet": f"{rho}",
                    "extrapolateProfile": "false",
                    "value": "uniform (0 0 0)",
                }
            elif uses_flow_rate(bc) and volumetric_m3s(bc) is not None:
                rate = (volumetric_m3s(bc) or 0.0) * n_faces
                U[name] = {
                    "type": "flowRateInletVelocity",
                    "volumetricFlowRate": f"constant {js_to_precision(rate, 8)}",
                    "extrapolateProfile": "false",
                    "value": "uniform (0 0 0)",
                }
            else:
                spd = abs(inlet_speed_ms(bc))
                vec = vector_inlet_velocity(bc, props) if uses_vector(bc) else None
                if vec:
                    comps = [js_to_precision(c, 8) for c in vec["U"]]
                    U[name] = {
                        "type": "fixedValue",
                        "value": f"uniform ({' '.join(comps)})",
                    }
                else:
                    U[name] = {
                        "type": "surfaceNormalFixedValue",
                        "refValue": f"uniform {js_plain_float(-spd)}",
                        "value": "uniform (0 0 0)",
                    }
            p[name] = {"type": "zeroGradient"}
            k[name] = {"type": "fixedValue", "value": f"uniform {k_str}"}
            omega[name] = {"type": "fixedValue", "value": f"uniform {w_str}"}
            nut[name] = {"type": "calculated", "value": "uniform 0"}
        elif kind == "pressure":
            p_kin = pressure_pa(r["bc"]) / rho  # type: ignore[index]
            U[name] = {"type": "pressureInletOutletVelocity", "value": "uniform (0 0 0)"}
            p[name] = {"type": "fixedValue", "value": f"uniform {js_to_precision(p_kin, 8)}"}
            k[name] = {
                "type": "inletOutlet",
                "inletValue": f"uniform {k_str}",
                "value": f"uniform {k_str}",
            }
            omega[name] = {
                "type": "inletOutlet",
                "inletValue": f"uniform {w_str}",
                "value": f"uniform {w_str}",
            }
            nut[name] = {"type": "calculated", "value": "uniform 0"}
        elif kind == "velOutlet":
            U[name] = {
                "type": "inletOutlet",
                "inletValue": "uniform (0 0 0)",
                "value": "uniform (0 0 0)",
            }
            p[name] = {"type": "zeroGradient"}
            k[name] = {
                "type": "inletOutlet",
                "inletValue": f"uniform {k_str}",
                "value": f"uniform {k_str}",
            }
            omega[name] = {
                "type": "inletOutlet",
                "inletValue": f"uniform {w_str}",
                "value": f"uniform {w_str}",
            }
            nut[name] = {"type": "calculated", "value": "uniform 0"}
        else:
            treatment = r["treatment"] if r and r.get("kind") == "wall" else wall_default
            if treatment == "Slip":
                U[name] = {"type": "slip"}
                p[name] = {"type": "zeroGradient"}
                k[name] = {"type": "zeroGradient"}
                omega[name] = {"type": "zeroGradient"}
                nut[name] = {"type": "calculated", "value": "uniform 0"}
            else:
                U[name] = {"type": "noSlip"}
                p[name] = {"type": "zeroGradient"}
                k[name] = {"type": "kqRWallFunction", "value": f"uniform {k_str}"}
                omega[name] = {"type": "omegaWallFunction", "value": f"uniform {w_str}"}
                nut[name] = {"type": "nutkWallFunction", "value": "uniform 0"}
    return U, p, k, omega, nut


def _steady_control_dict_body(end_time: float, write_interval: float, functions_text: str) -> str:
    return f"""application     simpleFoam;
startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         {js_plain_float(float(end_time))};
deltaT          1;
writeControl    timeStep;
writeInterval   {js_plain_float(float(write_interval))};
purgeWrite      0;
writeFormat     ascii;
writePrecision  8;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable true;

functions
{{
{functions_text}
}}"""


def _steady_fv_schemes_body() -> str:
    return """ddtSchemes { default steadyState; }
gradSchemes
{
    default         Gauss linear;
    grad(U)         cellLimited Gauss linear 1;
    grad(k)         cellLimited Gauss linear 1;
    grad(omega)     cellLimited Gauss linear 1;
}
divSchemes
{
    default         none;
    div(phi,U)      bounded Gauss linearUpwind grad(U);
    div(phi,k)      bounded Gauss upwind;
    div(phi,omega)  bounded Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}
laplacianSchemes { default Gauss linear limited corrected 0.5; }
interpolationSchemes { default linear; }
snGradSchemes { default limited corrected 0.5; }
wallDist { method meshWave; }"""


def _steady_fv_solution_body() -> str:
    return """solvers
{
    p
    {
        solver          GAMG;
        tolerance       1e-7;
        relTol          0.01;
        smoother        GaussSeidel;
        nCellsInCoarsestLevel 20;
        maxIter         200;
    }
    "(U|k|omega)"
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-8;
        relTol          0.1;
        maxIter         50;
    }
}
SIMPLE
{
    nNonOrthogonalCorrectors 1;
    consistent      no;
    residualControl { p 1e-4; U 1e-4; "(k|omega)" 1e-4; }
}
relaxationFactors
{
    fields
    {
        p               0.3;
    }
    equations
    {
        U               0.7;
        k               0.7;
        omega           0.7;
    }
}"""


def _copy_polymesh(src_case: Path, out_dir: Path) -> Path | None:
    """Copy constant/polyMesh from mesh case. Returns poly dst or None if absent."""
    candidates = [
        src_case / "constant" / "polyMesh",
        src_case if (src_case / "owner").is_file() else None,
    ]
    poly_src = next((p for p in candidates if p and p.is_dir() and (p / "owner").is_file()), None)
    const = out_dir / "constant"
    const.mkdir(parents=True, exist_ok=True)
    poly_dst = const / "polyMesh"
    if poly_src is None:
        return None
    if poly_dst.exists():
        shutil.rmtree(poly_dst)
    shutil.copytree(poly_src, poly_dst)
    return poly_dst


def _clean_prior_run(out_dir: Path) -> None:
    if not out_dir.is_dir():
        return
    for child in list(out_dir.iterdir()):
        name = child.name
        is_time = child.is_dir() and re.match(r"^\d+(\.\d+)?(?:[eE][+-]?\d+)?$", name) and float(name) > 0
        is_tmp = child.is_dir() and name.startswith(".sync_")
        if is_time or is_tmp:
            shutil.rmtree(child, ignore_errors=True)
    for stale in (
        "postProcessing",
        "log.simpleFoam",
        "log.pimpleFoam",
        "log.decomposePar",
        "log.reconstructPar",
        "log.reconstructPar.live",
        "log.livesync",
    ):
        p = out_dir / stale
        if p.exists():
            if p.is_dir():
                shutil.rmtree(p, ignore_errors=True)
            else:
                p.unlink(missing_ok=True)


def write_solve_case(spec: RunSpec, out_dir: Path | str) -> dict[str, Any]:
    """Write a complete run case matching the UI prepare_run contract (steady or transient).

    Product API. write_web_solve_case is an alias. CLI/AmgX stays on write_simplefoam_case.
    """
    _ensure_web_imports()
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "0").mkdir(exist_ok=True)
    (out / "constant").mkdir(exist_ok=True)
    (out / "system").mkdir(exist_ok=True)
    _clean_prior_run(out)

    poly_dst = _copy_polymesh(Path(spec.mesh_case_dir), out)
    patch_names = _patch_names(spec, poly_dst)

    speed_ref, d_hyd = resolve_speed_and_dhyd(spec)
    # Prefer RunSpec.speed_for_k when caller already resolved it (> default)
    if spec.speed_for_k and spec.speed_for_k != 1.0:
        speed_ref = float(spec.speed_for_k)
    turb = k_omega_from_scales(speed_ref, d_hyd)
    k_str = js_to_precision(turb["k"], 6)
    w_str = js_to_precision(turb["omega"], 6)

    U, p, k, omega, nut = _build_field_patches(spec, patch_names, k_str=k_str, w_str=w_str)
    write_vol_field(
        out / "0" / "U",
        object_name="U",
        cls="volVectorField",
        dims="[0 1 -1 0 0 0 0]",
        internal="uniform (0 0 0)",
        patches=U,
    )
    write_vol_field(
        out / "0" / "p",
        object_name="p",
        cls="volScalarField",
        dims="[0 2 -2 0 0 0 0]",
        internal="uniform 0",
        patches=p,
    )
    write_vol_field(
        out / "0" / "k",
        object_name="k",
        cls="volScalarField",
        dims="[0 2 -2 0 0 0 0]",
        internal=f"uniform {k_str}",
        patches=k,
    )
    write_vol_field(
        out / "0" / "omega",
        object_name="omega",
        cls="volScalarField",
        dims="[0 0 -1 0 0 0 0]",
        internal=f"uniform {w_str}",
        patches=omega,
    )
    write_vol_field(
        out / "0" / "nut",
        object_name="nut",
        cls="volScalarField",
        dims="[0 2 -1 0 0 0 0]",
        internal="uniform 0",
        patches=nut,
    )

    # Wall functions require polyMesh type wall. gmshToFoam leftover
    # defaultFaces (prism end-caps) stay type patch unless we rewrite them.
    if poly_dst and (poly_dst / "boundary").is_file():
        from cfddesk.mesh.gmsh_standard import apply_boundary_patch_types

        wall_names = {
            n
            for n, spec in nut.items()
            if "WallFunction" in str((spec or {}).get("type") or "")
        }
        wall_names.update(
            n
            for n, spec in U.items()
            if str((spec or {}).get("type") or "") == "noSlip"
        )
        if wall_names:
            apply_boundary_patch_types(poly_dst / "boundary", {n: "wall" for n in wall_names})

    write_foam_dict(
        out / "constant" / "transportProperties",
        "dictionary",
        "transportProperties",
        f"transportModel  Newtonian;\nnu              [0 2 -1 0 0 0 0] {js_plain_float(float(spec.nu))};",
    )
    write_foam_dict(
        out / "constant" / "turbulenceProperties",
        "dictionary",
        "turbulenceProperties",
        """simulationType  RAS;
RAS
{
    RASModel        kOmegaSST;
    turbulence      on;
    printCoeffs     on;
}""",
    )

    mon_patches = list(spec.monitor_patches or [])
    functions_text = monitors_functions_text(mon_patches, transient=spec.transient)
    is_transient = spec.transient is not None

    if is_transient:
        write_control_dict_transient(
            out / "system" / "controlDict",
            ctrl=spec.transient,  # type: ignore[arg-type]
            functions_text=functions_text,
        )
        write_fv_schemes_transient(out / "system" / "fvSchemes", ctrl=spec.transient)  # type: ignore[arg-type]
        write_fv_solution_pimple(out / "system" / "fvSolution", ctrl=spec.transient)  # type: ignore[arg-type]
    else:
        write_foam_dict(
            out / "system" / "controlDict",
            "dictionary",
            "controlDict",
            _steady_control_dict_body(spec.end_time, spec.write_interval, functions_text),
        )
        write_foam_dict(
            out / "system" / "fvSchemes",
            "dictionary",
            "fvSchemes",
            _steady_fv_schemes_body(),
        )
        write_foam_dict(
            out / "system" / "fvSolution",
            "dictionary",
            "fvSolution",
            _steady_fv_solution_body(),
        )

    u_max = max(50.0, 10.0 * abs(speed_ref))
    write_fv_options_limit_u(out / "system" / "fvOptions", max_u=u_max)

    if int(spec.n_procs) > 1:
        write_foam_dict(
            out / "system" / "decomposeParDict",
            "dictionary",
            "decomposeParDict",
            f"numberOfSubdomains {int(spec.n_procs)};\nmethod          scotch;",
        )

    (out / "case.foam").write_text("", encoding="ascii")

    mapped_meta = []
    for m in spec.mapped or []:
        bc = _bc_dict(m.get("bc") or {})
        faces = bc_faces(bc)
        entry: dict[str, Any] = {
            "name": bc.get("name"),
            "bc_type": bc.get("bc_type"),
            "patch": m.get("patch"),
            "faces": faces,
            "value": bc.get("value"),
            "unit": bc.get("unit") or None,
            "face_area_m2": faces_area(faces, spec.face_props) or None,
        }
        if is_wall_bc(bc):
            entry["wall_type"] = wall_treatment(bc)
        mapped_meta.append(entry)

    sidecar = {
        "endTime": spec.end_time,
        "writeInterval": spec.write_interval,
        "nProcs": int(spec.n_procs),
        "solver": "pimpleFoam" if is_transient else "simpleFoam",
        "time_dependency": "Transient" if is_transient else "Steady-state",
        "nu": float(spec.nu),
        "rho": float(spec.rho),
        "patches": patch_names,
        "wall_default": spec.wall_default,
        "mapped": mapped_meta,
        "monitors": mon_patches,
        "turbulence": {
            "model": "kOmegaSST",
            "intensity": turb["I"],
            "length_scale_m": turb["L"],
            "hydraulic_diameter_m": d_hyd,
            "speed_ref_m_s": speed_ref,
            "k": turb["k"],
            "omega": turb["omega"],
        },
        "n_cells": spec.n_cells,
        "mesh_id": spec.mesh_id,
        "run_id": spec.run_id,
    }
    if is_transient and spec.transient is not None:
        t = spec.transient
        sidecar["transient"] = {
            "end_time": t.end_time,
            "delta_t": t.delta_t,
            "write_interval": t.write_interval,
            "adjust_time_step": t.adjust_time_step,
            "max_co": t.max_co,
            "max_delta_t": t.max_delta_t,
            "time_scheme": t.time_scheme,
            "n_outer_correctors": t.n_outer_correctors,
            "n_correctors": t.n_correctors,
            "n_non_orthogonal_correctors": t.n_non_orthogonal_correctors,
        }
    (out / "w27-case.json").write_text(json.dumps(sidecar, indent=2) + "\n", encoding="utf-8")

    return {
        "ok": True,
        "case_dir": str(out),
        "solver": sidecar["solver"],
        "n_procs": int(spec.n_procs),
        "patches": patch_names,
        "turbulence": sidecar["turbulence"],
        "polyMesh_copied": poly_dst is not None,
    }


write_web_solve_case = write_solve_case
