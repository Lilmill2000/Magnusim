"""OpenFOAM invocation via WSL2 Ubuntu-24.04."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass

from cfddesk.wsl.config import get_wsl_distro

OPENFOAM_WRAPPER = "openfoam2606"


def __getattr__(name: str):
    if name == "WSL_DISTRO":
        return get_wsl_distro()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


@dataclass(frozen=True)
class WslCommandResult:
    returncode: int
    stdout: str
    stderr: str
    argv: list[str]


def escape_wsl_bash_dollars(inner: str) -> str:
    """Protect ``$`` so ``wsl.exe`` does not expand vars before bash sees them.

    On Windows, ``wsl … bash -lc 'x=1; echo $x'`` arrives at bash as
    ``echo`` with an empty expansion — ``wsl.exe`` strips ``$VAR`` from the
    argument. Escaping as ``\\$`` lets bash receive a real ``$``.
    """
    return inner.replace("$", "\\$")


def wsl_bash_argv(inner: str) -> list[str]:
    """Build ``wsl -d … -- bash -lc <inner>`` with dollar escaping applied."""
    return [
        "wsl",
        "-d",
        get_wsl_distro(),
        "--",
        "bash",
        "-lc",
        escape_wsl_bash_dollars(inner),
    ]


def run_wsl_bash(inner: str, *, timeout: float = 120.0) -> WslCommandResult:
    """Run ``bash -lc`` inside the CFD WSL distro."""
    argv = wsl_bash_argv(inner)
    completed = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    return WslCommandResult(
        returncode=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
        argv=argv,
    )


def smoke_simplefoam(*, timeout: float = 120.0) -> WslCommandResult:
    """Gate A0 smoke: ``simpleFoam -help`` under sourced OpenFOAM v2606."""
    # openfoam2606 is a wrapper that sources the ESI env then runs the rest.
    inner = f"{OPENFOAM_WRAPPER} bash -c 'simpleFoam -help'"
    return run_wsl_bash(inner, timeout=timeout)
