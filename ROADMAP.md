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

Each restored control should have a persistence check and a successful
end-to-end simulation or result-generation test. Do not expose placeholder
buttons marked “coming soon.”
