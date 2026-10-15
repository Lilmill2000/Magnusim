"""The OpenFOAM programs Heat Transfer runs (the case files are written by the analysis)."""

from __future__ import annotations

from cfddesk.registry.requirements import Requirement
from cfddesk.registry.solver import SolverApp


def build_buoyant_simple_foam() -> SolverApp:
    return SolverApp(
        key="buoyantSimpleFoam",
        label="buoyantSimpleFoam (buoyant SIMPLE steady)",
        application="buoyantSimpleFoam",
        time_dependency="steady",
        parallel="mpirun",
        stop_strategy="stopAt_writeNow",
        script_template="solve",
        requires=(Requirement("wsl_tool", "buoyantSimpleFoam"),),
    )


def build_cht_multi_region_simple_foam() -> SolverApp:
    return SolverApp(
        key="chtMultiRegionSimpleFoam",
        label="chtMultiRegionSimpleFoam (conjugate heat transfer, steady)",
        application="chtMultiRegionSimpleFoam",
        time_dependency="steady",
        parallel="mpirun",
        stop_strategy="stopAt_writeNow",
        script_template="solve",
        requires=(Requirement("wsl_tool", "chtMultiRegionSimpleFoam"),),
    )


def build_cht_multi_region_foam() -> SolverApp:
    return SolverApp(
        key="chtMultiRegionFoam",
        label="chtMultiRegionFoam (conjugate heat transfer, transient)",
        application="chtMultiRegionFoam",
        time_dependency="transient",
        parallel="mpirun",
        stop_strategy="stopAt_writeNow",
        script_template="solve",
        requires=(Requirement("wsl_tool", "chtMultiRegionFoam"),),
    )


def build_buoyant_pimple_foam() -> SolverApp:
    return SolverApp(
        key="buoyantPimpleFoam",
        label="buoyantPimpleFoam (buoyant PIMPLE transient)",
        application="buoyantPimpleFoam",
        time_dependency="transient",
        parallel="mpirun",
        stop_strategy="stopAt_writeNow",
        script_template="solve",
        requires=(Requirement("wsl_tool", "buoyantPimpleFoam"),),
    )
