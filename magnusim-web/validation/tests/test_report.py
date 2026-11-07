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
from validation_fakes import REAL_SCALE, fake_run, plan_run

pytestmark = pytest.mark.occt


def _exact(tmp_path: Path) -> dict:
    run_dir = plan_run(tmp_path)
    fake_run(run_dir)
    return evaluate_dir(run_dir)


def test_the_markdown_lists_each_quantity_with_its_reference(tmp_path: Path):
    res = _exact(tmp_path)
    text = build_markdown([res])
    assert "| Laminar pipe, Re = 100 | Hex-dominant | ok | Darcy friction factor × Re, developed part (x/D 10 to 13) | 64 | 64 | +0.00 % | ±2 % (inside) | pass | 120 000 |" in text
    assert "Environment: 2026-11-04: commit abc, OpenFOAM v2606 (build _481094f-20260618), 4 cores" in text
    assert "### Hex-dominant" in text and "- Status: ok." in text
    assert "converged at iteration 180" in text and "run health healthy" in text
    assert "wall layers applied (pipe_wall 3.8 of 4)" in text
    assert "Hagen" in text and "Durst" in text and "J. Fluids Eng. 127:1154-1160" in text
    assert "](../../docs/validation/img/c1_laminar_pipe-hexdominant-pressure.png)" in text
    # Beside the compared values: the line's own reading, the wall shear stress the run saved.
    assert "Plot over path's centreline over x/D 10 to 13 2 U_b" in text
    assert "the wall shear stress the run saved" in text
    # The plan's estimate of the mesh next to the mesh it got.
    assert "the plan's estimate about" in text
    # The same results give the same text.
    assert build_markdown([res]) == text


def test_a_failed_run_is_listed_with_why(tmp_path: Path):
    run_dir = plan_run(tmp_path)
    fake_run(run_dir, lines=False, driver={"outcome": "failed", "failed_step": "bcs", "error": "the BCs were not saved as sent",
                                           "ids": {}, "app": {}})
    res = evaluate_dir(run_dir)
    text = build_markdown([res])
    assert "- Status: setup_failed: the BCs were not saved as sent." in text
    assert "| SETUP FAILED | Darcy friction factor" in text
    assert "| 64 | - | - | ±2 % |" in text


def test_a_run_that_did_not_settle_is_marked_in_the_table(tmp_path: Path):
    run_dir = plan_run(tmp_path)
    fake_run(run_dir, converged=False, drift=0.01)
    res = evaluate_dir(run_dir)
    text = build_markdown([res])
    assert "| NOT SETTLED | Darcy friction factor" in text
    assert "did not reach its residual targets within 3000 iterations (over its last 10 % of iterations" in text
    page = build_site([res])["index.html"]
    assert "<td class=out>NOT SETTLED</td>" in page


def test_probes_are_never_reported(tmp_path: Path):
    from magnusim_validation.report import load_results

    root = tmp_path / "results"
    for variant, over in (("hexdominant", None), ("standard", {"hex_element_core": False})):
        run_dir = root / "c1_laminar_pipe" / variant
        from magnusim_validation.plan import make_plan

        make_plan(cases.get("c1"), variant, run_dir, cores=4, mesh_settings=over)
        fake_run(run_dir)
        evaluate_dir(run_dir)
    assert [r["variant"] for r in load_results(root)] == ["hexdominant"]
    # A mesh-only run is a probe too.
    hexd = root / "c1_laminar_pipe" / "hexdominant"
    fake_run(hexd, driver={"outcome": "mesh_only", "ids": {}, "app": {}})
    evaluate_dir(hexd)
    assert load_results(root) == []


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
    # The page carries what the report does: the notes, what is shown beside the values, the pre-run check.
    assert "<h3>Notes</h3>" in page and "skew-corrected" in page
    assert "Shown, not compared:" in page and "Pre-run check: info still_start" in page
    doc = json.loads(files["results.json"])
    assert doc["results"][0]["case"] == "c1_laminar_pipe"


def test_build_and_check_round_trip(tmp_path: Path):
    res_root = tmp_path / "results"
    run_dir = res_root / "c1_laminar_pipe" / "hexdominant"
    run_dir.mkdir(parents=True)
    # Every locked value inside its band: the round trip is about the texts (test_locks.py: a
    # locked value outside its band).
    fake_run(run_dir, scale=REAL_SCALE)
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


def test_heat_transfers_own_set_is_in_the_report_and_on_the_page(tmp_path: Path):
    """Daniel (2026-11-05): the page shows Heat Transfer's results too, from its own committed
    rows, with their citations and the words on how its runs differ from this set's."""
    from magnusim_validation import heat_transfer

    ht = heat_transfer.load()
    assert ht is not None and len(ht["rows"]) >= 10
    res = _exact(tmp_path)
    text = build_markdown([res])
    assert "## Heat Transfer" in text and "not sent over the app's HTTP routes" in text
    assert "| de Vahl Davis cavity, Ra = 1e5 | Nu-bar (mean of the hot and cold walls) | 4.519 | 4.494 ± 0.00 % | -0.55 % | Hex-dominant | 105 518 |" in text
    assert "Reference: G. de Vahl Davis, Natural convection of air in a square cavity" in text
    assert "V. Gnielinski" in text and "Shah and A. L. London" in text
    files = build_site([res], ht)
    page = files["index.html"]
    assert "<h2>Heat Transfer</h2>" in page and "de Vahl Davis" in page and "Gnielinski" in page
    assert page.index("<h2>Heat Transfer</h2>") < page.index("<h2>How to reproduce</h2>")
    doc = json.loads(files["results.json"])
    assert doc["heat_transfer"]["source"] == "bundled-plugins/heat_transfer/validation/results.json"
    assert len(doc["heat_transfer"]["rows"]) == len(ht["rows"])
    # Without Heat Transfer's rows the page has no such section.
    assert "<h2>Heat Transfer</h2>" not in build_site([res])["index.html"]


def test_the_report_and_the_page_say_the_tolerances_were_locked_after_daniel_reviewed_the_second_full_run(tmp_path: Path):
    """Daniel (2026-11-07): lock the 46 values, k-omega SST on Standard report-only. The report and the
    page say when and after what the tolerances were locked, never that they lock later."""
    res = _exact(tmp_path)
    text = " ".join(build_markdown([res]).split())
    page = build_site([res])["index.html"]
    said = "The tolerances were locked on 2026-11-07, after Daniel reviewed the second full run of the whole set"
    assert said in text and said in page
    assert "**Locked.**" in text and '<span class="badge">Locked 2026-11-07</span>' in page
    assert "<code>npm run validation:report -- --check</code>" in page
    for out in (text, page):
        assert "locked once Daniel" not in out and "Report-only.**" not in out and "No case fails on these numbers yet" not in out
        assert "proposed ones" not in out


def test_no_doc_says_the_tolerances_lock_later():
    """Every text that told of the lock to come says it happened (2026-11-07)."""
    from magnusim_validation.paths import WEB

    repo = WEB.parent
    later = ("locked once Daniel", "lock once Daniel", "not locked until Daniel", "not locked yet",
             "once Daniel has reviewed a full run", "until Daniel has reviewed", "Nothing is locked")
    for path in (WEB / "validation" / "README.md", WEB / "validation" / "VALIDATION.md", WEB / "docs" / "TESTING.md",
                 WEB / "bundled-plugins" / "heat_transfer" / "VALIDATION.md",
                 WEB / "bundled-plugins" / "heat_transfer" / "README.md", repo / "README.md",
                 repo / "RELEASE_AUDIT.md", repo / "ROADMAP.md", repo / "docs" / "validation" / "index.html"):
        if not path.is_file():
            continue
        text = " ".join(path.read_text(encoding="utf-8").split())
        assert [w for w in later if w in text] == [], path.name


def test_the_error_is_given_in_its_bands_own_unit():
    """The vortex centre's band is ±0.01 L: its error reads in L (it read "-0.07 %" beside "±0.01 L");
    a relative band keeps the error in %, and a reference of zero reads in its unit."""
    from magnusim_validation.report import band_text, err_text

    vortex = {"unit": "L", "error": {"abs": -0.00040630459, "rel_pct": -0.0659360595}, "tolerance": {"abs_tol": 0.01, "rel_pct": None}, "within": True}
    assert (err_text(vortex), band_text(vortex)) == ("-0.000406 L", "±0.01 L (inside)")
    psi = {"unit": "", "error": {"abs": 0.000171, "rel_pct": 0.1654411}, "tolerance": {"abs_tol": None, "rel_pct": 2.0}, "within": True}
    assert (err_text(psi), band_text(psi)) == ("+0.17 %", "±2 % (inside)")
    rms = {"unit": "U_lid", "error": {"abs": 0.0023354, "rel_pct": None}, "tolerance": {"abs_tol": 0.01}, "within": True}
    assert err_text(rms) == "+0.00234 U_lid"
