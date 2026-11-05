# Snappy dict writers — where to look

One module writes the snappyHexMesh dictionaries:

| Module | Role |
|--------|------|
| `cfddesk/mesh/snappy_hexdominant.py` | Hex-dominant **web Generate** host prep: `scale_body1_stl`, `write_hexdominant_dicts`, `read_polymesh_counts`, fineness via `snappy_policy`. Driven by `tools/generate_snappy.py` + `wsl/templates/snappy_hexdominant.sh`. |
| `cfddesk/mesh/two_d.py` | **One cell across (2D)**, a Hex-dominant setting: when a part can be meshed so (`plan_two_d`), the background block one cell of the part's depth with its two ends as patches, the side faces stretched past them, then `extrudeMeshDict` (one layer from the low end, the ends `empty` while `checkMesh` checks the 2D mesh) and `createPatchDict` (the ends onto the study's Symmetry patch, which the solve makes `empty`: nothing solved across the depth). |

Surface custom sizing: each record's faces become a refinement-only STL (`write_refine_stls`) and a
`refinementRegions` entry in distance mode: its faces' size as a level of the base cell
(`refinement_level_for_size`), out to `refine_distance_m` from them: three cells of the size, or the
record's **Refine out to** (`reach` with `reach_unit`, validation gap G4) when that is further.
Standard and cfMesh size the faces only and ignore Refine out to (the refinement editor says so).

Fineness / snap knobs: `cfddesk/mesh/snappy_policy.py` (single source; JS `finenessParams` deleted in land7).
