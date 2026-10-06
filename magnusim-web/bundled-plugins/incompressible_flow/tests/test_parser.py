"""Incompressible Flow's solver-output parser on a simpleFoam log."""

from __future__ import annotations

from incompressible_flow.parser import IncompressibleParser

SAMPLE_LOG = """\
CFDDESK_EVENT {"event":"start","run_id":"run-1","n_procs":1,"app":"simpleFoam"}
CFDDESK_EVENT {"event":"stage","stage":"copy_to_wsl"}
CFDDESK_EVENT {"event":"stage","stage":"solve","parallel":false,"app":"simpleFoam"}
Time = 1
Smooth solver:  Solving for Ux, Initial residual = 1.2e-1, Final residual = 1e-3, No Iterations 2
Smooth solver:  Solving for Uy, Initial residual = 2.3e-2, Final residual = 1e-4, No Iterations 2
Smooth solver:  Solving for Uz, Initial residual = 3.4e-3, Final residual = 1e-5, No Iterations 1
DICPCG:  Solving for p, Initial residual = 4.5e-1, Final residual = 1e-4, No Iterations 20
Smooth solver:  Solving for omega, Initial residual = 5.6e-2, Final residual = 1e-5, No Iterations 3
Smooth solver:  Solving for k, Initial residual = 6.7e-2, Final residual = 1e-5, No Iterations 3
Time = 2
Smooth solver:  Solving for Ux, Initial residual = 1.1e-1, Final residual = 1e-3, No Iterations 2
DICPCG:  Solving for p, Initial residual = 3.3e-1, Final residual = 1e-4, No Iterations 18
CFDDESK_EVENT {"event":"time_saved","t":2}
CFDDESK_EVENT {"event":"stage","stage":"copy"}
CFDDESK_EVENT {"event":"result","ok":true,"exit_code":0}
"""


def test_progress_parser_snapshot():
    parser = IncompressibleParser()
    fields: set[str] = set()
    for line in SAMPLE_LOG.splitlines():
        fields |= {e.fields["field"] for e in parser.feed(line) if e.event == "residual"}
    snap = parser.snapshot()
    assert snap["stage"] == "copy"
    assert float(snap["saved_times"][0]) == 2.0
    assert snap["n_steps"] >= 2
    # Velocity components, pressure and the turbulence fields of the log.
    assert fields == {"Ux", "Uy", "Uz", "p", "omega", "k"}


def test_spalart_allmaras_residual_is_read():
    parser = IncompressibleParser()
    line = "smoothSolver:  Solving for nuTilda, Initial residual = 0.0123, Final residual = 1e-5, No Iterations 2"
    events = [e for e in parser.feed("Time = 1") + parser.feed(line) if e.event == "residual"]
    assert [(e.fields["field"], e.fields["initial"]) for e in events] == [("nuTilda", 0.0123)]
