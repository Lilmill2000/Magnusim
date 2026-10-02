# Deferred features

These unfinished controls were removed from the release interface during the
September 2026 readiness audit. This list preserves the intended work.

- **Static structural simulation:** add the analysis definition, material model,
  boundary conditions, mesher/solver integration, and result controls before
  exposing it in the analysis picker.
- **Water preset:** verify the supported incompressible material workflow and
  its unit conversions, then restore the preset in material pickers.
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

- **Plugin e2e in the default suite (G0):** a bundled plugin's own e2e specs
  (`bundled-plugins/<key>/e2e/`) run neither with the core suite nor in CI,
  because `playwright.config.js` reads only `e2e/`. To add: load them with the
  core specs, locally and in CI.

- **Mesher plugins with their own engine:** a mesher plugin can register, but
  generating a mesh with it answers 400 “has no run path in this version”
  (`scripts/w21-mesh-generate.js`). To add: a run path that runs the plugin's
  mesher and loads its mesh like a core one, proven end to end with a fixture
  mesher plugin.

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
  - Buttons: the panel primary is #3b5bdb, Home's primary is near-black and
    Kick is #1f6feb. The kit's primary token is #3b5bdb; Daniel may pick
    #1570ef, a one-token change. Disabled is .45 in the app and .55 in
    `/plugin-sdk/theme.css`. Destructive styles use two reds (#c62828 in
    dialogs and the trash, #b42318 in reasons and menus). `.sim-def-title` is
    overridden by `.mat-panel-title`. A core Done click closes its panel twice
    (the tree's click handler and `cfd:panel-done`).
  - Bugs found while building the kit, not fixed yet: the results legend
    gradient is not the colours the render draws; Home shows sim times from 1
    to 10 ms as "5.0e-3 s" where the workbench shows "0.005 s"; the Mesh and
    Run panels show "62:05" past an hour where the viewport chip shows
    "1:02:05"; the job-finished toast is probably hidden under an open
    workspace (layer 40 under 1500; not yet checked in a browser); the
    residual hover tip is cut off at the right edge.
  - Formatters: four `formatSimTime` copies (workbench, ResidualPlot, Home,
    the Incompressible Flow transient settings); null and '' print "0 s";
    99.95 prints "100.0 s". `formatSci` prints 999999.9 as "1000000".
  - Units: `unitIsImperial('min')` is true; `BcPanel.tsx` keeps a second unit
    table; the Incompressible Flow case writer uses psi 6894.757 and inH₂O
    249.089 where the app uses 6894.757293168 and 249.08891; schema forms show
    SI units for every quantity but length in imperial projects.
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

Each restored control should have a persistence check and a successful
end-to-end simulation or result-generation test. Do not expose placeholder
buttons marked “coming soon.”
