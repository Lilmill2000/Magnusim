# Link contract fixtures (host API 1.5)

The host's own parts for the face numbering contract (`tests/unit/test_link_contract.py`).
Every face index a linking plugin sends must name the same face in the host's face
table, its viewport and its mesher; these parts check that, with no plugin involved.

| Folder | Part |
|---|---|
| `a-shared` | two boxes that touch and share one face (a General Fuse): that face has one index per body |
| `b-internal` | one box with an internal square face: it has one index |
| `c-apart` | two boxes that do not touch |

Each folder: `shape.bbrep` (binary BREP), `shape.brep` (the same shape, text BREP),
`face_names.json` (written by `magnusim_sdk.link.write_face_names`) and `expected.json`
(per index: the body, centroid and area of the face, from the boxes the script defines).

Regenerate (deterministic; the hashes it prints are the same on every run):

    cd python
    .venv/Scripts/python.exe tools/gen_link_contract_fixtures.py
