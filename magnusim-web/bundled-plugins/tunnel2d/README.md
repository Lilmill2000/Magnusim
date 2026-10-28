# 2D Wind Tunnel

A real-time 2D wind tunnel in its own workspace, solved on the GPU as you watch. Set the wind and the fluid, drop in airfoils, shapes or bodies you sketch, then drag and turn them: the flow answers as they move. Read the forces and the pressure round a body, pin probes in the flow, and sweep an airfoil through its angles for a polar.

The plugin ships on (it can be turned off in **Settings → Plugins**). The header's **Wind tunnel** button, or **New project** on the home page with **Open a 2D wind tunnel** picked, opens a tunnel. Each tunnel is a study in its project and keeps its scene; the flow starts again when it opens.

## The tunnel

**Wind** (left): the wind speed, the fluid (air or water at 20 °C) and the flow model (below). The Reynolds number panel gives the real Reynolds number and the one simulated, and says how far to trust the numbers.

**Bodies:**
- **Add airfoil:** a NACA 4- or 5-digit section (2412, 23012), chord in the Body panel. **Import .dat…** reads a Selig or Lednicer file.
- **Add shape:** cylinder, rectangle, ellipse, flat plate, or **Sketch…** (below).
- In the view, drag a body to move it, and drag the round handle above it to turn it (Shift: whole degrees). The Body panel sets its position, angle of attack (positive raises the leading side), spin (a spinning cylinder shows the Magnus effect), whether it is in the flow, and a lock.
- Up to 8 bodies; they interact.

**Sketched bodies.** "Add shape → Sketch…" opens the CAD plugin's sketcher on a new body, over the running flow. The sketch's origin is the body's pivot. "Edit sketch" in the Body panel opens it again; Done or Esc closes it.
- Tools: select and drag, line (chained), rectangle, circle, three-point arc, spline, point, fillet, dimension.
- Relations on the selection: coincident, horizontal, vertical, parallel, perpendicular, tangent, equal, concentric, fix. Construction geometry guides the outline without being part of it.
- Double-click a dimension to type a value with units (mm, cm, m, in, ft, deg, rad). Dragging a point keeps every relation and dimension, and the body in the flow follows.
- CAD's colours: blue under-defined, black fully defined, red over-defined.
- Every closed loop is part of the body (holes and islands fill even-odd). A sketch that is not closed stays out of the flow: its open ends are circled in red, and the panel says why.

**Tunnel** (left): length, height and walls (open, slip, solid or periodic), the resolution (Auto picks the finest grid this GPU runs smoothly), and **Refine near bodies** (×2 or ×4 finer cells round each body, moving with it).

**Presets** (toolbar): flows the grid resolves at their real Reynolds number: a cylinder at Re 20, 40, 100 and 200, and a square cylinder at Re 100. Their panel compares this run's drag, Strouhal number, lift swing and wake length with published ranges, and says when the setup has been changed.

## Seeing the flow

**Show** (View panel, or the keys 1–7):
- flow with particles;
- vorticity;
- speed;
- pressure (Cp);
- density gradient (schlieren);
- rheoscopic (flakes in a tank, lit from two sides);
- none (markers on a dark background).

The legend's range follows the flow, or can be fixed.

In the app's dark theme (Settings → Appearance) the view's margins turn dark, with a grey line along the tunnel's walls, and the marks over the flow (probes, the selection, sketches) take the dark theme's colours; the flow, the bodies and the rakes keep theirs. Pictures and recordings are light in either theme.

**Flow markers:**
- tracer particles with trails;
- rakes you place and drag, releasing streaks, timelines or dye;
- velocity arrows and streamlines.

## The numbers

Select a body; under its panel, on the right:

- **Forces:** Cl, Cd, Cm, L/D, and lift, drag and moment per metre of span, as the mean over the last 4 passes of the flow past the body and now. The Strouhal number appears when the body sheds. A plot shows them over time.
  - A line above says what they were run at: the Reynolds number, the flow model, how far to trust them, the reference length, and where the moment is taken. The moment is about the pivot: the quarter chord for airfoils, otherwise the centre (or a sketch's origin); nose up is positive.
- **Surface pressure:** −Cp along the upper and lower surfaces from the leading point (0) to the trailing one (1), as XFOIL draws it, averaged over the last few seconds.
- **Angle sweep:** from, to and step. At each angle it waits 8 passes of the flow, then averages over 4. It plots Cl and Cm against α, Cd against α and the drag polar, with a table, then puts the angle back. The last sweep is kept with the tunnel.

**Hover** over the flow: the toolbar reads u, v, |u|, the pressure and Cp under the pointer.

**Probes** (left): **Add probe** pins a point you drag in the view. Each probe reads velocity, pressure and Cp five times a second, with a plot over time. Probes are kept with the tunnel.

## What the numbers mean

A grid resolves so much. Three ways to run a flow, chosen by **Flow model** (Auto picks):

- **Resolved:** the grid carries the flow as it is: exact in two dimensions when the grid resolves the real Reynolds number (the presets, small or slow bodies in water).
  - **Capped:** when it cannot, the flow runs at the highest Reynolds number the grid resolves (at most 50 per cell). The Wind panel says so, and the forces are marked "qualitative": wakes, shedding and separation show as they do at that lower number.
- **Turbulence model** (Auto from Re 100,000): Spalart–Allmaras with wall functions, at the real Reynolds number. It gives the mean flow: attached boundary layers, and stall to within a few degrees. Lift is within about 10 % at the default 128 cells per chord, 5 % at 256 and 3 % beyond (Refine near bodies). Drag reads high, about twice the real drag at the default grid, closer when refined.
  - Turbulent eddies are not drawn: 2D turbulence is not the real, 3D kind.

**Measured against references** (RTX 5090; the browser suite checks each of these on every run, within the tolerance given):

| Case | Tunnel | Reference | Checked within |
|---|---|---|---|
| Schäfer–Turek 2D-2 cylinder, 20 cells per D: St, Cd max | 0.302, 3.253 | 0.30, 3.22–3.24 | St 0.295–0.305, Cd 3 % |
| Cylinder Re 100 (preset): St, Cd | 0.168, 1.37 | 0.162–0.168, 1.31–1.37 | 1 % of the range |
| NACA 2412 at 6°, Re 660,000, refined ×2: Cl, Cm (c/4) | 0.876, −0.046 | XFOIL 0.862, −0.044 | 6 %, 0.012 |
| NACA 2412 at 6°, default grid: surface Cp | within 0.08 | XFOIL | 0.12 |
| NACA 0012 at 0°: Cl, Cm | 0.000, 0.000 | 0, 0 | 0.02, 0.01 |
| NACA 0012, −4…4° sweep: lift slope | 0.118 per degree | XFOIL 0.108 | 15 % |
| NACA 0012, Re 6 million, 4°, 200 cells per chord | Cl 0.42–0.44 | NASA SA 0.44 | 5 % |

XFOIL runs are at the same Reynolds number with transition forced at the nose (the turbulence model is fully turbulent). Refined ×4, NACA 2412 at 6° comes to Cl 0.851 and Cm −0.040.

**An open tunnel's far field.** The inlet, the open top and bottom and the absorbing layers hold the wind plus each lifting body's far-field vortex (its circulation from its lift), so the upwash ahead of an airfoil reaches the inlet as it would in open air. The incoming flow keeps one total pressure to within 1 %. A walled tunnel's inlet holds the plain wind, as a real tunnel's contraction does.

**Where the lattice is pushed past its limits** (a gap closing between two bodies, a body dragged fast), a limiter holds the flow there, and the status line says so. A clean run never uses it.

## Pictures and recordings

**Picture** (C) saves the view as a PNG. **Record** (Shift+C) records it as a WebM until you stop it. Both include the colour legend and a line saying what the view shows (the body, the wind, the Reynolds number, the time), and download from the page.

## Keyboard shortcuts

| Keys | |
|---|---|
| Space | Run or pause the flow |
| . | Step the paused flow by one frame |
| R | Reset the flow (bodies stay) |
| F | Fit the tunnel in the view (or double-click empty space) |
| 1 – 7 | Show: particles, vorticity, speed, pressure, schlieren, rheoscopic, none |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Arrows | Move the selected body (Shift: ten times as far) |
| [ / ] | Turn the selected body by 1° (Shift: 10°) |
| Delete | Remove the selected body, rake or probe |
| Esc | Clear the selection (in the sketcher: end what is being drawn, then the tool, then the sketcher) |
| C | Save a picture of the view |
| Shift+C | Start or stop recording |
| ? | Show the shortcuts |

The mouse wheel zooms; the middle button (or dragging empty space) pans.

## Requirements

WebGPU: a current Chrome or Edge with graphics acceleration on. `run.bat` opens Magnusim in its own window (Edge, else Chrome, with a Magnusim profile of its own in `.cache/app-window`), where it is on whatever your own browser is set to. Opened in your own browser instead (its address and port), the tunnel says if graphics acceleration is off there and exactly where to turn it on.

The status line names the GPU in use. On a laptop with two GPUs, Chrome on Windows may pick the integrated one; Windows' per-app graphics setting for the browser changes it.

## How it works

- **Solver.** A D2Q9 lattice Boltzmann method in WebGPU compute shaders, in the workspace page; no Python, WSL or OpenFOAM is involved.
  - Recursive-regularized collision (third order), with the stress's trace relaxed fully so sound waves die out.
  - Smagorinsky only where the grid cannot carry the fluid's viscosity.
  - Zou–He inlet and outlet, and absorbing layers at the ends and open edges.
- **Bodies** are signed distance fields in their own frames, sampled at their moving poses every step. Walls use Bouzidi's interpolated bounce-back, with the moving-wall term and Galilean-invariant momentum exchange. The step kernel sums each body's force and moment (fixed-point atomics).
- **Turbulence model:** Spalart–Allmaras in the lattice, with Spalding's wall law applied as a slip velocity at the wall.
- **Refinement:** ratio-2 patches round bodies, coupled in moment space (Lagrava et al., Astoul et al.), moving with them.
- **Markers:** particles move with the flow on the GPU, in midpoint steps of under a cell, and never cross a body. Dye uses MacCormack's corrected semi-Lagrangian scheme. The rheoscopic look carries a flake orientation tensor (Jeffery's equation), lit by two lights.
- **Sketcher:** the CAD plugin's sketch model and FreeCAD's PlaneGCS solver, run in a worker.
- **Scene file:** `studies/<id>/scene.json` in the plugin's folder of the project (tunnel, wind, bodies, rakes, probes, view, the last sweep). The flow itself is not saved.

## Development

```bash
cd bundled-plugins/tunnel2d
npm install        # @webgpu/types; everything else comes from the app's node_modules
npm run check      # typecheck, unit tests, build (workspace/ is committed)
```

The build copies the CAD plugin's PlaneGCS worker into `workspace/solver/` (the frame serves only the plugin's own files).

The browser suite runs from the app folder on the installed Chrome, because Playwright's own Chromium has no WebGPU adapter. On a machine without a GPU, `MAGNUSIM_E2E_WEBGPU=swiftshader` uses Chrome's software adapter, and the GPU-heavy tests skip themselves:

```bash
npx playwright test -c bundled-plugins/tunnel2d/e2e/playwright.config.js
```

`MAGNUSIM_E2E_SOAK=1` makes the drag soak run for 10 minutes instead of 30 seconds, and the tracer test for 5 minutes.

The NACA generator is a port of the Airfoil plugin's `airfoil/naca.py`; `tests/fixtures/gen_naca.py` regenerates the parity fixture from the Python.

## Licences

The plugin is GPL-3.0-or-later. It ships a copy of FreeCAD's PlaneGCS solver (LGPL) with Eigen, Boost and the Emscripten runtime; `LICENSES/README.md` lists each component with its licence text, and says where the LGPL source is and how to relink.
