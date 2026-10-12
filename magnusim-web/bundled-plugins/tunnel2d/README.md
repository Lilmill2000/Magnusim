# 2D Wind Tunnel

A real-time 2D wind tunnel in its own workspace. Set the wind speed and the fluid, add airfoils (NACA 4- and 5-digit, or a `.dat` file) and shapes, then drag and turn them. The flow answers as they move, in vorticity, speed, pressure (Cp) or a density-gradient (schlieren) view.

Flow markers show where the flow goes:

- **Tracers:** particles through the whole tunnel, with fading trails.
- **Rakes** you place and drag, in three kinds:
  - streaks: a continuous thread from each emitter;
  - timelines: a line released at intervals that the flow stretches and rolls up;
  - dye.
- **Velocity arrows and streamlines.**
- **A plain dark background,** to show the markers on their own.

The plugin ships off. Turn it on in **Settings → Plugins**; the header's **Wind tunnel** button then opens a tunnel.

## How it works

- **GPU solver.** The flow is solved in the workspace page on the GPU with WebGPU compute shaders. The method is a D2Q9 lattice Boltzmann solver: recursive-regularized collision, a Smagorinsky model when the grid cannot resolve the flow, Zou–He inlet and outlet, and absorbing layers at both ends. No Python, WSL or OpenFOAM is involved.
- **Bodies.** Each body is a signed distance field in its own frame, sampled at its moving pose every step. Walls use Bouzidi's interpolated bounce-back, with the moving-wall term and Galilean-invariant momentum exchange.
- **Validation.** The solver passes the Schäfer–Turek 2D-2 cylinder benchmark: St 0.302 and Cd max 3.253 at 20 cells per diameter. The browser suite checks this on every run.
- **Markers.** Particles are carried by the velocity field on the GPU, in midpoint steps of under a cell, so they never cut through a body. One that ends up inside a body is pushed back out along the distance field, or leaves the flow if it cannot be.
- **Dye.** Dye is advected with MacCormack's corrected semi-Lagrangian scheme (clamped, so it never overshoots).
- **Scene file.** A tunnel keeps its scene (tunnel, wind, bodies, rakes, view) in `studies/<id>/scene.json` in the plugin's folder of the project. The flow itself starts again when the tunnel opens.

## What the numbers mean

A grid can only resolve so much. The lattice runs at a grid Reynolds number of at most 50 per cell, so a body 200 cells long is simulated at about Re 10,000, whatever the real one is. The Wind panel shows both, the real one and the simulated one, and says when they differ. Wakes, shedding, separation and how bodies affect each other show as they do. Forces are those of the simulated Reynolds number.

Where the flow is pushed beyond what the lattice can carry, a limiter holds it to its limits there: for example, a gap closing between two bodies, or a body dragged fast. The status line says when this happens. A clean run never uses it, and the benchmark checks that too.

## Requirements

WebGPU: a current Chrome or Edge with hardware acceleration. On a laptop with two GPUs, Chrome on Windows may pick the integrated one. The status line names the GPU in use, and Windows' per-app graphics setting for the browser changes it.

## Development

```bash
cd bundled-plugins/tunnel2d
npm install        # @webgpu/types; everything else comes from the app's node_modules
npm run check      # typecheck, unit tests, build (workspace/ is committed)
```

The browser suite runs from the app folder on the installed Chrome, because Playwright's own Chromium has no WebGPU adapter. On a machine without a GPU, `MAGNUSIM_E2E_WEBGPU=swiftshader` uses Chrome's software adapter:

```bash
npx playwright test -c bundled-plugins/tunnel2d/e2e/playwright.config.js
```

`MAGNUSIM_E2E_SOAK=1` makes the drag soak run for 10 minutes instead of 30 seconds, and the tracer test for 5 minutes.

The NACA generator is a port of the Airfoil plugin's `airfoil/naca.py`. `tests/fixtures/gen_naca.py` regenerates the parity fixture from the Python.
