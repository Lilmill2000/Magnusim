"""A steady run shorter than its write interval still writes its last iteration."""
from cfddesk.case.writer import _steady_control_dict_body


def _write_interval(text: str) -> str:
    return next(line.split()[1].rstrip(";") for line in text.splitlines() if line.startswith("writeInterval"))


def test_write_interval_never_exceeds_the_end_iteration():
    assert _write_interval(_steady_control_dict_body(40, 100, "")) == "40"
    assert _write_interval(_steady_control_dict_body(200, 50, "")) == "50"
