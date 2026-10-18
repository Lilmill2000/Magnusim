// The evaluation harness's command line (CAD tools spec §12.5): npm run eval:assistant -- ...
//   node eval/run.mjs --tasks plate-holes,flange --runs 1 --label <text>
//                     (--profile <file> | --attach <url> | --scripted)
//                     [--tab <id>] [--toolset all|core] [--pace fast|watch] [--headed] [--clean]
//                     [--out <dir>] [--no-repair] [--port-from <n>] [--turn-minutes <n>]
//   --tasks      task ids (eval/tasks/*.json), "all", or "probe": one request with the Part's full
//                tool set, to see the provider take its strict schemas (no fallback note)
//   --profile    a JSON file OUTSIDE the repository: {provider, model, effort?, base_url?,
//                confirm_remote?, key_env?, caps?}. The run gets its own app server (a temp
//                projects root and Assistant home), sets those settings with privacy allow and
//                caps {steps 150, turn_usd 8, turn_minutes 60, day_usd 50} under the profile's,
//                and saves the key read from the environment variable key_env (never printed).
//   --attach     the person's running app at <url>: its own settings, keys and limits (printed;
//                a warning below 120 steps). Projects "Eval · <task>" are made there and kept
//                unless --clean, which deletes only the ones this run made, after their turns.
//                A privacy question is answered Send only for a project this run made.
//   --scripted   the app's scripted model with each task's reference (what the e2e runs).
//   --tab        attach: the tab to bind turns to (it must show the project the run made);
//                by default the tab whose registration names that project, never "auto".
// Each run opens its Part in a browser page of its own (--headed shows it). The records go to
// .cache/assistant-eval/<stamp>-<label>/ (gitignored): runs.jsonl, a folder per run (events.jsonl,
// calls.json, facts.json, final.png) and summary.md.
// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { api, cadFrameOf, loadTasks, newPart, PLUGIN_DIR, runFolder, runTask, runTurn, scriptedDriver, summaryMd, TURN_MS } from './lib.mjs';

const DRIVERS = ['profile', 'attach', 'scripted'];
/** The isolated server's limits for a profile run (each under the profile's own, when it gives one). */
export const PROFILE_CAPS = Object.freeze({ steps: 150, turn_usd: 8, turn_minutes: 60, day_usd: 50 });
/** Below this many steps an attached app's limit is warned about (the app's default is 120). */
export const ATTACH_MIN_STEPS = 120;
/** The probe's request: one read call and an answer, with every tool offered. */
export const PROBE_TEXT = 'Call cad__get_model once with detail brief, then say in one sentence how many features the Part has.';
const STRICT_FALLBACK = /could not compile these tools strictly/;

const USAGE = `node eval/run.mjs --tasks <ids|all|probe> [--runs N] [--label text] (--profile <file> | --attach <url> | --scripted)
  [--tab <id>] [--toolset all|core] [--pace fast|watch] [--headed] [--clean] [--out <dir>] [--no-repair]
  [--port-from <n>] [--turn-minutes <n>]`;

/** The command line, checked: {tasks, runs, label, driver, profile, attach, tab, toolset, pace, headed, clean, out, repair, portFrom, turnMs}. */
export function parseArgs(argv) {
  const o = { tasks: 'all', runs: 1, label: '', driver: null, profile: null, attach: null, tab: null, toolset: 'all', pace: 'fast', headed: false, clean: false, out: null, repair: true, portFrom: null, turnMs: TURN_MS, help: false };
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

/** A profile file, read and checked: it lives outside the repository (provider names stay out of it). */
export function readProfile(file, repoTop) {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`no profile file at ${path}`);
  const real = realpathSync(path);
  const top = realpathSync(repoTop);
  const rel = relative(top, real);
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error(`the profile ${path} is inside the repository: keep profiles (and keys) outside it`);
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
  const { chromium, expect, request: pwRequest } = await import('@playwright/test');
  const stops = [];
  let base = o.attach;
  let driver = null;
  const created = new Set();
  try {
    if (o.driver === 'scripted' || o.driver === 'profile') {
      const { startHost } = await import('../../../e2e/support/host-server.mjs');
      let fake = null;
      if (o.driver === 'scripted') {
        const { startFakeLlm } = await import('../../../e2e/support/fake-llm.mjs');
        fake = await startFakeLlm();
        stops.push(() => fake.stop());
      }
      const env = { MAGNUSIM_E2E_WSL: null, MAGNUSIM_WSL_PRUNE: '0' };
      if (fake) Object.assign(env, { MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base, MAGNUSIM_TEST_EVENT_HUB: '1' });
      say('starting an app server of its own (a temp projects root and Assistant home)');
      const host = await startHost({
        name: 'cad-eval',
        seed: false,
        enablePlugins: ['cad'],
        viteCacheDir: join(PLUGIN_DIR, '.cache', 'host-vite-cad-eval'),
        portFrom: o.portFrom ?? Number(process.env.CAD_E2E_PORT_FROM || 8170) + 95,
        env,
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
    const out = o.out ? resolve(o.out) : runFolder(o.label || `${o.driver}${probe ? '-probe' : ''}`);
    mkdirSync(out, { recursive: true });
    say(`records in ${out}`);
    const env = { base, page, driver, out, created, log: (l) => say(l) };

    if (probe) {
      const part = await newPart(page, base, { title: 'Eval · probe', log: env.log });
      created.add(part.projectId);
      const tab = o.tab ?? part.tab;
      const t = await runTurn(base, { text: PROBE_TEXT, tab }, { answer: () => null, ms: o.turnMs, log: env.log });
      const notes = t.events.filter((e) => e.type === 'note').map((e) => e.text);
      const end = t.events.find((e) => e.type === 'end') ?? null;
      const calls = await cadFrameOf(page).evaluate(() => window.__CAD__.assistant.calls);
      const status = (await api(base, '/api/assistant/status')).body ?? {};
      const result = {
        when: new Date().toISOString(),
        model: { provider: status.provider ?? null, model: status.models?.[status.provider] ?? null, served_by: t.turn?.served_by ?? null },
        tools: (await api(base, '/api/assistant/tabs')).body?.tabs?.find((r) => r.tab === tab)?.tools.length ?? null,
        strict: notes.some((n) => STRICT_FALLBACK.test(n)) ? 'refused: sent again unchecked by the provider' : 'accepted',
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
            const r = await runTask(env, task, { label: o.label, run, pace: o.pace, toolset: o.toolset, repair: o.repair, turnMs: o.turnMs, tab: o.tab });
            records.push(r);
            say(`${task.id}: first shot ${r.first_shot.pass ? 'pass' : 'fail'}, final ${r.final.pass ? 'pass' : 'fail'} (${r.final.passed}/${r.final.counted}), ${r.steps} steps, $${r.usd}, ${r.wall_s} s`);
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
    if (o.clean && created.size) {
      for (const id of created) {
        const r = await api(base, '/api/project/delete', { project_id: id });
        say(`removed project ${id}: ${r.status}`);
      }
    }
    return 0;
  } catch (e) {
    console.error(`[eval] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    for (const stop of stops) {
      try {
        await stop();
      } catch {
        // Going anyway.
      }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
