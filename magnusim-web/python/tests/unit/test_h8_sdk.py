"""H8: magnusim_sdk is dependency-free and is the one copy the core uses."""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

SDK_ROOT = Path(__file__).resolve().parents[2] / "sdk"

BARE_SCRIPT = r"""
import sys
sys.path.insert(0, SDK_ROOT)
import magnusim_sdk
import magnusim_sdk.events, magnusim_sdk.units, magnusim_sdk.foam
import magnusim_sdk.gmsh_helpers, magnusim_sdk.msh22, magnusim_sdk.proc
import magnusim_sdk.data, magnusim_sdk.service
heavy = sorted(m for m in sys.modules if m.split(".")[0] in {"OCP", "pyvista", "gmsh", "numpy", "vtk", "cfddesk", "scipy"})
print("HEAVY", heavy)
try:
    import cfddesk  # noqa: F401
    print("CFDDESK importable")
except ImportError:
    print("CFDDESK missing")
try:
    import numpy  # noqa: F401
    print("NUMPY importable")
except ImportError:
    print("NUMPY missing")
"""


def test_sdk_imports_bare():
    """gate:h8-sdk-bare: no site-packages, no core on the path, and it still imports."""
    out = subprocess.run(
        [sys.executable, "-I", "-S", "-c", BARE_SCRIPT.replace("SDK_ROOT", repr(str(SDK_ROOT)))],
        capture_output=True,
        text=True,
        check=True,
        cwd=str(SDK_ROOT.parent.parent),  # not python/, so cfddesk is not on the path
    )
    assert "HEAVY []" in out.stdout, out.stdout
    assert "CFDDESK missing" in out.stdout, out.stdout
    # -S leaves site-packages out, so this environment really has no numpy.
    assert "NUMPY missing" in out.stdout, out.stdout


def test_core_uses_the_sdk_copy():
    import magnusim_sdk.events as sdk_events
    import magnusim_sdk.gmsh_helpers as sdk_gmsh
    import magnusim_sdk.msh22 as sdk_msh22
    import magnusim_sdk.units as sdk_units

    from cfddesk.jobs import events
    from cfddesk.mesh import gmsh_standard, msh22
    from cfddesk.units import convert, pressure

    # Incompressible Flow's writer uses the same copy: its own tests (test_sdk_use.py).
    assert events.emit is sdk_events.emit and events.parse_line is sdk_events.parse_line
    assert gmsh_standard.initialize_gmsh is sdk_gmsh.initialize_gmsh
    assert gmsh_standard.apply_boundary_patch_types is sdk_gmsh.apply_boundary_patch_types
    assert msh22.write_msh22 is sdk_msh22.write_msh22
    assert convert.to_si is sdk_units.to_si and pressure.pa_to_kinematic is sdk_units.pa_to_kinematic


def test_decompose_par_dict_bytes(tmp_path: Path):
    from magnusim_sdk.foam import write_decompose_par_dict

    p = tmp_path / "system" / "decomposeParDict"
    write_decompose_par_dict(p, 4)
    assert p.read_bytes() == (
        b"FoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       dictionary;\n"
        b"    object      decomposeParDict;\n}\n\nnumberOfSubdomains 4;\nmethod          scotch;\n"
    )


def test_run_exe_timeout_kills_the_tree(tmp_path: Path):
    """A timed-out program and the child it started are both gone."""
    from magnusim_sdk.proc import run_exe

    marker = tmp_path / "child.pid"
    parent = (
        "import subprocess, sys, time;"
        f"c = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']);"
        f"open({str(marker)!r}, 'w').write(str(c.pid));"
        "time.sleep(60)"
    )
    t0 = time.monotonic()
    res = run_exe([sys.executable, "-c", parent], timeout=3)
    assert res.timed_out and res.returncode is None
    assert time.monotonic() - t0 < 30
    child = int(marker.read_text())
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and _alive(child):
        time.sleep(0.2)
    assert not _alive(child), "the child process outlived the timeout"


def test_run_exe_passes_stdin_and_output():
    from magnusim_sdk.proc import run_exe

    res = run_exe([sys.executable, "-c", "import sys; print(sys.stdin.read().upper())"], stdin="plop\n", timeout=30)
    assert res.returncode == 0 and not res.timed_out
    assert res.stdout.strip() == "PLOP"


def _alive(pid: int) -> bool:
    if sys.platform == "win32":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True)
        return str(pid) in out.stdout
    import os

    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True
