"""Phase 0: create fixtures, migration docs, capture Python goldens."""
from __future__ import annotations

import copy
import json
import shutil
import tempfile
from pathlib import Path

from cfddesk.cad.step import load_step
from cfddesk.case.writer import assert_guardrails, write_simplefoam_case
from cfddesk.materials.library import default_air_dict
from cfddesk.project.model import PROJECT_VERSION, Project

ROOT = Path(r"C:\Users\drmil\Desktop\Code\CFD\cfd-web")
PY = ROOT / "python"
FIXTURES = PY / "tests" / "fixtures"
SAMPLE = ROOT / "projects" / "sample-project-steady-state-20260914220621-a75ad1"
STEP = SAMPLE / "geometry" / "source.step"
GOLDEN_FILES = (
    "controlDict",
    "fvSchemes",
    "fvSolution",
    "transportProperties",
    "turbulenceProperties",
    "U",
    "p",
    "k",
    "omega",
    "nut",
)


def _normalize(text: str) -> str:
    lines = []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("// *") or s.startswith("// \\*") or set(s) <= {"/", "*", " "}:
            continue
        if "timestamp" in line.lower() or "Date:" in line:
            continue
        if "location" in line.lower() and ("C:" in line or "/home/" in line or "\\\\" in line):
            continue
        lines.append(line.rstrip())
    return "\n".join(lines).strip() + "\n"


def build_v13() -> Project:
    solid = load_step(STEP)
    roles = {0: "inlet", 1: "outlet"}
    for i in range(2, len(solid.faces)):
        roles[i] = "walls"
    proj = Project.from_solid(
        solid, roles=roles, scale_to_metres=0.001, units_confirmed=True
    )
    geo = proj.geometries[0]
    vol_ids = []
    for v in geo.volumes or []:
        if isinstance(v, dict) and v.get("id"):
            vol_ids.append(str(v["id"]))
        elif hasattr(v, "id"):
            vol_ids.append(str(v.id))
    if not vol_ids:
        vol_ids = ["vol-0"]
    air = default_air_dict(material_id="air-1", volume_ids=vol_ids)
    proj = proj.upsert_material(air)
    proj = proj.assign_volumes("air-1", vol_ids)
    # Force CPU backend on solver
    sim = proj.primary_simulation()
    if sim is not None:
        from dataclasses import replace

        solver = replace(sim.solver, backend="cpu") if hasattr(sim, "solver") else None
        # MeshSettings / SolverSettings live on simulation
        try:
            sims = []
            for s in proj.simulations:
                if s.id == sim.id:
                    new_solver = replace(s.solver, backend="cpu")
                    sims.append(replace(s, solver=new_solver))
                else:
                    sims.append(s)
            proj = replace(proj, simulations=sims)
        except Exception as e:
            print("backend set warn", e)
    return proj, solid


def capture_golden(proj: Project, solid, backend: str, out_dir: Path) -> None:
    from dataclasses import replace

    sims = []
    for s in proj.simulations:
        sims.append(replace(s, solver=replace(s.solver, backend=backend)))
    p2 = replace(proj, simulations=sims)
    out_dir.mkdir(parents=True, exist_ok=True)
    amgx = FIXTURES / "amgx_options.json"
    with tempfile.TemporaryDirectory() as tmp:
        case = Path(tmp) / "case"
        case.mkdir()
        # polyMesh stub not required for writer of 0/constant/system physics
        write_simplefoam_case(
            case,
            amgx_json=amgx,
            default_backend=backend,
            project=p2,
            solid=solid,
        )
        # Collect files from 0/, constant/, system/
        mapping = {
            "controlDict": case / "system" / "controlDict",
            "fvSchemes": case / "system" / "fvSchemes",
            "fvSolution": case / "system" / "fvSolution",
            "transportProperties": case / "constant" / "transportProperties",
            "turbulenceProperties": case / "constant" / "turbulenceProperties",
            "U": case / "0" / "U",
            "p": case / "0" / "p",
            "k": case / "0" / "k",
            "omega": case / "0" / "omega",
            "nut": case / "0" / "nut",
            "epsilon": case / "0" / "epsilon",
        }
        for name, path in mapping.items():
            if path.is_file():
                (out_dir / name).write_text(_normalize(path.read_text(encoding="utf-8")), encoding="utf-8")
                print("golden", out_dir.name, name)
        gr = assert_guardrails(case)
        print("guardrails", backend, "amgx_on_p", getattr(gr, "amgx_on_p", gr))


def make_old_versions(v13: dict) -> None:
    """Hand-minimal older docs: start from v13 and strip fields per migration notes."""
    base = copy.deepcopy(v13)
    # v13 is current
    (FIXTURES / "projects" / "v13.json").write_text(
        json.dumps(base, indent=2) + "\n", encoding="utf-8"
    )

    def dump(ver: int, doc: dict) -> None:
        doc = copy.deepcopy(doc)
        doc["version"] = ver
        (FIXTURES / "projects" / f"v{ver}.json").write_text(
            json.dumps(doc, indent=2) + "\n", encoding="utf-8"
        )
        print("wrote", f"v{ver}.json")

    # v12: before fineness/mesh ids upgrade — still nested, version 12
    v12 = copy.deepcopy(base)
    dump(12, v12)

    # v11: before name_is_custom (strip the flag)
    v11 = copy.deepcopy(base)
    for sim in v11.get("simulations") or []:
        for bc in sim.get("boundary_conditions") or []:
            bc.pop("name_is_custom", None)
    dump(11, v11)

    # v10: same as v11 but version 10 (no re-stamp on migrate)
    v10 = copy.deepcopy(v11)
    dump(10, v10)

    # v9: before block_aabb in fingerprint era — strip name_is_custom already
    v9 = copy.deepcopy(v11)
    dump(9, v9)

    # v8: nested BC already present in our doc
    v8 = copy.deepcopy(v11)
    dump(8, v8)

    # v7: pressures in Pa already (current); mark version 7
    v7 = copy.deepcopy(v11)
    dump(7, v7)

    # v6: hierarchy present
    v6 = copy.deepcopy(v11)
    dump(6, v6)

    # v5: flat pre-hierarchy — synthesize minimal flat doc
    v5 = {
        "version": 5,
        "units": base["units"],
        "scale_to_metres": base["units"]["scale_to_metres"],
        "native_unit": base["units"].get("native_unit", "MM"),
        "paths": base.get("paths") or {},
        "step_path": "",
        "faces": [],
        "mesh": (base.get("simulations") or [{}])[0].get("mesh")
        or {"base_cell_m": 0.01, "fineness": 5},
        "boundary_conditions": [],
        "solver": {"backend": "cpu", "end_time": 200},
    }
    # flatten BCs from v13
    sim0 = (base.get("simulations") or [{}])[0]
    flat_bcs = []
    for bc in sim0.get("boundary_conditions") or []:
        flat_bcs.append(
            {
                "id": bc.get("id"),
                "name": bc.get("name"),
                "patch_name": bc.get("patch_name"),
                "type": bc.get("type"),
                "face_ids": bc.get("face_ids") or [],
                "settings": bc.get("settings") or {},
            }
        )
    v5["boundary_conditions"] = flat_bcs
    # faces from geometry
    geo0 = (base.get("geometries") or [{}])[0]
    v5["faces"] = geo0.get("faces") or []
    v5["step_path"] = geo0.get("step_path") or ""
    dump(5, v5)


def main() -> None:
    (FIXTURES / "projects").mkdir(parents=True, exist_ok=True)
    for g in ("steady_cpu", "steady_amgx", "js_steady", "js_transient"):
        (FIXTURES / "golden" / g).mkdir(parents=True, exist_ok=True)

    amgx = {
        "config_version": 2,
        "solver": {
            "preconditioner": {
                "solver": "AMG",
                "smoother": {"solver": "BLOCK_JACOBI"},
                "max_iters": 1,
                "cycle": "V",
            },
            "solver": "PCG",
            "max_iters": 100,
            "tolerance": 1e-6,
            "convergence": "RELATIVE_INI_CORE",
        },
    }
    (FIXTURES / "amgx_options.json").write_text(
        json.dumps(amgx, indent=2) + "\n", encoding="utf-8"
    )
    shutil.copy2(STEP, FIXTURES / "elbow.step")

    proj, solid = build_v13()
    make_old_versions(proj.to_dict())
    capture_golden(proj, solid, "cpu", FIXTURES / "golden" / "steady_cpu")
    capture_golden(proj, solid, "amgx", FIXTURES / "golden" / "steady_amgx")
    print("DONE fixtures+python goldens")


if __name__ == "__main__":
    main()
