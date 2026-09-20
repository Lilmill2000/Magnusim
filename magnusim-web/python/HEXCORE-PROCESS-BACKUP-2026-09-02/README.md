# Hexcore process backup — 2026-09-02

Frozen **before** any surface-first / body-fitted hexcore work.

If that experiment fails, restore the files under `src/` onto the live
paths listed below. Do **not** throw this folder away.

This is **not** a CAD-conforming snap-to-STEP mesher. It is cfMesh
`cartesianMesh`: hex bulk + poly skin, plus thin-wall gap local/object
refinement. Boundary vertices hug the STL, not the BREP.

## Product mapping (do not blur)

| UI | Backend |
|----|---------|
| Standard + Hex element core **on** | cfMesh `cartesianMesh` |
| Standard + core **off** | gmsh all-tet (already BREP-fitted) |
| Hex-dominant | snappyHexMesh (unchanged) |

## Live paths ↔ backup copies

| Live | Backup |
|------|--------|
| `cfddesk/mesh/cfmesh_standard.py` | `src/cfmesh_standard.py` |
| `cfddesk/cad/gaps.py` | `src/gaps.py` |
| `cfddesk/mesh/case_writer.py` | `src/case_writer.py` |
| `cfddesk/mesh/feature_edges.py` | `src/feature_edges.py` |
| `cfddesk/wsl/mesh_run.py` | `src/mesh_run.py` |
| `tests/test_cad_gaps.py` | `src/test_cad_gaps.py` |
| `scripts/verify_cfmesh_edge_adhere.py` | `src/verify_cfmesh_edge_adhere.py` |
| `scripts/verify_outlet_gap.py` | `src/verify_outlet_gap.py` |

Known-good `system/meshDict` (F=5 vortex, gap-aware v2):
`meshDict.v2.production`

## Pipeline (host → WSL)

1. `sizing_from_base_cell`: max = fineness base; boundary = max/2; skin = max/4
2. Multi-solid ASCII STL; wall faces split `walls__f*`
3. STL max edge = clamp(skin, 6–12 mm)
4. CAD `featureEdgeMesh` → `cadFeatures.eMesh`
5. `hexcore_gap_controls` → localRef + hollowCone when gap < 2×skin
6. `write_mesh_dict` (`allow_gap_min_cell=False` — **never** drop global minCellSize to the gap cell)
7. WSL: `surfaceFeatureEdges -angle 25` → `geometry.fms`
8. `cartesianMesh`
9. `createPatch` merges `walls__f*` and retypes inlet/outlet `wall` → `patch`
10. `checkMesh`

## Locked knobs

| Knob | Value |
|------|--------|
| `minCellSize` | = `boundaryCellSize` (no volume flood) |
| `localRefinement "walls.*"` | cellSize=skin, thickness=0.5×skin; skip if skin < 4 mm |
| `keepCellsIntersectingBoundary` | 1 |
| `boundaryLayers nLayers` | 0 |
| Gap cell | `gap / min_cells_across_passage` on VF patches + hollowCone only |
| Fingerprint token | `hexcore_recipe = cfmesh_gap_aware_v1` |

**Banned:** `localRefinement ".*"`, localRef thickness ≥ 3×skin, `minCellSize` ≪ boundary, STL edge from bulk (=max/2), deep `additionalRefinementLevels` on edges, retired gmsh ~27-hex box.

## Last verified numbers

Edge/skin lock (`verify_cfmesh_edge_adhere.py`, 2026-08-06):

| Preset | Cells | Skin layers | Edge p95 | Cone p95 |
|--------|------:|------------:|---------:|---------:|
| Coarse F=3 | 64.5k | 2.14 | 3.6 mm | 4.2 mm |
| Standard F=5 | 645k | 2.15 | 5.7 mm | 1.4 mm |
| Fine F=8 | 823k | 2.79 | 0.5 mm | 1.4 mm |

Outlet-gap v2 (`OUTLET-GAP-VERIFY.json`): **754,477** cells, **0** metal-interior cells, **0** lid faces, barrel peel p50 **2.53 mm** (same as the 645k mesh). Isolated WSL id `cfddesk-outlet-gap-v2`.

## Restore

Copy each `src/<file>` back to the live path in the table. Re-run
`tests/test_cad_gaps.py` and `tests/test_hexcore_solve_prereqs.py`.
Do not restore into the user’s live WSL case (`cfddesk-cfddesk`) unless
they ask. After restore, Generate Mesh in the UI — do not cite a scripted
mesh as the UI test.
