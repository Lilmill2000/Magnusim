"""Numerics + simulation-control settings (Phase 4).

Defaults match Researcher still (inc21b residual Abs tol 1e-6; inc21c Solvers
nested defaults). Solver Absolute tolerances are DISTINCT from residual Absolute
tolerance (U/k/omega solver Abs 1e-8, P solver Abs 1e-6 vs residual Abs 1e-6).
Schemes UI (inc24a persist; inc24a.1 writer wire) from numerics-form-schemes-expanded.txt; writer flats synced from Schemes via map_*_ui_to_of / sync_schemes_to_writer_flats (no UI/writer drift).
``SolverSettings.backend`` remains authoritative for AmgX vs CPU — see PHASE4-NOTES.md.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from cfddesk.case.ras import TurbulenceModel

PSolver = Literal["GAMG", "PBiCGStab", "amgx"]
USolver = Literal["smoothSolver", "PBiCGStab"]
DecomposeMethod = Literal["scotch", "hierarchical", "simple"]
CpuMode = Literal["automatic", "manual"]


@dataclass
class PBiCGStabRowSettings:
    """Still nested defaults for PBiCGStab solver rows (U / k / omega).

    absolute_tolerance here is the *solver* Abs tol (still 1e-8) — NOT residual
    controls Absolute tolerance (still 1e-6).
    """

    solver_type: str = "PBiCGStab"
    absolute_tolerance: float = 1e-8
    relative_tolerance: float = 0.01
    preconditioner: str = "DILU"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_dict(data: dict | None) -> "PBiCGStabRowSettings":
        if not data:
            return PBiCGStabRowSettings()
        d = dict(data)
        st = str(d.get("solver_type", "PBiCGStab") or "PBiCGStab")
        if st not in ("PBiCGStab", "smoothSolver"):
            st = "PBiCGStab"
        pc = str(d.get("preconditioner", "DILU") or "DILU")
        if pc not in ("DILU",):
            pc = "DILU"
        return PBiCGStabRowSettings(
            solver_type=st,
            absolute_tolerance=float(d.get("absolute_tolerance", 1e-8)),
            relative_tolerance=float(d.get("relative_tolerance", 0.01)),
            preconditioner=pc,
        )


@dataclass
class GAMGRowSettings:
    """Still nested defaults for GAMG pressure solver row.

    absolute_tolerance here is the *solver* Abs tol (still 1e-6) — DISTINCT field
    from residual controls Absolute tolerance (also 1e-6 numerically, separate key).
    """

    solver_type: str = "GAMG"
    absolute_tolerance: float = 1e-6
    relative_tolerance: float = 0.001
    smoother: str = "Gauss-Seidel"
    n_pre_sweeps: int = 2
    n_post_sweeps: int = 1
    cache_agglomeration: bool = True  # still: enabled (on)
    n_cells_coarsest: int = 100
    n_merge_levels: int = 1

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_dict(data: dict | None) -> "GAMGRowSettings":
        if not data:
            return GAMGRowSettings()
        d = dict(data)
        st = str(d.get("solver_type", "GAMG") or "GAMG")
        if st not in ("GAMG", "PBiCGStab", "amgx"):
            st = "GAMG"
        sm = str(d.get("smoother", "Gauss-Seidel") or "Gauss-Seidel")
        if sm in ("GaussSeidel", "gauss-seidel", "Gauss Seidel"):
            sm = "Gauss-Seidel"
        if sm not in ("Gauss-Seidel",):
            sm = "Gauss-Seidel"
        cache = d.get("cache_agglomeration", True)
        if isinstance(cache, str):
            cache = cache.strip().lower() in ("1", "true", "on", "enabled", "enabled (on)", "yes")
        else:
            cache = bool(cache)
        return GAMGRowSettings(
            solver_type=st,
            absolute_tolerance=float(d.get("absolute_tolerance", 1e-6)),
            relative_tolerance=float(d.get("relative_tolerance", 0.001)),
            smoother=sm,
            n_pre_sweeps=int(d.get("n_pre_sweeps", 2)),
            n_post_sweeps=int(d.get("n_post_sweeps", 1)),
            cache_agglomeration=cache,
            n_cells_coarsest=int(d.get("n_cells_coarsest", 100)),
            n_merge_levels=int(d.get("n_merge_levels", 1)),
        )




# --- Inc24a.1: Schemes UI → OpenFOAM fvSchemes mapping -----------------------
# Documented mapping (UI still label → OF dictionary token). SimScale "Gauss
# linear upwind v ∇U" is documented as second-order upwind/bounded →
# ``bounded Gauss linearUpwindV grad(U)``.

_NABLA_U_UI = "Gauss linear upwind v \u2207U"


def map_time_scheme_ui_to_of(ui: str) -> str:
    """Time differentiation UI → ddtSchemes default."""
    t = str(ui or "").strip()
    if t in ("Steady-state", "steadyState", "steady state"):
        return "steadyState"
    if t in ("Euler",):
        return "Euler"
    return "steadyState"


def map_gradient_scheme_ui_to_of(scheme: str, limiter_coefficient: float) -> str:
    """Gradient UI scheme + limiter → gradSchemes entry value."""
    s = str(scheme or "").strip()
    lim = float(limiter_coefficient)
    # Prefer compact float repr (1.0 → 1, 0.5 → 0.5)
    lim_s = ("%g" % lim)
    table = {
        "Celllimited leastSquares": f"cellLimited leastSquares {lim_s}",
        "Celllimited Gauss linear": f"cellLimited Gauss linear {lim_s}",
        "Gauss linear": "Gauss linear",
        "Least squares": "leastSquares",
        "Fourth gradient": "fourth",
    }
    return table.get(s, f"cellLimited leastSquares {lim_s}")


def map_divergence_scheme_ui_to_of(ui: str) -> str:
    """Divergence UI label → divSchemes entry value."""
    s = str(ui or "").strip()
    # Normalize chrome/encoding variants of nabla-U still string.
    if s in (
        _NABLA_U_UI,
        "Gauss linear upwind v U",
        "Gauss linear upwind v grad(U)",
    ) or ("linear upwind v" in s.lower() and "unlimited" not in s.lower()):
        # Still: "Gauss linear upwind v ∇U" — SimScale docs: bounded 2nd-order.
        if "unlimited" not in s.lower() and "limited grad" not in s.lower():
            if s == _NABLA_U_UI or "\u2207" in s or s.endswith("v U") or "v grad(U)" in s:
                return "bounded Gauss linearUpwindV grad(U)"
            if "linear upwind v" in s.lower():
                return "bounded Gauss linearUpwindV grad(U)"
    table = {
        "Gauss linear": "Gauss linear",
        "Bounded Gauss upwind": "bounded Gauss upwind",
        "Gauss upwind": "Gauss upwind",
        "Gauss vanLeer": "Gauss vanLeer",
        "Gauss limited linear 1": "Gauss limitedLinear 1",
        "Gauss limited linear": "Gauss limitedLinear 1",
        "Gauss linear upwind unlimited": "Gauss linearUpwind grad(U)",
        "Gauss linear upwind v unlimited": "Gauss linearUpwindV grad(U)",
        "Gauss linear upwind limited grad": "Gauss linearUpwind limited grad(U)",
        _NABLA_U_UI: "bounded Gauss linearUpwindV grad(U)",
    }
    return table.get(s, "bounded Gauss linearUpwindV grad(U)")


def map_laplacian_scheme_ui_to_of(scheme: str, limiter_coefficient: float) -> str:
    """Laplacian UI scheme + limiter → laplacianSchemes entry value."""
    s = str(scheme or "").strip()
    lim_s = ("%g" % float(limiter_coefficient))
    if s == "Gauss linear limited corrected":
        return f"Gauss linear limited corrected {lim_s}"
    if s == "Gauss linear corrected":
        return "Gauss linear corrected"
    if s == "Gauss linear uncorrected":
        return "Gauss linear uncorrected"
    return f"Gauss linear limited corrected {lim_s}"


def map_interpolation_scheme_ui_to_of(ui: str) -> str:
    s = str(ui or "").strip()
    table = {"Linear": "linear", "Cubic": "cubic", "linear": "linear", "cubic": "cubic"}
    return table.get(s, "linear")


def map_sn_grad_scheme_ui_to_of(scheme: str, limiter_coefficient: float) -> str:
    s = str(scheme or "").strip()
    lim_s = ("%g" % float(limiter_coefficient))
    if s == "Limited":
        return f"limited {lim_s}"
    if s in ("Corrected", "corrected"):
        return "corrected"
    if s in ("Uncorrected", "uncorrected"):
        return "uncorrected"
    return f"limited {lim_s}"


# Canonical UI→OF rows for banked expanded.txt (DA-verifiable).
SCHEMES_UI_TO_OF_MAPPING_TABLE: list[dict[str, str]] = [
    {"ui": "Steady-state", "of": "steadyState", "slot": "ddtSchemes.default"},
    {
        "ui": "Celllimited leastSquares; Limiter coefficient: 1",
        "of": "cellLimited leastSquares 1",
        "slot": "gradSchemes.default / grad(p) / grad(U)",
    },
    {"ui": "Gauss linear", "of": "Gauss linear", "slot": "divSchemes.default"},
    {
        "ui": "Gauss linear upwind v \u2207U",
        "of": "bounded Gauss linearUpwindV grad(U)",
        "slot": "divSchemes.div(phi,U)",
        "note": "SimScale docs: bounded 2nd-order linearUpwindV; grad(U) names the gradient scheme used by the convection scheme",
    },
    {
        "ui": "Bounded Gauss upwind",
        "of": "bounded Gauss upwind",
        "slot": "divSchemes.div(phi,k) / div(phi,omega)",
    },
    {
        "ui": "Gauss linear limited corrected; Limiter coefficient: 0.5",
        "of": "Gauss linear limited corrected 0.5",
        "slot": "laplacianSchemes.default + named",
    },
    {"ui": "Linear", "of": "linear", "slot": "interpolationSchemes.default / interpolate(HbyA)"},
    {
        "ui": "Limited; Limiter coefficient: 0.5",
        "of": "limited 0.5",
        "slot": "snGradSchemes.default",
    },
]


@dataclass
class GradientSchemeEntry:
    """Gradient scheme row — still: Celllimited leastSquares; Limiter coefficient: 1."""

    scheme: str = "Celllimited leastSquares"
    limiter_coefficient: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_dict(data: dict | None) -> "GradientSchemeEntry":
        if not data:
            return GradientSchemeEntry()
        d = dict(data)
        scheme = str(d.get("scheme", "Celllimited leastSquares") or "Celllimited leastSquares")
        allowed = {
            "Gauss linear",
            "Celllimited Gauss linear",
            "Celllimited leastSquares",
            "Fourth gradient",
            "Least squares",
        }
        if scheme not in allowed:
            scheme = "Celllimited leastSquares"
        return GradientSchemeEntry(
            scheme=scheme,
            limiter_coefficient=float(d.get("limiter_coefficient", 1.0)),
        )


@dataclass
class LaplacianSchemeEntry:
    """Laplacian scheme row — still: Gauss linear limited corrected; Limiter 0.5."""

    scheme: str = "Gauss linear limited corrected"
    limiter_coefficient: float = 0.5

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_dict(data: dict | None) -> "LaplacianSchemeEntry":
        if not data:
            return LaplacianSchemeEntry()
        d = dict(data)
        scheme = str(
            d.get("scheme", "Gauss linear limited corrected") or "Gauss linear limited corrected"
        )
        allowed = {
            "Gauss linear corrected",
            "Gauss linear limited corrected",
            "Gauss linear uncorrected",
        }
        if scheme not in allowed:
            scheme = "Gauss linear limited corrected"
        return LaplacianSchemeEntry(
            scheme=scheme,
            limiter_coefficient=float(d.get("limiter_coefficient", 0.5)),
        )


@dataclass
class SchemesSettings:
    """Numerics Schemes UI persist blob — defaults from numerics-form-schemes-expanded.txt.

    Exact still label strings (TXT wins over truncated dropdown chrome).
    OpenFOAM writer flat fields are synced from this blob (inc24a.1); legacy note was (ddt_default / grad_default / …) remain separate
    writer-parity strings; Schemes here is persist-only for the Numerics form.
    """

    # Time differentiation
    time_default: str = "Steady-state"

    # Gradient
    gradient_default: GradientSchemeEntry = field(default_factory=GradientSchemeEntry)
    grad_p: GradientSchemeEntry = field(default_factory=GradientSchemeEntry)
    grad_U: GradientSchemeEntry = field(default_factory=GradientSchemeEntry)

    # Divergence — div(phi,U) exact: "Gauss linear upwind v ∇U"
    divergence_default: str = "Gauss linear"
    div_phi_U: str = "Gauss linear upwind v \u2207U"
    div_phi_k: str = "Bounded Gauss upwind"
    div_phi_omega: str = "Bounded Gauss upwind"

    # Laplacian
    laplacian_default: LaplacianSchemeEntry = field(default_factory=LaplacianSchemeEntry)
    laplacian_nuEff_U: LaplacianSchemeEntry = field(default_factory=LaplacianSchemeEntry)
    laplacian_1AU_p: LaplacianSchemeEntry = field(default_factory=LaplacianSchemeEntry)
    laplacian_nu_U: LaplacianSchemeEntry = field(default_factory=LaplacianSchemeEntry)

    # Interpolation
    interpolation_default: str = "Linear"
    interpolate_HbyA: str = "Linear"

    # Surface normal gradient
    sn_grad_default: str = "Limited"
    sn_grad_limiter_coefficient: float = 0.5

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_dict(data: dict | None) -> "SchemesSettings":
        if not data:
            return SchemesSettings()
        d = dict(data)
        nabla_u = "Gauss linear upwind v \u2207U"
        # Accept ascii fallback "v U" / "v grad(U)" only as legacy; coerce to still TXT.
        div_u = str(d.get("div_phi_U", nabla_u) or nabla_u)
        if div_u in (
            "Gauss linear upwind v U",
            "Gauss linear upwind v grad(U)",
            "Gauss linear upwind v ∇U",  # may already be correct depending on source
        ):
            # If chrome truncated nabla away, restore expanded.txt verbatim.
            if "\u2207" not in div_u and "∇" not in div_u:
                div_u = nabla_u
            else:
                div_u = nabla_u
        # Always prefer exact still string when semantically matching upwind-v-U family default
        if div_u.replace("∇", "\u2207") == nabla_u or div_u == "Gauss linear upwind v \u2207U":
            div_u = nabla_u

        time_default = str(d.get("time_default", "Steady-state") or "Steady-state")
        if time_default not in ("Steady-state",):
            time_default = "Steady-state"

        div_def = str(d.get("divergence_default", "Gauss linear") or "Gauss linear")
        div_def_allowed = {"Gauss linear", "Gauss linear upwind v unlimited"}
        if div_def not in div_def_allowed:
            div_def = "Gauss linear"

        div_u_allowed = {
            "Gauss linear",
            "Gauss linear upwind v unlimited",
            "Gauss linear upwind unlimited",
            "Gauss linear upwind limited grad",
            "Gauss limited linear 1",
            "Gauss limited linear",
            "Bounded Gauss upwind",
            "Gauss upwind",
            "Gauss vanLeer",
            nabla_u,
        }
        if div_u not in div_u_allowed:
            div_u = nabla_u

        turb_allowed = {
            "Gauss linear",
            "Gauss linear upwind unlimited",
            "Gauss linear upwind limited grad",
            "Gauss limited linear 1",
            "Bounded Gauss upwind",
            "Gauss upwind",
            "Gauss vanLeer",
        }
        div_k = str(d.get("div_phi_k", "Bounded Gauss upwind") or "Bounded Gauss upwind")
        if div_k not in turb_allowed:
            div_k = "Bounded Gauss upwind"
        div_o = str(d.get("div_phi_omega", "Bounded Gauss upwind") or "Bounded Gauss upwind")
        if div_o not in turb_allowed:
            div_o = "Bounded Gauss upwind"

        interp_allowed = {"Cubic", "Linear"}
        interp_def = str(d.get("interpolation_default", "Linear") or "Linear")
        if interp_def not in interp_allowed:
            interp_def = "Linear"
        interp_h = str(d.get("interpolate_HbyA", "Linear") or "Linear")
        if interp_h not in interp_allowed:
            interp_h = "Linear"

        sn_allowed = {"Corrected", "Uncorrected", "Limited"}
        sn = str(d.get("sn_grad_default", "Limited") or "Limited")
        if sn not in sn_allowed:
            sn = "Limited"

        def _g(key: str) -> GradientSchemeEntry:
            raw = d.get(key)
            return GradientSchemeEntry.from_dict(raw if isinstance(raw, dict) else None)

        def _l(key: str) -> LaplacianSchemeEntry:
            raw = d.get(key)
            return LaplacianSchemeEntry.from_dict(raw if isinstance(raw, dict) else None)

        return SchemesSettings(
            time_default=time_default,
            gradient_default=_g("gradient_default"),
            grad_p=_g("grad_p"),
            grad_U=_g("grad_U"),
            divergence_default=div_def,
            div_phi_U=div_u,
            div_phi_k=div_k,
            div_phi_omega=div_o,
            laplacian_default=_l("laplacian_default"),
            laplacian_nuEff_U=_l("laplacian_nuEff_U"),
            laplacian_1AU_p=_l("laplacian_1AU_p"),
            laplacian_nu_U=_l("laplacian_nu_U"),
            interpolation_default=interp_def,
            interpolate_HbyA=interp_h,
            sn_grad_default=sn,
            sn_grad_limiter_coefficient=float(d.get("sn_grad_limiter_coefficient", 0.5)),
        )


@dataclass
class NumericsSettings:
    """fvSolution + fvSchemes surfaced as a form."""

    relaxation_type: str = "manual"  # still: Manual
    n_non_orthogonal: int = 1
    p_ref_cell: int = 0
    # Pa — converted to kinematic at case write via assigned material ρ.
    p_ref_value_pa: float = 0.0
    residual_u: float = 1e-6
    residual_p: float = 1e-6
    # k Abs tol on still (1e-6). omega Abs tol 1e-6 (numerics-form-omega-residual still).
    residual_k: float | None = 1e-6
    residual_omega: float | None = 1e-6
    residual_epsilon: float | None = None
    # Legacy flat solver-type keys — kept in sync with solver_* rows for writer.
    # Still defaults: U/k/omega PBiCGStab, P GAMG (inc21c).
    u_solver: USolver = "PBiCGStab"
    # CPU pressure solver when backend is cpu. When backend is amgx, UI shows amgx.
    p_solver: PSolver = "GAMG"
    turb_solver: USolver = "PBiCGStab"
    relax_p: float = 0.3
    relax_u: float = 0.7
    relax_k: float = 0.7
    relax_omega: float = 0.7
    relax_epsilon: float = 0.7
    relax_r: float = 0.5
    # OpenFOAM writer scheme flats — synced from nested `schemes` (inc24a.1).
    ddt_default: str = "steadyState"
    grad_default: str = "cellLimited leastSquares 1"
    div_phi_u: str = "bounded Gauss linearUpwindV grad(U)"
    div_nu_eff: str = "Gauss linear"
    laplacian_default: str = "Gauss linear limited corrected 0.5"
    interpolation_default: str = "linear"
    sn_grad_default: str = "limited 0.5"
    wall_dist_method: str = "meshWave"
    # Inc21c Solvers section — nested still defaults (persist-only).
    solver_u: PBiCGStabRowSettings = field(default_factory=PBiCGStabRowSettings)
    solver_p: GAMGRowSettings = field(default_factory=GAMGRowSettings)
    solver_k: PBiCGStabRowSettings = field(default_factory=PBiCGStabRowSettings)
    solver_omega: PBiCGStabRowSettings = field(default_factory=PBiCGStabRowSettings)
    # Inc24a/24a.1 Schemes — nested still defaults; writer flats synced from schemes.
    schemes: SchemesSettings = field(default_factory=SchemesSettings)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d

    def sync_legacy_solver_types(self) -> None:
        """Keep flat u_solver / p_solver / turb_solver aligned with nested rows."""
        ust = self.solver_u.solver_type
        if ust in ("smoothSolver", "PBiCGStab"):
            self.u_solver = ust  # type: ignore[assignment]
        pst = self.solver_p.solver_type
        if pst in ("GAMG", "PBiCGStab", "amgx"):
            self.p_solver = pst  # type: ignore[assignment]
        kst = self.solver_k.solver_type
        if kst in ("smoothSolver", "PBiCGStab"):
            self.turb_solver = kst  # type: ignore[assignment]


    def sync_schemes_to_writer_flats(self) -> "NumericsSettings":
        """Inc24a.1 — Schemes UI is authoritative; push mapped OF tokens into writer flats.

        Named entries (grad(p), laplacian(nuEff,U), …) are emitted by
        :func:`cfddesk.case.writer.write_fv_schemes` from ``self.schemes`` directly;
        flats cover the historical default slots the writer already consumed.
        """
        s = self.schemes if isinstance(self.schemes, SchemesSettings) else SchemesSettings()
        self.schemes = s
        self.ddt_default = map_time_scheme_ui_to_of(s.time_default)
        self.grad_default = map_gradient_scheme_ui_to_of(
            s.gradient_default.scheme, s.gradient_default.limiter_coefficient
        )
        self.div_phi_u = map_divergence_scheme_ui_to_of(s.div_phi_U)
        self.laplacian_default = map_laplacian_scheme_ui_to_of(
            s.laplacian_default.scheme, s.laplacian_default.limiter_coefficient
        )
        self.interpolation_default = map_interpolation_scheme_ui_to_of(
            s.interpolation_default
        )
        self.sn_grad_default = map_sn_grad_scheme_ui_to_of(
            s.sn_grad_default, s.sn_grad_limiter_coefficient
        )
        return self

    @staticmethod
    def from_dict(data: dict | None) -> NumericsSettings:
        if not data:
            return NumericsSettings()
        d = dict(data)
        # Nested solver rows (inc21c). Fall back to legacy flat keys when absent.
        su_raw = d.get("solver_u")
        if isinstance(su_raw, dict):
            solver_u = PBiCGStabRowSettings.from_dict(su_raw)
        else:
            u_legacy = d.get("u_solver", "PBiCGStab")
            if u_legacy not in ("smoothSolver", "PBiCGStab"):
                u_legacy = "PBiCGStab"
            solver_u = PBiCGStabRowSettings(solver_type=str(u_legacy))

        sp_raw = d.get("solver_p")
        if isinstance(sp_raw, dict):
            solver_p = GAMGRowSettings.from_dict(sp_raw)
        else:
            p_legacy = d.get("p_solver", "GAMG")
            if p_legacy not in ("GAMG", "PBiCGStab", "amgx"):
                p_legacy = "GAMG"
            solver_p = GAMGRowSettings(solver_type=str(p_legacy))

        sk_raw = d.get("solver_k")
        if isinstance(sk_raw, dict):
            solver_k = PBiCGStabRowSettings.from_dict(sk_raw)
        else:
            t_legacy = d.get("turb_solver", "PBiCGStab")
            if t_legacy not in ("smoothSolver", "PBiCGStab"):
                t_legacy = "PBiCGStab"
            solver_k = PBiCGStabRowSettings(solver_type=str(t_legacy))

        so_raw = d.get("solver_omega")
        if isinstance(so_raw, dict):
            solver_omega = PBiCGStabRowSettings.from_dict(so_raw)
        else:
            solver_omega = PBiCGStabRowSettings(solver_type=solver_k.solver_type)

        # Coerce known enums with fallbacks (legacy flat).
        p_solver = d.get("p_solver", solver_p.solver_type)
        if p_solver not in ("GAMG", "PBiCGStab", "amgx"):
            p_solver = solver_p.solver_type if solver_p.solver_type in ("GAMG", "PBiCGStab", "amgx") else "GAMG"
        u_solver = d.get("u_solver", solver_u.solver_type)
        if u_solver not in ("smoothSolver", "PBiCGStab"):
            u_solver = solver_u.solver_type if solver_u.solver_type in ("smoothSolver", "PBiCGStab") else "PBiCGStab"
        turb_solver = d.get("turb_solver", solver_k.solver_type)
        if turb_solver not in ("smoothSolver", "PBiCGStab"):
            turb_solver = solver_k.solver_type if solver_k.solver_type in ("smoothSolver", "PBiCGStab") else "PBiCGStab"
        rt = str(d.get("relaxation_type", "manual") or "manual").strip().lower()
        if rt not in ("manual",):
            rt = "manual"
        rk_raw = d.get("residual_k", 1e-6)
        residual_k = 1e-6 if rk_raw is None else float(rk_raw)
        sch_raw = d.get("schemes")
        schemes = SchemesSettings.from_dict(sch_raw if isinstance(sch_raw, dict) else None)
        n = NumericsSettings(
            relaxation_type=rt,
            n_non_orthogonal=int(d.get("n_non_orthogonal", 1)),
            p_ref_cell=int(d.get("p_ref_cell", 0)),
            p_ref_value_pa=float(d.get("p_ref_value_pa", 0.0)),
            residual_u=float(d.get("residual_u", 1e-6)),
            residual_p=float(d.get("residual_p", 1e-6)),
            residual_k=residual_k,
            residual_omega=(float(d["residual_omega"]) if d.get("residual_omega") is not None else 1e-6) if "residual_omega" in d else 1e-6,
            residual_epsilon=_opt_float(d.get("residual_epsilon")),
            u_solver=u_solver,  # type: ignore[arg-type]
            p_solver=p_solver,  # type: ignore[arg-type]
            turb_solver=turb_solver,  # type: ignore[arg-type]
            relax_p=float(d.get("relax_p", 0.3)),
            relax_u=float(d.get("relax_u", 0.7)),
            relax_k=float(d.get("relax_k", 0.7)),
            relax_omega=float(d.get("relax_omega", 0.7)),
            relax_epsilon=float(d.get("relax_epsilon", 0.7)),
            relax_r=float(d.get("relax_r", 0.5)),
            ddt_default=str(d.get("ddt_default", "steadyState")),
            grad_default=str(d.get("grad_default", "cellLimited leastSquares 1")),
            div_phi_u=str(d.get("div_phi_u", "bounded Gauss linearUpwindV grad(U)")),
            div_nu_eff=str(d.get("div_nu_eff", "Gauss linear")),
            laplacian_default=str(d.get("laplacian_default", "Gauss linear limited corrected 0.5")),
            interpolation_default=str(d.get("interpolation_default", "linear")),
            sn_grad_default=str(d.get("sn_grad_default", "limited 0.5")),
            wall_dist_method=str(d.get("wall_dist_method", "meshWave")),
            solver_u=solver_u,
            solver_p=solver_p,
            solver_k=solver_k,
            solver_omega=solver_omega,
            schemes=schemes,
        )
        n.sync_legacy_solver_types()
        n.sync_schemes_to_writer_flats()
        return n

    @staticmethod
    def from_backend(backend: str) -> NumericsSettings:
        """Seed numerics from authoritative SolverSettings.backend (v12 migrate)."""
        n = NumericsSettings()
        if backend == "amgx":
            n.p_solver = "amgx"
            n.solver_p.solver_type = "amgx"
        else:
            n.p_solver = "GAMG"
            n.solver_p.solver_type = "GAMG"
        return n


@dataclass
class SimulationControlSettings:
    """controlDict + decomposeParDict (+ potential flow init flag).

    Defaults match Researcher still (inc21a): End time lives on SolverSettings
    (1000 s); remaining fields here.
    """

    delta_t: float = 1.0
    write_control: str = "timeStep"  # UI label: Time step
    write_interval: int = 1000
    cpu_mode: CpuMode = "automatic"
    # Used when cpu_mode == "manual". Ignored (forced 1) when backend is amgx.
    # Automatic (max 16) still → resolve_n_cpus returns 16.
    n_cpus: int = 16
    max_runtime_s: float = 20_000.0
    potential_flow_init: bool = False
    decompose_method: DecomposeMethod = "scotch"  # UI label: Scotch

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_dict(data: dict | None) -> SimulationControlSettings:
        if not data:
            return SimulationControlSettings()
        d = dict(data)
        cpu_mode = d.get("cpu_mode", "automatic")
        if cpu_mode not in ("automatic", "manual"):
            cpu_mode = "automatic"
        method = d.get("decompose_method", "scotch")
        if isinstance(method, str):
            method = method.strip().lower()
        if method not in ("scotch", "hierarchical", "simple"):
            method = "scotch"
        wc = str(d.get("write_control", "timeStep"))
        if wc in ("Time step", "time step", "timestep"):
            wc = "timeStep"
        return SimulationControlSettings(
            delta_t=float(d.get("delta_t", 1.0)),
            write_control=wc,
            write_interval=int(d.get("write_interval", 1000)),
            cpu_mode=cpu_mode,  # type: ignore[arg-type]
            n_cpus=int(d.get("n_cpus", 16)),
            max_runtime_s=float(d.get("max_runtime_s", 20_000.0)),
            potential_flow_init=bool(d.get("potential_flow_init", False)),
            decompose_method=method,  # type: ignore[arg-type]
        )

    def resolve_n_cpus(self, *, backend: str) -> int:
        """Effective subdomain count. AmgX always 1. Automatic max 16 (still)."""
        if backend == "amgx":
            return 1
        if self.cpu_mode == "automatic":
            return 16
        return max(1, int(self.n_cpus))


def _opt_float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def relax_for_turbulence(n: NumericsSettings, model: TurbulenceModel) -> dict[str, float]:
    """Per-equation relaxation matching pre-P4 fv_solution_turbulence_block."""
    if model == "laminar":
        return {}
    if model == "kOmegaSST":
        return {"k": n.relax_k, "omega": n.relax_omega}
    if model in ("LRR", "SSG"):
        return {"k": 0.5, "epsilon": 0.5, "R": n.relax_r}
    return {"k": n.relax_k, "epsilon": n.relax_epsilon}
