# Testing

Magnusim has unit tests (Vitest, `node --test`, pytest) and browser tests
(Playwright, "e2e"). The browser tests include real meshing and solving in WSL,
which is slow. A full run on 2026-10-01 took 47 minutes: core 13.7 min, CAD
6.2 min and Incompressible Flow 27.2 min, nearly all of it in the tests that mesh
and solve. The core suite without them takes about 8 minutes. So which tests you
run depends on what you are doing.

## Which tests to run when

| When | Run | Time |
|---|---|---|
| While you work on something | `npm run typecheck`, the unit tests for that area, and the e2e specs for what you touched | seconds to minutes |
| Before a local commit | `npm run test:e2e:changed`: the suites your change can affect, without WSL meshes and solves | minutes |
| Before a push, and nightly | `npm run test:e2e`: every suite, with real meshes and solves | about 47 min |
| Before a release of a physics plugin | Its validation set: Heat Transfer's `pytest -m validation ../bundled-plugins/heat_transfer/tests -s` (from `python/`), then `python ../bundled-plugins/heat_transfer/validation/report.py` | about two hours |
| Before a release, and nightly | The app's validation set: `npm run test:validation` (WSL meshes and solves through the app's routes, then `npm run validation:report`) | minutes per case (case 1: about 2 min a mesher at 4 cores) |

The full run is the gate before a push. It is not needed for every commit. A
validation set is never part of `-m wsl`: its cases run only when asked for.

## The validation set

`magnusim-web/validation/` (its `README.md`) compares the app's results with published
reference values: each case is a STEP file imported into a project, set up, meshed and
solved through the routes the page and the Assistant use, then measured from its monitors
and Plot over path. It is opt-in: its browser suite (`validation/playwright.config.js`)
skips unless `MAGNUSIM_E2E_VALIDATION=1`, no default suite or CI job runs it, and
`scripts/e2e-suites.mjs` counts a change under `validation/` (and its two scripts) as
running no suite. Its harness's own parts (plans, face selectors, extraction, comparison,
the report) are tested by pytest (`validation/tests`, in `npm run test:py` and CI) and
`scripts/__tests__/validation-driver.test.mjs` (in `npm run test:server`).

| Command | What it runs |
|---|---|
| `npm run test:validation` | Every case and variant at 8 cores, one run at a time under the WSL test lock, then the report. |
| `npm run test:validation -- --case c1 --variant standard --cores 4` | One case and mesher. `--coarse` makes quick coarse runs into `validation/results-coarse/` (never committed); `--mesh-only` meshes and records the mesh facts only, and `--mesh '{"hex_element_core":false}'` or `--study '{"grad_limiter":"none"}'` change the case's mesh or study settings by hand: these are probes, into `validation/results-probe/` (never committed, never reported); `--no-report` skips the report. |
| `npm run validation:report` | `validation/VALIDATION.md` and the public page (`docs/validation/` at the repository's root) from the committed results; `-- --check` exits 1 when they are out of date (pytest checks this too). |

Its app server loads only the bundled plugins (not the test plugins the core suite loads).
`MAGNUSIM_E2E_LOCK=0` lets it run beside another WSL test run (set `--cores` low then);
a run's result records WSL's load while it solved, so run times compare like with like.
Results are report-only until the first full run's tolerances are locked; then a locked
quantity outside its tolerance fails `npm run test:validation` and blocks a release.

| Command | What it runs |
|---|---|
| `npm run test:e2e -- <spec path>` | One spec, in the suite that holds it (`e2e/...` or `bundled-plugins/<key>/e2e/...`). Set `MAGNUSIM_E2E_WSL=0` when it doesn't mesh or solve. |
| `npx playwright test e2e/<spec>.js` | One core spec, directly. |
| `npm run test:e2e:changed` | The fast tier of the suites the changed files affect (see below). `-- --full` adds WSL. |
| `npm run test:e2e:fast` | Every suite, without WSL meshes and solves. |
| `npm run test:e2e` | Every suite, with WSL meshes and solves when WSL with OpenFOAM is on the PC. |
| `npm run test:e2e:core` | The core suite only (`playwright test`). |
| `npm run test:e2e -- --suite incompressible_flow` | One suite (`core`, `cad`, `incompressible_flow`; repeatable). |

`test:e2e:changed` reads the changed files from `git status` (staged,
unstaged and untracked). In a shared checkout that includes other people's
uncommitted work, so it may run more than your change needs, never less. Name
your own files with `-- --files a,b,c` (also the way to use it in a snapshot
without `.git`). `-- --base origin/master` adds the commits a push would send;
`-- --plan` prints what it would run and why, and runs nothing.

## Suites

| Suite | Where | What it covers |
|---|---|---|
| core | `e2e/` (`playwright.config.js`) | Home, projects, geometry import, meshing, the compute queue, panels, and the plugin host, tested with small test plugins from `python/tests/fixtures/`. |
| incompressible_flow | `bundled-plugins/incompressible_flow/e2e/` (its `playwright.config.js`, on the core's Playwright and app server) | Its studies and run settings, every steady and transient solve, and the results views, monitors and exports those solves feed. |
| cad | `bundled-plugins/cad/e2e/`, run by `npm run test:e2e` in that folder (its own toolchain) | The Part workspace, against this checkout's app. |

**What a change runs** (`scripts/e2e-suites.mjs`). A plugin sits on top of the
core, so a core change can break a plugin without touching it, but a plugin
change cannot change the core.

| Changed | Runs |
|---|---|
| Documentation (`*.md`, `*.txt`, `docs/`), unit tests (`*.test.*`, `__tests__/`, `python/tests/` except `fixtures/`, a plugin's `tests/`), the plugin template, files outside `magnusim-web/` | nothing |
| `bundled-plugins/<key>/` | that plugin's suite, plus the core specs that check how the core meets its bundled plugins (`h5-plugins`, `h8-contract`, `start-actions-bundled`); never another plugin's suite |
| Only core spec files (`e2e/*.spec.js`) | those specs |
| Anything else in the app (`src/`, `scripts/`, `python/`, `e2e/support/`, fixtures, config, dependencies) | the core suite, Incompressible Flow's suite, and CAD's suite when the file is one CAD reaches (below) |

Incompressible Flow's studies run through the whole core (meshing, BCs,
materials, the run panel, results), so every core change runs its suite. CAD
reaches the app only through the plugin host, so a core change runs CAD's suite
only when it touches what CAD uses. That list is `HOST_PATHS.cad` in
`scripts/e2e-suites.mjs` (until CAD declares `"magnusim": {"e2eHostPaths": [...]}` in
its `package.json`): the workspace host, the plugin SDK and API, the UI kit, the app shell,
the tree, Settings, the dialogs, the Node server, the registry and worker, the
project tree and plugin data writes, `magnusim_sdk`, the e2e harness, the
build config and dependencies. A change elsewhere (`runtime.js`, the panels,
the viewer, the mesh and solve scripts, the meshers) still runs the core suite,
whose plugin-host specs (`h5`, `h11`, `h13`, `g1`, `g7`, `g11`) check the
same host with test plugins.

## Python package boundaries

`python/tools/core_layers.py` (CI job `plugin-boundary`) fixes which
`cfddesk` packages may import which (`ALLOWED` in that file). A new
cross-package import fails until it is added to `ALLOWED` on purpose, and an
entry nothing uses any more fails too, so the graph only shrinks unnoticed,
never grows. The graph started as it was on 2026-10-01. That graph is not
layered: eight pairs of packages import each other (nine on 2026-10-01; the
report lists them under `cycles`), so a change in one of those packages can still reach the other.
Removing a cycle is how a package becomes safe to change on its own.

## Real meshes and solves (WSL)

Every test runs by default, including real meshing and solving, whenever WSL
with OpenFOAM is on the PC; without it those tests skip and say why (GitHub CI
has no WSL, so CI never meshes or solves).

- `MAGNUSIM_E2E_WSL=0` skips them on purpose.
- `MAGNUSIM_E2E_HEAVY=0` skips only the long solves.
- `MAGNUSIM_E2E_WSL=1` fails the run if the toolchain is missing.
- `npm run test:e2e` is the full tier, so it sets `MAGNUSIM_E2E_FULL=1` for
  every suite. A test whose prerequisite is missing fails there instead of
  skipping (the Airfoil plugin's environment, built for its lock). Naming spec
  paths, `--fast`, `--changed` and `MAGNUSIM_E2E_WSL=0` are not the full tier.
- `e2e/phase1-land9-solve.spec.js` checks a public deployment and runs only
  with `MAGNUSIM_PUBLIC_E2E=1` and its URL settings.

**One WSL run at a time.** Two runs that mesh and solve at once share WSL's
CPU, and each takes about twice as long. A core run that may mesh or solve
waits for the PC's WSL test lock, `%LOCALAPPDATA%\Magnusim\e2e-wsl.lock`
(`e2e/global-setup.js`). It prints who holds the lock once a minute while it
waits. A run that can't reach a WSL test doesn't wait: `MAGNUSIM_E2E_WSL=0`, or
only specs that never mesh or solve. A lock left by a process that has ended is
ignored.

- `MAGNUSIM_E2E_LOCK_WAIT_MS` bounds the wait (default 4 hours).
- `MAGNUSIM_E2E_LOCK=0` skips the lock.

**Two runs in one tree** need different `MAGNUSIM_E2E_PORT`s. A run on a port other
than 8083 gets its own projects root and prefs (`e2e/.tmp-projects-<port>`,
`e2e/.tmp-prefs-<port>.json`): each run's server start empties its root and seeds it
again, so a shared root lost a running test's projects. `MAGNUSIM_E2E_PROJECTS_ROOT`
names a root the run uses as it is (its server start never empties it).

## Stress runs (slow pages)

A CI runner is slower than a desktop, and a race between the page and the app's
answers can show there only. `MAGNUSIM_E2E_CPU_THROTTLE=N` (N > 1) slows every
page of a test's browser context N times through the DevTools protocol
(`Emulation.setCPUThrottlingRate`): the test's page before the test starts, a
popup or second tab as it opens, and a frame with a process of its own. A
workspace frame shares its page's process in Playwright's Chromium, so the
page's throttle covers it. The app server keeps its speed. Unset, it changes
nothing and opens no DevTools session. The first test of each worker logs
`[stress] pages CPU-throttled Nx`.

```sh
MAGNUSIM_E2E_CPU_THROTTLE=4 npx playwright test e2e/link-leave.spec.js
MAGNUSIM_E2E_CPU_THROTTLE=6 npm run test:e2e -- e2e/cad-p4a-construct.spec.ts   # in bundled-plugins/cad
```

A spec takes part when it imports `test` and `expect` from the harness instead of
`@playwright/test`: core specs from `e2e/support/stress.js`, a plugin suite on the
core's Playwright from `e2e/support/plugin-suite.js`, CAD's specs from
`bundled-plugins/cad/e2e/stress.ts` (CAD's own `@playwright/test`, the same
`e2e/support/cpu-throttle.mjs`). Specs opt in one by one (a one-line import
change); the others run unthrottled. Types still come from `@playwright/test`. A
context a test makes itself (`browser.newContext()`) is not throttled.

- **A stress pass is separate and never gates.** Run it nightly or before a
  release, not in the CI that gates a push: timeouts sized for a normal run can
  fail under it without a bug. Use 4×, and 6× for CAD's view timing (camera
  refits, picks by screen position).
- **Mirror settings.** Match GitHub's runner first: 4 cores (`taskset -c a,b,c,d`),
  one Playwright worker (the configs' default), Python on `PATH`, `CI=1`. Then
  add the throttle. Capping the whole machine (`taskset` to 1 core, a systemd
  `CPUQuota`) slows the server and the page alike, so it keeps their order and
  shows no race.
- **It does not replace a forcing test.** On 2026-10-14 neither of that day's
  GitHub-only failures (`link-leave.spec.js` "a stall, a throw, a page reload…",
  CAD `cad:p4a-construct-edges`) failed at 4×, 6× or 10× on the code before
  their fixes. Throttling looks for a race. Once a race is found, the test that
  keeps it fixed forces its timing (below).

## Writing tests

- **Every bug fixed gets a browser test in a suite that runs by default.** It
  asserts what the user sees, after the action and after a reload. It runs in
  every full run, and whenever a change can affect its suite.
- **A race gets a test that forces its timing**, so it fails every time on the code
  before the fix (check that by reverting the fix once), not only on a slow runner.
  Hold a request with `page.route` until the test lets it through (the viewport menu
  before the first tree read, `e2e/geometry-actions.spec.js`), or use a test-only
  switch: the server's are `MAGNUSIM_TEST_*` environment variables (pass them with
  `startHost({ env })`); the page's are `window.__CFD_TEST_*__` globals the test sets,
  never the app. `window.__CFD_TEST_WORKSPACE_CLOSE_MS__ = N` keeps a workspace
  mounted N ms after the address left it (`e2e/link-leave.spec.js`, a quick way out
  and back). `MAGNUSIM_TEST_UI_SYNC=1` adds `POST /api/test/ui-sync`, which says a
  record changed as a host tool does after its write (`scripts/server/ui-channel.ts`),
  and, with `MAGNUSIM_TEST_ASSISTANT=1`, the host tool `test_ui_sync` a scripted model
  can call; the window counts the changes it reloaded in `window.__CFD_UI_SYNCS__`
  (`e2e/assistant-core-stale.spec.js`). `MAGNUSIM_TEST_COMPUTE=fake` makes the
  compute the app starts a stand-in (`scripts/test-compute.js`), so a test of what
  the person sees while a mesh generates, a run solves, either is stopped or ends,
  or This PC is checked needs no OpenFOAM, no WSL and no minutes: meshes run
  `python/tools/fake_mesh_generate.py` through the same live job, compute slot and
  queue (`MAGNUSIM_TEST_MESH_SECONDS`, default 6; `MAGNUSIM_TEST_MESH_RESULT=fail`;
  `MAGNUSIM_TEST_MESH_CHECKMESH=<checkMesh report>` puts that report in the case and writes
  the mesh's facts and quality as a real mesher does: `e2e/mesh-quality-line.spec.js`, with
  OpenFOAM's own reports in `python/tests/fixtures/mesh-facts/checkmesh/`),
  a Start runs `scripts/test-solve.js` after every check a real Start makes
  (`MAGNUSIM_TEST_SOLVE_SECONDS`, default 6; `MAGNUSIM_TEST_SOLVE_RESULT=fail`) and keeps the
  run's pre-run check as a real Start's plan does (`prepare_run.checks`: `e2e/run-precheck.spec.js`), and
  each hardware probe answers after `MAGNUSIM_TEST_HW_PROBE_MS` (default 1500) with a
  plausible PC (`e2e/assistant-jobs.spec.js`, `e2e/assistant-core-chain.spec.js`).
  `MAGNUSIM_TEST_SOLVE_LOG=<solver log>` (`.gz` too) makes the fake solve "solve" that
  log for run health: the real tracker (`python -m magnusim_sdk.health replay --events`)
  writes it into the run's `case/log.<app>` a time step every
  `MAGNUSIM_TEST_SOLVE_PACE_MS` (default 40), with the hints of
  `MAGNUSIM_TEST_SOLVE_HINTS` (else the log's `<name>.hints.json`), and the run doc gets
  each health event through the runner's shape check and scrub; the run ends once the log
  is read and `MAGNUSIM_TEST_SOLVE_SECONDS` have passed (`e2e/run-health.spec.js`, with
  Run_2's log in `python/tests/fixtures/health/`).
  `MAGNUSIM_TEST_SOLVE_FAIL_START=<run name>[|<run name>]` makes a fake Start of a run of
  that name fail before its solver starts, as a plan that fails does, and
  `MAGNUSIM_TEST_HEALTH_CHECK_HOLD_MS` holds "Check its log"'s answer that long after the
  log was read, as a long log's would (`e2e/run-health-ended.spec.js`).
- **A plugin's tests go in its own suite**, not in `e2e/`.
- **To let a stress run reach a spec**, import `test` and `expect` from the harness:
  `./support/stress.js` (core), `../../../e2e/support/plugin-suite.js` (a plugin
  suite), `./stress` (CAD) ("Stress runs").
- **A test that needs WSL** says so with `test.skip(!WSL, NO_WSL)` from
  `e2e/toolchain.js`, so the fast tier skips it cleanly. Setup that needs no
  solver (copying settings, editing refinements, picking engines) belongs in a
  test without that guard, so the fast tier and CI still check it.
- **A second app server** (other plugins, another projects root, other
  settings) comes from `startHost()` in `e2e/support/host-server.mjs`. It picks
  a free port and gives the server its own temp projects root, prefs and
  plugins folder. Don't pick `MAGNUSIM_E2E_PORT + N` by hand.

  ```js
  const host = await startHost({ name: 'g1', pluginsFrom: 'python/tests/fixtures/workspace-plugins' });
  try {
    await page.goto(`${host.base}/#/p/...`);
  } finally {
    host.stop();
  }
  ```

  Its options cover:
  - another bundled folder (`bundledDir`);
  - turning on bundled plugins that ship off (`enablePlugins`);
  - extra settings and environment (`prefs`, `env`);
  - a caller-filled temp folder (`tmp`, `projects`, `pluginsDir`, from `e2eTemp()`);
  - a private Vite cache (`viteCacheDir`);
  - another checkout (`webRoot`);
  - reusing a live server (`lock`).

  The header of `e2e/support/host-server.mjs` lists them all.

## The Assistant in tests

No test reaches a real model provider or this PC's real Assistant files.

- **The fake provider.** `e2e/support/fake-llm.mjs` is a small server the test
  process starts: `const fake = await startFakeLlm()`. It speaks three dialects (the
  first cloud dialect, the second cloud dialect and the local-server dialect) over
  server-sent events, and the app's real adapters talk to it.
  - `fake.reply(...steps)` queues the next answers, one per request. A step can
    stream text, thinking and tool calls, set usage and the stop reason, refuse,
    answer as a fallback model, `hold` until `fake.release(name)`, send an overload
    error, drop the connection, or wait before it answers (the file's header lists
    every field). A step may also be a function `(body) => step` (or a promise of
    one): the request that takes it passes a copy of its body, so a scripted step can
    answer from an earlier tool result. The log keeps the step it returned; one that
    throws or returns nothing is answered 400 and shows in the request's `refused`.
  - `fake.failNext({status, body, headers, times})` answers the next request(s) with
    an error; add `'x-should-retry': 'false'` to stop the client's own retries. A 400
    whose body says the strict tool schemas can't be compiled makes a cloud adapter send
    the request again: with fewer tools strict (the smallest) when its words say the set
    is too big, else with the workspace's tools not strict; the workspace tools spec
    runs a turn through each (the loose one from the terminal client).
  - `fake.strictBudget(bytes, dialect)` (the first cloud dialect by default) refuses
    (400, `GRAMMAR_TOO_LARGE`, that dialect's words) a request whose strict tool schemas
    pass `bytes` in all (each schema's JSON in UTF-8), as a provider refuses a strict set
    too big to compile; `fake.strictBudget(null, dialect)` clears it. The providers' node tests drive the
    smaller-strict search with it (which k is taken, the order by size, what is kept per
    tool set, the cap of 6 requests).
  - `fake.models(list)` sets what the model lists answer; `fake.holdModels(name)` makes
    the next list wait until `fake.release(name)` (a server that never answers).
  - An entry of `fake.models(list, 'compat')` may be a model row,
    `{id, context, max, type, route}`: the local server then answers the app's read of
    that model's context and type at the first row route (`GET <root>/api/v0/models/<id>`;
    a row with `max` and no `context` is a model not loaded yet), or with `route: 'show'`
    at the second (`POST <root>/api/show`), in the shapes of `LOCAL_SERVER_ROWS`, which
    the file exports with where each shape came from. The app keeps a row 60 s (a not
    loaded model's only until its next read), drops it when a turn ends failed for the
    context, and a test reset forgets it. `e2e/assistant-local-context.spec.js` runs
    turns from the terminal client against a small and a larger context.
  - `fake.textOnly(...ids)` makes the local server refuse (400, `TEXT_ONLY_REFUSAL`) a
    request for one of those models that carries an image, as a server whose model
    can't read images does; `fake.textOnly()` clears it. The workspace tools spec runs a
    local turn whose tool returns a picture against it: the app sends the request again
    with words in the picture's place, and the next turn sends no picture.
  - `fake.requests()` lists every request with its headers and body (`kind` is `chat`
    for a model request, `model_row` for a row read);
    `fake.disconnects()` counts answers the client closed early.
  - Like the real services, it answers 400 when a request breaks a rule: a tool call
    left without its result, an echoed opaque part (thinking, fallback, encrypted
    reasoning) that changed, a strict tool schema with a limit keyword, a replayed
    reasoning item without its encrypted content. So a test that passes against it
    has sent what the real service accepts, with one catch: a cloud request whose strict
    workspace tool breaks a schema rule (a limit keyword, the strict budget) is sent
    again by the app with fewer tools strict or the workspace's tools not strict, and
    the turn goes on with a note. `followTurn`'s `ended()` (and so `startTurn`'s) fails a turn that got that
    note unless the test passes `{strictFallback: true}`; a test that follows a turn
    another way (the terminal client) checks for the note itself.
- **Pointing the app at it.** Both cloud adapters go to the fake with
  `MAGNUSIM_TEST_ASSISTANT=1` and `MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL=<fake.base>`.
  The address is honoured only with the switch, in a test home and for plain http on
  this PC; status reports `test_provider: true` while it is in use. The local server
  needs no switch: save `fake.compatBase` as its address in Settings.
- **Other switches.** Each needs `MAGNUSIM_TEST_ASSISTANT=1` and is otherwise
  ignored with a log line: `MAGNUSIM_TEST_ASSISTANT_PROTECTOR=blocked|timeout|slow:<ms>|file`
  sets how keys are encrypted (`file` avoids the Windows helper in node tests).
  The page relay's three, for browser tests, also need a test home:
  - `MAGNUSIM_TEST_ASSISTANT_HOLD_MS=<ms>` shortens how long an app tab keeps its
    link after its last turn (10 minutes otherwise), even while hidden;
  - `MAGNUSIM_TEST_ASSISTANT_DORMANT_MS=<ms>` sets how long a tab whose link dropped
    keeps its tools as not connected (the hold otherwise), so a test with a short
    hold can still look at a dormant tab without racing its end;
  - `MAGNUSIM_TEST_ASSISTANT_ACK_MS=<ms>` shortens how long the server waits for a
    page to acknowledge a tool call (10 s otherwise).

  They take whole milliseconds from 1 to 3600000, and status reports them as
  `test_hold_ms`, `test_dormant_ms` and `test_ack_ms` while in use. The switch
  itself also registers `GET /api/test/assistant/state` (turns, open questions, each
  tab's link: connected, dormant, tools, pending call, rev) and
  `POST /api/test/assistant/reset` (`{files: true}` also removes the test home's
  files and attachments; a reset leaves the tabs' links, so open pages stay linked);
  the state lists the files attached in the dock (`attachments`: id, name, bytes,
  format, tab, conversation), and `POST /api/test/assistant/attachments/sweep
  {later_ms}` runs their sweep as if that much later (an unbound file goes after an
  hour). `e2e/assistant-core-attach.spec.js` uses both. `run.bat` and
  the setup scripts set none of them, and a test checks that.
- **The provider debug log.** `MAGNUSIM_ASSISTANT_DEBUG_LOG=<folder>` (no test switch
  needed; it works in normal runs too, off when unset, read once) makes the server
  append a row per model request to `<folder>/provider.jsonl`, a local file only: the
  turn, the dialect and model, the attempt (strict, reduced or loose, with its strict
  count; with or without images) and why, the whole request body as sent, each HTTP answer's status and request id,
  the time taken, and the result (stop reason, usage, the blocks with their tool
  calls) or the error with the provider's whole answer. Rows are redacted, never hold
  a header or a key, and image data is a marker with its size.
  `scripts/server/__tests__/assistant-debug-log.test.js` checks it; the CAD eval
  harness sets it for the servers it starts (`bundled-plugins/cad/eval/README.md`).
- **Home isolation.** The Assistant keeps its keys, settings and spend in
  `MAGNUSIM_ASSISTANT_HOME`, else beside `MAGNUSIM_LOCAL_JSON` (`local.json` →
  `local.assistant/`). Every node test sets both to temp paths before its first app
  import (and lists itself in `H15_TESTS`); e2e servers get their own folder from
  `e2e/support/app-config.js` and `startHost()`.
- **Node tests** import the fake dynamically (`await import('../../../e2e/support/fake-llm.mjs')`)
  after setting those paths, start it, then set the provider address before the first
  request (the app reads it once).
- **The node harness.** `scripts/server/__tests__/assistant-harness.js` (not a test
  itself; imported dynamically after the temp paths are set) holds what the loop,
  gate, terminal-client and relay tests share:
  - `FakeClock`: time and timers that move only with `advance(ms)`;
  - `ScriptedProvider`: a provider adapter whose answers a test scripts, for the
    turn loop without any HTTP;
  - `makeManager()`: a turn manager on them, with in-memory settings, a stand-in
    key store, a real spend ledger in a temp folder and a real tool registry;
  - `relayServer()`: a server wired as `index.ts` wires one (the event hub and the
    Assistant's routes), with `page()`, a client that holds a tab's event stream and
    speaks the relay (open a channel, register, ack, progress, result, a cut from
    the server's side), and the demo workspace's tools (`demoTools()`).
- **The terminal client.** `scripts/assistant-run.mjs` runs one turn against a running
  app and prints it: `node scripts/assistant-run.mjs --port <port> [--tab auto|<id>]
  [--json] "prompt"`. `--tab auto` binds the turn to the only connected app tab;
  questions are asked at the terminal (y/n) and, for a tab-bound turn, also in the
  app, where either answer counts. Exit codes: 0 done, 1 anything else, 2 the tab
  isn't connected. `assistant-cli.test.js` runs it against the harness, and the
  workspace tools spec against a browser tab. By hand, point it at a test server
  started with the switches above, never at the app with this PC's real keys.
- **The workspace tools spec.** `e2e/assistant-workspace-tools.spec.js` runs the
  whole chain in a browser: the fake → the server's turn loop → the page relay on
  the tab's event stream → the workspace bridge → the frame of the test plugin
  `ai-demo` (`python/tests/fixtures/assistant-plugins`) → back.
  - The plugin's page keeps a counter and offers ten tools: read, add (its result
    carries a `summary` for the turn's log), a slow add (progress every 200 ms until
    `window.__release()` in its frame, or Stop), reset (destructive, with a `confirm`
    note that its question shows in place of "can't be undone"), one whose risk the
    host doesn't know (counted as destructive), a 64×64 PNG of the counter, a
    read of its study from the app with a 1 s window (a test holds that read with
    `page.route`: the frame's call in flight keeps the tool call alive, on the server
    too), and `fail_hint`, which always fails with a `hint` and a `detail` (they reach
    the model's next request and the terminal client), and `label`, whose string, list
    and boolean fields are all required (a local model's call that leaves them out
    gets `""`, `[]` and `false`), and `attachment_size`, which reads a file attached in
    the dock with `call.readAttachment` and answers its name and size
    (`e2e/assistant-dock.spec.js`). It shows `#counter`, `#aborted`, `#label` and
    `#ai-available`, and registers again once shown when its tab was hidden at load.
    It hears the turns bound to its tab (`#turn-state` reads "running: <title>", then
    how it ended), and its `#stop` button stops the turn through the bridge.
  - Its server: `startHost({pluginsFrom, env})` with `MAGNUSIM_TEST_ASSISTANT=1`,
    the fake's address, `MAGNUSIM_TEST_EVENT_HUB=1` (to count and cut a tab's
    stream), a 2 s hold and a 60 s dormant time.
  - Turns start with `request.post('/api/assistant/turns', {text, tab})`, the tab
    being the page's own (its `/api/events?tab=` request) as `/api/assistant/tabs`
    lists it. The Assistant's questions are cards in the app's Assistant panel (the
    dock), never the app's confirm dialog, with their No button focused.
  - One turn runs in a tab at a time: another turn on it is refused 409 `tab_busy`
    until the first has ended, so a test waits for `ended()` before its next turn
    there. A question open across a change (the plugin turned off) belongs to the
    tab's only turn: a running turn alone keeps no channel for a page with nothing
    left to offer.
  - The turn helpers are shared in `e2e/support/assistant.js`, for the core's specs
    and the bundled plugins' suites alike, so a plugin's spec names no provider:
    `useScriptedModel(request, base, fake, 'cloud' | 'local')` points the server at
    the fake (the first cloud dialect with a test key, or the local-server dialect at
    `fake.compatBase`) with project data allowed; `trackTab(page)`;
    `startTurn(request, base, body, opts?)` and `followTurn(request, base, id, opts?)`
    (`waitFor`, `latest`, `ended`; `opts.strictFallback` above);
    `answerGate(request, base, turn, allow, {kind, tool, page})`
    answers the turn's next question as a click would: with the turn's answer key (only
    the program that started a turn holds it; `startTurn` keeps it from the 202), or, for
    a question only the window answers (`link_only`) or a turn followed without its key,
    on `page`'s question card in the dock (it checks the app's confirm dialog stays
    hidden);
    `offeredTools(req)` lists a request's tools as `{name, strict}`; and
    `resultsIn(req)` the tool results it carries (a fake request or a function step's
    body). `setHidden()` (`e2e/support/link-streams.js`) makes a tab say
    it is hidden or shown, as the browser does. A suite that runs its own copy of
    Playwright (CAD's) calls `setExpect(expect)` with its own first: a process loads
    `@playwright/test` once.
  - **The dock in tests.** The same file has the chat dock's helpers: `openDock(page)`
    (the header button the window shows), `dockSend(page, text, {pictures})` (types the
    text in the composer, each `\n` as Shift+Enter, attaches `pictures` as
    `[{name, mimeType, buffer}]`, sends with Enter and resolves to the turn's id from
    the 202), `dockGate(page)` (the oldest open question card; its parts are
    `.dock-gate-title`, `.dock-gate-copy` and `[data-gate-answer="no"|"yes"]`; Yes is
    disabled for its first 500 ms, which a Playwright click waits out) and
    `dockTurn(page)` (the newest request's block: `[data-dock-step]`,
    `[data-dock-phase]`, `[data-dock-counters]`, `[data-turn-end=<state>]`).
    `e2e/assistant-dock.spec.js` covers the dock with the fake and the ai-demo
    workspace; a request started with `startTurn` and bound to the page's tab shows in
    it too (read-only under "Elsewhere" when its conversation isn't the one shown).
    - A hidden tab: `setHidden(page, true)`; while a request the dock follows runs, its
      turn channel keeps the tab's stream (the server counts them in
      `GET /api/test/assistant/state` `turn_channels`, by tab), and once it ended and
      the hold is over the stream goes after the page's grace. A test that counts a
      tab's relay channels takes the turn channels from the hub's `assistant` count.
    - A reload: the dock keeps the conversation shown and the answer key of a request
      it started in `sessionStorage`; after `page.reload()` the conversation list
      comes back, the transcript replays, and a running request's open question shows
      again as a card in the reloaded page (POST `/turns/:id/show`). Another page
      (`context.newPage()`) has its own `sessionStorage`: it reads the conversation,
      and the request says its question shows in the window that started it.
    - The dock opens itself for a question and stays open over the bottom right: a
      test that then clicks a workspace view's bottom-right corner closes it first
      (`[data-dock-close]`; CAD's `keyboardInFrame` does).
    - `DOCK_SHOTS=<folder>` makes the dock specs (core and CAD) save screenshots of the
      main states there, for a person to look at; nothing compares them.
  - A remote viewer: add the proxy header to the page's `/api/` requests with
    `context.route()`. A header the browser adds itself (`extraHTTPHeaders`) makes
    the sandboxed frame's module script a cross-origin request with a preflight that
    fails, and the workspace never starts.
- **The fake coding agent.** `e2e/support/fake-acp-agent.mjs` is a scripted coding
  agent: plain Node, no dependencies, speaking the agent protocol (ACP v1, newline
  JSON-RPC) on stdin and stdout and logging only to stderr. The test process starts its
  controller, `const fake = await startFakeAcp(options)` from `e2e/support/fake-acp.mjs`,
  and hands the app (or a node test's own client) `fake.argv`.
  - `fake.script(...steps)` queues one prompt's steps: say, think, plan; call a tool
    through the MCP server the session was given (the real bridge, or a test's stand-in);
    ask permission for one of Magnusim's tools or for its own; report its own tool;
    `hold` until `fake.release(name)`; crash, exit during a call, ignore cancel, spawn
    helper processes, switch mode, stop with a reason or answer with an error. The file's
    header lists every step and option.
  - A controller that lives for a whole spec file (one per agent in
    `e2e/assistant-agents.spec.js`) is reset before each test: `fake.reset()` forgets the
    prompts scripted and not yet taken and lets every hold go, so a test that failed
    before its turn reached the agent never runs its leftovers in the next test;
    `fake.pending()` counts them, and the spec's `afterEach` checks every scripted prompt
    was used. Its records stay: scope a check to the agents a test started
    (`fake.pids('agent').slice(before)`, then `fake.received(pid)`).
  - `style` imitates how the adapters mark Magnusim's tools: `tool_name_meta` (the tool's
    name in the tool call's `_meta`), `mcp_call_flag` (a flagged `mcp.magnusim.<tool>`
    title, and approvals that carry the tool call's id) or `none` (a custom command).
  - `requireSignIn` refuses `session/new` with -32000 until `fake.signIn()` writes its
    marker (an `authenticate` writes it too). `authStatus: 'none'` (or another kind, such
    as `'account'`) says in `initialize` that it reports its own login
    (`agentCapabilities._meta.authStatus`) and lets `session/new` through but first sends
    `_auth/status_update {authStatus: {kind}}`, as an adapter that reports its own login does:
    the way such an agent says it isn't signed in on a connect. With `authStatusHold: name`
    that report goes after the `session/new` answer instead, once `fake.release(name)` (it
    records `{event: 'holding', name}` first), as that adapter's background read of its login
    lands; with `authStatusAt: 'initialize'` it goes once, right after the `initialize`
    answer, and never at `session/new`, as an adapter that probes its login at initialize
    does. `authStatus: 'silent'` says it reports its login and never does (a connect then
    waits for it only within its bound). `fake.argvWith({helpersAtStart: n})` makes it
    start n helpers before it reads anything.
  - **Through agent discovery.** Discovery starts a package's bin as `[node, <script>,
    ...args]`, with no `--control` and no `MAGNUSIM_` variable (the agent's environment
    drops them). `fake.writeLauncher(file, {version})` writes a small script at `file` that
    runs the fake with this controller: put it where the bin points (for example
    `<prefix>/node_modules/<package>/dist/index.js`, beside that package's `package.json`).
    Its `--version` prints `fake-acp-agent <version>` and exits without the controller, as
    discovery's version probe expects. Started without `--control` (and without a
    launcher), the fake exits 2.
  - **Discovery's test switches.** With `MAGNUSIM_TEST_ASSISTANT=1` in a test home,
    `MAGNUSIM_TEST_ASSISTANT_AGENT_PATHS=<folder>` (several joined by the path delimiter)
    makes agent discovery search exactly those folders, never PATH or the npm folders, and
    `MAGNUSIM_TEST_ASSISTANT_AGENT_HOME=<folder>` is the home its login files and home
    folders are looked up in (its `tmp` folder then holds the version probes' working
    folders); under it the real environment's agent variables (each known agent's key,
    login-folder and own-prefix variables) and `XDG_CONFIG_HOME` / `XDG_DATA_HOME` are not
    read, so a host started with it never looks at this PC's agent logins. Otherwise they are
    ignored with a log line.
    `scripts/server/__tests__/assistant-agents.test.js` lays out npm prefixes as npm does on
    Windows (a `.cmd` shim beside `node_modules/<package>/package.json`): plain files, so
    the same layout runs on Linux with `platform: 'win32'` passed to discovery.
  - It records every message it receives and sends, in order: `fake.received()`,
    `fake.sent()`, `fake.events()` (tool lists, call results, permission outcomes) and
    `fake.pids()` (itself, its MCP server, its helpers). `fake.waitFor(pred)` waits for a
    record without sleeping. An answer reaches the client only after the records before
    it reached the controller.
  - It answers -32601 to anything it doesn't serve, and asks the client to read a file
    once per session, to check that Magnusim refuses.
  - `scripts/server/__tests__/assistant-acp.test.js` checks every message it sends, and
    every message Magnusim's builders make, against the agent protocol's own JSON Schema
    (the `@agentclientprotocol/sdk` development dependency, with Ajv 2020).
  - **Stopping an agent's whole tree.** `scripts/server/__tests__/assistant-proc-tree.test.js`
    starts the fake as a real agent process (`agents/process.ts`) with helper processes
    that outlive it on purpose, and checks by pid that none is left after a stop: on
    Windows through the job object (the trampoline `agents/launch.mjs` holds the agent
    until it is in the job), on POSIX through the process group (helpers that clean up
    on SIGTERM, `{spawnHelpers: {count, onTerm}}`, get their grace) and the `pids.json`
    sweep, which must end a crashed run's group and leave an unrelated group alone.
    `MAGNUSIM_TEST_ASSISTANT_JOB=blocked` (with `MAGNUSIM_TEST_ASSISTANT=1`, in a
    test home) makes the Windows job keeper count as blocked, so the stop takes the
    best-effort path (`taskkill /T` as an async process) and `agentsTreeKill()` (the
    status field `agents_tree_kill`) says `best_effort`. Every agent the test starts
    passes `tmp` (its own temp folder), so its working folders, and the start's sweep of
    old ones, never touch the system temp folder.
- **Agent turns.** With `MAGNUSIM_TEST_ASSISTANT=1` in a test home, three switches shorten
  an agent turn's timers (whole milliseconds from 1 to 3600000; otherwise ignored with a log
  line):
  - `MAGNUSIM_TEST_ASSISTANT_AGENT_IDLE_MS=<ms>`: how long a conversation's agent is kept
    between its messages (15 minutes otherwise);
  - `MAGNUSIM_TEST_ASSISTANT_AGENT_CANCEL_MS=<ms>`: how long Stop waits for the agent to
    answer its cancel before the tree kill (3 s otherwise);
  - `MAGNUSIM_TEST_ASSISTANT_AGENT_GATE_MS=<ms>`: how long an agent turn's questions wait
    (4 minutes otherwise).

  Starting a coding agent needs this account's proof, else 403 `launch_proof`: a turn
  (`POST /api/assistant/turns`), the agent Test and connect check
  (`POST /api/assistant/agents/test`, and `POST /api/assistant/test` for `agent:<id>`) and
  sign-in (`POST /api/assistant/agents/sign-in`). The proof is either the launch token in the
  `x-magnusim-launch` header (never in the body) or a live relay link of any app tab in the
  body's `link`. A test reads the token from the test home's `mcp.json` (its path is the
  `--info` argument in the `bridge.args` of `GET /api/assistant/mcp`). The terminal client
  finds the same file when it runs with the server's `MAGNUSIM_ASSISTANT_HOME`, and sends the
  token only once `POST /api/assistant/launch/check {nonce}` answered
  HMAC-SHA256(token, "l<port>:<nonce>") for the port it reached; a stub app in
  `assistant-cli.test.js` answers that check itself.

  Adding a custom agent (`POST /api/assistant/agents/custom`) and turning an allow switch on
  (`POST /api/assistant/agents/allow` with `allow:true`) need the app's own `Origin` and a
  live relay link in `link`; the token is not taken there. Turning a switch off needs only the
  `Origin`. A node test gets a link with the harness: `await (await relayPage(base)).open()`
  (`assistant-harness.js`; the tab opens its relay channel for the proof alone, no workspace
  needed). A browser test makes those calls through the page's own `src/assistant/api.ts`
  (`page.evaluate(() => import('/src/assistant/api.ts'))`), which sends its tab's link.

  `GET /api/test/assistant/state` lists each conversation's agent (pid, state, how its tree
  is stopped), and every `POST /api/test/assistant/reset` ends them all.
  `scripts/server/__tests__/assistant-agent-turn.test.js` runs agent turns with the real
  bridge and listener; `e2e/assistant-agents.spec.js` runs Settings → Assistant → Coding
  agents and agent turns in the `ai-demo` workspace in a browser, each agent the fake
  installed through discovery's switches with a controller of its own (so each keeps its own
  `style`), and checks that every process a fake or a launcher reported has ended (by its
  command line, since the OS reuses pids). Its turns start with `request.post` and the
  launch token; it adds and allows its custom agent through the page's `api.ts` (`addCustom`);
  its Stop test leaves the cancel wait at its real 3 s.
- **Other apps (MCP).** Two clients reach the MCP listener as another app on this PC would;
  neither reads this PC's own `mcp.json`.
  - `scripts/server/__tests__/assistant-mcp-harness.js` (not a test itself; imported
    dynamically after the temp paths are set): `handshake(port, token)` (a raw socket through
    the greeting, both directions recorded), `socketClient(port, token, {era})` (the MCP
    SDK's own client over such a socket) and `bridgeClient({info, era})` (the SDK's client
    with a stdio transport that starts the real bridge, `scripts/assistant-mcp.mjs`).
    `era: 'legacy'` is the client's default protocol version and `'modern'` pins the newer
    one; the interop cases run in both.
  - `e2e/support/mcp-client.mjs`, for browser tests: `startMcpClient({info, name, era})`
    starts the bridge with the server's `mcp.json` (`infoPathOf()` of the
    `GET /api/assistant/mcp` answer) and connects the SDK's client, giving
    `{client, changes, stderr(), close()}`. It rejects with the bridge's stderr when the
    bridge ends first (Magnusim not running, or a refusal). `resultJson(result)` reads a
    tool result's JSON. `e2e/assistant-mcp.spec.js` uses it.
- **CAD's tools.** The Part's tools for the Assistant are tested in CAD's own suite
  (`bundled-plugins/cad`, its own toolchain; its `ARCHITECTURE.md` §8 and §12, and
  `docs/assistant.md` "Tests" there).
  - The browser shard `assistant` (`npm run test:e2e:assistant` in that folder, or
    `node scripts/e2e.mjs e2e/<spec>` for one spec): `cad-assistant-watch`, `-honest`,
    `-coexist`, `-takeover` and `-eval` (the evaluation set's tasks replayed from their
    references; `eval/README.md` there). Each spec starts its own app server with
    `startAssistantHost(name, offset)` from `e2e/assistant-helpers.ts`, on
    `CAD_E2E_PORT_FROM` + 60, 70, 80, 90 (the evaluation's) and 100, with the fake
    provider, `MAGNUSIM_TEST_ASSISTANT=1`, the fake's address, `MAGNUSIM_TEST_EVENT_HUB=1`,
    a 2 s hold and no WSL. The helpers wrap the turn helpers above (`useScriptedModel`,
    `startTurn`, `offeredTools`, `resultsIn`) and add CAD's own: a project with a Part
    open and its tab (`openNewPart`), the chip's words (`chipWords`: the chip's own text
    also holds its buttons), its buttons (`chipButton`), and recorders of what the frame
    shows over time. A local turn's context and images come from the fake's model rows
    (`fake.models([{id, context, type}], 'compat')`).
  - Races are forced at the page's hold points: `window.__CAD__.assistant.hold(point)`
    stops every call that reaches `point` until `release(point)` (`after-settled` for
    reads; `after-plan`, `after-open`, `between-opens`, `sketch-step:<n>` and
    `before-commit` for edits; `holdAt`, `reachedHold` and `releaseHold` in the
    helpers). The same handle shortens the edits' 10-minute wait for the person
    (`setHoldS(s)`) and forces the pace and "Ask each step" (`setPace(pace, scale)`,
    `setAskEach(on)`) without writing the person's preferences. A fake `hold` step stays
    released once released, so each one needs its own name within a spec.
  - Unit tests (`npm test` there): `tests/assistant/` runs the tools on a real Part in
    Node (the real kernel and solver, every feature type, the UI controller, the real
    sketch mode when a test asks for it) through a fake host's `ws.assistant`, called as
    the bridge calls them.
  - The app's side: `scripts/__tests__/assistant-cad-tools.test.mjs` (in
    `npm run test:server`) imports CAD's `src/assistant/schemas.ts` and `guide.ts`:
    every schema passes the app's checks, no CAD property is optional, the first 20 of
    the tools a CAD turn offers are strict on the cloud dialects (the Part's 22
    first), and, in each edition as its server builds the registry (Magnusim: 31 tools;
    Magnusim CAD: 29, with `cadEditionTool` and its own words), the tools as sent fit
    the registry's own local budget (`LOCAL_BUDGET`: 16,384 tokens for an unknown 32K
    model, counted at 3.5 characters a token) with nothing cut, and the system text
    (the prompt and the CAD notes) stays within 6,000 characters; it prints both with
    their share and warns past 90% of the tool budget.

## A bundled plugin's own suite

A bundled plugin keeps its browser tests in `bundled-plugins/<key>/e2e/`, in
one of two forms. `npm run test:e2e` and `test:e2e:changed` find both.

- **On the core's Playwright** (Incompressible Flow): an
  `e2e/playwright.config.js` that exports
  `appSuiteConfig({ name: '<key>', testDir, seed })`. Its specs get the same
  app server, seeded projects, WSL toolchain and lock as the core suite.
  - **One seam.** Its specs, seed module and config import from the core only
    `../../../e2e/support/plugin-suite.js` (`appSuiteConfig`, `NO_WSL`,
    `NO_HEAVY`, `wslPathExists`, `waitSlotFree`, `computeQueue`,
    `foamRecords`, `killFoamRelays`, `removeTestWslRoot`, `acquireWslLock`,
    `startHost`, `e2eTemp`, `NO_GEOMETRY_PROJECT`, `prepareE2eProjectsRoot`,
    the two-plates helpers `setup`, `createStudy`, `addAir`, `addBc`,
    `PYTHON` and `seedElbowProject`; `docs/plugins/GUIDE.md`, "Testing", says
    what each is); `scripts/__tests__/e2e-suites.test.mjs` fails on any
    other import from outside the plugin, in any file of any bundled plugin's
    `e2e/` folder (CAD, on its own Playwright, is the one listed exemption).
  - **Its own projects.** `seed` is a module (absolute path) whose default
    export gets the projects root and seeds the suite's projects, after
    `e2e/prepare-projects.js` has seeded the core's
    (`e2e/support/seed-suite.js`). Incompressible Flow's is
    `bundled-plugins/incompressible_flow/e2e/seed.js`; it exports the ids its
    specs open. `seedElbowProject(root, id, title)` copies a fresh elbow
    sample there, replacing one already seeded.
- **With its own toolchain** (CAD): a `package.json` whose `test:e2e` script
  builds the plugin and runs its tests against this checkout's app, started
  with `startHost()`. Most plugins ship off, so pass
  `enablePlugins: ['<key>']`.
  - A plugin whose folder has no `node_modules` yet stops the run with "run
    npm ci in bundled-plugins/<key>" instead of being skipped.
  - Spec paths given to the runner reach its script after `--`, relative to
    the plugin folder.
- **Host paths.** A plugin that reaches the app only through the plugin host
  can list the core paths it depends on in its `package.json`
  (`"magnusim": {"e2eHostPaths": [...]}`), so other core changes don't run its
  suite. Without a list, every core change runs it.
  - **Added by the manifest.** A plugin with a list also depends on the host
    features its `manifest.toml` opts into, with no plugin named in the core:
    a `[[start_actions]]` table adds `START_ACTION_HOST_PATHS` (Home, the New
    Project dialog, the header and empty-project buttons and their host
    elements, the create-then-open path in `runtime.js`, the tree's kind rows
    and the STUDIES rule, the manifest checks),
    and a study kind with `links_geometry = true` adds `LINK_HOST_PATHS` (the
    linked geometry's writers and readers). Both lists are in
    `scripts/e2e-suites.mjs`; `discoverPluginSuites` adds them by a plain line
    test of the manifest, so a commented-out example adds nothing
    (`scripts/__tests__/e2e-suites.test.mjs`, `gate:l1-suites`).
- **Fast tier.** A plugin's tests that mesh or solve must skip when
  `MAGNUSIM_E2E_WSL=0`.
