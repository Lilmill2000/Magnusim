"""Orchestration: apply siblings, regenerate mirrors, ingest, synthesize."""
from __future__ import annotations

import dataclasses
import json
import uuid
from pathlib import Path
from typing import Any

from cfddesk.project.web_mirrors._common import (
    _filter_study_rows,
    _legacy_sim_id,
    _matches_study,
    _parse_iso,
    _primary_sim,
    _read_json,
    _utc_now,
)
from cfddesk.project.web_mirrors.bcs import from_web_boundary_conditions, to_web_boundary_conditions
from cfddesk.project.web_mirrors.controls import (
    from_web_result_controls,
    from_web_simulation_control,
    to_web_result_controls,
    to_web_simulation_control,
)
from cfddesk.project.web_mirrors.materials import from_web_materials, to_web_materials
from cfddesk.project.web_mirrors.mesh import (
    from_web_mesh,
    from_web_mesh_refinements,
    to_web_mesh,
    to_web_mesh_refinements,
)
from cfddesk.project.web_mirrors.simulations import (
    from_web_runs_catalog,
    from_web_simulations,
    to_web_runs_catalog,
    to_web_simulations,
)

_KIND_LIST_KEY = {
    "materials": "materials",
    "boundary_conditions": "boundary_conditions",
    "bcs": "boundary_conditions",
    "mesh": "meshes",
    "mesh_refinements": "refinements",
    "refinements": "refinements",
    "result_controls": "result_controls",
    "result_control": "result_controls",
    "runs": "runs",
    "runs_catalog": "runs",
    "catalog": "runs",
}


def _scope_sibling_doc(doc: dict | None, kind: str, sim_id: str, legacy_id: str | None) -> dict:
    if not isinstance(doc, dict):
        return {}
    key = _KIND_LIST_KEY.get(kind)
    out = dict(doc)
    if not key:
        return out
    rows = doc.get(key)
    if kind == "mesh" and not (isinstance(rows, list) and rows):
        rows = [doc] if doc.get("id") or doc.get("settings") else []
    scoped = _filter_study_rows(rows, sim_id, legacy_id)
    out[key] = scoped
    if kind == "mesh":
        aid = doc.get("active_id")
        if not any(isinstance(r, dict) and r.get("id") == aid for r in scoped):
            out["active_id"] = scoped[0].get("id") if scoped else None
    if kind in ("result_controls", "result_control"):
        aa = doc.get("area_average_1")
        if isinstance(aa, dict) and not _matches_study(aa, sim_id, legacy_id):
            out.pop("area_average_1", None)
    return out


def _apply_kind_to_sim(sim: Any, kind: str, doc: dict | None) -> Any:
    from cfddesk.project.hierarchy import MeshNode

    if kind == "materials":
        return dataclasses.replace(sim, materials=from_web_materials(doc))
    if kind in ("boundary_conditions", "bcs"):
        bcs, _defaults = from_web_boundary_conditions(doc if isinstance(doc, dict) else None)
        return dataclasses.replace(sim, boundary_conditions=bcs)
    if kind == "mesh":
        nodes, active = from_web_mesh(doc if isinstance(doc, dict) else None)
        if not nodes:
            if isinstance(doc, dict) and "meshes" in doc:
                return dataclasses.replace(sim, meshes=[], active_mesh_id="")
            return sim
        old_by_id = {m.id: m for m in sim.meshes}
        merged = []
        for n in nodes:
            old = old_by_id.get(n.id)
            refs = list(getattr(n, "refinements", None) or [])
            if not refs and old is not None:
                refs = list(old.refinements)
            meta = getattr(n, "web_meta", None) or {}
            nn = MeshNode(
                id=n.id,
                name=n.name,
                settings=n.settings,
                last_mesh_fingerprint=n.last_mesh_fingerprint,
                results_subdir=n.results_subdir,
                n_cells=n.n_cells,
                n_points=n.n_points,
                refinements=list(refs),
            )
            nn.web_meta = meta  # type: ignore[attr-defined]
            merged.append(nn)
        return dataclasses.replace(sim, meshes=merged, active_mesh_id=active or merged[0].id)
    if kind in ("mesh_refinements", "refinements"):
        refs = from_web_mesh_refinements(doc if isinstance(doc, dict) else None)
        mesh = sim.active_mesh()
        new_mesh = MeshNode(
            id=mesh.id,
            name=mesh.name,
            settings=mesh.settings,
            last_mesh_fingerprint=mesh.last_mesh_fingerprint,
            results_subdir=mesh.results_subdir,
            n_cells=mesh.n_cells,
            n_points=mesh.n_points,
            refinements=list(refs),
        )
        if hasattr(mesh, "web_meta"):
            new_mesh.web_meta = mesh.web_meta  # type: ignore[attr-defined]
        meshes = [new_mesh if m.id == mesh.id else m for m in sim.meshes]
        return dataclasses.replace(sim, meshes=meshes)
    if kind in ("result_controls", "result_control"):
        return dataclasses.replace(
            sim, result_control=from_web_result_controls(doc if isinstance(doc, dict) else None)
        )
    if kind in ("simulation_control", "sim_control"):
        return dataclasses.replace(
            sim,
            simulation_control=from_web_simulation_control(doc if isinstance(doc, dict) else None),
        )
    if kind in ("runs", "runs_catalog", "catalog"):
        runs, active = from_web_runs_catalog(doc if isinstance(doc, dict) else None)
        return dataclasses.replace(sim, runs=runs, active_run_id=active)
    return sim


def apply_web_sibling_to_project(
    project: Any,
    kind: str,
    doc: dict | None,
    *,
    sim_id: str | None = None,
) -> Any:
    sims = list(project.simulations or [])
    if not sims:
        return project

    if kind == "simulations":
        entries, _active = from_web_simulations(doc if isinstance(doc, dict) else None)
        by_id = {str(e.get("id")): e for e in entries}
        updated = []
        seen = set()
        for e in entries:
            sid = str(e.get("id") or "")
            match = next((s for s in sims if str(s.id) == sid), None)
            if not match:
                continue
            s = dataclasses.replace(
                match,
                name=str(e.get("name") or match.name),
                analysis_type=str(e.get("analysis_type") or match.analysis_type),
            )
            s.web_meta = {
                k: v
                for k, v in e.items()
                if k not in ("id", "name", "analysis_type", "geometry_id")
            }
            updated.append(s)
            seen.add(sid)
        for s in sims:
            if str(s.id) not in seen:
                updated.append(s)
        return dataclasses.replace(project, simulations=updated)

    raw = doc if isinstance(doc, dict) else {}
    legacy = _legacy_sim_id(project)
    apply_sid = str(sim_id or "").strip() or None
    list_key = _KIND_LIST_KEY.get(kind)
    full_list = bool(list_key and list_key in raw)
    new_sims = []
    for s in sims:
        sid = str(s.id)
        if apply_sid and sid != apply_sid:
            new_sims.append(s)
            continue
        if kind in ("simulation_control", "sim_control"):
            doc_sid = str(raw.get("simulation_id") or apply_sid or legacy or "")
            if doc_sid and doc_sid != sid:
                new_sims.append(s)
                continue
            new_sims.append(_apply_kind_to_sim(s, kind, raw))
            continue
        scoped = _scope_sibling_doc(raw, kind, sid, apply_sid or legacy)
        if full_list:
            new_sims.append(_apply_kind_to_sim(s, kind, scoped))
            continue
        mentioned = apply_sid == sid or str(raw.get("simulation_id") or "") == sid
        if not mentioned and not apply_sid and sid == str(legacy or ""):
            mentioned = True
        if not mentioned:
            new_sims.append(s)
            continue
        new_sims.append(_apply_kind_to_sim(s, kind, scoped if scoped else raw))
    return dataclasses.replace(project, simulations=new_sims)


def regenerate_web_mirrors(
    project: Any,
    project_dir: str | Path,
    *,
    sim_id: str | None = None,
    project_id: str | None = None,
    kinds: list[str] | None = None,
) -> dict[str, Path]:
    root = Path(project_dir)
    root.mkdir(parents=True, exist_ok=True)
    pid = project_id or root.name
    sid = sim_id or (getattr(_primary_sim(project), "id", None) if _primary_sim(project) else None)
    ts = _utc_now()
    wanted = set(kinds) if kinds else {
        "materials", "boundary_conditions", "mesh", "mesh_refinements",
        "result_controls", "simulation_control", "simulations", "runs",
    }
    written: dict[str, Path] = {}

    def _write(rel: str, doc: dict) -> Path:
        from cfddesk.project.paths import ensure_study_folder, study_json_path
        from cfddesk.project.web_writes import _scope_doc_to_study

        if rel == "simulations.json":
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            return path
        if not sid:
            return root / rel
        ensure_study_folder(root, str(sid))
        dest = study_json_path(root, sid, rel)
        if dest is None:
            raise ValueError(f"study folder missing for {sid!r}")
        kind = rel.replace(".json", "").replace("runs/catalog", "runs")
        scoped = _scope_doc_to_study(doc if isinstance(doc, dict) else {}, kind, str(sid))
        if rel == "mesh.json":
            from cfddesk.project.web_writes import persist_mesh_doc

            persist_mesh_doc(root, str(sid), scoped)
            return dest
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(scoped, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        return dest

    if "materials" in wanted:
        written["materials"] = _write(
            "materials.json", to_web_materials(project, sim_id=sid, project_id=pid, updated_at=ts)
        )
    if "boundary_conditions" in wanted:
        written["boundary_conditions"] = _write(
            "boundary_conditions.json",
            to_web_boundary_conditions(project, sim_id=sid, project_id=pid, updated_at=ts),
        )
    if "mesh" in wanted:
        written["mesh"] = _write(
            "mesh.json", to_web_mesh(project, sim_id=sid, project_id=pid, updated_at=ts)
        )
    if "mesh_refinements" in wanted:
        written["mesh_refinements"] = _write(
            "mesh_refinements.json",
            to_web_mesh_refinements(project, sim_id=sid, project_id=pid, updated_at=ts),
        )
    if "result_controls" in wanted:
        rc = to_web_result_controls(project, sim_id=sid, project_id=pid, updated_at=ts)
        written["result_controls"] = _write("result_controls.json", rc)
        aa = dict(rc)
        aa["mirror_of"] = "result_controls.json"
        written["area_average"] = _write("area_average.json", aa)
    if "simulation_control" in wanted:
        written["simulation_control"] = _write(
            "simulation_control.json",
            to_web_simulation_control(project, sim_id=sid, project_id=pid, updated_at=ts),
        )
    if "simulations" in wanted:
        cat = to_web_simulations(project, project_id=pid, updated_at=ts)
        written["simulations"] = _write("simulations.json", cat)
        active = next(
            (s for s in cat.get("simulations") or [] if str(s.get("id")) == str(cat.get("active_id"))),
            None,
        )
        if active:
            mirror = dict(active)
            mirror["simulation_json"] = str(root / "simulation.json")
            written["simulation"] = _write("simulation.json", mirror)
    if "runs" in wanted:
        catalog = to_web_runs_catalog(project, sim_id=sid, updated_at=ts)
        written["runs_catalog"] = _write("runs/catalog.json", catalog)
        (root / "runs").mkdir(parents=True, exist_ok=True)
        for r in catalog.get("runs") or []:
            rid = str(r.get("id") or "")
            if not rid:
                continue
            rel_name = f"{rid}.json" if rid.startswith("run-") else f"run-{rid}.json"
            _write(f"runs/{rel_name}", dict(r))
    return written


def sibling_updated_at(project_dir: Path, rel: str) -> float | None:
    path = project_dir / rel
    if not path.is_file():
        return None
    doc = _read_json(path)
    if isinstance(doc, dict):
        ts = _parse_iso(doc.get("updated_at"))
        if ts is not None:
            return ts
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def project_updated_at(project: Any, project_dir: Path | None = None) -> float | None:
    ts = _parse_iso(getattr(project, "updated_at", None))
    if ts is not None:
        return ts
    pers = getattr(project, "persistence", None) or {}
    if isinstance(pers, dict):
        ts = _parse_iso(pers.get("updated_at"))
        if ts is not None:
            return ts
    if project_dir is not None:
        path = Path(project_dir) / "project.json"
        if path.is_file():
            doc = _read_json(path)
            if isinstance(doc, dict):
                ts = _parse_iso(doc.get("updated_at"))
                if ts is not None:
                    return ts
            try:
                return path.stat().st_mtime
            except OSError:
                return None
    return None


def ingest_web_siblings_if_newer(
    project: Any, project_dir: str | Path, *, ignore_ts: bool = False
) -> Any:
    root = Path(project_dir)
    proj_ts = None if ignore_ts else project_updated_at(project, root)
    kind_map = {
        "materials.json": "materials",
        "boundary_conditions.json": "boundary_conditions",
        "mesh.json": "mesh",
        "mesh_refinements.json": "mesh_refinements",
        "result_controls.json": "result_controls",
        "simulation_control.json": "simulation_control",
        "simulations.json": "simulations",
        "runs/catalog.json": "runs",
    }
    for rel, kind in kind_map.items():
        sib_ts = sibling_updated_at(root, rel)
        if sib_ts is None:
            continue
        if ignore_ts or proj_ts is None or sib_ts > proj_ts + 1e-6:
            doc = _read_json(root / rel)
            if isinstance(doc, dict):
                project = apply_web_sibling_to_project(project, kind, doc)
    pers = getattr(project, "persistence", None)
    if isinstance(pers, str):
        pers_d: dict[str, Any] = {"legacy": pers}
    else:
        pers_d = dict(pers or {})
    pers_d["web_mirrors"] = "derived"
    kwargs: dict[str, Any] = {
        "persistence": pers_d,
        "version": max(int(getattr(project, "version", 15) or 15), 15),
        "updated_at": getattr(project, "updated_at", None) or _utc_now(),
    }
    try:
        return dataclasses.replace(project, **kwargs)
    except TypeError:
        for k, v in kwargs.items():
            try:
                object.__setattr__(project, k, v)
            except Exception:
                setattr(project, k, v)
        return project


def is_python_project_doc(doc: dict | None) -> bool:
    return bool(
        isinstance(doc, dict)
        and isinstance(doc.get("version"), int)
        and isinstance(doc.get("units"), dict)
        and "simulations" in doc
    )


def _catalog_sim_entries(root: Path) -> list[dict[str, Any]]:
    d = _read_json(root / "simulations.json")
    if isinstance(d, dict) and isinstance(d.get("simulations"), list):
        out = [s for s in d["simulations"] if isinstance(s, dict) and s.get("id")]
        if out:
            return out
    d2 = _read_json(root / "simulation.json")
    if isinstance(d2, dict) and d2.get("id"):
        return [d2]
    return []


def _blank_simulation(entry: dict[str, Any], geom_id: str) -> Any:
    from cfddesk.project.hierarchy import MeshNode, Simulation
    from cfddesk.project.model import PRIMARY_SIM_ANALYSIS, PRIMARY_SIM_NAME
    from cfddesk.project.settings import MeshSettings

    mid = uuid.uuid4().hex[:12]
    gid = str(entry.get("geometry_id") or geom_id or "")
    return Simulation(
        id=str(entry.get("id")),
        name=str(entry.get("name") or PRIMARY_SIM_NAME),
        analysis_type=str(entry.get("analysis_type") or PRIMARY_SIM_ANALYSIS),
        geometry_id=gid,
        boundary_conditions=[],
        meshes=[MeshNode(id=mid, name="Mesh 1", settings=MeshSettings())],
        runs=[],
        active_mesh_id=mid,
    )


def ensure_catalog_simulations(project: Any, project_dir: str | Path) -> Any:
    root = Path(project_dir)
    entries = _catalog_sim_entries(root)
    if not entries:
        return project
    existing = {str(s.id): s for s in (getattr(project, "simulations", None) or [])}
    if len(existing) == 1 and "sim-1" in existing and str(entries[0].get("id")) != "sim-1":
        placeholder = existing.pop("sim-1")
        eid = str(entries[0]["id"])
        existing[eid] = dataclasses.replace(
            placeholder,
            id=eid,
            name=str(entries[0].get("name") or placeholder.name),
            geometry_id=str(entries[0].get("geometry_id") or placeholder.geometry_id),
        )
    gid = ""
    geoms = getattr(project, "geometries", None) or []
    if geoms:
        gid = str(getattr(geoms[0], "id", "") or "")
    new_sims = []
    seen: set[str] = set()
    for e in entries:
        eid = str(e["id"])
        if eid in seen:
            continue
        seen.add(eid)
        if eid in existing:
            new_sims.append(existing[eid])
        else:
            new_sims.append(_blank_simulation(e, gid))
    return dataclasses.replace(project, simulations=new_sims)


def load_or_synthesize_project(project_dir: str | Path) -> tuple[Any, str]:
    from cfddesk.project.hierarchy import Geometry, MeshNode, Simulation
    from cfddesk.project.model import (
        PRIMARY_SIM_ANALYSIS,
        PRIMARY_SIM_NAME,
        PROJECT_VERSION,
        Project,
    )
    from cfddesk.project.settings import MeshSettings

    root = Path(project_dir)
    path = root / "project.json"
    doc = _read_json(path) if path.is_file() else None
    if isinstance(doc, dict) and is_python_project_doc(doc):
        version = int((doc or {}).get("version") or 15)
        if version >= 15:
            proj = Project.from_dict(doc, project_dir=None)
            proj = ensure_catalog_simulations(proj, root)
            proj = ingest_web_siblings_if_newer(proj, root)
            return proj, "python"
        return Project.from_dict(doc, project_dir=root), "python"

    gid = uuid.uuid4().hex[:12]
    entries = _catalog_sim_entries(root)
    if not entries:
        seen: set[str] = set()
        inferred: list[str] = []

        def _add_sid(raw: Any) -> None:
            sid = str(raw or "").strip()
            if sid and sid not in seen:
                seen.add(sid)
                inferred.append(sid)

        for rel, keys in (
            ("simulations.json", ()),
            ("materials.json", ("materials",)),
            ("boundary_conditions.json", ("boundary_conditions",)),
            ("mesh.json", ("meshes",)),
            ("mesh_refinements.json", ("refinements",)),
            ("runs/catalog.json", ("runs",)),
        ):
            d = _read_json(root / rel)
            if not isinstance(d, dict):
                continue
            if d.get("simulation_id"):
                _add_sid(d["simulation_id"])
            if rel == "simulations.json" and d.get("active_id"):
                _add_sid(d["active_id"])
            for key in keys:
                for rec in d.get(key) or []:
                    if isinstance(rec, dict) and rec.get("simulation_id"):
                        _add_sid(rec["simulation_id"])
        if not inferred:
            inferred = ["sim-1"]
        entries = [
            {
                "id": sid,
                "name": PRIMARY_SIM_NAME,
                "analysis_type": PRIMARY_SIM_ANALYSIS,
                "geometry_id": gid,
            }
            for sid in inferred
        ]
    geom = Geometry(id=gid, name="Geometry 1", step_path="", faces=[], bodies=[])
    sims = [_blank_simulation(e, gid) for e in entries]
    if not sims:
        mid = uuid.uuid4().hex[:12]
        sims = [
            Simulation(
                id="sim-1",
                name=PRIMARY_SIM_NAME,
                analysis_type=PRIMARY_SIM_ANALYSIS,
                geometry_id=gid,
                boundary_conditions=[],
                meshes=[MeshNode(id=mid, name="Mesh 1", settings=MeshSettings())],
                runs=[],
                active_mesh_id=mid,
            )
        ]
    proj = Project(
        version=PROJECT_VERSION,
        scale_to_metres=0.001,
        native_unit="MM",
        declared_unit=None,
        units_confirmed=False,
        units_ambiguous=True,
        geometries=[geom],
        simulations=sims,
    )
    proj = ingest_web_siblings_if_newer(proj, root, ignore_ts=True)
    return proj, "synthesized"


def mark_web_mirrors_derived(project: Any) -> Any:
    pers = getattr(project, "persistence", None)
    if isinstance(pers, str):
        pers_d: dict[str, Any] = {"legacy": pers}
    else:
        pers_d = dict(pers or {})
    pers_d["web_mirrors"] = "derived"
    try:
        return dataclasses.replace(
            project,
            persistence=pers_d,
            updated_at=_utc_now(),
            version=max(int(getattr(project, "version", 15) or 15), 15),
        )
    except TypeError:
        project.persistence = pers_d
        project.updated_at = _utc_now()
        return project

