"""The function objects of Forces monitors and Point probes (OpenFOAM ESI v2606
dictionaries).

``forces`` writes postProcessing/<key>/<startTime>/force.dat and moment.dat;
``forceCoeffs`` writes coefficient.dat; ``probes`` writes U and p, one column
per point. The case stores kinematic pressure (p / rho): ``rho rhoInf`` with
the fluid's density turns the forces into newtons; probe pressures are scaled
when read. incompressible_flow.forces_results and probes_results read them.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from typing import Any

from .function_objects import _foam_ident_ok, js_to_precision, monitor_write_control_text
from .monitors import DEFAULT_WALLS, DEFAULT_WALLS_LABEL, DEFAULT_WALLS_PATCH


def num(x: float) -> str:
    """A number as the dictionaries write it (up to 8 significant digits)."""
    x = float(x)
    if x == 0:
        return "0"
    text = js_to_precision(x, 8)
    if "e" in text:
        mant, exp = text.split("e")
        mant = mant.rstrip("0").rstrip(".") if "." in mant else mant
        return f"{mant}e{int(exp)}"
    return text.rstrip("0").rstrip(".") if "." in text else text


def vec(v: Sequence[float]) -> str:
    return "(" + " ".join(num(c) for c in v) + ")"


def monitor_key(prefix: str, name: str, taken: set[str]) -> str:
    """``<prefix>_<slug>``, unique in ``taken`` (function object and postProcessing name)."""
    slug = re.sub(r"[^a-z0-9]+", "_", str(name or "").lower()).strip("_") or "monitor"
    key = f"{prefix}_{slug}"
    n = 2
    while key in taken:
        key = f"{prefix}_{slug}_{n}"
        n += 1
    taken.add(key)
    return key


def forces_block(
    key: str,
    patches: Iterable[str],
    *,
    rho: float,
    cofr: Sequence[float],
    write_control_text: str,
) -> str:
    """Total, pressure and viscous force and moment on the patches (N, N m)."""
    return f"""    {key}
    {{
        type            forces;
        libs            (forces);
        {write_control_text}
        log             false;
        patches         ({" ".join(patches)});
        rho             rhoInf;
        rhoInf          {num(rho)};
        CofR            {vec(cofr)};
    }}"""


def force_coeffs_block(
    key: str,
    patches: Iterable[str],
    *,
    rho: float,
    cofr: Sequence[float],
    lift: Sequence[float],
    drag: Sequence[float],
    speed: float,
    length: float,
    area: float,
    write_control_text: str,
) -> str:
    """Drag, lift, side and moment coefficients. v2606 takes the pitch axis as
    lift x drag (its header says so); lRef only scales the moment coefficients."""
    return f"""    {key}
    {{
        type            forceCoeffs;
        libs            (forces);
        {write_control_text}
        log             false;
        patches         ({" ".join(patches)});
        rho             rhoInf;
        rhoInf          {num(rho)};
        CofR            {vec(cofr)};
        liftDir         {vec(lift)};
        dragDir         {vec(drag)};
        magUInf         {num(speed)};
        lRef            {num(length)};
        Aref            {num(area)};
    }}"""


def _find_bc(mapped: Sequence[dict[str, Any]], token: str) -> dict[str, Any] | None:
    """The mapped BC a Forces monitor names: by its id, else (a BC saved without one) its name."""
    for m in mapped:
        bc = m.get("bc") or {}
        if bc.get("id") is not None and str(bc.get("id")) == token:
            return m
    for m in mapped:
        bc = m.get("bc") or {}
        if str(bc.get("name") or "") == token:
            return m
    return None


def plan_forces_monitors(spec: Any, mesh_patches: set[str] | None, reference: Any) -> list[dict[str, Any]]:
    """What each of the run's Forces monitors measures: the mesh patches of its
    boundaries (a BC's patch, or ``walls`` for the walls no BC claims), the
    boundaries this mesh has no patch of, and its function object keys.

    ``mesh_patches`` is the mesh's patch names (None: not known, every boundary
    is taken). A BC added after the mesh has no patch of its own: its faces are
    in another patch, so it is left out and named in ``notes``.
    """
    mapped = list(getattr(spec, "mapped", None) or [])
    taken: set[str] = set()
    out: list[dict[str, Any]] = []
    for mon in getattr(spec, "forces_monitors", None) or []:
        name = str(mon.get("name") or "Forces")
        patches: list[str] = []
        labels: list[str] = []
        missing: list[str] = []
        notes: list[str] = []
        gone = 0
        for token in mon.get("boundaries") or []:
            token = str(token)
            if token == DEFAULT_WALLS:
                label, patch = DEFAULT_WALLS_LABEL, DEFAULT_WALLS_PATCH
            else:
                hit = _find_bc(mapped, token)
                if hit is None:
                    gone += 1
                    continue
                label = str((hit.get("bc") or {}).get("name") or hit.get("patch") or token)
                patch = str(hit.get("patch") or "")
            if (mesh_patches is not None and patch not in mesh_patches) or not _foam_ident_ok(patch):
                missing.append(label)
                if token == DEFAULT_WALLS:
                    notes.append("This run's mesh has no walls without a boundary condition.")
                else:
                    notes.append(f"Re-mesh to give '{label}' its own boundary: it is not measured in this run.")
                continue
            if patch not in patches:
                patches.append(patch)
                labels.append(label)
        if gone:
            notes.append(
                "A boundary it was assigned to has no faces or was deleted."
                if gone == 1
                else f"{gone} boundaries it was assigned to have no faces or were deleted."
            )
        if not (mon.get("boundaries") or []):
            notes.append("No walls are picked: pick them in the monitor's panel.")
        key = monitor_key("forces", name, taken)
        coeffs_key = monitor_key("coeffs", name, taken) if patches and reference.area else None
        out.append(
            {
                "id": mon.get("id"),
                "name": name,
                "key": key if patches else None,
                "coeffs_key": coeffs_key,
                "patches": patches,
                "boundaries": labels,
                "missing": missing,
                "notes": notes,
                "moment_coefficient": bool(coeffs_key and reference.length),
            }
        )
    return out


def forces_functions_text(plans: Iterable[dict[str, Any]], reference: Any, *, transient: Any = None) -> str:
    """The forces (and forceCoeffs) blocks of the planned Forces monitors."""
    write = monitor_write_control_text(transient=transient)
    blocks: list[str] = []
    for plan in plans:
        if not plan.get("key"):
            continue
        blocks.append(
            forces_block(
                plan["key"], plan["patches"], rho=reference.rho, cofr=reference.cofr, write_control_text=write
            )
        )
        if plan.get("coeffs_key"):
            blocks.append(
                force_coeffs_block(
                    plan["coeffs_key"],
                    plan["patches"],
                    rho=reference.rho,
                    cofr=reference.cofr,
                    lift=reference.lift,
                    drag=reference.drag,
                    speed=reference.speed,
                    length=reference.length or 1.0,
                    area=reference.area,
                    write_control_text=write,
                )
            )
    return "\n".join(blocks)


def probes_block(key: str, points: Iterable[Sequence[float]], *, write_control_text: str) -> str:
    """Velocity and (kinematic) pressure at each point, in the order given. A point
    outside the mesh is written ``# Not Found`` with values of -1e300."""
    locations = " ".join(vec(p) for p in points)
    return f"""    {key}
    {{
        type            probes;
        libs            (sampling);
        {write_control_text}
        log             false;
        fields          (U p);
        probeLocations  ( {locations} );
    }}"""


def plan_probe_monitors(spec: Any) -> list[dict[str, Any]]:
    """The run's Point probes that have points, each with its function object key."""
    taken: set[str] = set()
    out: list[dict[str, Any]] = []
    for mon in getattr(spec, "probe_monitors", None) or []:
        points = [list(map(float, p)) for p in mon.get("points") or []]
        if not points:
            continue
        name = str(mon.get("name") or "Point probe")
        out.append({"id": mon.get("id"), "name": name, "key": monitor_key("probes", name, taken), "points": points})
    return out


def probes_functions_text(plans: Iterable[dict[str, Any]], *, transient: Any = None) -> str:
    write = monitor_write_control_text(transient=transient)
    return "\n".join(probes_block(p["key"], p["points"], write_control_text=write) for p in plans)
