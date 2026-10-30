function Zt(r) {
  const p = [];
  return r.knots.forEach((w, b) => {
    for (let M = 0; M < r.mults[b]; M++) p.push(w);
  }), p;
}
function tn(r) {
  const p = [], w = [];
  for (const b of r)
    p.length && Math.abs(b - p[p.length - 1]) < 1e-14 ? w[w.length - 1]++ : (p.push(b), w.push(1));
  return { knots: p, mults: w };
}
function zt(r, p, w, b) {
  if (w >= b[r + 1]) return r;
  if (w <= b[p]) return p;
  let M = p, P = r + 1, I = M + P >> 1;
  for (; w < b[I] || w >= b[I + 1]; )
    w < b[I] ? P = I : M = I, I = M + P >> 1;
  return I;
}
function Tt(r, p, w, b, M) {
  const P = Array.from({ length: w + 1 }, () => new Array(w + 1).fill(0)), I = new Array(w + 1).fill(0), G = new Array(w + 1).fill(0);
  P[0][0] = 1;
  for (let g = 1; g <= w; g++) {
    I[g] = p - M[r + 1 - g], G[g] = M[r + g] - p;
    let k = 0;
    for (let f = 0; f < g; f++) {
      P[g][f] = G[f + 1] + I[g - f];
      const v = P[f][g - 1] / P[g][f];
      P[f][g] = k + G[f + 1] * v, k = I[g - f] * v;
    }
    P[g][g] = k;
  }
  const S = Array.from({ length: b + 1 }, () => new Array(w + 1).fill(0));
  for (let g = 0; g <= w; g++) S[0][g] = P[g][w];
  const D = [new Array(w + 1).fill(0), new Array(w + 1).fill(0)];
  for (let g = 0; g <= w; g++) {
    let k = 0, f = 1;
    D[0][0] = 1;
    for (let v = 1; v <= b; v++) {
      let j = 0;
      const T = g - v, L = w - v;
      g >= v && (D[f][0] = D[k][0] / P[L + 1][T], j = D[f][0] * P[T][L]);
      const F = T >= -1 ? 1 : -T, R = g - 1 <= L ? v - 1 : w - g;
      for (let A = F; A <= R; A++)
        D[f][A] = (D[k][A] - D[k][A - 1]) / P[L + 1][T + A], j += D[f][A] * P[T + A][L];
      g <= L && (D[f][v] = -D[k][v - 1] / P[L + 1][g], j += D[f][v] * P[g][L]), S[v][g] = j;
      const Q = k;
      k = f, f = Q;
    }
  }
  let e = w;
  for (let g = 1; g <= b; g++) {
    for (let k = 0; k <= w; k++) S[g][k] *= e;
    e *= w - g;
  }
  return S;
}
function Ct(r) {
  return [r.knots[0], r.knots[r.knots.length - 1]];
}
const Yt = /* @__PURE__ */ new WeakMap();
function An(r) {
  const p = Yt.get(r.knots);
  if (p && p.mults === r.mults) return p.U;
  const w = Zt(r);
  return Yt.set(r.knots, { mults: r.mults, U: w }), w;
}
function nn(r, p, w = 1) {
  const b = An(r), M = r.poles.length - 1, P = r.degree, [I, G] = Ct(r), S = Math.min(G, Math.max(I, p)), D = zt(M, P, S, b), e = Tt(D, S, P, Math.min(w, P), b), g = [];
  for (let k = 0; k <= w; k++) {
    if (k > P) {
      g.push([0, 0]);
      continue;
    }
    let f = 0, v = 0;
    for (let j = 0; j <= P; j++) {
      const T = r.poles[D - P + j];
      f += e[k][j] * T[0], v += e[k][j] * T[1];
    }
    g.push([f, v]);
  }
  return g;
}
function It(r, p) {
  return nn(r, p, 0)[0];
}
function $n(r, p, w) {
  const b = Math.max(0, p - w), M = p - b, P = r.map((f) => {
    const v = new Array(M).fill(0), j = [...f.cells.entries()].filter(([F]) => F < b);
    for (const [F, R] of f.cells) F >= b && (v[F - b] += R);
    if (!j.length) return { lo: 1 / 0, a: [], b: v, rhs: [f.rhs[0], f.rhs[1]] };
    const T = Math.min(...j.map(([F]) => F)), L = new Array(Math.max(...j.map(([F]) => F)) - T + 1).fill(0);
    for (const [F, R] of j) L[F - T] = R;
    return { lo: T, a: L, b: v, rhs: [f.rhs[0], f.rhs[1]] };
  });
  P.sort((f, v) => f.lo - v.lo);
  const I = (f, v) => v >= f.lo && v < f.lo + f.a.length ? f.a[v - f.lo] : 0, G = () => new Error("the spline points do not give a curve (two points in one place?)"), S = [];
  let D = 0;
  for (let f = 0; f < b; f++) {
    let v = D, j = -1, T = 0;
    for (; v < P.length && P[v].lo <= f; v++) {
      const Q = Math.abs(I(P[v], f));
      Q > T && (T = Q, j = v);
    }
    if (j < 0 || !(T >= 1e-14)) throw G();
    const L = P[j];
    P[j] = P[D], P[D] = L, D++, S.push(L);
    const F = L.lo + L.a.length, R = L.a[f - L.lo];
    for (let Q = D; Q < v; Q++) {
      const A = P[Q], ot = I(A, f);
      if (ot) {
        const K = ot / R;
        for (; A.lo + A.a.length < F; ) A.a.push(0);
        for (let Y = f + 1; Y < F; Y++) A.a[Y - A.lo] -= K * L.a[Y - L.lo];
        for (let Y = 0; Y < M; Y++) A.b[Y] -= K * L.b[Y];
        A.rhs = [A.rhs[0] - K * L.rhs[0], A.rhs[1] - K * L.rhs[1]];
      }
      A.a.splice(0, f + 1 - A.lo), A.lo = A.a.length ? f + 1 : 1 / 0;
    }
    for (let Q = v - 1; Q >= D; Q--) {
      if (P[Q].lo !== 1 / 0) continue;
      const A = P.splice(Q, 1)[0];
      P.push(A);
    }
  }
  const e = P.slice(D);
  if (e.length !== M) throw G();
  const g = e.map((f) => [...f.b, f.rhs[0], f.rhs[1]]);
  for (let f = 0; f < M; f++) {
    let v = f;
    for (let j = f + 1; j < M; j++) Math.abs(g[j][f]) > Math.abs(g[v][f]) && (v = j);
    if (!(Math.abs(g[v][f]) >= 1e-14)) throw G();
    [g[f], g[v]] = [g[v], g[f]];
    for (let j = 0; j < M; j++) {
      if (j === f) continue;
      const T = g[j][f] / g[f][f];
      if (T)
        for (let L = f; L <= M + 1; L++) g[j][L] -= T * g[f][L];
    }
  }
  const k = new Array(p);
  for (let f = 0; f < M; f++) k[b + f] = [g[f][M] / g[f][f], g[f][M + 1] / g[f][f]];
  for (let f = b - 1; f >= 0; f--) {
    const v = S[f];
    let j = v.rhs[0], T = v.rhs[1];
    for (let F = f + 1; F < v.lo + v.a.length; F++) {
      const R = v.a[F - v.lo];
      R && (j -= R * k[F][0], T -= R * k[F][1]);
    }
    for (let F = 0; F < M; F++)
      v.b[F] && (j -= v.b[F] * k[b + F][0], T -= v.b[F] * k[b + F][1]);
    const L = v.a[f - v.lo];
    k[f] = [j / L, T / L];
  }
  return k;
}
function en(r, p, w) {
  const b = r.length - p - 1;
  if (w.length !== b) throw new Error("spline interpolation: rows and poles differ");
  const M = b - 1, P = w.map((I) => {
    const G = /* @__PURE__ */ new Map(), S = (D, e, g) => {
      const k = zt(M, p, D, r), f = Tt(k, D, p, e, r);
      for (let v = 0; v <= p; v++) f[e][v] && G.set(k - p + v, (G.get(k - p + v) ?? 0) + g * f[e][v]);
    };
    return S(I.u, I.order, 1), I.minus && S(I.minus.u, I.minus.order, -1), { cells: G, rhs: I.rhs };
  });
  return $n(P, b, p + 1);
}
function sn(r, p = !1, w) {
  const b = p ? [...r, r[0]] : [...r], M = [0], P = b.length - 1;
  for (let G = 1; G < b.length; G++) {
    let S = Math.hypot(b[G][0] - b[G - 1][0], b[G][1] - b[G - 1][1]);
    w && !p && (G === 1 && (S *= w[0]), G === P && P > 1 && (S *= w[1])), M.push(M[G - 1] + S);
  }
  const I = M[M.length - 1];
  if (!(I > 0)) throw new Error("the spline points are all in one place");
  return M.map((G) => G / I);
}
function on(r, p = {}) {
  const w = !!p.closed && r.length >= 3;
  if (r.length < 2) throw new Error("a spline needs two points or more");
  const b = w ? [...r, r[0]] : [...r], M = p.params ?? sn(r, w, p.spans);
  for (let k = 1; k < M.length; k++) if (!(M[k] - M[k - 1] > 1e-12)) throw new Error("two spline points in one place");
  const P = 3, G = [0, 0, 0, 0, ...M.slice(1, -1), 1, 1, 1, 1], S = b.map((k, f) => ({ u: M[f], order: 0, rhs: k })), D = M[1] - M[0], e = M[M.length - 1] - M[M.length - 2];
  if (w)
    S.push({ u: 0, order: 1, rhs: [0, 0], minus: { u: 1, order: 1 } }), S.push({ u: 0, order: 2, rhs: [0, 0], minus: { u: 1, order: 2 } });
  else {
    const [k, f] = p.handles ?? [null, null];
    S.push(k ? { u: 0, order: 1, rhs: [3 * (k[0] - b[0][0]) / D, 3 * (k[1] - b[0][1]) / D] } : { u: 0, order: 2, rhs: [0, 0] });
    const v = b[b.length - 1];
    S.push(f ? { u: 1, order: 1, rhs: [3 * (v[0] - f[0]) / e, 3 * (v[1] - f[1]) / e] } : { u: 1, order: 2, rhs: [0, 0] });
  }
  const g = en(G, P, S);
  return g[0] = [b[0][0], b[0][1]], g[g.length - 1] = w ? [b[0][0], b[0][1]] : [b[b.length - 1][0], b[b.length - 1][1]], { degree: P, poles: g, ...tn(G) };
}
function Gn(r, p) {
  const w = r.length;
  if (w < p + 1) throw new Error(`a degree ${p} spline needs ${p + 1} control points or more`);
  const b = w - p, M = Array.from({ length: b + 1 }, (I, G) => G / b), P = M.map((I, G) => G === 0 || G === b ? p + 1 : 1);
  return { degree: p, poles: r.map((I) => [I[0], I[1]]), knots: M, mults: P };
}
function On(r, p) {
  const w = r.length;
  if (w < p + 1) throw new Error(`a closed degree ${p} spline needs ${p + 1} control points or more`);
  const b = [...r, ...r.slice(0, p)].map((g) => [g[0], g[1]]), M = Array.from({ length: b.length + p + 1 }, (g, k) => k), P = (g, k) => {
    const f = zt(b.length - 1, p, g, M), v = Tt(f, g, p, k, M);
    let j = 0, T = 0;
    for (let L = 0; L <= p; L++)
      j += v[k][L] * b[f - p + L][0], T += v[k][L] * b[f - p + L][1];
    return [j, T];
  }, I = Array.from({ length: w - 1 }, (g, k) => (k + 1) / w), G = [...new Array(p + 1).fill(0), ...I, ...new Array(p + 1).fill(1)], S = G.length - p - 1, D = [];
  for (let g = 0; g < S; g++) {
    let k = 0;
    for (let f = 1; f <= p; f++) k += G[g + f];
    k /= p, D.push({ u: k, order: 0, rhs: P(p + k * w, 0) });
  }
  const e = en(G, p, D);
  return e[e.length - 1] = [e[0][0], e[0][1]], { degree: p, poles: e, ...tn(G) };
}
function rn(r) {
  if (r.form === "fit") return on(r.pts, { closed: r.closed, handles: r.handles, spans: r.spans });
  if (r.knots && r.mults) {
    if (r.mults.reduce((w, b) => w + b, 0) !== r.pts.length + r.degree + 1) throw new Error("the spline knots do not fit its control points");
    return { degree: r.degree, poles: r.pts.map((w) => [w[0], w[1]]), knots: [...r.knots], mults: [...r.mults] };
  }
  return r.closed ? On(r.pts, r.degree) : Gn(r.pts, r.degree);
}
function Sn(r) {
  const p = (r.handles ?? [null, null]).filter((S) => !!S), w = [...r.pts, ...p], b = r.form === "fit" ? sn(r.pts, !!r.closed && r.pts.length >= 3, r.spans) : void 0, M = (S) => {
    const D = S.slice(0, r.pts.length);
    let e = r.pts.length;
    const g = [r.handles?.[0] ? S[e++] : null, r.handles?.[1] ? S[e++] : null];
    return r.form === "fit" ? on(D, { closed: r.closed, handles: g, params: b }) : rn({ ...r, pts: D });
  }, P = M(w), I = M(w.map(() => [0, 0])), G = P.poles.map(() => new Array(w.length).fill(0));
  return w.forEach((S, D) => {
    M(w.map((g, k) => k === D ? [1, 0] : [0, 0])).poles.forEach((g, k) => G[k][D] = g[0] - I.poles[k][0]);
  }), { curve: P, W: G, flat: Zt(P) };
}
function Ln(r, p = 16) {
  const w = [];
  for (let M = 0; M < r.knots.length - 1; M++) {
    const P = r.knots[M], I = r.knots[M + 1];
    for (let G = 0; G < p; G++) {
      const S = P + (I - P) * G / p;
      w.push({ u: S, p: It(r, S) });
    }
  }
  const [, b] = Ct(r);
  return w.push({ u: b, p: It(r, b) }), w;
}
function Jt(r, p) {
  const w = Ln(r, 24);
  let b = 0, M = 1 / 0;
  w.forEach((e, g) => {
    const k = Math.hypot(e.p[0] - p[0], e.p[1] - p[1]);
    k < M && (M = k, b = g);
  });
  const [P, I] = Ct(r);
  let G = w[b].u;
  for (let e = 0; e < 20; e++) {
    const [g, k, f] = nn(r, G, 2), v = [g[0] - p[0], g[1] - p[1]], j = v[0] * k[0] + v[1] * k[1], T = k[0] * k[0] + k[1] * k[1] + v[0] * f[0] + v[1] * f[1];
    if (!(Math.abs(T) > 1e-300)) break;
    const L = Math.min(I, Math.max(P, G - j / T));
    if (Math.abs(L - G) < 1e-14) {
      G = L;
      break;
    }
    G = L;
  }
  const S = It(r, G), D = Math.hypot(S[0] - p[0], S[1] - p[1]);
  return D <= M ? { u: G, p: S, d: D } : { u: w[b].u, p: w[b].p, d: M };
}
const Z = { BFGS: 0, LM: 1, DOGLEG: 2 }, Lt = { Success: 0, Converged: 1, Failed: 2 }, ft = -1, dt = 0, Et = Math.PI / 180, yt = /* @__PURE__ */ new Set(["ellipse", "ellipse_arc", "parabola", "conic"]);
class q extends Error {
}
function an(r) {
  return typeof WebAssembly < "u" && typeof WebAssembly.Exception == "function" && r instanceof WebAssembly.Exception ? "the sketch solver failed inside: the sketch is likely too large for it (fewer arcs, ellipses or points)" : String(r && r.message ? r.message : r);
}
function bt(r) {
  const p = new Array(r.size());
  for (let w = 0; w < p.length; w++) p[w] = r.get(w);
  return r.delete(), p;
}
function jt(r) {
  for (; r <= -Math.PI; ) r += 2 * Math.PI;
  for (; r > Math.PI; ) r -= 2 * Math.PI;
  return r;
}
async function cn({ moduleUrl: r, wasmUrl: p, moduleFactory: w, dlGaussStep: b = 3, sparseSqpMinParams: M = 64 } = {}) {
  let P = w;
  if (!P) {
    const n = "planegcs.mjs";
    P = (await import(r ?? new URL(n, import.meta.url).href)).default;
  }
  const I = {};
  p && (I.locateFile = (n) => n.endsWith(".wasm") ? p : n);
  const G = performance.now(), S = await P(I), D = performance.now() - G, e = new S.GcsSystem();
  typeof e.set_dl_gauss_step == "function" && e.set_dl_gauss_step(b), typeof e.set_sparse_sqp_min_params == "function" && e.set_sparse_sqp_min_params(M);
  let g = null, k = /* @__PURE__ */ new Map(), f = /* @__PURE__ */ new Map(), v = /* @__PURE__ */ new Map(), j = /* @__PURE__ */ new Map(), T = [], L = [], F = 0, R = null, Q = null, A = null, ot = null, K = [], Y = 0, ht = -1;
  const Nt = () => S.HEAPF64;
  function nt() {
    const n = e.params_to_buffer();
    return Nt().slice(n >>> 3, (n >>> 3) + F);
  }
  function at(n, c = 0) {
    const l = e.input_buffer(n.length);
    Nt().set(n, l >>> 3), e.params_from_buffer(c, n.length);
  }
  function V(n, c, l, m) {
    const t = e.push_p_param(n, c);
    return T[t] = { owner: l, name: m, fixed: c }, F = t + 1, t;
  }
  function E(n, c) {
    const l = [];
    try {
      for (const m of n) l.push(m());
      return c(...l);
    } finally {
      for (const m of l) m.delete();
    }
  }
  const $ = (n) => () => e.make_point(n[0], n[1]), C = (n) => () => e.make_line(n.p1[0], n.p1[1], n.p2[0], n.p2[1]), U = (n) => () => e.make_circle(n.c[0], n.c[1], n.r), et = (n) => () => e.make_arc(n.c[0], n.c[1], n.s[0], n.s[1], n.e[0], n.e[1], n.a0, n.a1, n.r), Mt = (n) => () => e.make_ellipse(n.c[0], n.c[1], n.f[0], n.f[1], n.rmin), Wt = (n) => () => e.make_arc_of_ellipse(n.c[0], n.c[1], n.f[0], n.f[1], n.s[0], n.s[1], n.e[0], n.e[1], n.a0, n.a1, n.rmin), xt = (n) => () => e.make_arc_of_parabola(n.v[0], n.v[1], n.f[0], n.f[1], n.s[0], n.s[1], n.e[0], n.e[1], n.a0, n.a1), Vt = (n) => n.kind === "line" ? C(n) : n.kind === "arc" ? et(n) : n.kind === "ellipse" ? Mt(n) : n.kind === "ellipse_arc" ? Wt(n) : n.kind === "parabola" ? xt(n) : U(n);
  function qt(n) {
    return n.kind === "line" ? n.pts : n.kind === "arc" ? [n.pts[1], n.pts[2]] : n.kind === "spline" ? n.closed ? [] : [n.fitPts[0], n.fitPts[n.fitPts.length - 1]] : n.kind === "ellipse_arc" || n.kind === "parabola" || n.kind === "conic" ? n.ends : [];
  }
  function un(n, c) {
    return { kind: "line", p1: k.get(c), p2: n.t };
  }
  function pn(n, c, l) {
    const m = n.fitPts.length, t = n.fitPts[0] === c;
    let s;
    if (n.form === "control" ? s = t ? n.fitPts[1] : n.fitPts[m - 2] : s = t ? n.handleIds[0] : n.handleIds[1], !s) throw new q(`constraint ${l}: a fit spline is tangent at an end only through a tangent handle there`);
    return { kind: "line", p1: k.get(c), p2: k.get(s) };
  }
  function _n(n, c) {
    const l = qt(f.get(n)), m = new Set(qt(f.get(c)));
    return l.find((t) => m.has(t)) ?? null;
  }
  function Bt(n, c, l) {
    if (n.kind === "line") return [-(l[n.p2[1]] - l[n.p1[1]]), l[n.p2[0]] - l[n.p1[0]]];
    const m = [l[c[0]], l[c[1]]];
    if (n.kind === "ellipse" || n.kind === "ellipse_arc") {
      const t = [l[n.c[0]], l[n.c[1]]], s = [l[n.f[0]], l[n.f[1]]], y = l[n.rmin], o = Math.hypot(s[0] - t[0], s[1] - t[1]), h = Math.hypot(o, y), x = o > 0 ? [(s[0] - t[0]) / o, (s[1] - t[1]) / o] : [1, 0], O = [-x[1], x[0]], u = [m[0] - t[0], m[1] - t[1]], a = (u[0] * x[0] + u[1] * x[1]) / (h * h), i = (u[0] * O[0] + u[1] * O[1]) / (y * y);
      return [-(a * x[0] + i * O[0]), -(a * x[1] + i * O[1])];
    }
    if (n.kind === "parabola") {
      const t = [l[n.v[0]], l[n.v[1]]], s = [l[n.f[0]], l[n.f[1]]], y = Math.hypot(s[0] - t[0], s[1] - t[1]) || 1, o = [(s[0] - t[0]) / y, (s[1] - t[1]) / y], h = [-o[1], o[0]], x = (m[0] - t[0]) * h[0] + (m[1] - t[1]) * h[1];
      return [-4 * y * o[0] + 2 * x * h[0], -4 * y * o[1] + 2 * x * h[1]];
    }
    return [l[n.c[0]] - l[c[0]], l[n.c[1]] - l[c[1]]];
  }
  function Rt(n) {
    if (k.has(n)) return "point";
    const c = f.get(n);
    return c ? c.kind === "point" ? "point" : c.kind : null;
  }
  function mt(n) {
    if (k.has(n)) return k.get(n);
    const c = f.get(n);
    return c && c.kind === "point" ? c.p : null;
  }
  function hn(n, c) {
    const l = (y) => {
      const o = mt(y);
      return [c[o[0]], c[o[1]]];
    }, m = n.refs.map(Rt), t = (y) => {
      const o = f.get(y);
      return [[c[o.p1[0]], c[o.p1[1]]], [c[o.p2[0]], c[o.p2[1]]]];
    }, s = (y, o) => Math.hypot(o[0] - y[0], o[1] - y[1]);
    switch (n.kind) {
      case "distance":
        return m.length === 1 && m[0] === "line" ? s(...t(n.refs[0])) : m[0] === "point" && m[1] === "point" ? s(l(n.refs[0]), l(n.refs[1])) : null;
      case "distance_x":
      case "distance_y": {
        const y = n.kind === "distance_x" ? 0 : 1;
        if (m.length === 1 && m[0] === "line") {
          const [o, h] = t(n.refs[0]);
          return h[y] - o[y];
        }
        return m.length === 1 ? l(n.refs[0])[y] : l(n.refs[1])[y] - l(n.refs[0])[y];
      }
      case "radius":
      case "diameter": {
        const y = f.get(n.refs[0]), o = c[y.r];
        return n.kind === "radius" ? o : 2 * o;
      }
      case "angle": {
        const y = (o) => {
          const [h, x] = t(o);
          return Math.atan2(x[1] - h[1], x[0] - h[0]);
        };
        return m.length === 1 ? jt(y(n.refs[0])) / Et : jt(y(n.refs[1]) - y(n.refs[0])) / Et;
      }
      default:
        return null;
    }
  }
  function Ut(n, c, l, m) {
    if (typeof e.add_constraint_point_on_affine_spline != "function") throw new q(`constraint ${m}: this solver build cannot hold a point on a spline`);
    const t = nt(), s = (_) => {
      const z = k.get(_);
      return [t[z[0]], t[z[1]]];
    }, y = c.handleIds.map((_) => _ ? s(_) : null), o = { form: c.form, degree: c.raw.degree, pts: c.fitPts.map(s), closed: c.closed, handles: y, knots: c.raw.knots, mults: c.raw.mults, spans: c.raw.spans };
    let h;
    try {
      h = Sn(o);
    } catch (_) {
      throw new q(`constraint ${m}: ${_ instanceof Error ? _.message : String(_)}`);
    }
    const x = [...c.fitPts, ...c.handleIds.filter((_) => _)], O = Jt(h.curve, [t[n[0]], t[n[1]]]).u, u = V(O, !1, m, "u"), a = h.W.length, i = new S.DoubleVector();
    for (const _ of h.W) for (const z of _) i.push_back(z);
    const d = new S.DoubleVector();
    for (const _ of h.flat) d.push_back(_);
    try {
      for (const _ of [0, 1]) {
        const z = new S.IntVector();
        for (const W of x) z.push_back(k.get(W)[_]);
        try {
          e.add_constraint_point_on_affine_spline(n[_], u, z, i, a, d, h.curve.degree, l, !0);
        } finally {
          z.delete();
        }
      }
    } finally {
      i.delete(), d.delete();
    }
    c.form === "fit" && L.push({ p: n, entity: c });
  }
  function Qt(n, c, l, m, t) {
    if (n === "point,ellipse" || n === "point,ellipse_arc") E([$(c), Mt(l)], (s, y) => e.add_constraint_point_on_ellipse(s, y, m, !0, 1));
    else if (n === "point,parabola") E([$(c), xt(l)], (s, y) => e.add_constraint_point_on_parabolic_arc(s, y, m, !0, 1));
    else {
      if (n === "point,conic") throw new q(`constraint ${t}: a point lies on a conic only at its ends`);
      return !1;
    }
    return !0;
  }
  function mn(n, c) {
    const l = n.id, m = n.refs ?? [], t = m.map((a) => {
      const i = Rt(a);
      if (!i) throw new q(`constraint ${l}: reference "${a}" not found`);
      return i;
    }), s = t.join(","), y = { tag: c, kind: n.kind, refs: m, valueParams: [], driving: !0 }, o = (a) => f.get(m[a]), h = (a) => mt(m[a]), x = (a, i = n.value) => {
      if (typeof i != "number" || !Number.isFinite(i))
        throw new q(`constraint ${l}: numeric value required`);
      const d = V(a === "deg" ? i * Et : i, !0, l, "value");
      return y.valueParams.push({ idx: d, unit: a }), d;
    }, O = () => {
      throw new q(`constraint ${l}: kind "${n.kind}" does not accept refs (${s})`);
    }, u = c;
    switch (n.kind) {
      case "coincident":
        if (s === "point,spline") Ut(h(0), o(1), u, l);
        else if (s === "point,point") E([$(h(0)), $(h(1))], (a, i) => e.add_constraint_p2p_coincident(a, i, u, !0, 1));
        else if (s === "point,line") E([$(h(0)), C(o(1))], (a, i) => e.add_constraint_point_on_line_pl(a, i, u, !0, 1));
        else if (s === "point,circle" || s === "point,arc") E([$(h(0)), U(o(1))], (a, i) => e.add_constraint_point_on_circle(a, i, u, !0, 1));
        else {
          if (Qt(s, h(0), o(1), u, l)) break;
          O();
        }
        break;
      case "horizontal":
      case "vertical": {
        const a = n.kind;
        s === "line" ? E([C(o(0))], (i) => e[`add_constraint_${a}_l`](i, u, !0, 1)) : s === "ellipse" || s === "ellipse_arc" ? E([$(o(0).c), $(o(0).maj)], (i, d) => e[`add_constraint_${a}_pp`](i, d, u, !0, 1)) : s === "parabola" ? E([$(o(0).v), $(o(0).f)], (i, d) => e[`add_constraint_${a}_pp`](i, d, u, !0, 1)) : s === "point,point" ? E([$(h(0)), $(h(1))], (i, d) => e[`add_constraint_${a}_pp`](i, d, u, !0, 1)) : O();
        break;
      }
      case "parallel":
        s === "line,line" ? E([C(o(0)), C(o(1))], (a, i) => e.add_constraint_parallel(a, i, u, !0, 1)) : O();
        break;
      case "perpendicular":
        s === "line,line" ? E([C(o(0)), C(o(1))], (a, i) => e.add_constraint_perpendicular_ll(a, i, u, !0, 1)) : O();
        break;
      case "tangent": {
        const a = (d) => d === "line" || d === "arc" || d === "circle" || d === "spline" || yt.has(d);
        let i = null;
        if (m.length === 3 && a(t[0]) && a(t[1]) && t[2] === "point" ? i = m[2] : m.length === 2 && a(t[0]) && a(t[1]) && (i = _n(m[0], m[1])), (t[0] === "spline" || t[1] === "spline") && !i) throw new q(`constraint ${l}: a spline is tangent only at an end it shares`);
        if ((t[0] === "conic" || t[1] === "conic") && !i) throw new q(`constraint ${l}: a conic is tangent only at an end it shares`);
        if (!i && (yt.has(t[0]) || yt.has(t[1]))) {
          const d = t[0] === "line" ? 0 : t[1] === "line" ? 1 : -1, _ = 1 - d;
          if (d < 0 || t[_] !== "ellipse" && t[_] !== "ellipse_arc") throw new q(`constraint ${l}: an ellipse is tangent to a line anywhere; a parabola or a conic is tangent only at an end it shares`);
          E([C(o(d)), Mt(o(_))], (z, W) => e.add_constraint_tangent_le(z, W, u, !0, 1));
          break;
        }
        if (i) {
          const d = (J, H) => J === "spline" ? pn(H, i, l) : J === "conic" ? un(H, i) : H, _ = d(t[0], o(0)), z = d(t[1], o(1)), W = mt(i), X = nt(), B = Bt(_, W, X), N = Bt(z, W, X), it = Math.atan2(-N[0] * B[1] + N[1] * B[0], N[0] * B[0] + N[1] * B[1]), rt = Math.abs(jt(it)) > Math.PI / 2 ? Math.PI : 0, tt = V(rt, !0, l, "angle");
          y.valueParams.push({ idx: tt, unit: "internal" }), E([Vt(_), Vt(z), $(W)], (J, H, st) => e.add_constraint_angle_via_point(J, H, st, tt, u, !0, 1));
          break;
        }
        s === "line,circle" ? E([C(o(0)), U(o(1))], (d, _) => e.add_constraint_tangent_lc(d, _, u, !0, 1)) : s === "circle,line" ? E([C(o(1)), U(o(0))], (d, _) => e.add_constraint_tangent_lc(d, _, u, !0, 1)) : s === "line,arc" ? E([C(o(0)), et(o(1))], (d, _) => e.add_constraint_tangent_la(d, _, u, !0, 1)) : s === "arc,line" ? E([C(o(1)), et(o(0))], (d, _) => e.add_constraint_tangent_la(d, _, u, !0, 1)) : s === "circle,circle" ? E([U(o(0)), U(o(1))], (d, _) => e.add_constraint_tangent_cc(d, _, u, !0, 1)) : s === "arc,arc" ? E([et(o(0)), et(o(1))], (d, _) => e.add_constraint_tangent_aa(d, _, u, !0, 1)) : s === "circle,arc" ? E([U(o(0)), et(o(1))], (d, _) => e.add_constraint_tangent_ca(d, _, u, !0, 1)) : s === "arc,circle" ? E([U(o(1)), et(o(0))], (d, _) => e.add_constraint_tangent_ca(d, _, u, !0, 1)) : O();
        break;
      }
      case "equal":
        if (s === "line,line") E([C(o(0)), C(o(1))], (a, i) => e.add_constraint_equal_length(a, i, u, !0, 1));
        else if (s === "circle,circle") E([U(o(0)), U(o(1))], (a, i) => e.add_constraint_equal_radius_cc(a, i, u, !0, 1));
        else if (s === "circle,arc") E([U(o(0)), et(o(1))], (a, i) => e.add_constraint_equal_radius_ca(a, i, u, !0, 1));
        else if (s === "arc,circle") E([U(o(1)), et(o(0))], (a, i) => e.add_constraint_equal_radius_ca(a, i, u, !0, 1));
        else if (s === "arc,arc") E([et(o(0)), et(o(1))], (a, i) => e.add_constraint_equal_radius_aa(a, i, u, !0, 1));
        else if ((t[0] === "ellipse" || t[0] === "ellipse_arc") && (t[1] === "ellipse" || t[1] === "ellipse_arc")) {
          const a = o(0), i = o(1);
          E([C({ p1: a.c, p2: a.maj }), C({ p1: i.c, p2: i.maj })], (d, _) => e.add_constraint_equal_length(d, _, u, !0, 1)), E([C({ p1: a.c, p2: a.mnr }), C({ p1: i.c, p2: i.mnr })], (d, _) => e.add_constraint_equal_length(d, _, u, !0, 1));
        } else s === "parabola,parabola" ? E([C({ p1: o(0).v, p2: o(0).f }), C({ p1: o(1).v, p2: o(1).f })], (a, i) => e.add_constraint_equal_length(a, i, u, !0, 1)) : O();
        break;
      case "distance": {
        const a = () => x("mm");
        if (s === "line") {
          const i = o(0), d = a();
          E([$(i.p1), $(i.p2)], (_, z) => e.add_constraint_p2p_distance(_, z, d, u, !0, 1));
        } else if (s === "point,point") {
          const i = a();
          E([$(h(0)), $(h(1))], (d, _) => e.add_constraint_p2p_distance(d, _, i, u, !0, 1));
        } else if (s === "point,line") {
          const i = a();
          E([$(h(0)), C(o(1))], (d, _) => e.add_constraint_p2l_distance(d, _, i, u, !0, 1));
        } else if (s === "line,point") {
          const i = a();
          E([$(h(1)), C(o(0))], (d, _) => e.add_constraint_p2l_distance(d, _, i, u, !0, 1));
        } else if (s === "line,line") {
          const i = a();
          E([$(o(0).p1), C(o(1))], (d, _) => e.add_constraint_p2l_distance(d, _, i, u, !0, 1));
        } else if (s === "point,circle" || s === "point,arc") {
          const i = a();
          E([$(h(0)), U(o(1))], (d, _) => e.add_constraint_p2cdistance(d, _, i, u, !0, 1));
        } else if (s === "circle,circle") {
          const i = a();
          E([U(o(0)), U(o(1))], (d, _) => e.add_constraint_c2cdistance(d, _, i, u, !0, 1));
        } else if (s === "circle,line") {
          const i = a();
          E([U(o(0)), C(o(1))], (d, _) => e.add_constraint_c2ldistance(d, _, i, u, !0, 1));
        } else if (s === "line,circle") {
          const i = a();
          E([U(o(1)), C(o(0))], (d, _) => e.add_constraint_c2ldistance(d, _, i, u, !0, 1));
        } else O();
        break;
      }
      case "distance_x":
      case "distance_y": {
        const a = n.kind === "distance_x" ? 0 : 1;
        let i, d;
        if (s === "line")
          i = o(0).p1, d = o(0).p2;
        else if (s === "point,point")
          i = h(0), d = h(1);
        else if (s === "point") {
          const z = x("mm");
          E([$(h(0))], (W) => e[a === 0 ? "add_constraint_coordinate_x" : "add_constraint_coordinate_y"](W, z, u, !0, 1));
          break;
        } else O();
        const _ = x("mm");
        e.add_constraint_difference(i[a], d[a], _, u, !0, 1);
        break;
      }
      case "radius":
      case "diameter": {
        const a = n.kind, i = x("mm");
        s === "circle" ? E([U(o(0))], (d) => e[`add_constraint_circle_${a}`](d, i, u, !0, 1)) : s === "arc" ? E([et(o(0))], (d) => e[`add_constraint_arc_${a}`](d, i, u, !0, 1)) : O();
        break;
      }
      case "angle": {
        const a = x("deg");
        if (s === "line,line") E([C(o(0)), C(o(1))], (i, d) => e.add_constraint_l2l_angle_ll(i, d, a, u, !0, 1));
        else if (s === "line") {
          const i = o(0);
          E([$(i.p1), $(i.p2)], (d, _) => e.add_constraint_p2p_angle_incr_angle(d, _, a, 0, u, !0, 1));
        } else O();
        break;
      }
      case "midpoint":
        if (s === "point,line") {
          const a = o(1);
          E([$(a.p1), $(a.p2), $(h(0))], (i, d, _) => e.add_constraint_p2p_symmetric_ppp(i, d, _, u, !0, 1));
        } else if (s === "line,point") {
          const a = o(0);
          E([$(a.p1), $(a.p2), $(h(1))], (i, d, _) => e.add_constraint_p2p_symmetric_ppp(i, d, _, u, !0, 1));
        } else O();
        break;
      case "symmetric":
        s === "point,point,line" ? E([$(h(0)), $(h(1)), C(o(2))], (a, i, d) => e.add_constraint_p2p_symmetric_ppl(a, i, d, u, !0, 1)) : s === "point,point,point" ? E([$(h(0)), $(h(1)), $(h(2))], (a, i, d) => e.add_constraint_p2p_symmetric_ppp(a, i, d, u, !0, 1)) : O();
        break;
      case "point_on_line":
        s === "point,line" ? E([$(h(0)), C(o(1))], (a, i) => e.add_constraint_point_on_line_pl(a, i, u, !0, 1)) : O();
        break;
      case "point_on_circle":
        if (s === "point,spline") Ut(h(0), o(1), u, l);
        else if (s === "point,circle" || s === "point,arc") E([$(h(0)), U(o(1))], (a, i) => e.add_constraint_point_on_circle(a, i, u, !0, 1));
        else {
          if (Qt(s, h(0), o(1), u, l)) break;
          O();
        }
        break;
      case "concentric": {
        const a = (i) => i === "circle" || i === "arc" || i === "ellipse" || i === "ellipse_arc";
        t.length === 2 && a(t[0]) && a(t[1]) ? E([$(o(0).c), $(o(1).c)], (i, d) => e.add_constraint_p2p_coincident(i, d, u, !0, 1)) : O();
        break;
      }
      case "fix": {
        const a = nt(), i = (d, _) => {
          const z = V(_ ? _[0] : a[d[0]], !0, l, "value_u"), W = V(_ ? _[1] : a[d[1]], !0, l, "value_v");
          y.valueParams.push({ idx: z, unit: "mm" }, { idx: W, unit: "mm" }), E([$(d)], (X) => {
            e.add_constraint_coordinate_x(X, z, u, !0, 1), e.add_constraint_coordinate_y(X, W, u, !0, 1);
          });
        };
        if (s === "point") i(h(0), Array.isArray(n.value) ? n.value : null);
        else if (s === "line")
          i(o(0).p1), i(o(0).p2);
        else if (s === "circle") {
          const d = o(0);
          i(d.c);
          const _ = V(a[d.r], !0, l, "value_r");
          y.valueParams.push({ idx: _, unit: "mm" }), E([U(d)], (z) => e.add_constraint_circle_radius(z, _, u, !0, 1));
        } else if (s === "arc") {
          const d = o(0);
          i(d.c), i(d.s), i(d.e);
        } else if (s === "spline" || yt.has(s))
          for (const d of o(0).pts) i(k.get(d));
        else O();
        break;
      }
      // P4b (SKETCH): sketch pattern ties (solver-only kinds; see the header)
      case "pattern_shift": {
        (s !== "point,point" || !Array.isArray(n.value)) && O();
        const a = h(0), i = h(1), d = V(n.value[0], !0, l, "dx"), _ = V(n.value[1], !0, l, "dy");
        e.add_constraint_difference(a[0], i[0], d, u, !0, 1), e.add_constraint_difference(a[1], i[1], _, u, !0, 1);
        break;
      }
      case "pattern_along": {
        const a = Array.isArray(n.value) ? n.value : [], i = m.slice(2);
        (t[0] !== "point" || t[1] !== "point" || !i.length || t.slice(2).some((N) => N !== "line") || a.length !== 2 + i.length) && O();
        const d = h(0), _ = h(1), z = nt();
        let W = d, X = [z[d[0]], z[d[1]]];
        const B = [];
        (a[0] || a[1]) && B.push({ shift: [a[0], a[1]] }), i.forEach((N, it) => B.push({ line: o(2 + it), d: a[2 + it] })), B.forEach((N, it) => {
          const rt = it === B.length - 1;
          let tt;
          if (N.shift) tt = [X[0] + N.shift[0], X[1] + N.shift[1]];
          else {
            const H = N.line, st = z[H.p2[0]] - z[H.p1[0]], ct = z[H.p2[1]] - z[H.p1[1]], lt = Math.hypot(st, ct) || 1;
            tt = [X[0] + N.d * st / lt, X[1] + N.d * ct / lt];
          }
          const J = rt ? _ : [V(tt[0], !1, l, "hx"), V(tt[1], !1, l, "hy")];
          if (N.shift) {
            const H = V(N.shift[0], !0, l, "dx"), st = V(N.shift[1], !0, l, "dy");
            e.add_constraint_difference(W[0], J[0], H, u, !0, 1), e.add_constraint_difference(W[1], J[1], st, u, !0, 1);
          } else if (Math.abs(N.d) < 1e-12)
            E([$(W), $(J)], (H, st) => e.add_constraint_p2p_coincident(H, st, u, !0, 1));
          else {
            const H = V(Math.abs(N.d), !0, l, "d"), st = { p1: W, p2: J };
            E([$(W), $(J)], (ct, lt) => e.add_constraint_p2p_distance(ct, lt, H, u, !0, 1)), E([C(st), C(N.line)], (ct, lt) => e.add_constraint_parallel(ct, lt, u, !0, 1));
          }
          W = J, X = tt;
        });
        break;
      }
      case "offset_end": {
        s === "point,point,line" ? E([C({ p1: h(0), p2: h(1) }), C(o(2))], (a, i) => e.add_constraint_perpendicular_ll(a, i, u, !0, 1)) : s === "point,point,arc" ? E([$(h(1)), C({ p1: o(2).c, p2: h(0) })], (a, i) => e.add_constraint_point_on_line_pl(a, i, u, !0, 1)) : O();
        break;
      }
      case "pattern_rotate": {
        s !== "point,point,point" && O();
        const a = h(0), i = h(1), d = h(2), _ = nt();
        if (Math.hypot(_[i[0]] - _[a[0]], _[i[1]] - _[a[1]]) < 1e-9) {
          E([$(a), $(d)], (B, N) => e.add_constraint_p2p_coincident(B, N, u, !0, 1));
          break;
        }
        const z = x("deg"), W = { p1: a, p2: i }, X = { p1: a, p2: d };
        E([C(W), C(X)], (B, N) => e.add_constraint_equal_length(B, N, u, !0, 1)), E([C(W), C(X)], (B, N) => e.add_constraint_l2l_angle_ll(B, N, z, u, !0, 1));
        break;
      }
      default:
        throw new q(`constraint ${l}: unknown kind "${n.kind}"`);
    }
    return y;
  }
  function Kt(n) {
    A = null, K = [], Y++, e.clear_data(), k = /* @__PURE__ */ new Map(), f = /* @__PURE__ */ new Map(), v = /* @__PURE__ */ new Map(), j = /* @__PURE__ */ new Map(), T = [], F = 0, L = [], g = n;
    for (const [t, s] of Object.entries(n.points ?? {}))
      k.set(t, [V(s[0], !1, t, "u"), V(s[1], !1, t, "v")]);
    const c = (t, s) => {
      const y = k.get(t);
      if (!y) throw new q(`entity ${s}: point "${t}" not found`);
      return y;
    }, l = (t) => n.points[t];
    for (const t of n.entities ?? [])
      switch (t.kind) {
        case "point":
          f.set(t.id, { kind: "point", p: c(t.p, t.id), pts: [t.p], params: [...c(t.p, t.id)] });
          break;
        case "line": {
          const s = c(t.p[0], t.id), y = c(t.p[1], t.id);
          f.set(t.id, { kind: "line", p1: s, p2: y, pts: [t.p[0], t.p[1]], params: [...s, ...y] });
          break;
        }
        case "circle": {
          const s = c(t.c, t.id), y = V(t.r, !1, t.id, "r");
          f.set(t.id, { kind: "circle", c: s, r: y, pts: [t.c], params: [...s, y] });
          break;
        }
        case "arc": {
          const s = t.ccw !== !1, y = s ? t.a : t.b, o = s ? t.b : t.a, h = c(t.c, t.id), x = c(y, t.id), O = c(o, t.id), u = l(t.c), a = l(y), i = l(o), d = Math.hypot(a[0] - u[0], a[1] - u[1]);
          let _ = Math.atan2(a[1] - u[1], a[0] - u[0]), z = Math.atan2(i[1] - u[1], i[0] - u[0]);
          for (; z <= _; ) z += 2 * Math.PI;
          const W = V(d, !1, t.id, "r"), X = V(_, !1, t.id, "a0"), B = V(z, !1, t.id, "a1"), N = { kind: "arc", c: h, s: x, e: O, r: W, a0: X, a1: B, pts: [t.c, t.a, t.b], params: [...h, ...x, ...O, W, X, B] };
          f.set(t.id, N), E([et(N)], (it) => e.add_constraint_arc_rules(it, dt, !0, 1));
          break;
        }
        // P4b (SKETCH): a spline is its points (fit points or poles, then handles).
        case "spline": {
          const s = [...t.pts ?? []];
          if (s.length < 2) throw new q(`entity ${t.id}: a spline needs two points or more`);
          const y = [t.handles?.[0] ?? null, t.handles?.[1] ?? null], o = [...s, ...y.filter((x) => x && !s.includes(x))], h = [];
          for (const x of o) h.push(...c(x, t.id));
          f.set(t.id, { kind: "spline", form: t.form === "control" ? "control" : "fit", closed: !!t.closed, fitPts: s, handleIds: y, pts: o, params: h, raw: t });
          break;
        }
        // Ellipses, parabolas, conics (see the header).
        case "ellipse":
        case "ellipse_arc": {
          const s = c(t.c, t.id), y = c(t.major, t.id), o = c(t.minor, t.id), h = l(t.c), x = l(t.major), O = l(t.minor), u = Math.hypot(x[0] - h[0], x[1] - h[1]);
          if (!(u > 0)) throw new q(`entity ${t.id}: an ellipse needs its major end away from its centre`);
          const a = [(x[0] - h[0]) / u, (x[1] - h[1]) / u], i = [-a[1], a[0]], d = (O[0] - h[0]) * i[0] + (O[1] - h[1]) * i[1];
          if (!(Math.abs(d) > 0)) throw new q(`entity ${t.id}: an ellipse needs its minor end off its major axis`);
          const _ = Math.min(Math.abs(d), u * (1 - 1e-6)), z = Math.sqrt(u * u - _ * _), W = [V(h[0] + z * a[0], !1, t.id, "fx"), V(h[1] + z * a[1], !1, t.id, "fy")], X = V(_, !1, t.id, "rmin"), B = { kind: t.kind, c: s, f: W, rmin: X, maj: y, mnr: o, pts: [t.c, t.major, t.minor], params: [...s, ...y, ...o, ...W, X] };
          if (t.kind === "ellipse_arc") {
            const rt = t.ccw !== !1, tt = rt ? t.a : t.b, J = rt ? t.b : t.a, H = c(tt, t.id), st = c(J, t.id), ct = (pt) => Math.atan2(((pt[0] - h[0]) * i[0] + (pt[1] - h[1]) * i[1]) / _, ((pt[0] - h[0]) * a[0] + (pt[1] - h[1]) * a[1]) / u), lt = ct(l(tt));
            let St = ct(l(J));
            for (; St <= lt; ) St += 2 * Math.PI;
            const Xt = V(lt, !1, t.id, "a0"), Ht = V(St, !1, t.id, "a1");
            Object.assign(B, { s: H, e: st, a0: Xt, a1: Ht, ends: [t.a, t.b], pts: [t.c, t.major, t.minor, t.a, t.b] }), B.params.push(...H, ...st, Xt, Ht), E([Wt(B)], (pt) => e.add_constraint_arc_of_ellipse_rules(pt, dt, !0, 1));
          }
          f.set(t.id, B);
          const N = S.InternalAlignmentType, it = d < 0 ? "Negative" : "Positive";
          E([Mt(B), $(y), $(o)], (rt, tt, J) => {
            e.add_constraint_internal_alignment_point2ellipse(rt, tt, N.EllipsePositiveMajorX, dt, !0, 1), e.add_constraint_internal_alignment_point2ellipse(rt, tt, N.EllipsePositiveMajorY, dt, !0, 1), e.add_constraint_internal_alignment_point2ellipse(rt, J, N[`Ellipse${it}MinorX`], dt, !0, 1), e.add_constraint_internal_alignment_point2ellipse(rt, J, N[`Ellipse${it}MinorY`], dt, !0, 1);
          });
          break;
        }
        case "parabola": {
          const s = c(t.f, t.id), y = c(t.v, t.id), o = c(t.a, t.id), h = c(t.b, t.id), x = l(t.f), O = l(t.v), u = Math.hypot(x[0] - O[0], x[1] - O[1]);
          if (!(u > 0)) throw new q(`entity ${t.id}: a parabola needs its focus away from its vertex`);
          const a = [-(x[1] - O[1]) / u, (x[0] - O[0]) / u], i = (W) => (W[0] - O[0]) * a[0] + (W[1] - O[1]) * a[1], d = V(i(l(t.a)), !1, t.id, "a0"), _ = V(i(l(t.b)), !1, t.id, "a1"), z = { kind: "parabola", f: s, v: y, s: o, e: h, a0: d, a1: _, ends: [t.a, t.b], pts: [t.f, t.v, t.a, t.b], params: [...s, ...y, ...o, ...h, d, _] };
          f.set(t.id, z), E([xt(z)], (W) => e.add_constraint_arc_of_parabola_rules(W, dt, !0, 1));
          break;
        }
        case "conic": {
          if (!(t.rho > 0 && t.rho < 1)) throw new q(`entity ${t.id}: a conic's rho is between 0 and 1`);
          const s = c(t.a, t.id), y = c(t.b, t.id), o = c(t.t, t.id);
          f.set(t.id, { kind: "conic", t: o, ends: [t.a, t.b], pts: [t.a, t.b, t.t], params: [...s, ...y, ...o], raw: t });
          break;
        }
        default:
          throw new q(`entity ${t.id}: unknown kind "${t.kind}"`);
      }
    R = [V(0, !0, "#drag", "u"), V(0, !0, "#drag", "v")], Q = [V(0, !0, "#drag2", "u"), V(0, !0, "#drag2", "v")];
    let m = 0;
    for (const t of n.constraints ?? []) {
      if (v.has(t.id)) throw new q(`constraint ${t.id}: duplicate id`);
      if (t.driving === !1) {
        v.set(t.id, { tag: null, kind: t.kind, refs: t.refs ?? [], valueParams: [], driving: !1 });
        continue;
      }
      m += 1;
      const s = mn(t, m);
      v.set(t.id, s), j.set(m, t.id);
    }
    return ot = nt(), { params: F, unknowns: T.filter((t) => !t.fixed).length, constraints: m };
  }
  function gt(n = nt()) {
    const c = {};
    for (const [t, [s, y]] of k) c[t] = [n[s], n[y]];
    const l = {};
    for (const [t, s] of f) (s.kind === "circle" || s.kind === "arc") && (l[t] = n[s.r]);
    const m = {};
    for (const [t, s] of v) s.driving || (m[t] = hn(s, n));
    return { points: c, radii: l, measures: m };
  }
  const At = (n) => n.map((c) => j.get(c)).filter((c) => c !== void 0);
  function wt() {
    return {
      conflicting: At(bt(e.get_conflicting())),
      redundant: At(bt(e.get_redundant())),
      partiallyRedundant: At(bt(e.get_partially_redundant()))
    };
  }
  function $t(n = !0) {
    const c = n ? [Z.DOGLEG, Z.LM, Z.BFGS] : [Z.DOGLEG], l = e.has_redundant() && !e.has_conflicting(), m = (s) => s === Lt.Success || s === Lt.Converged && l;
    let t = Lt.Failed;
    for (const s of c)
      if (t = e.solve_prepared(s), m(t)) break;
    return m(t) ? (e.apply_solution(), ot = nt(), !0) : (at(ot), !1);
  }
  function gn(n, c) {
    return c.conflicting.length ? "conflicting" : n ? c.redundant.length ? "redundant" : "ok" : "failed";
  }
  function kt() {
    if (!g) throw new Error("load() a sketch first");
    const n = performance.now();
    if (ut(), e.init_solution(Z.DOGLEG), e.has_conflicting()) {
      const t = wt(), s = e.dof();
      return Ot(), { status: "conflicting", solved: !1, dof: s, ...t, values: gt(ot), ms: performance.now() - n };
    }
    let c = $t(!0);
    for (let t = 0; c && L.length && t < 6 && !A && wn(); t++) {
      const s = gt(ot);
      Kt({ ...g, points: { ...g.points, ...s.points } }), ut(), e.init_solution(Z.DOGLEG), c = $t(!0);
    }
    Y++;
    const l = wt(), m = e.dof();
    return Ot(), { status: gn(c, l), solved: c, dof: m, ...l, values: gt(ot), ms: performance.now() - n };
  }
  function wn() {
    const n = ot, c = (l) => {
      const m = k.get(l);
      return [n[m[0]], n[m[1]]];
    };
    for (const l of L) {
      const m = l.entity;
      let t;
      try {
        t = rn({ form: "fit", degree: 3, pts: m.fitPts.map(c), closed: m.closed, handles: m.handleIds.map((o) => o ? c(o) : null), spans: m.raw.spans });
      } catch {
        continue;
      }
      const s = [n[l.p[0]], n[l.p[1]]], y = Math.max(1, Math.abs(s[0]) + Math.abs(s[1]));
      if (Jt(t, s).d > 1e-9 * y) return !0;
    }
    return !1;
  }
  function kn(n, c) {
    const l = v.get(n);
    if (!l) throw new q(`constraint ${n} not found`);
    const m = g.constraints.find((t) => t.id === n);
    if (m.value = c, !l.driving) return kt();
    if (l.kind === "fix") {
      if (!Array.isArray(c) || l.valueParams.length !== 2) throw new q(`constraint ${n}: fix takes [u, v] on a point`);
      e.set_p_param(l.valueParams[0].idx, c[0], !0), e.set_p_param(l.valueParams[1].idx, c[1], !0);
    } else {
      const t = l.valueParams[0];
      if (!t) throw new q(`constraint ${n} has no value`);
      e.set_p_param(t.idx, t.unit === "deg" ? c * Et : c, !0);
    }
    return kt();
  }
  function Gt() {
    const n = new Set(bt(e.get_dependent_params())), c = nt();
    for (let l = 0; l < F; l++) {
      const m = T[l];
      m && !m.fixed && !n.has(l) && (e.set_p_param(l, c[l], !0), K.push(l));
    }
  }
  function ut() {
    if (!K.length) return;
    const n = nt();
    for (const c of K) e.set_p_param(c, n[c], !1);
    K = [];
  }
  function yn(n, { freeze: c = !0 } = {}) {
    if (!g) throw new Error("load() a sketch first");
    const l = mt(n);
    if (!l) throw new q(`point "${n}" not found`);
    if (e.clear_by_id(ft), ut(), A = null, c && ht !== Y ? (e.diagnose_fresh(Z.DOGLEG), ht = Y) : e.init_solution(Z.DOGLEG), e.has_conflicting())
      return { ok: !1, reason: "conflicting", movable: !1, frozenParams: 0, conflicting: wt().conflicting };
    c && Gt();
    const m = nt(), t = [m[l[0]], m[l[1]]];
    at(t, R[0]), E([$(R), $(l)], (y, o) => e.add_constraint_p2p_coincident(y, o, ft, !0, 1)), e.init_solution(Z.DOGLEG), A = { kind: "point", pointId: n, init: t, grab: t, step: 0, reinits: 0, freeze: c, frozen: K.length };
    const s = !K.includes(l[0]) || !K.includes(l[1]);
    return { ok: !0, at: t, movable: s, frozenParams: K.length };
  }
  function bn(n, c, { freeze: l = !0 } = {}) {
    if (!g) throw new Error("load() a sketch first");
    const m = f.get(n);
    if (!m || m.kind === "point") throw new q(`entity "${n}" cannot be dragged as a whole`);
    if (!Array.isArray(c) || c.length !== 2) throw new q("dragStartEntity needs the grab point [u, v]");
    if (e.clear_by_id(ft), ut(), A = null, l && ht !== Y ? (e.diagnose_fresh(Z.DOGLEG), ht = Y) : e.init_solution(Z.DOGLEG), e.has_conflicting())
      return { ok: !1, reason: "conflicting", movable: !1, frozenParams: 0, conflicting: wt().conflicting };
    l && Gt();
    const t = nt();
    let s = null, y = null;
    if (m.kind === "spline" || yt.has(m.kind))
      y = m.pts.map((h) => {
        const x = k.get(h), O = [t[x[0]], t[x[1]]], u = [V(O[0], !0, "#dragm", "u"), V(O[1], !0, "#dragm", "v")];
        return E([$(u), $(x)], (a, i) => e.add_constraint_p2p_coincident(a, i, ft, !0, 1)), { t: u, start: O };
      });
    else if (m.kind === "line")
      s = [[t[m.p1[0]], t[m.p1[1]]], [t[m.p2[0]], t[m.p2[1]]]], at(s[0], R[0]), at(s[1], Q[0]), E([$(R), $(m.p1)], (h, x) => e.add_constraint_p2p_coincident(h, x, ft, !0, 1)), E([$(Q), $(m.p2)], (h, x) => e.add_constraint_p2p_coincident(h, x, ft, !0, 1));
    else {
      at(c, R[0]), at([t[m.c[0]], t[m.c[1]]], Q[0]);
      const h = { c: m.c, r: m.r };
      E([$(R), U(h)], (x, O) => e.add_constraint_point_on_circle(x, O, ft, !0, 1)), E([$(Q), $(m.c)], (x, O) => e.add_constraint_p2p_coincident(x, O, ft, !0, 1));
    }
    e.init_solution(Z.DOGLEG), A = { kind: y ? "multi" : m.kind === "line" ? "line" : "radius", entity: n, ends: s, multi: y, init: [...c], grab: [...c], step: 0, reinits: 0, freeze: l, frozen: K.length };
    const o = m.params.some((h) => !K.includes(h));
    return { ok: !0, at: [...c], movable: o, frozenParams: K.length };
  }
  function vn(n, c, { reinit: l = "far", full: m = !0 } = {}) {
    if (!A) return { status: "idle" };
    const t = Math.hypot(n - A.init[0], c - A.init[1]);
    if (l === "always" || A.step > 0 && t > 20 * A.step) {
      if (e.init_solution(Z.DOGLEG), A.kind === "point") {
        const y = nt(), o = mt(A.pointId);
        A.init = [y[o[0]], y[o[1]]];
      } else
        A.init = [n, c];
      A.step = 0, A.reinits += 1;
    } else A.step === 0 && (A.step = t);
    if (A.kind === "multi") {
      const y = n - A.grab[0], o = c - A.grab[1];
      for (const h of A.multi) at([h.start[0] + y, h.start[1] + o], h.t[0]);
    } else if (A.kind === "line") {
      const y = n - A.grab[0], o = c - A.grab[1];
      at([A.ends[0][0] + y, A.ends[0][1] + o], R[0]), at([A.ends[1][0] + y, A.ends[1][1] + o], Q[0]);
    } else
      at([n, c], R[0]);
    const s = $t(!1);
    return Y++, { status: s ? "ok" : "failed", values: m ? gt(ot) : void 0 };
  }
  function Mn() {
    return A && (e.clear_by_id(ft), ut(), A = null), kt();
  }
  function Ot() {
    A && A.freeze && (Gt(), e.init_solution(Z.DOGLEG), A.frozen = K.length);
  }
  function En() {
    if (!g) throw new Error("load() a sketch first");
    const n = performance.now();
    ut();
    const c = e.diagnose_fresh(Z.DOGLEG);
    ht = Y;
    const l = bt(e.get_dependent_params());
    Ot();
    const m = new Set(l), t = wt(), s = /* @__PURE__ */ new Set();
    for (const x of [...t.conflicting, ...t.redundant])
      for (const O of v.get(x).refs) s.add(O);
    const y = {};
    for (const [x, O] of f)
      s.has(x) || O.pts.some((u) => s.has(u)) ? y[x] = "over" : y[x] = O.params.some((u) => m.has(u)) ? "under" : "fully";
    const o = {};
    for (const [x, [O, u]] of k)
      s.has(x) ? o[x] = "over" : o[x] = m.has(O) || m.has(u) ? "under" : "fully";
    const h = l.map((x) => T[x] ? `${T[x].owner}.${T[x].name}` : `#${x}`);
    return { dof: c, perEntity: y, perPoint: o, dependentParams: h, ...t, ms: performance.now() - n };
  }
  function Pn() {
    return { params: F, initMs: D, dragging: !!A, dragReinits: A ? A.reinits : 0, frozenParams: K.length, heapBytes: S.HEAPF64.buffer.byteLength };
  }
  function xn() {
    e.clear_data(), e.delete();
  }
  return { load: Kt, solve: kt, dragStart: yn, dragStartEntity: bn, dragMove: vn, dragEnd: Mn, setValue: kn, analyze: En, values: () => gt(), stats: Pn, dispose: xn, _internals: () => ({ M: S, gcs: e, pointParams: k, entityInfo: f, consInfo: v, dragTarget: R, frozen: K, paramOwner: T }) };
}
const jn = /* @__PURE__ */ new Set(["load", "solve", "dragStart", "dragStartEntity", "dragMove", "dragEnd", "setValue", "analyze", "values", "stats"]), In = "planegcs.mjs", ln = new URL(In, import.meta.url).href, vt = (r) => self.postMessage(r);
let Ft = null, _t = null;
const Pt = [];
let Dt = !1;
function fn(r) {
  if (!_t) throw new Error("the solver is not ready");
  return _t.load(r), _t.solve();
}
function Dn(r) {
  return { solve: fn(r), analysis: _t.analyze() };
}
async function zn(r) {
  const { id: p, op: w, params: b } = r;
  try {
    const M = Array.isArray(b) ? b : b === void 0 ? [] : [b];
    let P;
    if (w === "solveOnce" || w === "analyzeOnce")
      _t || (_t = await cn({ moduleUrl: ln })), P = w === "solveOnce" ? fn(M[0]) : Dn(M[0]);
    else {
      if (!jn.has(w)) throw new Error(`unknown op "${w}"`);
      P = Ft[w](...M);
    }
    vt({ type: "result", id: p, ok: !0, result: P });
  } catch (M) {
    vt({ type: "result", id: p, ok: !1, error: an(M) });
  }
}
async function Tn() {
  for (; Pt.length; ) {
    const r = Pt.shift();
    if (r.op === "dragMove" && Pt.some((p) => p.op === "dragMove")) {
      vt({ type: "result", id: r.id, ok: !0, result: { superseded: !0 } });
      continue;
    }
    await zn(r);
  }
  Dt = !1;
}
function dn() {
  Dt || !Ft || (Dt = !0, setTimeout(() => void Tn(), 0));
}
self.addEventListener("message", (r) => {
  const p = r.data;
  !p || p.type !== "call" || (Pt.push(p), dn());
});
try {
  const r = performance.now();
  Ft = await cn({ moduleUrl: ln }), vt({ type: "ready", solver: "planegcs", initMs: performance.now() - r }), dn();
} catch (r) {
  vt({ type: "error", error: an(r) });
}
