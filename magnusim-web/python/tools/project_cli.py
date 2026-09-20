#!/usr/bin/env python3
"""Web-JSON project persistence CLI (thin wrapper over cfddesk.project.web_writes)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

CFDDESK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CFDDESK_ROOT))

from cfddesk.project import web_writes as ww  # noqa: E402


def _read_stdin_json() -> Any:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def _print_doc(doc: Any) -> int:
    print(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    return 0


def _err(msg: str) -> int:
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False, separators=(",", ":")))
    return 1


def cmd_set_materials(args: argparse.Namespace) -> int:
    body = _read_stdin_json()
    raw = body if isinstance(body, dict) else {"materials": body}
    return _print_doc(ww.set_materials(Path(args.project_dir).resolve(), raw, sim_id=args.sim_id or ""))


def cmd_set_bcs(args: argparse.Namespace) -> int:
    body = _read_stdin_json()
    raw = body if isinstance(body, dict) else {"boundary_conditions": body}
    return _print_doc(ww.set_bcs(Path(args.project_dir).resolve(), raw, sim_id=args.sim_id or ""))


def cmd_set_mesh_settings(args: argparse.Namespace) -> int:
    body = _read_stdin_json()
    raw = body if isinstance(body, dict) else {"settings": body}
    return _print_doc(ww.set_mesh_settings(Path(args.project_dir).resolve(), raw, sim_id=args.sim_id or ""))


def cmd_set_refinements(args: argparse.Namespace) -> int:
    body = _read_stdin_json()
    raw = body if isinstance(body, dict) else {"refinements": body}
    return _print_doc(ww.set_refinements(Path(args.project_dir).resolve(), raw, sim_id=args.sim_id or ""))


def cmd_set_result_controls(args: argparse.Namespace) -> int:
    body = _read_stdin_json()
    raw = body if isinstance(body, dict) else {"controls": body}
    return _print_doc(ww.set_result_controls(Path(args.project_dir).resolve(), raw, sim_id=args.sim_id or ""))


def cmd_set_sim_control(args: argparse.Namespace) -> int:
    body = _read_stdin_json()
    raw = body if isinstance(body, dict) else {}
    return _print_doc(ww.set_sim_control(Path(args.project_dir).resolve(), raw, sim_id=args.sim_id or ""))


def cmd_run_upsert(args: argparse.Namespace) -> int:
    body = _read_stdin_json()
    if not isinstance(body, dict):
        return _err("stdin must be object")
    try:
        return _print_doc(
            ww.run_upsert(
                Path(args.project_dir).resolve(),
                body,
                sim_id=args.sim_id or "",
                run_id=args.run_id or "",
                stamp_project=bool(getattr(args, "stamp_project", False)),
            )
        )
    except ValueError as exc:
        return _err(str(exc))


def cmd_run_delete(args: argparse.Namespace) -> int:
    return _print_doc(
        ww.run_delete(Path(args.project_dir).resolve(), str(args.run_id or ""), sim_id=args.sim_id or "")
    )


def cmd_mesh_result(args: argparse.Namespace) -> int:
    body = _read_stdin_json()
    if not isinstance(body, dict):
        return _err("stdin must be object")
    return _print_doc(ww.mesh_result(Path(args.project_dir).resolve(), body, sim_id=args.sim_id or ""))


def cmd_write_json(args: argparse.Namespace) -> int:
    body = _read_stdin_json()
    if not isinstance(body, dict):
        return _err("stdin must be object")
    try:
        return _print_doc(
            ww.write_json(
                Path(args.project_dir).resolve(),
                str(args.rel or ""),
                body,
                sim_id=args.sim_id or "",
            )
        )
    except ValueError as exc:
        return _err(str(exc))


def cmd_write_project(args: argparse.Namespace) -> int:
    body = _read_stdin_json()
    if not isinstance(body, dict):
        return _err("stdin must be object")
    return _print_doc(ww.write_project(Path(args.project_dir).resolve(), body))


def cmd_save_catalog(args: argparse.Namespace) -> int:
    body = _read_stdin_json()
    if not isinstance(body, dict):
        return _err("stdin must be object")
    return _print_doc(ww.save_catalog(Path(args.project_dir).resolve(), body, sim_id=args.sim_id or ""))


def cmd_write_simulation(args: argparse.Namespace) -> int:
    body = _read_stdin_json()
    if not isinstance(body, dict):
        return _err("stdin must be object")
    return _print_doc(ww.write_simulation(Path(args.project_dir).resolve(), body, sim_id=args.sim_id or ""))


def cmd_save_sim_catalog(args: argparse.Namespace) -> int:
    body = _read_stdin_json()
    if not isinstance(body, dict):
        return _err("stdin must be object")
    return _print_doc(ww.save_sim_catalog(Path(args.project_dir).resolve(), body, sim_id=args.sim_id or ""))


# Re-export for tests that imported write_through_project from this module.
write_through_project = ww.write_through_project


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="cfddesk web project JSON CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_common(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--project-dir", required=True)
        sp.add_argument("--sim-id", default="")

    for name, fn, extra in [
        ("set-materials", cmd_set_materials, False),
        ("set-bcs", cmd_set_bcs, False),
        ("set-mesh-settings", cmd_set_mesh_settings, False),
        ("set-refinements", cmd_set_refinements, False),
        ("set-result-controls", cmd_set_result_controls, False),
        ("set-sim-control", cmd_set_sim_control, False),
        ("run-upsert", cmd_run_upsert, True),
        ("run-delete", cmd_run_delete, True),
        ("mesh-result", cmd_mesh_result, False),
        ("write-project", cmd_write_project, False),
        ("write-json", cmd_write_json, False),
        ("save-catalog", cmd_save_catalog, False),
        ("write-simulation", cmd_write_simulation, False),
        ("save-sim-catalog", cmd_save_sim_catalog, False),
    ]:
        sp = sub.add_parser(name)
        add_common(sp)
        if name == "write-json":
            sp.add_argument("--rel", required=True, help="Project-relative JSON path (allowlisted)")
        if extra:
            sp.add_argument("--run-id", default="")
            sp.add_argument("--stamp-project", action="store_true")
        sp.set_defaults(func=fn)
    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
