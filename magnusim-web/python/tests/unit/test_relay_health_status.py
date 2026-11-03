"""The relay's status file keeps the run's health, its converged and its failed_reason (RH1):
they were lost after a server restart, as only live events carried them."""

from __future__ import annotations

from cfddesk.wsl.foam_relay import RelayState


def test_status_file_carries_health_converged_and_failed_reason():
    state = RelayState("fc-abcdef12-123456", "tok")
    state.observe({"event": "health", "v": 1, "verdict": "unhealthy", "step": 30})
    state.observe({"event": "converged", "by": "residuals", "time": 285})
    state.observe({"event": "failed_reason", "reason": "Boussinesq density reached zero: use incompressible perfect gas"})
    snap = state.snapshot()
    assert snap["health"] == {"v": 1, "verdict": "unhealthy", "step": 30}
    assert snap["converged"] == {"by": "residuals", "time": 285}
    assert snap["failed_reason"].startswith("Boussinesq density reached zero")
    empty = RelayState("fc-abcdef12-123456", "tok").snapshot()
    assert empty["health"] is None and empty["converged"] is None and empty["failed_reason"] is None
