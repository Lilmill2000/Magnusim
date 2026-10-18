# The Part's tools for the app's Assistant

Developer reference for `src/assistant/` (owner: ASSISTANT). The app's Assistant
(host API 1.9, unreleased: `ws.assistant`) calls tools a workspace page offers; the
Part offers 18, `cad__get_model` to `cad__view`, with one fixed guide. This file says
how the pieces fit, how to add a tool, and how to test one. What each tool takes and
answers is in its own description (`src/assistant/schemas.ts`), which is also what the
model reads.

## How a call goes

1. `src/features/assistant/index.tsx` is a module like every feature folder: its
   `install` is `installAssistant` (`install.ts`), its chip `AssistantChip.tsx`.
2. `installAssistant` makes the page's state (`runtime.ts`: the chip's store, the turns
   the host told of, the call keys, the revision, the hold points, the ledger),
   publishes `services.apis.assistant` (the camera gate other areas ask, and the store),
   listens to the host's turns (`turn-info.ts`), then registers **once** for the page's
   life: every tool of `schemas.ts` and `GUIDE` (`guide.ts`). After a `not_connected`
   answer it registers again when the tab shows; after `remote`, `no_assistant` or
   `not_allowed` never. A tool whose code is not in this build is still offered: the
   grammar and the prompt cache stay the same while tools are added.
3. Each call runs `createCallHandler` (`call.ts`): its key (`session-key.ts`:
   `turn:<id>`, `mcp:<session>`, or `ext:<n>` for an outside client's calls), its
   context (`CallCtx` in `src/types/assistant.ts`), the tool's code from
   `tools/index.ts`, and the reply.

## A reply

A tool returns `ToolReply` `{text, data, summary?, images?}`:

- `text` is one line (at most 200 characters), `summary` the turn log's line (160; the
  model never gets it);
- `data` is compact JSON in mm, mm², mm³ and degrees (`numbers.ts`: lengths to 1e-4,
  areas and volumes to 6 significant figures), every list at most 200 items, every
  container at most 6 deep inside `data` (the app turns depth 8 into null, and cuts
  every string at 2000 characters and newlines into spaces);
- `call.ts` adds `rev` to every `data`, and `user_changes` when the person changed the
  committed Part since the key's last call (`rev.ts`).

A refusal or failure is thrown as `ToolError(reason, message, {hint?, detail?})`
(`errors.ts`). The reason fixes the code (`invalid_input`, `failed`, `busy`,
`not_ready`) and the hint (`HINTS`, also in `help errors`); the message starts with
the reason; `detail.reason` names it. On a host without the turn events the hint goes
into the message. Anything else thrown is `internal`; an aborted call is `stopped`.

## Adding a tool

1. Write `src/assistant/tools/<name>.ts` exporting `tool: ToolImpl` (`kind: 'read'` or
   `'edit'`, `run(ctx)`).
2. Uncomment its line in `tools/index.ts` (each line has a comment line above it, so
   commits that add different tools merge cleanly).
3. A tool that makes a feature type registers its reader with
   `registerFeatureIo(type, {tool, inputsOf, values})` (`features-io.ts`) from its own
   file, so `get_model detail full` shows those features in its fields.
4. Its schema is already in `schemas.ts`; change it only with the spec (the app's host
   test `scripts/__tests__/assistant-cad-tools.test.mjs` pins the strict budget).

## Reading the Part (`get_model`, `model.ts`)

Reads wait (at most 30 s, a sign of life every 5 s) for the Part to open and the kernel
to start (`busy.ts`), then for the rebuild to catch up (`doc.settled()`). Reply budgets
(`turn-info.ts`): brief 8 KB (3 KB on a local turn), older features collapsing above 80
(30); full 24 KB (12 KB); one sketch 16 KB (8 KB). A local turn whose model has less than
24,000 tokens of context answers `not_ready` `small_context`.

## An edit call (`step.ts`, `judge.ts`, `ledger.ts`, `busy.ts`, `pace.ts`)

An edit tool is `{kind: 'edit', run: (ctx) => runEdit(ctx, tool)}` with an `EditTool`
`{plan, apply, sealed?, reply}`. `runEdit` makes one call one Assistant step
(`doc.assistant`), all or nothing:

1. **The gate** (`busy.ts` `waitForEdit`): `not_ready` while the Part cannot take edits
   (`not_editable`; `opening_geometry` while Edit in CAD opens it), `busy`/`other_turn` for a
   call of a turn that is not the one running here, then the **wait for the person**: the
   rollback bar not at the end, a panel of theirs (an idle Parameters panel does not count), a
   typed value, a rename, a menu, a dialog, a toolbar drag, or the Assistant paused. While it
   holds, the chip is `waiting` with what it asks ("close the Fillet 2 panel"), and progress
   carries `waiting: true` (every 5 s), so the turn's minutes stop. It is checked again on
   every change of the stores behind those signals; after 10 minutes (`EDIT_WAIT_MS`, the
   test handle's `setHoldS` shortens it) the call answers `busy` `person_editing`,
   `rolled_back` or `paused`. A key or a held pointer in the frame is a soft wait (800 ms of
   quiet, at most 10 s). Reads never wait.
2. **Plan** against the settled Part: every refusal (`invalid_input` with the row at fault)
   before anything changes. The hold point `after-plan` follows; a person who opened something
   meanwhile is waited for again and the call plans anew (at most three times).
3. **Apply** inside the step, through the person's own paths (`openEditForAssistant`, the
   Part's one-shot edits inside `step.run`), with `ctx.checkpoint({hold, pace, label})` at each
   pace point: it throws on a stop, a take-over (`busy` `taken_over` with its `why`; the
   Assistant pauses in this Part until the turn ends), a change of the Part by someone else
   (`busy` `changed`) or a draft the call did not write. Hold points: `after-open`,
   `between-opens`, `before-commit`.
4. **Judge** (`judge.ts`) once the rebuild settled: a failed rebuild or a kernel stop is
   `kernel_failed`; the call's own feature failing is `feature_failed` with its own message and
   actions; a value edit (`set_params`, `edit_feature` with only `set`) that turns a working
   feature red is `broke_downstream`; those revert. A structural edit keeps what it broke
   (`broke`; `get_model` marks it `broken_by_you`). Warnings: the own feature's, a feature newly
   warning, a body with more solids.
5. **Seal** the step's undo steps into the key's group (`ledger.ts` `groupLabel`: "Assistant:
   <request>", or "Assistant (other app): <first part> +N"), and keep the call in the key's
   ledger (its mark, the model after) for the `undo` tool and `get_model`'s
   `undo.your_steps`. Anything that fails reverts the step to its mark exactly; a revert the
   person's own change refuses answers with `detail.kept`. A Stop, a stall or Back (the call's
   signal) reverts synchronously in the abort handler.

The answer's `data` is `EditData` (`report()`: the feature, what was resolved, the bodies
created, changed and removed, warnings, broke, fixed) plus the tool's own fields.

**Pace** (`pace.ts`): `watch` (the default, the person's choice in `ws.prefs`
`assistant.pace`) waits at each pace point (a panel open 450 ms, a parameter row 150 ms, before
the commit 250 ms, ...), at most 6 s per call; never while the window is hidden, after a
rebuild over 1.5 s, or at `fast`. Tests force the pace without writing the preference
(`setPace(pace, scale)` on the test handle; the vitest harness runs `fast`).

**The pause** (`busy.ts` `createPause`): set by a take-over, by the person's undo or redo of
the Assistant's steps while its turn runs, or by the chip's Pause; it ends with its turn (the
host's turn events) or, without them, at the next key. The chip shows `paused` ("you took
over", "you undid its steps").

## The person's view

The chip (`[data-chip="assistant"][data-assistant-state]`) and the frame's
`.cad-app[data-assistant]` follow `state.ts`: `off`, `idle`, `thinking` (a turn runs, no
call), `working` (a call runs: the tool's title), `ended` (for 120 s, or until the Part
changes). Without the host's turn events the chip stays 10 s after the last call.

## Tests

- Vitest: `tests/assistant/` over `harness.ts` (a real DocService on the real kernel,
  every module's feature types, the real solver, the UI controller and the fake host's
  `ws.assistant`, `tests/fakes/assistant-sdk.ts`). Real-kernel tests give each test an
  explicit timeout.
- Hold points (`testing.ts`): a test holds a point (`after-settled` for reads; `after-plan`,
  `after-open`, `between-opens` and `before-commit` for edits), the call stops there until the
  test releases it. No sleeps.
- `window.__CAD__.assistant`: the tools, the chip's state, the calls answered (`calls`,
  with each error's reason), the turns, the hold points, `setHoldS(s)` (the edits' wait for the
  person), `setPace(pace, scale)`, `paused()`, and `setToolset('core')` for the eval's A/B
  runs.
- The edit tools' vitest files: `step`, `judge`, `busy`, `pace`, `ledger`, `tools-edit`
  (`parts.ts` makes the plate and its fillet as the person would).
- E2E shard `assistant` (`npm run test:e2e:assistant`): each spec runs its own app
  server with the Assistant's test switches and the app's scripted model
  (`e2e/assistant-helpers.ts`); the app's turn helpers are vendor-neutral and take this
  suite's `expect` (`setExpect`). Ports: `CAD_E2E_PORT_FROM` + 60, 70, 80, 90, 100.
