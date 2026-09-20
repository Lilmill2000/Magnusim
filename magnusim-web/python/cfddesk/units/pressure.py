"""Single Pa ↔ kinematic-pressure conversion for BC write, IC write, and results legend."""

from __future__ import annotations


def pa_to_kinematic(p_pa: float, density_kg_m3: float) -> float:
    """OpenFOAM incompressible p [m²/s²] = Pa / ρ."""
    rho = float(density_kg_m3)
    if rho <= 0.0:
        raise ValueError(f"density must be positive, got {rho}")
    return float(p_pa) / rho


def kinematic_to_pa(p_kin: float, density_kg_m3: float) -> float:
    """Display / migrate: Pa = kinematic × ρ."""
    rho = float(density_kg_m3)
    if rho <= 0.0:
        raise ValueError(f"density must be positive, got {rho}")
    return float(p_kin) * rho
