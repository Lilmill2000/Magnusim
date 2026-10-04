"""The face table (area, centroid, normal, surface type per face visit), serial or split.

``preview.face_properties`` builds it. On a large part it is split over up to
``PROCESSES`` processes (LINK speed plan step 6): each reads the shape from its binary
BREP, numbers the faces with ``face_visits`` and computes its own run of indices. The
caller starts them before it meshes the shape for display, and reads their rows after,
so the table is computed while the main process meshes. The rows are the serial
ones, in the same order: the same shape, the same code, and JSON keeps every double.

``python -m cfddesk.cad.face_table --bbrep F --start A --stop B --out JSON
--parent-pid P`` is one such process (rows for indices A+1..B). It lives no longer than
the process P that started it: a preview killed by the link job (its timeout, a removed
geometry) takes its face-table processes with it. Their rows go to a folder beside the
binary BREP (``.face-table-*``), so the link job's staging clean-up removes what a killed
preview leaves, and a later split beside the same BREP removes one left an hour or more.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

PROCESSES = 4
# Rows per process, at least: so a part splits only from 2,000 face visits (below,
# starting processes costs more than it saves) and over fewer processes just above.
MIN_ROWS_PER_PROCESS = 1000
# A rows folder this old is a killed preview's (rows wait at most 900 s).
STALE_DIR_S = 3600.0


def face_row(idx: int, body: int | None, face: Any) -> dict[str, Any]:
    """One face visit's row (see ``preview.face_properties``), without ``shared_with``."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepGProp import BRepGProp, BRepGProp_Face
    from OCP.BRepTools import BRepTools
    from OCP.gp import gp_Pnt, gp_Vec
    from OCP.GProp import GProp_GProps

    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(face, props)
    area = float(props.Mass())
    c = props.CentreOfMass()
    centroid = [float(c.X()), float(c.Y()), float(c.Z())]
    normal = None
    try:
        adapt = BRepAdaptor_Surface(face)
        umin, umax, vmin, vmax = BRepTools.UVBounds_s(face)
        u = 0.5 * (umin + umax)
        v = 0.5 * (vmin + vmax)
        pnt = gp_Pnt()
        vec = gp_Vec()
        BRepGProp_Face(face).Normal(u, v, pnt, vec)
        if vec.Magnitude() > 0:
            vec.Normalize()
            normal = [float(vec.X()), float(vec.Y()), float(vec.Z())]
        stype = str(adapt.GetType()).split("_")[-1]
    except Exception:
        stype = "unknown"
    entry: dict[str, Any] = {
        "id": idx,
        "area": area,
        "centroid": centroid,
        "normal": normal,
        "surface_type": stype,
    }
    if body is not None:
        entry["body"] = body
    return entry


def with_shared(rows: list[dict[str, Any]], visits: list[tuple[int, int | None, Any]]) -> list[dict[str, Any]]:
    """``shared_with`` on the rows of faces two bodies share (``shared_faces.pairs``)."""
    from cfddesk.cad import shared_faces

    keys = [
        (r["id"], body, r["area"], (r["centroid"][0], r["centroid"][1], r["centroid"][2]), face)
        for r, (_idx, body, face) in zip(rows, visits, strict=True)
    ]
    shared = shared_faces.pairs(keys)
    for r in rows:
        if r["id"] in shared:
            r["shared_with"] = shared[r["id"]]
    return rows


def serial_rows(visits: list[tuple[int, int | None, Any]]) -> list[dict[str, Any]]:
    return [face_row(idx, body, face) for idx, body, face in visits]


def _python_env() -> dict[str, str]:
    root = str(Path(__file__).resolve().parents[2])
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([root, env.get("PYTHONPATH", "")]).rstrip(os.pathsep)
    env["PYTHONIOENCODING"] = "utf-8"
    return env


class Split:
    """Face-table processes running beside the caller (``start`` ... ``rows``)."""

    def __init__(self, bbrep: Path, n_visits: int, processes: int):
        self.dir = _rows_dir(bbrep)
        self.parts: list[tuple[subprocess.Popen, Path, int, int]] = []
        size = -(-n_visits // processes)
        root = Path(__file__).resolve().parents[2]
        for k in range(processes):
            a, b = k * size, min(n_visits, (k + 1) * size)
            if a >= b:
                break
            out = self.dir / f"rows-{k}.json"
            proc = subprocess.Popen(
                [
                    sys.executable, "-m", "cfddesk.cad.face_table", "--bbrep", str(bbrep), "--start", str(a),
                    "--stop", str(b), "--out", str(out), "--parent-pid", str(os.getpid()),
                ],
                cwd=str(root),
                env=_python_env(),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            self.parts.append((proc, out, a, b))

    def rows(self, timeout: float = 900.0) -> list[dict[str, Any]] | None:
        """All rows in index order, or None when a process failed (the caller goes serial)."""
        out: list[dict[str, Any]] = []
        ok = True
        try:
            for proc, path, a, b in self.parts:
                try:
                    _o, err = proc.communicate(timeout=timeout)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    ok = False
                    continue
                if proc.returncode != 0 or not path.is_file():
                    print("FACE_TABLE_WARN", (err or b"").decode("utf-8", "replace")[-300:], file=sys.stderr)
                    ok = False
                    continue
                part = json.loads(path.read_text(encoding="utf-8"))
                if len(part) != b - a:
                    ok = False
                    continue
                out.extend(part)
        finally:
            self.close()
        return out if ok else None

    def close(self) -> None:
        """Stop the processes still running and remove the rows folder (again is a no-op)."""
        for proc, _path, _a, _b in self.parts:
            if proc.poll() is None:
                proc.kill()
        for proc, _path, _a, _b in self.parts:
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        shutil.rmtree(self.dir, ignore_errors=True)


def _rows_dir(bbrep: Path) -> Path:
    """A new rows folder beside ``bbrep`` (a link job's staging, a geometry folder), after
    removing the ones a killed preview left there an hour or more ago; the system temp
    folder when that one cannot take it."""
    parent = Path(bbrep).parent
    try:
        now = time.time()
        for old in parent.glob(".face-table-*"):
            try:
                if old.is_dir() and now - old.stat().st_mtime > STALE_DIR_S:
                    shutil.rmtree(old, ignore_errors=True)
            except OSError:
                pass
        return Path(tempfile.mkdtemp(prefix=".face-table-", dir=str(parent)))
    except OSError:
        return Path(tempfile.mkdtemp(prefix="cfd-facetable-"))


def exit_with_parent(pid: int) -> None:
    """Exit this process (``os._exit``) as soon as process ``pid`` is gone.

    A killed process runs no clean-up, so the face-table processes it started watch it
    themselves: on Windows a thread waits on the parent's handle (opened now, so a reused
    pid cannot fool it); elsewhere it checks every half second.
    """
    import threading

    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        k32.WaitForSingleObject.restype = wintypes.DWORD
        k32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        synchronize, infinite = 0x00100000, 0xFFFFFFFF
        handle = k32.OpenProcess(synchronize, False, int(pid))
        if not handle:
            os._exit(3)

        def watch() -> None:
            k32.WaitForSingleObject(handle, infinite)
            os._exit(3)

    else:

        def watch() -> None:
            while True:
                try:
                    os.kill(int(pid), 0)
                except ProcessLookupError:
                    os._exit(3)
                except OSError:
                    pass
                time.sleep(0.5)

    threading.Thread(target=watch, name="face-table-parent", daemon=True).start()


def processes_for(n_visits: int) -> int:
    return max(1, min(PROCESSES, n_visits // MIN_ROWS_PER_PROCESS))


def start(bbrep: Path | None, n_visits: int, processes: int | None = None) -> Split | None:
    """Start the split face table on ``bbrep``, or None (the table is then serial)."""
    n = processes if processes is not None else processes_for(n_visits)
    if bbrep is None or n < 2 or not Path(bbrep).is_file():
        return None
    try:
        return Split(Path(bbrep), n_visits, n)
    except OSError:
        return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Rows of the face table for a run of face indices")
    ap.add_argument("--bbrep", type=Path, required=True)
    ap.add_argument("--start", type=int, required=True)
    ap.add_argument("--stop", type=int, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--parent-pid", type=int, default=None, help="exit when this process is gone")
    args = ap.parse_args(argv)
    if args.parent_pid:
        exit_with_parent(args.parent_pid)
    from magnusim_sdk.link import face_visits

    from cfddesk.cad.preview import read_bbrep

    visits = face_visits(read_bbrep(args.bbrep))[args.start : args.stop]
    rows = serial_rows(visits)
    tmp = args.out.with_name(args.out.name + ".tmp")
    tmp.write_text(json.dumps(rows), encoding="utf-8")
    tmp.replace(args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
