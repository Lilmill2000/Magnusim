"""RAS turbulence field init, wall functions, and case dict helpers (Slice 4).

Inlet formulas (mixing-length / intensity):
  I  = intensity_pct / 100
  k  = 1.5 * (U_ref * I)^2
  L  = 0.07 * D_h
  ε  = Cμ^{0.75} * k^{1.5} / L
  ω  = ε / (Cμ * k)   (= √k / (Cμ^{0.25} * L))
  νt = Cμ * k² / ε
  R  = (2/3) k * I   (isotropic Reynolds stress, OpenFOAM symmTensor)

Cyclone guidance: k-ε / SST under-predict the tangential peak in strong swirl;
LRR/SSG are the appropriate class. RSM needs a warm start from a converged
eddy-viscosity solution (k-ε → RSM) — uniform init often diverges.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from cfddesk.mesh.case_writer import _foam_header, _write_foam

TurbulenceModel = Literal["laminar", "kEpsilon", "kOmegaSST", "LRR", "SSG"]

RAS_MODELS: tuple[TurbulenceModel, ...] = (
    "kEpsilon",
    "kOmegaSST",
    "LRR",
    "SSG",
)
ALL_TURBULENCE_MODELS: tuple[TurbulenceModel, ...] = ("laminar", *RAS_MODELS)
RSM_MODELS: frozenset[str] = frozenset({"LRR", "SSG"})

C_MU = 0.09
DEFAULT_INTENSITY_PCT = 5.0
# Inlet duct bore on the vortex STEP (metres) — used when no measured Dh.
DEFAULT_HYDRAULIC_DIAMETER_M = 0.0508


@dataclass(frozen=True)
class TurbulenceScalars:
    k: float
    epsilon: float
    omega: float
    nut: float
    intensity: float
    L: float
    U_ref: float
    D_h: float

    @property
    def R_diag(self) -> float:
        return (2.0 / 3.0) * self.k


def inlet_turbulence_scalars(
    U_ref: float,
    *,
    intensity_pct: float = DEFAULT_INTENSITY_PCT,
    D_h: float = DEFAULT_HYDRAULIC_DIAMETER_M,
) -> TurbulenceScalars:
    """Compute k, ε, ω, νt from inlet speed, intensity, and hydraulic diameter."""
    U = abs(float(U_ref))
    intensity = max(float(intensity_pct), 0.01) / 100.0
    Dh = max(float(D_h), 1e-6)
    L = 0.07 * Dh
    k = 1.5 * (U * intensity) ** 2
    k = max(k, 1e-12)
    eps = (C_MU**0.75) * (k**1.5) / L
    eps = max(eps, 1e-12)
    omega = eps / (C_MU * k)
    omega = max(omega, 1e-12)
    nut = C_MU * k * k / eps
    return TurbulenceScalars(
        k=k,
        epsilon=eps,
        omega=omega,
        nut=nut,
        intensity=intensity,
        L=L,
        U_ref=U,
        D_h=Dh,
    )


def _scalar_field(
    *,
    object_name: str,
    dimensions: str,
    internal: float,
    patches: list[tuple[str, str]],
) -> str:
    """``patches``: list of (patch_name, indented body without outer braces)."""
    blocks = []
    for name, body in patches:
        blocks.append(f"    {name}\n    {{\n{body}    }}")
    bf = "\n".join(blocks)
    return f"""FoamFile
{{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      {object_name};
}}
dimensions      {dimensions};
internalField   uniform {internal:g};
boundaryField
{{
{bf}
}}
"""


def _patches_by_semantic(
    patch_semantics: dict[str, str] | None,
) -> dict[str, list[str]]:
    """Group patch names by semantic class; default classic inlet/outlet/walls."""
    if not patch_semantics:
        return {
            "inlet": ["inlet"],
            "outlet": ["outlet"],
            "wall": ["walls"],
            "open": [],
            "symmetry": [],
            "empty": [],
            "wedge": [],
            "custom": [],
        }
    groups: dict[str, list[str]] = {
        "inlet": [],
        "outlet": [],
        "wall": [],
        "open": [],
        "symmetry": [],
        "empty": [],
        "wedge": [],
        "custom": [],
    }
    for name, sem in patch_semantics.items():
        groups.setdefault(sem, []).append(name)
    return groups


def _ras_boundary_blocks(
    s: TurbulenceScalars,
    *,
    field: str,
    patch_semantics: dict[str, str] | None,
) -> list[tuple[str, str]]:
    """Build (patch_name, body) for a RAS scalar / R field."""
    groups = _patches_by_semantic(patch_semantics)
    out: list[tuple[str, str]] = []

    def inlet_body() -> str:
        if field == "nut":
            return (
                "        type            calculated;\n"
                f"        value           uniform {s.nut:g};\n"
            )
        if field == "R":
            d = s.R_diag
            r = f"({d:g} 0 0 {d:g} 0 {d:g})"
            return (
                "        type            fixedValue;\n"
                f"        value           uniform {r};\n"
            )
        val = {"k": s.k, "epsilon": s.epsilon, "omega": s.omega}[field]
        return (
            "        type            fixedValue;\n"
            f"        value           uniform {val:g};\n"
        )

    def outlet_body() -> str:
        if field == "nut":
            return (
                "        type            calculated;\n"
                f"        value           uniform {s.nut:g};\n"
            )
        if field == "R":
            d = s.R_diag
            r = f"({d:g} 0 0 {d:g} 0 {d:g})"
            return (
                "        type            inletOutlet;\n"
                "        inletValue      uniform (0 0 0 0 0 0);\n"
                f"        value           uniform {r};\n"
            )
        val = {"k": s.k, "epsilon": s.epsilon, "omega": s.omega}[field]
        return (
            "        type            inletOutlet;\n"
            "        inletValue      uniform 1e-10;\n"
            f"        value           uniform {val:g};\n"
        )

    def wall_body() -> str:
        if field == "nut":
            return (
                "        type            nutkWallFunction;\n"
                f"        value           uniform {s.nut:g};\n"
            )
        if field == "R":
            d = s.R_diag
            r = f"({d:g} 0 0 {d:g} 0 {d:g})"
            return (
                "        type            kqRWallFunction;\n"
                f"        value           uniform {r};\n"
            )
        if field == "k":
            return (
                "        type            kqRWallFunction;\n"
                f"        value           uniform {s.k:g};\n"
            )
        if field == "epsilon":
            return (
                "        type            epsilonWallFunction;\n"
                f"        value           uniform {s.epsilon:g};\n"
            )
        return (
            "        type            omegaWallFunction;\n"
            f"        value           uniform {s.omega:g};\n"
        )

    def constraint_body(ctype: str) -> str:
        return f"        type            {ctype};\n"

    for name in groups["inlet"]:
        out.append((name, inlet_body()))
    for name in groups["outlet"] + groups["open"]:
        out.append((name, outlet_body()))
    for name in groups["wall"]:
        out.append((name, wall_body()))
    for name in groups["symmetry"]:
        out.append((name, constraint_body("symmetry")))
    for name in groups["empty"]:
        out.append((name, constraint_body("empty")))
    for name in groups["wedge"]:
        out.append((name, constraint_body("wedge")))
    for name in groups["custom"]:
        # Safe default for custom mesh patches
        if field == "nut":
            out.append(
                (
                    name,
                    "        type            calculated;\n"
                    f"        value           uniform {s.nut:g};\n",
                )
            )
        else:
            out.append((name, "        type            zeroGradient;\n"))
    return out


def write_k(
    path: Path,
    s: TurbulenceScalars,
    *,
    patch_semantics: dict[str, str] | None = None,
) -> None:
    _write_foam(
        path,
        _scalar_field(
            object_name="k",
            dimensions="[0 2 -2 0 0 0 0]",
            internal=s.k,
            patches=_ras_boundary_blocks(s, field="k", patch_semantics=patch_semantics),
        ),
    )


def write_epsilon(
    path: Path,
    s: TurbulenceScalars,
    *,
    patch_semantics: dict[str, str] | None = None,
) -> None:
    _write_foam(
        path,
        _scalar_field(
            object_name="epsilon",
            dimensions="[0 2 -3 0 0 0 0]",
            internal=s.epsilon,
            patches=_ras_boundary_blocks(
                s, field="epsilon", patch_semantics=patch_semantics
            ),
        ),
    )


def write_omega(
    path: Path,
    s: TurbulenceScalars,
    *,
    patch_semantics: dict[str, str] | None = None,
) -> None:
    _write_foam(
        path,
        _scalar_field(
            object_name="omega",
            dimensions="[0 0 -1 0 0 0 0]",
            internal=s.omega,
            patches=_ras_boundary_blocks(
                s, field="omega", patch_semantics=patch_semantics
            ),
        ),
    )


def write_nut(
    path: Path,
    s: TurbulenceScalars,
    *,
    patch_semantics: dict[str, str] | None = None,
) -> None:
    _write_foam(
        path,
        _scalar_field(
            object_name="nut",
            dimensions="[0 2 -1 0 0 0 0]",
            internal=s.nut,
            patches=_ras_boundary_blocks(
                s, field="nut", patch_semantics=patch_semantics
            ),
        ),
    )


def write_R(
    path: Path,
    s: TurbulenceScalars,
    *,
    patch_semantics: dict[str, str] | None = None,
) -> None:
    """Isotropic Reynolds-stress tensor (OpenFOAM symmTensor: xx xy xz yy yz zz)."""
    d = s.R_diag
    r = f"({d:g} 0 0 {d:g} 0 {d:g})"
    patches = _ras_boundary_blocks(s, field="R", patch_semantics=patch_semantics)
    blocks = []
    for name, body in patches:
        blocks.append(f"    {name}\n    {{\n{body}    }}")
    bf = "\n".join(blocks)
    text = f"""FoamFile
{{
    version     2.0;
    format      ascii;
    class       volSymmTensorField;
    object      R;
}}
dimensions      [0 2 -2 0 0 0 0];
internalField   uniform {r};
boundaryField
{{
{bf}
}}
"""
    _write_foam(path, text)


def write_turbulence_properties(path: Path, model: TurbulenceModel) -> None:
    if model == "laminar":
        body = "simulationType  laminar;\n"
    else:
        body = (
            "simulationType  RAS;\n"
            "\n"
            "RAS\n"
            "{\n"
            f"    RASModel        {model};\n"
            "    turbulence      on;\n"
            "    printCoeffs     on;\n"
            "}\n"
        )
    _write_foam(path, _foam_header("turbulenceProperties") + f"\n{body}\n")


def write_ras_fields(
    case_dir: Path,
    model: TurbulenceModel,
    *,
    U_ref: float,
    intensity_pct: float,
    D_h: float = DEFAULT_HYDRAULIC_DIAMETER_M,
    patch_semantics: dict[str, str] | None = None,
    internal_overrides: dict[str, float] | None = None,
) -> TurbulenceScalars | None:
    """Write 0/ turbulence fields for ``model``; remove leftover RAS files."""
    zero = Path(case_dir) / "0"
    zero.mkdir(parents=True, exist_ok=True)
    # Drop fields from a previous model so sync does not leave orphans.
    for name in ("k", "epsilon", "omega", "nut", "R"):
        p = zero / name
        if p.is_file():
            p.unlink()

    if model == "laminar":
        return None

    s = inlet_turbulence_scalars(
        U_ref, intensity_pct=intensity_pct, D_h=D_h
    )
    ov = internal_overrides or {}
    if ov:
        # Rebuild scalars with IC globals for internalField; inlet BC values stay derived.
        s = TurbulenceScalars(
            k=float(ov.get("k", s.k)),
            epsilon=float(ov.get("epsilon", s.epsilon)),
            omega=float(ov.get("omega", s.omega)),
            nut=s.nut,
            intensity=s.intensity,
            L=s.L,
            U_ref=s.U_ref,
            D_h=s.D_h,
        )
    write_k(zero / "k", s, patch_semantics=patch_semantics)
    write_nut(zero / "nut", s, patch_semantics=patch_semantics)
    if model == "kOmegaSST":
        write_omega(zero / "omega", s, patch_semantics=patch_semantics)
    else:
        # kEpsilon, LRR, SSG
        write_epsilon(zero / "epsilon", s, patch_semantics=patch_semantics)
    if model in RSM_MODELS:
        write_R(zero / "R", s, patch_semantics=patch_semantics)
    return s


def fv_schemes_div_extra(model: TurbulenceModel) -> str:
    if model == "laminar":
        return ""
    lines = [
        "    div(phi,k)      bounded Gauss upwind;",
        "    div(phi,epsilon) bounded Gauss upwind;",
        "    div(phi,omega)  bounded Gauss upwind;",
        "    div(phi,R)      bounded Gauss upwind;",
        "    div(R)          Gauss linear;",
    ]
    return "\n".join(lines) + "\n"


def fv_solution_turbulence_block(model: TurbulenceModel) -> tuple[str, str, str]:
    """Return (solvers_extra, residual_extra, relax_eq_extra)."""
    if model == "laminar":
        return "", "", ""
    solver = """    "(k|epsilon|omega|R)"
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-8;
        relTol          0.1;
    }
"""
    residual = ""
    if model == "kOmegaSST":
        relax = "        k               0.7;\n        omega           0.7;\n"
    elif model in RSM_MODELS:
        relax = (
            "        k               0.5;\n"
            "        epsilon         0.5;\n"
            "        R               0.5;\n"
        )
    else:
        relax = "        k               0.7;\n        epsilon         0.7;\n"
    return solver, residual, relax


def model_needs_warm_start(model: TurbulenceModel) -> bool:
    return model in RSM_MODELS


# High-Re wall functions (k-ε / RSM kqR+epsilon WF) expect y+ ≳ 30.
HIGH_RE_YPLUS_MIN = 30.0
# Flag when this fraction of wall faces sits below the model's valid band.
YPLUS_INVALID_FRAC_WARN = 0.05

# Models that use standard high-Re wall functions (invalid at low y+).
HIGH_RE_WALL_MODELS: frozenset[str] = frozenset({"kEpsilon", "LRR", "SSG"})
# Blended / automatic wall treatment — low y+ is acceptable.
BLENDED_WALL_MODELS: frozenset[str] = frozenset({"kOmegaSST"})


def yplus_geometry_note() -> str:
    """Always-true guidance for this cyclone: spread tracks wall shear, not mesh bugs."""
    return (
        "y+ spread on this geometry is expected: a fast inlet and a stagnant "
        "collection bin sit at opposite ends of wall shear on the same mesh — "
        "not by itself a mesh defect."
    )


def interpret_yplus(
    model: str,
    *,
    min_yp: float | None,
    mean_yp: float | None,
    max_yp: float | None,
    frac_below_30: float | None = None,
) -> tuple[str | None, str | None]:
    """Return ``(warning, note)``.

    ``warning`` — selected model's wall treatment is invalid on a meaningful
    wall-face fraction (name the model). ``note`` — informational (e.g. SST
    handles low y+; coarse max y+).
    """
    if min_yp is None and mean_yp is None and max_yp is None:
        return None, None
    m = mean_yp if mean_yp is not None else 0.0
    mx = max_yp if max_yp is not None else 0.0
    mn = min_yp if min_yp is not None else 0.0
    frac = frac_below_30

    if model in HIGH_RE_WALL_MODELS:
        invalid = False
        if frac is not None and frac >= YPLUS_INVALID_FRAC_WARN:
            invalid = True
        elif frac is None and mn < HIGH_RE_YPLUS_MIN and m < 50.0:
            invalid = True
        warn = None
        note = None
        if invalid:
            pct = f"{100.0 * frac:.0f}%" if frac is not None else "part"
            warn = (
                f"{model}: standard high-Re wall functions need y+ ≳ 30; "
                f"~{pct} of wall faces are below that (min={mn:.3g}) — "
                f"wall treatment invalid there. Prefer kOmegaSST on this mesh, "
                f"or refine/coarsen locally; the low end is often the bin, not "
                f"a global mesh failure."
            )
        if mx > 500:
            note = (
                f"{model}: max y+={mx:.3g} is high — first cell may be coarse "
                f"in high-shear regions (inlet)."
            )
        return warn, note

    if model in BLENDED_WALL_MODELS:
        notes: list[str] = []
        if mn < HIGH_RE_YPLUS_MIN:
            notes.append(
                f"{model}: blended wall treatment is valid at low y+ "
                f"(min={mn:.3g}); low values near the collection bin are expected."
            )
        if mx > 500:
            notes.append(
                f"{model}: max y+={mx:.3g} is coarse in high-shear regions."
            )
        return None, (" ".join(notes) if notes else None)

    if model == "laminar":
        return None, "laminar: y+ is informational only (no wall functions)."

    if m < 15.0 or mx < 1.0:
        return (
            f"{model}: y+ looks low for high-Re wall functions "
            f"(mean={m:.2g}, max={mx:.2g}).",
            None,
        )
    return None, None
