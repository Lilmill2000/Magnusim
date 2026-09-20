"""Stale generate_* processes on the same case folder must be identified."""
from __future__ import annotations

import os
from pathlib import Path

from cfddesk.mesh.generate_guard import LOCK_NAME, pids_targeting_case


def test_pids_targeting_case_matches_same_folder_only():
    case = Path(r"C:\proj\meshes\Mesh_1\case")
    self_pid = os.getpid()
    rows = [
        (10, r"python tools\generate_standard.py --case-dir C:\proj\meshes\Mesh_1\case --generate-id old"),
        (11, r"python tools\generate_standard.py --case-dir C:\proj\meshes\Mesh_2\case --generate-id other"),
        (12, r"python tools\generate_standard.py --case-dir C:/proj/meshes/Mesh_1/case --generate-id slash"),
        (13, r"python tools\generate_snappy.py --case-dir C:\proj\meshes\Mesh_1\case"),
        (14, "python notepad.py --case-dir C:\\proj\\meshes\\Mesh_1\\case"),
        (self_pid, r"python tools\generate_standard.py --case-dir C:\proj\meshes\Mesh_1\case --generate-id self"),
    ]
    got = set(pids_targeting_case(rows, case, keep_pids={self_pid}))
    assert got == {10, 12, 13}


def test_lock_name_is_dotfile():
    assert LOCK_NAME == ".generate.lock"


def test_reap_all_generators_is_exported():
    from cfddesk.mesh.generate_guard import reap_all_generators

    assert callable(reap_all_generators)
