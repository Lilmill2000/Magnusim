// The evaluation harness's runs (CAD tools spec §12.5): one task on one open Part, end to end, as
// a person's request would go:
//   1. a new project (REST) and its first Part (the header's CAD menu, as the person makes one;
//      an Imperial project for an inch task), and the app tab whose registration names that project;
//   2. each of the task's requests as a turn on that tab (POST /api/assistant/turns), followed to its
//      end, its questions answered by the task's policy (gateAnswer: a delete is denied unless the
//      task allows it; a privacy question only for a project this run made); the first turn carries
//      the run's reference pictures, if any; the Part asks for its review rounds unless the run
//      turns them off (review: false), and each round the app ran is recorded;
//   3. the Part's facts (window.__CAD__.assistant.evalFacts) scored (score.mjs), with the parameter
//      walk (each walk check's parameter set as the person sets it, the volume read at each value,
//      the first value put back);
//   4. on a failure, one repair turn ("These checks fail: ... Fix the Part.") and the score again;
//   5. the record: what was asked, the model, the first-shot and final scores, the steps, the calls
//      by tool, the errors by reason, the notes, the money and tokens, the wall time, the chip's
//      health, and (with an `out` folder) the turns' events, the calls, the facts and a picture.
// Drivers say where the model's answers come from: scriptedDriver(fake) queues each task's
// reference (eval/references/<id>.json, the app's scripted model, e2e/support/fake-llm.mjs);
// run.mjs builds the live ones (a model on an isolated server, or the person's running app).
// Plain Node and a Playwright page handed in: no provider, key or vendor word here.
// SPDX-License-Identifier: GPL-3.0-or-later
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkIds, factsAsk, failedWords, score, taskProblems } from './score.mjs';

export const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = resolve(EVAL_DIR, '..');
/** Where runs are recorded (gitignored: .cache/). */
export const RESULTS_DIR = join(PLUGIN_DIR, '.cache', 'assistant-eval');
/** The tools a Part offers, and the eval's A/B core set (src/assistant/schemas.ts CORE_TOOLSET). */
export const PART_TOOLS = 18;
export const CORE_TOOLS = 13;
/** A turn's ceiling by default (a live L3 build may take many minutes). */
export const TURN_MS = 30 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- tasks and references

/** The task ids, sorted. */
export function taskIds() {
  return readdirSync(join(EVAL_DIR, 'tasks'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** One task (eval/tasks/<id>.json), checked. */
export function loadTask(id) {
  const path = join(EVAL_DIR, 'tasks', `${id}.json`);
  if (!existsSync(path)) throw new Error(`no task "${id}": the tasks are ${taskIds().join(', ')}`);
  const task = readJson(path);
  const problems = taskProblems(task);
  if (task.id !== id) problems.unshift(`its id is "${task.id}", not its file name`);
  if (problems.length) throw new Error(`task ${id}: ${problems.join('; ')}`);
  return task;
}

/** The tasks named (comma-separated or a list), or every task. */
export function loadTasks(ids = null) {
  const list = ids === null || ids === '' || ids === 'all' ? taskIds() : (Array.isArray(ids) ? ids : String(ids).split(',')).map((s) => s.trim()).filter(Boolean);
  return list.map(loadTask);
}

/** A task's reference (eval/references/<id>.json): the scripted model's answers, one list per turn. */
export function loadReference(id) {
  const path = join(EVAL_DIR, 'references', `${id}.json`);
  if (!existsSync(path)) throw new Error(`no reference for task "${id}"`);
  return readJson(path);
}

/** A reference turn's steps as the scripted model takes them (the tool calls and the text; `expect` left out). */
export function fakeSteps(reference, turn) {
  const steps = reference.turns?.[turn];
  if (!Array.isArray(steps)) throw new Error(`the reference of ${reference.id} has no turn ${turn}`);
  return steps.map((s) => ({ ...(s.tools ? { tools: s.tools.map((t) => ({ name: t.name, input: t.input })) } : {}), ...(s.text !== undefined ? { text: s.text } : {}) }));
}

/** A reference turn's tool calls: {tool (the Part's own name), input, expect ("ok" or an error code)}. */
export function referenceCalls(reference, turn) {
  return (reference.turns?.[turn] ?? []).flatMap((s) => (s.tools ?? []).map((t) => ({ tool: t.name.replace(/^cad__/, ''), input: t.input, expect: t.expect ?? 'ok' })));
}

// ---------------------------------------------------------------- drivers

/**
 * The scripted model as the driver (CI, the e2e, --scripted): before each turn the task's
 * reference steps for it are queued on the fake; a repair turn gets the reference's `repair`
 * steps, or one plain answer when it has none.
 */
export function scriptedDriver(fake) {
  // Answers left from a turn that ended early would answer this one: stop instead.
  const clean = () => {
    const left = typeof fake.pending === 'function' ? fake.pending() : 0;
    if (left) throw new Error(`the scripted model still holds ${left} answer(s) of an earlier turn`);
  };
  return {
    kind: 'scripted',
    beforeTurn(task, turn) {
      clean();
      fake.reply(...fakeSteps(loadReference(task.id), turn));
    },
    beforeRepair(task) {
      clean();
      const ref = loadReference(task.id);
      fake.reply(...(ref.repair ? fakeSteps({ id: ref.id, turns: [ref.repair] }, 0) : [{ text: 'No repair is scripted for this task.' }]));
    },
  };
}

/**
 * The answer to a question a turn asks (true: allow; null: left for the person):
 * a confirmation by the task's `gates` policy for its tool (deny when it names none);
 * a privacy question only for a project this run made (`created`), never another.
 */
export function gateAnswer(gate, task, created) {
  if (gate.kind === 'privacy') return gate.project?.id && created.has(gate.project.id) ? true : null;
  if (gate.kind === 'confirm') {
    const tool = String(gate.tool ?? '');
    const policy = task.gates?.[tool.replace(/^cad__/, '')] ?? task.gates?.[tool] ?? 'deny';
    return policy === 'allow';
  }
  return null;
}

// ---------------------------------------------------------------- the app's routes

/** A JSON route of the app at `base`: {status, body}. */
export async function api(base, path, body) {
  const r = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let json = null;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  return { status: r.status, body: json };
}

async function apiOk(base, path, body) {
  const r = await api(base, path, body);
  if (r.status < 200 || r.status > 299) throw new Error(`${path} answered ${r.status}: ${JSON.stringify(r.body).slice(0, 400)}`);
  return r.body;
}

/**
 * `tab` when it shows the project this run made (its Part registration names `pid`), else an
 * error: turns bound to another tab would edit another Part (the person's own, attached).
 */
export async function tabShowing(base, tab, pid, title) {
  const rows = (await apiOk(base, '/api/assistant/tabs')).tabs;
  const row = rows.find((t) => t.tab === tab);
  if (!row || row.workspace?.project_id !== pid) throw new Error(`tab ${tab} does not show the project this run made (${title}): its turns would edit another Part`);
  return tab;
}

/** The app tab whose Part registration names project `pid` (connected, at least `tools` tools), or null. */
export async function tabOfProject(base, pid, tools = 1) {
  const j = await apiOk(base, '/api/assistant/tabs');
  return j.tabs.find((t) => t.connected && t.workspace?.project_id === pid && t.tools.length >= tools) ?? null;
}

async function waitFor(what, ms, fn, everyMs = 250) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`${what} within ${Math.round(ms / 1000)} s`);
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------- the Part

/** The Part's frame in `page` (the CAD workspace's iframe). */
export function cadFrameOf(page) {
  const f = page.frames().find((fr) => /\/plugins\/cad\/workspace\//.test(fr.url()));
  if (!f) throw new Error('the CAD workspace frame is not open');
  return f;
}

/**
 * A new project titled `title` (Imperial for an inch task) with its first Part open in `page`:
 * {projectId, tab}, once the Part's tools are offered on the tab whose registration names it.
 */
export async function newPart(page, base, { title, units = 'mm', log = () => {} }) {
  const project = await apiOk(base, '/api/project', { title, category: 'Other', units: units === 'in' ? 'Imperial' : 'Metric' });
  const pid = String(project.id);
  log(`project ${title} (${pid})`);
  await page.goto(`${base}/#/p/${pid}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 90_000 });
  await page.waitForFunction(() => window.__CFD_PLUGINS_READY__ === true, null, { timeout: 60_000 }).catch(() => {});
  // The first Part comes from the header's CAD menu; STUDIES offers "+ New Part" once the project has one.
  const studies = page.locator('#plugin-studies-section [data-plugin-study-new="cad:part"]');
  const header = page.locator('#ws-start-host [data-start-header="cad:part"]');
  await studies.or(header.locator('> button')).first().waitFor({ state: 'visible', timeout: 30_000 });
  if (await studies.isVisible()) {
    await studies.click();
    await page.locator('#pm-confirm').click();
  } else {
    await header.locator('> button').click();
    await header.locator('[role="menu"] [data-start-new="cad:part"]').click();
  }
  await page.locator('#workspace-overlay').waitFor({ state: 'visible', timeout: 60_000 });
  const frame = page.frameLocator('#workspace-frame');
  await frame.locator('[data-cad-app][data-kernel="ready"]').waitFor({ timeout: 90_000 });
  await frame.locator('[data-cad-app][data-doc="ready"]').waitFor({ timeout: 90_000 });
  const row = await waitFor(`the Part's ${PART_TOOLS} tools are offered on the tab of ${title}`, 90_000, () => tabOfProject(base, pid, PART_TOOLS));
  log(`Part open on tab ${row.tab}`);
  return { projectId: pid, tab: row.tab };
}

/** The Part's facts now (eval-facts.ts) with what the task's checks ask for. */
export const factsOf = (frame, ask) => frame.evaluate((a) => window.__CAD__.assistant.evalFacts(a), ask);

/** One parameter set as the person sets it (eval-facts.ts evalSetParam). */
export const setParamOf = (frame, name, expr) => frame.evaluate(([n, e]) => window.__CAD__.assistant.evalSetParam(n, e), [name, expr]);

/**
 * The parameter walks of a task's walk checks, by check id: the volume before, then each step's
 * parameter value, whether the Part took it, its volume and the features that fail; the
 * parameter's first value is put back after. `io` reads the facts and sets a parameter.
 */
export async function runWalks(task, io) {
  const ids = checkIds(task);
  const out = {};
  const total = (f) => (f.bodies.length && f.bodies.every((b) => typeof b.volume === 'number') ? f.bodies.reduce((s, b) => s + b.volume, 0) : null);
  for (const [k, c] of (task.checks ?? []).entries()) {
    if (c.kind !== 'walk') continue;
    const before = await io.facts({});
    const param = before.params.find((p) => p.name === c.param);
    if (!param) {
      out[ids[k]] = { error: `no parameter named ${c.param} (parameters: ${before.params.map((p) => p.name).join(', ') || 'none'})` };
      continue;
    }
    const steps = [];
    for (const step of c.steps ?? []) {
      const r = await io.setParam(c.param, step.expr);
      const f = await io.facts({});
      steps.push({ expr: step.expr, ok: r.ok, ...(r.ok ? {} : { reason: r.reason }), volume: total(f), failing: f.features.filter((x) => x.state === 'error').map((x) => x.name) });
    }
    if ((c.steps ?? []).length && c.steps[c.steps.length - 1].expr !== param.expr) await io.setParam(c.param, param.expr);
    out[ids[k]] = { param: c.param, from: param.expr, base: total(before), steps };
  }
  return out;
}

// ---------------------------------------------------------------- turns

/**
 * One turn on `tab`, followed to its end (the turn's log, long-polled), its questions answered by
 * `answer(gate)` (true, false, or null to leave it): {id, conversation, events, turn}.
 */
export async function runTurn(base, body, { answer = () => null, ms = TURN_MS, log = () => {} } = {}) {
  const start = await api(base, '/api/assistant/turns', body);
  if (start.status !== 202) throw new Error(`the turn did not start (${start.status}): ${JSON.stringify(start.body).slice(0, 400)}`);
  const id = start.body.turn;
  const key = start.body.answer_key ?? null;
  const events = [];
  const answered = new Set();
  let next = 0;
  let turn = null;
  const until = Date.now() + ms;
  for (;;) {
    const wait = Math.max(0, Math.min(20_000, until - Date.now()));
    const j = await apiOk(base, `/api/assistant/turns/${id}?since=${next}&wait_ms=${wait}`);
    events.push(...j.events);
    next = j.next;
    turn = j.turn;
    for (const e of j.events) {
      if (e.type === 'tool_call') log(`  ${e.tool} ${e.input_preview ?? ''}`.slice(0, 160));
      else if (e.type === 'tool_result' && !e.ok) log(`    -> ${e.code}: ${e.summary}`.slice(0, 200));
      else if (e.type === 'note') log(`  note: ${e.text}`);
      else if (e.type === 'review') log(`  review: round ${e.round} of ${e.of}`);
    }
    for (const e of events) {
      if (e.type !== 'gate' || answered.has(e.gate.id) || events.some((c) => c.type === 'gate_closed' && c.gate === e.gate.id)) continue;
      const a = answer(e.gate);
      if (a === null || a === undefined) continue;
      answered.add(e.gate.id);
      log(`  question "${e.gate.title}": ${a ? e.gate.yes : e.gate.no}`);
      await api(base, `/api/assistant/gates/${e.gate.id}`, { allow: a, ...(key ? { answer_key: key } : {}) });
    }
    if (j.ended) break;
    if (Date.now() > until) {
      await api(base, `/api/assistant/turns/${id}/stop`, {});
      throw new Error(`the turn did not end within ${Math.round(ms / 1000)} s; it was stopped. Last events: ${JSON.stringify(events.slice(-6)).slice(0, 600)}`);
    }
  }
  return { id, conversation: start.body.conversation ?? null, events, turn };
}

/** A review round's answer that only confirms the Part ("Review: no changes"): not the turn's last words. */
export const REVIEW_CONFIRMED = /^review:\s*no changes\.?$/i;

/** The last words of a turn: the text of its last step that said something (a review's bare confirmation left out). */
export function lastText(events) {
  const byStep = new Map();
  for (const e of events) {
    if (e.type === 'text') byStep.set(e.step, (byStep.get(e.step) ?? '') + e.text);
    else if (e.type === 'discard') byStep.delete(e.step);
  }
  const steps = [...byStep.keys()].sort((a, b) => a - b);
  const said = steps.map((s) => byStep.get(s).trim()).filter((t) => t && !REVIEW_CONFIRMED.test(t));
  return said.length ? said[said.length - 1] : '';
}

/** The review rounds the app ran in each turn: [{turn (1-based, in order), repair, round, of}]. */
export function reviewRounds(turns) {
  return turns.flatMap((t, i) => t.events.filter((e) => e.type === 'review').map((e) => ({ turn: i + 1, repair: !!t.repair, round: e.round, of: e.of })));
}

/** What a run's turns used: steps, money, tokens, the largest request, notes, end states. */
export function turnUse(turns) {
  let steps = 0;
  let usd = 0;
  let tokens = 0;
  let maxRequest = 0;
  const notes = [];
  const ends = [];
  const byTool = {};
  const byCode = {};
  for (const t of turns) {
    let last = 0;
    let turnUsd = 0;
    for (const e of t.events) {
      if (e.type === 'tool_call') {
        steps++;
        byTool[e.tool] = (byTool[e.tool] ?? 0) + 1;
      } else if (e.type === 'tool_result' && !e.ok && e.code) byCode[e.code] = (byCode[e.code] ?? 0) + 1;
      else if (e.type === 'usage') {
        maxRequest = Math.max(maxRequest, e.tokens - last);
        last = e.tokens;
        turnUsd = e.turn_usd;
      } else if (e.type === 'note' && !notes.includes(e.text)) notes.push(e.text);
      else if (e.type === 'end') ends.push({ state: e.state, reason: e.reason });
    }
    usd += turnUsd;
    tokens += last;
  }
  return { steps, calls_by_tool: byTool, errors_by_code: byCode, usd: Number(usd.toFixed(6)), tokens, max_request_tokens: maxRequest, notes, ends };
}

// ---------------------------------------------------------------- one run

/**
 * Run one task: env {base, page, driver, out?, created?, log?}, o {label, run, pace, toolset,
 * repair, turnMs, tab, title}. Resolves to the run's record (and writes it under env.out).
 */
export async function runTask(env, task, o = {}) {
  const t0 = Date.now();
  const log = env.log ?? (() => {});
  const created = env.created ?? new Set();
  const title = o.title ?? `Eval · ${task.id}`;
  const part = await newPart(env.page, env.base, { title, units: task.units, log });
  created.add(part.projectId);
  const tab = o.tab ? await tabShowing(env.base, o.tab, part.projectId, title) : part.tab;
  const frame = cadFrameOf(env.page);
  if (o.pace) await frame.evaluate((p) => window.__CAD__.assistant.setPace(p, null), o.pace);
  if (o.toolset === 'core') {
    await frame.evaluate(() => window.__CAD__.assistant.setToolset('core'));
    await waitFor(`the ${CORE_TOOLS} core tools are offered`, 60_000, async () => (await tabOfProject(env.base, part.projectId))?.tools.length === CORE_TOOLS);
  }
  // The review rounds the Part asks for: on unless the run turns them off.
  const review = o.review !== false;
  if (!review) {
    const v = await frame.evaluate(() => window.__CAD__.assistant.setReview(false));
    if (!v.available) throw new Error(`the Part could not offer its tools without review rounds: ${v.reason ?? 'unavailable'}`);
  }
  // The person's reference pictures go with the first request only.
  const pictures = (o.references ?? []).map((r) => ({ media_type: r.media_type, data: r.data }));
  const answer = (gate) => (env.driver.answer ? env.driver.answer(gate, task, created) : gateAnswer(gate, task, created));
  const names = [];
  const turns = [];
  let conversation = null;
  const texts = [task.prompt, ...task.turns];
  const namesNow = () => frame.evaluate(() => window.__CAD__.services.doc.state.get().doc.features.map((f) => f.name));
  for (const [i, text] of texts.entries()) {
    await env.driver.beforeTurn?.(task, i);
    log(`turn ${i + 1}/${texts.length}: ${text.slice(0, 80)}`);
    const t = await runTurn(env.base, { text, tab, ...(conversation ? { conversation } : {}), ...(i === 0 && pictures.length ? { images: pictures } : {}) }, { answer, ms: o.turnMs ?? TURN_MS, log });
    conversation = t.conversation ?? conversation;
    turns.push({ ...t, repair: false });
    names.push(await namesNow());
  }
  const ask = factsAsk(task);
  const io = { facts: (a) => factsOf(frame, a), setParam: (n, e) => setParamOf(frame, n, e) };
  let facts = await factsOf(frame, ask);
  let walk = await runWalks(task, io);
  const first = score(task, facts, { walk, names, last_text: lastText(turns[turns.length - 1].events) });
  log(`first shot: ${first.passed}/${first.counted}${first.pass ? ' pass' : `: ${failedWords(first)}`}`);
  let final = first;
  if (!first.pass && o.repair !== false) {
    await env.driver.beforeRepair?.(task);
    const t = await runTurn(env.base, { text: `These checks fail: ${failedWords(first)}. Fix the Part.`, tab, ...(conversation ? { conversation } : {}) }, { answer, ms: o.turnMs ?? TURN_MS, log });
    turns.push({ ...t, repair: true });
    names.push(await namesNow());
    facts = await factsOf(frame, ask);
    walk = await runWalks(task, io);
    final = score(task, facts, { walk, names, last_text: lastText(t.events) });
    log(`after the repair: ${final.passed}/${final.counted}${final.pass ? ' pass' : `: ${failedWords(final)}`}`);
  }
  const calls = await frame.evaluate(() => window.__CAD__.assistant.calls);
  const pageTurns = await frame.evaluate(() => window.__CAD__.assistant.turns());
  const status = (await api(env.base, '/api/assistant/status')).body ?? {};
  const use = turnUse(turns);
  const errorsByReason = {};
  for (const c of calls) if (!c.ok) errorsByReason[c.reason ?? c.code ?? 'unknown'] = (errorsByReason[c.reason ?? c.code ?? 'unknown'] ?? 0) + 1;
  const record = {
    task: task.id,
    tier: task.tier,
    label: o.label ?? '',
    run: o.run ?? 1,
    driver: env.driver.kind,
    model: { provider: status.provider ?? null, model: status.models?.[status.provider] ?? null, effort: status.effort ?? null, served_by: [...new Set(turns.map((t) => t.turn?.served_by).filter(Boolean))] },
    project: part.projectId,
    tab,
    pace: o.pace ?? null,
    toolset: o.toolset ?? 'all',
    review,
    // What the run's reference pictures were: their files and digests, never their bytes.
    references: (o.references ?? []).map((r) => ({ path: r.path, sha256: r.sha256 })),
    reviews: reviewRounds(turns),
    first_shot: { pass: first.pass, passed: first.passed, counted: first.counted, failed: first.checks.filter((c) => !c.pass && !c.heuristic).map((c) => c.id) },
    final: { pass: final.pass, passed: final.passed, counted: final.counted, failed: final.checks.filter((c) => !c.pass && !c.heuristic).map((c) => c.id) },
    repaired: turns.some((t) => t.repair),
    checks: final.checks,
    steps: use.steps,
    calls_by_tool: use.calls_by_tool,
    errors_by_reason: errorsByReason,
    errors_by_code: use.errors_by_code,
    invalid_input: use.errors_by_code.invalid_input ?? 0,
    images: calls.filter((c) => c.tool === 'view' && c.ok).length,
    notes: use.notes,
    max_request_tokens: use.max_request_tokens,
    context_tokens: pageTurns.map((t) => t.contextTokens).find((n) => typeof n === 'number') ?? null,
    usd: use.usd,
    tokens: use.tokens,
    wall_s: Math.round((Date.now() - t0) / 100) / 10,
    end: use.ends,
    health: facts.health,
    fact_errors: facts.errors,
  };
  if (env.out) {
    const dir = join(env.out, `${task.id}-${record.run}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.jsonl'), turns.flatMap((t) => t.events.map((e) => JSON.stringify({ turn: t.id, repair: t.repair, ...e }))).join('\n') + '\n');
    writeFileSync(join(dir, 'calls.json'), JSON.stringify(calls, null, 1));
    writeFileSync(join(dir, 'facts.json'), JSON.stringify(facts));
    if (o.picture !== false) {
      const pic = await frame.evaluate(() => window.__CAD__.assistant.evalPicture()).catch(() => null);
      if (pic) writeFileSync(join(dir, pic.mediaType === 'image/png' ? 'final.png' : 'final.jpg'), Buffer.from(pic.base64, 'base64'));
    }
    appendFileSync(join(env.out, 'runs.jsonl'), JSON.stringify(record) + '\n');
  }
  return record;
}

// ---------------------------------------------------------------- the summary

/** A run folder name: <stamp>-<label> (the label made safe for a file name). */
export function runFolder(label, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const safe = String(label || 'run').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'run';
  return join(RESULTS_DIR, `${stamp}-${safe}`);
}

/** summary.md for a set of records (what Daniel copies to the Plans folder). */
export function summaryMd(records, meta = {}) {
  const lines = [`# Assistant CAD eval: ${meta.label || 'run'}`, ''];
  if (meta.when) lines.push(`When: ${meta.when}`);
  if (meta.driver) lines.push(`Driver: ${meta.driver}`);
  const model = records.find((r) => r.model?.model)?.model;
  if (model) lines.push(`Model: ${[model.provider, model.model, model.effort].filter(Boolean).join(' / ')}`);
  if (meta.caps) lines.push(`Limits: ${meta.caps}`);
  lines.push('');
  lines.push('| task | tier | run | first shot | final | steps | invalid input | errors by reason | usd | tokens | largest request | wall s | health | review rounds |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of records) {
    const errors = Object.entries(r.errors_by_reason).map(([k, v]) => `${k} ${v}`).join(', ') || '-';
    lines.push(
      `| ${r.task} | ${r.tier} | ${r.run} | ${r.first_shot.pass ? 'pass' : 'fail'} ${r.first_shot.passed}/${r.first_shot.counted} | ${r.final.pass ? 'pass' : 'fail'} ${r.final.passed}/${r.final.counted} | ${r.steps} | ${r.invalid_input} | ${errors} | ${r.usd} | ${r.tokens} | ${r.max_request_tokens} | ${r.wall_s} | ${r.health?.health ?? '-'}${r.health?.words?.length ? `: ${r.health.words.join(', ')}` : ''} | ${r.review === false ? 'off' : (r.reviews ?? []).length} |`,
    );
  }
  const passed = records.filter((r) => r.final.pass).length;
  const first = records.filter((r) => r.first_shot.pass).length;
  lines.push('', `First shot: ${first} of ${records.length}. Final: ${passed} of ${records.length}.`);
  const failed = records.filter((r) => !r.final.pass);
  if (failed.length) {
    lines.push('', '## Failed checks', '');
    for (const r of failed) for (const c of r.checks.filter((x) => !x.pass && !x.heuristic)) lines.push(`- ${r.task} (run ${r.run}) ${c.id}: ${c.why}`);
  }
  const heuristic = records.flatMap((r) => r.checks.filter((c) => c.heuristic).map((c) => `- ${r.task} (run ${r.run}) ${c.id}: ${c.pass ? 'yes' : 'no'}${c.why ? ` (${c.why})` : ''}`));
  if (heuristic.length) lines.push('', '## Heuristic checks (not counted)', '', ...heuristic);
  const notes = [...new Set(records.flatMap((r) => r.notes))];
  if (notes.length) lines.push('', '## Notes', '', ...notes.map((n) => `- ${n}`));
  return lines.join('\n') + '\n';
}
