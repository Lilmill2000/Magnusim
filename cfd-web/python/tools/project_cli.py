#!/usr/bin/env python3
"""Web-JSON project persistence CLI (Phase 1 Step 9).

Node handlers spawn this instead of writeFileSync into projects/.
Subcommands mirror the small table-like JS persistence merges.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

CFDDESK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CFDDESK_ROOT))


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _atomic_write(path: Path, doc: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_stdin_json() -> Any:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def _print_doc(doc: Any) -> int:
    print(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    return 0


def _stamp(doc: dict[str, Any], *, sim_id: str | None, increment: str) -> dict[str, Any]:
    out = dict(doc)
    out["updated_at"] = _now()
    out["persistence"] = "filesystem"
    out["increment"] = increment
    if sim_id:
        out["simulation_id"] = sim_id
    return out


def cmd_set_materials(args: argparse.Namespace) -> int:
    project_dir = Path(args.project_dir).resolve()
    body = _read_stdin_json()
    path = project_dir / "materials.json"
    doc = body if isinstance(body, dict) else {"materials": body}
    doc = _stamp(doc, sim_id=args.sim_id, increment="W18")
    _atomic_write(path, doc)
    # Soft stamp on project.json materials pointer (Python owns the write).
    proj_path = project_dir / "project.json"
    proj = _read_json(proj_path)
    if proj:
        air = doc.get("air") or (doc.get("materials") or [None])[0]
        proj["materials"] = {
            "air": (
                {
                    "id": air.get("id"),
                    "name": air.get("name"),
                    "assigned_volumes": air.get("assigned_volumes"),
                    "materials_json": str(path),
                    "updated_at": doc["updated_at"],
                }
                if isinstance(air, dict)
                else None
            ),
            "materials_json": str(path),
            "count": len(doc.get("materials") or []),
        }
        proj["updated_at"] = doc["updated_at"]
        proj["increment"] = "W18"
        _atomic_write(proj_path, proj)
    return _print_doc(doc)


def cmd_set_bcs(args: argparse.Namespace) -> int:
    project_dir = Path(args.project_dir).resolve()
    body = _read_stdin_json()
    path = project_dir / "boundary_conditions.json"
    doc = body if isinstance(body, dict) else {"boundary_conditions": body}
    doc = _stamp(doc, sim_id=args.sim_id, increment="W19")
    _atomic_write(path, doc)
    return _print_doc(doc)


def cmd_set_mesh_settings(args: argparse.Namespace) -> int:
    project_dir = Path(args.project_dir).resolve()
    body = _read_stdin_json()
    path = project_dir / "mesh.json"
    doc = body if isinstance(body, dict) else {"settings": body}
    doc = _stamp(doc, sim_id=args.sim_id, increment="W20")
    _atomic_write(path, doc)
    return _print_doc(doc)


def cmd_set_refinements(args: argparse.Namespace) -> int:
    project_dir = Path(args.project_dir).resolve()
    body = _read_stdin_json()
    path = project_dir / "mesh_refinements.json"
    doc = body if isinstance(body, dict) else {"refinements": body}
    doc = _stamp(doc, sim_id=args.sim_id, increment="W26")
    _atomic_write(path, doc)
    return _print_doc(doc)


def cmd_set_result_controls(args: argparse.Namespace) -> int:
    project_dir = Path(args.project_dir).resolve()
    body = _read_stdin_json()
    # Prefer result_controls.json; also accept area_average.json alias payload.
    name = "result_controls.json"
    if isinstance(body, dict) and body.get("_file") == "area_average.json":
        name = "area_average.json"
        body = {k: v for k, v in body.items() if k != "_file"}
    path = project_dir / name
    doc = body if isinstance(body, dict) else {"controls": body}
    doc = _stamp(doc, sim_id=args.sim_id, increment="W22")
    _atomic_write(path, doc)
    return _print_doc(doc)


def cmd_set_sim_control(args: argparse.Namespace) -> int:
    project_dir = Path(args.project_dir).resolve()
    body = _read_stdin_json()
    path = project_dir / "simulation_control.json"
    doc = body if isinstance(body, dict) else {}
    doc = _stamp(doc, sim_id=args.sim_id, increment="W17")
    _atomic_write(path, doc)
    return _print_doc(doc)


def cmd_run_upsert(args: argparse.Namespace) -> int:
    project_dir = Path(args.project_dir).resolve()
    body = _read_stdin_json()
    if not isinstance(body, dict):
        print(json.dumps({"ok": False, "error": "stdin must be object"}))
        return 1
    runs_dir = project_dir / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    catalog_path = runs_dir / "catalog.json"
    catalog = _read_json(catalog_path)
    runs = list(catalog.get("runs") or [])
    run_id = str(body.get("id") or body.get("run_id") or args.run_id or "")
    if not run_id:
        print(json.dumps({"ok": False, "error": "run id required"}))
        return 1
    body = _stamp(body, sim_id=args.sim_id, increment="W27")
    body["id"] = run_id
    idx = next((i for i, r in enumerate(runs) if r and r.get("id") == run_id), -1)
    if idx >= 0:
        runs[idx] = {**(runs[idx] or {}), **body}
    else:
        runs.append(body)
    catalog = _stamp({"runs": runs}, sim_id=args.sim_id, increment="W27")
    _atomic_write(catalog_path, catalog)
    run_path = runs_dir / f"{run_id}.json"
    _atomic_write(run_path, body)
    return _print_doc(body)


def cmd_run_delete(args: argparse.Namespace) -> int:
    project_dir = Path(args.project_dir).resolve()
    run_id = str(args.run_id or "")
    runs_dir = project_dir / "runs"
    catalog_path = runs_dir / "catalog.json"
    catalog = _read_json(catalog_path)
    runs = [r for r in (catalog.get("runs") or []) if not (r and r.get("id") == run_id)]
    catalog = _stamp({"runs": runs}, sim_id=args.sim_id, increment="W27")
    _atomic_write(catalog_path, catalog)
    run_path = runs_dir / f"{run_id}.json"
    if run_path.is_file():
        run_path.unlink()
    return _print_doc({"ok": True, "deleted": run_id})


def cmd_mesh_result(args: argparse.Namespace) -> int:
    project_dir = Path(args.project_dir).resolve()
    body = _read_stdin_json()
    if not isinstance(body, dict):
        print(json.dumps({"ok": False, "error": "stdin must be object"}))
        return 1
    path = project_dir / "mesh.json"
    existing = _read_json(path)
    now = _now()
    live = body.get("live_mesh_result") or body
    existing["live_mesh_result"] = live
    existing["updated_at"] = now
    existing["persistence"] = "filesystem"
    existing["increment"] = body.get("increment") or "W21"
    if args.sim_id:
        existing["simulation_id"] = args.sim_id
    # Optional per-mesh update
    mesh_id = body.get("mesh_id")
    meshes = existing.get("meshes")
    if mesh_id and isinstance(meshes, list):
        for i, m in enumerate(meshes):
            if m and m.get("id") == mesh_id:
                meshes[i] = {**m, "live_mesh_result": live, "updated_at": now}
                break
        existing["meshes"] = meshes
    _atomic_write(path, existing)
    return _print_doc(existing)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="cfddesk web project JSON CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_common(sp):
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
    ]:
        sp = sub.add_parser(name)
        add_common(sp)
        if extra:
            sp.add_argument("--run-id", default="")
        sp.set_defaults(func=fn)
    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
