// The evaluation set's scoring (CAD tools spec §12.1 eval-score, §12.5): every task's reference
// (eval/references, the calls the scripted model makes) is built through the page's tool handler on
// the REAL kernel, the Part's facts are read (src/assistant/eval-facts.ts) with what the task's
// checks ask for, its parameter walk runs, and eval/score.mjs scores it: every check passes on the
// reference. Then each check's facts are changed (a volume, a box, a hole moved or gone, a spot
// moved off its circle or its spacing, the interlock columns without Red above White, ...) and that
// check, and the task, fail. Every check kind is met. The formula reader and the task files are
// checked apart from the kernel.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { lastText, loadReference, loadTask, referenceCalls, runWalks, taskIds } from '../../eval/lib.mjs';
import { CHECK_KINDS, checkIds, factsAsk, formula, holesOf, score, taskProblems, within, type Check, type EvalTask, type ScoreExtra } from '../../eval/score.mjs';
import { evalFacts, evalSetParam } from '../../src/assistant/eval-facts';
import type { EvalFacts } from '../../src/assistant/eval-types';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('formulas', () => {
  it('read numbers, + - * / ^, parentheses, unary minus, pi and the functions', () => {
    expect(formula(12)).toBe(12);
    expect(formula('100*60*8 - 4*pi*3.25^2*8')).toBeCloseTo(48000 - 4 * Math.PI * 3.25 ** 2 * 8, 9);
    expect(formula('2^3^2')).toBe(512);
    expect(formula('-(1 + 2)*3')).toBe(-9);
    expect(formula('-2^2')).toBe(-4);
    expect(formula('sqrt(16) + max(1, 3) - min(2, 5) + abs(-1)')).toBe(6);
    expect(formula('tan(45*deg)')).toBeCloseTo(1, 12);
    expect(formula('1.5e3 / .5')).toBe(3000);
  });

  it('refuse what they cannot read, naming the column', () => {
    expect(() => formula('2 * (3 + 4')).toThrow(/a "\)" is missing at column 11/);
    expect(() => formula('2 * w')).toThrow(/unknown name "w" at column 6/);
    expect(() => formula('2 3')).toThrow(/unexpected text at column 3/);
    expect(() => formula('1/0')).toThrow(/not a finite number/);
    expect(() => formula({} as unknown as string)).toThrow(/a formula is a number or text/);
  });

  it('compare within an absolute or a relative room (1e-6 relative by default)', () => {
    expect(within(100.05, 100, { abs: 0.1 })).toBe(true);
    expect(within(100.2, 100, { abs: 0.1 })).toBe(false);
    expect(within(101, 100, { rel: 0.01 })).toBe(true);
    expect(within(101.1, 100, { rel: 0.01 })).toBe(false);
    expect(within(100 + 1e-5, 100)).toBe(true);
    expect(within(100.01, 100)).toBe(false);
    expect(within(null, 100, { abs: 1 })).toBe(false);
    expect(within(1, 1, { abs: '0.5*2' })).toBe(true);
  });
});

describe('the tasks', () => {
  it('are nine, each sound, each with a reference of its own', () => {
    expect(taskIds()).toEqual(['edit-plate', 'enclosure', 'flange', 'l-bracket', 'pipe-elbow', 'plate-holes', 'poker-chip', 'spacer', 'vortex']);
    for (const id of taskIds()) {
      const task = loadTask(id);
      expect(taskProblems(task), id).toEqual([]);
      const ref = loadReference(id);
      expect(ref.id).toBe(id);
      expect(ref.turns).toHaveLength(1 + task.turns.length);
    }
    expect(Object.fromEntries(taskIds().map((id) => [id, loadTask(id).tier]))).toEqual({
      'plate-holes': 'L1',
      spacer: 'L1',
      'l-bracket': 'L2',
      flange: 'L2',
      enclosure: 'L3',
      'poker-chip': 'L3',
      'pipe-elbow': 'L4',
      vortex: 'L4',
      'edit-plate': 'Edit',
    });
    expect(loadTask('vortex').units).toBe('in');
  });

  it('a task that is not sound says what is wrong', () => {
    expect(taskProblems({ id: 'Bad id', tier: 'L9', units: 'cm', prompt: '', turns: [3], checks: [{ kind: 'nope' }, { id: 'a', kind: 'volume', expect: '2 *' }, { id: 'a', kind: 'bbox' }], gates: { delete: 'maybe' } })).toEqual([
      'id "Bad id" is not lower-case words joined by -',
      'tier "L9" is not one of L1, L2, L3, L4, Edit',
      'units "cm" is not mm or in',
      'prompt is missing',
      'turns is a list of follow-up requests',
      'gates.delete is "maybe", not allow or deny',
      'check kind "nope" is unknown',
      'a.expect: a number is missing at column 4 of "2 *"',
      'check id "a" is used twice',
    ]);
    expect(() => loadTask('nope')).toThrow(/no task "nope": the tasks are edit-plate, enclosure/);
  });

  it('ask the facts for what their checks read', () => {
    expect(factsAsk(loadTask('poker-chip'))).toEqual({
      pairs: [['Red', 'White']],
      union: true,
      sections: [
        { body: '*', origin: [0, 0, 1.65], normal: [0, 0, 1] },
        { body: 'White', origin: [0, 0, 3.25], normal: [0, 0, 1] },
      ],
      probes: [{ inner: 'White', bodies: ['Red'], origin: [0, 0, 1.65], normal: [0, 0, 1] }],
    });
    expect(factsAsk(loadTask('plate-holes'))).toEqual({ pairs: [], union: false, sections: [], probes: [] });
    expect(checkIds({ checks: [{ kind: 'holes' }, { kind: 'holes' }, { id: 'x', kind: 'volume' }] as Check[] })).toEqual(['holes', 'holes-1', 'x']);
  });
});

// ---------------------------------------------------------------- the references on the real kernel

type Variant = { label: string; facts: EvalFacts; extra: ScoreExtra };

/** Ways to break what check `c` reads (each must make it fail). */
function variants(c: Check, facts: EvalFacts, extra: ScoreExtra, id: string): Variant[] {
  const out: Variant[] = [];
  const v = (label: string, change: (f: EvalFacts, x: ScoreExtra) => void) => {
    const f = clone(facts);
    const x = clone(extra);
    change(f, x);
    out.push({ label, facts: f, extra: x });
  };
  const holeFaces = (f: EvalFacts) => holesOf(f, c).flatMap((g) => g.faces as EvalFacts['faces']);
  const section = (f: EvalFacts) => f.sections.find((s) => s.body === (c.body ?? '*') && Math.abs(s.plane.origin[2] - formula(c.z as number)) < 1e-9)!;
  switch (c.kind) {
    case 'bodies':
      if (c.solids !== undefined) v('a body with one solid more', (f) => void f.bodies[0].solids++);
      if (c.voids !== undefined) v('a body with a void', (f) => void (f.bodies[0].voids = (f.bodies[0].voids ?? 0) + 1));
      if (c.names) v('a body renamed', (f) => void (f.bodies[0].name = 'Body 9'));
      if (c.count !== undefined) v('a body more', (f) => void f.bodies.push(clone(f.bodies[0])));
      if (c.valid) v('a body not valid', (f) => void (f.bodies[0].valid = false));
      break;
    case 'volume':
      v('5% more volume', (f) => f.bodies.forEach((b) => (b.volume = (b.volume ?? 0) * 1.05)));
      break;
    case 'bbox':
      v('a box 1 mm longer', (f) => f.bodies.forEach((b) => (b.bbox[3] += 1)));
      break;
    case 'holes':
      if (c.count !== undefined)
        v('a hole gone', (f) => {
          const gone = holeFaces(f)[0];
          f.faces = f.faces.filter((x) => x !== gone);
        });
      if (c.at || c.axis_radius !== undefined) v('the holes 1 mm along X', (f) => holeFaces(f).forEach((x) => (x.axis!.point[0] += 1)));
      if (c.centred !== undefined) v('the holes off their faces', (f) => holeFaces(f).forEach((x) => (x.centred_mm = [1, 1])));
      break;
    case 'round_faces':
      v('the round faces 0.5 mm larger', (f) => f.faces.forEach((x) => typeof x.radius === 'number' && (x.radius += 0.5)));
      break;
    case 'flat_faces':
      v('the flat faces 10% larger', (f) => f.faces.forEach((x) => x.type === 'plane' && x.area !== null && (x.area *= 1.1)));
      break;
    case 'features_ok':
      v('a feature failing', (f) => void (f.features[f.features.length - 1].state = 'error'));
      break;
    case 'sketches_defined':
      v('a sketch under-defined', (f) => void (f.sketches[0].dof = 2));
      break;
    case 'params':
      v('a parameter that does not evaluate', (f) => void (f.params[0].value = null));
      v('too few parameters', (f) => void (f.params = f.params.slice(0, 1)));
      break;
    case 'walk':
      v('the walk changing the volume 10% more', (_f, x) => {
        const step = x.walk![id].steps[0];
        step.volume = (step.volume ?? 0) * 1.1;
      });
      v('the walk breaking a feature', (_f, x) => void (x.walk![id].steps[1].failing = ['Hole 1']));
      v('no such parameter', (_f, x) => void (x.walk![id] = { steps: [], error: 'no parameter named t' }));
      break;
    case 'overlap':
      v('5 mm3 shared', (f) => void (f.pairs[0].overlap = 5));
      break;
    case 'union':
      v('the union with no void', (f) => void (f.union!.voids = 0));
      v('the union in two solids', (f) => void (f.union!.solids = 2));
      v('the union 2% smaller', (f) => void (f.union!.volume *= 0.98));
      break;
    case 'section':
      if (c.holes !== undefined) v('no pocket in the cut', (f) => void (section(f).holes = 0));
      if (c.area) v('the cut 10% smaller', (f) => void (section(f).area *= 0.9));
      break;
    case 'wall':
      v('a wall 0.1 mm thicker', (f) => {
        const hole = section(f).pieces.filter((p) => p.depth === 1).sort((a, b) => b.area - a.area)[0];
        hole.bbox[0] += 0.1;
      });
      break;
    case 'spots':
      v('a spot 0.05 mm off its circle', (f) => {
        const p = section(f).pieces.find((x) => x.depth === 0 && x.centroid)!;
        const r = Math.hypot(p.centroid![0], p.centroid![1]);
        p.centroid![0] *= (r + 0.05) / r;
        p.centroid![1] *= (r + 0.05) / r;
      });
      v('a spot turned 0.5 deg', (f) => {
        const p = section(f).pieces.find((x) => x.depth === 0 && x.centroid)!;
        const a = (0.5 * Math.PI) / 180;
        const [x, y] = p.centroid!;
        p.centroid![0] = x * Math.cos(a) - y * Math.sin(a);
        p.centroid![1] = x * Math.sin(a) + y * Math.cos(a);
      });
      v('a spot less', (f) => {
        const s = section(f);
        s.pieces.splice(s.pieces.findIndex((x) => x.depth === 0), 1);
      });
      break;
    case 'interlock':
      v('no Red above White in any column', (f) => {
        const inner = String(c.inner);
        const outer = String(c.outer);
        for (const p of f.probes) {
          const top = Math.max(...p.intervals[inner].map(([, b]) => b));
          p.intervals[outer] = p.intervals[outer].filter(([a]) => a < top);
        }
      });
      v('no column measured', (f) => void (f.probes = []));
      break;
    case 'names_kept':
      v('a feature renamed', (f) => void (f.features[0].name = `${f.features[0].name} 2`));
      break;
    case 'feature_type':
      v('the feature failing', (f) => f.features.forEach((x) => x.type === c.type && (x.state = 'error')));
      v('no such feature', (f) => void (f.features = f.features.filter((x) => x.type !== c.type)));
      break;
    case 'driven':
      v('the diameter a plain number', (f) => f.sketches.forEach((s) => s.dims.forEach((d) => d.kind === c.dimension && (d.expr = `${d.value} mm`))));
      break;
    case 'units':
      v('a Part in mm', (f) => void (f.units.length = 'mm'));
      break;
    case 'blend_honest': {
      const blend = (state: string, message: string | null) => ({ name: 'Inlet blend', type: 'fillet', state, message, suppressed: false, by_assistant: true, values: [{ field: 'radius', expr: 'R_in', value: formula(c.radius as number) }] });
      v('a red blend with no message', (f) => void f.features.push(blend('error', null)));
      v("a red blend the Part's health does not show", (f) => {
        f.features.push(blend('error', 'The fillet failed'));
        f.health = { health: 'ok', words: [] };
      });
      v('a blend that is ok on a body that is not valid', (f) => {
        f.features.push(blend('ok', null));
        f.bodies[0].valid = false;
      });
      break;
    }
    case 'last_text':
      v('last words that do not name it', (_f, x) => void (x.last_text = 'Done.'));
      break;
  }
  return out;
}

/** Build a task's reference through the tool handler, as the scripted model calls it, turn by turn. */
async function buildReference(id: string): Promise<{ task: EvalTask; facts: EvalFacts; extra: ScoreExtra }> {
  const task = loadTask(id);
  const ref = loadReference(id);
  h = await assistantHarness({ sketchMode: true, units: task.units === 'in' ? 'imperial' : 'metric' });
  const x = h;
  const names: string[][] = [];
  for (let turn = 0; turn < ref.turns.length; turn++) {
    for (const c of referenceCalls(ref, turn)) {
      const r = await x.call(c.tool, c.input, { turn: `t-${turn}` });
      expect(r.ok ? 'ok' : (r.error as { code: string }).code, `${id} turn ${turn} ${c.tool}: ${r.ok ? '' : JSON.stringify(r.error)}`).toBe(c.expect);
    }
    names.push(x.doc.state.get().doc.features.map((f) => f.name));
  }
  const facts = await evalFacts(x.services, factsAsk(task));
  const walk = await runWalks(task, { facts: (a) => evalFacts(x.services, a), setParam: (n, e) => evalSetParam(x.services, n, e) });
  // The last words of the reference's last turn, as the turn log gives them.
  const lastTurn = ref.turns[ref.turns.length - 1];
  const last = lastText(lastTurn.flatMap((s, step) => (s.text ? [{ type: 'text', step, text: s.text }] : [])));
  return { task, facts, extra: { walk, names, last_text: last } };
}

const met = new Set<string>();

describe('the references on the real kernel', () => {
  for (const id of ['plate-holes', 'spacer', 'l-bracket', 'flange', 'enclosure', 'poker-chip', 'pipe-elbow', 'vortex', 'edit-plate']) {
    it(
      `${id}: every check passes on the reference, and fails when what it reads is changed`,
      async () => {
        const { task, facts, extra } = await buildReference(id);
        expect(facts.errors).toEqual([]);
        const r = score(task, facts, extra);
        expect(
          r.checks.filter((c) => !c.pass).map((c) => `${c.id}: ${c.why}`),
          `${id} on its reference`,
        ).toEqual([]);
        expect(r.pass).toBe(true);
        const ids = checkIds(task);
        task.checks.forEach((c, k) => {
          const vs = variants(c, facts, extra, ids[k]);
          expect(vs.length, `${ids[k]} has a way to fail`).toBeGreaterThan(0);
          for (const variant of vs) {
            const s = score(task, variant.facts, variant.extra);
            const got = s.checks.find((x) => x.id === ids[k])!;
            expect(got.pass, `${id} ${ids[k]} with ${variant.label}`).toBe(false);
            expect(got.why, `${id} ${ids[k]} says why`).not.toBe('');
            if (!c.heuristic) expect(s.pass).toBe(false);
            else expect(s.pass, 'a heuristic check never decides the task').toBe(true);
          }
          met.add(c.kind);
        });
      },
      id === 'poker-chip' ? 300_000 : REAL_KERNEL_MS,
    );
  }

  it('the references meet every check kind', () => {
    expect([...met].sort()).toEqual([...CHECK_KINDS].sort());
  });
});

describe('blend_honest', () => {
  const task = { checks: [{ id: 'b', kind: 'blend_honest', feature: 'fillet', radius: 3.175 } as Check] };
  const facts = (features: Partial<EvalFacts['features'][number]>[], health = 'ok', valid = true) =>
    ({ features: features.map((f) => ({ name: 'Inlet blend', type: 'fillet', suppressed: false, by_assistant: true, values: [{ field: 'radius', expr: 'R_in', value: 3.175 }], message: null, state: 'ok', ...f })), health: { health, words: [] }, bodies: [{ valid }] }) as unknown as EvalFacts;
  it('passes when the blend is absent, red with its message and the health saying so, or made on a valid body', () => {
    expect(score(task, facts([])).pass).toBe(true);
    expect(score(task, facts([{ state: 'error', message: 'Fillet failed: the kernel could not make it' }], 'error')).pass).toBe(true);
    expect(score(task, facts([{ state: 'ok' }])).pass).toBe(true);
    // A fillet of another radius is not the blend.
    expect(score(task, facts([{ state: 'error', values: [{ field: 'radius', expr: '1 mm', value: 1 }] }])).pass).toBe(true);
  });
  it('fails a red blend without its message, or one the health hides', () => {
    expect(score(task, facts([{ state: 'error' }], 'error')).checks[0].why).toBe('Inlet blend fails with no message');
    expect(score(task, facts([{ state: 'error', message: 'x' }], 'ok')).checks[0].why).toBe("Inlet blend fails but the Part's health says ok");
    expect(score(task, facts([{ state: 'suppressed' }])).checks[0].why).toBe('Inlet blend is suppressed');
  });
});
