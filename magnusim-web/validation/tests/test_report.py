"""The report: each result row lists its reference, error and band, a failed run says why,
the page needs nothing from outside, and --check finds a report that is out of date."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from magnusim_validation import cases
from magnusim_validation.evaluate import evaluate_dir
from magnusim_validation.report import build_all, build_markdown
from magnusim_validation.site import build_site
from validation_fakes import fake_run, plan_run

pytestmark = pytest.mark.occt


def _exact(tmp_path: Path) -> dict:
    run_dir = plan_run(tmp_path)
    fake_run(run_dir)
    return evaluate_dir(run_dir)


def test_the_markdown_lists_each_quantity_with_its_reference(tmp_path: Path):
    res = _exact(tmp_path)
    text = build_markdown([res])
    assert "| Laminar pipe, Re = 100 | Hex-dominant | Darcy friction factor × Re, developed part (x/D 10 to 13) | 64 | 64 | +0.00 % | ±2 % (inside) | 120 000 |" in text
    assert "Environment: 2026-11-04: commit abc, OpenFOAM v2606 (build _481094f-20260618), 4 cores" in text
    assert "### Hex-dominant" in text and "- Status: ok." in text
    assert "converged at iteration 180" in text and "run health healthy" in text
    assert "wall layers applied (pipe_wall 3.8 of 4)" in text
    assert "Hagen" in text and "Durst" in text and "J. Fluids Eng. 127:1154-1160" in text
    assert "](../../docs/validation/img/c1_laminar_pipe-hexdominant-pressure.png)" in text
    # The same results give the same text.
    assert build_markdown([res]) == text


def test_a_failed_run_is_listed_with_why(tmp_path: Path):
    run_dir = plan_run(tmp_path)
    fake_run(run_dir, lines=False, driver={"outcome": "failed", "failed_step": "bcs", "error": "the BCs were not saved as sent",
                                           "ids": {}, "app": {}})
    res = evaluate_dir(run_dir)
    text = build_markdown([res])
    assert "- Status: setup_failed: the BCs were not saved as sent." in text
    assert "| 64 | - | - | ±2 % |" in text


def test_the_page_is_self_contained_and_has_both_themes(tmp_path: Path):
    res = _exact(tmp_path)
    files = build_site([res])
    page = files["index.html"]
    assert page.startswith("<!doctype html>")
    assert "prefers-color-scheme:dark" in page
    assert '<meta name="viewport"' in page
    # No script, and nothing loaded from another site.
    assert "<script" not in page
    assert not re.search(r'(src|href)="(https?:)?//', page)
    assert 'src="img/c1_laminar_pipe-hexdominant-pressure.png"' in page
    doc = json.loads(files["results.json"])
    assert doc["results"][0]["case"] == "c1_laminar_pipe"


def test_build_and_check_round_trip(tmp_path: Path):
    res_root = tmp_path / "results"
    run_dir = res_root / "c1_laminar_pipe" / "hexdominant"
    run_dir.mkdir(parents=True)
    fake_run(run_dir)
    from magnusim_validation.plan import make_plan

    make_plan(cases.get("c1"), "hexdominant", run_dir, cores=4)
    evaluate_dir(run_dir)
    md, site = tmp_path / "VALIDATION.md", tmp_path / "docs" / "validation"
    assert build_all(check=True, root=res_root, md_path=md, site_dir=site) == 1
    assert build_all(root=res_root, md_path=md, site_dir=site) == 0
    assert (site / "img" / "c1_laminar_pipe-hexdominant-pressure.png").is_file()
    assert (tmp_path / "docs" / ".nojekyll").is_file()
    assert build_all(check=True, root=res_root, md_path=md, site_dir=site) == 0
    md.write_text(md.read_text(encoding="utf-8") + "edited\n", encoding="utf-8")
    assert build_all(check=True, root=res_root, md_path=md, site_dir=site) == 1
