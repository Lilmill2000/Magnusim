function Rt(s) {
  const d = [];
  return s.knots.forEach((u, _) => {
    for (let h = 0; h < s.mults[_]; h++) d.push(u);
  }), d;
}
function Qt(s) {
  const d = [], u = [];
  for (const _ of s)
    d.length && Math.abs(_ - d[d.length - 1]) < 1e-14 ? u[u.length - 1]++ : (d.push(_), u.push(1));
  return { knots: d, mults: u };
}
function St(s, d, u, _) {
  if (u >= _[s + 1]) return s;
  if (u <= _[d]) return d;
  let h = d, v = s + 1, $ = h + v >> 1;
  for (; u < _[$] || u >= _[$ + 1]; )
    u < _[$] ? v = $ : h = $, $ = h + v >> 1;
  return $;
}
function Lt(s, d, u, _, h) {
  const v = Array.from({ length: u + 1 }, () => new Array(u + 1).fill(0)), $ = new Array(u + 1).fill(0), E = new Array(u + 1).fill(0);
  v[0][0] = 1;
  for (let g = 1; g <= u; g++) {
    $[g] = d - h[s + 1 - g], E[g] = h[s + g] - d;
    let w = 0;
    for (let M = 0; M < g; M++) {
      v[g][M] = E[M + 1] + $[g - M];
      const O = v[M][g - 1] / v[g][M];
      v[M][g] = w + E[M + 1] * O, w = $[g - M] * O;
    }
    v[g][g] = w;
  }
  const G = Array.from({ length: _ + 1 }, () => new Array(u + 1).fill(0));
  for (let g = 0; g <= u; g++) G[0][g] = v[g][u];
  const z = [new Array(u + 1).fill(0), new Array(u + 1).fill(0)];
  for (let g = 0; g <= u; g++) {
    let w = 0, M = 1;
    z[0][0] = 1;
    for (let O = 1; O <= _; O++) {
      let q = 0;
      const C = g - O, F = u - O;
      g >= O && (z[M][0] = z[w][0] / v[F + 1][C], q = z[M][0] * v[C][F]);
      const tt = C >= -1 ? 1 : -C, X = g - 1 <= F ? O - 1 : u - g;
      for (let x = tt; x <= X; x++)
        z[M][x] = (z[w][x] - z[w][x - 1]) / v[F + 1][C + x], q += z[M][x] * v[C + x][F];
      g <= F && (z[M][O] = -z[w][O - 1] / v[F + 1][g], q += z[M][O] * v[g][F]), G[O][g] = q;
      const nt = w;
      w = M, M = nt;
    }
  }
  let e = u;
  for (let g = 1; g <= _; g++) {
    for (let w = 0; w <= u; w++) G[g][w] *= e;
    e *= u - g;
  }
  return G;
}
function Ot(s) {
  return [s.knots[0], s.knots[s.knots.length - 1]];
}
function Wt(s, d, u = 1) {
  const _ = Rt(s), h = s.poles.length - 1, v = s.degree, [$, E] = Ot(s), G = Math.min(E, Math.max($, d)), z = St(h, v, G, _), e = Lt(z, G, v, Math.min(u, v), _), g = [];
  for (let w = 0; w <= u; w++) {
    if (w > v) {
      g.push([0, 0]);
      continue;
    }
    let M = 0, O = 0;
    for (let q = 0; q <= v; q++) {
      const C = s.poles[z - v + q];
      M += e[w][q] * C[0], O += e[w][q] * C[1];
    }
    g.push([M, O]);
  }
  return g;
}
function xt(s, d) {
  return Wt(s, d, 0)[0];
}
function pn(s, d) {
  const u = s.length, _ = s.map((h, v) => [...h, d[v][0], d[v][1]]);
  for (let h = 0; h < u; h++) {
    let v = h;
    for (let $ = h + 1; $ < u; $++) Math.abs(_[$][h]) > Math.abs(_[v][h]) && (v = $);
    if (Math.abs(_[v][h]) < 1e-14) throw new Error("the spline points do not give a curve (two points in one place?)");
    [_[h], _[v]] = [_[v], _[h]];
    for (let $ = 0; $ < u; $++) {
      if ($ === h) continue;
      const E = _[$][h] / _[h][h];
      if (E)
        for (let G = h; G <= u + 1; G++) _[$][G] -= E * _[h][G];
    }
  }
  return _.map((h, v) => [h[u] / _[v][v], h[u + 1] / _[v][v]]);
}
function Bt(s, d, u) {
  const _ = s.length - d - 1;
  if (u.length !== _) throw new Error("spline interpolation: rows and poles differ");
  const h = _ - 1, v = (E, G, z, e) => {
    const g = St(h, d, E, s), w = Lt(g, E, d, G, s);
    for (let M = 0; M <= d; M++) e[g - d + M] += z * w[G][M];
  }, $ = u.map((E) => {
    const G = new Array(_).fill(0);
    return v(E.u, E.order, 1, G), E.minus && v(E.minus.u, E.minus.order, -1, G), G;
  });
  return pn($, u.map((E) => E.rhs));
}
function Kt(s, d = !1, u) {
  const _ = d ? [...s, s[0]] : [...s], h = [0], v = _.length - 1;
  for (let E = 1; E < _.length; E++) {
    let G = Math.hypot(_[E][0] - _[E - 1][0], _[E][1] - _[E - 1][1]);
    u && !d && (E === 1 && (G *= u[0]), E === v && v > 1 && (G *= u[1])), h.push(h[E - 1] + G);
  }
  const $ = h[h.length - 1];
  if (!($ > 0)) throw new Error("the spline points are all in one place");
  return h.map((E) => E / $);
}
function Ut(s, d = {}) {
  const u = !!d.closed && s.length >= 3;
  if (s.length < 2) throw new Error("a spline needs two points or more");
  const _ = u ? [...s, s[0]] : [...s], h = d.params ?? Kt(s, u, d.spans);
  for (let w = 1; w < h.length; w++) if (!(h[w] - h[w - 1] > 1e-12)) throw new Error("two spline points in one place");
  const v = 3, E = [0, 0, 0, 0, ...h.slice(1, -1), 1, 1, 1, 1], G = _.map((w, M) => ({ u: h[M], order: 0, rhs: w })), z = h[1] - h[0], e = h[h.length - 1] - h[h.length - 2];
  if (u)
    G.push({ u: 0, order: 1, rhs: [0, 0], minus: { u: 1, order: 1 } }), G.push({ u: 0, order: 2, rhs: [0, 0], minus: { u: 1, order: 2 } });
  else {
    const [w, M] = d.handles ?? [null, null];
    G.push(w ? { u: 0, order: 1, rhs: [3 * (w[0] - _[0][0]) / z, 3 * (w[1] - _[0][1]) / z] } : { u: 0, order: 2, rhs: [0, 0] });
    const O = _[_.length - 1];
    G.push(M ? { u: 1, order: 1, rhs: [3 * (O[0] - M[0]) / e, 3 * (O[1] - M[1]) / e] } : { u: 1, order: 2, rhs: [0, 0] });
  }
  const g = Bt(E, v, G);
  return g[0] = [_[0][0], _[0][1]], g[g.length - 1] = u ? [_[0][0], _[0][1]] : [_[_.length - 1][0], _[_.length - 1][1]], { degree: v, poles: g, ...Qt(E) };
}
function _n(s, d) {
  const u = s.length;
  if (u < d + 1) throw new Error(`a degree ${d} spline needs ${d + 1} control points or more`);
  const _ = u - d, h = Array.from({ length: _ + 1 }, ($, E) => E / _), v = h.map(($, E) => E === 0 || E === _ ? d + 1 : 1);
  return { degree: d, poles: s.map(($) => [$[0], $[1]]), knots: h, mults: v };
}
function hn(s, d) {
  const u = s.length;
  if (u < d + 1) throw new Error(`a closed degree ${d} spline needs ${d + 1} control points or more`);
  const _ = [...s, ...s.slice(0, d)].map((g) => [g[0], g[1]]), h = Array.from({ length: _.length + d + 1 }, (g, w) => w), v = (g, w) => {
    const M = St(_.length - 1, d, g, h), O = Lt(M, g, d, w, h);
    let q = 0, C = 0;
    for (let F = 0; F <= d; F++)
      q += O[w][F] * _[M - d + F][0], C += O[w][F] * _[M - d + F][1];
    return [q, C];
  }, $ = Array.from({ length: u - 1 }, (g, w) => (w + 1) / u), E = [...new Array(d + 1).fill(0), ...$, ...new Array(d + 1).fill(1)], G = E.length - d - 1, z = [];
  for (let g = 0; g < G; g++) {
    let w = 0;
    for (let M = 1; M <= d; M++) w += E[g + M];
    w /= d, z.push({ u: w, order: 0, rhs: v(d + w * u, 0) });
  }
  const e = Bt(E, d, z);
  return e[e.length - 1] = [e[0][0], e[0][1]], { degree: d, poles: e, ...Qt(E) };
}
function Ht(s) {
  if (s.form === "fit") return Ut(s.pts, { closed: s.closed, handles: s.handles, spans: s.spans });
  if (s.knots && s.mults) {
    if (s.mults.reduce((u, _) => u + _, 0) !== s.pts.length + s.degree + 1) throw new Error("the spline knots do not fit its control points");
    return { degree: s.degree, poles: s.pts.map((u) => [u[0], u[1]]), knots: [...s.knots], mults: [...s.mults] };
  }
  return s.closed ? hn(s.pts, s.degree) : _n(s.pts, s.degree);
}
function mn(s) {
  const d = (s.handles ?? [null, null]).filter((G) => !!G), u = [...s.pts, ...d], _ = s.form === "fit" ? Kt(s.pts, !!s.closed && s.pts.length >= 3, s.spans) : void 0, h = (G) => {
    const z = G.slice(0, s.pts.length);
    let e = s.pts.length;
    const g = [s.handles?.[0] ? G[e++] : null, s.handles?.[1] ? G[e++] : null];
    return s.form === "fit" ? Ut(z, { closed: s.closed, handles: g, params: _ }) : Ht({ ...s, pts: z });
  }, v = h(u), $ = h(u.map(() => [0, 0])), E = v.poles.map(() => new Array(u.length).fill(0));
  return u.forEach((G, z) => {
    h(u.map((g, w) => w === z ? [1, 0] : [0, 0])).poles.forEach((g, w) => E[w][z] = g[0] - $.poles[w][0]);
  }), { curve: v, W: E, flat: Rt(v) };
}
function gn(s, d = 16) {
  const u = [];
  for (let h = 0; h < s.knots.length - 1; h++) {
    const v = s.knots[h], $ = s.knots[h + 1];
    for (let E = 0; E < d; E++) {
      const G = v + ($ - v) * E / d;
      u.push({ u: G, p: xt(s, G) });
    }
  }
  const [, _] = Ot(s);
  return u.push({ u: _, p: xt(s, _) }), u;
}
function qt(s, d) {
  const u = gn(s, 24);
  let _ = 0, h = 1 / 0;
  u.forEach((e, g) => {
    const w = Math.hypot(e.p[0] - d[0], e.p[1] - d[1]);
    w < h && (h = w, _ = g);
  });
  const [v, $] = Ot(s);
  let E = u[_].u;
  for (let e = 0; e < 20; e++) {
    const [g, w, M] = Wt(s, E, 2), O = [g[0] - d[0], g[1] - d[1]], q = O[0] * w[0] + O[1] * w[1], C = w[0] * w[0] + w[1] * w[1] + O[0] * M[0] + O[1] * M[1];
    if (!(Math.abs(C) > 1e-300)) break;
    const F = Math.min($, Math.max(v, E - q / C));
    if (Math.abs(F - E) < 1e-14) {
      E = F;
      break;
    }
    E = F;
  }
  const G = xt(s, E), z = Math.hypot(G[0] - d[0], G[1] - d[1]);
  return z <= h ? { u: E, p: G, d: z } : { u: u[_].u, p: u[_].p, d: h };
}
const B = { BFGS: 0, LM: 1, DOGLEG: 2 }, Gt = { Success: 0, Converged: 1, Failed: 2 }, Z = -1, wn = 0, yt = Math.PI / 180;
class W extends Error {
}
function mt(s) {
  const d = new Array(s.size());
  for (let u = 0; u < d.length; u++) d[u] = s.get(u);
  return s.delete(), d;
}
function At(s) {
  for (; s <= -Math.PI; ) s += 2 * Math.PI;
  for (; s > Math.PI; ) s -= 2 * Math.PI;
  return s;
}
async function Xt({ moduleUrl: s, wasmUrl: d, moduleFactory: u, dlGaussStep: _ = 3, sparseSqpMinParams: h = 64 } = {}) {
  let v = u;
  if (!v) {
    const t = "planegcs.mjs";
    v = (await import(s ?? new URL(t, import.meta.url).href)).default;
  }
  const $ = {};
  d && ($.locateFile = (t) => t.endsWith(".wasm") ? d : t);
  const E = performance.now(), G = await v($), z = performance.now() - E, e = new G.GcsSystem();
  typeof e.set_dl_gauss_step == "function" && e.set_dl_gauss_step(_), typeof e.set_sparse_sqp_min_params == "function" && e.set_sparse_sqp_min_params(h);
  let g = null, w = /* @__PURE__ */ new Map(), M = /* @__PURE__ */ new Map(), O = /* @__PURE__ */ new Map(), q = /* @__PURE__ */ new Map(), C = [], F = [], tt = 0, X = null, nt = null, x = null, et = null, K = [], st = 0, ut = -1;
  const zt = () => G.HEAPF64;
  function U() {
    const t = e.params_to_buffer();
    return zt().slice(t >>> 3, (t >>> 3) + tt);
  }
  function Y(t, a = 0) {
    const l = e.input_buffer(t.length);
    zt().set(t, l >>> 3), e.params_from_buffer(a, t.length);
  }
  function T(t, a, l, p) {
    const n = e.push_p_param(t, a);
    return C[n] = { owner: l, name: p, fixed: a }, tt = n + 1, n;
  }
  function P(t, a) {
    const l = [];
    try {
      for (const p of t) l.push(p());
      return a(...l);
    } finally {
      for (const p of l) p.delete();
    }
  }
  const A = (t) => () => e.make_point(t[0], t[1]), I = (t) => () => e.make_line(t.p1[0], t.p1[1], t.p2[0], t.p2[1]), N = (t) => () => e.make_circle(t.c[0], t.c[1], t.r), H = (t) => () => e.make_arc(t.c[0], t.c[1], t.s[0], t.s[1], t.e[0], t.e[1], t.a0, t.a1, t.r), It = (t) => t.kind === "line" ? I(t) : t.kind === "arc" ? H(t) : N(t);
  function jt(t) {
    return t.kind === "line" ? t.pts : t.kind === "arc" ? [t.pts[1], t.pts[2]] : t.kind === "spline" ? t.closed ? [] : [t.fitPts[0], t.fitPts[t.fitPts.length - 1]] : [];
  }
  function Tt(t, a, l) {
    const p = t.fitPts.length, n = t.fitPts[0] === a;
    let r;
    if (t.form === "control" ? r = n ? t.fitPts[1] : t.fitPts[p - 2] : r = n ? t.handleIds[0] : t.handleIds[1], !r) throw new W(`constraint ${l}: a fit spline is tangent at an end only through a tangent handle there`);
    return { kind: "line", p1: w.get(a), p2: w.get(r) };
  }
  function Zt(t, a) {
    const l = jt(M.get(t)), p = new Set(jt(M.get(a)));
    return l.find((n) => p.has(n)) ?? null;
  }
  function Ct(t, a, l) {
    return t.kind === "line" ? [-(l[t.p2[1]] - l[t.p1[1]]), l[t.p2[0]] - l[t.p1[0]]] : [l[t.c[0]] - l[a[0]], l[t.c[1]] - l[a[1]]];
  }
  function Ft(t) {
    if (w.has(t)) return "point";
    const a = M.get(t);
    return a ? a.kind === "point" ? "point" : a.kind : null;
  }
  function dt(t) {
    if (w.has(t)) return w.get(t);
    const a = M.get(t);
    return a && a.kind === "point" ? a.p : null;
  }
  function tn(t, a) {
    const l = (b) => {
      const i = dt(b);
      return [a[i[0]], a[i[1]]];
    }, p = t.refs.map(Ft), n = (b) => {
      const i = M.get(b);
      return [[a[i.p1[0]], a[i.p1[1]]], [a[i.p2[0]], a[i.p2[1]]]];
    }, r = (b, i) => Math.hypot(i[0] - b[0], i[1] - b[1]);
    switch (t.kind) {
      case "distance":
        return p.length === 1 && p[0] === "line" ? r(...n(t.refs[0])) : p[0] === "point" && p[1] === "point" ? r(l(t.refs[0]), l(t.refs[1])) : null;
      case "distance_x":
      case "distance_y": {
        const b = t.kind === "distance_x" ? 0 : 1;
        if (p.length === 1 && p[0] === "line") {
          const [i, y] = n(t.refs[0]);
          return y[b] - i[b];
        }
        return p.length === 1 ? l(t.refs[0])[b] : l(t.refs[1])[b] - l(t.refs[0])[b];
      }
      case "radius":
      case "diameter": {
        const b = M.get(t.refs[0]), i = a[b.r];
        return t.kind === "radius" ? i : 2 * i;
      }
      case "angle": {
        const b = (i) => {
          const [y, S] = n(i);
          return Math.atan2(S[1] - y[1], S[0] - y[0]);
        };
        return p.length === 1 ? At(b(t.refs[0])) / yt : At(b(t.refs[1]) - b(t.refs[0])) / yt;
      }
      default:
        return null;
    }
  }
  function Vt(t, a, l, p) {
    if (typeof e.add_constraint_point_on_affine_spline != "function") throw new W(`constraint ${p}: this solver build cannot hold a point on a spline`);
    const n = U(), r = (m) => {
      const D = w.get(m);
      return [n[D[0]], n[D[1]]];
    }, b = a.handleIds.map((m) => m ? r(m) : null), i = { form: a.form, degree: a.raw.degree, pts: a.fitPts.map(r), closed: a.closed, handles: b, knots: a.raw.knots, mults: a.raw.mults, spans: a.raw.spans };
    let y;
    try {
      y = mn(i);
    } catch (m) {
      throw new W(`constraint ${p}: ${m instanceof Error ? m.message : String(m)}`);
    }
    const S = [...a.fitPts, ...a.handleIds.filter((m) => m)], L = qt(y.curve, [n[t[0]], n[t[1]]]).u, k = T(L, !1, p, "u"), c = y.W.length, o = new G.DoubleVector();
    for (const m of y.W) for (const D of m) o.push_back(D);
    const f = new G.DoubleVector();
    for (const m of y.flat) f.push_back(m);
    try {
      for (const m of [0, 1]) {
        const D = new G.IntVector();
        for (const V of S) D.push_back(w.get(V)[m]);
        try {
          e.add_constraint_point_on_affine_spline(t[m], k, D, o, c, f, y.curve.degree, l, !0);
        } finally {
          D.delete();
        }
      }
    } finally {
      o.delete(), f.delete();
    }
    a.form === "fit" && F.push({ p: t, entity: a });
  }
  function nn(t, a) {
    const l = t.id, p = t.refs ?? [], n = p.map((c) => {
      const o = Ft(c);
      if (!o) throw new W(`constraint ${l}: reference "${c}" not found`);
      return o;
    }), r = n.join(","), b = { tag: a, kind: t.kind, refs: p, valueParams: [], driving: !0 }, i = (c) => M.get(p[c]), y = (c) => dt(p[c]), S = (c, o = t.value) => {
      if (typeof o != "number" || !Number.isFinite(o))
        throw new W(`constraint ${l}: numeric value required`);
      const f = T(c === "deg" ? o * yt : o, !0, l, "value");
      return b.valueParams.push({ idx: f, unit: c }), f;
    }, L = () => {
      throw new W(`constraint ${l}: kind "${t.kind}" does not accept refs (${r})`);
    }, k = a;
    switch (t.kind) {
      case "coincident":
        r === "point,spline" ? Vt(y(0), i(1), k, l) : r === "point,point" ? P([A(y(0)), A(y(1))], (c, o) => e.add_constraint_p2p_coincident(c, o, k, !0, 1)) : r === "point,line" ? P([A(y(0)), I(i(1))], (c, o) => e.add_constraint_point_on_line_pl(c, o, k, !0, 1)) : r === "point,circle" || r === "point,arc" ? P([A(y(0)), N(i(1))], (c, o) => e.add_constraint_point_on_circle(c, o, k, !0, 1)) : L();
        break;
      case "horizontal":
      case "vertical": {
        const c = t.kind;
        r === "line" ? P([I(i(0))], (o) => e[`add_constraint_${c}_l`](o, k, !0, 1)) : r === "point,point" ? P([A(y(0)), A(y(1))], (o, f) => e[`add_constraint_${c}_pp`](o, f, k, !0, 1)) : L();
        break;
      }
      case "parallel":
        r === "line,line" ? P([I(i(0)), I(i(1))], (c, o) => e.add_constraint_parallel(c, o, k, !0, 1)) : L();
        break;
      case "perpendicular":
        r === "line,line" ? P([I(i(0)), I(i(1))], (c, o) => e.add_constraint_perpendicular_ll(c, o, k, !0, 1)) : L();
        break;
      case "tangent": {
        const c = (f) => f === "line" || f === "arc" || f === "circle" || f === "spline";
        let o = null;
        if (p.length === 3 && c(n[0]) && c(n[1]) && n[2] === "point" ? o = p[2] : p.length === 2 && c(n[0]) && c(n[1]) && (o = Zt(p[0], p[1])), (n[0] === "spline" || n[1] === "spline") && !o) throw new W(`constraint ${l}: a spline is tangent only at an end it shares`);
        if (o) {
          const f = n[0] === "spline" ? Tt(i(0), o, l) : i(0), m = n[1] === "spline" ? Tt(i(1), o, l) : i(1), D = dt(o), V = U(), R = Ct(f, D, V), Q = Ct(m, D, V), j = Math.atan2(-Q[0] * R[1] + Q[1] * R[0], Q[0] * R[0] + Q[1] * R[1]), rt = Math.abs(At(j)) > Math.PI / 2 ? Math.PI : 0, kt = T(rt, !0, l, "angle");
          b.valueParams.push({ idx: kt, unit: "internal" }), P([It(f), It(m), A(D)], (at, ot, J) => e.add_constraint_angle_via_point(at, ot, J, kt, k, !0, 1));
          break;
        }
        r === "line,circle" ? P([I(i(0)), N(i(1))], (f, m) => e.add_constraint_tangent_lc(f, m, k, !0, 1)) : r === "circle,line" ? P([I(i(1)), N(i(0))], (f, m) => e.add_constraint_tangent_lc(f, m, k, !0, 1)) : r === "line,arc" ? P([I(i(0)), H(i(1))], (f, m) => e.add_constraint_tangent_la(f, m, k, !0, 1)) : r === "arc,line" ? P([I(i(1)), H(i(0))], (f, m) => e.add_constraint_tangent_la(f, m, k, !0, 1)) : r === "circle,circle" ? P([N(i(0)), N(i(1))], (f, m) => e.add_constraint_tangent_cc(f, m, k, !0, 1)) : r === "arc,arc" ? P([H(i(0)), H(i(1))], (f, m) => e.add_constraint_tangent_aa(f, m, k, !0, 1)) : r === "circle,arc" ? P([N(i(0)), H(i(1))], (f, m) => e.add_constraint_tangent_ca(f, m, k, !0, 1)) : r === "arc,circle" ? P([N(i(1)), H(i(0))], (f, m) => e.add_constraint_tangent_ca(f, m, k, !0, 1)) : L();
        break;
      }
      case "equal":
        r === "line,line" ? P([I(i(0)), I(i(1))], (c, o) => e.add_constraint_equal_length(c, o, k, !0, 1)) : r === "circle,circle" ? P([N(i(0)), N(i(1))], (c, o) => e.add_constraint_equal_radius_cc(c, o, k, !0, 1)) : r === "circle,arc" ? P([N(i(0)), H(i(1))], (c, o) => e.add_constraint_equal_radius_ca(c, o, k, !0, 1)) : r === "arc,circle" ? P([N(i(1)), H(i(0))], (c, o) => e.add_constraint_equal_radius_ca(c, o, k, !0, 1)) : r === "arc,arc" ? P([H(i(0)), H(i(1))], (c, o) => e.add_constraint_equal_radius_aa(c, o, k, !0, 1)) : L();
        break;
      case "distance": {
        const c = () => S("mm");
        if (r === "line") {
          const o = i(0), f = c();
          P([A(o.p1), A(o.p2)], (m, D) => e.add_constraint_p2p_distance(m, D, f, k, !0, 1));
        } else if (r === "point,point") {
          const o = c();
          P([A(y(0)), A(y(1))], (f, m) => e.add_constraint_p2p_distance(f, m, o, k, !0, 1));
        } else if (r === "point,line") {
          const o = c();
          P([A(y(0)), I(i(1))], (f, m) => e.add_constraint_p2l_distance(f, m, o, k, !0, 1));
        } else if (r === "line,point") {
          const o = c();
          P([A(y(1)), I(i(0))], (f, m) => e.add_constraint_p2l_distance(f, m, o, k, !0, 1));
        } else if (r === "line,line") {
          const o = c();
          P([A(i(0).p1), I(i(1))], (f, m) => e.add_constraint_p2l_distance(f, m, o, k, !0, 1));
        } else if (r === "point,circle" || r === "point,arc") {
          const o = c();
          P([A(y(0)), N(i(1))], (f, m) => e.add_constraint_p2cdistance(f, m, o, k, !0, 1));
        } else if (r === "circle,circle") {
          const o = c();
          P([N(i(0)), N(i(1))], (f, m) => e.add_constraint_c2cdistance(f, m, o, k, !0, 1));
        } else if (r === "circle,line") {
          const o = c();
          P([N(i(0)), I(i(1))], (f, m) => e.add_constraint_c2ldistance(f, m, o, k, !0, 1));
        } else if (r === "line,circle") {
          const o = c();
          P([N(i(1)), I(i(0))], (f, m) => e.add_constraint_c2ldistance(f, m, o, k, !0, 1));
        } else L();
        break;
      }
      case "distance_x":
      case "distance_y": {
        const c = t.kind === "distance_x" ? 0 : 1;
        let o, f;
        if (r === "line")
          o = i(0).p1, f = i(0).p2;
        else if (r === "point,point")
          o = y(0), f = y(1);
        else if (r === "point") {
          const D = S("mm");
          P([A(y(0))], (V) => e[c === 0 ? "add_constraint_coordinate_x" : "add_constraint_coordinate_y"](V, D, k, !0, 1));
          break;
        } else L();
        const m = S("mm");
        e.add_constraint_difference(o[c], f[c], m, k, !0, 1);
        break;
      }
      case "radius":
      case "diameter": {
        const c = t.kind, o = S("mm");
        r === "circle" ? P([N(i(0))], (f) => e[`add_constraint_circle_${c}`](f, o, k, !0, 1)) : r === "arc" ? P([H(i(0))], (f) => e[`add_constraint_arc_${c}`](f, o, k, !0, 1)) : L();
        break;
      }
      case "angle": {
        const c = S("deg");
        if (r === "line,line") P([I(i(0)), I(i(1))], (o, f) => e.add_constraint_l2l_angle_ll(o, f, c, k, !0, 1));
        else if (r === "line") {
          const o = i(0);
          P([A(o.p1), A(o.p2)], (f, m) => e.add_constraint_p2p_angle_incr_angle(f, m, c, 0, k, !0, 1));
        } else L();
        break;
      }
      case "midpoint":
        if (r === "point,line") {
          const c = i(1);
          P([A(c.p1), A(c.p2), A(y(0))], (o, f, m) => e.add_constraint_p2p_symmetric_ppp(o, f, m, k, !0, 1));
        } else if (r === "line,point") {
          const c = i(0);
          P([A(c.p1), A(c.p2), A(y(1))], (o, f, m) => e.add_constraint_p2p_symmetric_ppp(o, f, m, k, !0, 1));
        } else L();
        break;
      case "symmetric":
        r === "point,point,line" ? P([A(y(0)), A(y(1)), I(i(2))], (c, o, f) => e.add_constraint_p2p_symmetric_ppl(c, o, f, k, !0, 1)) : r === "point,point,point" ? P([A(y(0)), A(y(1)), A(y(2))], (c, o, f) => e.add_constraint_p2p_symmetric_ppp(c, o, f, k, !0, 1)) : L();
        break;
      case "point_on_line":
        r === "point,line" ? P([A(y(0)), I(i(1))], (c, o) => e.add_constraint_point_on_line_pl(c, o, k, !0, 1)) : L();
        break;
      case "point_on_circle":
        r === "point,spline" ? Vt(y(0), i(1), k, l) : r === "point,circle" || r === "point,arc" ? P([A(y(0)), N(i(1))], (c, o) => e.add_constraint_point_on_circle(c, o, k, !0, 1)) : L();
        break;
      case "concentric": {
        const c = (o) => o === "circle" || o === "arc";
        n.length === 2 && c(n[0]) && c(n[1]) ? P([A(i(0).c), A(i(1).c)], (o, f) => e.add_constraint_p2p_coincident(o, f, k, !0, 1)) : L();
        break;
      }
      case "fix": {
        const c = U(), o = (f, m) => {
          const D = T(m ? m[0] : c[f[0]], !0, l, "value_u"), V = T(m ? m[1] : c[f[1]], !0, l, "value_v");
          b.valueParams.push({ idx: D, unit: "mm" }, { idx: V, unit: "mm" }), P([A(f)], (R) => {
            e.add_constraint_coordinate_x(R, D, k, !0, 1), e.add_constraint_coordinate_y(R, V, k, !0, 1);
          });
        };
        if (r === "point") o(y(0), Array.isArray(t.value) ? t.value : null);
        else if (r === "line")
          o(i(0).p1), o(i(0).p2);
        else if (r === "circle") {
          const f = i(0);
          o(f.c);
          const m = T(c[f.r], !0, l, "value_r");
          b.valueParams.push({ idx: m, unit: "mm" }), P([N(f)], (D) => e.add_constraint_circle_radius(D, m, k, !0, 1));
        } else if (r === "arc") {
          const f = i(0);
          o(f.c), o(f.s), o(f.e);
        } else if (r === "spline")
          for (const f of i(0).pts) o(w.get(f));
        else L();
        break;
      }
      // P4b (SKETCH): sketch pattern ties (solver-only kinds; see the header)
      case "pattern_shift": {
        (r !== "point,point" || !Array.isArray(t.value)) && L();
        const c = y(0), o = y(1), f = T(t.value[0], !0, l, "dx"), m = T(t.value[1], !0, l, "dy");
        e.add_constraint_difference(c[0], o[0], f, k, !0, 1), e.add_constraint_difference(c[1], o[1], m, k, !0, 1);
        break;
      }
      case "pattern_along": {
        const c = Array.isArray(t.value) ? t.value : [], o = p.slice(2);
        (n[0] !== "point" || n[1] !== "point" || !o.length || n.slice(2).some((j) => j !== "line") || c.length !== 2 + o.length) && L();
        const f = y(0), m = y(1), D = U();
        let V = f, R = [D[f[0]], D[f[1]]];
        const Q = [];
        (c[0] || c[1]) && Q.push({ shift: [c[0], c[1]] }), o.forEach((j, rt) => Q.push({ line: i(2 + rt), d: c[2 + rt] })), Q.forEach((j, rt) => {
          const kt = rt === Q.length - 1;
          let at;
          if (j.shift) at = [R[0] + j.shift[0], R[1] + j.shift[1]];
          else {
            const J = j.line, it = D[J.p2[0]] - D[J.p1[0]], lt = D[J.p2[1]] - D[J.p1[1]], ft = Math.hypot(it, lt) || 1;
            at = [R[0] + j.d * it / ft, R[1] + j.d * lt / ft];
          }
          const ot = kt ? m : [T(at[0], !1, l, "hx"), T(at[1], !1, l, "hy")];
          if (j.shift) {
            const J = T(j.shift[0], !0, l, "dx"), it = T(j.shift[1], !0, l, "dy");
            e.add_constraint_difference(V[0], ot[0], J, k, !0, 1), e.add_constraint_difference(V[1], ot[1], it, k, !0, 1);
          } else if (Math.abs(j.d) < 1e-12)
            P([A(V), A(ot)], (J, it) => e.add_constraint_p2p_coincident(J, it, k, !0, 1));
          else {
            const J = T(Math.abs(j.d), !0, l, "d"), it = { p1: V, p2: ot };
            P([A(V), A(ot)], (lt, ft) => e.add_constraint_p2p_distance(lt, ft, J, k, !0, 1)), P([I(it), I(j.line)], (lt, ft) => e.add_constraint_parallel(lt, ft, k, !0, 1));
          }
          V = ot, R = at;
        });
        break;
      }
      case "offset_end": {
        r === "point,point,line" ? P([I({ p1: y(0), p2: y(1) }), I(i(2))], (c, o) => e.add_constraint_perpendicular_ll(c, o, k, !0, 1)) : r === "point,point,arc" ? P([A(y(1)), I({ p1: i(2).c, p2: y(0) })], (c, o) => e.add_constraint_point_on_line_pl(c, o, k, !0, 1)) : L();
        break;
      }
      case "pattern_rotate": {
        r !== "point,point,point" && L();
        const c = y(0), o = y(1), f = y(2), m = U();
        if (Math.hypot(m[o[0]] - m[c[0]], m[o[1]] - m[c[1]]) < 1e-9) {
          P([A(c), A(f)], (Q, j) => e.add_constraint_p2p_coincident(Q, j, k, !0, 1));
          break;
        }
        const D = S("deg"), V = { p1: c, p2: o }, R = { p1: c, p2: f };
        P([I(V), I(R)], (Q, j) => e.add_constraint_equal_length(Q, j, k, !0, 1)), P([I(V), I(R)], (Q, j) => e.add_constraint_l2l_angle_ll(Q, j, D, k, !0, 1));
        break;
      }
      default:
        throw new W(`constraint ${l}: unknown kind "${t.kind}"`);
    }
    return b;
  }
  function Nt(t) {
    x = null, K = [], st++, e.clear_data(), w = /* @__PURE__ */ new Map(), M = /* @__PURE__ */ new Map(), O = /* @__PURE__ */ new Map(), q = /* @__PURE__ */ new Map(), C = [], tt = 0, F = [], g = t;
    for (const [n, r] of Object.entries(t.points ?? {}))
      w.set(n, [T(r[0], !1, n, "u"), T(r[1], !1, n, "v")]);
    const a = (n, r) => {
      const b = w.get(n);
      if (!b) throw new W(`entity ${r}: point "${n}" not found`);
      return b;
    }, l = (n) => t.points[n];
    for (const n of t.entities ?? [])
      switch (n.kind) {
        case "point":
          M.set(n.id, { kind: "point", p: a(n.p, n.id), pts: [n.p], params: [...a(n.p, n.id)] });
          break;
        case "line": {
          const r = a(n.p[0], n.id), b = a(n.p[1], n.id);
          M.set(n.id, { kind: "line", p1: r, p2: b, pts: [n.p[0], n.p[1]], params: [...r, ...b] });
          break;
        }
        case "circle": {
          const r = a(n.c, n.id), b = T(n.r, !1, n.id, "r");
          M.set(n.id, { kind: "circle", c: r, r: b, pts: [n.c], params: [...r, b] });
          break;
        }
        case "arc": {
          const r = n.ccw !== !1, b = r ? n.a : n.b, i = r ? n.b : n.a, y = a(n.c, n.id), S = a(b, n.id), L = a(i, n.id), k = l(n.c), c = l(b), o = l(i), f = Math.hypot(c[0] - k[0], c[1] - k[1]);
          let m = Math.atan2(c[1] - k[1], c[0] - k[0]), D = Math.atan2(o[1] - k[1], o[0] - k[0]);
          for (; D <= m; ) D += 2 * Math.PI;
          const V = T(f, !1, n.id, "r"), R = T(m, !1, n.id, "a0"), Q = T(D, !1, n.id, "a1"), j = { kind: "arc", c: y, s: S, e: L, r: V, a0: R, a1: Q, pts: [n.c, n.a, n.b], params: [...y, ...S, ...L, V, R, Q] };
          M.set(n.id, j), P([H(j)], (rt) => e.add_constraint_arc_rules(rt, wn, !0, 1));
          break;
        }
        // P4b (SKETCH): a spline is its points (fit points or poles, then handles).
        case "spline": {
          const r = [...n.pts ?? []];
          if (r.length < 2) throw new W(`entity ${n.id}: a spline needs two points or more`);
          const b = [n.handles?.[0] ?? null, n.handles?.[1] ?? null], i = [...r, ...b.filter((S) => S && !r.includes(S))], y = [];
          for (const S of i) y.push(...a(S, n.id));
          M.set(n.id, { kind: "spline", form: n.form === "control" ? "control" : "fit", closed: !!n.closed, fitPts: r, handleIds: b, pts: i, params: y, raw: n });
          break;
        }
        default:
          throw new W(`entity ${n.id}: unknown kind "${n.kind}"`);
      }
    X = [T(0, !0, "#drag", "u"), T(0, !0, "#drag", "v")], nt = [T(0, !0, "#drag2", "u"), T(0, !0, "#drag2", "v")];
    let p = 0;
    for (const n of t.constraints ?? []) {
      if (O.has(n.id)) throw new W(`constraint ${n.id}: duplicate id`);
      if (n.driving === !1) {
        O.set(n.id, { tag: null, kind: n.kind, refs: n.refs ?? [], valueParams: [], driving: !1 });
        continue;
      }
      p += 1;
      const r = nn(n, p);
      O.set(n.id, r), q.set(p, n.id);
    }
    return et = U(), { params: tt, unknowns: C.filter((n) => !n.fixed).length, constraints: p };
  }
  function pt(t = U()) {
    const a = {};
    for (const [n, [r, b]] of w) a[n] = [t[r], t[b]];
    const l = {};
    for (const [n, r] of M) (r.kind === "circle" || r.kind === "arc") && (l[n] = t[r.r]);
    const p = {};
    for (const [n, r] of O) r.driving || (p[n] = tn(r, t));
    return { points: a, radii: l, measures: p };
  }
  const bt = (t) => t.map((a) => q.get(a)).filter((a) => a !== void 0);
  function _t() {
    return {
      conflicting: bt(mt(e.get_conflicting())),
      redundant: bt(mt(e.get_redundant())),
      partiallyRedundant: bt(mt(e.get_partially_redundant()))
    };
  }
  function Mt(t = !0) {
    const a = t ? [B.DOGLEG, B.LM, B.BFGS] : [B.DOGLEG], l = e.has_redundant() && !e.has_conflicting(), p = (r) => r === Gt.Success || r === Gt.Converged && l;
    let n = Gt.Failed;
    for (const r of a)
      if (n = e.solve_prepared(r), p(n)) break;
    return p(n) ? (e.apply_solution(), et = U(), !0) : (Y(et), !1);
  }
  function en(t, a) {
    return a.conflicting.length ? "conflicting" : t ? a.redundant.length ? "redundant" : "ok" : "failed";
  }
  function ht() {
    if (!g) throw new Error("load() a sketch first");
    const t = performance.now();
    if (ct(), e.init_solution(B.DOGLEG), e.has_conflicting()) {
      const n = _t(), r = e.dof();
      return Pt(), { status: "conflicting", solved: !1, dof: r, ...n, values: pt(et), ms: performance.now() - t };
    }
    let a = Mt(!0);
    for (let n = 0; a && F.length && n < 6 && !x && sn(); n++) {
      const r = pt(et);
      Nt({ ...g, points: { ...g.points, ...r.points } }), ct(), e.init_solution(B.DOGLEG), a = Mt(!0);
    }
    st++;
    const l = _t(), p = e.dof();
    return Pt(), { status: en(a, l), solved: a, dof: p, ...l, values: pt(et), ms: performance.now() - t };
  }
  function sn() {
    const t = et, a = (l) => {
      const p = w.get(l);
      return [t[p[0]], t[p[1]]];
    };
    for (const l of F) {
      const p = l.entity;
      let n;
      try {
        n = Ht({ form: "fit", degree: 3, pts: p.fitPts.map(a), closed: p.closed, handles: p.handleIds.map((i) => i ? a(i) : null), spans: p.raw.spans });
      } catch {
        continue;
      }
      const r = [t[l.p[0]], t[l.p[1]]], b = Math.max(1, Math.abs(r[0]) + Math.abs(r[1]));
      if (qt(n, r).d > 1e-9 * b) return !0;
    }
    return !1;
  }
  function rn(t, a) {
    const l = O.get(t);
    if (!l) throw new W(`constraint ${t} not found`);
    const p = g.constraints.find((n) => n.id === t);
    if (p.value = a, !l.driving) return ht();
    if (l.kind === "fix") {
      if (!Array.isArray(a) || l.valueParams.length !== 2) throw new W(`constraint ${t}: fix takes [u, v] on a point`);
      e.set_p_param(l.valueParams[0].idx, a[0], !0), e.set_p_param(l.valueParams[1].idx, a[1], !0);
    } else {
      const n = l.valueParams[0];
      if (!n) throw new W(`constraint ${t} has no value`);
      e.set_p_param(n.idx, n.unit === "deg" ? a * yt : a, !0);
    }
    return ht();
  }
  function Et() {
    const t = new Set(mt(e.get_dependent_params())), a = U();
    for (let l = 0; l < tt; l++) {
      const p = C[l];
      p && !p.fixed && !t.has(l) && (e.set_p_param(l, a[l], !0), K.push(l));
    }
  }
  function ct() {
    if (!K.length) return;
    const t = U();
    for (const a of K) e.set_p_param(a, t[a], !1);
    K = [];
  }
  function on(t, { freeze: a = !0 } = {}) {
    if (!g) throw new Error("load() a sketch first");
    const l = dt(t);
    if (!l) throw new W(`point "${t}" not found`);
    if (e.clear_by_id(Z), ct(), x = null, a && ut !== st ? (e.diagnose_fresh(B.DOGLEG), ut = st) : e.init_solution(B.DOGLEG), e.has_conflicting())
      return { ok: !1, reason: "conflicting", movable: !1, frozenParams: 0, conflicting: _t().conflicting };
    a && Et();
    const p = U(), n = [p[l[0]], p[l[1]]];
    Y(n, X[0]), P([A(X), A(l)], (b, i) => e.add_constraint_p2p_coincident(b, i, Z, !0, 1)), e.init_solution(B.DOGLEG), x = { kind: "point", pointId: t, init: n, grab: n, step: 0, reinits: 0, freeze: a, frozen: K.length };
    const r = !K.includes(l[0]) || !K.includes(l[1]);
    return { ok: !0, at: n, movable: r, frozenParams: K.length };
  }
  function an(t, a, { freeze: l = !0 } = {}) {
    if (!g) throw new Error("load() a sketch first");
    const p = M.get(t);
    if (!p || p.kind === "point") throw new W(`entity "${t}" cannot be dragged as a whole`);
    if (!Array.isArray(a) || a.length !== 2) throw new W("dragStartEntity needs the grab point [u, v]");
    if (e.clear_by_id(Z), ct(), x = null, l && ut !== st ? (e.diagnose_fresh(B.DOGLEG), ut = st) : e.init_solution(B.DOGLEG), e.has_conflicting())
      return { ok: !1, reason: "conflicting", movable: !1, frozenParams: 0, conflicting: _t().conflicting };
    l && Et();
    const n = U();
    let r = null, b = null;
    if (p.kind === "spline")
      b = p.pts.map((y) => {
        const S = w.get(y), L = [n[S[0]], n[S[1]]], k = [T(L[0], !0, "#dragm", "u"), T(L[1], !0, "#dragm", "v")];
        return P([A(k), A(S)], (c, o) => e.add_constraint_p2p_coincident(c, o, Z, !0, 1)), { t: k, start: L };
      });
    else if (p.kind === "line")
      r = [[n[p.p1[0]], n[p.p1[1]]], [n[p.p2[0]], n[p.p2[1]]]], Y(r[0], X[0]), Y(r[1], nt[0]), P([A(X), A(p.p1)], (y, S) => e.add_constraint_p2p_coincident(y, S, Z, !0, 1)), P([A(nt), A(p.p2)], (y, S) => e.add_constraint_p2p_coincident(y, S, Z, !0, 1));
    else {
      Y(a, X[0]), Y([n[p.c[0]], n[p.c[1]]], nt[0]);
      const y = { c: p.c, r: p.r };
      P([A(X), N(y)], (S, L) => e.add_constraint_point_on_circle(S, L, Z, !0, 1)), P([A(nt), A(p.c)], (S, L) => e.add_constraint_p2p_coincident(S, L, Z, !0, 1));
    }
    e.init_solution(B.DOGLEG), x = { kind: b ? "multi" : p.kind === "line" ? "line" : "radius", entity: t, ends: r, multi: b, init: [...a], grab: [...a], step: 0, reinits: 0, freeze: l, frozen: K.length };
    const i = p.params.some((y) => !K.includes(y));
    return { ok: !0, at: [...a], movable: i, frozenParams: K.length };
  }
  function cn(t, a, { reinit: l = "far", full: p = !0 } = {}) {
    if (!x) return { status: "idle" };
    const n = Math.hypot(t - x.init[0], a - x.init[1]);
    if (l === "always" || x.step > 0 && n > 20 * x.step) {
      if (e.init_solution(B.DOGLEG), x.kind === "point") {
        const b = U(), i = dt(x.pointId);
        x.init = [b[i[0]], b[i[1]]];
      } else
        x.init = [t, a];
      x.step = 0, x.reinits += 1;
    } else x.step === 0 && (x.step = n);
    if (x.kind === "multi") {
      const b = t - x.grab[0], i = a - x.grab[1];
      for (const y of x.multi) Y([y.start[0] + b, y.start[1] + i], y.t[0]);
    } else if (x.kind === "line") {
      const b = t - x.grab[0], i = a - x.grab[1];
      Y([x.ends[0][0] + b, x.ends[0][1] + i], X[0]), Y([x.ends[1][0] + b, x.ends[1][1] + i], nt[0]);
    } else
      Y([t, a], X[0]);
    const r = Mt(!1);
    return st++, { status: r ? "ok" : "failed", values: p ? pt(et) : void 0 };
  }
  function ln() {
    return x && (e.clear_by_id(Z), ct(), x = null), ht();
  }
  function Pt() {
    x && x.freeze && (Et(), e.init_solution(B.DOGLEG), x.frozen = K.length);
  }
  function fn() {
    if (!g) throw new Error("load() a sketch first");
    const t = performance.now();
    ct();
    const a = e.diagnose_fresh(B.DOGLEG);
    ut = st;
    const l = mt(e.get_dependent_params());
    Pt();
    const p = new Set(l), n = _t(), r = /* @__PURE__ */ new Set();
    for (const S of [...n.conflicting, ...n.redundant])
      for (const L of O.get(S).refs) r.add(L);
    const b = {};
    for (const [S, L] of M)
      r.has(S) || L.pts.some((k) => r.has(k)) ? b[S] = "over" : b[S] = L.params.some((k) => p.has(k)) ? "under" : "fully";
    const i = {};
    for (const [S, [L, k]] of w)
      r.has(S) ? i[S] = "over" : i[S] = p.has(L) || p.has(k) ? "under" : "fully";
    const y = l.map((S) => C[S] ? `${C[S].owner}.${C[S].name}` : `#${S}`);
    return { dof: a, perEntity: b, perPoint: i, dependentParams: y, ...n, ms: performance.now() - t };
  }
  function un() {
    return { params: tt, initMs: z, dragging: !!x, dragReinits: x ? x.reinits : 0, frozenParams: K.length, heapBytes: G.HEAPF64.buffer.byteLength };
  }
  function dn() {
    e.clear_data(), e.delete();
  }
  return { load: Nt, solve: ht, dragStart: on, dragStartEntity: an, dragMove: cn, dragEnd: ln, setValue: rn, analyze: fn, values: () => pt(), stats: un, dispose: dn, _internals: () => ({ M: G, gcs: e, pointParams: w, entityInfo: M, consInfo: O, dragTarget: X, frozen: K, paramOwner: C }) };
}
const kn = /* @__PURE__ */ new Set(["load", "solve", "dragStart", "dragStartEntity", "dragMove", "dragEnd", "setValue", "analyze", "values", "stats"]), yn = "planegcs.mjs", Jt = new URL(yn, import.meta.url).href, wt = (s) => self.postMessage(s);
let Dt = null, gt = null;
const vt = [];
let $t = !1;
function vn(s) {
  if (!gt) throw new Error("the solver is not ready");
  return gt.load(s), gt.solve();
}
async function bn(s) {
  const { id: d, op: u, params: _ } = s;
  try {
    const h = Array.isArray(_) ? _ : _ === void 0 ? [] : [_];
    let v;
    if (u === "solveOnce")
      gt || (gt = await Xt({ moduleUrl: Jt })), v = vn(h[0]);
    else {
      if (!kn.has(u)) throw new Error(`unknown op "${u}"`);
      v = Dt[u](...h);
    }
    wt({ type: "result", id: d, ok: !0, result: v });
  } catch (h) {
    wt({ type: "result", id: d, ok: !1, error: String(h && h.message ? h.message : h) });
  }
}
async function Mn() {
  for (; vt.length; ) {
    const s = vt.shift();
    if (s.op === "dragMove" && vt.some((d) => d.op === "dragMove")) {
      wt({ type: "result", id: s.id, ok: !0, result: { superseded: !0 } });
      continue;
    }
    await bn(s);
  }
  $t = !1;
}
function Yt() {
  $t || !Dt || ($t = !0, setTimeout(() => void Mn(), 0));
}
self.addEventListener("message", (s) => {
  const d = s.data;
  !d || d.type !== "call" || (vt.push(d), Yt());
});
try {
  const s = performance.now();
  Dt = await Xt({ moduleUrl: Jt }), wt({ type: "ready", solver: "planegcs", initMs: performance.now() - s }), Yt();
} catch (s) {
  wt({ type: "error", error: String(s && s.message ? s.message : s) });
}
