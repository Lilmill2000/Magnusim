# Deferred features

These unfinished controls were removed from the release interface during the
September 2026 readiness audit. This list preserves the intended work.

- **Static structural simulation:** add the analysis definition, material model,
  boundary conditions, mesher/solver integration, and result controls before
  exposing it in the analysis picker.
- **Virtual thermocouple:** implement temperature-capable analysis and monitor
  output before restoring the point-data monitor option.
- **Energy (temperature) and passive species:** removed from the study panel in
  Phase 6 (2026-09-24) because no solve path ever read them. To restore: solve
  T and N species as transported scalars (OpenFOAM `scalarTransport` function
  objects work with simpleFoam/pimpleFoam), add inlet temperature/concentration
  and wall thermal type (fixed T, heat flux, adiabatic) to the BC editor, add
  thermal/species diffusivity (Pr, Sc), show T and species as result fields,
  and prove it with a WSL solve. Passive temperature ignores buoyancy; hot air
  rising needs the buoyant solver family, which is a separate, larger feature.

- **Plugin workspaces, later (Plugin Host H13):** a workspace opens only for a
  study in a project. To add: global workspaces that open without a project,
  an “open with” hand-off that passes one plugin's result to another (for
  example an airfoil from the Airfoil plugin into a 2D wind tunnel), and the
  2D Wind Tunnel plugin itself.

- **CAD plugin host calls, before its simulation phase (G3-G6, G9):** the CAD
  workspace keeps its parts in its own files but cannot hand one to the
  project yet. To add: a workspace call that adds a project geometry from a
  workspace file, STEP face names kept as patch names, a call that reads the
  project's geometries, and an “Open in CAD” action on geometry rows (G3-G6).
  Workspace files are read whole and sent again on every open, and the CAD
  kernel is 20 MB: stream them, let the browser revalidate them, and serve
  precompressed copies (G9).

- **Mesher plugins with their own engine:** a mesher plugin can register, but
  generating a mesh with it answers 400 “has no run path in this version”
  (`scripts/w21-mesh-generate.js`). To add: a run path that runs the plugin's
  mesher and loads its mesh like a core one, proven end to end with a fixture
  mesher plugin.

- **Mesh paths no Generate reached (removed 2026-10):** about 6.4k lines of
  core mesh and CAD code that no run used were deleted before the Standard and
  Hex-dominant meshers move into a plugin: the body-fit hex core (OCC surface,
  Cartesian flood, Delaunay peel, prism skin), the gmsh all-tet volume path and
  its OCC surface fallback, the old snappyHexMesh case writer with periodic
  (cyclic) patch pairing, CAD feature edges and CAD-adherence checks, and the
  parallel snappy and gmsh-only WSL pipelines, the STL-against-cell quality
  checks and the face-normal inlet helper. Standard, Hex-dominant and
  cfMesh are unchanged (their goldens prove it). Projects that saved
  `hexcore_backend = "bodyfit"` keep their mesh fingerprint; the value selects
  nothing. To restore one: take it from git history into a mesher plugin, with
  goldens and a WSL mesh check like the others.

- **XFLR5 polar import/export (Airfoil plugin):** XFLR5 is a desktop program
  with no command line, so the app cannot run it. To add: import and export of
  XFLR5 polar files in the Airfoil workspace.

- **GPU pressure solve (AmgX):** the old command-line case writer could put
  AmgX on the pressure equation, but nothing in the app used it, and the
  `simpleFoam_amgx` solver option wrote the same CPU case. Both were removed in
  2026-09 (Plugin Host H9). To restore: add it to the Incompressible Flow
  plugin's case writer as a real option (fvSolution `p` solver, `amgxpOptions`,
  the AmgX library in the WSL toolchain), show it only when a CUDA GPU is found,
  and prove it with a WSL solve against the CPU result.

- **Plugin environments, next steps (Plugin Host H12):** a plugin's own
  environment comes from a `[python]` table in a folder plugin's manifest; a
  plugin installed as a wheel (entry point) has none yet. The `gpu`
  requirement is checked only for an NVIDIA GPU (`nvidia-smi`). A service
  answers one call at a time. To add: environments for wheel plugins, other GPU
  vendors, and concurrent calls for services that declare they are safe.

- **Core UI consistency (Plugin Host H14):** the plugin UI kit
  (`magnusim-web/src/plugin-ui/`) copies today's core look, but the core does
  not use it yet. To do, each with Daniel's OK where users would see a change:
  - Move the core panels onto the kit: panel chrome, rows, buttons, inputs,
    toggles, hints, status blocks, and the residual plot onto LinePlot. The H10
    DOM parity baseline, `e2e/fixtures/h10-ui-parity.json` in
    `magnusim-web/bundled-plugins/incompressible_flow/`, must then be
    re-recorded on purpose. The bundled Incompressible Flow panels use core
    class names and move with them (H14 plan task 6). Move `style.css`
    colours onto tokens.
  - One look for controls in core and kit: the app font (they use the
    browser font today), one focus ring (the browser's today; the switch
    shows no focus at all), hover states on primary and secondary buttons
    (none today), and an OFF pill toggle that is not the browser button face
    (`.mesh-toggle.is-off` is dead CSS). One toast layer: app toasts and
    workspace toasts draw in the same bottom-right corner, apart.
  - Buttons: the primary blue is #1570ef (Daniel, 2026-10-02) for the kit,
    the panel primary and Kick; Home's primary is still near-black. Disabled
    is .45 in the app and .55 in
    `/plugin-sdk/theme.css`. Destructive styles use two reds (#c62828 in
    dialogs and the trash, #b42318 in reasons and menus). `.sim-def-title` is
    overridden by `.mat-panel-title`. A core Done click closes its panel twice
    (the tree's click handler and `cfd:panel-done`).
  - Plot tips: the residual plot's and the kit LinePlot's hover tip is at most
    170 px wide and does not wrap, so a readout of four series (U, p, k, ω)
    spills past the tip's own box.
  - The CAD plugin keeps two copies of `formatSci`
    (`bundled-plugins/cad/src/ui/kit/format.ts`, `src/doc/units.ts`) that
    still print 999999.9 as "1000000"; the kit's shows "1.0000e+6".
  - Units: schema forms show SI units for every quantity but length in
    imperial projects.
  - Colour: `results.color_scale.cmap` in project.json is never read; the
    Filters panel builds a colour table it never uses. cividis was left out of
    the kit because neither table is CC0 (PNNL's has Battelle BSD-style terms,
    matplotlib's has its own licence); add one with its notice if wanted.
  - Dead code: `.ml-type-soon`, `.mat-check-btn`, `.mesh-toggle.is-off`,
    `residualPaths`.

- **CAD plugin, after V1 (Magnusim CAD, `bundled-plugins/cad`):** V1 is
  parametric multi-body parts (sketches, solid features, booleans, STEP
  editing, CFD preparation). These come back in a later version:
  - assemblies and joints: components, mates/joints, and a 3D constraint
    solver (SolveSpace libslvs, GPL-3.0-or-later);
  - full surface modelling: trim, extend, boundary, fill and offset surfaces;
  - 2D drawings with dimensions, and sheet metal;
  - feature recognition on imported STEP (holes and fillets first, then
    FeatureWorks-style rebuilds as sketches and extrudes);
  - the 64-bit kernel build (`kernel-build/`) for models larger than the
    4 GB 32-bit heap;
  - the R0.125 in tangential inlet blend of the Vortex test part, which
    OCCT 7.9.3 cannot build: try a newer OCCT.

- **Plugin OpenFOAM cases and the compute slot, later (Plugin Host H15):**
  - live results in the 3D view while a plugin case runs (`results.openIn3D`
    answers `running` until it has ended);
  - residual points for a case the app found again after a restart (its stage,
    time and saved frames update, its plot does not);
  - hold the compute slot until a stopped mesh's WSL processes are gone (today
    it frees when the generator ends);
  - scope result field reads (`?case=`) to a study, as attach is;
  - busy checks for a plugin's own Python writers (its service, jobs and
    `scope["data"]`) inside a running case's folder;
  - a queue number on plugin study rows in the tree;
  - more WSL step flags (`-dict`) when a plugin needs them;
  - an optional scan for `#codeStream`, `#calc` and `systemCall` in a plugin's
    case;
  - plugin cases that start from a later time than `0`;
  - render `solve.sh` in one pass for core runs (its placeholders), as
    `foam_pre.sh` is;
  - a prepare step's own progress beyond its stage names;
  - solve hooks in a process of their own, so a plugin cannot end or bend a
    core run.

- **Faces two bodies share (October 2026):** every body is one fluid region, so
  a face two bodies share whole is inside the fluid. Each mesher meshes
  through it, and a BC on it is refused (`cfddesk/cad/shared_faces.py`). To
  add:
  - a thin wall there (a zero-thickness baffle, wall on both sides), made by
    an explicit Wall BC on the face, in all three meshers;
  - bodies that touch over only part of a face: they are not found as
    sharing, so each body keeps its own wall there;
  - one region per body (solids, conjugate heat transfer), where the shared
    face becomes an interface.

Each restored control should have a persistence check and a successful
end-to-end simulation or result-generation test. Do not expose placeholder
buttons marked “coming soon.”
