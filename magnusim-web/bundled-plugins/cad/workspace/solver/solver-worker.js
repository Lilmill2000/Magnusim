const P = { BFGS: 0, LM: 1, DOGLEG: 2 }, gn = { Success: 0, Converged: 1, Failed: 2 }, V = -1, Wn = 0, cn = Math.PI / 180;
class O extends Error {
}
function tn(k) {
  const M = new Array(k.size());
  for (let S = 0; S < M.length; S++) M[S] = k.get(S);
  return k.delete(), M;
}
function mn(k) {
  for (; k <= -Math.PI; ) k += 2 * Math.PI;
  for (; k > Math.PI; ) k -= 2 * Math.PI;
  return k;
}
async function Ln({ moduleUrl: k, wasmUrl: M, moduleFactory: S, dlGaussStep: N = 3, sparseSqpMinParams: q = 64 } = {}) {
  let U = S;
  if (!U) {
    const n = "planegcs.mjs";
    U = (await import(k ?? new URL(n, import.meta.url).href)).default;
  }
  const wn = {};
  M && (wn.locateFile = (n) => n.endsWith(".wasm") ? M : n);
  const On = performance.now(), sn = await U(wn), Sn = performance.now() - On, i = new sn.GcsSystem();
  typeof i.set_dl_gauss_step == "function" && i.set_dl_gauss_step(N), typeof i.set_sparse_sqp_min_params == "function" && i.set_sparse_sqp_min_params(q);
  let H = null, I = /* @__PURE__ */ new Map(), G = /* @__PURE__ */ new Map(), C = /* @__PURE__ */ new Map(), dn = /* @__PURE__ */ new Map(), R = [], K = 0, A = null, W = null, h = null, X = null, L = [], j = 0, J = -1;
  const yn = () => sn.HEAPF64;
  function D() {
    const n = i.params_to_buffer();
    return yn().slice(n >>> 3, (n >>> 3) + K);
  }
  function F(n, a = 0) {
    const l = i.input_buffer(n.length);
    yn().set(n, l >>> 3), i.params_from_buffer(a, n.length);
  }
  function $(n, a, l, d) {
    const t = i.push_p_param(n, a);
    return R[t] = { owner: l, name: d, fixed: a }, K = t + 1, t;
  }
  function _(n, a) {
    const l = [];
    try {
      for (const d of n) l.push(d());
      return a(...l);
    } finally {
      for (const d of l) d.delete();
    }
  }
  const g = (n) => () => i.make_point(n[0], n[1]), v = (n) => () => i.make_line(n.p1[0], n.p1[1], n.p2[0], n.p2[1]), b = (n) => () => i.make_circle(n.c[0], n.c[1], n.r), x = (n) => () => i.make_arc(n.c[0], n.c[1], n.s[0], n.s[1], n.e[0], n.e[1], n.a0, n.a1, n.r), vn = (n) => n.kind === "line" ? v(n) : n.kind === "arc" ? x(n) : b(n);
  function bn(n) {
    return n.kind === "line" ? n.pts : n.kind === "arc" ? [n.pts[1], n.pts[2]] : [];
  }
  function An(n, a) {
    const l = bn(G.get(n)), d = new Set(bn(G.get(a)));
    return l.find((t) => d.has(t)) ?? null;
  }
  function Gn(n, a, l) {
    return n.kind === "line" ? [-(l[n.p2[1]] - l[n.p1[1]]), l[n.p2[0]] - l[n.p1[0]]] : [l[n.c[0]] - l[a[0]], l[n.c[1]] - l[a[1]]];
  }
  function En(n) {
    if (I.has(n)) return "point";
    const a = G.get(n);
    return a ? a.kind === "point" ? "point" : a.kind : null;
  }
  function Q(n) {
    if (I.has(n)) return I.get(n);
    const a = G.get(n);
    return a && a.kind === "point" ? a.p : null;
  }
  function Dn(n, a) {
    const l = (p) => {
      const e = Q(p);
      return [a[e[0]], a[e[1]]];
    }, d = n.refs.map(En), t = (p) => {
      const e = G.get(p);
      return [[a[e.p1[0]], a[e.p1[1]]], [a[e.p2[0]], a[e.p2[1]]]];
    }, r = (p, e) => Math.hypot(e[0] - p[0], e[1] - p[1]);
    switch (n.kind) {
      case "distance":
        return d.length === 1 && d[0] === "line" ? r(...t(n.refs[0])) : d[0] === "point" && d[1] === "point" ? r(l(n.refs[0]), l(n.refs[1])) : null;
      case "distance_x":
      case "distance_y": {
        const p = n.kind === "distance_x" ? 0 : 1;
        if (d.length === 1 && d[0] === "line") {
          const [e, m] = t(n.refs[0]);
          return m[p] - e[p];
        }
        return d.length === 1 ? l(n.refs[0])[p] : l(n.refs[1])[p] - l(n.refs[0])[p];
      }
      case "radius":
      case "diameter": {
        const p = G.get(n.refs[0]), e = a[p.r];
        return n.kind === "radius" ? e : 2 * e;
      }
      case "angle": {
        const p = (e) => {
          const [m, w] = t(e);
          return Math.atan2(w[1] - m[1], w[0] - m[0]);
        };
        return d.length === 1 ? mn(p(n.refs[0])) / cn : mn(p(n.refs[1]) - p(n.refs[0])) / cn;
      }
      default:
        return null;
    }
  }
  function zn(n, a) {
    const l = n.id, d = n.refs ?? [], t = d.map((o) => {
      const s = En(o);
      if (!s) throw new O(`constraint ${l}: reference "${o}" not found`);
      return s;
    }), r = t.join(","), p = { tag: a, kind: n.kind, refs: d, valueParams: [], driving: !0 }, e = (o) => G.get(d[o]), m = (o) => Q(d[o]), w = (o, s = n.value) => {
      if (typeof s != "number" || !Number.isFinite(s))
        throw new O(`constraint ${l}: numeric value required`);
      const c = $(o === "deg" ? s * cn : s, !0, l, "value");
      return p.valueParams.push({ idx: c, unit: o }), c;
    }, y = () => {
      throw new O(`constraint ${l}: kind "${n.kind}" does not accept refs (${r})`);
    }, u = a;
    switch (n.kind) {
      case "coincident":
        r === "point,point" ? _([g(m(0)), g(m(1))], (o, s) => i.add_constraint_p2p_coincident(o, s, u, !0, 1)) : r === "point,line" ? _([g(m(0)), v(e(1))], (o, s) => i.add_constraint_point_on_line_pl(o, s, u, !0, 1)) : r === "point,circle" || r === "point,arc" ? _([g(m(0)), b(e(1))], (o, s) => i.add_constraint_point_on_circle(o, s, u, !0, 1)) : y();
        break;
      case "horizontal":
      case "vertical": {
        const o = n.kind;
        r === "line" ? _([v(e(0))], (s) => i[`add_constraint_${o}_l`](s, u, !0, 1)) : r === "point,point" ? _([g(m(0)), g(m(1))], (s, c) => i[`add_constraint_${o}_pp`](s, c, u, !0, 1)) : y();
        break;
      }
      case "parallel":
        r === "line,line" ? _([v(e(0)), v(e(1))], (o, s) => i.add_constraint_parallel(o, s, u, !0, 1)) : y();
        break;
      case "perpendicular":
        r === "line,line" ? _([v(e(0)), v(e(1))], (o, s) => i.add_constraint_perpendicular_ll(o, s, u, !0, 1)) : y();
        break;
      case "tangent": {
        const o = (c) => c === "line" || c === "arc" || c === "circle";
        let s = null;
        if (d.length === 3 && o(t[0]) && o(t[1]) && t[2] === "point" ? s = d[2] : d.length === 2 && o(t[0]) && o(t[1]) && (s = An(d[0], d[1])), s) {
          const c = e(0), f = e(1), E = Q(s), z = D(), T = Gn(c, E, z), B = Gn(f, E, z), on = Math.atan2(-B[0] * T[1] + B[1] * T[0], B[0] * T[0] + B[1] * T[1]), _n = Math.abs(mn(on)) > Math.PI / 2 ? Math.PI : 0, Mn = $(_n, !0, l, "angle");
          p.valueParams.push({ idx: Mn, unit: "internal" }), _([vn(c), vn(f), g(E)], (Nn, Hn, Kn) => i.add_constraint_angle_via_point(Nn, Hn, Kn, Mn, u, !0, 1));
          break;
        }
        r === "line,circle" ? _([v(e(0)), b(e(1))], (c, f) => i.add_constraint_tangent_lc(c, f, u, !0, 1)) : r === "circle,line" ? _([v(e(1)), b(e(0))], (c, f) => i.add_constraint_tangent_lc(c, f, u, !0, 1)) : r === "line,arc" ? _([v(e(0)), x(e(1))], (c, f) => i.add_constraint_tangent_la(c, f, u, !0, 1)) : r === "arc,line" ? _([v(e(1)), x(e(0))], (c, f) => i.add_constraint_tangent_la(c, f, u, !0, 1)) : r === "circle,circle" ? _([b(e(0)), b(e(1))], (c, f) => i.add_constraint_tangent_cc(c, f, u, !0, 1)) : r === "arc,arc" ? _([x(e(0)), x(e(1))], (c, f) => i.add_constraint_tangent_aa(c, f, u, !0, 1)) : r === "circle,arc" ? _([b(e(0)), x(e(1))], (c, f) => i.add_constraint_tangent_ca(c, f, u, !0, 1)) : r === "arc,circle" ? _([b(e(1)), x(e(0))], (c, f) => i.add_constraint_tangent_ca(c, f, u, !0, 1)) : y();
        break;
      }
      case "equal":
        r === "line,line" ? _([v(e(0)), v(e(1))], (o, s) => i.add_constraint_equal_length(o, s, u, !0, 1)) : r === "circle,circle" ? _([b(e(0)), b(e(1))], (o, s) => i.add_constraint_equal_radius_cc(o, s, u, !0, 1)) : r === "circle,arc" ? _([b(e(0)), x(e(1))], (o, s) => i.add_constraint_equal_radius_ca(o, s, u, !0, 1)) : r === "arc,circle" ? _([b(e(1)), x(e(0))], (o, s) => i.add_constraint_equal_radius_ca(o, s, u, !0, 1)) : r === "arc,arc" ? _([x(e(0)), x(e(1))], (o, s) => i.add_constraint_equal_radius_aa(o, s, u, !0, 1)) : y();
        break;
      case "distance": {
        const o = () => w("mm");
        if (r === "line") {
          const s = e(0), c = o();
          _([g(s.p1), g(s.p2)], (f, E) => i.add_constraint_p2p_distance(f, E, c, u, !0, 1));
        } else if (r === "point,point") {
          const s = o();
          _([g(m(0)), g(m(1))], (c, f) => i.add_constraint_p2p_distance(c, f, s, u, !0, 1));
        } else if (r === "point,line") {
          const s = o();
          _([g(m(0)), v(e(1))], (c, f) => i.add_constraint_p2l_distance(c, f, s, u, !0, 1));
        } else if (r === "line,point") {
          const s = o();
          _([g(m(1)), v(e(0))], (c, f) => i.add_constraint_p2l_distance(c, f, s, u, !0, 1));
        } else if (r === "line,line") {
          const s = o();
          _([g(e(0).p1), v(e(1))], (c, f) => i.add_constraint_p2l_distance(c, f, s, u, !0, 1));
        } else if (r === "point,circle" || r === "point,arc") {
          const s = o();
          _([g(m(0)), b(e(1))], (c, f) => i.add_constraint_p2cdistance(c, f, s, u, !0, 1));
        } else if (r === "circle,circle") {
          const s = o();
          _([b(e(0)), b(e(1))], (c, f) => i.add_constraint_c2cdistance(c, f, s, u, !0, 1));
        } else if (r === "circle,line") {
          const s = o();
          _([b(e(0)), v(e(1))], (c, f) => i.add_constraint_c2ldistance(c, f, s, u, !0, 1));
        } else if (r === "line,circle") {
          const s = o();
          _([b(e(1)), v(e(0))], (c, f) => i.add_constraint_c2ldistance(c, f, s, u, !0, 1));
        } else y();
        break;
      }
      case "distance_x":
      case "distance_y": {
        const o = n.kind === "distance_x" ? 0 : 1;
        let s, c;
        if (r === "line")
          s = e(0).p1, c = e(0).p2;
        else if (r === "point,point")
          s = m(0), c = m(1);
        else if (r === "point") {
          const E = w("mm");
          _([g(m(0))], (z) => i[o === 0 ? "add_constraint_coordinate_x" : "add_constraint_coordinate_y"](z, E, u, !0, 1));
          break;
        } else y();
        const f = w("mm");
        i.add_constraint_difference(s[o], c[o], f, u, !0, 1);
        break;
      }
      case "radius":
      case "diameter": {
        const o = n.kind, s = w("mm");
        r === "circle" ? _([b(e(0))], (c) => i[`add_constraint_circle_${o}`](c, s, u, !0, 1)) : r === "arc" ? _([x(e(0))], (c) => i[`add_constraint_arc_${o}`](c, s, u, !0, 1)) : y();
        break;
      }
      case "angle": {
        const o = w("deg");
        if (r === "line,line") _([v(e(0)), v(e(1))], (s, c) => i.add_constraint_l2l_angle_ll(s, c, o, u, !0, 1));
        else if (r === "line") {
          const s = e(0);
          _([g(s.p1), g(s.p2)], (c, f) => i.add_constraint_p2p_angle_incr_angle(c, f, o, 0, u, !0, 1));
        } else y();
        break;
      }
      case "midpoint":
        if (r === "point,line") {
          const o = e(1);
          _([g(o.p1), g(o.p2), g(m(0))], (s, c, f) => i.add_constraint_p2p_symmetric_ppp(s, c, f, u, !0, 1));
        } else if (r === "line,point") {
          const o = e(0);
          _([g(o.p1), g(o.p2), g(m(1))], (s, c, f) => i.add_constraint_p2p_symmetric_ppp(s, c, f, u, !0, 1));
        } else y();
        break;
      case "symmetric":
        r === "point,point,line" ? _([g(m(0)), g(m(1)), v(e(2))], (o, s, c) => i.add_constraint_p2p_symmetric_ppl(o, s, c, u, !0, 1)) : r === "point,point,point" ? _([g(m(0)), g(m(1)), g(m(2))], (o, s, c) => i.add_constraint_p2p_symmetric_ppp(o, s, c, u, !0, 1)) : y();
        break;
      case "point_on_line":
        r === "point,line" ? _([g(m(0)), v(e(1))], (o, s) => i.add_constraint_point_on_line_pl(o, s, u, !0, 1)) : y();
        break;
      case "point_on_circle":
        r === "point,circle" || r === "point,arc" ? _([g(m(0)), b(e(1))], (o, s) => i.add_constraint_point_on_circle(o, s, u, !0, 1)) : y();
        break;
      case "concentric": {
        const o = (s) => s === "circle" || s === "arc";
        t.length === 2 && o(t[0]) && o(t[1]) ? _([g(e(0).c), g(e(1).c)], (s, c) => i.add_constraint_p2p_coincident(s, c, u, !0, 1)) : y();
        break;
      }
      case "fix": {
        const o = D(), s = (c, f) => {
          const E = $(f ? f[0] : o[c[0]], !0, l, "value_u"), z = $(f ? f[1] : o[c[1]], !0, l, "value_v");
          p.valueParams.push({ idx: E, unit: "mm" }, { idx: z, unit: "mm" }), _([g(c)], (T) => {
            i.add_constraint_coordinate_x(T, E, u, !0, 1), i.add_constraint_coordinate_y(T, z, u, !0, 1);
          });
        };
        if (r === "point") s(m(0), Array.isArray(n.value) ? n.value : null);
        else if (r === "line")
          s(e(0).p1), s(e(0).p2);
        else if (r === "circle") {
          const c = e(0);
          s(c.c);
          const f = $(o[c.r], !0, l, "value_r");
          p.valueParams.push({ idx: f, unit: "mm" }), _([b(c)], (E) => i.add_constraint_circle_radius(E, f, u, !0, 1));
        } else if (r === "arc") {
          const c = e(0);
          s(c.c), s(c.s), s(c.e);
        } else y();
        break;
      }
      default:
        throw new O(`constraint ${l}: unknown kind "${n.kind}"`);
    }
    return p;
  }
  function Tn(n) {
    h = null, L = [], j++, i.clear_data(), I = /* @__PURE__ */ new Map(), G = /* @__PURE__ */ new Map(), C = /* @__PURE__ */ new Map(), dn = /* @__PURE__ */ new Map(), R = [], K = 0, H = n;
    for (const [t, r] of Object.entries(n.points ?? {}))
      I.set(t, [$(r[0], !1, t, "u"), $(r[1], !1, t, "v")]);
    const a = (t, r) => {
      const p = I.get(t);
      if (!p) throw new O(`entity ${r}: point "${t}" not found`);
      return p;
    }, l = (t) => n.points[t];
    for (const t of n.entities ?? [])
      switch (t.kind) {
        case "point":
          G.set(t.id, { kind: "point", p: a(t.p, t.id), pts: [t.p], params: [...a(t.p, t.id)] });
          break;
        case "line": {
          const r = a(t.p[0], t.id), p = a(t.p[1], t.id);
          G.set(t.id, { kind: "line", p1: r, p2: p, pts: [t.p[0], t.p[1]], params: [...r, ...p] });
          break;
        }
        case "circle": {
          const r = a(t.c, t.id), p = $(t.r, !1, t.id, "r");
          G.set(t.id, { kind: "circle", c: r, r: p, pts: [t.c], params: [...r, p] });
          break;
        }
        case "arc": {
          const r = t.ccw !== !1, p = r ? t.a : t.b, e = r ? t.b : t.a, m = a(t.c, t.id), w = a(p, t.id), y = a(e, t.id), u = l(t.c), o = l(p), s = l(e), c = Math.hypot(o[0] - u[0], o[1] - u[1]);
          let f = Math.atan2(o[1] - u[1], o[0] - u[0]), E = Math.atan2(s[1] - u[1], s[0] - u[0]);
          for (; E <= f; ) E += 2 * Math.PI;
          const z = $(c, !1, t.id, "r"), T = $(f, !1, t.id, "a0"), B = $(E, !1, t.id, "a1"), on = { kind: "arc", c: m, s: w, e: y, r: z, a0: T, a1: B, pts: [t.c, t.a, t.b], params: [...m, ...w, ...y, z, T, B] };
          G.set(t.id, on), _([x(on)], (_n) => i.add_constraint_arc_rules(_n, Wn, !0, 1));
          break;
        }
        default:
          throw new O(`entity ${t.id}: unknown kind "${t.kind}"`);
      }
    A = [$(0, !0, "#drag", "u"), $(0, !0, "#drag", "v")], W = [$(0, !0, "#drag2", "u"), $(0, !0, "#drag2", "v")];
    let d = 0;
    for (const t of n.constraints ?? []) {
      if (C.has(t.id)) throw new O(`constraint ${t.id}: duplicate id`);
      if (t.driving === !1) {
        C.set(t.id, { tag: null, kind: t.kind, refs: t.refs ?? [], valueParams: [], driving: !1 });
        continue;
      }
      d += 1;
      const r = zn(t, d);
      C.set(t.id, r), dn.set(d, t.id);
    }
    return X = D(), { params: K, unknowns: R.filter((t) => !t.fixed).length, constraints: d };
  }
  function an(n = D()) {
    const a = {};
    for (const [t, [r, p]] of I) a[t] = [n[r], n[p]];
    const l = {};
    for (const [t, r] of G) (r.kind === "circle" || r.kind === "arc") && (l[t] = n[r.r]);
    const d = {};
    for (const [t, r] of C) r.driving || (d[t] = Dn(r, n));
    return { points: a, radii: l, measures: d };
  }
  const un = (n) => n.map((a) => dn.get(a)).filter((a) => a !== void 0);
  function Y() {
    return {
      conflicting: un(tn(i.get_conflicting())),
      redundant: un(tn(i.get_redundant())),
      partiallyRedundant: un(tn(i.get_partially_redundant()))
    };
  }
  function Pn(n = !0) {
    const a = n ? [P.DOGLEG, P.LM, P.BFGS] : [P.DOGLEG], l = i.has_redundant() && !i.has_conflicting(), d = (r) => r === gn.Success || r === gn.Converged && l;
    let t = gn.Failed;
    for (const r of a)
      if (t = i.solve_prepared(r), d(t)) break;
    return d(t) ? (i.apply_solution(), X = D(), !0) : (F(X), !1);
  }
  function qn(n, a) {
    return a.conflicting.length ? "conflicting" : n ? a.redundant.length ? "redundant" : "ok" : "failed";
  }
  function Z() {
    if (!H) throw new Error("load() a sketch first");
    const n = performance.now();
    if (nn(), i.init_solution(P.DOGLEG), i.has_conflicting()) {
      const t = Y(), r = i.dof();
      return pn(), { status: "conflicting", solved: !1, dof: r, ...t, values: an(X), ms: performance.now() - n };
    }
    const a = Pn(!0);
    j++;
    const l = Y(), d = i.dof();
    return pn(), { status: qn(a, l), solved: a, dof: d, ...l, values: an(X), ms: performance.now() - n };
  }
  function In(n, a) {
    const l = C.get(n);
    if (!l) throw new O(`constraint ${n} not found`);
    const d = H.constraints.find((t) => t.id === n);
    if (d.value = a, !l.driving) return Z();
    if (l.kind === "fix") {
      if (!Array.isArray(a) || l.valueParams.length !== 2) throw new O(`constraint ${n}: fix takes [u, v] on a point`);
      i.set_p_param(l.valueParams[0].idx, a[0], !0), i.set_p_param(l.valueParams[1].idx, a[1], !0);
    } else {
      const t = l.valueParams[0];
      if (!t) throw new O(`constraint ${n} has no value`);
      i.set_p_param(t.idx, t.unit === "deg" ? a * cn : a, !0);
    }
    return Z();
  }
  function fn() {
    const n = new Set(tn(i.get_dependent_params())), a = D();
    for (let l = 0; l < K; l++) {
      const d = R[l];
      d && !d.fixed && !n.has(l) && (i.set_p_param(l, a[l], !0), L.push(l));
    }
  }
  function nn() {
    if (!L.length) return;
    const n = D();
    for (const a of L) i.set_p_param(a, n[a], !1);
    L = [];
  }
  function Fn(n, { freeze: a = !0 } = {}) {
    if (!H) throw new Error("load() a sketch first");
    const l = Q(n);
    if (!l) throw new O(`point "${n}" not found`);
    if (i.clear_by_id(V), nn(), h = null, a && J !== j ? (i.diagnose_fresh(P.DOGLEG), J = j) : i.init_solution(P.DOGLEG), i.has_conflicting())
      return { ok: !1, reason: "conflicting", movable: !1, frozenParams: 0, conflicting: Y().conflicting };
    a && fn();
    const d = D(), t = [d[l[0]], d[l[1]]];
    F(t, A[0]), _([g(A), g(l)], (p, e) => i.add_constraint_p2p_coincident(p, e, V, !0, 1)), i.init_solution(P.DOGLEG), h = { kind: "point", pointId: n, init: t, grab: t, step: 0, reinits: 0, freeze: a, frozen: L.length };
    const r = !L.includes(l[0]) || !L.includes(l[1]);
    return { ok: !0, at: t, movable: r, frozenParams: L.length };
  }
  function Cn(n, a, { freeze: l = !0 } = {}) {
    if (!H) throw new Error("load() a sketch first");
    const d = G.get(n);
    if (!d || d.kind === "point") throw new O(`entity "${n}" cannot be dragged as a whole`);
    if (!Array.isArray(a) || a.length !== 2) throw new O("dragStartEntity needs the grab point [u, v]");
    if (i.clear_by_id(V), nn(), h = null, l && J !== j ? (i.diagnose_fresh(P.DOGLEG), J = j) : i.init_solution(P.DOGLEG), i.has_conflicting())
      return { ok: !1, reason: "conflicting", movable: !1, frozenParams: 0, conflicting: Y().conflicting };
    l && fn();
    const t = D();
    let r = null;
    if (d.kind === "line")
      r = [[t[d.p1[0]], t[d.p1[1]]], [t[d.p2[0]], t[d.p2[1]]]], F(r[0], A[0]), F(r[1], W[0]), _([g(A), g(d.p1)], (e, m) => i.add_constraint_p2p_coincident(e, m, V, !0, 1)), _([g(W), g(d.p2)], (e, m) => i.add_constraint_p2p_coincident(e, m, V, !0, 1));
    else {
      F(a, A[0]), F([t[d.c[0]], t[d.c[1]]], W[0]);
      const e = { c: d.c, r: d.r };
      _([g(A), b(e)], (m, w) => i.add_constraint_point_on_circle(m, w, V, !0, 1)), _([g(W), g(d.c)], (m, w) => i.add_constraint_p2p_coincident(m, w, V, !0, 1));
    }
    i.init_solution(P.DOGLEG), h = { kind: d.kind === "line" ? "line" : "radius", entity: n, ends: r, init: [...a], grab: [...a], step: 0, reinits: 0, freeze: l, frozen: L.length };
    const p = d.params.some((e) => !L.includes(e));
    return { ok: !0, at: [...a], movable: p, frozenParams: L.length };
  }
  function Rn(n, a, { reinit: l = "far", full: d = !0 } = {}) {
    if (!h) return { status: "idle" };
    const t = Math.hypot(n - h.init[0], a - h.init[1]);
    if (l === "always" || h.step > 0 && t > 20 * h.step) {
      if (i.init_solution(P.DOGLEG), h.kind === "point") {
        const p = D(), e = Q(h.pointId);
        h.init = [p[e[0]], p[e[1]]];
      } else
        h.init = [n, a];
      h.step = 0, h.reinits += 1;
    } else h.step === 0 && (h.step = t);
    if (h.kind === "line") {
      const p = n - h.grab[0], e = a - h.grab[1];
      F([h.ends[0][0] + p, h.ends[0][1] + e], A[0]), F([h.ends[1][0] + p, h.ends[1][1] + e], W[0]);
    } else
      F([n, a], A[0]);
    const r = Pn(!1);
    return j++, { status: r ? "ok" : "failed", values: d ? an(X) : void 0 };
  }
  function jn() {
    return h && (i.clear_by_id(V), nn(), h = null), Z();
  }
  function pn() {
    h && h.freeze && (fn(), i.init_solution(P.DOGLEG), h.frozen = L.length);
  }
  function Vn() {
    if (!H) throw new Error("load() a sketch first");
    const n = performance.now();
    nn();
    const a = i.diagnose_fresh(P.DOGLEG);
    J = j;
    const l = tn(i.get_dependent_params());
    pn();
    const d = new Set(l), t = Y(), r = /* @__PURE__ */ new Set();
    for (const w of [...t.conflicting, ...t.redundant])
      for (const y of C.get(w).refs) r.add(y);
    const p = {};
    for (const [w, y] of G)
      r.has(w) || y.pts.some((u) => r.has(u)) ? p[w] = "over" : p[w] = y.params.some((u) => d.has(u)) ? "under" : "fully";
    const e = {};
    for (const [w, [y, u]] of I)
      r.has(w) ? e[w] = "over" : e[w] = d.has(y) || d.has(u) ? "under" : "fully";
    const m = l.map((w) => R[w] ? `${R[w].owner}.${R[w].name}` : `#${w}`);
    return { dof: a, perEntity: p, perPoint: e, dependentParams: m, ...t, ms: performance.now() - n };
  }
  function Un() {
    return { params: K, initMs: Sn, dragging: !!h, dragReinits: h ? h.reinits : 0, frozenParams: L.length, heapBytes: sn.HEAPF64.buffer.byteLength };
  }
  function Bn() {
    i.clear_data(), i.delete();
  }
  return { load: Tn, solve: Z, dragStart: Fn, dragStartEntity: Cn, dragMove: Rn, dragEnd: jn, setValue: In, analyze: Vn, values: () => an(), stats: Un, dispose: Bn, _internals: () => ({ M: sn, gcs: i, pointParams: I, entityInfo: G, consInfo: C, dragTarget: A, frozen: L, paramOwner: R }) };
}
const Xn = /* @__PURE__ */ new Set(["load", "solve", "dragStart", "dragStartEntity", "dragMove", "dragEnd", "setValue", "analyze", "values", "stats"]), Jn = "planegcs.mjs", $n = new URL(Jn, import.meta.url).href, rn = (k) => self.postMessage(k);
let kn = null, en = null;
const ln = [];
let hn = !1;
function Qn(k) {
  if (!en) throw new Error("the solver is not ready");
  return en.load(k), en.solve();
}
async function Yn(k) {
  const { id: M, op: S, params: N } = k;
  try {
    const q = Array.isArray(N) ? N : N === void 0 ? [] : [N];
    let U;
    if (S === "solveOnce")
      en || (en = await Ln({ moduleUrl: $n })), U = Qn(q[0]);
    else {
      if (!Xn.has(S)) throw new Error(`unknown op "${S}"`);
      U = kn[S](...q);
    }
    rn({ type: "result", id: M, ok: !0, result: U });
  } catch (q) {
    rn({ type: "result", id: M, ok: !1, error: String(q && q.message ? q.message : q) });
  }
}
async function Zn() {
  for (; ln.length; ) {
    const k = ln.shift();
    if (k.op === "dragMove" && ln.some((M) => M.op === "dragMove")) {
      rn({ type: "result", id: k.id, ok: !0, result: { superseded: !0 } });
      continue;
    }
    await Yn(k);
  }
  hn = !1;
}
function xn() {
  hn || !kn || (hn = !0, setTimeout(() => void Zn(), 0));
}
self.addEventListener("message", (k) => {
  const M = k.data;
  !M || M.type !== "call" || (ln.push(M), xn());
});
try {
  const k = performance.now();
  kn = await Ln({ moduleUrl: $n }), rn({ type: "ready", solver: "planegcs", initMs: performance.now() - k }), xn();
} catch (k) {
  rn({ type: "error", error: String(k && k.message ? k.message : k) });
}
