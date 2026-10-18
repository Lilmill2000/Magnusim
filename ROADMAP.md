# Deferred features

These unfinished controls were removed from the release interface during the
September 2026 readiness audit. This list preserves the intended work.

- **Static structural simulation:** add the analysis definition, material model,
  boundary conditions, mesher/solver integration, and result controls before
  exposing it in the analysis picker.
- **Passive species:** a scalar the flow carries without changing it (a
  concentration, a dye, smoke): solve N species as transported scalars
  (OpenFOAM `scalarTransport` function objects work with simpleFoam/pimpleFoam
  and with the Heat Transfer plugin's buoyant solvers), add each species'
  inlet concentration and wall condition to the BC editor and its diffusivity
  (Sc), show the species as result fields, and prove it with a WSL solve.
  Temperature, buoyancy and heat conducted through solids ship in the Heat
  Transfer plugin 0.1.0.

- **The Assistant (v0.5.0, in progress):** a model the person chooses (a cloud
  provider with their own key, or a local server on this PC) works in Magnusim
  through tools, asking before anything that can't be undone. Its foundation is
  built: keys kept encrypted and write-only, Settings → Assistant with a
  connection test, limits and a privacy setting, turns that run on the server
  with their questions shown in the app, three read-only app tools, and tools a
  workspace page offers (bridge 1.9, unreleased: the host still says 1.8). A
  turn starts from the terminal client (`scripts/assistant-run.mjs`) until the
  chat panel lands. CAD's tools are built too: an open Part offers 18 (read
  the Part, find faces and edges, measure, look at pictures, help, set
  parameters, sketch, extrude, revolve, sweep or loft, holes, fillet, chamfer
  or shell, pattern or mirror, combine bodies, name or colour a body, change a
  feature, undo its own steps, and delete features after asking). Each call
  is all or nothing and one request is one undo step; the person watches it
  work in the Part's own panels and sketch mode, with Pause, Stop, Undo,
  Fast / Watch and "Ask each step" on the Part's chip, and takes over with
  Escape (`bundled-plugins/cad/README.md`, "The Assistant in the Part").
  Before it ships: a live check of the tool set against both cloud providers'
  strict schemas, and the first evaluation runs on real models. Next, in this
  order: a server other assistant programs can connect to (MCP), the chat
  panel, and other plugins' tools; then the 1.9 bridge and SDK 1.5.0 release.
  - **CAD's Assistant tools, later:** more tools (Split, Press-pull, Delete
    faces, the Enclosure, Import STEP, CONSTRUCT's axes and points, a face
    extrude, Project / Intersect, sketch patterns and offsets; it reads them
    and can change or delete them today), a batch tool if the evaluation shows
    builds running out of steps, undo that survives a reload, and kernel
    queries the selectors could use (face wires, edge convexity, the nearest
    point, rays). No export tool: the person exports with Export STEP.

- **Plugin workspaces, later (Plugin Host H13):** a workspace opens only for a
  study in a project. To add: global workspaces that open without a project,
  and an “open with” hand-off that passes one plugin's result to another (for
  example an airfoil from the Airfoil plugin into a 2D wind tunnel).

- **2D Wind Tunnel, later:**
  - **CAD sketches into the tunnel:** a tunnel body's sketch is already CAD's
    sketch format; importing one from a CAD Part needs a host call that hands
    a 2D profile across plugins.
  - **XFOIL and NeuralFoil beside the tunnel's numbers:** the Airfoil plugin's
    polars and Cp over the tunnel's surface-pressure plot and angle sweep (a
    call across plugins).
  - **Walled tunnels' far field:** an open tunnel holds a lifting body's
    far-field vortex at its inlet and edges; a slip or solid-walled one would
    need its image vortices, and keeps the plain wind at its inlet. The drag's
    far-field source term is also left out.
  - **16-bit populations:** tried in T6 and dropped. IEEE half precision, even
    stored less the weights, moved the Schäfer–Turek Strouhal number from
    0.302 to 0.42 at 20 cells per diameter (0.56 at 40), and was slower on the
    test GPU. A custom 16-bit format (more mantissa, less exponent) might pass.
  - **Sketcher tools:** trim, extend, offset, mirror and slots (CAD has them in
    its own editor), and dimensions shown in the unit system's units (they are
    typed in any, but shown in mm).
  - **Sweep settings:** the passes to settle and to average are fixed at 8 and
    4.

- **CAD plugin host calls, still to add (G9):** a CAD Part becomes its
  project's linked geometry, with its face names as patch names (host API 1.5
  and 1.6, `ws.project.linkGeometry` and the exit hook). G5 and G6 are done in
  v0.3.0 as Edit in CAD (host API 1.7): a geometry added as a STEP, IGES or
  BREP file has “Edit in CAD” on its tree row, in the viewport's right-click
  menu and in the Geometry panel; the Part reads that geometry
  (`ws.project.geometrySource`, `geometryFaces`), and its first update goes
  back into it with its boundary conditions and joins the same live link.
  To add: workspace files are read whole and sent again on every open, and
  the CAD kernel is 22 MB: stream them, let the browser revalidate them, and
  serve precompressed copies (G9).

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

- **Plugin installs that survive a crash:** installing a plugin from a zip moves
  the copies it replaces aside until the new one has loaded, and puts them back
  when it does not. If the app's worker dies or hangs between the move and that
  check, the new copy stays in `plugins/<key>` and the old one is deleted with
  the staging folder an hour later. To add: a small journal (`pending.json`
  beside the moved copies, written before the move and removed after) that the
  next start reads to finish the rollback; and the same for a native Python
  extension, which needs the other worker processes to let go of the plugin
  before its folder can move (today: restart the app, then install).

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
  - Units: schema forms show SI units for every quantity but length in
    imperial projects.
  - Colour: `results.color_scale.cmap` in project.json is never read; the
    Filters panel builds a colour table it never uses. cividis was left out of
    the kit because neither table is CC0 (PNNL's has Battelle BSD-style terms,
    matplotlib's has its own licence); add one with its notice if wanted.
  - Dead code: `.ml-type-soon`, `.mat-check-btn`, `.mesh-toggle.is-off`,
    `residualPaths`.

- **CAD plugin V1 (Magnusim CAD, `bundled-plugins/cad`; 0.1.0,
  October 2026):** 0.1.0 is the MVP: sketches, solid features, patterns,
  reference geometry, booleans, STEP editing, the Enclosure, the live link
  to the project and Edit in CAD for a project geometry. Its known
  limitations are listed in the plugin's `README.md`. Next, in this order:
  - V1-M, modelling breadth: hole wizard, draft, variable-radius fillets,
    guide rails for Sweep and Loft, 3D sketch paths, the surface basics, a
    command palette, a view cube and mouse presets;
  - V1-C, CFD preparation: split face, an internal fluid volume (the air
    inside a part), defeature by size, projected area;
  - from 0.1.0's limitations: Press-pull with a "keep tangent faces" switch,
    re-rounding fillet chains and corner blends, and the "what works" search
    above 2,000 faces; spline offsets that follow their source; Extend and
    curve dimensions on splines; a "move faces" pattern; Revolve and Sweep
    that join a body they touch, as an option; Sweep's Keep orientation that
    moves the profile to the path's start; a place in the landing report for
    a plugin's own line (the broken-reference note).

- **CAD plugin, after V1:** V1 is parametric multi-body parts (sketches, solid
  features, booleans, STEP editing, CFD preparation). These come back in a
  later version:
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

- **Faces two bodies share (October 2026):** bodies of one material are one
  region, so a face two of them share whole is inside it. Each mesher meshes
  through it, and a BC on it is refused (`cfddesk/cad/shared_faces.py`).
  Bodies of different materials (a Heat Transfer study) are regions of their
  own, and the face between them is a coupled interface. To add:
  - a thin wall there (a zero-thickness baffle, wall on both sides), made by
    an explicit Wall BC on the face, in all three meshers;
  - bodies that touch over only part of a face: they are not found as
    sharing, so each body keeps its own wall there (and Heat Transfer does not
    couple them there).
- **Heat Transfer, after 0.1.0 (`bundled-plugins/heat_transfer`):**
  - radiation (P1, fvDOM, solar load);
  - temperature-dependent properties, and anisotropic conductivity (a circuit
    board conducts better along its layers);
  - contact resistance between two bodies (a layer's thickness and
    conductivity, written on both sides of the interface);
  - thin walls (baffles) on shared faces, and bodies that touch over only
    part of a face (not coupled there today);
  - Joule heating, humidity and condensation, phase change, porous media,
    rotating zones (MRF);
  - solid regions on cfMesh (it is refused with the reason today);
  - a Mesh panel warning for a solid about one cell thick (Start refuses it
    today), Wall heat flux monitors on the faces between bodies (the run's
    monitors list each interface's heat), a starting temperature per body;
  - a K/°C/°F picker on the results legend, and a gravity arrow in the
    viewport while the study panel is open;
  - the energy balance counts the heat the flow carries through openings, not
    heat conducted back out of an inlet;
  - heat through walls on Standard (tetrahedral) meshes: the validation read
    it up to about 14 % high next to a laminar flow (the laminar pipes),
    about 20 % low with wall functions (the turbulent pipe), about 6 % high
    through a solid's walls (the gradient at the wall of a tetrahedron;
    corrected schemes do not help), and within 1.5 % in the cavity; the
    study panel says so, and a Heat Transfer study's new mesh starts on
    Hex-dominant. A wall-normal correction, or prism layers that always
    hold, would fix it;
  - the turbulent pipe (Re = 50 000, k-omega SST, wall functions) reads
    about 10 % under Gnielinski's correlation on Hex-dominant, more than the
    correlation's own scatter, and why is not known yet (its slices are 17.5
    to 22.5 D after a uniform inlet; the wall's y+ is about 12 to 56, so part
    of the first cells sit in the buffer layer): a longer pipe or a fully
    developed inlet, and y+ near 1 with low-Re wall treatment or y+ above 30
    everywhere, would tell which;
  - the validation set's tolerances, once its first full run is reviewed
    (it is report-only: `bundled-plugins/heat_transfer/VALIDATION.md`), and
    its public page.

Each restored control should have a persistence check and a successful
end-to-end simulation or result-generation test. Do not expose placeholder
buttons marked “coming soon.”
