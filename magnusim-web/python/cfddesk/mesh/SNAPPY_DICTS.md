# Snappy dict writers — where to look

One module writes the snappyHexMesh dictionaries:

| Module | Role |
|--------|------|
| `cfddesk/mesh/snappy_hexdominant.py` | Hex-dominant **web Generate** host prep: `scale_body1_stl`, `write_hexdominant_dicts`, `read_polymesh_counts`, fineness via `snappy_policy`. Driven by `tools/generate_snappy.py` + `wsl/templates/snappy_hexdominant.sh`. |
| `cfddesk/mesh/two_d.py` | **One cell across (2D)**, a Hex-dominant setting: when a part can be meshed so (`plan_two_d`), the background block one cell of the part's depth with its two ends as patches, the side faces stretched past them, then `extrudeMeshDict` (one layer from the low end, the ends `empty` while `checkMesh` checks the 2D mesh) and `createPatchDict` (the ends onto the study's Symmetry patch). |

Fineness / snap knobs: `cfddesk/mesh/snappy_policy.py` (single source; JS `finenessParams` deleted in land7).
