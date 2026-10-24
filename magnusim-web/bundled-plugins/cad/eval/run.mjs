// The evaluation harness's command line (CAD tools spec §12.5): npm run eval:assistant -- ...
//   node eval/run.mjs --tasks plate-holes,flange --runs 1 --label <text>
//                     (--profile <file> | --attach <url> | --scripted)
//                     [--tab <id>] [--toolset all|core] [--pace fast|watch] [--headed] [--clean]
//                     [--out <dir>] [--no-repair] [--port-from <n>] [--turn-minutes <n>]
//                     [--reference <file>]... [--review on|off]
//   --tasks      task ids (eval/tasks/*.json), "all", or "probe": one request with the Part's full
//                tool set, to see how many of its strict schemas the provider takes (probeStrict)
//   --profile    a JSON file OUTSIDE the repository: {provider, model, effort?, base_url?,
//                confirm_remote?, key_env?, caps?}. The run gets its own app server (a temp
//                projects root and Assistant home), sets those settings with privacy allow and
//                caps {steps 150, turn_usd 8, turn_minutes 60, day_usd 50} under the profile's,
//                and saves the key read from the environment variable key_env (never printed).
//   --attach     the person's running app at <url>: its own settings, keys and limits (printed;
//                a warning below 120 steps). Projects "Eval · <task>" are made there and kept
//                unless --clean, which deletes only the ones this run made, after their turns
//                (also when the run stops early).
//                A privacy question is answered Send only for a project this run made.
//   --scripted   the app's scripted model with each task's reference (what the e2e runs).
//   --reference  a picture (PNG, JPEG or WebP, at most 1.5 MB and 2000 px a side; up to 4) OUTSIDE the
//                repository, sent with each task's first request as the person's reference; runs.jsonl
//                records its path and SHA-256 only.
//   --review     on (default): the Part asks for its review rounds; off: it does not (an A/B).
//   --tab        attach: the tab to bind turns to (it must show the project the run made, the
//                probe's too); by default the tab whose registration names that project, never
//                "auto".
// Each run opens its Part in a browser page of its own (--headed shows it). The records go to
// .cache/assistant-eval/<stamp>-<label>/ (gitignored): runs.jsonl, a folder per run (events.jsonl,
// calls.json, facts.json, final.png) and summary.md; the probe writes probe.json and probe-1/events.jsonl.
// With --profile and --scripted the run's own app server also leaves there server.log (its whole
// output) and debug/provider.jsonl (every model request and answer: MAGNUSIM_ASSISTANT_DEBUG_LOG),
// kept after the server is removed; --attach says how to get the same from the running app.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { api, cadFrameOf, loadTasks, newPart, PLUGIN_DIR, runFolder, runTask, runTurn, scriptedDriver, summaryMd, tabShowing, TURN_MS } from './lib.mjs';

const DRIVERS = ['profile', 'attach', 'scripted'];
/** The isolated server's limits for a profile run (each under the profile's own, when it gives one). */
export const PROFILE_CAPS = Object.freeze({ steps: 150, turn_usd: 8, turn_minutes: 60, day_usd: 50 });
/** Below this many steps an attached app's limit is warned about (the app's default is 120). */
export const ATTACH_MIN_STEPS = 120;
/** The probe's request: one read call and an answer, with every tool offered. */
export const PROBE_TEXT = 'Call cad__get_model once with detail brief, then say in one sentence how many features the Part has.';
const STRICT_FALLBACK = /could not compile these tools strictly/;
/** The app's note when it sent fewer tools strict (scripts/server/assistant/providers/common.ts strictReducedNote). */
const STRICT_REDUCED = /can't check the inputs of all (\d+) of Magnusim's tools at once, so Magnusim checks (\d+) of them itself \(([^()]*)\)\. The Assistant can still use every tool\.$/;

/**
 * What the probe's turn notes say of its strict tools: "accepted"; "reduced: N of M strict
 * (unchecked: <tool names>)" when the app sent fewer of them strict; "refused: all unchecked"
 * when it sent the Part's tools unchecked by the provider.
 */
export function probeStrict(notes) {
  for (const n of notes) {
    const m = STRICT_REDUCED.exec(String(n));
    if (m) return `reduced: ${Number(m[1]) - Number(m[2])} of ${m[1]} strict (unchecked: ${m[3]})`;
  }
  return notes.some((n) => STRICT_FALLBACK.test(String(n))) ? 'refused: all unchecked' : 'accepted';
}
/** The server switch that keeps every model request and answer (scripts/server/assistant/debug-log.ts). */
export const DEBUG_LOG_ENV = 'MAGNUSIM_ASSISTANT_DEBUG_LOG';
/** The scripted model's answers to the probe: the read it asks for, then its sentence. */
const PROBE_STEPS = [{ tools: [{ name: 'cad__get_model', input: { detail: 'brief', feature: '' } }] }, { text: 'The Part has no features yet.' }];

const USAGE = `node eval/run.mjs --tasks <ids|all|probe> [--runs N] [--label text] (--profile <file> | --attach <url> | --scripted)
  [--tab <id>] [--toolset all|core] [--pace fast|watch] [--headed] [--clean] [--out <dir>] [--no-repair]
  [--port-from <n>] [--turn-minutes <n>] [--reference <file>]... [--review on|off] [--keep-open]`;

/** The command line, checked: {tasks, runs, label, driver, profile, attach, tab, toolset, pace, headed, clean, out, repair, keepOpen, portFrom, turnMs, references, review}. */
export function parseArgs(argv) {
  const o = { tasks: 'all', runs: 1, label: '', driver: null, profile: null, attach: null, tab: null, toolset: 'all', pace: 'fast', headed: false, clean: false, out: null, repair: true, keepOpen: false, portFrom: null, turnMs: TURN_MS, references: [], review: true, help: false };
  const drivers = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [name, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const value = () => {
      const v = inline !== null ? inline : argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
      return v;
    };
    switch (name) {
      case '--tasks':
        o.tasks = value();
        break;
      case '--runs': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('--runs is a whole number from 1 to 20');
        o.runs = n;
        break;
      }
      case '--label':
        o.label = value();
        break;
      case '--profile':
        drivers.push('profile');
        o.profile = value();
        break;
      case '--attach':
        drivers.push('attach');
        o.attach = value().replace(/\/+$/, '');
        break;
      case '--scripted':
        drivers.push('scripted');
        break;
      case '--tab':
        o.tab = value();
        break;
      case '--toolset':
        o.toolset = value();
        if (o.toolset !== 'all' && o.toolset !== 'core') throw new Error('--toolset is all or core');
        break;
      case '--pace':
        o.pace = value();
        if (o.pace !== 'fast' && o.pace !== 'watch') throw new Error('--pace is fast or watch');
        break;
      case '--headed':
        o.headed = true;
        break;
      case '--clean':
        o.clean = true;
        break;
      case '--out':
        o.out = value();
        break;
      case '--no-repair':
        o.repair = false;
        break;
      case '--keep-open':
        o.keepOpen = true;
        break;
      case '--port-from': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1024 || n > 65000) throw new Error('--port-from is a port number');
        o.portFrom = n;
        break;
      }
      case '--turn-minutes': {
        const n = Number(value());
        if (!(n > 0 && n <= 240)) throw new Error('--turn-minutes is from 1 to 240');
        o.turnMs = n * 60_000;
        break;
      }
      case '--reference':
        o.references.push(value());
        if (o.references.length > REFERENCES_MAX) throw new Error(`at most ${REFERENCES_MAX} --reference pictures`);
        break;
      case '--review': {
        const v = value();
        if (v !== 'on' && v !== 'off') throw new Error('--review is on or off');
        o.review = v === 'on';
        break;
      }
      case '--help':
      case '-h':
        o.help = true;
        break;
      default:
        throw new Error(`unknown option ${a}\n${USAGE}`);
    }
  }
  if (o.help) return o;
  if (drivers.length !== 1) throw new Error(`choose one driver: ${DRIVERS.map((d) => `--${d}`).join(', ')}\n${USAGE}`);
  o.driver = drivers[0];
  if (o.attach && !/^https?:\/\/[^/]+$/.test(o.attach)) throw new Error('--attach is the app address, like http://127.0.0.1:8082');
  if (o.tab && o.driver !== 'attach') throw new Error('--tab goes with --attach (the other drivers make their own server and tab)');
  if (o.clean && o.driver !== 'attach') throw new Error('--clean goes with --attach (the other drivers remove their whole server at the end)');
  if (o.tab && o.tab === 'auto') throw new Error('--tab names one tab: turns are never bound to "auto"');
  return o;
}

/** The most reference pictures a run sends (the app takes 4 with a request). */
export const REFERENCES_MAX = 4;
const PICTURE_TYPES = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' });

/** Whether `real` (a real path) is inside the repository at `repoTop`. */
function insideRepo(real, repoTop) {
  const rel = relative(realpathSync(repoTop), real);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * A reference picture, read and checked: it lives outside the repository (the person's own
 * picture), and is a .png, .jpg, .jpeg or .webp file (the app checks what it holds). Its path and
 * SHA-256 go into the records, its bytes only to the app.
 */
export function readReference(file, repoTop) {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`no reference picture at ${path}`);
  const real = realpathSync(path);
  if (insideRepo(real, repoTop)) throw new Error(`the reference picture ${path} is inside the repository: keep it outside`);
  const ext = (/\.[^./\\]+$/.exec(path)?.[0] ?? '').toLowerCase();
  const media_type = PICTURE_TYPES[ext];
  if (!media_type) throw new Error(`the reference picture ${path} is not a .png, .jpg, .jpeg or .webp file`);
  const bytes = readFileSync(real);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), media_type, data: bytes.toString('base64') };
}

/** A profile file, read and checked: it lives outside the repository (provider names stay out of it). */
export function readProfile(file, repoTop) {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`no profile file at ${path}`);
  const real = realpathSync(path);
  if (insideRepo(real, repoTop)) throw new Error(`the profile ${path} is inside the repository: keep profiles (and keys) outside it`);
  const p = JSON.parse(readFileSync(path, 'utf8'));
  if (!p || typeof p !== 'object') throw new Error('a profile is a JSON object');
  if (typeof p.provider !== 'string' || !p.provider) throw new Error('the profile names no provider');
  if (typeof p.model !== 'string' || !p.model) throw new Error('the profile names no model');
  if (p.key_env !== undefined && (typeof p.key_env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.key_env))) throw new Error('key_env is the name of an environment variable');
  return p;
}

/** The settings a profile run posts: the profile's choices, privacy allow, and the run's caps under the profile's. */
export function profileSettings(p) {
  const caps = { ...PROFILE_CAPS, ...(p.caps ?? {}) };
  caps.day_usd = Math.max(caps.day_usd, caps.turn_usd);
  return {
    provider: p.provider,
    model: p.model,
    ...(p.effort ? { effort: p.effort } : {}),
    ...(p.base_url ? { base_url: p.base_url } : {}),
    ...(p.confirm_remote ? { confirm_remote: true } : {}),
    privacy: 'allow',
    caps,
  };
}

/** The limits in words ("120 steps, $8 a turn, 60 minutes, $15 a day"). */
export const capsWords = (c) => (c ? `${c.steps} steps, $${c.turn_usd} a turn, ${c.turn_minutes} minutes, $${c.day_usd} a day` : 'unknown');

const say = (line) => console.log(`[eval] ${line}`);

async function postOk(base, path, body) {
  const r = await api(base, path, body);
  if (r.status !== 200) throw new Error(`${path} answered ${r.status}: ${String(r.body?.error ?? JSON.stringify(r.body)).slice(0, 300)}`);
  return r.body;
}

/** The repository's top folder (two levels above the app). */
const REPO_TOP = resolve(PLUGIN_DIR, '..', '..', '..');

async function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  if (o.help) {
    console.log(USAGE);
    return 0;
  }
  const probe = o.tasks === 'probe';
  const tasks = probe ? [] : loadTasks(o.tasks);
  let references;
  try {
    references = o.references.map((f) => readReference(f, REPO_TOP));
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  const { chromium, expect, request: pwRequest } = await import('@playwright/test');
  const stops = [];
  let base = o.attach;
  let driver = null;
  let fake = null;
  const created = new Set();
  const out = o.out ? resolve(o.out) : runFolder(o.label || `${o.driver}${probe ? '-probe' : ''}`);
  const logs = o.driver === 'attach' ? null : { server: join(out, 'server.log'), debug: join(out, 'debug') };
  try {
    mkdirSync(out, { recursive: true });
    say(`records in ${out}`);
    if (o.driver === 'scripted' || o.driver === 'profile') {
      const { startHost } = await import('../../../e2e/support/host-server.mjs');
      if (o.driver === 'scripted') {
        const { startFakeLlm } = await import('../../../e2e/support/fake-llm.mjs');
        fake = await startFakeLlm();
        stops.push(() => fake.stop());
      }
      const env = { MAGNUSIM_E2E_WSL: null, MAGNUSIM_WSL_PRUNE: '0', [DEBUG_LOG_ENV]: logs.debug };
      if (fake) Object.assign(env, { MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base, MAGNUSIM_TEST_EVENT_HUB: '1' });
      say('starting an app server of its own (a temp projects root and Assistant home)');
      const host = await startHost({
        name: 'cad-eval',
        seed: false,
        enablePlugins: ['cad'],
        viteCacheDir: join(PLUGIN_DIR, '.cache', 'host-vite-cad-eval'),
        portFrom: o.portFrom ?? Number(process.env.CAD_E2E_PORT_FROM || 8170) + 95,
        env,
        logFile: logs.server,
        timeoutMs: 240_000,
      });
      stops.unshift(() => host.stop());
      base = host.base;
      say(`server at ${base}`);
      if (fake) {
        const core = await import('../../../e2e/support/assistant.js');
        core.setExpect(expect);
        const request = await pwRequest.newContext();
        stops.unshift(() => request.dispose());
        await core.useScriptedModel(request, base, fake, 'cloud');
        driver = scriptedDriver(fake);
      } else {
        const p = readProfile(o.profile, REPO_TOP);
        const settings = profileSettings(p);
        await postOk(base, '/api/assistant/settings', settings);
        if (p.key_env) {
          const key = process.env[p.key_env];
          if (!key) throw new Error(`the environment variable ${p.key_env} the profile names is not set`);
          await postOk(base, '/api/assistant/key', { provider: p.provider, key });
        }
        const status = (await api(base, '/api/assistant/status')).body ?? {};
        if (!status.ready) throw new Error(`the Assistant is not ready with this profile: ${status.ready_reason}`);
        say(`limits: ${capsWords(status.caps)}`);
        driver = { kind: 'profile' };
      }
    } else {
      say(`the server's own log and every model request are not kept from an attached app; to keep them, start the app with ${DEBUG_LOG_ENV}=<folder> (provider.jsonl goes there) and keep its console output`);
      const status = (await api(base, '/api/assistant/status')).body;
      if (!status?.ok) throw new Error(`no app answers at ${base}`);
      say(`the app's limits: ${capsWords(status.caps)}`);
      if (status.caps && status.caps.steps < ATTACH_MIN_STEPS) say(`warning: ${status.caps.steps} steps a turn is below ${ATTACH_MIN_STEPS}; an L3 build may be cut short (Settings, Assistant)`);
      if (!status.ready) throw new Error(`the app's Assistant is not ready: ${status.ready_reason}`);
      driver = { kind: 'attach' };
    }

    const browser = await chromium.launch({ headless: !o.headed });
    stops.unshift(() => browser.close());
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
    const env = { base, page, driver, out, created, log: (l) => say(l) };

    if (probe) {
      const part = await newPart(page, base, { title: 'Eval · probe', log: env.log });
      created.add(part.projectId);
      const tab = o.tab ? await tabShowing(base, o.tab, part.projectId, 'Eval · probe') : part.tab;
      if (fake) fake.reply(...PROBE_STEPS);
      const t = await runTurn(base, { text: PROBE_TEXT, tab }, { answer: () => null, ms: o.turnMs, log: env.log });
      const notes = t.events.filter((e) => e.type === 'note').map((e) => e.text);
      const end = t.events.find((e) => e.type === 'end') ?? null;
      const calls = await cadFrameOf(page).evaluate(() => window.__CAD__.assistant.calls);
      const dir = join(out, 'probe-1');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'events.jsonl'), t.events.map((e) => JSON.stringify({ turn: t.id, ...e })).join('\n') + '\n');
      const status = (await api(base, '/api/assistant/status')).body ?? {};
      const result = {
        when: new Date().toISOString(),
        model: { provider: status.provider ?? null, model: status.models?.[status.provider] ?? null, served_by: t.turn?.served_by ?? null },
        tools: (await api(base, '/api/assistant/tabs')).body?.tabs?.find((r) => r.tab === tab)?.tools.length ?? null,
        strict: probeStrict(notes),
        end,
        notes,
        calls: calls.map((c) => ({ tool: c.tool, ok: c.ok, reason: c.reason ?? null })),
      };
      writeFileSync(join(out, 'probe.json'), JSON.stringify(result, null, 2) + '\n');
      say(`probe: strict ${result.strict}; the turn ended ${end?.state ?? 'unknown'}`);
    } else {
      const records = [];
      for (const task of tasks) {
        for (let run = 1; run <= o.runs; run++) {
          say(`${task.id} (${task.tier}), run ${run} of ${o.runs}`);
          try {
            const r = await runTask(env, task, { label: o.label, run, pace: o.pace, toolset: o.toolset, repair: o.repair, turnMs: o.turnMs, tab: o.tab, review: o.review, references });
            records.push(r);
            say(`${task.id}: first shot ${r.first_shot.pass ? 'pass' : 'fail'}, final ${r.final.pass ? 'pass' : 'fail'} (${r.final.passed}/${r.final.counted}), ${r.steps} steps, ${r.review ? `${r.reviews.length} review rounds` : 'review off'}, ${r.usd}, ${r.wall_s} s`);
          } catch (e) {
            say(`${task.id}: the run stopped: ${e instanceof Error ? e.message : String(e)}`);
            writeFileSync(join(out, `${task.id}-${run}.error.txt`), `${e instanceof Error ? e.stack : String(e)}\n`);
          }
        }
      }
      const status = (await api(base, '/api/assistant/status')).body ?? {};
      const md = summaryMd(records, { label: o.label, when: new Date().toISOString(), driver: o.driver, caps: capsWords(status.caps) });
      writeFileSync(join(out, 'summary.md'), md);
      console.log(md);
    }
    return 0;
  } catch (e) {
    console.error(`[eval] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    // --clean (attach): the projects this run made, and only those, also when it stopped early.
    if (o.clean && created.size) {
      for (const id of created) {
        try {
          const r = await api(base, '/api/project/delete', { project_id: id });
          say(`removed project ${id}: ${r.status}`);
        } catch (e) {
          say(`could not remove project ${id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    // --keep-open: leave the window and its app server up until the person presses Enter here.
    if (o.keepOpen && stops.length && process.stdin.isTTY) {
      say('done: the window stays open. Press Enter here to close it and stop the app server.');
      await new Promise((done) => {
        process.stdin.resume();
        process.stdin.once('data', () => {
          process.stdin.pause();
          done();
        });
      });
    }
    for (const stop of stops) {
      try {
        await stop();
      } catch {
        // Going anyway.
      }
    }
    if (logs) for (const line of logLines(logs)) say(line);
  }
}

/** Where the run's own server left its logs, in words (only the ones there). */
export function logLines(logs) {
  const lines = [];
  const size = (f) => {
    try {
      return statSync(f).size;
    } catch {
      return null;
    }
  };
  const server = size(logs.server);
  if (server !== null) lines.push(`server log: ${logs.server} (${server} bytes)`);
  const provider = size(join(logs.debug, 'provider.jsonl'));
  if (provider !== null) lines.push(`provider log: ${join(logs.debug, 'provider.jsonl')} (${provider} bytes, a row per model request)`);
  else lines.push(`provider log: none in ${logs.debug} (no model request was sent)`);
  return lines;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
