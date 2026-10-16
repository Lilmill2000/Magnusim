"""The validation set's shared pieces (tests/test_ht6_validation_wsl.py): where a case's
result rows go, and readers for a solved case's cells, fields and boundary faces.

Each case writes its rows to one JSON file (``HT_VALIDATION_OUT``, by default the
plugin's committed ``validation/results.json``): one row per case, quantity and mesher,
a later run of the same row replacing it. ``validation/report.py`` turns that file into
``VALIDATION.md``.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import re
import time
from pathlib import Path
from typing import Any

PLUGIN = Path(__file__).resolve().parents[1]
RESULTS = PLUGIN / "validation" / "results.json"


def results_path() -> Path:
    raw = os.environ.get("HT_VALIDATION_OUT", "").strip()
    return Path(raw) if raw else RESULTS


def _plugin_version() -> str:
    m = re.search(r'^version\s*=\s*"([^"]+)"', (PLUGIN / "manifest.toml").read_text(encoding="utf-8"), re.M)
    return m.group(1) if m else ""


def openfoam_version(case: Path) -> str:
    """The OpenFOAM version a solved case ran with, from its solver log's header
    ("v2606 (build _481094f-20260618)"), or "" when no log names one."""
    for log in sorted(case.glob("log.*")):
        head = log.read_text(encoding="utf-8", errors="replace")[:4000]
        version = re.search(r"Version:\s*(\S+)", head)
        if version:
            build = re.search(r"^Build\s*:\s*(\S+)", head, re.M)
            name = version.group(1)
            name = name if name.startswith("v") else f"v{name}"
            return f"{name} (build {build.group(1)})" if build else name
    return ""


def error_pct(value: float, reference: float) -> float:
    return 100.0 * (value - reference) / reference


class _Lock:
    """The results file's lock: groups of cases run side by side (``-k``) each add their
    rows; a lock file made with O_EXCL keeps one writer at a time (60 s, then an error)."""

    def __init__(self, path: Path) -> None:
        self.path = path.with_name(path.name + ".lock")

    def __enter__(self) -> _Lock:
        deadline = time.monotonic() + 60.0
        self.path.parent.mkdir(parents=True, exist_ok=True)
        while True:
            try:
                os.close(os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
                return self
            except FileExistsError:
                if time.monotonic() > deadline:
                    raise TimeoutError(f"{self.path} is held (remove it if no validation run is writing)") from None
                time.sleep(0.2)

    def __exit__(self, *_exc: object) -> None:
        self.path.unlink(missing_ok=True)


def record(rows: list[dict[str, Any]], *, case: Path) -> None:
    """Add (or replace) result rows. Each row: case, quantity, reference, value, mesher,
    cells, iterations, and whatever else describes it (source, setup, mesh, detail). Each is
    stamped with the date, the plugin's version and the OpenFOAM version ``case`` ran with
    (the commit that holds the results is in git's history)."""
    path = results_path()
    when = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d")
    stamp = {"date": when, "plugin_version": _plugin_version(), "openfoam": openfoam_version(case)}
    with _Lock(path):
        doc: dict[str, Any] = {"rows": []}
        if path.is_file():
            doc = json.loads(path.read_text(encoding="utf-8"))
        keep = {(r["case"], r["quantity"], r["mesher"]) for r in rows}
        out = [r for r in doc.get("rows", []) if (r["case"], r["quantity"], r["mesher"]) not in keep]
        for r in rows:
            row = {**r, **stamp}
            row["error_pct"] = round(error_pct(float(r["value"]), float(r["reference"])), 3)
            out.append(row)
        doc["rows"] = out
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes((json.dumps(doc, indent=1, ensure_ascii=False) + "\n").encode("utf-8"))
        os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Reading a solved case
# ---------------------------------------------------------------------------


def last_time(case: Path, region: str | None = None) -> Path:
    """The latest saved time folder (of ``region`` when given)."""
    times = []
    for d in case.iterdir():
        try:
            t = float(d.name)
        except ValueError:
            continue
        if d.is_dir() and t > 0 and (region is None or (d / region).is_dir()):
            times.append((t, d))
    assert times, f"no saved time in {case}"
    return max(times)[1]


def internal_values(path: Path, width: int = 1) -> Any:
    """A volField's internal values (ascii or binary): (n,) or (n, width), numpy."""
    import numpy as np

    from heat_transfer.polymesh import _header, _list, _sizes

    raw = path.read_bytes()
    head, pos = _header(raw)
    binary, _label, scalar = _sizes(head)
    at = raw.find(b"internalField", pos)
    stripped = raw[at + len(b"internalField"):].lstrip()
    if stripped.startswith(b"uniform"):
        text = stripped[len(b"uniform"):].split(b";", 1)[0].decode("ascii").strip("() \t\r\n")
        return np.array([float(v) for v in text.split()])
    kind = b"List<scalar>" if width == 1 else b"List<vector>"
    lst = raw.find(kind, at)
    vals, _end = _list(raw, lst + len(kind), binary=binary, size=scalar, width=width, kind="f")
    return vals


def cell_geometry(poly: Path) -> tuple[Any, Any]:
    """Each cell's centroid (n, 3) and volume (n,), numpy, as OpenFOAM computes them."""
    import numpy as np

    from heat_transfer.polymesh import face_geometry, read_polymesh

    m = read_polymesh(poly)
    centre, area = face_geometry(m)
    est = np.zeros((m.n_cells, 3))
    n = np.zeros(m.n_cells)
    np.add.at(est, m.owner, centre)
    np.add.at(est, m.neighbour, centre[: m.n_internal])
    np.add.at(n, m.owner, 1)
    np.add.at(n, m.neighbour, 1)
    est /= n[:, None]
    vol = np.zeros(m.n_cells)
    acc = np.zeros((m.n_cells, 3))
    for cells, faces, sign in ((m.owner, slice(None), 1.0), (m.neighbour, slice(0, m.n_internal), -1.0)):
        fc = centre[faces]
        pv = sign * np.einsum("ij,ij->i", area[faces], fc - est[cells]) / 3.0
        pc = 0.75 * fc + 0.25 * est[cells]
        np.add.at(vol, cells, pv)
        np.add.at(acc, cells, pc * pv[:, None])
    good = np.abs(vol) > 0
    out = est.copy()
    out[good] = acc[good] / vol[good][:, None]
    return out, vol


def patch_faces(poly: Path, patch: str) -> tuple[Any, Any]:
    """The centres (n, 3) and areas (n,) of a patch's faces, numpy."""
    import numpy as np

    from heat_transfer.polymesh import face_geometry, read_polymesh

    m = read_polymesh(poly)
    p = next((p for p in m.patches if p.name == patch), None)
    assert p is not None, (patch, [q.name for q in m.patches])
    centre, area = face_geometry(m)
    sl = slice(p.start, p.start + p.n_faces)
    return centre[sl], np.linalg.norm(area[sl], axis=1)


def patch_names(poly: Path) -> list[str]:
    from heat_transfer.polymesh import read_polymesh

    return [p.name for p in read_polymesh(poly).patches]


def snappy_layers(mesh_case: Path) -> dict[str, str]:
    """Hex-dominant's layers per patch from snappyHexMesh's final layer table:
    {patch: "3.6 of 4 layers, 90 % of the thickness"} (empty when no layers were asked for)."""
    import re

    log = next(iter(sorted(mesh_case.rglob("log.snappyHexMesh*"))), None)
    if log is None:
        return {}
    lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
    heads = [i for i, line in enumerate(lines) if re.match(r"^patch\s+faces\s+layers", line)]
    if not heads:
        return {}
    out: dict[str, str] = {}
    for line in lines[heads[-1] + 3:]:
        parts = line.split()
        if len(parts) < 6:
            break
        try:
            target, mesh, pct = int(parts[2]), float(parts[3]), float(parts[5])
        except ValueError:
            break
        out[parts[0]] = f"{mesh:g} of {target} layers, {pct:g} % of the thickness"
    return out


def say(line: str) -> None:
    """Print a result line, also on a console that cannot show its symbols (cp1252)."""
    try:
        print(line)
    except UnicodeEncodeError:
        print(line.encode("ascii", "replace").decode("ascii"))
