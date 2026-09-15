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
    proj_path = project_dir / "project.json"
    proj = _read_json(proj_path)
    if proj:
        bcs = list(doc.get("boundary_conditions") or [])
        proj["boundary_conditions"] = {
            "count": len(bcs),
            "names": [b.get("name") for b in bcs if isinstance(b, dict)],
            "types": [b.get("bc_type") for b in bcs if isinstance(b, dict)],
            "boundary_conditions_json": str(path),
            "updated_at": doc["updated_at"],
        }
        proj["updated_at"] = doc["updated_at"]
        proj["increment"] = "W19"
        _atomic_write(proj_path, proj)
    return _print_doc(doc)


def cmd_set_mesh_settings(args: argparse.Namespace) -> int:
    project_dir = Path(args.project_dir).resolve()
    body = _read_stdin_json()
    path = project_dir / "mesh.json"
    doc = body if isinstance(body, dict) else {"settings": body}
    # Preserve caller stamps when present (W21 live results use increment W21/W25).
    inc = "W20"
    if isinstance(body, dict) and body.get("increment"):
        inc = str(body.get("increment"))
    doc = _stamp(doc, sim_id=args.sim_id, increment=inc)
    _atomic_write(path, doc)
    proj_path = project_dir / "project.json"
    proj = _read_json(proj_path)
    if proj:
        settings = doc.get("settings") if isinstance(doc.get("settings"), dict) else {}
        proj["mesh"] = {
            "id": doc.get("id") or doc.get("active_id"),
            "name": doc.get("name"),
            "algorithm": settings.get("algorithm"),
            "sizing": settings.get("sizing"),
            "fineness": settings.get("fineness"),
            "bank_exact": doc.get("bank_exact"),
            "mesh_json": str(path),
            "active_id": doc.get("active_id"),
            "mesh_count": len(doc.get("meshes") or []) or 1,
            "updated_at": doc["updated_at"],
        }
        proj["updated_at"] = doc["updated_at"]
        proj["increment"] = inc
        _atomic_write(proj_path, proj)
    return _print_doc(doc)


def cmd_set_refinements(args: argparse.Namespace) -> int:
    project_dir = Path(args.project_dir).resolve()
    body = _read_stdin_json()
    path = project_dir / "mesh_refinements.json"
    doc = body if isinstance(body, dict) else {"refinements": body}
    doc = _stamp(doc, sim_id=args.sim_id, increment="W26")
    _atomic_write(path, doc)
    proj_path = project_dir / "project.json"
    proj = _read_json(proj_path)
    if proj:
        refs = list(doc.get("refinements") or [])
        proj["mesh_refinements"] = {
            "count": len(refs),
            "names": [r.get("name") for r in refs if isinstance(r, dict)],
            "types": [r.get("type") for r in refs if isinstance(r, dict)],
            "mesh_refinements_json": str(path),
            "updated_at": doc["updated_at"],
        }
        proj["updated_at"] = doc["updated_at"]
        proj["increment"] = "W26"
        _atomic_write(proj_path, proj)
    return _print_doc(doc)


def cmd_set_result_controls(args: argparse.Namespace) -> int:
    project_dir = Path(args.project_dir).resolve()
    body = _read_stdin_json()
    only_aa = isinstance(body, dict) and body.get("_file") == "area_average.json"
    if only_aa and isinstance(body, dict):
        body = {k: v for k, v in body.items() if k != "_file"}
    doc = body if isinstance(body, dict) else {"controls": body}
    doc = _stamp(doc, sim_id=args.sim_id, increment="W22")
    rc_path = project_dir / "result_controls.json"
    aa_path = project_dir / "area_average.json"
    if only_aa:
        _atomic_write(aa_path, doc)
    else:
        _atomic_write(rc_path, doc)
        mirror = dict(doc)
        mirror["mirror_of"] = "result_controls.json"
        _atomic_write(aa_path, mirror)
    path = aa_path if only_aa else rc_path
    proj_path = project_dir / "project.json"
    proj = _read_json(proj_path)
    if proj:
        rcs = list(doc.get("result_controls") or [])
        aa = doc.get("area_average_1")
        aa_sum = None
        if isinstance(aa, dict):
            aa_sum = {
                "name": aa.get("name"),
                "kind": aa.get("kind"),
                "category": aa.get("category"),
                "write_control": aa.get("write_control"),
                "faces": aa.get("faces"),
                "both_faces": True,
                "results_available": False,
            }
        proj["result_controls"] = {
            "count": len(rcs),
            "names": [r.get("name") for r in rcs if isinstance(r, dict)],
            "area_average_1": aa_sum,
            "result_controls_json": str(rc_path),
            "area_average_json": str(aa_path),
            "updated_at": doc["updated_at"],
        }
        proj["updated_at"] = doc["updated_at"]
        proj["increment"] = "W22"
        _atomic_write(proj_path, proj)
    return _print_doc(doc)


def cmd_set_sim_control(args: argparse.Namespace) -> int:
    project_dir = Path(args.project_dir).resolve()
    body = _read_stdin_json()
    path = project_dir / "simulation_control.json"
    doc = body if isinstance(body, dict) else {}
    doc = _stamp(doc, sim_id=args.sim_id, increment="W17")
    _atomic_write(path, doc)
    return _print_doc(doc)



def _run_sidecar_path(runs_dir: Path, run_id: str) -> Path:
    """Match JS w27 runSidecarPath: runs/run-<id>.json."""
    rid = str(run_id or "").strip()
    if rid.startswith("run-"):
        return runs_dir / f"{rid}.json"
    return runs_dir / f"run-{rid}.json"

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
    active_id = body.get("active_id")
    if active_id is None:
        active_id = catalog.get("active_id")
    if active_id is None:
        active_id = run_id
    catalog_out = _stamp(
        {"runs": runs, "active_id": active_id},
        sim_id=args.sim_id,
        increment="W27",
    )
    _atomic_write(catalog_path, catalog_out)
    run_path = _run_sidecar_path(runs_dir, run_id)
    _atomic_write(run_path, body)
    if getattr(args, "stamp_project", False):
        _stamp_run_on_project(project_dir, body)
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
    run_path = _run_sidecar_path(runs_dir, run_id)
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




ALLOWED_WRITE_JSON_RELS = frozenset(
    {
        "materials.json",
        "boundary_conditions.json",
        "mesh.json",
        "mesh_refinements.json",
        "result_controls.json",
        "area_average.json",
        "simulation_control.json",
        "runs/catalog.json",
    }
)


def cmd_write_json(args: argparse.Namespace) -> int:
    """Atomically write an allowlisted project-relative JSON doc (Node builds; Python owns write)."""
    project_dir = Path(args.project_dir).resolve()
    rel = str(args.rel or "").replace("\\", "/").lstrip("/")
    if rel not in ALLOWED_WRITE_JSON_RELS:
        print(json.dumps({"ok": False, "error": f"rel not allowlisted: {rel}"}))
        return 1
    body = _read_stdin_json()
    if not isinstance(body, dict):
        print(json.dumps({"ok": False, "error": "stdin must be object"}))
        return 1
    path = project_dir / Path(rel)
    doc = dict(body)
    if not doc.get("updated_at"):
        doc["updated_at"] = _now()
    if not doc.get("persistence"):
        doc["persistence"] = "filesystem"
    _atomic_write(path, doc)
    return _print_doc(doc)


def cmd_write_project(args: argparse.Namespace) -> int:
    """Atomically write full project.json (Node builds doc; Python owns write)."""
    project_dir = Path(args.project_dir).resolve()
    body = _read_stdin_json()
    if not isinstance(body, dict):
        print(json.dumps({"ok": False, "error": "stdin must be object"}))
        return 1
    path = project_dir / "project.json"
    if not body.get("id"):
        body = {**body, "id": project_dir.name}
    body = dict(body)
    body["updated_at"] = body.get("updated_at") or _now()
    body["persistence"] = "filesystem"
    _atomic_write(path, body)
    return _print_doc(body)


def cmd_save_catalog(args: argparse.Namespace) -> int:
    """Write runs/catalog.json from stdin (full catalog document)."""
    project_dir = Path(args.project_dir).resolve()
    body = _read_stdin_json()
    if not isinstance(body, dict):
        print(json.dumps({"ok": False, "error": "stdin must be object"}))
        return 1
    runs_dir = project_dir / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    path = runs_dir / "catalog.json"
    doc = _stamp(body, sim_id=args.sim_id, increment="W27")
    if "runs" not in doc:
        doc["runs"] = []
    _atomic_write(path, doc)
    return _print_doc(doc)



def cmd_write_simulation(args: argparse.Namespace) -> int:
    """Atomically write projects/<id>/simulation.json (active-study mirror)."""
    project_dir = Path(args.project_dir).resolve()
    body = _read_stdin_json()
    if not isinstance(body, dict):
        print(json.dumps({"ok": False, "error": "stdin must be object"}))
        return 1
    path = project_dir / "simulation.json"
    doc = dict(body)
    doc["simulation_json"] = str(path)
    if args.sim_id and not doc.get("id"):
        doc["id"] = args.sim_id
    doc["updated_at"] = doc.get("updated_at") or _now()
    doc["persistence"] = "filesystem"
    _atomic_write(path, doc)
    return _print_doc(doc)


def cmd_save_sim_catalog(args: argparse.Namespace) -> int:
    """Write simulations.json and mirror active study to simulation.json."""
    project_dir = Path(args.project_dir).resolve()
    body = _read_stdin_json()
    if not isinstance(body, dict):
        print(json.dumps({"ok": False, "error": "stdin must be object"}))
        return 1
    simulations = list(body.get("simulations") or [])
    active_id = body.get("active_id")
    if active_id and not any(
        str(s.get("id")) == str(active_id) for s in simulations if isinstance(s, dict)
    ):
        active_id = (
            simulations[0]["id"]
            if simulations and isinstance(simulations[0], dict)
            else None
        )
    if not active_id and simulations and isinstance(simulations[0], dict):
        active_id = simulations[0].get("id")
    doc = {
        "active_id": active_id,
        "simulations": simulations,
        "updated_at": body.get("updated_at") or _now(),
    }
    if args.sim_id:
        doc["simulation_id"] = args.sim_id
    cat_path = project_dir / "simulations.json"
    _atomic_write(cat_path, doc)
    mirror = project_dir / "simulation.json"
    active = next(
        (
            s
            for s in simulations
            if isinstance(s, dict) and str(s.get("id")) == str(active_id)
        ),
        None,
    )
    if active:
        mirrored = dict(active)
        mirrored["simulation_json"] = str(mirror)
        _atomic_write(mirror, mirrored)
    elif mirror.exists():
        try:
            mirror.unlink()
        except OSError:
            pass
    return _print_doc(doc)


def _stamp_run_on_project(project_dir: Path, body: dict[str, Any]) -> None:
    proj_path = project_dir / "project.json"
    proj = _read_json(proj_path)
    if not proj:
        return
    run_id = str(body.get("id") or body.get("run_id") or "")
    proj["run_1"] = {
        "run_id": run_id,
        "name": body.get("name"),
        "status": body.get("status"),
        "pid": body.get("pid"),
        "case_dir": body.get("case_dir"),
        "log_path": body.get("log_path"),
        "increment": body.get("increment") or "W27",
        "updated_at": body.get("finished_at") or body.get("started_at") or body.get("updated_at") or _now(),
    }
    proj["updated_at"] = _now()
    proj["increment"] = "W27"
    _atomic_write(proj_path, proj)


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
        ("write-project", cmd_write_project, False),
        ("write-json", cmd_write_json, False),
        ("save-catalog", cmd_save_catalog, False),
        ("write-simulation", cmd_write_simulation, False),
        ("save-sim-catalog", cmd_save_sim_catalog, False),
    ]:
        sp = sub.add_parser(name)
        add_common(sp)
        if name == "write-json":
            sp.add_argument(
                "--rel",
                required=True,
                help="Project-relative JSON path (allowlisted)",
            )
        if extra:
            sp.add_argument("--run-id", default="")
            sp.add_argument(
                "--stamp-project",
                action="store_true",
                help="Also stamp project.json run_1 pointer (W27)",
            )
        sp.set_defaults(func=fn)
    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
