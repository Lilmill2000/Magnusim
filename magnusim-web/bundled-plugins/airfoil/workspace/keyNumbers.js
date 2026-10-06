// SPDX-License-Identifier: GPL-3.0-or-later
// The numbers a polar is read by, from its rows ({alpha, cl, cd?, cm?}): the most lift and
// whether the curve turned over (stall), the lift slope, the zero-lift angle, the least
// drag, the best lift-to-drag ratio and the pitching moment at zero angle. Pure: the page
// shows them, the tests check them.

const RAD = 180 / Math.PI;

/** Least squares y = a + b·x over points [{x, y}]. */
function fitLine(points) {
  const n = points.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    sxy += p.x * p.y;
  }
  const d = n * sxx - sx * sx;
  if (!(n >= 2) || Math.abs(d) < 1e-12) return null;
  const b = (n * sxy - sx * sy) / d;
  return { a: (sy - b * sx) / n, b };
}

/** y at x by straight lines between the rows (null outside them). */
function at(rows, key, x) {
  for (let i = 0; i + 1 < rows.length; i++) {
    const p = rows[i];
    const q = rows[i + 1];
    if (x >= p.alpha && x <= q.alpha && Number.isFinite(p[key]) && Number.isFinite(q[key])) {
      const f = q.alpha === p.alpha ? 0 : (x - p.alpha) / (q.alpha - p.alpha);
      return p[key] + f * (q[key] - p[key]);
    }
  }
  return null;
}

/**
 * The key numbers of one polar, or null with fewer than 2 angles.
 * - clMax {cl, alpha, stalled}: stalled only when Cl turns over inside the range (a maximum
 *   at the last angle means "still rising: no stall in this range").
 * - slope {perDeg, perRad, from, to}: least squares over the straight part: angles from
 *   −5° up to 8°, and at least 3° short of Cl max when the curve stalled.
 * - alpha0 {alpha, extrapolated}: where Cl crosses zero; from the slope line when no angle
 *   in the range has Cl ≤ 0.
 * - cdMin {cd, alpha}, bestLd {ld, alpha}: over the angles that have a drag.
 * - cm0: Cm at α = 0° (between the nearest angles), null when 0° is outside the range.
 * - range {from, to}: the angles the polar has.
 */
export function keyNumbers(rows) {
  const pts = (rows || [])
    .filter((r) => r && Number.isFinite(r.alpha) && Number.isFinite(r.cl))
    .map((r) => ({ alpha: Number(r.alpha), cl: Number(r.cl), cd: Number(r.cd), cm: Number(r.cm) }))
    .sort((p, q) => p.alpha - q.alpha);
  if (pts.length < 2) return null;
  let iMax = 0;
  pts.forEach((p, i) => {
    if (p.cl > pts[iMax].cl) iMax = i;
  });
  const top = pts[iMax];
  const stalled = iMax < pts.length - 1;
  const clMax = { cl: top.cl, alpha: top.alpha, stalled };

  const upTo = Math.min(8, stalled ? top.alpha - 3 : Infinity);
  let straight = pts.filter((p) => p.alpha >= -5 && p.alpha <= upTo);
  if (straight.length < 3) straight = pts.slice(0, Math.max(2, iMax + 1));
  const fit = fitLine(straight.map((p) => ({ x: p.alpha, y: p.cl })));
  const slope = fit
    ? { perDeg: fit.b, perRad: fit.b * RAD, from: straight[0].alpha, to: straight[straight.length - 1].alpha }
    : null;

  let alpha0 = null;
  for (let i = 0; i + 1 < pts.length && !alpha0; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    if (p.cl === 0) alpha0 = { alpha: p.alpha, extrapolated: false };
    else if (p.cl < 0 && q.cl >= 0) alpha0 = { alpha: p.alpha + ((0 - p.cl) * (q.alpha - p.alpha)) / (q.cl - p.cl), extrapolated: false };
  }
  if (!alpha0 && fit && fit.b > 0) alpha0 = { alpha: -fit.a / fit.b, extrapolated: true };

  const withDrag = pts.filter((p) => Number.isFinite(p.cd) && p.cd > 0);
  let cdMin = null;
  let bestLd = null;
  for (const p of withDrag) {
    if (!cdMin || p.cd < cdMin.cd) cdMin = { cd: p.cd, alpha: p.alpha };
    const ld = p.cl / p.cd;
    if (!bestLd || ld > bestLd.ld) bestLd = { ld, alpha: p.alpha };
  }
  const cm0 = at(pts, 'cm', 0);
  return {
    clMax,
    slope,
    alpha0,
    cdMin,
    bestLd,
    cm0: Number.isFinite(cm0) ? cm0 : null,
    range: { from: pts[0].alpha, to: pts[pts.length - 1].alpha },
  };
}

/** The thin-airfoil theory lift slope, per radian (2π), the reference a slope is read against. */
export const THIN_AIRFOIL_SLOPE = 2 * Math.PI;
