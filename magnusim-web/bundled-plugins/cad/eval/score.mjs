// The evaluation set's checks (CAD tools spec §12.5): what a task's `checks` say, scored on the
// Part's facts (src/assistant/eval-facts.ts, read through window.__CAD__.assistant.evalFacts).
// Pure: no I/O, no kernel. eval/lib.mjs runs the turns and reads the facts; tests/assistant/
// eval-score.test.ts builds every reference on the real kernel and checks that every kind passes
// on it and fails when its facts are changed.
//
// A check is {id?, kind, heuristic?, ...}; `expect` and tolerances may be numbers or formulas
// ("100*60*8 - 4*pi*3.25^2*8": numbers, + - * / ^, parentheses, pi, sqrt, sin, cos, tan, atan,
// abs, min, max; angles in radians, deg = pi/180). Lengths are mm, areas mm², volumes mm³.
// A heuristic check is scored and reported but never decides the task's pass.
//   bodies            count, names, and for each body solids, shells, voids, valid
//   volume            one body's volume, or every body's together (expect, rel | abs)
//   bbox              one body's box, or every body's together: expect [x0,y0,z0,x1,y1,z1] or size [dx,dy,dz] (abs)
//   holes             round bores of radius r (one per axis): count, at points, at a radius from an axis, centred on a flat face
//   round_faces       faces of a type (cylinder, cone, torus, sphere) and radius, hole or boss or neither: count or min
//   flat_faces        flat faces of an area: count or min
//   features_ok       every feature ok (warnings only when allowed)
//   sketches_defined  every sketch fully defined (dof 0, analysed again)
//   params            at least `min` parameters, all evaluating
//   walk              a parameter set to each value in turn: every feature ok, the volume at each ratio of the first
//   overlap           two bodies share at most `max` mm³
//   union             every body joined: solids, voids, volume
//   section           a cut at height z (or a plane): its material's area, holes, pieces
//   wall              a cut at z: the material between its outside and its hole, on every side
//   spots             a cut at z of one body: its pieces the same distance from an axis and evenly spaced
//   interlock         columns through the inner body at its section: the outer body above and below it in one
//   names_kept        every feature there after turn k is still there
//   feature_type      features of a type (and state): min, max
//   driven            a sketch dimension of a kind and value whose expression names a parameter
//   units             the Part's length unit
//   blend_honest      a fillet of radius r is absent, or fails with its message while the Part's health says so
//   last_text         the last turn's last words match (a heuristic)
// SPDX-License-Identifier: GPL-3.0-or-later

/** Every check kind, in the order the header lists them. */
export const CHECK_KINDS = Object.freeze([
  'bodies',
  'volume',
  'bbox',
  'holes',
  'round_faces',
  'flat_faces',
  'features_ok',
  'sketches_defined',
  'params',
  'walk',
  'overlap',
  'union',
  'section',
  'wall',
  'spots',
  'interlock',
  'names_kept',
  'feature_type',
  'driven',
  'units',
  'blend_honest',
  'last_text',
]);

// ---------------------------------------------------------------- formulas

const FUNCS = {
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  atan: Math.atan,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
};
const CONSTS = { pi: Math.PI, deg: Math.PI / 180 };

/** A formula's value (or a number as it is); throws with the column of what it cannot read. */
export function formula(text) {
  if (typeof text === 'number') {
    if (!Number.isFinite(text)) throw new Error(`not a finite number: ${text}`);
    return text;
  }
  if (typeof text !== 'string') throw new Error(`a formula is a number or text, not ${JSON.stringify(text)}`);
  const s = text;
  let i = 0;
  const fail = (why) => {
    throw new Error(`${why} at column ${i + 1} of "${s}"`);
  };
  const space = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const peek = () => {
    space();
    return s[i];
  };
  const primary = () => {
    const c = peek();
    if (c === '(') {
      i++;
      const v = sum();
      if (peek() !== ')') fail('a ")" is missing');
      i++;
      return v;
    }
    if (c === '-') {
      i++;
      return -power();
    }
    if (c === '+') {
      i++;
      return power();
    }
    const num = /^(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?/.exec(s.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (word) {
      i += word[0].length;
      const w = word[0];
      if (Object.hasOwn(FUNCS, w)) {
        if (peek() !== '(') fail(`${w} needs (`);
        i++;
        const args = [sum()];
        while (peek() === ',') {
          i++;
          args.push(sum());
        }
        if (peek() !== ')') fail('a ")" is missing');
        i++;
        return FUNCS[w](...args);
      }
      if (Object.hasOwn(CONSTS, w)) return CONSTS[w];
      fail(`unknown name "${w}"`);
    }
    return fail('a number is missing');
  };
  const power = () => {
    const base = primary();
    if (peek() === '^') {
      i++;
      return base ** power();
    }
    return base;
  };
  const product = () => {
    let v = power();
    for (let c = peek(); c === '*' || c === '/'; c = peek()) {
      i++;
      v = c === '*' ? v * power() : v / power();
    }
    return v;
  };
  const sum = () => {
    let v = product();
    for (let c = peek(); c === '+' || c === '-'; c = peek()) {
      i++;
      v = c === '+' ? v + product() : v - product();
    }
    return v;
  };
  const v = sum();
  space();
  if (i < s.length) fail('unexpected text');
  if (!Number.isFinite(v)) throw new Error(`"${s}" is not a finite number`);
  return v;
}

/** Whether `got` is within the tolerance of `want`: `abs` (mm, mm², mm³) or `rel` (of want); 1e-6 relative by default. */
export function within(got, want, tol = {}) {
  if (typeof got !== 'number' || !Number.isFinite(got)) return false;
  const abs = tol.abs !== undefined ? formula(tol.abs) : null;
  const rel = tol.rel !== undefined ? formula(tol.rel) : abs === null ? 1e-6 : null;
  const room = Math.max(abs ?? 0, rel !== null ? rel * Math.abs(want) : 0);
  return Math.abs(got - want) <= room;
}

// ---------------------------------------------------------------- what to measure

const zPlane = (c) => ({ origin: c.origin ?? [0, 0, formula(c.z)], normal: c.normal ?? [0, 0, 1] });

/** What the facts must measure for these checks (the EvalAsk of src/assistant/eval-facts.ts). */
export function factsAsk(task) {
  const ask = { pairs: [], union: false, sections: [], probes: [] };
  for (const c of task.checks ?? []) {
    if (c.kind === 'overlap') ask.pairs.push([c.a, c.b]);
    else if (c.kind === 'union') ask.union = true;
    else if (c.kind === 'section' || c.kind === 'wall' || c.kind === 'spots') ask.sections.push({ body: c.body ?? '*', ...zPlane(c) });
    else if (c.kind === 'interlock') ask.probes.push({ inner: c.inner, bodies: [c.outer], ...zPlane(c), ...(c.columns ? { columns: c.columns } : {}) });
  }
  return ask;
}

/** The section the facts hold for a check (the same body and plane). */
function sectionFor(facts, c) {
  const p = zPlane(c);
  const n = unit(p.normal);
  const body = c.body ?? '*';
  return (facts.sections ?? []).find((s) => s.body === body && Math.abs(dot(s.plane.normal, n) - 1) < 1e-9 && Math.abs(dot(s.plane.origin, n) - dot(p.origin, n)) < 1e-9) ?? null;
}

// ---------------------------------------------------------------- the checks

const lower = (s) => String(s ?? '').trim().toLowerCase();
const bodyNamed = (facts, name) => (facts.bodies ?? []).find((b) => lower(b.name) === lower(name)) ?? null;
const round = (v, digits = 6) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(digits)) : v);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => {
  const l = norm(a);
  return l > 0 ? a.map((x) => x / l) : [0, 0, 1];
};
/** The distance from p to the line through `point` along `dir`. */
const lineDistance = (point, dir, p) => norm(cross(sub(p, point), unit(dir)));

/** Each body's box, or all of them together. */
function boxOf(facts, body) {
  const of = body ? [bodyNamed(facts, body)].filter(Boolean) : (facts.bodies ?? []);
  if (!of.length) return null;
  return of.map((b) => b.bbox).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5])]);
}

/** The holes of radius r (within abs): their faces grouped by axis (a bore split into faces is one hole). */
export function holesOf(facts, c) {
  const r = formula(c.radius);
  const abs = c.abs !== undefined ? formula(c.abs) : 0.01;
  const faces = (facts.faces ?? []).filter((f) => f.kind === 'hole' && f.axis && typeof f.radius === 'number' && Math.abs(f.radius - r) <= abs && (!c.body || lower(f.body) === lower(c.body)));
  const groups = [];
  for (const f of faces) {
    const same = groups.find((g) => lower(g.body) === lower(f.body) && Math.abs(Math.abs(dot(unit(g.axis.dir), unit(f.axis.dir))) - 1) < 1e-6 && lineDistance(g.axis.point, g.axis.dir, f.axis.point) < abs);
    if (same) same.faces.push(f);
    else groups.push({ body: f.body, axis: f.axis, radius: f.radius, faces: [f] });
  }
  return groups;
}

const CHECKS = {
  bodies(c, facts) {
    const bodies = facts.bodies ?? [];
    const problems = [];
    if (c.count !== undefined && bodies.length !== c.count) problems.push(`${bodies.length} bodies, not ${c.count}`);
    if (c.names) {
      const have = bodies.map((b) => lower(b.name)).sort();
      const want = c.names.map(lower).sort();
      if (JSON.stringify(have) !== JSON.stringify(want)) problems.push(`bodies are ${bodies.map((b) => b.name).join(', ') || 'none'}, not ${c.names.join(', ')}`);
    }
    for (const b of bodies) {
      for (const k of ['solids', 'shells', 'voids']) if (c[k] !== undefined && b[k] !== c[k]) problems.push(`${b.name} has ${b[k]} ${k}, not ${c[k]}`);
      if (c.valid && !b.valid) problems.push(`${b.name} is not a valid solid`);
    }
    return { pass: problems.length === 0, got: bodies.map((b) => ({ name: b.name, solids: b.solids, shells: b.shells, voids: b.voids, valid: b.valid })), why: problems.join('; ') };
  },

  volume(c, facts) {
    const want = formula(c.expect);
    const of = c.body ? [bodyNamed(facts, c.body)] : (facts.bodies ?? []);
    if (!of.length || of.some((b) => !b || typeof b.volume !== 'number')) return { pass: false, got: null, want: round(want), why: c.body ? `no body ${c.body} with a volume` : 'no body with a volume' };
    const got = of.reduce((s, b) => s + b.volume, 0);
    const pass = within(got, want, c);
    return { pass, got: round(got), want: round(want), why: pass ? '' : `volume ${round(got)} mm3, not ${round(want)} (${round(((got - want) / want) * 100, 3)}%)` };
  },

  bbox(c, facts) {
    const b = boxOf(facts, c.body);
    if (!b) return { pass: false, got: null, why: 'no body' };
    const abs = c.abs !== undefined ? formula(c.abs) : 0.01;
    if (c.size) {
      const size = [b[3] - b[0], b[4] - b[1], b[5] - b[2]];
      const want = c.size.map(formula);
      const pass = size.every((v, k) => Math.abs(v - want[k]) <= abs);
      return { pass, got: size.map((v) => round(v)), want, why: pass ? '' : `size ${size.map((v) => round(v)).join(' x ')}, not ${want.join(' x ')}` };
    }
    const want = c.expect.map(formula);
    const pass = b.every((v, k) => Math.abs(v - want[k]) <= abs);
    return { pass, got: b.map((v) => round(v)), want, why: pass ? '' : `box [${b.map((v) => round(v)).join(', ')}], not [${want.join(', ')}]` };
  },

  holes(c, facts) {
    const holes = holesOf(facts, c);
    const atAbs = c.at_abs !== undefined ? formula(c.at_abs) : 0.05;
    const problems = [];
    if (c.count !== undefined && holes.length !== c.count) problems.push(`${holes.length} holes of radius ${formula(c.radius)}, not ${c.count}`);
    for (const p of c.at ?? []) {
      const pt = p.map(formula);
      if (!holes.some((h) => lineDistance(h.axis.point, h.axis.dir, pt) <= atAbs)) problems.push(`no hole through (${pt.join(', ')})`);
    }
    if (c.axis_radius !== undefined) {
      const r = formula(c.axis_radius);
      const about = c.about ?? { point: [0, 0, 0], dir: [0, 0, 1] };
      for (const h of holes) {
        const d = lineDistance(about.point, about.dir, h.axis.point);
        if (Math.abs(d - r) > atAbs) problems.push(`a hole's axis is ${round(d)} mm from the axis, not ${r}`);
      }
    }
    if (c.centred !== undefined) {
      const tol = formula(c.centred);
      for (const h of holes) {
        const best = Math.min(...h.faces.flatMap((f) => f.centred_mm ?? []));
        if (!(best <= tol)) problems.push(`a hole's axis passes ${Number.isFinite(best) ? round(best) : 'far'} mm from the centre of each flat face it opens into`);
      }
    }
    return { pass: problems.length === 0, got: holes.map((h) => ({ body: h.body, point: h.axis.point.map((v) => round(v)), dir: h.axis.dir.map((v) => round(v)) })), why: problems.join('; ') };
  },

  round_faces(c, facts) {
    const r = formula(c.radius);
    const abs = c.abs !== undefined ? formula(c.abs) : 0.01;
    const want = c.round === 'neither' ? null : c.round;
    const faces = (facts.faces ?? []).filter((f) => f.type === (c.face ?? 'cylinder') && typeof f.radius === 'number' && Math.abs(f.radius - r) <= abs && (c.round === undefined || (f.kind ?? null) === want));
    const n = faces.length;
    const pass = c.count !== undefined ? n === c.count : n >= (c.min ?? 1);
    return { pass, got: n, why: pass ? '' : `${n} ${c.face ?? 'cylinder'} faces of radius ${r}${c.round ? ` (${c.round})` : ''}` };
  },

  flat_faces(c, facts) {
    const want = formula(c.area);
    const faces = (facts.faces ?? []).filter((f) => f.type === 'plane' && within(f.area, want, c.rel === undefined && c.abs === undefined ? { rel: 0.001 } : c));
    const n = faces.length;
    const pass = c.count !== undefined ? n === c.count : n >= (c.min ?? 1);
    return { pass, got: n, want: round(want), why: pass ? '' : `${n} flat faces of ${round(want)} mm2` };
  },

  features_ok(c, facts) {
    const allow = new Set(['ok', ...(c.allow ?? [])]);
    const bad = (facts.features ?? []).filter((f) => !allow.has(f.state));
    const none = !(facts.features ?? []).length;
    return { pass: !bad.length && !none, got: bad.map((f) => `${f.name}: ${f.state}${f.message ? ` (${f.message})` : ''}`), why: none ? 'no features' : bad.map((f) => `${f.name} is ${f.state}`).join('; ') };
  },

  sketches_defined(_c, facts) {
    const bad = (facts.sketches ?? []).filter((s) => s.dof !== 0);
    return { pass: !bad.length, got: (facts.sketches ?? []).map((s) => `${s.name}: dof ${s.dof}`), why: bad.map((s) => `${s.name} has dof ${s.dof}`).join('; ') };
  },

  params(c, facts) {
    const params = facts.params ?? [];
    const broken = params.filter((p) => p.value === null);
    const pass = params.length >= (c.min ?? 1) && !broken.length;
    return { pass, got: params.length, why: pass ? '' : broken.length ? `${broken.map((p) => p.name).join(', ')} do not evaluate` : `${params.length} parameters, fewer than ${c.min}` };
  },

  walk(c, _facts, extra) {
    const walk = extra.walk?.[c.id] ?? null;
    if (!walk) return { pass: false, got: null, why: 'the walk did not run' };
    if (walk.error) return { pass: false, got: walk, why: walk.error };
    const problems = [];
    const base = walk.base;
    (c.steps ?? []).forEach((step, k) => {
      const got = walk.steps[k];
      if (!got) return problems.push(`${c.param} = ${step.expr} did not run`);
      if (!got.ok) return problems.push(`${c.param} = ${step.expr}: ${got.reason}`);
      if (got.failing.length) problems.push(`${c.param} = ${step.expr}: ${got.failing.join(', ')} fail`);
      if (step.volume_ratio !== undefined) {
        const want = formula(step.volume_ratio);
        const ratio = typeof got.volume === 'number' && typeof base === 'number' && base > 0 ? got.volume / base : null;
        if (!within(ratio, want, c.rel === undefined && c.abs === undefined ? { rel: 0.001 } : c)) problems.push(`${c.param} = ${step.expr}: volume ratio ${round(ratio)}, not ${want}`);
      }
    });
    return { pass: !problems.length, got: walk.steps.map((s) => ({ expr: s.expr, ok: s.ok, volume: round(s.volume) })), why: problems.join('; ') };
  },

  overlap(c, facts) {
    const p = (facts.pairs ?? []).find((x) => (lower(x.a) === lower(c.a) && lower(x.b) === lower(c.b)) || (lower(x.a) === lower(c.b) && lower(x.b) === lower(c.a)));
    if (!p || typeof p.overlap !== 'number') return { pass: false, got: null, why: p?.note ?? `${c.a} and ${c.b} were not measured` };
    const max = c.max !== undefined ? formula(c.max) : 0.01;
    return { pass: p.overlap <= max, got: round(p.overlap), want: `<= ${max}`, why: p.overlap <= max ? '' : `${c.a} and ${c.b} share ${round(p.overlap)} mm3` };
  },

  union(c, facts) {
    const u = facts.union;
    if (!u) return { pass: false, got: null, why: 'the union was not measured' };
    const problems = [];
    if (c.solids !== undefined && u.solids !== c.solids) problems.push(`${u.solids} solids, not ${c.solids}`);
    if (c.voids !== undefined && u.voids !== c.voids) problems.push(`${u.voids} voids, not ${c.voids}`);
    if (c.volume) {
      const want = formula(c.volume.expect);
      if (!within(u.volume, want, c.volume)) problems.push(`volume ${round(u.volume)} mm3, not ${round(want)}`);
    }
    return { pass: !problems.length, got: { solids: u.solids, voids: u.voids, volume: round(u.volume) }, why: problems.join('; ') };
  },

  section(c, facts) {
    const s = sectionFor(facts, c);
    if (!s) return { pass: false, got: null, why: 'the section was not measured' };
    const problems = [];
    if (c.area) {
      const want = formula(c.area.expect);
      if (!within(s.area, want, c.area)) problems.push(`area ${round(s.area)} mm2, not ${round(want)}`);
    }
    if (c.holes !== undefined && s.holes !== c.holes) problems.push(`${s.holes} holes, not ${c.holes}`);
    const pieces = s.pieces.filter((p) => p.depth % 2 === 0).length;
    if (c.pieces !== undefined && pieces !== c.pieces) problems.push(`${pieces} pieces, not ${c.pieces}`);
    return { pass: !problems.length, got: { area: round(s.area), holes: s.holes, pieces }, why: problems.join('; ') };
  },

  wall(c, facts) {
    const s = sectionFor(facts, c);
    if (!s) return { pass: false, got: null, why: 'the section was not measured' };
    const outer = s.pieces.filter((p) => p.depth === 0).sort((a, b) => b.area - a.area)[0];
    const holes = s.pieces.filter((p) => p.depth === 1);
    if (!outer || !holes.length) return { pass: false, got: null, why: 'the cut shows no wall around a hole' };
    const hole = holes.sort((a, b) => b.area - a.area)[0];
    const [u0, v0, u1, v1] = outer.bbox;
    const [h0, w0, h1, w1] = hole.bbox;
    const walls = [h0 - u0, w0 - v0, u1 - h1, v1 - w1];
    const want = formula(c.expect);
    const abs = c.abs !== undefined ? formula(c.abs) : 0.01;
    const pass = walls.every((w) => Math.abs(w - want) <= abs);
    return { pass, got: walls.map((w) => round(w)), want, why: pass ? '' : `walls ${walls.map((w) => round(w)).join(', ')} mm, not ${want}` };
  },

  spots(c, facts) {
    const s = sectionFor(facts, c);
    if (!s) return { pass: false, got: null, why: 'the section was not measured' };
    const axis = (c.axis ?? [0, 0]).map(formula);
    const spots = s.pieces.filter((p) => p.depth % 2 === 0 && p.centroid);
    const problems = [];
    if (c.count !== undefined && spots.length !== c.count) problems.push(`${spots.length} spots, not ${c.count}`);
    if (spots.length < 2) return { pass: false, got: spots.length, why: problems.join('; ') || 'fewer than 2 spots' };
    const at = spots.map((p) => ({ r: Math.hypot(p.centroid[0] - axis[0], p.centroid[1] - axis[1]), a: (Math.atan2(p.centroid[1] - axis[1], p.centroid[0] - axis[0]) * 180) / Math.PI }));
    const radii = at.map((x) => x.r);
    const spread = Math.max(...radii) - Math.min(...radii);
    const spreadMax = c.spread_mm !== undefined ? formula(c.spread_mm) : 0.01;
    if (spread > spreadMax) problems.push(`the spots' centres are ${round(Math.min(...radii))} to ${round(Math.max(...radii))} mm from the axis (spread ${round(spread)})`);
    const angles = at.map((x) => (x.a + 360) % 360).sort((a, b) => a - b);
    const step = 360 / angles.length;
    const gaps = angles.map((a, k) => (k + 1 < angles.length ? angles[k + 1] - a : angles[0] + 360 - a));
    const worst = Math.max(...gaps.map((g) => Math.abs(g - step)));
    const spacingMax = c.spacing_deg !== undefined ? formula(c.spacing_deg) : 0.01;
    if (worst > spacingMax) problems.push(`the spots are spaced ${gaps.map((g) => round(g)).join(', ')} deg, not evenly ${round(step)}`);
    return { pass: !problems.length, got: { count: spots.length, radius: round(radii[0]), spread: round(spread), worst_gap_deg: round(worst) }, why: problems.join('; ') };
  },

  interlock(c, facts) {
    const tol = c.tol !== undefined ? formula(c.tol) : 1e-3;
    const columns = (facts.probes ?? []).filter((p) => lower(p.inner) === lower(c.inner));
    if (!columns.length) return { pass: false, got: 0, why: 'no probe column was measured' };
    const hit = columns.find((p) => {
      const inner = p.intervals[Object.keys(p.intervals).find((k) => lower(k) === lower(c.inner))] ?? [];
      const outer = p.intervals[Object.keys(p.intervals).find((k) => lower(k) === lower(c.outer))] ?? [];
      return inner.some(([a, b]) => outer.some(([, y1]) => y1 <= a + tol) && outer.some(([y0]) => y0 >= b - tol));
    });
    return { pass: !!hit, got: { columns: columns.length, at: hit ? hit.at.map((v) => round(v)) : null }, why: hit ? '' : `in none of ${columns.length} columns has ${c.outer} material both above and below ${c.inner}` };
  },

  names_kept(c, facts, extra) {
    const before = extra.names?.[c.after_turn ?? 0];
    if (!before) return { pass: false, got: null, why: `no names were kept after turn ${c.after_turn ?? 0}` };
    const now = new Set((facts.features ?? []).map((f) => f.name));
    const lost = before.filter((n) => !now.has(n));
    return { pass: !lost.length, got: lost, why: lost.length ? `gone or renamed: ${lost.join(', ')}` : '' };
  },

  feature_type(c, facts) {
    const of = (facts.features ?? []).filter((f) => f.type === c.type && (!c.state || f.state === c.state));
    const n = of.length;
    const pass = n >= (c.min ?? 1) && (c.max === undefined || n <= c.max);
    return { pass, got: n, why: pass ? '' : `${n} ${c.type} features${c.state ? ` ${c.state}` : ''}` };
  },

  driven(c, facts) {
    const want = formula(c.value);
    const abs = c.abs !== undefined ? formula(c.abs) : 1e-3;
    const names = (facts.params ?? []).map((p) => p.name);
    const word = (expr, name) => new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`).test(expr);
    const dims = (facts.sketches ?? []).flatMap((s) => s.dims.map((d) => ({ ...d, sketch: s.name }))).filter((d) => d.kind === c.dimension && typeof d.value === 'number' && Math.abs(d.value - want) <= abs);
    const driven = dims.filter((d) => names.some((n) => word(d.expr, n)));
    return { pass: driven.length > 0, got: dims.map((d) => `${d.sketch} ${d.id} = ${d.expr}`), why: driven.length ? '' : dims.length ? `${c.dimension} ${want} is a plain number (${dims.map((d) => d.expr).join(', ')}), not a parameter` : `no ${c.dimension} dimension of ${want}` };
  },

  units(c, facts) {
    const got = facts.units?.length ?? null;
    return { pass: got === c.length, got, want: c.length, why: got === c.length ? '' : `the Part is in ${got}, not ${c.length}` };
  },

  blend_honest(c, facts) {
    const r = formula(c.radius);
    const abs = c.abs !== undefined ? formula(c.abs) : 1e-3;
    const type = c.feature ?? 'fillet';
    const blends = (facts.features ?? []).filter((f) => f.type === type && f.values.some((v) => typeof v.value === 'number' && Math.abs(v.value - r) <= abs));
    if (!blends.length) return { pass: true, got: 'absent', why: '' };
    const problems = [];
    for (const f of blends) {
      if (f.state === 'error') {
        if (!f.message) problems.push(`${f.name} fails with no message`);
        if (facts.health?.health !== 'error') problems.push(`${f.name} fails but the Part's health says ${facts.health?.health}`);
      } else if (f.state === 'ok') {
        if ((facts.bodies ?? []).some((b) => !b.valid)) problems.push(`${f.name} is ok but a body is not valid`);
      } else problems.push(`${f.name} is ${f.state}`);
    }
    return { pass: !problems.length, got: blends.map((f) => `${f.name}: ${f.state}`), why: problems.join('; ') };
  },

  last_text(c, _facts, extra) {
    const text = String(extra.last_text ?? '');
    const re = new RegExp(c.match, 'i');
    return { pass: re.test(text), got: text.slice(0, 200), why: re.test(text) ? '' : `the last words do not match /${c.match}/` };
  },
};

/** Each check's id: its own, else its kind (and its index after the first of a kind). */
export function checkIds(task) {
  return (task.checks ?? []).map((c, k) => c.id ?? `${c.kind}${(task.checks ?? []).some((x, j) => j < k && x.kind === c.kind) ? `-${k}` : ''}`);
}

/**
 * Score one task on the Part's facts. `extra`: what the run kept beside them: `walk` (the
 * parameter walk's results by check id), `names` (feature names after each turn), `last_text`
 * (the last turn's last words). Returns {pass, passed, counted, checks}; heuristic checks are
 * in `checks` but not counted.
 */
export function score(task, facts, extra = {}) {
  const ids = checkIds(task);
  const checks = (task.checks ?? []).map((c, k) => {
    const id = ids[k];
    const run = CHECKS[c.kind];
    let out;
    try {
      out = run ? run({ ...c, id }, facts, extra) : { pass: false, got: null, why: `unknown check kind ${c.kind}` };
    } catch (e) {
      out = { pass: false, got: null, why: `the check could not be scored: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { id, kind: c.kind, heuristic: !!c.heuristic, pass: !!out.pass, got: out.got ?? null, ...(out.want !== undefined ? { want: out.want } : {}), why: out.why || '' };
  });
  const counted = checks.filter((c) => !c.heuristic);
  const passed = counted.filter((c) => c.pass).length;
  return { pass: counted.length > 0 && passed === counted.length, passed, counted: counted.length, checks };
}

/** The checks that failed, in words, for the repair turn ("These checks fail: ..."). */
export function failedWords(result) {
  return result.checks
    .filter((c) => !c.pass && !c.heuristic)
    .map((c) => `${c.id}${c.why ? ` (${c.why})` : ''}`)
    .join('; ');
}

// ---------------------------------------------------------------- tasks

const TIERS = new Set(['L1', 'L2', 'L3', 'L4', 'Edit']);

/** What is wrong with a task's definition (empty when it is sound). */
export function taskProblems(task) {
  const out = [];
  if (!task || typeof task !== 'object') return ['a task is an object'];
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(String(task.id))) out.push(`id "${task.id}" is not lower-case words joined by -`);
  if (!TIERS.has(task.tier)) out.push(`tier "${task.tier}" is not one of ${[...TIERS].join(', ')}`);
  if (task.units !== 'mm' && task.units !== 'in') out.push(`units "${task.units}" is not mm or in`);
  if (typeof task.prompt !== 'string' || task.prompt.length < 20) out.push('prompt is missing');
  if (!Array.isArray(task.turns) || task.turns.some((t) => typeof t !== 'string' || !t.trim())) out.push('turns is a list of follow-up requests');
  if (!Array.isArray(task.checks) || !task.checks.length) out.push('checks is missing');
  if (!task.gates || typeof task.gates !== 'object') out.push('gates is missing');
  else for (const [tool, a] of Object.entries(task.gates)) if (a !== 'allow' && a !== 'deny') out.push(`gates.${tool} is "${a}", not allow or deny`);
  const ids = new Set();
  for (const c of task.checks ?? []) {
    if (!CHECK_KINDS.includes(c.kind)) out.push(`check kind "${c.kind}" is unknown`);
    if (c.id) {
      if (ids.has(c.id)) out.push(`check id "${c.id}" is used twice`);
      ids.add(c.id);
    }
    for (const k of ['expect', 'radius', 'value', 'area', 'z', 'rel', 'abs', 'max', 'axis_radius', 'centred', 'at_abs']) {
      const v = c[k];
      if (v === undefined || typeof v === 'object') continue;
      try {
        formula(v);
      } catch (e) {
        out.push(`${c.id ?? c.kind}.${k}: ${e.message}`);
      }
    }
  }
  return out;
}
