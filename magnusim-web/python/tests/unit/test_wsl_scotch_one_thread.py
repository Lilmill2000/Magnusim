"""Every WSL script that can split a mesh into ranks runs scotch on one thread.

Ubuntu's scotch 7 (the libscotch WSL's OpenFOAM v2606 links) splits on several threads
and gives the same mesh a different split each run: three decomposePar runs of one
81,000-cell box gave three splits, a Hex-dominant Generate of one study gave the same
cell count with a third of the cells moved, and one mesh solved twice on 4 ranks took
another path from its first iteration. With ``SCOTCH_PTHREAD_NUMBER=1`` all of these
repeat exactly, and a 3,000,000-cell decomposePar takes no longer (about 4 s either way).
``tests/wsl/test_foam_case_wsl.py`` runs a case twice on real OpenFOAM to show it.
"""

from __future__ import annotations

import re

import generate_snappy

from cfddesk.wsl.foam_case import foam_pre_template_path, render_foam_pre
from cfddesk.wsl.solve_run import render_solve_script

EXPORT = "export SCOTCH_PTHREAD_NUMBER=1"
# A line that runs an OpenFOAM program (the wrapper sources OpenFOAM, then runs the rest),
# or foam_pre.sh's __STEPS__, where its steps' calls go.
_FOAM_CALL = re.compile(r"^\s*[^#\n]*(\bopenfoam2606\b|__STEPS__)", re.M)
# What can split a mesh: decomposePar, or a program run on several ranks (snappyHexMesh's
# own balancing in parallel splits with the same method).
_SPLITS = re.compile(r"\bdecomposePar\b|\bmpirun\b|-parallel\b")


def _set_before_first_call(text: str) -> None:
    lines = text.split("\n")
    assert EXPORT in lines, "the script does not set one-thread scotch"
    first = _FOAM_CALL.search(text)
    assert first is not None, "no OpenFOAM call in the script"
    assert text.index(EXPORT) < first.start(), "one-thread scotch is set only after an OpenFOAM call"


def test_every_template_that_splits_a_mesh_sets_one_thread_scotch():
    folder = foam_pre_template_path().parent
    splitting = sorted(p.name for p in folder.glob("*.sh") if _SPLITS.search(p.read_text(encoding="utf-8")))
    # The three that split a mesh today; a new one is checked the moment it can.
    assert {"foam_pre.sh", "snappy_hexdominant.sh", "solve.sh"} <= set(splitting), splitting
    for name in splitting:
        text = (folder / name).read_text(encoding="utf-8").lstrip("﻿")
        try:
            _set_before_first_call(text)
        except AssertionError as exc:
            raise AssertionError(f"{name}: {exc}") from None


def test_the_rendered_scripts_keep_it():
    solve = render_solve_script(
        dst="/home/u/cases/cfddesk-w27-run-1",
        win_out="/mnt/c/p/runs/run-run-1",
        n_procs=4,
        app="pimpleFoam",
        run_id="run-1",
        frame_fields=("U", "p"),
    )
    pre = render_foam_pre(
        dst="/home/u/cases/cfddesk-pf-foam-demo-st-1-0123abcd",
        win_out="/mnt/c/p/case",
        token="0123abcd",
        steps=[{"tool": "blockMesh"}, {"tool": "decomposePar"}, {"tool": "renumberMesh", "parallel": True},
               {"tool": "reconstructParMesh"}],
        n_procs=4,
    )
    snappy = generate_snappy.render_snappy_script(dst="/home/u/cases/c", win_out="/mnt/c/p/mesh", generate_id="g-1")
    for name, text in (("solve.sh", solve), ("foam_pre.sh", pre), ("snappy_hexdominant.sh", snappy)):
        assert "-parallel" in text, name
        try:
            _set_before_first_call(text)
        except AssertionError as exc:
            raise AssertionError(f"{name}: {exc}") from None
