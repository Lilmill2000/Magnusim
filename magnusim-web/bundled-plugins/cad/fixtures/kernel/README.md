# Kernel test fixtures

Used by `tests/kernel/kernel-*.test.ts` (`npm run test:kernel`) and
`e2e/cad-p1-kernel-ops.spec.ts`. Nothing here is served to the workspace.

| File | What | Source |
|---|---|---|
| `vortex-cfd-test.step` | "Vortex CFD Test": the fluid volume of a cyclone separator, 1 solid, 17 faces, 34 edges, inch units (sha256 `d40156af…c71e5b`, 64,518 bytes) | Daniel Milligan's test part, exported from Fusion; given for Magnusim's CAD tests |
| `box20.step` | a 20 mm cube (AP214) | generated natively with OCCT 7.9.3 (P0 fixtures) |
| `flange.step` | a 100 x 100 x 10 plate with 4 through holes r = 5 (AP214) | generated natively with OCCT 7.9.3 (P0 fixtures) |
| `vortex-recipe.calls.json` | the kernel calls (profiles, extents, boolean kinds) of the Vortex part rebuilt from scratch | P0 Vortex recipe (native rebuild); edge indices in it are native and are not used: tests find edges by name |
| `reference.json` | native reference values: OCCT 7.9.3 through cadquery-ocp 7.9.3.1.1, trimmed to what the tests read; conventions in its `about` | P0 fixtures workstream, 2026-09-30 |

The 113 MB STEP (`8m0119333_V12.step`) is not in the repository. Its test is
opt-in: `CAD_KERNEL_BIG_STEP=<path> npm run test:kernel -- bigstep`.

`.gitattributes` keeps the STEP files byte for byte (no line-ending changes).
