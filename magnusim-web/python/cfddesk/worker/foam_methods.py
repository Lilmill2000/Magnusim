"""Worker RPCs for plugin OpenFOAM cases and solve hooks (API 1.3).

- ``foam.check_case`` (submit only, on the plugin lane): the registry check (the
  app is a registered solver) and every case check of
  :func:`cfddesk.wsl.foam_case.check_case_local`; answers the launch spec. A
  refusal is an answer (``{ok: false, code, error}``), not an RPC error.
- ``solve_hooks.listening``: the solve hook names some loaded plugin listens on,
  so Node passes hook names to a solve only when they matter.
"""

from __future__ import annotations

from typing import Any

from cfddesk.registry import load_all
from cfddesk.registry.base import RegistryError
from cfddesk.registry.contract import (
    APP_NAME_RE,
    GENERIC_LOG_PARSER,
    LEGACY_FRAME_FIELDS,
    ContractError,
    LaunchSpec,
    check_launch_spec,
)
from cfddesk.registry.hooks import get_hooks
from cfddesk.worker.paths import web_root
from cfddesk.worker.rpc import rpc
from cfddesk.wsl.foam_case import FoamCaseError, check_case_local
from cfddesk.wsl.solve_hooks import SOLVE_HOOK_NAMES


def _not_allowed(text: str) -> dict[str, Any]:
    return {"ok": False, "code": "app_not_allowed", "error": text}


def _solver_app(app: str) -> Any:
    """The registered SolverApp whose application is ``app``, or None."""
    reg = load_all(web_root=web_root()).registry("solver")
    for key in reg.keys():
        spec = reg.get(key)
        if str(getattr(spec, "application", "")) == app:
            return spec
    return None


@rpc("foam.check_case")
def foam_check_case(
    case_dir: str = "",
    app: str | None = None,
    pre: Any = None,
    results: Any = None,
) -> dict[str, Any]:
    """``{ok: true, launch, write_format}`` or ``{ok: false, code, error}`` (§7.4)."""
    if app is None or app == "":
        try:
            done = check_case_local(case_dir, None, pre, None)
        except FoamCaseError as exc:
            return exc.answer()
        return {"ok": True, "launch": None, "write_format": None, "steps": done["steps"]}
    if not isinstance(app, str) or not APP_NAME_RE.match(app):
        return _not_allowed("The app must be a plain program name")
    try:
        solver = _solver_app(app)
    except RegistryError:
        solver = None
    if solver is None:
        return _not_allowed(f"{app} is not a registered solver")
    stop_strategy = str(getattr(solver, "stop_strategy", "") or "sigterm")
    try:
        done = check_case_local(case_dir, app, pre, results, stop_strategy=stop_strategy)
    except FoamCaseError as exc:
        return exc.answer()
    checked = done["results"] or {}
    time_dependency = str(getattr(solver, "time_dependency", "steady") or "steady")
    launch = LaunchSpec(
        app=app,
        keep_frames="all" if time_dependency == "transient" else "latest",
        process_names=(app,),
        stop_strategy=stop_strategy,
        parallel=str(getattr(solver, "parallel", "none")) == "mpirun",
        log_parser=GENERIC_LOG_PARSER,
        frame_fields=tuple(checked.get("frame_fields") or LEGACY_FRAME_FIELDS),
    )
    try:
        check_launch_spec(launch, load_all(web_root=web_root()).registry("solver"))
    except ContractError as exc:
        return _not_allowed(str(exc))
    return {
        "ok": True,
        "launch": {
            "app": launch.app,
            "keep_frames": launch.keep_frames,
            "process_names": list(launch.process_names),
            "stop_strategy": launch.stop_strategy,
            "parallel": "mpirun" if launch.parallel else "none",
            "frame_fields": list(launch.frame_fields),
            "time_dependency": time_dependency,
        },
        "results": checked or None,
        "write_format": done["write_format"],
        "steps": done["steps"],
    }


@rpc("solve_hooks.listening")
def solve_hooks_listening() -> dict[str, Any]:
    """``{names: [...]}``: the solve hooks some loaded plugin listens on."""
    load_all(web_root=web_root())
    bus = get_hooks()
    return {"names": [name for name in SOLVE_HOOK_NAMES if bus.has_listeners(name)]}
