// Unit-aware expressions: "20 mm", "width/2 + 3 mm", "sin(30 deg) * r", "2^3 in".
// Values carry dimensions (length and angle exponents) and are held in internal
// units (mm, deg). A unitless number next to a length or an angle (in +, -,
// min, max, or as the whole result of a length/angle field) takes the
// document's display unit, as in Fusion: "20" in an inch part is 20 in.
// Owner: DOC-CORE. Pure: no DOM, no kernel.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AngleUnit, DocUnits, EvalResult, LengthUnit, Quantity } from '../types/units';

export const MM_PER: Record<LengthUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
export const DEG_PER: Record<AngleUnit, number> = { deg: 1, rad: 180 / Math.PI };

/** Unit words an expression understands (lower case; "°" too). Parameters may not use these names. */
export const UNIT_NAMES = ['mm', 'cm', 'm', 'in', 'ft', 'deg', 'rad'] as const;
export const FUNCTION_NAMES = ['sin', 'cos', 'tan', 'sqrt', 'abs', 'min', 'max'] as const;
export const CONSTANT_NAMES = ['pi'] as const;

/** A value with dimensions: v in internal units, L = length exponent, A = angle exponent. */
export interface Qty {
  v: number;
  L: number;
  A: number;
}

const UNITS: Record<string, Qty> = {
  mm: { v: 1, L: 1, A: 0 },
  cm: { v: 10, L: 1, A: 0 },
  m: { v: 1000, L: 1, A: 0 },
  in: { v: 25.4, L: 1, A: 0 },
  ft: { v: 304.8, L: 1, A: 0 },
  deg: { v: 1, L: 0, A: 1 },
  rad: { v: 180 / Math.PI, L: 0, A: 1 },
  '°': { v: 1, L: 0, A: 1 },
};

export function isUnitName(s: string): boolean {
  return Object.prototype.hasOwnProperty.call(UNITS, s.toLowerCase());
}

/** Names a parameter may not take (units, functions, constants), compared without case. */
export function isReservedName(s: string): boolean {
  const l = s.toLowerCase();
  return isUnitName(l) || (FUNCTION_NAMES as readonly string[]).includes(l) || (CONSTANT_NAMES as readonly string[]).includes(l);
}

// ------------------------------------------------------------------ tokens

type Tok =
  | { t: 'num'; v: number; at: number; end: number }
  | { t: 'id'; s: string; at: number; end: number }
  | { t: 'op'; s: '+' | '-' | '*' | '/' | '^' | '(' | ')' | ','; at: number; end: number }
  | { t: 'deg'; at: number; end: number }
  | { t: 'end'; at: number; end: number };

export class ExprError extends Error {
  constructor(
    message: string,
    readonly at?: number,
  ) {
    super(message);
    this.name = 'ExprError';
  }
}

const NUM_RE = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/;
const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const rest = text.slice(i);
    const num = NUM_RE.exec(rest);
    if (num) {
      out.push({ t: 'num', v: Number(num[0]), at: i, end: i + num[0].length });
      i += num[0].length;
      continue;
    }
    const id = ID_RE.exec(rest);
    if (id) {
      out.push({ t: 'id', s: id[0], at: i, end: i + id[0].length });
      i += id[0].length;
      continue;
    }
    if (c === '°') {
      out.push({ t: 'deg', at: i, end: i + 1 });
      i++;
      continue;
    }
    if ('+-*/^(),'.includes(c)) {
      out.push({ t: 'op', s: c as '+', at: i, end: i + 1 });
      i++;
      continue;
    }
    throw new ExprError(`"${c}" is not allowed here`, i);
  }
  out.push({ t: 'end', at: text.length, end: text.length });
  return out;
}

// ------------------------------------------------------------------ syntax

export type Node =
  | { k: 'num'; v: number; at: number }
  | { k: 'ref'; name: string; at: number }
  | { k: 'call'; fn: string; args: Node[]; at: number }
  | { k: 'neg'; a: Node; at: number }
  | { k: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Node; b: Node; at: number }
  | { k: 'unit'; a: Node; unit: string; at: number };

export function parse(text: string): Node {
  if (!text.trim()) throw new ExprError('Enter a value', 0);
  const toks = tokenize(text);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (s: string) => {
    const t = toks[p];
    return t.t === 'op' && t.s === s;
  };

  function expect(s: string) {
    if (!isOp(s)) {
      const t = peek();
      throw new ExprError(t.t === 'end' ? `Missing "${s}"` : `Expected "${s}" before ${describe(t)}`, t.at);
    }
    p++;
  }

  function describe(t: Tok): string {
    if (t.t === 'end') return 'the end';
    if (t.t === 'num') return `"${text.slice(t.at, t.end)}"`;
    if (t.t === 'id') return `"${t.s}"`;
    if (t.t === 'deg') return '"°"';
    return `"${t.s}"`;
  }

  function add(): Node {
    let a = mul();
    while (isOp('+') || isOp('-')) {
      const t = toks[p++] as Extract<Tok, { t: 'op' }>;
      const b = mul();
      a = { k: 'bin', op: t.s as '+' | '-', a, b, at: t.at };
    }
    return a;
  }

  function mul(): Node {
    let a = unary();
    while (isOp('*') || isOp('/')) {
      const t = toks[p++] as Extract<Tok, { t: 'op' }>;
      const b = unary();
      a = { k: 'bin', op: t.s as '*' | '/', a, b, at: t.at };
    }
    return a;
  }

  function unary(): Node {
    if (isOp('-')) {
      const at = toks[p++].at;
      return { k: 'neg', a: unary(), at };
    }
    if (isOp('+')) {
      p++;
      return unary();
    }
    return power();
  }

  function power(): Node {
    const base = postfix();
    if (isOp('^')) {
      const at = toks[p++].at;
      return { k: 'bin', op: '^', a: base, b: unary(), at };
    }
    return base;
  }

  /** A unit written after a number, pi or a closing parenthesis: "20 mm", "(a + 2) in", "15°", "pi rad". */
  function postfix(): Node {
    const t = peek();
    const a = atom();
    const u = peek();
    const unitAllowed = t.t === 'num' || (t.t === 'op' && t.s === '(') || (a.k === 'ref' && a.name.toLowerCase() === 'pi');
    if (unitAllowed && u.t === 'deg') {
      p++;
      return { k: 'unit', a, unit: '°', at: u.at };
    }
    if (unitAllowed && u.t === 'id') {
      if (isUnitName(u.s)) {
        p++;
        return { k: 'unit', a, unit: u.s.toLowerCase(), at: u.at };
      }
      throw new ExprError(`"${u.s}" is not a unit (use * to multiply)`, u.at);
    }
    return a;
  }

  function atom(): Node {
    const t = peek();
    if (t.t === 'num') {
      p++;
      return { k: 'num', v: t.v, at: t.at };
    }
    if (t.t === 'id') {
      p++;
      if (isOp('(')) {
        p++;
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(add());
          while (isOp(',')) {
            p++;
            args.push(add());
          }
        }
        expect(')');
        return { k: 'call', fn: t.s, args, at: t.at };
      }
      return { k: 'ref', name: t.s, at: t.at };
    }
    if (t.t === 'op' && t.s === '(') {
      p++;
      const inner = add();
      expect(')');
      return inner;
    }
    if (t.t === 'end') throw new ExprError(`"${text.trim()}" is incomplete`, t.at);
    throw new ExprError(`Expected a number, a parameter or "(" before ${describe(t)}`, t.at);
  }

  const node = add();
  const t = peek();
  if (t.t !== 'end') {
    if (t.t === 'op' && t.s === ')') throw new ExprError('There is a ")" without a matching "("', t.at);
    throw new ExprError(`Expected an operator before ${describe(t)}`, t.at);
  }
  return node;
}

/** Parameter names an expression refers to (not functions, units or constants), in order, once each. */
export function referencedNames(node: Node): string[] {
  const out: string[] = [];
  const walk = (n: Node) => {
    switch (n.k) {
      case 'ref':
        if (!(CONSTANT_NAMES as readonly string[]).includes(n.name.toLowerCase()) && !out.includes(n.name)) out.push(n.name);
        break;
      case 'call':
        n.args.forEach(walk);
        break;
      case 'neg':
      case 'unit':
        walk(n.a);
        break;
      case 'bin':
        walk(n.a);
        walk(n.b);
        break;
    }
  };
  walk(node);
  return out;
}

/** The parameter names in `text` (empty when it does not parse). */
export function namesIn(text: string): string[] {
  try {
    return referencedNames(parse(text));
  } catch {
    return [];
  }
}

/**
 * Rename a parameter inside an expression, keeping everything else as typed.
 * Function names ("sin(") and units after numbers are never touched.
 */
export function renameInExpr(text: string, from: string, to: string): string {
  let toks: Tok[];
  try {
    toks = tokenize(text);
  } catch {
    return text;
  }
  let out = '';
  let last = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== 'id' || t.s !== from) continue;
    const next = toks[i + 1];
    const prev = toks[i - 1];
    if (next && next.t === 'op' && next.s === '(') continue; // a function call
    if (prev && (prev.t === 'num' || (prev.t === 'op' && prev.s === ')')) && isUnitName(t.s)) continue; // a unit
    out += text.slice(last, t.at) + to;
    last = t.end;
  }
  return out + text.slice(last);
}

// ------------------------------------------------------------------ values

export interface EvalScope {
  units: DocUnits;
  /**
   * A parameter's value by name: undefined when there is no such parameter.
   * Errors come back as text ("Circular reference: a → b → a").
   */
  param(name: string): { ok: true; q: Qty } | { ok: false; error: string } | undefined;
}

const isScalar = (q: Qty) => q.L === 0 && q.A === 0;
const isSimple = (q: Qty) => (q.L === 1 && q.A === 0) || (q.L === 0 && q.A === 1);
const sameDim = (a: Qty, b: Qty) => a.L === b.L && a.A === b.A;

export function dimName(q: { L: number; A: number }): string {
  const { L, A } = q;
  if (L === 0 && A === 0) return 'a number';
  if (A === 0 && L === 1) return 'a length';
  if (A === 0 && L === 2) return 'an area';
  if (A === 0 && L === 3) return 'a volume';
  if (L === 0 && A === 1) return 'an angle';
  const parts = [L ? `mm${L === 1 ? '' : `^${L}`}` : '', A ? `deg${A === 1 ? '' : `^${A}`}` : ''].filter(Boolean);
  return `a quantity in ${parts.join('·')}`;
}

/** A unitless number next to a length or an angle takes the document's display unit. */
function adapt(scalar: Qty, like: Qty, units: DocUnits): Qty {
  if (like.L === 1) return { v: scalar.v * MM_PER[units.length], L: 1, A: 0 };
  return { v: scalar.v * DEG_PER[units.angle], L: 0, A: 1 };
}

function unify(a: Qty, b: Qty, units: DocUnits, what: string, at: number): [Qty, Qty] {
  if (sameDim(a, b)) return [a, b];
  if (isScalar(a) && isSimple(b)) return [adapt(a, b, units), b];
  if (isScalar(b) && isSimple(a)) return [a, adapt(b, a, units)];
  throw new ExprError(`Cannot ${what} ${dimName(a)} and ${dimName(b)}`, at);
}

const INT_EPS = 1e-9;

function evalNode(n: Node, scope: EvalScope, uses: Set<string>): Qty {
  switch (n.k) {
    case 'num':
      return { v: n.v, L: 0, A: 0 };
    case 'unit': {
      const inner = evalNode(n.a, scope, uses);
      if (!isScalar(inner)) throw new ExprError(`A unit can follow only a plain number, not ${dimName(inner)}`, n.at);
      const u = UNITS[n.unit];
      return { v: inner.v * u.v, L: u.L, A: u.A };
    }
    case 'ref': {
      const lower = n.name.toLowerCase();
      if (lower === 'pi') return { v: Math.PI, L: 0, A: 0 };
      if ((FUNCTION_NAMES as readonly string[]).includes(lower)) throw new ExprError(`${lower} needs parentheses, as in ${lower}(30 deg)`, n.at);
      if (isUnitName(lower)) throw new ExprError(`"${n.name}" is a unit: write it after a number, as in 20 ${lower}`, n.at);
      const r = scope.param(n.name);
      if (!r) throw new ExprError(`Unknown parameter "${n.name}"`, n.at);
      uses.add(n.name);
      if (!r.ok) throw new ExprError(r.error.startsWith('Circular reference') || r.error.startsWith('Parameter "') ? r.error : `Parameter "${n.name}" has an error: ${r.error}`, n.at);
      return r.q;
    }
    case 'neg': {
      const a = evalNode(n.a, scope, uses);
      return { ...a, v: -a.v };
    }
    case 'bin': {
      const a = evalNode(n.a, scope, uses);
      const b = evalNode(n.b, scope, uses);
      switch (n.op) {
        case '+':
        case '-': {
          const [x, y] = unify(a, b, scope.units, n.op === '+' ? 'add' : 'subtract', n.at);
          return { v: n.op === '+' ? x.v + y.v : x.v - y.v, L: x.L, A: x.A };
        }
        case '*':
          return { v: a.v * b.v, L: a.L + b.L, A: a.A + b.A };
        case '/':
          if (b.v === 0) throw new ExprError('Division by zero', n.at);
          return { v: a.v / b.v, L: a.L - b.L, A: a.A - b.A };
        case '^': {
          if (!isScalar(b)) throw new ExprError(`The power must be a plain number, not ${dimName(b)}`, n.at);
          const L = a.L * b.v;
          const A = a.A * b.v;
          if (Math.abs(L - Math.round(L)) > INT_EPS || Math.abs(A - Math.round(A)) > INT_EPS)
            throw new ExprError(`Cannot raise ${dimName(a)} to the power ${b.v}`, n.at);
          return { v: Math.pow(a.v, b.v), L: Math.round(L), A: Math.round(A) };
        }
      }
      break;
    }
    case 'call':
      return evalCall(n, scope, uses);
  }
  throw new ExprError('Unsupported expression', 0);
}

function evalCall(n: Extract<Node, { k: 'call' }>, scope: EvalScope, uses: Set<string>): Qty {
  const fn = n.fn.toLowerCase();
  if (!(FUNCTION_NAMES as readonly string[]).includes(fn)) {
    if (scope.param(n.fn)) throw new ExprError(`"${n.fn}" is a parameter, not a function (use * to multiply)`, n.at);
    throw new ExprError(`Unknown function "${n.fn}"`, n.at);
  }
  const args = n.args.map((a) => evalNode(a, scope, uses));
  const one = () => {
    if (args.length !== 1) throw new ExprError(`${fn} takes one value`, n.at);
    return args[0];
  };
  switch (fn) {
    case 'sin':
    case 'cos':
    case 'tan': {
      const a = one();
      let deg: number;
      if (a.L === 0 && a.A === 1) deg = a.v;
      else if (isScalar(a)) deg = a.v * DEG_PER[scope.units.angle];
      else throw new ExprError(`${fn} takes an angle, not ${dimName(a)}`, n.at);
      const r = (deg * Math.PI) / 180;
      return { v: fn === 'sin' ? Math.sin(r) : fn === 'cos' ? Math.cos(r) : Math.tan(r), L: 0, A: 0 };
    }
    case 'sqrt': {
      const a = one();
      if (a.L % 2 !== 0 || a.A % 2 !== 0) throw new ExprError(`Cannot take the square root of ${dimName(a)}`, n.at);
      if (a.v < 0) throw new ExprError('Cannot take the square root of a negative number', n.at);
      return { v: Math.sqrt(a.v), L: a.L / 2, A: a.A / 2 };
    }
    case 'abs': {
      const a = one();
      return { ...a, v: Math.abs(a.v) };
    }
    case 'min':
    case 'max': {
      if (!args.length) throw new ExprError(`${fn} needs at least one value`, n.at);
      // Unitless values adapt to the first value with a length or angle.
      const like = args.find((a) => !isScalar(a));
      const vals = like ? args.map((a) => unify(a, like, scope.units, `compare`, n.at)[0]) : args;
      for (const v of vals) if (!sameDim(v, vals[0])) throw new ExprError(`Cannot compare ${dimName(vals[0])} and ${dimName(v)}`, n.at);
      const pick = fn === 'min' ? Math.min(...vals.map((v) => v.v)) : Math.max(...vals.map((v) => v.v));
      return { v: pick, L: vals[0].L, A: vals[0].A };
    }
  }
  throw new ExprError(`Unknown function "${n.fn}"`, n.at);
}

const QUANTITY_NAME: Record<Quantity, string> = { length: 'a length', angle: 'an angle', scalar: 'a number without units' };

/** A quantity's dimensions (what a parameter of that quantity is worth in other expressions). */
export function dimsOf(q: Quantity): { L: number; A: number } {
  return q === 'length' ? { L: 1, A: 0 } : q === 'angle' ? { L: 0, A: 1 } : { L: 0, A: 0 };
}

/** Coerce a computed value to what a field measures, in internal units (mm, deg, plain). */
export function coerce(q: Qty, quantity: Quantity, units: DocUnits): number {
  if (quantity === 'length') {
    if (q.L === 1 && q.A === 0) return q.v;
    if (isScalar(q)) return q.v * MM_PER[units.length];
  } else if (quantity === 'angle') {
    if (q.L === 0 && q.A === 1) return q.v;
    if (isScalar(q)) return q.v * DEG_PER[units.angle];
  } else if (isScalar(q)) {
    return q.v;
  }
  throw new ExprError(`Expected ${QUANTITY_NAME[quantity]}, got ${dimName(q)}`);
}

/** Evaluate `text` as `quantity` in a scope. Never throws. */
export function evaluateExpr(text: string, quantity: Quantity, scope: EvalScope): EvalResult {
  const uses = new Set<string>();
  try {
    const node = parse(String(text ?? ''));
    const q = evalNode(node, scope, uses);
    const value = coerce(q, quantity, scope.units);
    if (!Number.isFinite(value)) return { ok: false, error: 'The result is not a finite number' };
    return { ok: true, value, quantity, uses: [...uses] };
  } catch (e) {
    if (e instanceof ExprError) return e.at === undefined ? { ok: false, error: e.message } : { ok: false, error: e.message, at: e.at };
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
}
