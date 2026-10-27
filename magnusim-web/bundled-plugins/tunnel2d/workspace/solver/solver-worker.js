function Zn(r) {
  const m = [];
  return r.knots.forEach((h, g) => {
    for (let k = 0; k < r.mults[g]; k++) m.push(h);
  }), m;
}
function nt(r) {
  const m = [], h = [];
  for (const g of r)
    m.length && Math.abs(g - m[m.length - 1]) < 1e-14 ? h[h.length - 1]++ : (m.push(g), h.push(1));
  return { knots: m, mults: h };
}
function Tn(r, m, h, g) {
  if (h >= g[r + 1]) return r;
  if (h <= g[m]) return m;
  let k = m, M = r + 1, O = k + M >> 1;
  for (; h < g[O] || h >= g[O + 1]; )
    h < g[O] ? M = O : k = O, O = k + M >> 1;
  return O;
}
function Cn(r, m, h, g, k) {
  const M = Array.from({ length: h + 1 }, () => new Array(h + 1).fill(0)), O = new Array(h + 1).fill(0), x = new Array(h + 1).fill(0);
  M[0][0] = 1;
  for (let y = 1; y <= h; y++) {
    O[y] = m - k[r + 1 - y], x[y] = k[r + y] - m;
    let b = 0;
    for (let P = 0; P < y; P++) {
      M[y][P] = x[P + 1] + O[y - P];
      const D = M[P][y - 1] / M[y][P];
      M[P][y] = b + x[P + 1] * D, b = O[y - P] * D;
    }
    M[y][y] = b;
  }
  const G = Array.from({ length: g + 1 }, () => new Array(h + 1).fill(0));
  for (let y = 0; y <= h; y++) G[0][y] = M[y][h];
  const z = [new Array(h + 1).fill(0), new Array(h + 1).fill(0)];
  for (let y = 0; y <= h; y++) {
    let b = 0, P = 1;
    z[0][0] = 1;
    for (let D = 1; D <= g; D++) {
      let Q = 0;
      const N = y - D, V = h - D;
      y >= D && (z[P][0] = z[b][0] / M[V + 1][N], Q = z[P][0] * M[N][V]);
      const cn = N >= -1 ? 1 : -N, nn = y - 1 <= V ? D - 1 : h - y;
      for (let S = cn; S <= nn; S++)
        z[P][S] = (z[b][S] - z[b][S - 1]) / M[V + 1][N + S], Q += z[P][S] * M[N + S][V];
      y <= V && (z[P][D] = -z[b][D - 1] / M[V + 1][y], Q += z[P][D] * M[y][V]), G[D][y] = Q;
      const ln = b;
      b = P, P = ln;
    }
  }
  let e = h;
  for (let y = 1; y <= g; y++) {
    for (let b = 0; b <= h; b++) G[y][b] *= e;
    e *= h - y;
  }
  return G;
}
function Fn(r) {
  return [r.knots[0], r.knots[r.knots.length - 1]];
}
function tt(r, m, h = 1) {
  const g = Zn(r), k = r.poles.length - 1, M = r.degree, [O, x] = Fn(r), G = Math.min(x, Math.max(O, m)), z = Tn(k, M, G, g), e = Cn(z, G, M, Math.min(h, M), g), y = [];
  for (let b = 0; b <= h; b++) {
    if (b > M) {
      y.push([0, 0]);
      continue;
    }
    let P = 0, D = 0;
    for (let Q = 0; Q <= M; Q++) {
      const N = r.poles[z - M + Q];
      P += e[b][Q] * N[0], D += e[b][Q] * N[1];
    }
    y.push([P, D]);
  }
  return y;
}
function In(r, m) {
  return tt(r, m, 0)[0];
}
function Pt(r, m) {
  const h = r.length, g = r.map((k, M) => [...k, m[M][0], m[M][1]]);
  for (let k = 0; k < h; k++) {
    let M = k;
    for (let O = k + 1; O < h; O++) Math.abs(g[O][k]) > Math.abs(g[M][k]) && (M = O);
    if (Math.abs(g[M][k]) < 1e-14) throw new Error("the spline points do not give a curve (two points in one place?)");
    [g[k], g[M]] = [g[M], g[k]];
    for (let O = 0; O < h; O++) {
      if (O === k) continue;
      const x = g[O][k] / g[k][k];
      if (x)
        for (let G = k; G <= h + 1; G++) g[O][G] -= x * g[k][G];
    }
  }
  return g.map((k, M) => [k[h] / g[M][M], k[h + 1] / g[M][M]]);
}
function et(r, m, h) {
  const g = r.length - m - 1;
  if (h.length !== g) throw new Error("spline interpolation: rows and poles differ");
  const k = g - 1, M = (x, G, z, e) => {
    const y = Tn(k, m, x, r), b = Cn(y, x, m, G, r);
    for (let P = 0; P <= m; P++) e[y - m + P] += z * b[G][P];
  }, O = h.map((x) => {
    const G = new Array(g).fill(0);
    return M(x.u, x.order, 1, G), x.minus && M(x.minus.u, x.minus.order, -1, G), G;
  });
  return Pt(O, h.map((x) => x.rhs));
}
function st(r, m = !1, h) {
  const g = m ? [...r, r[0]] : [...r], k = [0], M = g.length - 1;
  for (let x = 1; x < g.length; x++) {
    let G = Math.hypot(g[x][0] - g[x - 1][0], g[x][1] - g[x - 1][1]);
    h && !m && (x === 1 && (G *= h[0]), x === M && M > 1 && (G *= h[1])), k.push(k[x - 1] + G);
  }
  const O = k[k.length - 1];
  if (!(O > 0)) throw new Error("the spline points are all in one place");
  return k.map((x) => x / O);
}
function ot(r, m = {}) {
  const h = !!m.closed && r.length >= 3;
  if (r.length < 2) throw new Error("a spline needs two points or more");
  const g = h ? [...r, r[0]] : [...r], k = m.params ?? st(r, h, m.spans);
  for (let b = 1; b < k.length; b++) if (!(k[b] - k[b - 1] > 1e-12)) throw new Error("two spline points in one place");
  const M = 3, x = [0, 0, 0, 0, ...k.slice(1, -1), 1, 1, 1, 1], G = g.map((b, P) => ({ u: k[P], order: 0, rhs: b })), z = k[1] - k[0], e = k[k.length - 1] - k[k.length - 2];
  if (h)
    G.push({ u: 0, order: 1, rhs: [0, 0], minus: { u: 1, order: 1 } }), G.push({ u: 0, order: 2, rhs: [0, 0], minus: { u: 1, order: 2 } });
  else {
    const [b, P] = m.handles ?? [null, null];
    G.push(b ? { u: 0, order: 1, rhs: [3 * (b[0] - g[0][0]) / z, 3 * (b[1] - g[0][1]) / z] } : { u: 0, order: 2, rhs: [0, 0] });
    const D = g[g.length - 1];
    G.push(P ? { u: 1, order: 1, rhs: [3 * (D[0] - P[0]) / e, 3 * (D[1] - P[1]) / e] } : { u: 1, order: 2, rhs: [0, 0] });
  }
  const y = et(x, M, G);
  return y[0] = [g[0][0], g[0][1]], y[y.length - 1] = h ? [g[0][0], g[0][1]] : [g[g.length - 1][0], g[g.length - 1][1]], { degree: M, poles: y, ...nt(x) };
}
function xt(r, m) {
  const h = r.length;
  if (h < m + 1) throw new Error(`a degree ${m} spline needs ${m + 1} control points or more`);
  const g = h - m, k = Array.from({ length: g + 1 }, (O, x) => x / g), M = k.map((O, x) => x === 0 || x === g ? m + 1 : 1);
  return { degree: m, poles: r.map((O) => [O[0], O[1]]), knots: k, mults: M };
}
function $t(r, m) {
  const h = r.length;
  if (h < m + 1) throw new Error(`a closed degree ${m} spline needs ${m + 1} control points or more`);
  const g = [...r, ...r.slice(0, m)].map((y) => [y[0], y[1]]), k = Array.from({ length: g.length + m + 1 }, (y, b) => b), M = (y, b) => {
    const P = Tn(g.length - 1, m, y, k), D = Cn(P, y, m, b, k);
    let Q = 0, N = 0;
    for (let V = 0; V <= m; V++)
      Q += D[b][V] * g[P - m + V][0], N += D[b][V] * g[P - m + V][1];
    return [Q, N];
  }, O = Array.from({ length: h - 1 }, (y, b) => (b + 1) / h), x = [...new Array(m + 1).fill(0), ...O, ...new Array(m + 1).fill(1)], G = x.length - m - 1, z = [];
  for (let y = 0; y < G; y++) {
    let b = 0;
    for (let P = 1; P <= m; P++) b += x[y + P];
    b /= m, z.push({ u: b, order: 0, rhs: M(m + b * h, 0) });
  }
  const e = et(x, m, z);
  return e[e.length - 1] = [e[0][0], e[0][1]], { degree: m, poles: e, ...nt(x) };
}
function it(r) {
  if (r.form === "fit") return ot(r.pts, { closed: r.closed, handles: r.handles, spans: r.spans });
  if (r.knots && r.mults) {
    if (r.mults.reduce((h, g) => h + g, 0) !== r.pts.length + r.degree + 1) throw new Error("the spline knots do not fit its control points");
    return { degree: r.degree, poles: r.pts.map((h) => [h[0], h[1]]), knots: [...r.knots], mults: [...r.mults] };
  }
  return r.closed ? $t(r.pts, r.degree) : xt(r.pts, r.degree);
}
function At(r) {
  const m = (r.handles ?? [null, null]).filter((G) => !!G), h = [...r.pts, ...m], g = r.form === "fit" ? st(r.pts, !!r.closed && r.pts.length >= 3, r.spans) : void 0, k = (G) => {
    const z = G.slice(0, r.pts.length);
    let e = r.pts.length;
    const y = [r.handles?.[0] ? G[e++] : null, r.handles?.[1] ? G[e++] : null];
    return r.form === "fit" ? ot(z, { closed: r.closed, handles: y, params: g }) : it({ ...r, pts: z });
  }, M = k(h), O = k(h.map(() => [0, 0])), x = M.poles.map(() => new Array(h.length).fill(0));
  return h.forEach((G, z) => {
    k(h.map((y, b) => b === z ? [1, 0] : [0, 0])).poles.forEach((y, b) => x[b][z] = y[0] - O.poles[b][0]);
  }), { curve: M, W: x, flat: Zn(M) };
}
function Gt(r, m = 16) {
  const h = [];
  for (let k = 0; k < r.knots.length - 1; k++) {
    const M = r.knots[k], O = r.knots[k + 1];
    for (let x = 0; x < m; x++) {
      const G = M + (O - M) * x / m;
      h.push({ u: G, p: In(r, G) });
    }
  }
  const [, g] = Fn(r);
  return h.push({ u: g, p: In(r, g) }), h;
}
function Jn(r, m) {
  const h = Gt(r, 24);
  let g = 0, k = 1 / 0;
  h.forEach((e, y) => {
    const b = Math.hypot(e.p[0] - m[0], e.p[1] - m[1]);
    b < k && (k = b, g = y);
  });
  const [M, O] = Fn(r);
  let x = h[g].u;
  for (let e = 0; e < 20; e++) {
    const [y, b, P] = tt(r, x, 2), D = [y[0] - m[0], y[1] - m[1]], Q = D[0] * b[0] + D[1] * b[1], N = b[0] * b[0] + b[1] * b[1] + D[0] * P[0] + D[1] * P[1];
    if (!(Math.abs(N) > 1e-300)) break;
    const V = Math.min(O, Math.max(M, x - Q / N));
    if (Math.abs(V - x) < 1e-14) {
      x = V;
      break;
    }
    x = V;
  }
  const G = In(r, x), z = Math.hypot(G[0] - m[0], G[1] - m[1]);
  return z <= k ? { u: x, p: G, d: z } : { u: h[g].u, p: h[g].p, d: k };
}
const U = { BFGS: 0, LM: 1, DOGLEG: 2 }, jn = { Success: 0, Converged: 1, Failed: 2 }, an = -1, un = 0, Pn = Math.PI / 180, bn = /* @__PURE__ */ new Set(["ellipse", "ellipse_arc", "parabola", "conic"]);
class F extends Error {
}
function vn(r) {
  const m = new Array(r.size());
  for (let h = 0; h < m.length; h++) m[h] = r.get(h);
  return r.delete(), m;
}
function Dn(r) {
  for (; r <= -Math.PI; ) r += 2 * Math.PI;
  for (; r > Math.PI; ) r -= 2 * Math.PI;
  return r;
}
async function rt({ moduleUrl: r, wasmUrl: m, moduleFactory: h, dlGaussStep: g = 3, sparseSqpMinParams: k = 64 } = {}) {
  let M = h;
  if (!M) {
    const t = "planegcs.mjs";
    M = (await import(r ?? new URL(t, import.meta.url).href)).default;
  }
  const O = {};
  m && (O.locateFile = (t) => t.endsWith(".wasm") ? m : t);
  const x = performance.now(), G = await M(O), z = performance.now() - x, e = new G.GcsSystem();
  typeof e.set_dl_gauss_step == "function" && e.set_dl_gauss_step(g), typeof e.set_sparse_sqp_min_params == "function" && e.set_sparse_sqp_min_params(k);
  let y = null, b = /* @__PURE__ */ new Map(), P = /* @__PURE__ */ new Map(), D = /* @__PURE__ */ new Map(), Q = /* @__PURE__ */ new Map(), N = [], V = [], cn = 0, nn = null, ln = null, S = null, fn = null, X = [], dn = 0, mn = -1;
  const Vn = () => G.HEAPF64;
  function Y() {
    const t = e.params_to_buffer();
    return Vn().slice(t >>> 3, (t >>> 3) + cn);
  }
  function sn(t, c = 0) {
    const l = e.input_buffer(t.length);
    Vn().set(t, l >>> 3), e.params_from_buffer(c, t.length);
  }
  function C(t, c, l, _) {
    const n = e.push_p_param(t, c);
    return N[n] = { owner: l, name: _, fixed: c }, cn = n + 1, n;
  }
  function v(t, c) {
    const l = [];
    try {
      for (const _ of t) l.push(_());
      return c(...l);
    } finally {
      for (const _ of l) _.delete();
    }
  }
  const $ = (t) => () => e.make_point(t[0], t[1]), j = (t) => () => e.make_line(t.p1[0], t.p1[1], t.p2[0], t.p2[1]), R = (t) => () => e.make_circle(t.c[0], t.c[1], t.r), J = (t) => () => e.make_arc(t.c[0], t.c[1], t.s[0], t.s[1], t.e[0], t.e[1], t.a0, t.a1, t.r), En = (t) => () => e.make_ellipse(t.c[0], t.c[1], t.f[0], t.f[1], t.rmin), qn = (t) => () => e.make_arc_of_ellipse(t.c[0], t.c[1], t.f[0], t.f[1], t.s[0], t.s[1], t.e[0], t.e[1], t.a0, t.a1, t.rmin), $n = (t) => () => e.make_arc_of_parabola(t.v[0], t.v[1], t.f[0], t.f[1], t.s[0], t.s[1], t.e[0], t.e[1], t.a0, t.a1), Rn = (t) => t.kind === "line" ? j(t) : t.kind === "arc" ? J(t) : t.kind === "ellipse" ? En(t) : t.kind === "ellipse_arc" ? qn(t) : t.kind === "parabola" ? $n(t) : R(t);
  function Bn(t) {
    return t.kind === "line" ? t.pts : t.kind === "arc" ? [t.pts[1], t.pts[2]] : t.kind === "spline" ? t.closed ? [] : [t.fitPts[0], t.fitPts[t.fitPts.length - 1]] : t.kind === "ellipse_arc" || t.kind === "parabola" || t.kind === "conic" ? t.ends : [];
  }
  function ft(t, c) {
    return { kind: "line", p1: b.get(c), p2: t.t };
  }
  function dt(t, c, l) {
    const _ = t.fitPts.length, n = t.fitPts[0] === c;
    let s;
    if (t.form === "control" ? s = n ? t.fitPts[1] : t.fitPts[_ - 2] : s = n ? t.handleIds[0] : t.handleIds[1], !s) throw new F(`constraint ${l}: a fit spline is tangent at an end only through a tangent handle there`);
    return { kind: "line", p1: b.get(c), p2: b.get(s) };
  }
  function ut(t, c) {
    const l = Bn(P.get(t)), _ = new Set(Bn(P.get(c)));
    return l.find((n) => _.has(n)) ?? null;
  }
  function Qn(t, c, l) {
    if (t.kind === "line") return [-(l[t.p2[1]] - l[t.p1[1]]), l[t.p2[0]] - l[t.p1[0]]];
    const _ = [l[c[0]], l[c[1]]];
    if (t.kind === "ellipse" || t.kind === "ellipse_arc") {
      const n = [l[t.c[0]], l[t.c[1]]], s = [l[t.f[0]], l[t.f[1]]], w = l[t.rmin], o = Math.hypot(s[0] - n[0], s[1] - n[1]), p = Math.hypot(o, w), E = o > 0 ? [(s[0] - n[0]) / o, (s[1] - n[1]) / o] : [1, 0], A = [-E[1], E[0]], d = [_[0] - n[0], _[1] - n[1]], a = (d[0] * E[0] + d[1] * E[1]) / (p * p), i = (d[0] * A[0] + d[1] * A[1]) / (w * w);
      return [-(a * E[0] + i * A[0]), -(a * E[1] + i * A[1])];
    }
    if (t.kind === "parabola") {
      const n = [l[t.v[0]], l[t.v[1]]], s = [l[t.f[0]], l[t.f[1]]], w = Math.hypot(s[0] - n[0], s[1] - n[1]) || 1, o = [(s[0] - n[0]) / w, (s[1] - n[1]) / w], p = [-o[1], o[0]], E = (_[0] - n[0]) * p[0] + (_[1] - n[1]) * p[1];
      return [-4 * w * o[0] + 2 * E * p[0], -4 * w * o[1] + 2 * E * p[1]];
    }
    return [l[t.c[0]] - l[c[0]], l[t.c[1]] - l[c[1]]];
  }
  function Wn(t) {
    if (b.has(t)) return "point";
    const c = P.get(t);
    return c ? c.kind === "point" ? "point" : c.kind : null;
  }
  function gn(t) {
    if (b.has(t)) return b.get(t);
    const c = P.get(t);
    return c && c.kind === "point" ? c.p : null;
  }
  function pt(t, c) {
    const l = (w) => {
      const o = gn(w);
      return [c[o[0]], c[o[1]]];
    }, _ = t.refs.map(Wn), n = (w) => {
      const o = P.get(w);
      return [[c[o.p1[0]], c[o.p1[1]]], [c[o.p2[0]], c[o.p2[1]]]];
    }, s = (w, o) => Math.hypot(o[0] - w[0], o[1] - w[1]);
    switch (t.kind) {
      case "distance":
        return _.length === 1 && _[0] === "line" ? s(...n(t.refs[0])) : _[0] === "point" && _[1] === "point" ? s(l(t.refs[0]), l(t.refs[1])) : null;
      case "distance_x":
      case "distance_y": {
        const w = t.kind === "distance_x" ? 0 : 1;
        if (_.length === 1 && _[0] === "line") {
          const [o, p] = n(t.refs[0]);
          return p[w] - o[w];
        }
        return _.length === 1 ? l(t.refs[0])[w] : l(t.refs[1])[w] - l(t.refs[0])[w];
      }
      case "radius":
      case "diameter": {
        const w = P.get(t.refs[0]), o = c[w.r];
        return t.kind === "radius" ? o : 2 * o;
      }
      case "angle": {
        const w = (o) => {
          const [p, E] = n(o);
          return Math.atan2(E[1] - p[1], E[0] - p[0]);
        };
        return _.length === 1 ? Dn(w(t.refs[0])) / Pn : Dn(w(t.refs[1]) - w(t.refs[0])) / Pn;
      }
      default:
        return null;
    }
  }
  function Kn(t, c, l, _) {
    if (typeof e.add_constraint_point_on_affine_spline != "function") throw new F(`constraint ${_}: this solver build cannot hold a point on a spline`);
    const n = Y(), s = (u) => {
      const L = b.get(u);
      return [n[L[0]], n[L[1]]];
    }, w = c.handleIds.map((u) => u ? s(u) : null), o = { form: c.form, degree: c.raw.degree, pts: c.fitPts.map(s), closed: c.closed, handles: w, knots: c.raw.knots, mults: c.raw.mults, spans: c.raw.spans };
    let p;
    try {
      p = At(o);
    } catch (u) {
      throw new F(`constraint ${_}: ${u instanceof Error ? u.message : String(u)}`);
    }
    const E = [...c.fitPts, ...c.handleIds.filter((u) => u)], A = Jn(p.curve, [n[t[0]], n[t[1]]]).u, d = C(A, !1, _, "u"), a = p.W.length, i = new G.DoubleVector();
    for (const u of p.W) for (const L of u) i.push_back(L);
    const f = new G.DoubleVector();
    for (const u of p.flat) f.push_back(u);
    try {
      for (const u of [0, 1]) {
        const L = new G.IntVector();
        for (const T of E) L.push_back(b.get(T)[u]);
        try {
          e.add_constraint_point_on_affine_spline(t[u], d, L, i, a, f, p.curve.degree, l, !0);
        } finally {
          L.delete();
        }
      }
    } finally {
      i.delete(), f.delete();
    }
    c.form === "fit" && V.push({ p: t, entity: c });
  }
  function Un(t, c, l, _, n) {
    if (t === "point,ellipse" || t === "point,ellipse_arc") v([$(c), En(l)], (s, w) => e.add_constraint_point_on_ellipse(s, w, _, !0, 1));
    else if (t === "point,parabola") v([$(c), $n(l)], (s, w) => e.add_constraint_point_on_parabolic_arc(s, w, _, !0, 1));
    else {
      if (t === "point,conic") throw new F(`constraint ${n}: a point lies on a conic only at its ends`);
      return !1;
    }
    return !0;
  }
  function _t(t, c) {
    const l = t.id, _ = t.refs ?? [], n = _.map((a) => {
      const i = Wn(a);
      if (!i) throw new F(`constraint ${l}: reference "${a}" not found`);
      return i;
    }), s = n.join(","), w = { tag: c, kind: t.kind, refs: _, valueParams: [], driving: !0 }, o = (a) => P.get(_[a]), p = (a) => gn(_[a]), E = (a, i = t.value) => {
      if (typeof i != "number" || !Number.isFinite(i))
        throw new F(`constraint ${l}: numeric value required`);
      const f = C(a === "deg" ? i * Pn : i, !0, l, "value");
      return w.valueParams.push({ idx: f, unit: a }), f;
    }, A = () => {
      throw new F(`constraint ${l}: kind "${t.kind}" does not accept refs (${s})`);
    }, d = c;
    switch (t.kind) {
      case "coincident":
        if (s === "point,spline") Kn(p(0), o(1), d, l);
        else if (s === "point,point") v([$(p(0)), $(p(1))], (a, i) => e.add_constraint_p2p_coincident(a, i, d, !0, 1));
        else if (s === "point,line") v([$(p(0)), j(o(1))], (a, i) => e.add_constraint_point_on_line_pl(a, i, d, !0, 1));
        else if (s === "point,circle" || s === "point,arc") v([$(p(0)), R(o(1))], (a, i) => e.add_constraint_point_on_circle(a, i, d, !0, 1));
        else {
          if (Un(s, p(0), o(1), d, l)) break;
          A();
        }
        break;
      case "horizontal":
      case "vertical": {
        const a = t.kind;
        s === "line" ? v([j(o(0))], (i) => e[`add_constraint_${a}_l`](i, d, !0, 1)) : s === "ellipse" || s === "ellipse_arc" ? v([$(o(0).c), $(o(0).maj)], (i, f) => e[`add_constraint_${a}_pp`](i, f, d, !0, 1)) : s === "parabola" ? v([$(o(0).v), $(o(0).f)], (i, f) => e[`add_constraint_${a}_pp`](i, f, d, !0, 1)) : s === "point,point" ? v([$(p(0)), $(p(1))], (i, f) => e[`add_constraint_${a}_pp`](i, f, d, !0, 1)) : A();
        break;
      }
      case "parallel":
        s === "line,line" ? v([j(o(0)), j(o(1))], (a, i) => e.add_constraint_parallel(a, i, d, !0, 1)) : A();
        break;
      case "perpendicular":
        s === "line,line" ? v([j(o(0)), j(o(1))], (a, i) => e.add_constraint_perpendicular_ll(a, i, d, !0, 1)) : A();
        break;
      case "tangent": {
        const a = (f) => f === "line" || f === "arc" || f === "circle" || f === "spline" || bn.has(f);
        let i = null;
        if (_.length === 3 && a(n[0]) && a(n[1]) && n[2] === "point" ? i = _[2] : _.length === 2 && a(n[0]) && a(n[1]) && (i = ut(_[0], _[1])), (n[0] === "spline" || n[1] === "spline") && !i) throw new F(`constraint ${l}: a spline is tangent only at an end it shares`);
        if ((n[0] === "conic" || n[1] === "conic") && !i) throw new F(`constraint ${l}: a conic is tangent only at an end it shares`);
        if (!i && (bn.has(n[0]) || bn.has(n[1]))) {
          const f = n[0] === "line" ? 0 : n[1] === "line" ? 1 : -1, u = 1 - f;
          if (f < 0 || n[u] !== "ellipse" && n[u] !== "ellipse_arc") throw new F(`constraint ${l}: an ellipse is tangent to a line anywhere; a parabola or a conic is tangent only at an end it shares`);
          v([j(o(f)), En(o(u))], (L, T) => e.add_constraint_tangent_le(L, T, d, !0, 1));
          break;
        }
        if (i) {
          const f = (K, W) => K === "spline" ? dt(W, i, l) : K === "conic" ? ft(W, i) : W, u = f(n[0], o(0)), L = f(n[1], o(1)), T = gn(i), B = Y(), q = Qn(u, T, B), I = Qn(L, T, B), tn = Math.atan2(-I[0] * q[1] + I[1] * q[0], I[0] * q[0] + I[1] * q[1]), en = Math.abs(Dn(tn)) > Math.PI / 2 ? Math.PI : 0, H = C(en, !0, l, "angle");
          w.valueParams.push({ idx: H, unit: "internal" }), v([Rn(u), Rn(L), $(T)], (K, W, Z) => e.add_constraint_angle_via_point(K, W, Z, H, d, !0, 1));
          break;
        }
        s === "line,circle" ? v([j(o(0)), R(o(1))], (f, u) => e.add_constraint_tangent_lc(f, u, d, !0, 1)) : s === "circle,line" ? v([j(o(1)), R(o(0))], (f, u) => e.add_constraint_tangent_lc(f, u, d, !0, 1)) : s === "line,arc" ? v([j(o(0)), J(o(1))], (f, u) => e.add_constraint_tangent_la(f, u, d, !0, 1)) : s === "arc,line" ? v([j(o(1)), J(o(0))], (f, u) => e.add_constraint_tangent_la(f, u, d, !0, 1)) : s === "circle,circle" ? v([R(o(0)), R(o(1))], (f, u) => e.add_constraint_tangent_cc(f, u, d, !0, 1)) : s === "arc,arc" ? v([J(o(0)), J(o(1))], (f, u) => e.add_constraint_tangent_aa(f, u, d, !0, 1)) : s === "circle,arc" ? v([R(o(0)), J(o(1))], (f, u) => e.add_constraint_tangent_ca(f, u, d, !0, 1)) : s === "arc,circle" ? v([R(o(1)), J(o(0))], (f, u) => e.add_constraint_tangent_ca(f, u, d, !0, 1)) : A();
        break;
      }
      case "equal":
        if (s === "line,line") v([j(o(0)), j(o(1))], (a, i) => e.add_constraint_equal_length(a, i, d, !0, 1));
        else if (s === "circle,circle") v([R(o(0)), R(o(1))], (a, i) => e.add_constraint_equal_radius_cc(a, i, d, !0, 1));
        else if (s === "circle,arc") v([R(o(0)), J(o(1))], (a, i) => e.add_constraint_equal_radius_ca(a, i, d, !0, 1));
        else if (s === "arc,circle") v([R(o(1)), J(o(0))], (a, i) => e.add_constraint_equal_radius_ca(a, i, d, !0, 1));
        else if (s === "arc,arc") v([J(o(0)), J(o(1))], (a, i) => e.add_constraint_equal_radius_aa(a, i, d, !0, 1));
        else if ((n[0] === "ellipse" || n[0] === "ellipse_arc") && (n[1] === "ellipse" || n[1] === "ellipse_arc")) {
          const a = o(0), i = o(1);
          v([j({ p1: a.c, p2: a.maj }), j({ p1: i.c, p2: i.maj })], (f, u) => e.add_constraint_equal_length(f, u, d, !0, 1)), v([j({ p1: a.c, p2: a.mnr }), j({ p1: i.c, p2: i.mnr })], (f, u) => e.add_constraint_equal_length(f, u, d, !0, 1));
        } else s === "parabola,parabola" ? v([j({ p1: o(0).v, p2: o(0).f }), j({ p1: o(1).v, p2: o(1).f })], (a, i) => e.add_constraint_equal_length(a, i, d, !0, 1)) : A();
        break;
      case "distance": {
        const a = () => E("mm");
        if (s === "line") {
          const i = o(0), f = a();
          v([$(i.p1), $(i.p2)], (u, L) => e.add_constraint_p2p_distance(u, L, f, d, !0, 1));
        } else if (s === "point,point") {
          const i = a();
          v([$(p(0)), $(p(1))], (f, u) => e.add_constraint_p2p_distance(f, u, i, d, !0, 1));
        } else if (s === "point,line") {
          const i = a();
          v([$(p(0)), j(o(1))], (f, u) => e.add_constraint_p2l_distance(f, u, i, d, !0, 1));
        } else if (s === "line,point") {
          const i = a();
          v([$(p(1)), j(o(0))], (f, u) => e.add_constraint_p2l_distance(f, u, i, d, !0, 1));
        } else if (s === "line,line") {
          const i = a();
          v([$(o(0).p1), j(o(1))], (f, u) => e.add_constraint_p2l_distance(f, u, i, d, !0, 1));
        } else if (s === "point,circle" || s === "point,arc") {
          const i = a();
          v([$(p(0)), R(o(1))], (f, u) => e.add_constraint_p2cdistance(f, u, i, d, !0, 1));
        } else if (s === "circle,circle") {
          const i = a();
          v([R(o(0)), R(o(1))], (f, u) => e.add_constraint_c2cdistance(f, u, i, d, !0, 1));
        } else if (s === "circle,line") {
          const i = a();
          v([R(o(0)), j(o(1))], (f, u) => e.add_constraint_c2ldistance(f, u, i, d, !0, 1));
        } else if (s === "line,circle") {
          const i = a();
          v([R(o(1)), j(o(0))], (f, u) => e.add_constraint_c2ldistance(f, u, i, d, !0, 1));
        } else A();
        break;
      }
      case "distance_x":
      case "distance_y": {
        const a = t.kind === "distance_x" ? 0 : 1;
        let i, f;
        if (s === "line")
          i = o(0).p1, f = o(0).p2;
        else if (s === "point,point")
          i = p(0), f = p(1);
        else if (s === "point") {
          const L = E("mm");
          v([$(p(0))], (T) => e[a === 0 ? "add_constraint_coordinate_x" : "add_constraint_coordinate_y"](T, L, d, !0, 1));
          break;
        } else A();
        const u = E("mm");
        e.add_constraint_difference(i[a], f[a], u, d, !0, 1);
        break;
      }
      case "radius":
      case "diameter": {
        const a = t.kind, i = E("mm");
        s === "circle" ? v([R(o(0))], (f) => e[`add_constraint_circle_${a}`](f, i, d, !0, 1)) : s === "arc" ? v([J(o(0))], (f) => e[`add_constraint_arc_${a}`](f, i, d, !0, 1)) : A();
        break;
      }
      case "angle": {
        const a = E("deg");
        if (s === "line,line") v([j(o(0)), j(o(1))], (i, f) => e.add_constraint_l2l_angle_ll(i, f, a, d, !0, 1));
        else if (s === "line") {
          const i = o(0);
          v([$(i.p1), $(i.p2)], (f, u) => e.add_constraint_p2p_angle_incr_angle(f, u, a, 0, d, !0, 1));
        } else A();
        break;
      }
      case "midpoint":
        if (s === "point,line") {
          const a = o(1);
          v([$(a.p1), $(a.p2), $(p(0))], (i, f, u) => e.add_constraint_p2p_symmetric_ppp(i, f, u, d, !0, 1));
        } else if (s === "line,point") {
          const a = o(0);
          v([$(a.p1), $(a.p2), $(p(1))], (i, f, u) => e.add_constraint_p2p_symmetric_ppp(i, f, u, d, !0, 1));
        } else A();
        break;
      case "symmetric":
        s === "point,point,line" ? v([$(p(0)), $(p(1)), j(o(2))], (a, i, f) => e.add_constraint_p2p_symmetric_ppl(a, i, f, d, !0, 1)) : s === "point,point,point" ? v([$(p(0)), $(p(1)), $(p(2))], (a, i, f) => e.add_constraint_p2p_symmetric_ppp(a, i, f, d, !0, 1)) : A();
        break;
      case "point_on_line":
        s === "point,line" ? v([$(p(0)), j(o(1))], (a, i) => e.add_constraint_point_on_line_pl(a, i, d, !0, 1)) : A();
        break;
      case "point_on_circle":
        if (s === "point,spline") Kn(p(0), o(1), d, l);
        else if (s === "point,circle" || s === "point,arc") v([$(p(0)), R(o(1))], (a, i) => e.add_constraint_point_on_circle(a, i, d, !0, 1));
        else {
          if (Un(s, p(0), o(1), d, l)) break;
          A();
        }
        break;
      case "concentric": {
        const a = (i) => i === "circle" || i === "arc" || i === "ellipse" || i === "ellipse_arc";
        n.length === 2 && a(n[0]) && a(n[1]) ? v([$(o(0).c), $(o(1).c)], (i, f) => e.add_constraint_p2p_coincident(i, f, d, !0, 1)) : A();
        break;
      }
      case "fix": {
        const a = Y(), i = (f, u) => {
          const L = C(u ? u[0] : a[f[0]], !0, l, "value_u"), T = C(u ? u[1] : a[f[1]], !0, l, "value_v");
          w.valueParams.push({ idx: L, unit: "mm" }, { idx: T, unit: "mm" }), v([$(f)], (B) => {
            e.add_constraint_coordinate_x(B, L, d, !0, 1), e.add_constraint_coordinate_y(B, T, d, !0, 1);
          });
        };
        if (s === "point") i(p(0), Array.isArray(t.value) ? t.value : null);
        else if (s === "line")
          i(o(0).p1), i(o(0).p2);
        else if (s === "circle") {
          const f = o(0);
          i(f.c);
          const u = C(a[f.r], !0, l, "value_r");
          w.valueParams.push({ idx: u, unit: "mm" }), v([R(f)], (L) => e.add_constraint_circle_radius(L, u, d, !0, 1));
        } else if (s === "arc") {
          const f = o(0);
          i(f.c), i(f.s), i(f.e);
        } else if (s === "spline" || bn.has(s))
          for (const f of o(0).pts) i(b.get(f));
        else A();
        break;
      }
      // P4b (SKETCH): sketch pattern ties (solver-only kinds; see the header)
      case "pattern_shift": {
        (s !== "point,point" || !Array.isArray(t.value)) && A();
        const a = p(0), i = p(1), f = C(t.value[0], !0, l, "dx"), u = C(t.value[1], !0, l, "dy");
        e.add_constraint_difference(a[0], i[0], f, d, !0, 1), e.add_constraint_difference(a[1], i[1], u, d, !0, 1);
        break;
      }
      case "pattern_along": {
        const a = Array.isArray(t.value) ? t.value : [], i = _.slice(2);
        (n[0] !== "point" || n[1] !== "point" || !i.length || n.slice(2).some((I) => I !== "line") || a.length !== 2 + i.length) && A();
        const f = p(0), u = p(1), L = Y();
        let T = f, B = [L[f[0]], L[f[1]]];
        const q = [];
        (a[0] || a[1]) && q.push({ shift: [a[0], a[1]] }), i.forEach((I, tn) => q.push({ line: o(2 + tn), d: a[2 + tn] })), q.forEach((I, tn) => {
          const en = tn === q.length - 1;
          let H;
          if (I.shift) H = [B[0] + I.shift[0], B[1] + I.shift[1]];
          else {
            const W = I.line, Z = L[W.p2[0]] - L[W.p1[0]], on = L[W.p2[1]] - L[W.p1[1]], rn = Math.hypot(Z, on) || 1;
            H = [B[0] + I.d * Z / rn, B[1] + I.d * on / rn];
          }
          const K = en ? u : [C(H[0], !1, l, "hx"), C(H[1], !1, l, "hy")];
          if (I.shift) {
            const W = C(I.shift[0], !0, l, "dx"), Z = C(I.shift[1], !0, l, "dy");
            e.add_constraint_difference(T[0], K[0], W, d, !0, 1), e.add_constraint_difference(T[1], K[1], Z, d, !0, 1);
          } else if (Math.abs(I.d) < 1e-12)
            v([$(T), $(K)], (W, Z) => e.add_constraint_p2p_coincident(W, Z, d, !0, 1));
          else {
            const W = C(Math.abs(I.d), !0, l, "d"), Z = { p1: T, p2: K };
            v([$(T), $(K)], (on, rn) => e.add_constraint_p2p_distance(on, rn, W, d, !0, 1)), v([j(Z), j(I.line)], (on, rn) => e.add_constraint_parallel(on, rn, d, !0, 1));
          }
          T = K, B = H;
        });
        break;
      }
      case "offset_end": {
        s === "point,point,line" ? v([j({ p1: p(0), p2: p(1) }), j(o(2))], (a, i) => e.add_constraint_perpendicular_ll(a, i, d, !0, 1)) : s === "point,point,arc" ? v([$(p(1)), j({ p1: o(2).c, p2: p(0) })], (a, i) => e.add_constraint_point_on_line_pl(a, i, d, !0, 1)) : A();
        break;
      }
      case "pattern_rotate": {
        s !== "point,point,point" && A();
        const a = p(0), i = p(1), f = p(2), u = Y();
        if (Math.hypot(u[i[0]] - u[a[0]], u[i[1]] - u[a[1]]) < 1e-9) {
          v([$(a), $(f)], (q, I) => e.add_constraint_p2p_coincident(q, I, d, !0, 1));
          break;
        }
        const L = E("deg"), T = { p1: a, p2: i }, B = { p1: a, p2: f };
        v([j(T), j(B)], (q, I) => e.add_constraint_equal_length(q, I, d, !0, 1)), v([j(T), j(B)], (q, I) => e.add_constraint_l2l_angle_ll(q, I, L, d, !0, 1));
        break;
      }
      default:
        throw new F(`constraint ${l}: unknown kind "${t.kind}"`);
    }
    return w;
  }
  function Xn(t) {
    S = null, X = [], dn++, e.clear_data(), b = /* @__PURE__ */ new Map(), P = /* @__PURE__ */ new Map(), D = /* @__PURE__ */ new Map(), Q = /* @__PURE__ */ new Map(), N = [], cn = 0, V = [], y = t;
    for (const [n, s] of Object.entries(t.points ?? {}))
      b.set(n, [C(s[0], !1, n, "u"), C(s[1], !1, n, "v")]);
    const c = (n, s) => {
      const w = b.get(n);
      if (!w) throw new F(`entity ${s}: point "${n}" not found`);
      return w;
    }, l = (n) => t.points[n];
    for (const n of t.entities ?? [])
      switch (n.kind) {
        case "point":
          P.set(n.id, { kind: "point", p: c(n.p, n.id), pts: [n.p], params: [...c(n.p, n.id)] });
          break;
        case "line": {
          const s = c(n.p[0], n.id), w = c(n.p[1], n.id);
          P.set(n.id, { kind: "line", p1: s, p2: w, pts: [n.p[0], n.p[1]], params: [...s, ...w] });
          break;
        }
        case "circle": {
          const s = c(n.c, n.id), w = C(n.r, !1, n.id, "r");
          P.set(n.id, { kind: "circle", c: s, r: w, pts: [n.c], params: [...s, w] });
          break;
        }
        case "arc": {
          const s = n.ccw !== !1, w = s ? n.a : n.b, o = s ? n.b : n.a, p = c(n.c, n.id), E = c(w, n.id), A = c(o, n.id), d = l(n.c), a = l(w), i = l(o), f = Math.hypot(a[0] - d[0], a[1] - d[1]);
          let u = Math.atan2(a[1] - d[1], a[0] - d[0]), L = Math.atan2(i[1] - d[1], i[0] - d[0]);
          for (; L <= u; ) L += 2 * Math.PI;
          const T = C(f, !1, n.id, "r"), B = C(u, !1, n.id, "a0"), q = C(L, !1, n.id, "a1"), I = { kind: "arc", c: p, s: E, e: A, r: T, a0: B, a1: q, pts: [n.c, n.a, n.b], params: [...p, ...E, ...A, T, B, q] };
          P.set(n.id, I), v([J(I)], (tn) => e.add_constraint_arc_rules(tn, un, !0, 1));
          break;
        }
        // P4b (SKETCH): a spline is its points (fit points or poles, then handles).
        case "spline": {
          const s = [...n.pts ?? []];
          if (s.length < 2) throw new F(`entity ${n.id}: a spline needs two points or more`);
          const w = [n.handles?.[0] ?? null, n.handles?.[1] ?? null], o = [...s, ...w.filter((E) => E && !s.includes(E))], p = [];
          for (const E of o) p.push(...c(E, n.id));
          P.set(n.id, { kind: "spline", form: n.form === "control" ? "control" : "fit", closed: !!n.closed, fitPts: s, handleIds: w, pts: o, params: p, raw: n });
          break;
        }
        // Ellipses, parabolas, conics (see the header).
        case "ellipse":
        case "ellipse_arc": {
          const s = c(n.c, n.id), w = c(n.major, n.id), o = c(n.minor, n.id), p = l(n.c), E = l(n.major), A = l(n.minor), d = Math.hypot(E[0] - p[0], E[1] - p[1]);
          if (!(d > 0)) throw new F(`entity ${n.id}: an ellipse needs its major end away from its centre`);
          const a = [(E[0] - p[0]) / d, (E[1] - p[1]) / d], i = [-a[1], a[0]], f = (A[0] - p[0]) * i[0] + (A[1] - p[1]) * i[1];
          if (!(Math.abs(f) > 0)) throw new F(`entity ${n.id}: an ellipse needs its minor end off its major axis`);
          const u = Math.min(Math.abs(f), d * (1 - 1e-6)), L = Math.sqrt(d * d - u * u), T = [C(p[0] + L * a[0], !1, n.id, "fx"), C(p[1] + L * a[1], !1, n.id, "fy")], B = C(u, !1, n.id, "rmin"), q = { kind: n.kind, c: s, f: T, rmin: B, maj: w, mnr: o, pts: [n.c, n.major, n.minor], params: [...s, ...w, ...o, ...T, B] };
          if (n.kind === "ellipse_arc") {
            const en = n.ccw !== !1, H = en ? n.a : n.b, K = en ? n.b : n.a, W = c(H, n.id), Z = c(K, n.id), on = (_n) => Math.atan2(((_n[0] - p[0]) * i[0] + (_n[1] - p[1]) * i[1]) / u, ((_n[0] - p[0]) * a[0] + (_n[1] - p[1]) * a[1]) / d), rn = on(l(H));
            let Ln = on(l(K));
            for (; Ln <= rn; ) Ln += 2 * Math.PI;
            const Hn = C(rn, !1, n.id, "a0"), Yn = C(Ln, !1, n.id, "a1");
            Object.assign(q, { s: W, e: Z, a0: Hn, a1: Yn, ends: [n.a, n.b], pts: [n.c, n.major, n.minor, n.a, n.b] }), q.params.push(...W, ...Z, Hn, Yn), v([qn(q)], (_n) => e.add_constraint_arc_of_ellipse_rules(_n, un, !0, 1));
          }
          P.set(n.id, q);
          const I = G.InternalAlignmentType, tn = f < 0 ? "Negative" : "Positive";
          v([En(q), $(w), $(o)], (en, H, K) => {
            e.add_constraint_internal_alignment_point2ellipse(en, H, I.EllipsePositiveMajorX, un, !0, 1), e.add_constraint_internal_alignment_point2ellipse(en, H, I.EllipsePositiveMajorY, un, !0, 1), e.add_constraint_internal_alignment_point2ellipse(en, K, I[`Ellipse${tn}MinorX`], un, !0, 1), e.add_constraint_internal_alignment_point2ellipse(en, K, I[`Ellipse${tn}MinorY`], un, !0, 1);
          });
          break;
        }
        case "parabola": {
          const s = c(n.f, n.id), w = c(n.v, n.id), o = c(n.a, n.id), p = c(n.b, n.id), E = l(n.f), A = l(n.v), d = Math.hypot(E[0] - A[0], E[1] - A[1]);
          if (!(d > 0)) throw new F(`entity ${n.id}: a parabola needs its focus away from its vertex`);
          const a = [-(E[1] - A[1]) / d, (E[0] - A[0]) / d], i = (T) => (T[0] - A[0]) * a[0] + (T[1] - A[1]) * a[1], f = C(i(l(n.a)), !1, n.id, "a0"), u = C(i(l(n.b)), !1, n.id, "a1"), L = { kind: "parabola", f: s, v: w, s: o, e: p, a0: f, a1: u, ends: [n.a, n.b], pts: [n.f, n.v, n.a, n.b], params: [...s, ...w, ...o, ...p, f, u] };
          P.set(n.id, L), v([$n(L)], (T) => e.add_constraint_arc_of_parabola_rules(T, un, !0, 1));
          break;
        }
        case "conic": {
          if (!(n.rho > 0 && n.rho < 1)) throw new F(`entity ${n.id}: a conic's rho is between 0 and 1`);
          const s = c(n.a, n.id), w = c(n.b, n.id), o = c(n.t, n.id);
          P.set(n.id, { kind: "conic", t: o, ends: [n.a, n.b], pts: [n.a, n.b, n.t], params: [...s, ...w, ...o], raw: n });
          break;
        }
        default:
          throw new F(`entity ${n.id}: unknown kind "${n.kind}"`);
      }
    nn = [C(0, !0, "#drag", "u"), C(0, !0, "#drag", "v")], ln = [C(0, !0, "#drag2", "u"), C(0, !0, "#drag2", "v")];
    let _ = 0;
    for (const n of t.constraints ?? []) {
      if (D.has(n.id)) throw new F(`constraint ${n.id}: duplicate id`);
      if (n.driving === !1) {
        D.set(n.id, { tag: null, kind: n.kind, refs: n.refs ?? [], valueParams: [], driving: !1 });
        continue;
      }
      _ += 1;
      const s = _t(n, _);
      D.set(n.id, s), Q.set(_, n.id);
    }
    return fn = Y(), { params: cn, unknowns: N.filter((n) => !n.fixed).length, constraints: _ };
  }
  function wn(t = Y()) {
    const c = {};
    for (const [n, [s, w]] of b) c[n] = [t[s], t[w]];
    const l = {};
    for (const [n, s] of P) (s.kind === "circle" || s.kind === "arc") && (l[n] = t[s.r]);
    const _ = {};
    for (const [n, s] of D) s.driving || (_[n] = pt(s, t));
    return { points: c, radii: l, measures: _ };
  }
  const An = (t) => t.map((c) => Q.get(c)).filter((c) => c !== void 0);
  function kn() {
    return {
      conflicting: An(vn(e.get_conflicting())),
      redundant: An(vn(e.get_redundant())),
      partiallyRedundant: An(vn(e.get_partially_redundant()))
    };
  }
  function Gn(t = !0) {
    const c = t ? [U.DOGLEG, U.LM, U.BFGS] : [U.DOGLEG], l = e.has_redundant() && !e.has_conflicting(), _ = (s) => s === jn.Success || s === jn.Converged && l;
    let n = jn.Failed;
    for (const s of c)
      if (n = e.solve_prepared(s), _(n)) break;
    return _(n) ? (e.apply_solution(), fn = Y(), !0) : (sn(fn), !1);
  }
  function ht(t, c) {
    return c.conflicting.length ? "conflicting" : t ? c.redundant.length ? "redundant" : "ok" : "failed";
  }
  function yn() {
    if (!y) throw new Error("load() a sketch first");
    const t = performance.now();
    if (pn(), e.init_solution(U.DOGLEG), e.has_conflicting()) {
      const n = kn(), s = e.dof();
      return On(), { status: "conflicting", solved: !1, dof: s, ...n, values: wn(fn), ms: performance.now() - t };
    }
    let c = Gn(!0);
    for (let n = 0; c && V.length && n < 6 && !S && mt(); n++) {
      const s = wn(fn);
      Xn({ ...y, points: { ...y.points, ...s.points } }), pn(), e.init_solution(U.DOGLEG), c = Gn(!0);
    }
    dn++;
    const l = kn(), _ = e.dof();
    return On(), { status: ht(c, l), solved: c, dof: _, ...l, values: wn(fn), ms: performance.now() - t };
  }
  function mt() {
    const t = fn, c = (l) => {
      const _ = b.get(l);
      return [t[_[0]], t[_[1]]];
    };
    for (const l of V) {
      const _ = l.entity;
      let n;
      try {
        n = it({ form: "fit", degree: 3, pts: _.fitPts.map(c), closed: _.closed, handles: _.handleIds.map((o) => o ? c(o) : null), spans: _.raw.spans });
      } catch {
        continue;
      }
      const s = [t[l.p[0]], t[l.p[1]]], w = Math.max(1, Math.abs(s[0]) + Math.abs(s[1]));
      if (Jn(n, s).d > 1e-9 * w) return !0;
    }
    return !1;
  }
  function gt(t, c) {
    const l = D.get(t);
    if (!l) throw new F(`constraint ${t} not found`);
    const _ = y.constraints.find((n) => n.id === t);
    if (_.value = c, !l.driving) return yn();
    if (l.kind === "fix") {
      if (!Array.isArray(c) || l.valueParams.length !== 2) throw new F(`constraint ${t}: fix takes [u, v] on a point`);
      e.set_p_param(l.valueParams[0].idx, c[0], !0), e.set_p_param(l.valueParams[1].idx, c[1], !0);
    } else {
      const n = l.valueParams[0];
      if (!n) throw new F(`constraint ${t} has no value`);
      e.set_p_param(n.idx, n.unit === "deg" ? c * Pn : c, !0);
    }
    return yn();
  }
  function Sn() {
    const t = new Set(vn(e.get_dependent_params())), c = Y();
    for (let l = 0; l < cn; l++) {
      const _ = N[l];
      _ && !_.fixed && !t.has(l) && (e.set_p_param(l, c[l], !0), X.push(l));
    }
  }
  function pn() {
    if (!X.length) return;
    const t = Y();
    for (const c of X) e.set_p_param(c, t[c], !1);
    X = [];
  }
  function wt(t, { freeze: c = !0 } = {}) {
    if (!y) throw new Error("load() a sketch first");
    const l = gn(t);
    if (!l) throw new F(`point "${t}" not found`);
    if (e.clear_by_id(an), pn(), S = null, c && mn !== dn ? (e.diagnose_fresh(U.DOGLEG), mn = dn) : e.init_solution(U.DOGLEG), e.has_conflicting())
      return { ok: !1, reason: "conflicting", movable: !1, frozenParams: 0, conflicting: kn().conflicting };
    c && Sn();
    const _ = Y(), n = [_[l[0]], _[l[1]]];
    sn(n, nn[0]), v([$(nn), $(l)], (w, o) => e.add_constraint_p2p_coincident(w, o, an, !0, 1)), e.init_solution(U.DOGLEG), S = { kind: "point", pointId: t, init: n, grab: n, step: 0, reinits: 0, freeze: c, frozen: X.length };
    const s = !X.includes(l[0]) || !X.includes(l[1]);
    return { ok: !0, at: n, movable: s, frozenParams: X.length };
  }
  function kt(t, c, { freeze: l = !0 } = {}) {
    if (!y) throw new Error("load() a sketch first");
    const _ = P.get(t);
    if (!_ || _.kind === "point") throw new F(`entity "${t}" cannot be dragged as a whole`);
    if (!Array.isArray(c) || c.length !== 2) throw new F("dragStartEntity needs the grab point [u, v]");
    if (e.clear_by_id(an), pn(), S = null, l && mn !== dn ? (e.diagnose_fresh(U.DOGLEG), mn = dn) : e.init_solution(U.DOGLEG), e.has_conflicting())
      return { ok: !1, reason: "conflicting", movable: !1, frozenParams: 0, conflicting: kn().conflicting };
    l && Sn();
    const n = Y();
    let s = null, w = null;
    if (_.kind === "spline" || bn.has(_.kind))
      w = _.pts.map((p) => {
        const E = b.get(p), A = [n[E[0]], n[E[1]]], d = [C(A[0], !0, "#dragm", "u"), C(A[1], !0, "#dragm", "v")];
        return v([$(d), $(E)], (a, i) => e.add_constraint_p2p_coincident(a, i, an, !0, 1)), { t: d, start: A };
      });
    else if (_.kind === "line")
      s = [[n[_.p1[0]], n[_.p1[1]]], [n[_.p2[0]], n[_.p2[1]]]], sn(s[0], nn[0]), sn(s[1], ln[0]), v([$(nn), $(_.p1)], (p, E) => e.add_constraint_p2p_coincident(p, E, an, !0, 1)), v([$(ln), $(_.p2)], (p, E) => e.add_constraint_p2p_coincident(p, E, an, !0, 1));
    else {
      sn(c, nn[0]), sn([n[_.c[0]], n[_.c[1]]], ln[0]);
      const p = { c: _.c, r: _.r };
      v([$(nn), R(p)], (E, A) => e.add_constraint_point_on_circle(E, A, an, !0, 1)), v([$(ln), $(_.c)], (E, A) => e.add_constraint_p2p_coincident(E, A, an, !0, 1));
    }
    e.init_solution(U.DOGLEG), S = { kind: w ? "multi" : _.kind === "line" ? "line" : "radius", entity: t, ends: s, multi: w, init: [...c], grab: [...c], step: 0, reinits: 0, freeze: l, frozen: X.length };
    const o = _.params.some((p) => !X.includes(p));
    return { ok: !0, at: [...c], movable: o, frozenParams: X.length };
  }
  function yt(t, c, { reinit: l = "far", full: _ = !0 } = {}) {
    if (!S) return { status: "idle" };
    const n = Math.hypot(t - S.init[0], c - S.init[1]);
    if (l === "always" || S.step > 0 && n > 20 * S.step) {
      if (e.init_solution(U.DOGLEG), S.kind === "point") {
        const w = Y(), o = gn(S.pointId);
        S.init = [w[o[0]], w[o[1]]];
      } else
        S.init = [t, c];
      S.step = 0, S.reinits += 1;
    } else S.step === 0 && (S.step = n);
    if (S.kind === "multi") {
      const w = t - S.grab[0], o = c - S.grab[1];
      for (const p of S.multi) sn([p.start[0] + w, p.start[1] + o], p.t[0]);
    } else if (S.kind === "line") {
      const w = t - S.grab[0], o = c - S.grab[1];
      sn([S.ends[0][0] + w, S.ends[0][1] + o], nn[0]), sn([S.ends[1][0] + w, S.ends[1][1] + o], ln[0]);
    } else
      sn([t, c], nn[0]);
    const s = Gn(!1);
    return dn++, { status: s ? "ok" : "failed", values: _ ? wn(fn) : void 0 };
  }
  function bt() {
    return S && (e.clear_by_id(an), pn(), S = null), yn();
  }
  function On() {
    S && S.freeze && (Sn(), e.init_solution(U.DOGLEG), S.frozen = X.length);
  }
  function vt() {
    if (!y) throw new Error("load() a sketch first");
    const t = performance.now();
    pn();
    const c = e.diagnose_fresh(U.DOGLEG);
    mn = dn;
    const l = vn(e.get_dependent_params());
    On();
    const _ = new Set(l), n = kn(), s = /* @__PURE__ */ new Set();
    for (const E of [...n.conflicting, ...n.redundant])
      for (const A of D.get(E).refs) s.add(A);
    const w = {};
    for (const [E, A] of P)
      s.has(E) || A.pts.some((d) => s.has(d)) ? w[E] = "over" : w[E] = A.params.some((d) => _.has(d)) ? "under" : "fully";
    const o = {};
    for (const [E, [A, d]] of b)
      s.has(E) ? o[E] = "over" : o[E] = _.has(A) || _.has(d) ? "under" : "fully";
    const p = l.map((E) => N[E] ? `${N[E].owner}.${N[E].name}` : `#${E}`);
    return { dof: c, perEntity: w, perPoint: o, dependentParams: p, ...n, ms: performance.now() - t };
  }
  function Mt() {
    return { params: cn, initMs: z, dragging: !!S, dragReinits: S ? S.reinits : 0, frozenParams: X.length, heapBytes: G.HEAPF64.buffer.byteLength };
  }
  function Et() {
    e.clear_data(), e.delete();
  }
  return { load: Xn, solve: yn, dragStart: wt, dragStartEntity: kt, dragMove: yt, dragEnd: bt, setValue: gt, analyze: vt, values: () => wn(), stats: Mt, dispose: Et, _internals: () => ({ M: G, gcs: e, pointParams: b, entityInfo: P, consInfo: D, dragTarget: nn, frozen: X, paramOwner: N }) };
}
const St = /* @__PURE__ */ new Set(["load", "solve", "dragStart", "dragStartEntity", "dragMove", "dragEnd", "setValue", "analyze", "values", "stats"]), Ot = "planegcs.mjs", at = new URL(Ot, import.meta.url).href, Mn = (r) => self.postMessage(r);
let Nn = null, hn = null;
const xn = [];
let zn = !1;
function ct(r) {
  if (!hn) throw new Error("the solver is not ready");
  return hn.load(r), hn.solve();
}
function Lt(r) {
  return { solve: ct(r), analysis: hn.analyze() };
}
async function jt(r) {
  const { id: m, op: h, params: g } = r;
  try {
    const k = Array.isArray(g) ? g : g === void 0 ? [] : [g];
    let M;
    if (h === "solveOnce" || h === "analyzeOnce")
      hn || (hn = await rt({ moduleUrl: at })), M = h === "solveOnce" ? ct(k[0]) : Lt(k[0]);
    else {
      if (!St.has(h)) throw new Error(`unknown op "${h}"`);
      M = Nn[h](...k);
    }
    Mn({ type: "result", id: m, ok: !0, result: M });
  } catch (k) {
    Mn({ type: "result", id: m, ok: !1, error: String(k && k.message ? k.message : k) });
  }
}
async function Dt() {
  for (; xn.length; ) {
    const r = xn.shift();
    if (r.op === "dragMove" && xn.some((m) => m.op === "dragMove")) {
      Mn({ type: "result", id: r.id, ok: !0, result: { superseded: !0 } });
      continue;
    }
    await jt(r);
  }
  zn = !1;
}
function lt() {
  zn || !Nn || (zn = !0, setTimeout(() => void Dt(), 0));
}
self.addEventListener("message", (r) => {
  const m = r.data;
  !m || m.type !== "call" || (xn.push(m), lt());
});
try {
  const r = performance.now();
  Nn = await rt({ moduleUrl: at }), Mn({ type: "ready", solver: "planegcs", initMs: performance.now() - r }), lt();
} catch (r) {
  Mn({ type: "error", error: String(r && r.message ? r.message : r) });
}
