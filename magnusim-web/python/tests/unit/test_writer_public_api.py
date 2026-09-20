"""Product case writer lives in writer.py; web_case is a re-export."""
from __future__ import annotations

from cfddesk.case.web_case import write_web_solve_case as web_alias
from cfddesk.case.writer import write_simplefoam_case, write_solve_case, write_web_solve_case


def test_write_solve_case_is_product_alias():
    assert write_solve_case is write_web_solve_case
    assert web_alias is write_solve_case
    assert write_simplefoam_case is not write_solve_case
