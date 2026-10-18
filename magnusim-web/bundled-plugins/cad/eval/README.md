# The Assistant's CAD evaluation set

Nine tasks the app's Assistant builds in a Part, each scored by checks the geometry kernel
answers (CAD tools spec §12.5). The same harness runs a real model (the owner's keys, on its own
app server or on the running app) and, in CI, the app's scripted model replaying each task's
reference.

| Tier | Task | What it checks |
|---|---|---|
| L1 | `plate-holes` | 1 solid, no void; volume and box; 4 holes r 3.25 at 10 mm from the edges; all ok; every sketch dof 0; 5 or more parameters; the walk of `t`: 8 -> 12 -> 8 mm (volume x 1.5, then back) |
| L1 | `spacer` | volume pi (15² - 6²) 5; box; the 12 mm bore |
| L2 | `l-bracket` | volume within 0.5%; an R4 fillet face; 2 holes r 3, each centred on its flange's outside face (0.05 mm) |
| L2 | `flange` | volume within 0.1%; 6 holes r 3.25 on the 60 mm circle (0.01 mm), the first on +X; the bore |
| L3 | `enclosure` | volume within 0.5%; 1 shell; the wall 2 mm (0.01) all round at half height |
| L3 | `poker-chip` | Red and White, 1 solid each, no overlap; their union 1 solid with 1 void of the disc pocket's volume (1%); the mid-thickness cut shows the pocket; the edge spots concentric (0.01 mm) and evenly spaced (0.01 deg); White interlocked (Red above and below it in a probe column) |
| L4 | `pipe-elbow` | volume within 1%; 1 solid; two annular ends |
| L4 | `vortex` | an inch Part; 1 solid; box 304.8 x 304.8 x 812.8 mm; volume within 1e-4 of 44,798,524 mm³; the R0.125 inlet blend honest (absent, or red with its message and the Part's health saying so); the last words name the blend (heuristic: reported, not counted) |
| Edit | `edit-plate` | the plate, then "holes 8 mm ... chamfer the outer top edges 1 mm": the first turn's names kept; 4 holes r 4 driven by a parameter; a chamfer; the volume |

The vortex task follows only the published recipe (the CAD plugin's P0 notes, "the Vortex part
from scratch"); no part file is read.

## Running it

From `bundled-plugins/cad`:

```
npm run eval:assistant -- --tasks plate-holes,flange --runs 1 --label first-pass --profile <file>
npm run eval:assistant -- --tasks all --attach http://127.0.0.1:8082
npm run eval:assistant -- --tasks all --scripted
npm run eval:assistant -- --tasks probe --profile <file>
```

Exactly one driver:

- `--profile <file>`: the run starts its own app server (a temp projects root and Assistant home,
  removed at the end) and sets the Assistant from the profile, a JSON file kept **outside the
  repository** (the harness refuses one inside it):

  ```json
  { "provider": "<provider id as Settings names it>", "model": "<model id>", "effort": "high",
    "base_url": "<a local server's address, for that provider only>",
    "key_env": "<the environment variable holding the key>",
    "caps": { "turn_usd": 8 } }
  ```

  The key is read from that environment variable and saved through the app's write-only key
  route; it is never printed or written to the records. The run allows project data to go to the
  model (privacy allow) and sets the limits 150 steps, $8 a turn, 60 minutes and $50 a day,
  under the profile's own `caps`.
- `--attach <url>`: the person's running app, with its own settings, keys and limits (printed;
  below 120 steps a warning). Projects `Eval · <task>` are made there and kept; `--clean` deletes
  the ones this run made (by id, never by title), after their turns, also when the run stops
  early. A privacy question is answered only for a project this run made; any other question is
  left to the person.
- `--scripted`: the app's scripted model with each task's reference (eval/references): no key, no
  network. This is what the e2e (`e2e/cad-assistant-eval.spec.ts`) runs.

Options: `--runs N`, `--label text`, `--toolset core` (the 13-tool core set: get_model, find,
measure, help, set_params, sketch, extrude, hole, revolve, modify, pattern, combine, undo; the
Part registers them with a guide that names only them and a line listing the 5 not offered, and
help features marks those 5),
`--pace watch` (the default is fast), `--headed` (show the browser), `--tab <id>` (attach: bind
the turns to that tab; it must show the project the run made, else the task, or the probe,
stops before its first turn; by default the tab whose registration names it, never "auto"),
`--no-repair`, `--out <dir>`, `--port-from <n>`, `--turn-minutes <n>`.

`--tasks probe` sends one request with the Part's full tool set (the app's 3 tools and the Part's
18) and records whether the provider took the strict schemas (`probe.json`: `strict` is
`accepted`, or `refused` when the app had to send the tools again unchecked). Run it once per
cloud provider before the first real eval.

## A run

1. A new project and its first Part (the header's CAD menu, as the person makes one; Imperial for
   an inch task); the app tab whose registration names that project.
2. Each request of the task as a turn on that tab, followed to its end. A delete is denied unless
   the task's `gates` allow it.
3. The Part's facts (`window.__CAD__.assistant.evalFacts`, `src/assistant/eval-facts.ts`) scored by
   `score.mjs`, with the parameter walk (each walk check's parameter set as the person sets it,
   the first value put back).
4. On a failure, one repair turn: "These checks fail: <list>. Fix the Part." and the score again.
5. The record, and a picture of the Part (iso, drawn off screen).

Records go to `.cache/assistant-eval/<stamp>-<label>/` (ignored by git):

- `runs.jsonl`: per run the task, the label, the model (from the app's status), `first_shot` and
  `final` (pass, passed of counted, the failed check ids), every check with what it got and why
  it failed, the steps, the calls by tool, the errors by reason (the page's) and by code (the
  turn log's), the `invalid_input` count, the images sent, the notes (images left out, the strict
  fallback), the largest request in tokens, the local model's context when known, the money, the
  tokens, the wall time, each turn's end and the Part's health;
- `<task>-<run>/`: `events.jsonl` (every turn's log), `calls.json` (the page's calls),
  `facts.json`, `final.png`;
- `summary.md`, a table to copy into the plans.

## Adding a task

1. `tasks/<id>.json`: `{id, tier, units, title, prompt, turns, gates, checks}`. `prompt` is the
   first request, `turns` the later ones in the same conversation. Say where the part sits (the
   checks read model coordinates).
2. `references/<id>.json`: `{id, about, turns}`, one list of the scripted model's answers per
   request: `{"tools": [{"name": "cad__sketch", "input": {...}}]}` with every field of the tool,
   then `{"text": "..."}`. A call that must fail carries `"expect": "<error code>"`.
3. `tests/assistant/eval-score.test.ts` builds the reference on the real kernel: every check must
   pass on it and fail when what it reads is changed. Add a way to break a new check kind there.

The check kinds and their fields are listed at the top of `score.mjs`; expected values may be
formulas (`"pi*(15^2 - 6^2)*5"`).
