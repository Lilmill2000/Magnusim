#!/usr/bin/env python3
"""Hex-dominant (snappyHexMesh) generate — Phase 1 Step 6.

Host prep (scale Body1 + write dicts) then WSL bash template
``snappy_hexdominant.sh``. Emits MAGNUSIM_EVENT JSONL (optional
``--legacy-markers`` for CFMESH_* dual emission).
"""
from __future__ import annotations

import argparse
import atexit
import json
import shutil
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

CFDDESK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CFDDESK_ROOT))

from cfddesk.jobs import legacy_markers as _legacy  # noqa: E402
from cfddesk.mesh.generate_guard import claim_generate_case, release_generate_case  # noqa: E402
from cfddesk.jobs.events import emit  # noqa: E402
from cfddesk.mesh.snappy_hexdominant import (  # noqa: E402
    fineness_params,
    read_feature_marks,
    read_polymesh_counts,
    scale_body1_stl,
    write_hexdominant_dicts,
)
from cfddesk.runner.case_id import validate_wsl_case_id, wsl_case_path  # noqa: E402
from cfddesk.runner.sync import sync_to_wsl  # noqa: E402
from cfddesk.wsl.config import get_wsl_distro  # noqa: E402
from cfddesk.wsl.mesh_run import windows_to_wsl_path  # noqa: E402

_TEMPLATES = CFDDESK_ROOT / "cfddesk" / "wsl" / "templates"
_SNAPPY_SH = _TEMPLATES / "snappy_hexdominant.sh"

PATH_KIND = "snappyHexMesh"


def _progress(stage: str, **extra) -> None:
    _legacy.progress(stage, **extra)


def _result(ok: bool, **extra) -> int:
    return _legacy.result(ok, path_kind=PATH_KIND, **extra)



def _read_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def render_snappy_script(*, dst: str, win_out: str, generate_id: str) -> str:
    raw = _SNAPPY_SH.read_text(encoding="utf-8")
    if raw.startswith("\ufeff"):
        raw = raw.lstrip("\ufeff")
    text = (
        raw.replace("__DST__", str(dst))
        .replace("__WIN_OUT__", str(win_out))
        .replace("__GENERATE_ID__", str(generate_id))
    )
    return text.replace("\r\n", "\n").replace("\r", "\n")


def main() -> int:
    p = argparse.ArgumentParser(description="Hex-dominant snappyHexMesh generate")
    p.add_argument("--project-dir", required=True)
    p.add_argument("--case-dir", required=True)
    p.add_argument("--wsl-case", required=True)
    p.add_argument("--generate-id", required=True)
    p.add_argument("--fineness", type=int, default=5)
    p.add_argument("--add-layers", type=int, default=0)
    p.add_argument("--physics-based", type=int, default=1)
    p.add_argument(
        "--legacy-markers",
        action="store_true",
        help="Also emit CFMESH_PROGRESS/CFMESH_RESULT lines.",
    )
    p.add_argument("--timeout", type=float, default=3600.0)
    p.add_argument(
        "--render-only",
        action="store_true",
        help="Host-prep + render bash only (no WSL).",
    )
    p.add_argument("--simulation-id", default="")
    args = p.parse_args()
    _legacy.set_legacy_markers(bool(args.legacy_markers))

    project_dir = Path(args.project_dir).resolve()
    case_dir = Path(args.case_dir).resolve()
    claim_generate_case(case_dir, generate_id=str(args.generate_id))
    atexit.register(release_generate_case, case_dir, generate_id=str(args.generate_id))
    wsl_case = validate_wsl_case_id(str(args.wsl_case))
    generate_id = str(args.generate_id)
    add_layers = bool(int(args.add_layers))
    physics_based = bool(int(args.physics_based))

    if wsl_case.startswith("cfddesk-manual-") or wsl_case == "cfddesk-cfmesh":
        return _result(False, error=f"refusing reserved WSL case id {wsl_case}")
    if "HEXCORE-PROCESS-BACKUP" in str(case_dir):
        return _result(False, error="refusing to write into HEXCORE-PROCESS-BACKUP")

    from cfddesk.project.paths import find_study, resolve_step

    geom_id = None
    sid = str(getattr(args, "simulation_id", "") or "").strip()
    if sid:
        study = find_study(project_dir, sid)
        if study:
            geom_id = study.get("geometry_id")
    step = resolve_step(project_dir, geom_id)
    body1 = (step.parent / "Body1.stl") if step else None
    if not step or not step.is_file():
        return _result(False, error=f"missing source.step: {step}")
    if not body1 or not body1.is_file():
        return _result(False, error=f"missing Body1.stl: {body1}")
    if not _SNAPPY_SH.is_file():
        return _result(False, error=f"missing template: {_SNAPPY_SH}")

    try:
        _progress("load_geometry", step=str(step), body1=str(body1))
        # Fresh case dir
        if case_dir.exists():
            shutil.rmtree(case_dir, ignore_errors=True)
        case_dir.mkdir(parents=True, exist_ok=True)
        tri = case_dir / "constant" / "triSurface"
        tri.mkdir(parents=True, exist_ok=True)
        for pth in list(tri.glob("*")):
            if pth.is_file():
                pth.unlink()
            else:
                shutil.rmtree(pth, ignore_errors=True)

        scaled = scale_body1_stl(body1, tri / "Body1.stl")
        bounds = scaled["bounds_m"]
        params = fineness_params(
            int(args.fineness), physics_based=physics_based, bounds_m=bounds
        )
        _progress(
            "write_dicts",
            block=params["block"],
            feature_level=params["feature_level"],
            walls_level=params["walls_level"],
            add_layers=add_layers,
            snappy_geometry_rev=params["snappy_geometry_rev"],
        )
        meta = write_hexdominant_dicts(
            case_dir,
            block=params["block"],
            feature_level=params["feature_level"],
            walls_level=params["walls_level"],
            add_layers=add_layers,
            snap=params["snap"],
            bounds_m=bounds,
        )
        meta_doc = {
            "increment": "W25",
            "project_id": project_dir.name,
            "step_path": str(step),
            "body1_path_src": str(body1),
            "body1_bytes_scaled": scaled["body1_bytes"],
            "bounds_m": bounds,
            "mtp1_silent_copy": False,
            "geometry_source": "W16_project_STEP_Body1",
            **meta,
        }
        (case_dir / "w23-geometry-meta.json").write_text(
            json.dumps(meta_doc, indent=2), encoding="utf-8"
        )

        dst = wsl_case_path(wsl_case)
        win_out_wsl = windows_to_wsl_path(case_dir)
        script_body = render_snappy_script(
            dst=dst, win_out=win_out_wsl, generate_id=generate_id
        )
        if args.render_only:
            out = case_dir / "generate_snappy.render.sh"
            out.write_bytes(script_body.encode("utf-8"))
            return _result(
                True,
                render_only=True,
                script=str(out),
                **{k: params[k] for k in ("block", "feature_level", "walls_level", "snappy_geometry_rev")},
                snap=params["snap"],
                add_layers=add_layers,
            )

        _progress("sync_to_wsl", wsl_case=wsl_case)
        sync_to_wsl(case_dir, wsl_case, timeout=600.0)

        with tempfile.TemporaryDirectory(prefix="cfddesk-snappy-") as tmp:
            sh_path = Path(tmp) / f"generate-{generate_id}.sh"
            sh_path.write_bytes(script_body.encode("utf-8"))
            wsl_sh = windows_to_wsl_path(sh_path)
            argv = [
                "wsl",
                "-d",
                get_wsl_distro(),
                "--",
                "bash",
                wsl_sh,
            ]
            _progress("snappy_pipeline", argv=" ".join(argv))
            proc = subprocess.Popen(
                argv,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            assert proc.stdout is not None
            last_result = None
            for line in proc.stdout:
                line = line.rstrip("\n")
                if line.startswith("MAGNUSIM_EVENT ") or line.startswith("CFDDESK_EVENT "):
                    # Re-emit bare protocol already on stdout from bash; also dual legacy if asked
                    print(line, flush=True)
                    try:
                        payload = line.split(" ", 1)[1]
                        data = json.loads(payload)
                        if data.get("event") == "result":
                            last_result = data
                        if _legacy.legacy_enabled() and data.get("event") == "progress":
                            print(
                                "CFMESH_PROGRESS "
                                + json.dumps(
                                    {"stage": data.get("stage"), **{k: v for k, v in data.items() if k not in ("event",)}},
                                    separators=(",", ":"),
                                ),
                                flush=True,
                            )
                    except Exception:
                        pass
                elif line.strip():
                    emit("log", line=line[:500])
            rc = proc.wait(timeout=float(args.timeout))

        counts = read_polymesh_counts(case_dir)
        (case_dir / "w21-counts.json").write_text(
            json.dumps(counts, indent=2), encoding="utf-8"
        )
        marks = read_feature_marks(case_dir / "log.snappyHexMesh")
        (case_dir / "w21-feature-marks.json").write_text(
            json.dumps(marks, indent=2), encoding="utf-8"
        )
        if marks["total"] < 1 and rc == 0:
            return _result(
                False,
                error="zero explicit feature refinement",
                exit_code=44,
                **counts,
                feature_marks_total=marks["total"],
            )

        ok = rc == 0 and (last_result is None or bool(last_result.get("ok", True)))
        return _result(
            ok,
            exit_code=rc,
            n_cells=counts.get("n_cells"),
            n_points=counts.get("n_points"),
            n_faces=counts.get("n_faces"),
            counts_source=counts.get("source"),
            feature_marks_total=marks["total"],
            block=params["block"],
            feature_level=params["feature_level"],
            walls_level=params["walls_level"],
            add_layers=add_layers,
            snap=params["snap"],
            snappy_geometry_rev=params["snappy_geometry_rev"],
            generate_id=generate_id,
            wsl_case=wsl_case,
            case_dir=str(case_dir),
        )
    except Exception as exc:
        return _result(False, error=str(exc), traceback=traceback.format_exc()[-2000:])


if __name__ == "__main__":
    raise SystemExit(main())
