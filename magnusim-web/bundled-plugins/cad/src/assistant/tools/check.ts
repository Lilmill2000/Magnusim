// check: does an assembly hold together and turn (src/features/assembly/check.ts, the checks the
// person's panel runs too), on the bodies built now after the rebuild caught up:
//   interference  pairs that overlap (overlap_mm3, at_mm; press_fit for a bore drawn under its shaft,
//                 counted apart), and with a clearance the pairs closer than it (gap_mm); bodies []
//                 for every body, a chosen set, or one body against every other;
//   stack         each shared axis: its parts in order, what holds each one radially (on, play_mm)
//                 and on each side along it (the body it meets and how far, or nothing), and what is
//                 loose: a part free to slide (nothing on a side), one that slides more than the
//                 play first, a bore nothing holds; clearance: the play counted as held (0.5 mm);
//                 bodies: only the axes near them, and their findings;
//   sweep         bodies turned a full turn about an axis (an axis, a round face, a straight or round
//                 edge, "axis of <round face>", or "" for the axis they share with another body): the
//                 first angle each meets another body both ways, where, and the kernel's overlap 1
//                 degree past it.
// Rows are capped (rows_more says how many more). A read: it never waits for the person. When the
// Part changes while it checks, it checks again once; a second change answers busy/changed. Long
// checks give progress and stop with the call; past the time limit a check's text starts with it
// ("Stopped at the time limit ...": never an all-clear) and a note says what helps.
// The person's side is INSPECT's Check (src/features/check): its Interference, Loose parts and
// Rotation run the same engine and show these replies' words (interferenceReply, stackReply,
// sweepReply), and its axis list resolves reference axes with axisOf.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { axisLine, CheckKernelError, checkInterference, checkStack, checkSweep, PLAY_MM, sharedAxes, SLABS_MAX, sideWords, type AssemblyBody, type AxisLine, type CheckEnv, type InterferenceResult, type StackResult, type StackSide, type SweepResult } from '../../features/assembly/check';
import type { CallCtx, ToolImpl, ToolReply } from '../../types/assistant';
import type { DocState } from '../../types/doc-service';
import type { BodyInfo } from '../../types/kernel';
import { heartbeat, waitForRead } from '../busy';
import { ToolError } from '../errors';
import { entityFacts } from '../measure';
import { bodyNamed, resolveTarget } from '../measure-targets';
import { dir, len, oneLine, sig6, vec } from '../numbers';

type Row = Record<string, unknown>;

/** Most rows a reply lists (the rest counted). */
export const CHECK_ROWS = 40;
/** Most bodies a set names (the schema's maxItems). */
const BODIES_MAX = 64;
const KINDS = ['interference', 'stack', 'sweep'] as const;
type Kind = (typeof KINDS)[number];

interface Input {
  kind: Kind;
  bodies: string[];
  clearance: string;
  axis: string;
}

function inputOf(ctx: CallCtx): Input {
  const { kind, bodies, clearance, axis } = ctx.input;
  const problems: string[] = [];
  if (!KINDS.includes(kind as Kind)) problems.push(`kind must be one of ${KINDS.join(', ')}`);
  if (!Array.isArray(bodies) || bodies.length > BODIES_MAX || !bodies.every((b) => typeof b === 'string')) problems.push(`bodies must be a list of up to ${BODIES_MAX} body names`);
  if (typeof clearance !== 'string') problems.push('clearance must be "" or a length');
  if (typeof axis !== 'string') problems.push('axis must be "" or an axis');
  if (problems.length) throw new ToolError('bad_input', `${problems.join('; ')}.`, { detail: { field: problems[0].split(' ')[0] } });
  return { kind: kind as Kind, bodies: bodies as string[], clearance: clearance as string, axis: axis as string };
}

/** A body as the checks read it. */
export const asBody = (b: BodyInfo): AssemblyBody => ({ id: b.id, name: b.name, shape: b.shape, bbox: b.bbox, faces: b.faces, solids: b.solids ?? null });

/** The bodies named (each once), or every body built now for []. */
function bodiesOf(s: DocState, names: readonly string[], kind: Kind): BodyInfo[] {
  if (!names.length) {
    if (kind === 'sweep') throw new ToolError('bad_input', 'bodies: name the bodies that turn.', { detail: { field: 'bodies' } });
    return [...s.rebuild.bodies];
  }
  const out: BodyInfo[] = [];
  names.forEach((n, i) => {
    const b = bodyNamed(s, n);
    if (!b) throw new ToolError('not_found', `bodies[${i}]: no body is called "${n}". Bodies: ${s.rebuild.bodies.map((x) => x.name).slice(0, 30).join(', ') || 'none yet'}.`, { detail: { field: `bodies[${i}]`, bodies: s.rebuild.bodies.map((x) => x.name).slice(0, 30) } });
    if (out.includes(b)) throw new ToolError('bad_input', `bodies: ${b.name} is named twice: name each body once.`, { detail: { field: 'bodies' } });
    out.push(b);
  });
  return out;
}

/** The clearance (interference: 0 for none) or the play (stack: PLAY_MM for none), in mm. */
function lengthOf(ctx: CallCtx, text: string, none: number): number {
  if (!text.trim()) return none;
  const r = ctx.services.doc.units.evaluate(text, 'length');
  if (!r.ok) throw new ToolError('expr_error', `clearance "${text}": ${r.error}`, { detail: { field: 'clearance' } });
  if (r.value < 0) throw new ToolError('bad_input', 'clearance cannot be below 0.', { detail: { field: 'clearance' } });
  return r.value;
}

/** The sweep's axis: an axis, a round face's, an edge's, "axis of <round face>"; null for "" (the shared one). */
export async function axisOf(ctx: CallCtx, s: DocState, text: string): Promise<{ line: AxisLine; words: string } | null> {
  const raw = text.trim();
  if (!raw) return null;
  const face = /^axis\s+of\s+(.+)$/i.exec(raw);
  const e = await resolveTarget(ctx, s, face ? face[1] : raw, 'axis');
  if (e.kind === 'axis') return { line: axisLine(e.origin, e.dir), words: e.words };
  if (e.kind === 'face' || e.kind === 'edge') {
    const f = await entityFacts(ctx.services, e);
    if (f.axis && (e.kind === 'edge' || f.type !== 'plane')) return { line: axisLine(f.axis.point, f.axis.dir), words: `the axis of ${e.words}` };
  }
  throw new ToolError('bad_input', `axis: ${e.words} has no axis. Give X axis, Y axis, Z axis, a construction axis, a round face ("axis of <face>") or a straight or round edge, or "" for the axis the bodies share.`, { detail: { field: 'axis' } });
}

const roundRows = <T>(list: readonly T[], map: (x: T) => Row): { rows: Row[]; more: number } => ({ rows: list.slice(0, CHECK_ROWS).map(map), more: Math.max(0, list.length - CHECK_ROWS) });
const word = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The words a check's text starts with when the time limit stopped it. */
export const STOPPED = 'Stopped at the time limit';
/** What a stopped check says it got to, and what helps it finish. */
const stopped = (complete: boolean, what: string, helps: string): Row => (complete ? {} : { note: `${STOPPED}: ${what}. ${helps}` });
const THINNED_NOTE = `more than ${SLABS_MAX} levels along an axis: the levels of bodies away from its own parts were left out, so a thin one there may be missed`;

async function interference(env: CheckEnv, bodies: AssemblyBody[], clearance: number, one?: number): Promise<ToolReply> {
  return interferenceReply(await checkInterference(env, bodies, { clearance, ...(one === undefined ? {} : { one }) }), clearance);
}

/** An interference check's reply (clearance in mm, 0 for none). */
export function interferenceReply(r: InterferenceResult, clearance: number): ToolReply {
  const overlaps = r.rows.filter((x) => x.overlap !== null && !x.press);
  const press = r.rows.filter((x) => x.press);
  const gaps = r.rows.filter((x) => x.gap !== null);
  const { rows, more } = roundRows(r.rows, (x) => (x.overlap !== null ? { bodies: [x.a, x.b], overlap_mm3: sig6(x.overlap), ...(x.press ? { press_fit: true } : {}), at_mm: vec(x.at) } : { bodies: [x.a, x.b], gap_mm: len(x.gap ?? 0), at_mm: vec(x.at) }));
  const named = overlaps.slice(0, 3).map((x) => `${x.a} and ${x.b} ${sig6(x.overlap!)} mm3`);
  const head = overlaps.length ? `${word(overlaps.length, 'pair')} overlap${overlaps.length === 1 ? 's' : ''}` : 'no pair overlaps';
  const list = named.length ? `: ${named.join(', ')}${overlaps.length > 3 ? ', ...' : ''}` : '';
  const scope = r.one ? `${r.one} against ${word(r.pairs, 'other body', 'other bodies')}, ${r.boxPairs} near enough to measure` : `${word(r.bodies, 'body', 'bodies')}, ${r.boxPairs} of ${r.pairs} pairs near enough to measure`;
  const text = oneLine(`${r.complete ? '' : `${STOPPED}: `}${head}${press.length ? `, ${word(press.length, 'press fit')} (a bore round its shaft)` : ''}${clearance > 0 ? `, ${word(gaps.length, 'pair')} closer than ${len(clearance)} mm` : ''} (${scope}${r.complete ? '' : `, ${r.checked} measured`})${list}`, 200);
  return {
    text,
    data: {
      kind: 'interference',
      bodies: r.bodies,
      pairs: r.pairs,
      measured: r.checked,
      of: r.boxPairs,
      clearance_mm: len(clearance),
      ...(r.one ? { against: r.one } : {}),
      overlaps: overlaps.length,
      ...(press.length ? { press_fits: press.length } : {}),
      ...(clearance > 0 ? { closer: gaps.length } : {}),
      touching: r.touching,
      rows,
      ...(more ? { rows_more: more } : {}),
      ...(r.surfaces.length ? { surfaces: r.surfaces, surfaces_note: 'surface bodies have no volume to overlap: left out' } : {}),
      complete: r.complete,
      ...stopped(r.complete, `${r.checked} of ${r.boxPairs} pairs measured`, 'Check fewer bodies, or one body against the rest.'),
    },
    summary: oneLine(`Checked ${word(r.bodies, 'body', 'bodies')} for interference: ${head}${list}`, 160),
  };
}

const sideText = (s: StackSide | null): string | null => (s === null ? null : s.by === null ? `nothing${s.off ? ' (comes off its shaft)' : ''}` : `${s.by} at ${len(s.gap ?? 0)} mm`);

async function stack(env: CheckEnv, all: AssemblyBody[], only: number[] | null, play: number): Promise<ToolReply> {
  return stackReply(await checkStack(env, all, { play, ...(only ? { only } : {}) }), play);
}

/** A stack check's reply (play in mm). */
export function stackReply(r: StackResult, play: number): ToolReply {
  const axes = r.axes.map((a) => ({
    axis: a.words,
    point_mm: vec(a.line.point),
    dir: dir(a.line.dir),
    parts: a.parts.map((p) => {
      const row: Row = { body: p.body, from_mm: len(p.from), to_mm: len(p.to) };
      if (p.bore !== null) row.bore_r_mm = len(p.bore);
      if (p.on) {
        row[p.inBore ? 'in' : 'on'] = p.on;
        row.play_mm = len(p.play ?? 0);
      }
      if (p.fixed.length) row.fixed_to = p.fixed;
      const neg = sideText(p.neg);
      const pos = sideText(p.pos);
      if (neg !== null) row[a.negWords] = neg;
      if (pos !== null) row[a.posWords] = pos;
      return row;
    }),
  }));
  const { rows: axisRows, more: axesMore } = roundRows(axes, (x) => x);
  const loose = r.findings.map((f) => f.words);
  const { rows: looseRows, more: looseMore } = roundRows(loose, (x) => ({ words: x }));
  const sliding = [...new Set(r.findings.filter((f) => f.kind !== 'bore').map((f) => f.body))];
  const bores = [...new Set(r.findings.filter((f) => f.kind === 'bore').map((f) => f.body))];
  const sideOf = (body: string) =>
    r.findings
      .filter((f) => f.body === body && f.kind !== 'bore')
      .map((f) => {
        const a = r.axes[f.axis];
        return `${f.side === 'neg' ? a.negWords : a.posWords}${f.kind === 'slides' ? ` ${len(f.gap ?? 0)} mm` : ''}`;
      })
      .join(', ');
  const parts = r.axes.reduce((n, a) => n + a.parts.filter((p) => p.on).length, 0);
  const segs: string[] = [];
  if (sliding.length) segs.push(`${word(sliding.length, 'part')} can slide along ${sliding.length === 1 ? 'its shaft' : 'their shafts'}: ${sliding.map((b) => `${b} (${sideOf(b)})`).join(', ')}`);
  if (bores.length) segs.push(`nothing holds ${bores.join(', ')} radially`);
  const all = r.axes.length ? `Nothing is loose: ${word(parts, 'part')} on ${word(r.axes.length, 'axis', 'axes')}, each held both ways within ${len(play)} mm` : 'No two bodies share an axis (no round faces on one line)';
  // Stopped: what it checked, never an all-clear.
  const partial = `${STOPPED} after ${r.axes.length} of ${word(r.axesTotal, 'axis', 'axes')}: ${segs.length ? segs.join('; ') : r.axes.length ? `nothing loose on ${r.axes.length === 1 ? 'that one' : 'those'}` : 'none checked to the end'}`;
  const text = oneLine(!r.complete ? partial : segs.length ? segs.join('; ') : all, 200);
  return {
    text,
    data: {
      kind: 'stack',
      play_mm: len(play),
      axes: axisRows,
      ...(axesMore ? { axes_more: axesMore } : {}),
      loose: looseRows.map((x) => x.words),
      ...(looseMore ? { loose_more: looseMore } : {}),
      complete: r.complete,
      ...stopped(r.complete, `${r.axes.length} of ${word(r.axesTotal, 'axis', 'axes')} checked`, 'Check fewer bodies: only the axes near them are checked.'),
      ...(r.thinned ? { thinned_note: THINNED_NOTE } : {}),
    },
    summary: oneLine(`Checked the stack: ${text}`, 160),
  };
}

async function sweep(ctx: CallCtx, env: CheckEnv, all: AssemblyBody[], turning: number[], given: { line: AxisLine; words: string } | null): Promise<ToolReply> {
  let line = given?.line ?? null;
  let words = given?.words ?? '';
  if (!line) {
    const axes = (await sharedAxes(env, all)).filter((g) => turning.every((t) => g.members.includes(t)));
    const names = turning.map((t) => all[t].name).join(', ');
    if (!axes.length) throw new ToolError('bad_input', `axis: ${names} share${turning.length === 1 ? 's' : ''} no axis with another body (no round faces on one line). Give axis: an axis, "axis of <round face>" or an edge.`, { detail: { field: 'axis' } });
    if (axes.length > 1) {
      const list = axes.slice(0, 8).map((a) => `${sideWords(a.line, 1)} through (${vec(a.line.point).join(', ')}) with ${a.members.map((m) => all[m].name).join(', ')}`);
      throw new ToolError('bad_input', `axis: ${names} share${turning.length === 1 ? 's' : ''} ${axes.length} axes with other bodies: ${list.join('; ')}. Give axis.`, { detail: { field: 'axis' } });
    }
    line = axes[0].line;
    words = 'the axis they share';
  }
  ctx.checkAbort();
  return sweepReply(await checkSweep(env, all, turning, line), words);
}

/** A sweep's reply; `words`: how the axis was given ("" for the result's own words). */
export function sweepReply(r: SweepResult, words: string): ToolReply {
  const { rows, more } = roundRows(r.hits, (h) => ({
    turning: h.turning,
    hits: h.hits,
    first_deg: h.pos === null ? null : len(h.pos),
    back_deg: h.neg === null ? null : len(h.neg),
    at_mm: vec(h.at),
    ...(h.overlap !== null ? { overlap_mm3_1deg_past: sig6(h.overlap) } : {}),
  }));
  const first = r.hits[0];
  const turned = r.turning.join(', ');
  const hit = first ? `${first.turning} turned ${r.words} hits ${first.hits} at ${first.pos === null ? '-' : len(first.pos)} deg (${first.neg === null ? 'never' : `${len(first.neg)} deg`} the other way)${r.hits.length > 1 ? `; ${word(r.hits.length - 1, 'more hit')}` : ''}` : '';
  const already = r.already.length ? `; already overlapping: ${r.already.map((a) => a.with).join(', ')}` : '';
  // Stopped: the hits so far, never "without meeting anything".
  const text = oneLine(
    !r.complete
      ? `${STOPPED} before the whole turn was checked: ${first ? hit : `no hit found so far for ${turned} ${r.words}`}${already}`
      : first
        ? hit
        : `${turned} turn${r.turning.length === 1 ? 's' : ''} a full turn ${r.words} without meeting anything (${word(r.near, 'body', 'bodies')} near)${already}`,
    200,
  );
  return {
    text,
    data: {
      kind: 'sweep',
      axis: words || r.words,
      line: r.words,
      point_mm: vec(r.line.point),
      dir: dir(r.line.dir),
      turning: r.turning,
      hits: rows,
      ...(more ? { hits_more: more } : {}),
      ...(r.already.length ? { already: r.already.map((a) => [a.turning, a.with]), already_note: 'these share material before turning: check interference' } : {}),
      near: r.near,
      complete: r.complete,
      ...stopped(r.complete, `${word(r.hits.length, 'hit')} found so far`, 'Turn fewer bodies at once.'),
      ...(r.thinned ? { thinned_note: THINNED_NOTE } : {}),
    },
    summary: oneLine(`Checked turning ${turned}: ${!r.complete ? `stopped at the time limit, ${first ? `hits ${first.hits} so far` : 'no hit so far'}` : first ? `hits ${first.hits} at ${first.pos === null ? '-' : len(first.pos)} deg` : 'it meets nothing'}`, 160),
  };
}

/** What a call read: the model, the rebuild it checked and the kernel's worker. */
const stampOf = (ctx: CallCtx) => {
  const s = ctx.services.doc.state.get();
  return { doc: s.doc, seq: s.rebuild.seq, respawns: ctx.services.kernel.status.get().respawns };
};

async function checkOnce(ctx: CallCtx, input: Input): Promise<ToolReply> {
  const s = ctx.services.doc.state.get();
  const chosen = bodiesOf(s, input.bodies, input.kind);
  const env: CheckEnv = { kernel: ctx.services.kernel, signal: ctx.signal, progress: (f, label) => ctx.progress(f, label) };
  const all = s.rebuild.bodies.map(asBody);
  const indexOf = (b: BodyInfo) => s.rebuild.bodies.indexOf(b);
  try {
    // One body: it against every other body.
    if (input.kind === 'interference') return chosen.length === 1 ? await interference(env, all, lengthOf(ctx, input.clearance, 0), indexOf(chosen[0])) : await interference(env, chosen.map(asBody), lengthOf(ctx, input.clearance, 0));
    if (input.kind === 'stack') return await stack(env, all, input.bodies.length ? chosen.map(indexOf) : null, lengthOf(ctx, input.clearance, PLAY_MM));
    const given = await axisOf(ctx, s, input.axis);
    return await sweep(ctx, env, all, chosen.map(indexOf), given);
  } catch (e) {
    ctx.checkAbort();
    if (e instanceof CheckKernelError) throw new ToolError('kernel_failed', e.message, { detail: { op: e.op } });
    throw e;
  }
}

export const tool: ToolImpl = {
  kind: 'read',
  async run(ctx) {
    const input = inputOf(ctx);
    await waitForRead(ctx);
    const settle = () => heartbeat(ctx, ctx.services.doc.settled(ctx.signal), 'Waiting for the rebuild');
    for (let attempt = 0; ; attempt++) {
      await settle();
      if (attempt === 0) {
        await ctx.hold('after-settled');
        await settle();
      }
      ctx.checkAbort();
      const before = stampOf(ctx);
      const same = () => {
        const now = stampOf(ctx);
        return now.doc === before.doc && now.seq === before.seq && now.respawns === before.respawns;
      };
      try {
        const reply = await heartbeat(ctx, checkOnce(ctx, input), 'Checking');
        if (same()) return reply;
      } catch (e) {
        if (ctx.signal.aborted || same()) throw e;
      }
      if (attempt >= 1) throw new ToolError('changed', 'The Part changed again while it was being checked: nothing was checked.');
    }
  },
};
