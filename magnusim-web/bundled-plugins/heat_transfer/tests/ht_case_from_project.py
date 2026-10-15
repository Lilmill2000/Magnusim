"""Write a Heat Transfer study's case from its records as the app saved them, without WSL.

usage: python ht_case_from_project.py --project-dir DIR --simulation-id SID --out DIR

The study row (``cfddesk.project.readiness.study_doc``) and its materials and BCs
(``cfddesk.project.paths``) are read from the project; the case is written on the
committed two-region mesh (python/tests/fixtures/cht-case: ``air`` on Body1,
``aluminium_6061`` on Body2), so a browser test can check what a study set in the
panels writes (a heat source's fvOptions, the gravity in constant/g) where no mesher
runs. Prints one JSON line: ``{ok, error?, files: {relative path: text}}``.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEB = HERE.parents[2]
MESH = WEB / "python" / "tests" / "fixtures" / "cht-case" / "constant" / "polyMesh"
ROWS = [
    {"name": "air", "role": "fluid", "bodies": ["Body1"], "cells": 32},
    {"name": "aluminium_6061", "role": "solid", "bodies": ["Body2"], "cells": 32},
]
SHOWN = ("constant/g", "system/aluminium_6061/fvOptions", "system/controlDict")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--project-dir", type=Path, required=True)
    p.add_argument("--simulation-id", required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args(argv)

    from cfddesk.project.paths import assemble_study_bcs, assemble_study_materials
    from cfddesk.project.readiness import study_doc
    from cfddesk.project.run_inputs import RunInputs

    from heat_transfer.polymesh import read_polymesh
    from heat_transfer.runspec import load_spec
    from heat_transfer.writer import write_case

    sid = a.simulation_id
    study = study_doc(a.project_dir, sid)
    td = "transient" if str(study.get("time_dependency") or "").lower().startswith("transient") else "steady"
    mesh_dir = a.out.parent / f"{a.out.name}-mesh"
    shutil.rmtree(mesh_dir, ignore_errors=True)
    shutil.copytree(MESH, mesh_dir / "constant" / "polyMesh")
    patches = [x.name for x in read_polymesh(mesh_dir / "constant" / "polyMesh").patches]
    inputs = RunInputs(
        project_dir=a.project_dir,
        run_id="run_1",
        simulation_id=sid,
        mesh_id="mesh_1",
        n_procs=1,
        require_mesh=True,
        time_dependency=td,  # type: ignore[arg-type]
        analysis_key=f"heat_transfer_{td}",
        solver_key="buoyantSimpleFoam",
        materials={"materials": assemble_study_materials(a.project_dir, sid)},
        bcs_doc={"defaults": {"wall_type": "No-slip"}, "boundary_conditions": assemble_study_bcs(a.project_dir, sid)},
        result_controls={},
        simulation_control={"endTime": 100, "writeInterval": 100},
        mesh={"ok": True, "case_dir": str(mesh_dir), "patches": patches, "n_cells": 64, "mesh_id": "mesh_1", "regions": ROWS},
        face_props={},
        study=study,
        run={},
        transient_override={"end_time": 1, "write_count": 1} if td == "transient" else None,
    )
    spec = load_spec(inputs)
    if not spec.ok:
        print(json.dumps({"ok": False, "error": spec.error}))
        return 1
    report = write_case(spec, a.out)
    files = {rel: (a.out / rel).read_text(encoding="utf-8") for rel in SHOWN if (a.out / rel).is_file()}
    print(json.dumps({"ok": bool(report.get("ok")), "error": report.get("error"), "files": files}))
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
