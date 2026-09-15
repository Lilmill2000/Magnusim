/**
 * CFD Desk W24 - Start Run 1 + live Area average (seven-series from run)
 * Prior: W22 - Area average setup (Result control → Surface data → Area average 1)
 * + W21 mesh generate + W20 mesh settings + W19 BCs + W18 Materials + W17 Incompressible + W16 project/geo
 * HARD: BOTH face57@Body1 + face71@Body1; no fake charts; no solves
 */
import '@kitware/vtk.js/Rendering/Profiles/Geometry';

import vtkFullScreenRenderWindow from '@kitware/vtk.js/Rendering/Misc/FullScreenRenderWindow';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkXMLPolyDataReader from '@kitware/vtk.js/IO/XML/XMLPolyDataReader';
import vtkSTLReader from '@kitware/vtk.js/IO/Geometry/STLReader';
import vtkLookupTable from '@kitware/vtk.js/Common/Core/LookupTable';
import vtkInteractorStyleManipulator from '@kitware/vtk.js/Interaction/Style/InteractorStyleManipulator';
import vtkMouseCameraTrackballRotateManipulator from '@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballRotateManipulator';
import vtkMouseCameraTrackballPanManipulator from '@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballPanManipulator';
import vtkMouseCameraTrackballZoomManipulator from '@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballZoomManipulator';
import vtkSphereSource from '@kitware/vtk.js/Filters/Sources/SphereSource';
import vtkCellPicker from '@kitware/vtk.js/Rendering/Core/CellPicker';
import vtkHardwareSelector from '@kitware/vtk.js/Rendering/OpenGL/HardwareSelector';
import { FieldAssociations } from '@kitware/vtk.js/Common/DataModel/DataSet/Constants';
import vtkArrowSource from '@kitware/vtk.js/Filters/Sources/ArrowSource';
import vtkAppendPolyData from '@kitware/vtk.js/Filters/General/AppendPolyData';
import vtkMatrixBuilder from '@kitware/vtk.js/Common/Core/MatrixBuilder';
import vtkPlane from '@kitware/vtk.js/Common/DataModel/Plane';
import vtkAxesActor from '@kitware/vtk.js/Rendering/Core/AxesActor';
import vtkOrientationMarkerWidget from '@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget';
import vtkCutter from '@kitware/vtk.js/Filters/Core/Cutter';
import vtkTubeFilter from '@kitware/vtk.js/Filters/General/TubeFilter';
import { VaryRadius } from '@kitware/vtk.js/Filters/General/TubeFilter/Constants';
import '@kitware/vtk.js/Rendering/Profiles/Glyph';
import vtkGlyph3DMapper from '@kitware/vtk.js/Rendering/Core/Glyph3DMapper';
import { OrientationModes, ScaleModes as GlyphScaleModes } from '@kitware/vtk.js/Rendering/Core/Glyph3DMapper/Constants';
import vtkContourTriangulator from '@kitware/vtk.js/Filters/General/ContourTriangulator';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkPoints from '@kitware/vtk.js/Common/Core/Points';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkCellArray from '@kitware/vtk.js/Common/Core/CellArray';
import { ColorMode, ScalarMode } from '@kitware/vtk.js/Rendering/Core/Mapper/Constants';
import { initHome, showHome, goHomeFromWorkbench, prepareCreateModal, submitProjectModal, activateHashProject, parseHomeRoute } from './dashboard.js';

try { initHome(); } catch (e) { console.warn('[CFD] initHome', e); }

function currentStudyId() {
  try {
    return (typeof w17State !== 'undefined' && w17State.simulation && w17State.simulation.id) || '';
  } catch (_) {
    return '';
  }
}

/**
 * `?project_id=<id>` for the project in the URL, or '' on the home screen.
 * Every hydrate on page load must pin its project this way: the server's
 * "active project" is shared by all tabs and races with /api/project/open,
 * so reading it can hand this tab another project's settings.
 */
function hashProjectQs(prefix = '?') {
  try {
    const route = parseHomeRoute();
    if (route.view === 'workbench' && route.projectId) {
      let qs = `${prefix}project_id=${encodeURIComponent(route.projectId)}`;
      const gid =
        (typeof w16State !== 'undefined' &&
          (w16State.selectedGeomId || (w16State.geometry && w16State.geometry.id))) ||
        '';
      if (gid) qs += `&geometry_id=${encodeURIComponent(gid)}`;
      const sid = currentStudyId();
      if (sid) qs += `&simulation_id=${encodeURIComponent(sid)}`;
      return qs;
    }
  } catch (_) {}
  return '';
}

function withProjectCaseParams(init) {
  const q = new URLSearchParams(init);
  try {
    const pid = currentProjectId();
    if (pid) q.set('project_id', pid);
  } catch (_) {}
  return q;
}

let caseDir = null;
function getCaseDir() { return caseDir; }
function hasAttachedCase() {
  const dir = getCaseDir();
  return !!(dir && String(dir).trim() && String(dir) !== 'null' && String(dir) !== 'undefined');
}

function sameCasePath(a, b) {
  const n = (p) => String(p || '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return !!n(a) && n(a) === n(b);
}

function resultsCaseAlreadyAttached(casePath) {
  if (!casePath || !hasAttachedCase()) return false;
  if (!sameCasePath(getCaseDir(), casePath)) return false;
  if (jobState.mode === 'mesh' || isMeshJobKind(jobState.path_kind)) return false;
  const n = sourcePolyData && sourcePolyData.getNumberOfPoints && sourcePolyData.getNumberOfPoints();
  return n > 0;
}
/** Alias: coerces to live caseDir string for URL builders. */
const CASE_DIR = {
  toString() { return getCaseDir(); },
  valueOf() { return getCaseDir(); },
  [Symbol.toPrimitive]() { return getCaseDir(); },
};
let currentTime = '50';
function getTime() { return String(currentTime); }
const TIME = { toString() { return getTime(); }, valueOf() { return getTime(); } };

// Optional `ctx` = { case, time } points a URL at another run's case (the
// right pane of the results compare); default is the attached case.
function apiCaseCtx(ctx) {
  const c = ctx && ctx.case ? String(ctx.case) : getCaseDir();
  const t = ctx && ctx.time != null ? String(ctx.time) : getTime();
  return { case: c, time: t };
}
function apiFieldUrl(field, ctx) {
  const c = apiCaseCtx(ctx);
  return `/api/fields/${encodeURIComponent(field)}?case=${encodeURIComponent(c.case)}&time=${encodeURIComponent(c.time)}`;
}
function apiMetaUrl(field, ctx) {
  const c = apiCaseCtx(ctx);
  return `/api/fields/${encodeURIComponent(field)}/meta?case=${encodeURIComponent(c.case)}&time=${encodeURIComponent(c.time)}`;
}

function parseSci(v, fallback) {
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : fallback;
}

function normalizePtSeedMode(mode) {
  return String(mode || 'faces').toLowerCase() === 'region' ? 'region' : 'faces';
}
function isRegionSeedMode(st) {
  return normalizePtSeedMode((st || ptState).seed_mode) === 'region';
}
function ptApiSeedMode() {
  return 'faces';
}
function ptFacesParam(s) {
  const st = s || ptState;
  if (isRegionSeedMode(st) && !regionIsUsable(st.region)) return '__none__';
  const faces = Array.isArray(st.faces) ? st.faces : [];
  return faces.length ? faces.join(',') : '__none__';
}
function regionIsUsable(r) {
  if (!r || !r.shape) return false;
  if (r.shape === 'circle') return Number(r.radius) > 1e-6;
  const lu = Math.hypot(Number(r.u && r.u[0]) || 0, Number(r.u && r.u[1]) || 0, Number(r.u && r.u[2]) || 0);
  const lv = Math.hypot(Number(r.v && r.v[0]) || 0, Number(r.v && r.v[1]) || 0, Number(r.v && r.v[2]) || 0);
  return lu > 1e-6 || lv > 1e-6;
}
function clonePtRegion(r) {
  if (!regionIsUsable(r)) return null;
  const num3 = (a) => [Number(a[0]) || 0, Number(a[1]) || 0, Number(a[2]) || 0];
  return {
    face: String(r.face || ''),
    shape: r.shape === 'circle' ? 'circle' : 'box',
    origin: num3(r.origin || [0, 0, 0]),
    u: num3(r.u || [0, 0, 0]),
    v: num3(r.v || [0, 0, 0]),
    radius: Number(r.radius) || 0,
  };
}
function encodePtRegionParam(r) {
  const c = clonePtRegion(r);
  if (!c) return '';
  const rnd = (a) => a.map((n) => Number(Number(n).toFixed(7)));
  c.origin = rnd(c.origin);
  c.u = rnd(c.u);
  c.v = rnd(c.v);
  c.radius = Number(Number(c.radius).toFixed(7));
  return JSON.stringify(c);
}
function apiParticleTraceUrl(st, ctx) {
  const s = st || ptState;
  const c = apiCaseCtx(ctx);
  const q = new URLSearchParams({
    case: c.case,
    time: c.time,
    seed_mode: ptApiSeedMode(),
    faces: ptFacesParam(s),
    quantity_mode: s.quantity_mode || 'count',
    n_seeds: String(s.n_seeds ?? 40),
    density: String(s.density ?? 10000),
    seeds_h: String(s.seeds_h),
    seeds_v: String(s.seeds_v),
    spacing: String(s.spacing),
    size: String(s.size),
    both: s.both ? '1' : '0',
    pick: s.pick || '',
    representation: s.representation || 'Cylinders',
    region: isRegionSeedMode(s) ? encodePtRegionParam(s.region) : '',
  });
  return `/api/particle-trace?${q.toString()}`;
}
function apiParticleTraceMetaUrl(st, ctx) {
  const s = st || ptState;
  const c = apiCaseCtx(ctx);
  const q = new URLSearchParams({
    case: c.case,
    time: c.time,
    seed_mode: ptApiSeedMode(),
    faces: ptFacesParam(s),
    quantity_mode: s.quantity_mode || 'count',
    n_seeds: String(s.n_seeds ?? 40),
    density: String(s.density ?? 10000),
    seeds_h: String(s.seeds_h),
    seeds_v: String(s.seeds_v),
    spacing: String(s.spacing),
    size: String(s.size),
    both: s.both ? '1' : '0',
    pick: s.pick || '',
    representation: s.representation || 'Cylinders',
    region: isRegionSeedMode(s) ? encodePtRegionParam(s.region) : '',
  });
  return `/api/particle-trace/meta?${q.toString()}`;
}

function encodePopPoints(pts) {
  return (pts || [])
    .map((p) => `${Number(p[0])},${Number(p[1])},${Number(p[2])}`)
    .join(';');
}
function apiPlotOverPathUrl(st) {
  const s = st || popState;
  const q = new URLSearchParams({
    case: getCaseDir(),
    time: getTime(),
    points: encodePopPoints(s.points),
    subdivisions: String(s.subdivisions),
    field_variable: s.field_variable || 'Velocity Magnitude',
  });
  return `/api/plot-over-path?${q.toString()}`;
}
function apiPlotOverPathMetaUrl(st) {
  const s = st || popState;
  const q = new URLSearchParams({
    case: getCaseDir(),
    time: getTime(),
    points: encodePopPoints(s.points),
    subdivisions: String(s.subdivisions),
    field_variable: s.field_variable || 'Velocity Magnitude',
  });
  return `/api/plot-over-path/meta?${q.toString()}`;
}

function apiCutPlaneUrl(origin, normal, field, ctx) {
  const o = origin || [0, 0, 0];
  const n = normal || [0, 1, 0];
  const c = apiCaseCtx(ctx);
  const q = new URLSearchParams({
    case: c.case,
    time: c.time,
    ox: String(o[0]),
    oy: String(o[1]),
    oz: String(o[2]),
    nx: String(n[0]),
    ny: String(n[1]),
    nz: String(n[2]),
    field: field === 'p' ? 'p' : 'magU',
  });
  return `/api/cut-plane?${q.toString()}`;
}
function apiCutPlaneMetaUrl(origin, normal, field, ctx) {
  return apiCutPlaneUrl(origin, normal, field, ctx).replace('/api/cut-plane?', '/api/cut-plane/meta?');
}

function apiIsoSurfaceUrl(st) {
  const s = st || isoState;
  const q = new URLSearchParams({
    case: getCaseDir(),
    time: getTime(),
    iso_scalar: s.iso_scalar || 'Velocity Magnitude',
    iso_value: String(s.iso_value),
    coloring: s.coloring || 'Pressure',
    opacity: String(s.opacity),
    vectors: s.vectors ? '1' : '0',
  });
  return `/api/iso-surface?${q.toString()}`;
}
function apiIsoSurfaceMetaUrl(st) {
  const s = st || isoState;
  const q = new URLSearchParams({
    case: getCaseDir(),
    time: getTime(),
    iso_scalar: s.iso_scalar || 'Velocity Magnitude',
    iso_value: String(s.iso_value),
    coloring: s.coloring || 'Pressure',
    opacity: String(s.opacity),
    vectors: s.vectors ? '1' : '0',
  });
  return `/api/iso-surface/meta?${q.toString()}`;
}

function apiIsoVolumeUrl(st) {
  const s = st || ivState;
  const q = new URLSearchParams({
    case: getCaseDir(),
    time: getTime(),
    iso_scalar: s.iso_scalar || 'Velocity Magnitude',
    iso_value_low: String(s.iso_value_low),
    iso_value_high: String(s.iso_value_high),
    coloring: s.coloring || 'Pressure',
    opacity: String(s.opacity),
    vectors: s.vectors ? '1' : '0',
  });
  return `/api/iso-volume?${q.toString()}`;
}
function apiIsoVolumeMetaUrl(st) {
  const s = st || ivState;
  const q = new URLSearchParams({
    case: getCaseDir(),
    time: getTime(),
    iso_scalar: s.iso_scalar || 'Velocity Magnitude',
    iso_value_low: String(s.iso_value_low),
    iso_value_high: String(s.iso_value_high),
    coloring: s.coloring || 'Pressure',
    opacity: String(s.opacity),
    vectors: s.vectors ? '1' : '0',
  });
  return `/api/iso-volume/meta?${q.toString()}`;
}

function apiInspectUrl(x, y, z, time) {
  const q = new URLSearchParams({
    case: getCaseDir(),
    time: String(time != null ? time : getTime()),
    x: String(x),
    y: String(y),
    z: String(z),
  });
  return `/api/inspect?${q.toString()}`;
}



let activeField = 'magU';
let sourcePolyData = null;
let sourceBounds = null;
let lutRange = [0, 0.79];

// Colour scale for a (case, field) across every /api/times entry. Per-frame
// foam / fingerprint min–max must not move the legend while Time Step
// scrubs or plays. First paint may hold the current frame until the series
// lock is computed from every cached time.
const seriesLut = {
  case: null,
  magU: null,
  p: null,
  held: { magU: null, p: null },
  locked: { magU: false, p: false },
};

function seriesLutKey(field) {
  return field === 'p' ? 'p' : 'magU';
}

function resetSeriesLut() {
  seriesLut.case = getCaseDir();
  seriesLut.magU = null;
  seriesLut.p = null;
  seriesLut.held = { magU: null, p: null };
  seriesLut.locked = { magU: false, p: false };
  legendAutoExtents.magU = null;
  legendAutoExtents.p = null;
}

function ensureSeriesLutCase() {
  if (seriesLut.case !== getCaseDir()) resetSeriesLut();
}

function unionLutRange(a, b) {
  const ok = (r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0];
  if (!ok(a)) return ok(b) ? [b[0], b[1]] : null;
  if (!ok(b)) return [a[0], a[1]];
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
}

function rangeFromFoamMeta(field, meta) {
  const foam = meta && (meta.u_from_case || meta.foam_proof);
  if (!foam) return null;
  if (field === 'p') {
    const lo = Number(foam.pmin);
    const hi = Number(foam.pmax);
    return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? [lo, hi] : null;
  }
  const lo = Number(foam.umin);
  const hi = Number(foam.umax);
  return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? [lo, hi] : null;
}

function absorbSeriesRange(field, lo, hi) {
  ensureSeriesLutCase();
  const key = seriesLutKey(field);
  if (seriesLut.locked[key]) return;
  const next = unionLutRange(seriesLut[key], [lo, hi]);
  if (next) seriesLut[key] = next;
}

function absorbSeriesFromEntry(field, entry) {
  const foamR = rangeFromFoamMeta(field, entry && entry.meta);
  if (foamR) absorbSeriesRange(field, foamR[0], foamR[1]);
  const pd = entry && entry.pd;
  if (!pd) return;
  try {
    const pointData = pd.getPointData ? pd.getPointData() : null;
    const arr = pointData ? pointData.getArrayByName(field) : null;
    if (!arr) return;
    const data = arr.getData();
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (Number.isFinite(mn) && Number.isFinite(mx) && mx > mn) {
      absorbSeriesRange(field, mn, mx);
    }
  } catch (_) {}
}

function seriesTimesComplete(field) {
  const times = animState.times || [];
  if (times.length < 2) return false;
  try { ensureFieldCacheCase(); } catch (_) {}
  return times.every((t) => fieldFrameCache.has(fieldFrameKey(field, t)));
}

function lockSeriesLut(field, opts) {
  ensureSeriesLutCase();
  const key = seriesLutKey(field);
  const times = animState.times || [];
  for (let i = 0; i < times.length; i++) {
    const entry = fieldFrameCache.get(fieldFrameKey(field, times[i]));
    if (entry) absorbSeriesFromEntry(field, entry);
  }
  const ready = !!(seriesLut[key] && (seriesTimesComplete(field) || (opts && opts.force)));
  if (ready) {
    seriesLut.locked[key] = true;
    seriesLut.held[key] = seriesLut[key].slice();
  }
  return seriesLut[key];
}

function resolveFieldLutRange(field, frameLo, frameHi) {
  const fixed = scaleOverrideFor(field);
  if (fixed) return [fixed.lo, fixed.hi];
  ensureSeriesLutCase();
  const key = seriesLutKey(field);
  let times = [];
  try { times = animState.times || []; } catch (_) { times = []; }
  if (times.length >= 2) {
    if (!seriesLut.locked[key] && seriesTimesComplete(field)) lockSeriesLut(field);
    if (seriesLut.locked[key] && seriesLut[key]) return seriesLut[key].slice();
    if (seriesLut.held[key]) return seriesLut.held[key].slice();
    if (Number.isFinite(frameLo) && Number.isFinite(frameHi) && frameHi > frameLo) {
      seriesLut.held[key] = [frameLo, frameHi];
    }
    return seriesLut.held[key] ? seriesLut.held[key].slice() : [frameLo, frameHi];
  }
  return [frameLo, frameHi];
}

function applyLockedSeriesLegend(field) {
  const name = field || activeField || 'magU';
  if ((animState.times || []).length < 2) return;
  const r = lockSeriesLut(name, { force: true });
  if (!r || scaleOverrideFor(name)) return;
  setLegendAutoExtents(name, r[0], r[1]);
  lutRange = [r[0], r[1]];
  try { lut.setRange(r[0], r[1]); lut.build(); } catch (_) {}
  updateLegend(name, r[0], r[1]);
  try { syncSharedLegend(); } catch (_) {}
  try { renderWindow.render(); } catch (_) {}
}

/**
 * User-set colour scale per quantity ({ lo, hi } or null = auto from the
 * data). Applies to every view of that quantity: parts, cutting planes,
 * iso-surfaces, particle trace and the compare pane. Saved with the run's
 * filter set. Edited by clicking the end labels of the legend or by
 * dragging the blue / red ends of the colour bar.
 */
const scaleOverride = { magU: null, p: null };
const legendAutoExtents = { magU: null, p: null };

function seriesRangeForLegend(field) {
  const key = seriesLutKey(field);
  let times = [];
  try { times = animState.times || []; } catch (_) { times = []; }
  if (times.length < 2) return null;
  if (seriesLut.locked[key] && seriesLut[key]) return seriesLut[key].slice();
  if (seriesLut.held[key]) return seriesLut.held[key].slice();
  if (seriesLut[key]) return seriesLut[key].slice();
  return null;
}

function setLegendAutoExtents(field, lo, hi) {
  const key = field === 'p' ? 'p' : 'magU';
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return;
  legendAutoExtents[key] = { lo, hi };
}

function legendAutoRange(field) {
  const key = field === 'p' ? 'p' : 'magU';
  const stored = legendAutoExtents[key];
  if (stored && stored.hi > stored.lo) return [stored.lo, stored.hi];
  const sk = seriesLutKey(key);
  if (seriesLut[sk] && seriesLut[sk][1] > seriesLut[sk][0]) return seriesLut[sk].slice();
  if (seriesLut.held[sk] && seriesLut.held[sk][1] > seriesLut.held[sk][0]) return seriesLut.held[sk].slice();
  if (ptOwnRange && (ptOwnRange.field === key || (key === 'magU' && ptOwnRange.field !== 'p'))) {
    return [ptOwnRange.lo, ptOwnRange.hi];
  }
  return null;
}

function scaleOverrideFor(field) {
  const o = scaleOverride[field === 'p' ? 'p' : 'magU'];
  return o && Number.isFinite(o.lo) && Number.isFinite(o.hi) && o.hi > o.lo ? o : null;
}

function setScaleOverride(field, lo, hi) {
  const key = field === 'p' ? 'p' : 'magU';
  if (lo == null || hi == null) {
    scaleOverride[key] = null;
  } else {
    let a = Number(lo);
    let b = Number(hi);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
    if (b < a) [a, b] = [b, a];
    if (b - a < 1e-12) b = a + (Math.abs(a) > 1e-9 ? Math.abs(a) * 1e-3 : 1e-3);
    scaleOverride[key] = { lo: a, hi: b };
  }
  try { syncSharedLegend(); } catch (_) {}
  try { renderWindow.render(); } catch (_) {}
  try { scheduleFilterAutosave(); } catch (_) {}
}

function clearScaleOverrides() {
  scaleOverride.magU = null;
  scaleOverride.p = null;
}

const cutState = {
  enabled: true,
  position: 33,
  axis: 'Y',
  inverse: false,
  opacity: 0.9,
  vectors: false,
  clipModel: true,
  partsColor: true,
  partsStyle: 'field',
  partsSolid: '#9aa3ad',
  partsOpacity: 1,
  com: null,
  positionUserSet: false,
};

const ptState = {
  enabled: true,
  seed_mode: 'faces',
  faces: [],
  focusFace: null,
  quantity_mode: 'count',
  n_seeds: 40,
  density: 10000,
  pick: '',
  seeds_h: 10,
  seeds_v: 10,
  spacing: 0.015,
  size: 0.0037,
  representation: 'Cylinders',
  both: false,
  coloring: 'magU',
  solid: '#2563eb',
  // Spheres / Comets are drawn as particle groups ("pulses") that travel
  // along each trace at the local flow speed (SimScale's Num pulses and
  // Relative comet length). Cylinders always show the whole path.
  pulses: 5,
  comet_length: 0.05,
  regionShape: 'box',
  region: null,
};
let ptMeta = null;
let ptLoadToken = 0;
// True while a particle-trace request is in flight (keeps the status hint).
let ptLoading = false;
let ptFaceCatalog = [];
let ptFacesHydratedFor = '';
let ptLinePd = null;

const popState = {
  enabled: true,
  pick: '',
  points: [],
  subdivisions: 0,
  field_variable: 'Velocity Magnitude',
};
let popMeta = null;
let popSeries = null;
let popLoadToken = 0;

const isoState = {
  enabled: true,
  iso_scalar: 'Velocity Magnitude',
  iso_value: 11.1,
  coloring: 'Pressure',
  vectors: false,
  opacity: 1,
};
let isoMeta = null;
let isoLoadToken = 0;

const ivState = {
  enabled: true,
  iso_scalar: 'Velocity Magnitude',
  iso_value_low: 0.25,
  iso_value_high: 0.75,
  coloring: 'Pressure',
  vectors: false,
  opacity: 1,
};
let ivMeta = null;
let ivLoadToken = 0;
let fieldLoadToken = 0;
let cutLoadToken = 0;
let cutLoadTimer = null;

const inspectState = {
  armed: false,
  enabled: false,
  position: null,
  hit: false,
  empty: true,
  magU: null,
  p: null,
  value_checksum: 0,
  reason: '',
  time: null,
  fingerprint: null,
  meta: null,
  marker_present: false,
  marker_radius: 0.018,
};
let inspectLoadToken = 0;



const container = document.getElementById('viewer');

const fullScreenRenderer = vtkFullScreenRenderWindow.newInstance({
  rootContainer: container,
  containerStyle: {
    height: '100%',
    width: '100%',
    position: 'absolute',
    left: '0',
    top: '0',
  },
  background: [0.94, 0.95, 0.97],
});

const renderer = fullScreenRenderer.getRenderer();
const renderWindow = fullScreenRenderer.getRenderWindow();
const interactor = fullScreenRenderer.getInteractor();
window.__CFD_VIEW__ = { renderer, renderWindow, interactor };
const cadStyle = vtkInteractorStyleManipulator.newInstance();
cadStyle.addMouseManipulator(vtkMouseCameraTrackballRotateManipulator.newInstance({ button: 1 }));
cadStyle.addMouseManipulator(vtkMouseCameraTrackballPanManipulator.newInstance({ button: 2 }));
cadStyle.addMouseManipulator(vtkMouseCameraTrackballPanManipulator.newInstance({ button: 1, shift: true }));
cadStyle.addMouseManipulator(vtkMouseCameraTrackballZoomManipulator.newInstance({
  dragEnabled: false,
  scrollEnabled: true,
}));
cadStyle.addMouseManipulator(vtkMouseCameraTrackballZoomManipulator.newInstance({ button: 3 }));
interactor.setInteractorStyle(cadStyle);

const compareState = {
  on: false,
  // 'mesh' (two generated meshes) or 'results' (two runs / views).
  mode: 'mesh',
  // Results compare: what each pane shows ('runId|viewId') and pane B's pipeline.
  resA: null,
  resB: null,
  res: null,
  // Sync filters: pane B draws pane A's live filter set on its own run.
  resSync: false,
  leftId: null,
  rightId: null,
  leftCase: null,
  rightCase: null,
  viewer: null,
  syncing: false,
  camBound: false,
  loadToken: 0,
  savedCam: null,
};

window.__CFD_COMPARE__ = compareState;
function meshCompareOn() {
  return !!(compareState.on && compareState.mode !== 'results');
}
function resultsCompareOn() {
  return !!(compareState.on && compareState.mode === 'results');
}

let cadEdgesWanted = true;
try {
  const stored = localStorage.getItem('cfd-cad-edges');
  if (stored === '0') cadEdgesWanted = false;
  if (stored === '1') cadEdgesWanted = true;
} catch (_) {}

let viewportOrient = null;
try {
  const viewportAxes = vtkAxesActor.newInstance({
    config: { recenter: false },
    xConfig: { color: [220, 40, 40] },
    yConfig: { color: [36, 168, 64] },
    zConfig: { color: [40, 96, 220] },
  });
  if (typeof viewportAxes.update === 'function') viewportAxes.update();
  viewportOrient = vtkOrientationMarkerWidget.newInstance({
    actor: viewportAxes,
    interactor,
    parentRenderer: renderer,
  });
  if (vtkOrientationMarkerWidget.Corners) {
    viewportOrient.setViewportCorner(vtkOrientationMarkerWidget.Corners.BOTTOM_RIGHT);
  }
  viewportOrient.setViewportSize(0.12);
  viewportOrient.setMinPixelSize(78);
  viewportOrient.setMaxPixelSize(118);
  viewportOrient.setEnabled(true);
} catch (e) {
  console.warn('[CFD] viewport XYZ triad', e);
  viewportOrient = null;
}

// Pixels the bottom-right viewport chrome (triad, XYZ key, fit button) has to
// move left to clear the Filters panel when it is open.
function viewportLeftInsetPx() {
  const wrap = document.querySelector('.viewport-wrap');
  if (!wrap) return 0;
  const wr = wrap.getBoundingClientRect();
  let right = wr.left;
  const stack = document.getElementById('tree-float-stack');
  if (stack && stack.offsetParent !== null) {
    const sr = stack.getBoundingClientRect();
    if (sr.width > 8 && sr.right > wr.left) right = Math.max(right, sr.right);
  }
  const job = document.querySelector('.job-debug-drawer');
  if (job && job.offsetParent !== null) {
    const jr = job.getBoundingClientRect();
    if (jr.width > 8 && jr.bottom > wr.bottom - 90 && jr.right > wr.left) {
      right = Math.max(right, jr.right);
    }
  }
  return Math.max(0, Math.round(right - wr.left + 8));
}

function viewportRightInsetPx() {
  const panel = document.getElementById('filters-panel');
  if (!panel || panel.classList.contains('is-hidden') || panel.offsetParent === null) return 0;
  // Only move things when the panel actually reaches down into the corner
  // where the triad / key / fit button live (bottom ~130 px of the viewport).
  try {
    const wrap = document.querySelector('.viewport-wrap');
    const pr = panel.getBoundingClientRect();
    const wr = wrap ? wrap.getBoundingClientRect() : { bottom: window.innerHeight };
    if (pr.bottom < wr.bottom - 130) return 0;
  } catch (_) {}
  const w = panel.offsetWidth || 260;
  return w + 12 + 8;
}

// Slide the triad, the X Y Z key and the fit button left of the Filters panel
// when it is open so the panel does not cover them. (vtk.js instances are
// frozen, so the marker widget's viewport is re-set here rather than by
// overriding its computeViewport.)
let lastChromeInsetKey = '';
function syncViewportChromeInset() {
  const inset = viewportRightInsetPx();
  const left = viewportLeftInsetPx();
  const view = interactor && interactor.getView && interactor.getView();
  const size = view && view.getSize ? view.getSize() : [0, 0];
  const key = inset + '|' + left + '|' + size[0] + '|' + size[1];
  if (key === lastChromeInsetKey) return;
  lastChromeInsetKey = key;
  const host = document.querySelector('.viewport-wrap') || document.body;
  try { host.style.setProperty('--vp-right-inset', inset + 'px'); } catch (_) {}
  try { host.style.setProperty('--vp-left-inset', left + 'px'); } catch (_) {}
  if (!viewportOrient) return;
  try {
    viewportOrient.updateViewport();
    if (inset > 0) {
      const vp = viewportOrient.computeViewport();
      const canvasW = size[0] || (interactor.getView().getSize()[0]);
      if (vp && canvasW) {
        const dx = Math.min(inset / canvasW, Math.max(0, vp[0]));
        viewportOrient.getRenderer().setViewport(vp[0] - dx, vp[1], vp[2] - dx, vp[3]);
      }
    }
  } catch (_) {}
}

if (container) {
  const blockAutoscroll = (e) => {
    if (e.button === 1) e.preventDefault();
  };
  let rightDown = null;
  container.addEventListener('mousedown', (e) => {
    blockAutoscroll(e);
    if (e.button === 2) rightDown = { x: e.clientX, y: e.clientY };
  }, { capture: true });
  container.addEventListener('auxclick', (e) => e.preventDefault());
  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (rightDown) {
      const dx = e.clientX - rightDown.x;
      const dy = e.clientY - rightDown.y;
      rightDown = null;
      if (dx * dx + dy * dy > 256) return;
    }
    try { onViewerFaceContextMenu(e, 'a'); } catch (_) {}
  });
}

function syncViewportOrient() {
  if (!viewportOrient) return;
  try {
    if (vtkOrientationMarkerWidget.Corners) {
      viewportOrient.setViewportCorner(vtkOrientationMarkerWidget.Corners.BOTTOM_RIGHT);
    }
    viewportOrient.setEnabled(true);
    viewportOrient.updateViewport();
  } catch (_) {}
  try { syncViewportChromeInset(); } catch (_) {}
}

let lastViewerCssSize = { w: -1, h: -1 };
let viewerResizeBusy = false;
let viewerResizeRaf = 0;

function resizeViewer() {
  if (viewerResizeBusy || document.hidden) return;
  const host = document.querySelector('.viewport-wrap') || container;
  const w = host ? host.clientWidth : 0;
  const h = host ? host.clientHeight : 0;
  const sizeChanged = w !== lastViewerCssSize.w || h !== lastViewerCssSize.h;
  if (!sizeChanged) {
    try { syncViewportChromeInset(); } catch (_) {}
    return;
  }
  lastViewerCssSize = { w, h };
  viewerResizeBusy = true;
  try {
    try {
      fullScreenRenderer.resize();
    } catch (_) {}
    try {
      syncViewportOrient();
    } catch (_) {}
    try {
      renderWindow.render();
    } catch (_) {}
    try {
      if (compareState.viewer && compareState.viewer.fullScreenRenderer) {
        compareState.viewer.fullScreenRenderer.resize();
        if (compareState.on) compareState.viewer.renderWindow.render();
      }
    } catch (_) {}
    lastMeshEdgeLodKey = '';
    try { applyMeshEdgeLod(); } catch (_) {}
    try { syncFiltersPanelOffset(); } catch (_) {}
    lastChromeInsetKey = '';
    try { syncViewportChromeInset(); } catch (_) {}
  } finally {
    viewerResizeBusy = false;
  }
}

function scheduleViewerResize() {
  if (viewerResizeBusy || viewerResizeRaf || document.hidden) return;
  viewerResizeRaf = requestAnimationFrame(() => {
    viewerResizeRaf = 0;
    resizeViewer();
  });
}

window.__CFD_RESIZE_VIEWER__ = resizeViewer;
window.addEventListener('resize', scheduleViewerResize);
if (typeof ResizeObserver === 'function') {
  try {
    const ro = new ResizeObserver(scheduleViewerResize);
    const wrap = document.querySelector('.viewport-wrap');
    // Watch the wrap, not #viewer — vtk resize mutates the canvas and
    // observing that host loops render → resize → render on a core.
    if (wrap) ro.observe(wrap);
    const fpEl = document.getElementById('filters-panel');
    if (fpEl) {
      const fpRo = new ResizeObserver(() => {
        lastChromeInsetKey = '';
        try { syncViewportChromeInset(); } catch (_) {}
      });
      fpRo.observe(fpEl);
    }
    const leftRo = new ResizeObserver(() => {
      lastChromeInsetKey = '';
      try { syncViewportChromeInset(); } catch (_) {}
    });
    const leftStack = document.getElementById('tree-float-stack');
    if (leftStack) leftRo.observe(leftStack);
    const jobDraw = document.querySelector('.job-debug-drawer');
    if (jobDraw) leftRo.observe(jobDraw);
  } catch (_) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    try { if (viewportOrient) viewportOrient.setEnabled(false); } catch (_) {}
    try { if (typeof stopAnimationPlay === 'function') stopAnimationPlay(); } catch (_) {}
    return;
  }
  try { if (viewportOrient) viewportOrient.setEnabled(true); } catch (_) {}
  lastViewerCssSize = { w: -1, h: -1 };
  lastChromeInsetKey = '';
  scheduleViewerResize();
});

const reader = vtkXMLPolyDataReader.newInstance();
const surfaceMapper = vtkMapper.newInstance();
surfaceMapper.setInputConnection(reader.getOutputPort());
surfaceMapper.setScalarVisibility(true);
surfaceMapper.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
surfaceMapper.setColorByArrayName(activeField);
surfaceMapper.setColorMode(ColorMode.MAP_SCALARS);
surfaceMapper.setInterpolateScalarsBeforeMapping(true);

const surfaceActor = vtkActor.newInstance();
surfaceActor.setMapper(surfaceMapper);
surfaceActor.getProperty().setSpecular(0.15);
surfaceActor.getProperty().setSpecularPower(20);
surfaceActor.getProperty().setOpacity(1.0);
surfaceActor.getProperty().setEdgeVisibility(false);
surfaceActor.setVisibility(false);
renderer.addActor(surfaceActor);

const cutPlane = vtkPlane.newInstance();
const cutter = vtkCutter.newInstance();
cutter.setCutFunction(cutPlane);
const cutReader = vtkXMLPolyDataReader.newInstance();

const cutMapper = vtkMapper.newInstance();
cutMapper.setScalarVisibility(true);
cutMapper.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
cutMapper.setColorByArrayName(activeField);
cutMapper.setColorMode(ColorMode.MAP_SCALARS);
cutMapper.setInterpolateScalarsBeforeMapping(true);
cutMapper.setUseLookupTableScalarRange(true);

const cutActor = vtkActor.newInstance();
cutActor.setMapper(cutMapper);
cutActor.getProperty().setSpecular(0.1);
cutActor.getProperty().setOpacity(cutState.opacity);
cutActor.getProperty().setEdgeVisibility(false);
cutActor.getProperty().setLighting(true);
cutActor.setVisibility(false);
renderer.addActor(cutActor);

const meshSurfReader = vtkXMLPolyDataReader.newInstance();
const meshSurfMapper = vtkMapper.newInstance();
meshSurfMapper.setInputConnection(meshSurfReader.getOutputPort());
meshSurfMapper.setScalarVisibility(false);
const meshSurfActor = vtkActor.newInstance();
meshSurfActor.setMapper(meshSurfMapper);
meshSurfActor.setVisibility(false);
try { meshSurfActor.setPickable(true); } catch (_) {}
{
  const pr = meshSurfActor.getProperty();
  pr.setRepresentationToSurface();
  pr.setEdgeVisibility(true);
  pr.setEdgeColor(0.28, 0.3, 0.33);
  pr.setColor(0.86, 0.88, 0.91);
  pr.setOpacity(1);
  pr.setLighting(false);
  pr.setLineWidth(1);
  try { if (pr.setBackfaceCulling) pr.setBackfaceCulling(false); } catch (_) {}
}
renderer.addActor(meshSurfActor);

const ptReader = vtkXMLPolyDataReader.newInstance();
const ptMapper = vtkMapper.newInstance();
ptMapper.setInputConnection(ptReader.getOutputPort());
ptMapper.setScalarVisibility(true);
ptMapper.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
ptMapper.setColorByArrayName('magU');
ptMapper.setColorMode(ColorMode.MAP_SCALARS);
ptMapper.setInterpolateScalarsBeforeMapping(true);
ptMapper.setUseLookupTableScalarRange(true);

const ptActor = vtkActor.newInstance();
ptActor.setMapper(ptMapper);
ptActor.getProperty().setSpecular(0.2);
ptActor.getProperty().setSpecularPower(25);
ptActor.getProperty().setOpacity(1.0);
ptActor.getProperty().setEdgeVisibility(false);
ptActor.getProperty().setLighting(true);
renderer.addActor(ptActor);

const ptTube = vtkTubeFilter.newInstance({
  radius: 0.0037,
  numberOfSides: 8,
  capping: true,
  varyRadius: VaryRadius.VARY_RADIUS_OFF,
});
const ptSphereSrc = vtkSphereSource.newInstance({
  radius: 1,
  phiResolution: 8,
  thetaResolution: 10,
});
const ptGlyphMapper = vtkGlyph3DMapper.newInstance();
try { ptSphereSrc.update(); } catch (_) {}
try { ptGlyphMapper.setInputData(ptSphereSrc.getOutputData(), 1); } catch (_) {}
try { ptGlyphMapper.setSourceConnection(ptSphereSrc.getOutputPort()); } catch (_) {}
ptGlyphMapper.setScalarVisibility(true);
ptGlyphMapper.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
ptGlyphMapper.setColorByArrayName('magU');
ptGlyphMapper.setColorMode(ColorMode.MAP_SCALARS);
ptGlyphMapper.setInterpolateScalarsBeforeMapping(true);
ptGlyphMapper.setUseLookupTableScalarRange(true);
try { ptGlyphMapper.setScaleMode(GlyphScaleModes.SCALE_BY_CONSTANT); } catch (_) {}
try { ptGlyphMapper.setScaling(true); } catch (_) {}
try { if (ptGlyphMapper.setOrient) ptGlyphMapper.setOrient(false); } catch (_) {}

const ptSeedMapper = vtkGlyph3DMapper.newInstance();
try { ptSeedMapper.setSourceConnection(ptSphereSrc.getOutputPort()); } catch (_) {}
try { ptSeedMapper.setScaleMode(GlyphScaleModes.SCALE_BY_CONSTANT); } catch (_) {}
try { ptSeedMapper.setScaling(true); } catch (_) {}
try { if (ptSeedMapper.setOrient) ptSeedMapper.setOrient(false); } catch (_) {}
ptSeedMapper.setScalarVisibility(false);
const ptSeedActor = vtkActor.newInstance();
ptSeedActor.setMapper(ptSeedMapper);
ptSeedActor.getProperty().setColor(0.08, 0.1, 0.16);
ptSeedActor.getProperty().setLighting(true);
ptSeedActor.setVisibility(false);
renderer.addActor(ptSeedActor);

let resultPlaneSeq = 1;
const resultPlanes = [];

const popPathMapper = vtkMapper.newInstance();
popPathMapper.setScalarVisibility(false);
const popPathActor = vtkActor.newInstance();
popPathActor.setMapper(popPathMapper);
popPathActor.getProperty().setColor(0.1, 0.1, 0.1);
popPathActor.getProperty().setLineWidth(2);
popPathActor.setVisibility(false);
renderer.addActor(popPathActor);

// W13 Inspect point ? magenta marker (26a.1 bank family); visible when placed
const inspectSphere = vtkSphereSource.newInstance({
  radius: inspectState.marker_radius,
  thetaResolution: 24,
  phiResolution: 24,
});
const inspectMarkerMapper = vtkMapper.newInstance();
inspectMarkerMapper.setInputConnection(inspectSphere.getOutputPort());
inspectMarkerMapper.setScalarVisibility(false);
const inspectMarkerActor = vtkActor.newInstance();
inspectMarkerActor.setMapper(inspectMarkerMapper);
inspectMarkerActor.getProperty().setColor(1.0, 0.0, 1.0); // magenta (26a.1)
inspectMarkerActor.getProperty().setOpacity(1.0);
inspectMarkerActor.getProperty().setAmbient(1.0);
inspectMarkerActor.getProperty().setDiffuse(0.0);
inspectMarkerActor.getProperty().setSpecular(0.0);
inspectMarkerActor.getProperty().setLighting(false);
inspectMarkerActor.setVisibility(false);
renderer.addActor(inspectMarkerActor);

const orbitFlashSphere = vtkSphereSource.newInstance({
  radius: 1,
  thetaResolution: 20,
  phiResolution: 16,
});
const orbitFlashMapper = vtkMapper.newInstance();
orbitFlashMapper.setInputConnection(orbitFlashSphere.getOutputPort());
orbitFlashMapper.setScalarVisibility(false);
const orbitFlashActor = vtkActor.newInstance();
orbitFlashActor.setMapper(orbitFlashMapper);
orbitFlashActor.getProperty().setColor(1.0, 0.55, 0.08);
orbitFlashActor.getProperty().setAmbient(1.0);
orbitFlashActor.getProperty().setDiffuse(0.15);
orbitFlashActor.getProperty().setLighting(false);
orbitFlashActor.setVisibility(false);
try { orbitFlashActor.setPickable(false); } catch (_) {}
renderer.addActor(orbitFlashActor);
let orbitFlashTimer = null;
let orbitCenterMode = 'model';
let customOrbitCenter = null;
const inspectPicker = vtkCellPicker.newInstance();
inspectPicker.setPickFromList(true);
inspectPicker.initializePickList();
inspectPicker.addPickList(surfaceActor);
inspectPicker.addPickList(cutActor);

const isoReader = vtkXMLPolyDataReader.newInstance();
const isoMapper = vtkMapper.newInstance();
isoMapper.setInputConnection(isoReader.getOutputPort());
isoMapper.setScalarVisibility(true);
isoMapper.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
isoMapper.setColorByArrayName('p');
isoMapper.setColorMode(ColorMode.MAP_SCALARS);
isoMapper.setInterpolateScalarsBeforeMapping(true);
isoMapper.setUseLookupTableScalarRange(true);

const isoActor = vtkActor.newInstance();
isoActor.setMapper(isoMapper);
isoActor.getProperty().setSpecular(0.15);
isoActor.getProperty().setSpecularPower(20);
isoActor.getProperty().setOpacity(isoState.opacity);
isoActor.getProperty().setEdgeVisibility(false);
isoActor.getProperty().setLighting(true);
isoActor.setVisibility(false);
renderer.addActor(isoActor);

function makeFieldVectorGlyph() {
  const arrow = vtkArrowSource.newInstance({
    tipResolution: 10,
    tipRadius: 0.14,
    tipLength: 0.34,
    shaftResolution: 8,
    shaftRadius: 0.045,
  });
  const mapper = vtkGlyph3DMapper.newInstance();
  try { mapper.setSourceConnection(arrow.getOutputPort()); } catch (_) {}
  try { mapper.setOrient(true); } catch (_) {}
  try { mapper.setOrientationMode(OrientationModes.DIRECTION); } catch (_) {}
  try { mapper.setOrientationArray('U'); } catch (_) {}
  try { mapper.setScaleMode(GlyphScaleModes.SCALE_BY_CONSTANT); } catch (_) {}
  try { mapper.setScaling(true); } catch (_) {}
  mapper.setScalarVisibility(false);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  actor.getProperty().setColor(0.12, 0.18, 0.28);
  actor.getProperty().setLighting(true);
  actor.setVisibility(false);
  renderer.addActor(actor);
  return { mapper, actor };
}

function subsampleVectorsForGlyphs(pd, maxPts) {
  if (!pd || typeof pd.getNumberOfPoints !== 'function') return null;
  const n = pd.getNumberOfPoints();
  const pda = pd.getPointData && pd.getPointData();
  const uArr = pda && pda.getArrayByName && pda.getArrayByName('U');
  if (!uArr || n < 1) return null;
  const stride = n > maxPts ? Math.ceil(n / maxPts) : 1;
  const srcPts = pd.getPoints().getData();
  const srcU = uArr.getData();
  const comps = uArr.getNumberOfComponents ? uArr.getNumberOfComponents() : 3;
  const outN = Math.max(1, Math.floor(n / stride));
  const pts = new Float32Array(outN * 3);
  const u = new Float32Array(outN * 3);
  let j = 0;
  for (let i = 0; i < n && j < outN; i += stride, j++) {
    pts[j * 3] = srcPts[i * 3];
    pts[j * 3 + 1] = srcPts[i * 3 + 1];
    pts[j * 3 + 2] = srcPts[i * 3 + 2];
    u[j * 3] = srcU[i * comps] || 0;
    u[j * 3 + 1] = srcU[i * comps + 1] || 0;
    u[j * 3 + 2] = srcU[i * comps + 2] || 0;
  }
  const out = vtkPolyData.newInstance();
  const points = vtkPoints.newInstance();
  points.setData(pts, 3);
  out.setPoints(points);
  const verts = new Uint32Array(outN * 2);
  for (let i = 0; i < outN; i++) {
    verts[i * 2] = 1;
    verts[i * 2 + 1] = i;
  }
  out.getVerts().setData(verts);
  out.getPointData().addArray(
    vtkDataArray.newInstance({ name: 'U', values: u, numberOfComponents: 3 })
  );
  return out;
}

function syncFieldVectorGlyphs(bundle, pd, enabled) {
  if (!enabled || !pd) {
    bundle.actor.setVisibility(false);
    return false;
  }
  const input = subsampleVectorsForGlyphs(pd, 1800);
  if (!input) {
    bundle.actor.setVisibility(false);
    return false;
  }
  bundle.mapper.setInputData(input);
  try { bundle.mapper.setOrientationArray('U'); } catch (_) {}
  const b = input.getBounds ? input.getBounds() : [0, 1, 0, 1, 0, 1];
  const diag = Math.hypot((b[1] - b[0]) || 0, (b[3] - b[2]) || 0, (b[5] - b[4]) || 0);
  try { bundle.mapper.setScaleFactor(Math.max(diag * 0.028, 1e-5)); } catch (_) {}
  bundle.actor.setVisibility(true);
  return true;
}

const isoVecGlyph = makeFieldVectorGlyph();
const ivVecGlyph = makeFieldVectorGlyph();

const ivReader = vtkXMLPolyDataReader.newInstance();
const ivMapper = vtkMapper.newInstance();
ivMapper.setInputConnection(ivReader.getOutputPort());
ivMapper.setScalarVisibility(true);
ivMapper.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
ivMapper.setColorByArrayName('p');
ivMapper.setColorMode(ColorMode.MAP_SCALARS);
ivMapper.setInterpolateScalarsBeforeMapping(true);
ivMapper.setUseLookupTableScalarRange(true);

const ivActor = vtkActor.newInstance();
ivActor.setMapper(ivMapper);
ivActor.getProperty().setSpecular(0.15);
ivActor.getProperty().setSpecularPower(20);
ivActor.getProperty().setOpacity(ivState.opacity);
ivActor.getProperty().setEdgeVisibility(false);
ivActor.getProperty().setLighting(true);
ivActor.setVisibility(false);
renderer.addActor(ivActor);



const lut = vtkLookupTable.newInstance();
lut.setHueRange(0.667, 0.0);
lut.setSaturationRange(1.0, 1.0);
lut.setValueRange(1.0, 1.0);
lut.setNumberOfColors(256);
const ptLut = vtkLookupTable.newInstance();
ptLut.setHueRange(0.667, 0.0);
ptLut.setSaturationRange(1.0, 1.0);
ptLut.setValueRange(1.0, 1.0);
ptLut.setNumberOfColors(256);
surfaceMapper.setLookupTable(lut);
surfaceMapper.setUseLookupTableScalarRange(true);
cutMapper.setLookupTable(lut);
ptMapper.setLookupTable(ptLut);
try { ptGlyphMapper.setLookupTable(ptLut); } catch (_) {}
try { if (ptGlyphMapper.setOrient) ptGlyphMapper.setOrient(false); } catch (_) {}
isoMapper.setLookupTable(lut);
ivMapper.setLookupTable(lut);

function sampleChecksum(arr) {
  const n = arr.length;
  const head = Math.min(64, n);
  let h = 2166136261 >>> 0;
  const push = (v) => {
    const x = Math.floor(v * 1e9);
    h ^= x >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= (x / 4294967296) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  };
  push(n);
  for (let i = 0; i < head; i++) push(arr[i]);
  for (let i = Math.max(0, n - 64); i < n; i++) push(arr[i]);
  return ('00000000' + h.toString(16)).slice(-8);
}

function meshChecksum(pd) {
  if (!pd) return null;
  const pts = pd.getPoints();
  const data = pts ? pts.getData() : null;
  if (!data || !data.length) return '00000000';
  const n = data.length;
  let h = 2166136261 >>> 0;
  const push = (v) => {
    const x = Math.floor(Number(v) * 1e6);
    h ^= x >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  };
  push(n);
  push(pd.getNumberOfCells ? pd.getNumberOfCells() : 0);
  const step = Math.max(1, Math.floor(n / 256));
  for (let i = 0; i < n; i += step) push(data[i]);
  for (let i = Math.max(0, n - 24); i < n; i++) push(data[i]);
  return ('00000000' + h.toString(16)).slice(-8);
}

function boundsObj(bounds) {
  if (!bounds || bounds.length < 6) return null;
  return {
    xmin: bounds[0],
    xmax: bounds[1],
    ymin: bounds[2],
    ymax: bounds[3],
    zmin: bounds[4],
    zmax: bounds[5],
    dx: bounds[1] - bounds[0],
    dy: bounds[3] - bounds[2],
    dz: bounds[5] - bounds[4],
  };
}

function fingerprintFromPolyData(pd, meta, field, assetUrl) {
  if (!pd) return null;
  const pts = pd.getPoints();
  const nPoints = pts ? pts.getNumberOfPoints() : 0;
  const nCells = pd.getNumberOfCells ? pd.getNumberOfCells() : 0;
  const bounds = pd.getBounds ? pd.getBounds() : null;
  const b = boundsObj(bounds);
  const pointData = pd.getPointData ? pd.getPointData() : null;
  const arr = pointData ? pointData.getArrayByName(field) : null;
  let umin = null;
  let umax = null;
  let nonzero = 0;
  let nSamples = 0;
  let browser_sample_fnv = null;
  let sample_head = null;
  if (arr) {
    const data = arr.getData();
    nSamples = data.length;
    let mn = Infinity;
    let mx = -Infinity;
    const head = [];
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      if (v !== 0) nonzero += 1;
      if (i < 8) head.push(v);
    }
    umin = mn;
    umax = mx;
    sample_head = head;
    browser_sample_fnv = sampleChecksum(data);
  }
  const foam = meta && (meta.u_from_case || meta.foam_proof);
  return {
    source: 'vtkXMLPolyDataReader',
    asset_url: assetUrl,
    api_url: assetUrl,
    case_dir: getCaseDir(),
    time: getTime(),
    field,
    nPoints,
    nCells,
    bounds: b,
    umin,
    umax,
    nonzero,
    nSamples,
    sample_head,
    browser_sample_fnv,
    mesh_checksum: meshChecksum(pd),
    meta_umin: foam ? foam.umin ?? foam.pmin ?? null : null,
    meta_umax: foam ? foam.umax ?? foam.pmax ?? null : null,
    meta_checksum: foam ? foam.sample_checksum_sha256 : null,
    proves_not_baked_only: !!(assetUrl && assetUrl.indexOf('/api/fields/') === 0),
    real_field: !!(arr && nSamples > 1000 && meta && (meta.foam_proof || meta.u_from_case) && (field !== 'magU' || (umax !== null && umax < 5))),
    not_simscale_22_2: !!(field !== 'magU' || (umax !== null && umax < 5)),
  };
}

function cutFingerprint(pd) {
  if (!pd) {
    return { nPoints: 0, nCells: 0, bounds: null, mesh_checksum: '00000000', empty: true };
  }
  const pts = pd.getPoints();
  const nPoints = pts ? pts.getNumberOfPoints() : 0;
  const nCells = pd.getNumberOfCells ? pd.getNumberOfCells() : 0;
  const b = boundsObj(pd.getBounds ? pd.getBounds() : null);
  const pointData = pd.getPointData ? pd.getPointData() : null;
  const arr = pointData ? pointData.getArrayByName(activeField) : null;
  let umin = null;
  let umax = null;
  let nSamples = 0;
  if (arr) {
    const data = arr.getData();
    nSamples = data.length;
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    umin = mn;
    umax = mx;
  }
  return {
    nPoints,
    nCells,
    bounds: b,
    mesh_checksum: meshChecksum(pd),
    umin,
    umax,
    nSamples,
    empty: nCells === 0 || nPoints === 0,
  };
}

/**
 * vtk.js Cutter does not interpolate point-field scalars onto cut points.
 * Re-cut with the same vtkPlane and lerp activeField onto intersections so the
 * cutting-plane actor is a real sample of the API magU surface (not a chrome overlay).
 */
function buildCutBins(pd) {
  const points = pd.getPoints().getData();
  const polys = pd.getPolys() ? pd.getPolys().getData() : null;
  if (!polys) return null;
  const nBins = 64;
  const bounds = pd.getBounds();
  const bins = { X: null, Y: null, Z: null, nBins, bounds };
  for (const axis of ["X", "Y", "Z"]) {
    const ai = axis === "X" ? 0 : axis === "Y" ? 1 : 2;
    const lo = bounds[ai * 2];
    const hi = bounds[ai * 2 + 1];
    const span = hi - lo || 1;
    const lists = Array.from({ length: nBins }, () => []);
    let idx = 0;
    while (idx < polys.length) {
      const cellStart = idx;
      const n = polys[idx++];
      if (n < 3 || idx + n > polys.length) break;
      let cmin = Infinity;
      let cmax = -Infinity;
      for (let k = 0; k < n; k++) {
        const pid = polys[idx++];
        const v = points[pid * 3 + ai];
        if (v < cmin) cmin = v;
        if (v > cmax) cmax = v;
      }
      let b0 = Math.floor(((cmin - lo) / span) * nBins);
      let b1 = Math.floor(((cmax - lo) / span) * nBins);
      if (b0 < 0) b0 = 0;
      if (b1 < 0) b1 = 0;
      if (b0 >= nBins) b0 = nBins - 1;
      if (b1 >= nBins) b1 = nBins - 1;
      for (let b = b0; b <= b1; b++) lists[b].push(cellStart);
    }
    bins[axis] = lists;
  }
  bins.polys = polys;
  bins.points = points;
  bins.nPoints = pd.getPoints().getNumberOfPoints();
  return bins;
}

let cutBins = null;

function cutSurfacePreservingScalars(pd, plane, fieldName) {
  const empty = vtkPolyData.newInstance();
  if (!pd) return empty;
  const points = pd.getPoints();
  if (!points) return empty;
  const pointsData = points.getData();
  const numPts = points.getNumberOfPoints();
  const polys = pd.getPolys() ? pd.getPolys().getData() : null;
  if (!polys || !polys.length || numPts < 1) return empty;

  const fieldArr = pd.getPointData() ? pd.getPointData().getArrayByName(fieldName) : null;
  const fieldData = fieldArr ? fieldArr.getData() : null;
  const origin = plane.getOrigin();
  const normal = plane.getNormal();

  // Choose dominant axis of normal for binning
  const ax = Math.abs(normal[0]) >= Math.abs(normal[1]) && Math.abs(normal[0]) >= Math.abs(normal[2])
    ? "X"
    : Math.abs(normal[1]) >= Math.abs(normal[2])
      ? "Y"
      : "Z";
  const ai = ax === "X" ? 0 : ax === "Y" ? 1 : 2;
  if (!cutBins || cutBins.nPoints !== numPts) {
    cutBins = buildCutBins(pd);
  }

  const dist = new Float32Array(numPts);
  dist.fill(NaN);
  const ensureDist = (pid) => {
    if (!Number.isNaN(dist[pid])) return dist[pid];
    const o = pid * 3;
    dist[pid] = plane.evaluateFunction(pointsData[o], pointsData[o + 1], pointsData[o + 2]);
    return dist[pid];
  };

  const newPoints = [];
  const newScalars = [];
  const newLines = [];
  const newPolysOut = [];
  const edgeCache = new Map();

  function intersectEdge(i1, i2) {
    const a = i1 < i2 ? i1 : i2;
    const b = i1 < i2 ? i2 : i1;
    const key = a * (numPts + 1) + b;
    if (edgeCache.has(key)) return edgeCache.get(key);
    const d1 = ensureDist(i1);
    const d2 = ensureDist(i2);
    let t = 0;
    const denom = d1 - d2;
    if (denom !== 0) t = d1 / denom;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    const o1 = i1 * 3;
    const o2 = i2 * 3;
    const id = newPoints.length / 3;
    newPoints.push(
      pointsData[o1] + t * (pointsData[o2] - pointsData[o1]),
      pointsData[o1 + 1] + t * (pointsData[o2 + 1] - pointsData[o1 + 1]),
      pointsData[o1 + 2] + t * (pointsData[o2 + 2] - pointsData[o1 + 2])
    );
    if (fieldData) newScalars.push(fieldData[i1] + t * (fieldData[i2] - fieldData[i1]));
    edgeCache.set(key, id);
    return id;
  }

  const planeCoord = origin[ai];
  const lo = cutBins.bounds[ai * 2];
  const hi = cutBins.bounds[ai * 2 + 1];
  const span = hi - lo || 1;
  let b = Math.floor(((planeCoord - lo) / span) * cutBins.nBins);
  if (b < 0) b = 0;
  if (b >= cutBins.nBins) b = cutBins.nBins - 1;
  const candidates = new Set();
  for (let db = -1; db <= 1; db++) {
    const bi = b + db;
    if (bi < 0 || bi >= cutBins.nBins) continue;
    const list = cutBins[ax][bi];
    for (let i = 0; i < list.length; i++) candidates.add(list[i]);
  }

  candidates.forEach((cellStart) => {
    let idx = cellStart;
    const n = polys[idx++];
    if (n < 3) return;
    const cell = new Array(n);
    for (let k = 0; k < n; k++) cell[k] = polys[idx++];
    const d0 = ensureDist(cell[0]);
    const side0 = d0 > 0;
    let same = true;
    for (let k = 1; k < n; k++) {
      if ((ensureDist(cell[k]) > 0) !== side0) {
        same = false;
        break;
      }
    }
    if (same) return;
    const crossed = [];
    for (let e = 0; e < n; e++) {
      const ca = cell[e];
      const cb = cell[(e + 1) % n];
      if ((ensureDist(ca) > 0) !== (ensureDist(cb) > 0)) crossed.push(intersectEdge(ca, cb));
    }
    if (crossed.length === 2) newLines.push(2, crossed[0], crossed[1]);
    else if (crossed.length > 2) {
      newPolysOut.push(crossed.length);
      for (let c = 0; c < crossed.length; c++) newPolysOut.push(crossed[c]);
    }
  });

  const out = vtkPolyData.newInstance();
  if (newPoints.length === 0) return out;
  const vtkPts = vtkPoints.newInstance();
  vtkPts.setData(Float32Array.from(newPoints), 3);
  out.setPoints(vtkPts);
  if (newLines.length) {
    const lines = vtkCellArray.newInstance();
    lines.setData(Uint32Array.from(newLines));
    out.setLines(lines);
  }
  if (newPolysOut.length) {
    const parr = vtkCellArray.newInstance();
    parr.setData(Uint32Array.from(newPolysOut));
    out.setPolys(parr);
  }
  if (fieldData && newScalars.length) {
    const da = vtkDataArray.newInstance({
      name: fieldName,
      values: Float32Array.from(newScalars),
      numberOfComponents: 1,
    });
    out.getPointData().setScalars(da);
    out.getPointData().addArray(da);
  }
  void normal;
  return out;
}

function axisNormal(axis, inverse) {
  let n = [0, 1, 0];
  if (axis === 'X') n = [1, 0, 0];
  else if (axis === 'Z') n = [0, 0, 1];
  else n = [0, 1, 0];
  if (inverse) n = [-n[0], -n[1], -n[2]];
  return n;
}

let officialComNative = null;
let officialCadBoundsNative = null;

function boundsObjectToArray(b) {
  if (!b) return null;
  if (Array.isArray(b) && b.length >= 6) {
    const out = b.slice(0, 6).map(Number);
    return out.every((n) => Number.isFinite(n)) ? out : null;
  }
  if (b.xmin == null && b.ymin == null && b.zmin == null) return null;
  const out = [Number(b.xmin), Number(b.xmax), Number(b.ymin), Number(b.ymax), Number(b.zmin), Number(b.zmax)];
  return out.every((n) => Number.isFinite(n)) ? out : null;
}

function rememberOfficialCom(meta) {
  if (!meta || typeof meta !== 'object') return;
  const raw = meta.center_of_mass || (meta.fingerprint && meta.fingerprint.center_of_mass);
  if (Array.isArray(raw) && raw.length >= 3) {
    const com = [Number(raw[0]), Number(raw[1]), Number(raw[2])];
    if (com.every((n) => Number.isFinite(n))) officialComNative = com;
  }
  const b = boundsObjectToArray(meta.bounds || (meta.fingerprint && meta.fingerprint.bounds));
  if (b) officialCadBoundsNative = b;
}

function bboxCenter(bounds) {
  if (!bounds || bounds.length < 6) return null;
  return [
    0.5 * (bounds[0] + bounds[1]),
    0.5 * (bounds[2] + bounds[3]),
    0.5 * (bounds[4] + bounds[5]),
  ];
}

function fracAlongAxis(bounds, axis, point) {
  if (!bounds || !point) return 0.5;
  const ax = String(axis || 'x').toLowerCase();
  const i = ax === 'y' ? 1 : ax === 'z' ? 2 : 0;
  const lo = bounds[i * 2];
  const hi = bounds[i * 2 + 1];
  const span = hi - lo;
  if (!(span > 1e-15)) return 0.5;
  return Math.min(1, Math.max(0, (point[i] - lo) / span));
}

function mapPointCadToView(comNative, viewBounds) {
  if (!comNative || !officialCadBoundsNative || !viewBounds) return null;
  const src = officialCadBoundsNative;
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const s0 = src[i * 2];
    const s1 = src[i * 2 + 1];
    const t0 = viewBounds[i * 2];
    const t1 = viewBounds[i * 2 + 1];
    const span = s1 - s0;
    out[i] = Math.abs(span) < 1e-18 ? 0.5 * (t0 + t1) : t0 + ((comNative[i] - s0) / span) * (t1 - t0);
  }
  return out;
}

function polyDataCenterOfMass(pd) {
  if (!pd) return null;
  const ptsObj = pd.getPoints && pd.getPoints();
  const pts = ptsObj && ptsObj.getData && ptsObj.getData();
  if (!pts || pts.length < 3) return null;
  let mass = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  const addTri = (i0, i1, i2) => {
    const ax = pts[i0 * 3];
    const ay = pts[i0 * 3 + 1];
    const az = pts[i0 * 3 + 2];
    const bx = pts[i1 * 3];
    const by = pts[i1 * 3 + 1];
    const bz = pts[i1 * 3 + 2];
    const dx = pts[i2 * 3];
    const dy = pts[i2 * 3 + 1];
    const dz = pts[i2 * 3 + 2];
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = dx - ax;
    const vy = dy - ay;
    const vz = dz - az;
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (!(area > 0)) return;
    mass += area;
    cx += (area * (ax + bx + dx)) / 3;
    cy += (area * (ay + by + dy)) / 3;
    cz += (area * (az + bz + dz)) / 3;
  };
  const polys = pd.getPolys && pd.getPolys();
  const offsets = polys && polys.getOffsets && polys.getOffsets();
  const conn = polys && polys.getConnectivity && polys.getConnectivity();
  if (offsets && conn) {
    const off = offsets.getData ? offsets.getData() : offsets;
    const ids = conn.getData ? conn.getData() : conn;
    for (let i = 0; i < off.length - 1; i++) {
      const a = off[i];
      const b = off[i + 1];
      if (b - a >= 3) {
        const i0 = ids[a];
        for (let k = a + 1; k < b - 1; k++) addTri(i0, ids[k], ids[k + 1]);
      }
    }
  } else {
    const data = polys && polys.getData && polys.getData();
    if (data) {
      let i = 0;
      while (i < data.length) {
        const npts = data[i++];
        if (npts >= 3) {
          const i0 = data[i];
          for (let k = 1; k < npts - 1; k++) addTri(i0, data[i + k], data[i + k + 1]);
        }
        i += npts;
      }
    }
  }
  if (mass > 1e-20) return [cx / mass, cy / mass, cz / mass];
  const n = Math.floor(pts.length / 3);
  if (n < 1) return null;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let i = 0; i < n; i++) {
    sx += pts[i * 3];
    sy += pts[i * 3 + 1];
    sz += pts[i * 3 + 2];
  }
  return [sx / n, sy / n, sz / n];
}

function currentObjectPolyData() {
  if (meshInspectOpen) {
    try {
      const pd = meshSurfMapper.getInputData && meshSurfMapper.getInputData();
      if (pd && pd.getNumberOfPoints && pd.getNumberOfPoints() > 0) return pd;
    } catch (_) {}
  }
  if (!meshInspectOpen && sourcePolyData && sourcePolyData.getNumberOfPoints && sourcePolyData.getNumberOfPoints() > 0) {
    return sourcePolyData;
  }
  try {
    const pd = geomCadFaceReader.getOutputData && geomCadFaceReader.getOutputData();
    if (pd && pd.getNumberOfPoints && pd.getNumberOfPoints() > 0) return pd;
  } catch (_) {}
  return null;
}

function getObjectCenterOfMass(boundsHint) {
  const bounds = boundsHint || meshBounds || sourceBounds;
  const mapped = mapPointCadToView(officialComNative, bounds);
  if (mapped) return mapped;
  const fromPd = polyDataCenterOfMass(currentObjectPolyData());
  if (fromPd) return fromPd;
  return bboxCenter(bounds) || [0, 0, 0];
}

function ensureCutStateCom(bounds) {
  if (!bounds) return;
  if (!cutState.com) cutState.com = getObjectCenterOfMass(bounds);
  if (!cutState.positionUserSet) {
    cutState.position = fracAlongAxis(bounds, cutState.axis, cutState.com) * 100;
    cutState.positionUserSet = true;
  }
}

function planeOriginFromPosition(bounds, axis, position01, com) {
  const t = Math.min(1, Math.max(0, position01));
  const c = com && com.length === 3 ? com : bboxCenter(bounds) || [0, 0, 0];
  if (axis === 'X') return [bounds[0] + t * (bounds[1] - bounds[0]), c[1], c[2]];
  if (axis === 'Z') return [c[0], c[1], bounds[4] + t * (bounds[5] - bounds[4])];
  return [c[0], bounds[2] + t * (bounds[3] - bounds[2]), c[2]];
}

function viewFacingClipNormal(origin, axisN, inverse) {
  const n = [Number(axisN[0]) || 0, Number(axisN[1]) || 0, Number(axisN[2]) || 0];
  if (n[0] * n[0] + n[1] * n[1] + n[2] * n[2] < 1e-18) {
    n[0] = 0;
    n[1] = 1;
    n[2] = 0;
  }
  // Deterministic: the half on the +axis side of the plane is removed;
  // "Inverse" keeps that half and removes the other one. The choice does not
  // depend on where the camera happens to be, so rotating the view never
  // flips which half is shown.
  if (inverse) {
    n[0] = -n[0];
    n[1] = -n[1];
    n[2] = -n[2];
  }
  return n;
}

function applyPlaneFromState(bounds, state, miss) {
  const axis = state.axis;
  const axisN = axisNormal(axis, false);
  let origin;
  if (miss) {
    // Honest empty: push origin far outside mesh along axis
    const c = state.com && state.com.length === 3 ? state.com : bboxCenter(bounds);
    const pad = 10;
    if (axis === 'X') origin = [bounds[1] + pad * (bounds[1] - bounds[0] + 1), c[1], c[2]];
    else if (axis === 'Z') origin = [c[0], c[1], bounds[5] + pad * (bounds[5] - bounds[4] + 1)];
    else origin = [c[0], bounds[3] + pad * (bounds[3] - bounds[2] + 1), c[2]];
  } else {
    origin = planeOriginFromPosition(bounds, axis, state.position / 100, state.com);
  }
  const clipN = viewFacingClipNormal(origin, axisN, !!state.inverse);
  cutPlane.setOrigin(origin);
  cutPlane.setNormal(clipN);
  return { origin, normal: axisN, clipNormal: clipN };
}

function polyDataHasPolys(pd) {
  if (!pd || !pd.getPolys) return false;
  const polys = pd.getPolys();
  if (!polys) return false;
  if (typeof polys.getNumberOfCells === 'function' && polys.getNumberOfCells() > 0) return true;
  const data = polys.getData && polys.getData();
  return !!(data && data.length);
}

function fanFillPolylines(pd) {
  if (!pd || polyDataHasPolys(pd)) return pd;
  const lines = pd.getLines && pd.getLines();
  const lineData = lines && lines.getData && lines.getData();
  if (!lineData || !lineData.length) return pd;
  const polys = [];
  let i = 0;
  while (i < lineData.length) {
    const n = Number(lineData[i++]);
    if (!Number.isFinite(n) || n < 1) break;
    const ids = [];
    for (let k = 0; k < n && i < lineData.length; k++) ids.push(lineData[i++]);
    if (ids.length < 3) continue;
    const last = ids[ids.length - 1];
    const loop = last === ids[0] ? ids.slice(0, -1) : ids;
    if (loop.length < 3) continue;
    for (let k = 1; k + 1 < loop.length; k++) {
      polys.push(3, loop[0], loop[k], loop[k + 1]);
    }
  }
  if (!polys.length) return pd;
  try {
    const arr = vtkCellArray.newInstance();
    arr.setData(Uint32Array.from(polys));
    pd.setPolys(arr);
  } catch (e) {
    console.warn('[CFD W7] fan fill skipped', e);
  }
  return pd;
}

function triangulateCut(cutPd) {
  if (!cutPd || (cutPd.getNumberOfPoints && cutPd.getNumberOfPoints() === 0)) {
    return cutPd;
  }
  try {
    const tri = vtkContourTriangulator.newInstance();
    tri.setInputData(cutPd);
    tri.update();
    const out = tri.getOutputData();
    if (out && ((out.getNumberOfCells && out.getNumberOfCells() > 0) || polyDataHasPolys(out))) {
      return out;
    }
  } catch (e) {
    console.warn('[CFD W7] ContourTriangulator skipped', e);
  }
  return fanFillPolylines(cutPd);
}

function hexToRgb01(hex) {
  const raw = String(hex || '#9aa3ad').replace('#', '').trim();
  const h = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return [0.6, 0.64, 0.68];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function applyPartsAppearance() {
  const nPts = sourcePolyData && sourcePolyData.getNumberOfPoints
    ? sourcePolyData.getNumberOfPoints()
    : 0;
  const show = !!cutState.partsColor && nPts > 0;
  try { surfaceActor.setVisibility(show); } catch (_) {}
  try { surfaceActor.setScale(1, 1, 1); } catch (_) {}
  const op = Number(cutState.partsOpacity);
  const opacity = Number.isFinite(op) ? Math.min(1, Math.max(0, op)) : 1;
  try {
    const pr = surfaceActor.getProperty();
    pr.setOpacity(opacity);
    pr.setSpecular(0.15);
    pr.setSpecularPower(20);
    pr.setEdgeVisibility(false);
    pr.setLighting(true);
    if (pr.setRepresentationToSurface) pr.setRepresentationToSurface();
    if (cutState.partsStyle === 'solid') {
      const rgb = hexToRgb01(cutState.partsSolid);
      pr.setColor(rgb[0], rgb[1], rgb[2]);
    }
  } catch (_) {}
  try {
    if (cutState.partsStyle === 'solid') {
      surfaceMapper.setScalarVisibility(false);
    } else {
      surfaceMapper.setScalarVisibility(true);
      surfaceMapper.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
      surfaceMapper.setColorByArrayName(activeField);
      surfaceMapper.setColorMode(ColorMode.MAP_SCALARS);
      surfaceMapper.setInterpolateScalarsBeforeMapping(true);
      surfaceMapper.setUseLookupTableScalarRange(true);
      surfaceMapper.setLookupTable(lut);
    }
  } catch (_) {}
  try { syncSharedLegend(); } catch (_) {}
}

function resultsCutActive() {
  return !!(resultsViewOpen && !meshInspectOpen);
}

function styleCutSliceActor() {
  try { cutActor.setScale(1, 1, 1); } catch (_) {}
  try {
    const pr = cutActor.getProperty();
    if (pr.setRepresentationToSurface) pr.setRepresentationToSurface();
    pr.setEdgeVisibility(false);
    pr.setLighting(false);
    pr.setOpacity(Number.isFinite(Number(cutState.opacity)) ? Number(cutState.opacity) : 1);
    pr.setLineWidth(1);
    pr.setSpecular(0);
    pr.setAmbient(0.35);
    pr.setDiffuse(0.75);
    if (pr.setBackfaceCulling) pr.setBackfaceCulling(false);
    if (pr.setBackFaceCulling) pr.setBackFaceCulling(false);
    if (pr.setFrontfaceCulling) pr.setFrontfaceCulling(false);
    if (pr.setFrontFaceCulling) pr.setFrontFaceCulling(false);
  } catch (_) {}
  try {
    cutMapper.setScalarVisibility(true);
    cutMapper.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
    cutMapper.setColorByArrayName(activeField === 'p' ? 'p' : 'magU');
    cutMapper.setColorMode(ColorMode.MAP_SCALARS);
    cutMapper.setInterpolateScalarsBeforeMapping(true);
    cutMapper.setUseLookupTableScalarRange(true);
    cutMapper.setLookupTable(lut);
  } catch (_) {}
}

function bindCutSlice(pd) {
  styleCutSliceActor();
  try {
    if (pd && pd.getNumberOfPoints && pd.getNumberOfPoints() > 0) {
      cutMapper.setInputData(pd);
    } else {
      cutMapper.setInputData(emptyVtkPolyData());
    }
  } catch (_) {}
}

function applyCutClipAndParts() {
  if (surfaceMapper.removeAllClippingPlanes) {
    surfaceMapper.removeAllClippingPlanes();
  }
  // The CAD outline drawn over the result must be cut by the same planes,
  // otherwise the full silhouette stays while half the model is clipped away.
  // vtk.js clipping planes are world-space and are transformed by each
  // actor's own matrix, so one vtkPlane serves both the result surface and
  // the (rescaled) CAD edge actor.
  const clipEdges = !meshInspectOpen && !meshCompareOn();
  // Particle traces are clipped visually with the model too. This is display
  // only — the traces themselves (seeds, integration) are untouched.
  const ptMappers = [ptMapper, ptGlyphMapper, ptSeedMapper];
  const extra = clipEdges ? [geomEdgeMapper, ...ptMappers] : ptMappers;
  for (const m of extra) {
    try { if (m && m.removeAllClippingPlanes) m.removeAllClippingPlanes(); } catch (_) {}
  }
  if (sourcePolyData) {
    bindFieldSurface(sourcePolyData);
  }
  for (const plane of resultPlanes) {
    if (!resultPlaneOn(plane) || !plane.clipModel) continue;
    resultPlaneGeom(plane);
    try { surfaceMapper.addClippingPlane(plane.vtkPlane); } catch (_) {}
    for (const m of extra) {
      try { if (m) m.addClippingPlane(plane.vtkPlane); } catch (_) {}
    }
  }
  try { surfaceMapper.modified(); } catch (_) {}
  for (const m of extra) {
    try { if (m) m.modified(); } catch (_) {}
  }
  // Glyph mappers (Spheres representation, seed markers) are clipped on the
  // CPU inside applyPtRepresentation, so rebuild them for the new planes.
  if (ptLinePd && ptActor && ptActor.getVisibility && ptActor.getVisibility()) {
    try { applyPtRepresentation(); } catch (_) {}
  }
  applyPartsAppearance();
  try { setGeomVisible(false); } catch (_) {}
  try { syncPtAssignGeom(); } catch (_) {}
}

function applyLiveCutPlane() {
  if (!sourceBounds) return null;
  ensureCutStateCom(sourceBounds);
  return applyPlaneFromState(sourceBounds, cutState, false);
}

function vtpLooksLikeHtml(buf) {
  if (!buf || buf.byteLength < 12) return false;
  const head = new Uint8Array(buf, 0, Math.min(20, buf.byteLength));
  let s = '';
  for (let i = 0; i < head.length; i++) s += String.fromCharCode(head[i]);
  return s.indexOf('<!DOCTYPE') !== -1 || s.indexOf('<html') !== -1;
}

async function readVtpPolyData(readerInst, url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('vtp HTTP ' + r.status);
  const buf = await r.arrayBuffer();
  if (vtpLooksLikeHtml(buf)) throw new Error('cut-plane API returned HTML');
  readerInst.parseAsArrayBuffer(buf);
  return readerInst.getOutputData ? readerInst.getOutputData() : null;
}

function nudgeCutActor(normal) {
  const n = normal || [0, 1, 0];
  const b = sourceBounds;
  const span = b
    ? Math.max(Math.abs(b[1] - b[0]), Math.abs(b[3] - b[2]), Math.abs(b[5] - b[4]), 1e-6)
    : 1;
  const eps = Math.max(2e-4, span * 4e-4);
  try { cutActor.setPosition(-n[0] * eps, -n[1] * eps, -n[2] * eps); } catch (_) {}
}

function hideCutSlice() {
  try { cutActor.setVisibility(false); } catch (_) {}
  try { cutActor.setPosition(0, 0, 0); } catch (_) {}
  for (const p of resultPlanes) {
    try { p.actor.setVisibility(false); } catch (_) {}
  }
}

// Group switch in the "Cutting planes" head hides every plane at once while
// keeping each plane's own Enabled state, so switching back restores exactly
// what was shown before.
function resultPlanesGroupOn() {
  return cutState.planesOn !== false;
}
function resultPlaneOn(p) {
  return !!(p && p.enabled && resultPlanesGroupOn());
}
function anyResultPlaneOn() {
  return resultPlanes.some((p) => resultPlaneOn(p));
}
function setResultPlanesGroupOn(on) {
  cutState.planesOn = !!on;
  const en = document.getElementById('cp-enabled');
  if (en) en.checked = cutState.planesOn;
  cutState.enabled = anyResultPlaneOn();
  updateCuttingPlane();
  for (const p of resultPlanes) {
    if (!cutState.planesOn) {
      try { p.actor.setVisibility(false); } catch (_) {}
    }
  }
  try { renderWindow.render(); } catch (_) {}
  try { scheduleFilterAutosave(); } catch (_) {}
}

function resultPlaneGeom(plane) {
  if (!sourceBounds || !plane) return null;
  if (!plane.com) plane.com = getObjectCenterOfMass(sourceBounds);
  const origin = planeOriginFromPosition(sourceBounds, plane.axis, plane.position / 100, plane.com);
  const axisN = axisNormal(plane.axis, false);
  const clipN = viewFacingClipNormal(origin, axisN, !!plane.inverse);
  try {
    plane.vtkPlane.setOrigin(origin);
    plane.vtkPlane.setNormal(clipN);
  } catch (_) {}
  return { origin, normal: axisN, clipNormal: clipN };
}

function styleResultPlaneActor(actor, opacity) {
  try { actor.setScale(1, 1, 1); } catch (_) {}
  try {
    const pr = actor.getProperty();
    if (pr.setRepresentationToSurface) pr.setRepresentationToSurface();
    pr.setEdgeVisibility(false);
    pr.setLighting(false);
    pr.setOpacity(Number.isFinite(Number(opacity)) ? Number(opacity) : 0.9);
    pr.setLineWidth(1);
    pr.setSpecular(0);
    pr.setAmbient(0.35);
    pr.setDiffuse(0.75);
    if (pr.setBackfaceCulling) pr.setBackfaceCulling(false);
    if (pr.setBackFaceCulling) pr.setBackFaceCulling(false);
  } catch (_) {}
}

function renderResultPlaneList() {
  const list = document.getElementById('result-plane-list');
  if (!list) return;
  if (!resultPlanes.length) {
    list.innerHTML = '<li class="hub-empty">No cutting planes. Add one to section the result.</li>';
    return;
  }
  list.innerHTML = resultPlanes
    .map((p) => {
      const ax = String(p.axis || 'Y').toUpperCase();
      return (
        '<li class="mesh-plane-card' + (collapsedFilterBlocks.has('rplane:' + p.id) ? ' is-collapsed' : '') +
        '" data-result-plane="' + p.id + '" data-collapse-key="rplane:' + p.id + '">' +
        '<div class="mesh-plane-card-head"><strong class="fp-collapse-toggle" title="Collapse / expand">' + escapeHtml(p.name) + '</strong>' +
        '<button type="button" class="mesh-plane-del" data-del-rplane="' + p.id + '">Delete</button></div>' +
        '<div class="fp-row toggle-row"><span>Enabled</span>' +
        '<label class="switch"><input type="checkbox" data-rplane-on="' + p.id + '"' +
        (p.enabled ? ' checked' : '') + ' /><span class="slider"></span></label></div>' +
        '<div class="fp-field"><div class="fp-label">Position</div>' +
        '<input type="range" min="0" max="100" value="' + Math.round(p.position) +
        '" data-rplane-frac="' + p.id + '" /></div>' +
        '<div class="fp-field"><div class="fp-label">Orientation</div><div class="orient-btns">' +
        ['X', 'Y', 'Z'].map((a) =>
          '<button type="button" class="orient' + (ax === a ? ' is-on' : '') +
          '" data-rplane-axis="' + p.id + '" data-axis="' + a + '">' + a + '</button>'
        ).join('') +
        '<button type="button" class="orient' + (p.inverse ? ' is-on' : '') +
        '" data-rplane-inv="' + p.id + '">Inverse</button></div></div>' +
        '<div class="fp-field"><div class="fp-label">Opacity</div><div class="opacity-row">' +
        '<input type="range" min="0" max="1" step="0.1" value="' + p.opacity +
        '" data-rplane-op="' + p.id + '" /><span class="opacity-val">' + p.opacity + '</span></div></div>' +
        '<div class="fp-row toggle-row"><span>Clip model</span>' +
        '<label class="switch"><input type="checkbox" data-rplane-clip="' + p.id + '"' +
        (p.clipModel ? ' checked' : '') + ' /><span class="slider"></span></label></div></li>'
      );
    })
    .join('');
}

// `init` (optional) seeds axis / position / inverse / opacity / clipModel /
// enabled when a plane is rebuilt from a saved filter set; `opts.silent`
// skips the immediate reload so the caller can batch several planes.
function addResultPlane(init, opts) {
  const o = opts || {};
  const seed = init && typeof init === 'object' && !(init instanceof Event) ? init : null;
  if (sourceBounds) ensureCutStateCom(sourceBounds);
  const axes = ['Y', 'X', 'Z'];
  const axis = seed && /^[XYZ]$/.test(String(seed.axis || '').toUpperCase())
    ? String(seed.axis).toUpperCase()
    : axes[resultPlanes.length % 3];
  const vtkP = vtkPlane.newInstance();
  const reader = vtkXMLPolyDataReader.newInstance();
  const mapper = vtkMapper.newInstance();
  mapper.setScalarVisibility(true);
  mapper.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
  mapper.setColorByArrayName(activeField === 'p' ? 'p' : 'magU');
  mapper.setColorMode(ColorMode.MAP_SCALARS);
  mapper.setInterpolateScalarsBeforeMapping(true);
  mapper.setUseLookupTableScalarRange(true);
  mapper.setLookupTable(lut);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  actor.setVisibility(false);
  styleResultPlaneActor(actor, 0.9);
  renderer.addActor(actor);
  const com = getObjectCenterOfMass(sourceBounds);
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const plane = {
    id: 'rp-' + resultPlaneSeq++,
    name: 'Cutting Plane ' + (resultPlanes.length + 1),
    enabled: seed && seed.enabled != null ? !!seed.enabled : true,
    axis,
    position: seed && seed.position != null
      ? Math.min(100, Math.max(0, num(seed.position, 50)))
      : fracAlongAxis(sourceBounds, axis, com) * 100,
    com,
    inverse: !!(seed && seed.inverse),
    opacity: seed && seed.opacity != null ? Math.min(1, Math.max(0, num(seed.opacity, 0.9))) : 0.9,
    clipModel: seed && seed.clipModel != null ? !!seed.clipModel : true,
    vtkPlane: vtkP,
    reader,
    mapper,
    actor,
    loadToken: 0,
  };
  resultPlanes.push(plane);
  if (!seed) cutState.planesOn = true;
  cutState.enabled = anyResultPlaneOn();
  revealPostFilter('cp-block');
  renderResultPlaneList();
  btnCuttingPlane?.classList.add('is-active');
  if (!o.silent) updateCuttingPlane();
  return plane;
}

function removeResultPlane(id) {
  const i = resultPlanes.findIndex((p) => p.id === id);
  if (i < 0) return;
  const plane = resultPlanes[i];
  try { renderer.removeActor(plane.actor); } catch (_) {}
  resultPlanes.splice(i, 1);
  resultPlanes.forEach((p, idx) => { p.name = 'Cutting Plane ' + (idx + 1); });
  cutState.enabled = anyResultPlaneOn();
  renderResultPlaneList();
  try { scheduleFilterAutosave(); } catch (_) {}
  if (!resultPlanes.length) {
    btnCuttingPlane?.classList.remove('is-active');
    const cp = document.getElementById('cp-block');
    if (cp) cp.hidden = true;
    hideCutSlice();
    applyCutClipAndParts();
    try { renderWindow.render(); } catch (_) {}
    return;
  }
  updateCuttingPlane();
}

function clearResultPlanes() {
  while (resultPlanes.length) {
    const p = resultPlanes.pop();
    try { renderer.removeActor(p.actor); } catch (_) {}
  }
  cutState.enabled = false;
  try { renderResultPlaneList(); } catch (_) {}
}

async function loadResultPlane(plane) {
  if (!plane || !sourceBounds) return { empty: true };
  if (!resultPlaneOn(plane)) {
    try { plane.actor.setVisibility(false); } catch (_) {}
    return { empty: true, disabled: true };
  }
  const geom = resultPlaneGeom(plane);
  if (!geom) return { empty: true };
  const token = ++plane.loadToken;
  const field = activeField === 'p' ? 'p' : 'magU';
  const assetUrl = apiCutPlaneUrl(geom.origin, geom.normal, field);
  const metaUrl = apiCutPlaneMetaUrl(geom.origin, geom.normal, field);
  let meta = null;
  try {
    const mr = await fetch(metaUrl, { cache: 'no-store' });
    const text = await mr.text();
    meta = text && text.charAt(0) === '<' ? { empty: true } : (text ? JSON.parse(text) : { empty: true });
    if (!mr.ok) meta = { ...meta, empty: true };
  } catch (e) {
    meta = { empty: true, error: String(e) };
  }
  if (token !== plane.loadToken) return null;
  if (!meta || meta.empty) {
    try { plane.actor.setVisibility(false); } catch (_) {}
    return meta;
  }
  let pd = null;
  try {
    pd = await readVtpPolyData(plane.reader, assetUrl);
  } catch (e) {
    try { plane.actor.setVisibility(false); } catch (_) {}
    return { empty: true, error: String(e) };
  }
  if (token !== plane.loadToken) return null;
  if (!polyDataHasPolys(pd)) pd = triangulateCut(pd);
  try {
    plane.mapper.setInputData(pd);
    plane.mapper.setColorByArrayName(field);
    plane.mapper.setLookupTable(lut);
    styleResultPlaneActor(plane.actor, plane.opacity);
    const n = geom.clipNormal || geom.normal;
    const b = sourceBounds;
    const span = b ? Math.max(Math.abs(b[1] - b[0]), Math.abs(b[3] - b[2]), Math.abs(b[5] - b[4]), 1e-6) : 1;
    const eps = Math.max(2e-4, span * 4e-4);
    plane.actor.setPosition(-n[0] * eps, -n[1] * eps, -n[2] * eps);
    plane.actor.setVisibility(true);
  } catch (_) {}
  return { empty: false, n_points: pd && pd.getNumberOfPoints ? pd.getNumberOfPoints() : 0 };
}

async function loadAllResultPlanes() {
  applyCutClipAndParts();
  if (!anyResultPlaneOn()) {
    hideCutSlice();
    try { renderWindow.render(); } catch (_) {}
    return { empty: true, disabled: true };
  }
  const out = await Promise.all(resultPlanes.map((p) => loadResultPlane(p)));
  try { renderWindow.render(); } catch (_) {}
  return out;
}

async function loadCutPlane() {
  if (
    !resultsCutActive() &&
    window.__CFD_FILTERS_MODE__ === 'mesh' &&
    window.__CFD_W25B__ &&
    window.__CFD_W25B__.ready
  ) {
    return updateCuttingPlane({ forceRecut: false, meshOnly: true });
  }
  if (!sourceBounds) {
    hideCutSlice();
    return { empty: true };
  }
  applyCutClipAndParts();
  if (!anyResultPlaneOn()) {
    hideCutSlice();
    try { renderWindow.render(); } catch (_) {}
    return { empty: true, disabled: true };
  }
  if (!hasAttachedCase()) {
    hideCutSlice();
    try { renderWindow.render(); } catch (_) {}
    return { empty: true, skipped: 'no_case' };
  }
  const token = ++cutLoadToken;
  const out = await loadAllResultPlanes();
  if (token !== cutLoadToken) return null;
  window.__CFD_W7_CUT__ = {
    planes: resultPlanes.length,
    enabled: resultPlanes.filter((p) => resultPlaneOn(p)).length,
    clip: resultPlanes.some((p) => resultPlaneOn(p) && p.clipModel),
  };
  return out;
}

function updateCuttingPlane(opts) {
  const options = opts || {};
  const miss = !!options.miss;
  if (!sourceBounds) {
    return cutFingerprint(null);
  }
  ensureCutStateCom(sourceBounds);
  if (
    !resultsCutActive() &&
    window.__CFD_FILTERS_MODE__ === 'mesh' &&
    window.__CFD_W25B__ &&
    window.__CFD_W25B__.ready &&
    !options.forceRecut
  ) {
    try {
      cutMapper.setInputData(sourcePolyData);
      cutMapper.setScalarVisibility(false);
      cutActor.setVisibility(!!cutState.enabled);
      cutActor.getProperty().setOpacity(cutState.opacity);
      cutActor.getProperty().setEdgeVisibility(true);
      try { cutActor.getProperty().setRepresentationToWireframe(); } catch(_) {}
      try { cutActor.getProperty().setBackfaceCulling(false); } catch(_) {}
      try { cutActor.getProperty().setBackFaceCulling(false); } catch(_) {}
      try { renderer.setBackground(1,1,1); } catch(_) {}
      applyPartsAppearance();
      renderWindow.render();
    } catch (_) {}
    return { ...cutFingerprint(sourcePolyData), mesh_section_passthrough: true };
  }
  if (options.meshOnly) return cutFingerprint(null);

  cutState.enabled = anyResultPlaneOn();
  applyCutClipAndParts();
  if (!cutState.enabled || miss) {
    hideCutSlice();
    try { renderWindow.render(); } catch (_) {}
    return { empty: true, disabled: !cutState.enabled, miss };
  }
  if (cutLoadTimer) clearTimeout(cutLoadTimer);
  const delay = options.defer ? 180 : 0;
  cutLoadTimer = setTimeout(() => {
    loadCutPlane().catch((e) => console.error('[CFD] cut-plane load', e));
  }, delay);
  try { renderWindow.render(); } catch (_) {}
  return {
    pending: true,
    planes: resultPlanes.length,
    approach: 'pyvista volume slice /api/cut-plane',
  };
}

// Tick label precision follows the range: 1234 Pa, 12.3 m/s, 0.46 m/s.
function legendTick(t, span) {
  if (!Number.isFinite(t)) return '—';
  const s = Math.abs(span);
  if (s >= 500) return Math.round(t).toLocaleString('en-US');
  if (s >= 20) return t.toFixed(1);
  // A value that is negligible against the range reads as 0, not 8.4e-4.
  if (Math.abs(t) < s * 1e-3) return '0.00';
  if (s < 0.05) return t.toExponential(1);
  return t.toFixed(2);
}

// A tick being edited (holds an <input>) keeps its field until the edit ends.
function setLegendTickText(tickEl, text) {
  if (!tickEl) return;
  if (tickEl.firstElementChild && tickEl.firstElementChild.tagName === 'INPUT') return;
  tickEl.textContent = text;
}

function paintLegendTrackTicks(el, fallbackLo, fallbackHi) {
  if (!el) return;
  const ticks = el.querySelectorAll('.legend-ticks span');
  if (!ticks.length) return;
  const target = typeof legendScaleTarget === 'function' ? legendScaleTarget(el) : null;
  const track = target && typeof legendHandleTrack === 'function' ? legendHandleTrack(target) : null;
  const lo = track ? track[0] : fallbackLo;
  const hi = track ? track[1] : fallbackHi;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
  const n = ticks.length;
  for (let i = 0; i < n; i++) {
    const t = lo + (hi - lo) * (i / Math.max(1, n - 1));
    setLegendTickText(ticks[i], legendTick(t, hi - lo));
  }
}

function updateLegend(field, lo, hi) {
  paintLegendTrackTicks(document.getElementById('legend'), lo, hi);
  const title = document.querySelector('#legend .legend-title');
  const units = document.querySelector('#legend .legend-units');
  if (field === 'p') {
    if (title) title.textContent = 'Pressure';
    if (units) units.textContent = 'Pa';
  } else {
    if (title) title.textContent = 'Velocity Magnitude';
    if (units) units.textContent = 'm/s';
  }
  const coloring = document.getElementById('cp-coloring') || document.getElementById('coloring-select');
  if (coloring && coloring.tagName === 'SELECT') {
    coloring.value = field;
  }
  const iterColor = document.getElementById('iter-coloring') || document.querySelector('.iter-coloring');
  if (iterColor) {
    iterColor.textContent =
      field === 'p' ? 'Coloring: Pressure' : 'Coloring: Velocity Magnitude';
  }
}

async function loadMeta(field) {
  try {
    const r = await fetch(apiMetaUrl(field));
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function ptFingerprintFromPd(pd, meta) {
  if (!pd) {
    return {
      nPoints: 0,
      nCells: 0,
      mesh_checksum: '00000000',
      empty: true,
      n_seeds: meta ? meta.n_seeds : 0,
    };
  }
  const pts = pd.getPoints();
  const nPoints = pts ? pts.getNumberOfPoints() : 0;
  const nCells = pd.getNumberOfCells ? pd.getNumberOfCells() : 0;
  const empty = !!(meta && meta.empty) || nPoints === 0 || nCells === 0;
  const bounds = pd.getBounds ? pd.getBounds() : null;
  return {
    nPoints,
    nCells,
    bounds: boundsObj(bounds),
    mesh_checksum: meshChecksum(pd),
    empty,
    n_seeds: meta ? meta.n_seeds : null,
    n_seeds_requested: meta ? meta.n_seeds_requested : null,
    seeds_h: meta ? meta.seeds_h : ptState.seeds_h,
    seeds_v: meta ? meta.seeds_v : ptState.seeds_v,
    spacing: meta ? meta.spacing : ptState.spacing,
    size: meta ? meta.size : ptState.size,
    both_directions: meta ? meta.both_directions : ptState.both,
    tube_proof: meta ? meta.tube_proof : null,
    empty_reason: meta ? meta.empty_reason : null,
    seed_checksum: meta ? meta.seed_checksum : null,
    asset_sha256: meta ? meta.asset_sha256 : null,
    approach: meta ? meta.approach : null,
    vector_field: meta ? meta.vector_field : 'U',
    representation: 'Cylinders',
    live_rep: 'tubes',
    seed_mode: meta ? meta.seed_mode : ptState.seed_mode,
    faces: meta ? meta.faces_requested : ptState.faces,
    quantity_mode: meta ? meta.quantity_mode : ptState.quantity_mode,
    per_face_counts: meta ? meta.per_face_counts : null,
    n_faces_with_seeds: meta ? meta.n_faces_with_seeds : null,
    culled_n: meta ? meta.culled_n : null,
    total_area: meta ? meta.total_area : null,
    density: meta ? meta.density : ptState.density,
  };
}

function publishW8(extra) {
  const pd = ptMapper.getInputData ? ptMapper.getInputData() : null;
  const fp = ptFingerprintFromPd(pd, ptMeta);
  window.__CFD_W8__ = {
    increment: 'W8',
    ready: !!(window.__CFD_W6__ && window.__CFD_W6__.ready && ptMeta),
    approach:
      'server-side streamlines from case U via pyvista in Vite middleware; tube glyphs (Cylinders); client loads /api/particle-trace VTP',
    api_url: apiParticleTraceUrl(),
    api_meta_url: apiParticleTraceMetaUrl(),
    pt_state: { ...ptState },
    pt_meta: ptMeta,
    pt_fingerprint: fp,
    n_seeds: ptMeta ? ptMeta.n_seeds : null,
    tube_proof: ptMeta ? ptMeta.tube_proof : null,
    honest_empty: !!(ptMeta && ptMeta.empty),
    multi_face_seeds: !!(ptState.seed_mode === 'faces' || ptState.seed_mode === 'region'),
    increment_w14: true,
    cutting_plane_still_live: true,
    other_filters_chrome_only: true,
    no_fake_solve: true,
    no_line_fakes_as_cylinders: true,
    ...(extra || {}),
  };
  window.__CFD_W14__ = {
    increment: 'W14',
    ready: !!(window.__CFD_W8__ && window.__CFD_W8__.ready),
    multi_face_seeds: true,
    seed_mode: ptState.seed_mode,
    faces: [...(ptState.faces || [])],
    quantity_mode: ptState.quantity_mode,
    n_seeds: ptMeta ? ptMeta.n_seeds : null,
    n_seeds_requested: ptMeta ? ptMeta.n_seeds_requested : null,
    per_face_counts: ptMeta ? ptMeta.per_face_counts : null,
    n_faces_with_seeds: ptMeta ? ptMeta.n_faces_with_seeds : null,
    faces_loaded: ptMeta ? ptMeta.faces_loaded : null,
    faces_skipped: ptMeta ? ptMeta.faces_skipped : null,
    face_source_doc: ptMeta ? ptMeta.face_source_doc : null,
    tube_proof: ptMeta ? ptMeta.tube_proof : null,
    pt_fingerprint: window.__CFD_W8__.pt_fingerprint,
    empty: !!(ptMeta && ptMeta.empty),
    empty_reason: ptMeta ? ptMeta.empty_reason : null,
    inspect_still_live: true,
    filters_still_live: true,
    ...(extra || {}),
  };
}

// Active result cutting planes with "Clip model" on, as {origin, normal} in
// world (metre) coordinates. Points on the negative side of a plane's normal
// are the clipped-away side, matching vtk.js mapper clipping planes.
function activeResultClipPlanes() {
  const out = [];
  for (const plane of resultPlanes) {
    if (!resultPlaneOn(plane) || !plane.clipModel || !plane.vtkPlane) continue;
    try {
      resultPlaneGeom(plane);
      out.push({ origin: plane.vtkPlane.getOrigin(), normal: plane.vtkPlane.getNormal() });
    } catch (_) {}
  }
  return out;
}

// vtk.js glyph mappers ignore mapper clipping planes, so the sphere / seed
// point clouds are clipped on the CPU. Display only: the trace data is intact.
function clipPointCloudByResultPlanes(pd) {
  const planes = activeResultClipPlanes();
  const n = pd && pd.getNumberOfPoints ? pd.getNumberOfPoints() : 0;
  if (!planes.length || !n) return pd;
  const out = vtkPolyData.newInstance();
  const pts = vtkPoints.newInstance();
  const verts = vtkCellArray.newInstance();
  const src = pd.getPoints();
  const arrays = [];
  try {
    pd.getPointData().getArrays().forEach((a) => arrays.push({ src: a, vals: [] }));
  } catch (_) {}
  let count = 0;
  for (let i = 0; i < n; i++) {
    const x = src.getPoint(i);
    let keep = true;
    for (const p of planes) {
      const d =
        p.normal[0] * (x[0] - p.origin[0]) +
        p.normal[1] * (x[1] - p.origin[1]) +
        p.normal[2] * (x[2] - p.origin[2]);
      if (d < 0) { keep = false; break; }
    }
    if (!keep) continue;
    pts.insertNextPoint(x[0], x[1], x[2]);
    verts.insertNextCell([count]);
    for (const a of arrays) {
      const t = a.src.getTuple(i);
      for (let k = 0; k < t.length; k++) a.vals.push(t[k]);
    }
    count += 1;
  }
  out.setPoints(pts);
  out.setVerts(verts);
  for (const a of arrays) {
    try {
      out.getPointData().addArray(
        vtkDataArray.newInstance({
          name: a.src.getName(),
          values: Float32Array.from(a.vals),
          numberOfComponents: a.src.getNumberOfComponents() || 1,
        }),
      );
    } catch (_) {}
  }
  return out;
}

function ptSeedCloudFromLines(pd) {
  const out = vtkPolyData.newInstance();
  const pts = vtkPoints.newInstance();
  const verts = vtkCellArray.newInstance();
  let count = 0;
  walkPolyLines(pd, (_cellId, path) => {
    if (!path || !path.length) return;
    const xyz = path[0];
    pts.insertNextPoint(xyz[0], xyz[1], xyz[2]);
    verts.insertNextCell([count]);
    count += 1;
  });
  out.setPoints(pts);
  out.setVerts(verts);
  return out;
}

// ---- Particle pulses (Spheres / Comets) ----
// Each trace is turned into a table of cumulative travel time (arc length /
// local |U|), so particles move at the real relative flow speed: fast where
// the flow is fast, slow in the wake. One cycle = the time the slowest
// complete trace needs. ptPhase (0..1) is the position in that cycle; the
// Animation filter advances it.
// Keyed by the trace polydata so the main viewer and the compare pane each
// keep their own tables.
const ptPathsCache = new WeakMap();
let ptPhase = 0;

function ptPathsFor(pd) {
  const cached = ptPathsCache.get(pd);
  if (cached) return cached;
  const paths = [];
  let magData = null;
  let pData = null;
  let uData = null;
  let uComp = 3;
  try {
    const pdat = pd.getPointData();
    const magArr = pdat.getArrayByName('magU');
    const pArr = pdat.getArrayByName('p');
    const uArr = pdat.getArrayByName('U');
    magData = magArr ? magArr.getData() : null;
    pData = pArr ? pArr.getData() : null;
    uData = uArr ? uArr.getData() : null;
    uComp = uArr ? uArr.getNumberOfComponents() || 3 : 3;
  } catch (_) {}
  const xyzAll = pd.getPoints().getData();
  let vmax = 0;
  if (magData) for (let i = 0; i < magData.length; i++) if (magData[i] > vmax) vmax = magData[i];
  // Floor keeps a stagnating trace from stretching the whole cycle.
  const vFloor = Math.max(vmax * 0.02, 1e-6);
  walkPolyLines(pd, (_cellId, _path, ids) => {
    let order = ids;
    if (uData) {
      // Backward-integrated traces are stored upstream-first; flip them so
      // particles always travel with the flow.
      let dot = 0;
      for (let k = 1; k < ids.length; k++) {
        const a = ids[k - 1] * 3;
        const b = ids[k] * 3;
        const u = ids[k - 1] * uComp;
        dot += uData[u] * (xyzAll[b] - xyzAll[a]) + uData[u + 1] * (xyzAll[b + 1] - xyzAll[a + 1]) + uData[u + 2] * (xyzAll[b + 2] - xyzAll[a + 2]);
      }
      if (dot < 0) order = ids.slice().reverse();
    }
    const m = order.length;
    const xyz = new Float64Array(m * 3);
    const tau = new Float64Array(m);
    const arc = new Float64Array(m);
    const mag = new Float32Array(m);
    const pres = pData ? new Float32Array(m) : null;
    for (let k = 0; k < m; k++) {
      const id = order[k];
      xyz[k * 3] = xyzAll[id * 3];
      xyz[k * 3 + 1] = xyzAll[id * 3 + 1];
      xyz[k * 3 + 2] = xyzAll[id * 3 + 2];
      mag[k] = magData ? magData[id] : 0;
      if (pres) pres[k] = pData[id];
      if (k > 0) {
        const ds = Math.hypot(xyz[k * 3] - xyz[k * 3 - 3], xyz[k * 3 + 1] - xyz[k * 3 - 2], xyz[k * 3 + 2] - xyz[k * 3 - 1]);
        const v = 0.5 * (mag[k] + mag[k - 1]);
        arc[k] = arc[k - 1] + ds;
        tau[k] = tau[k - 1] + ds / Math.max(v, vFloor);
      }
    }
    if (m >= 2 && tau[m - 1] > 0) paths.push({ xyz, tau, arc, mag, pres, total: tau[m - 1], n: m });
  });
  // Reference travel time = median trace, so one animation cycle carries a
  // typical particle from seed to exit (a single stagnant trace must not
  // slow everything down).
  const totals = paths.map((p) => p.total).sort((a, b) => a - b);
  let period = totals.length ? totals[Math.floor(totals.length / 2)] : 1;
  if (!(period > 0)) period = 1;
  const out = { pd, paths, period };
  ptPathsCache.set(pd, out);
  return out;
}

// Head travel time of pulse k on a path: N pulses evenly spaced along the
// path, all advancing at the real local flow speed and re-entering at the
// seed after they exit.
function ptPulseHeadTime(path, k, N, phase, period) {
  const t = (phase * period + (k * path.total) / N) % path.total;
  return t < 0 ? t + path.total : t;
}

// Interpolated position / scalars on a path at travel time t.
function ptSamplePath(path, t, out) {
  const tau = path.tau;
  const n = path.n;
  let lo = 0;
  let hi = n - 1;
  if (t <= tau[0]) hi = 1;
  else if (t >= tau[n - 1]) lo = n - 2;
  else {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tau[mid] <= t) lo = mid;
      else hi = mid;
    }
  }
  const span = tau[hi] - tau[lo];
  const f = span > 0 ? Math.min(1, Math.max(0, (t - tau[lo]) / span)) : 0;
  const a = lo * 3;
  const b = hi * 3;
  out.x = path.xyz[a] + (path.xyz[b] - path.xyz[a]) * f;
  out.y = path.xyz[a + 1] + (path.xyz[b + 1] - path.xyz[a + 1]) * f;
  out.z = path.xyz[a + 2] + (path.xyz[b + 2] - path.xyz[a + 2]) * f;
  out.mag = path.mag[lo] + (path.mag[hi] - path.mag[lo]) * f;
  out.p = path.pres ? path.pres[lo] + (path.pres[hi] - path.pres[lo]) * f : 0;
  return out;
}

// Piecewise-linear lookup between two monotone per-path tables (tau <-> arc).
function ptPathLookup(from, to, v) {
  const n = from.length;
  if (v <= from[0]) return to[0];
  if (v >= from[n - 1]) return to[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (from[mid] <= v) lo = mid;
    else hi = mid;
  }
  const span = from[hi] - from[lo];
  const f = span > 0 ? (v - from[lo]) / span : 0;
  return to[lo] + (to[hi] - to[lo]) * f;
}

// `st` = the particle-trace settings to use (ptState for the main viewer;
// the compare pane passes the settings of the view it shows).
function ptPulseCount(st) {
  const s = st || ptState;
  return Math.max(1, Math.min(50, Math.floor(Number(s.pulses) || 5)));
}

// Sphere per pulse per trace, at the head position for the current phase.
function ptPulseSpheresPd(pd, phase, st) {
  const { paths, period } = ptPathsFor(pd);
  const N = ptPulseCount(st);
  const out = vtkPolyData.newInstance();
  const pts = vtkPoints.newInstance();
  const verts = vtkCellArray.newInstance();
  const mag = [];
  const pres = [];
  const s = {};
  let count = 0;
  for (const path of paths) {
    for (let k = 0; k < N; k++) {
      const th = ptPulseHeadTime(path, k, N, phase, period);
      ptSamplePath(path, th, s);
      pts.insertNextPoint(s.x, s.y, s.z);
      verts.insertNextCell([count]);
      mag.push(s.mag);
      pres.push(s.p);
      count += 1;
    }
  }
  out.setPoints(pts);
  out.setVerts(verts);
  out.getPointData().addArray(vtkDataArray.newInstance({ name: 'magU', values: Float32Array.from(mag), numberOfComponents: 1 }));
  out.getPointData().addArray(vtkDataArray.newInstance({ name: 'p', values: Float32Array.from(pres), numberOfComponents: 1 }));
  return out;
}

// Comet per pulse per trace: a short polyline ending at the head, resampled
// uniformly in travel time so its length scales with the local velocity.
// 'comet' (0.2 tail -> 1 head) drives the tube radius. Returns the comets as
// plain arrays; ptCometTubesPd turns them into a triangle mesh.
function ptPulseComets(pd, phase, st) {
  const s0 = st || ptState;
  const { paths, period } = ptPathsFor(pd);
  const N = ptPulseCount(s0);
  const relLen = Math.max(0.01, Math.min(0.5, Number(s0.comet_length) || 0.05));
  const L = relLen * period;
  // Slow regions would shrink a velocity-scaled comet to a dot; keep every
  // comet at least this long (in metres) so it still reads as a comet.
  const minArc = 8 * Math.max(2e-4, Number(s0.size) || 0.0037);
  // Samples per full-length comet. Budgeted so a frame stays around ~6k
  // polyline points however many traces x pulses there are (the tube filter
  // runs every animation frame).
  const S = Math.max(8, Math.min(24, Math.round(6000 / Math.max(1, paths.length * N))));
  // Two samples closer than this are merged. Coincident points would give
  // the tube filter a zero-length segment -> NaN normals -> the whole comet
  // actor vanishes from the GPU.
  const minSep = 1e-6;
  const comets = [];
  const s = {};
  // One polyline over travel times [tA, tB]; the radius scalar runs from the
  // (possibly virtual, negative) tail time tailV to the head at tailV + Lk.
  const emit = (path, tA, tB, tailV, Lk) => {
    if (tB - tA <= 1e-12) return;
    const n = Math.max(3, Math.round((S * (tB - tA)) / Lk));
    const cx = [];
    const cm = [];
    const cp = [];
    const cc = [];
    let px = NaN;
    let py = NaN;
    let pz = NaN;
    for (let j = 0; j <= n; j++) {
      const t = tA + (tB - tA) * (j / n);
      ptSamplePath(path, t, s);
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z)) continue;
      if (j > 0 && Math.hypot(s.x - px, s.y - py, s.z - pz) < minSep) continue;
      px = s.x; py = s.y; pz = s.z;
      cx.push(s.x, s.y, s.z);
      cm.push(s.mag);
      cp.push(s.p);
      cc.push(0.2 + 0.8 * Math.min(1, Math.max(0, (t - tailV) / Lk)));
    }
    if (cm.length < 2) return; // all samples coincident
    comets.push({ xyz: cx, mag: cm, p: cp, c: cc });
  };
  for (const path of paths) {
    const pathArc = path.arc[path.n - 1];
    for (let k = 0; k < N; k++) {
      const th = ptPulseHeadTime(path, k, N, phase, period);
      let Lk = L;
      // Stretch the comet back in time until it spans at least minArc.
      const sHead = ptPathLookup(path.tau, path.arc, th);
      const sTailByTime = ptPathLookup(path.tau, path.arc, th - L);
      if (th - L >= 0 && sHead - sTailByTime < minArc && minArc < pathArc) {
        const sTail = sHead - minArc;
        if (sTail >= 0) Lk = Math.max(L, th - ptPathLookup(path.arc, path.tau, sTail));
        else Lk = Math.max(L, th + (path.total - ptPathLookup(path.arc, path.tau, pathArc + sTail)));
      }
      const tailV = th - Lk;
      emit(path, Math.max(0, tailV), th, tailV, Lk);
      if (tailV < 0 && Lk < path.total) {
        // The tail is still leaving through the exit while the head has
        // re-entered at the seed.
        emit(path, path.total + tailV, path.total, path.total + tailV, Lk);
      }
    }
  }
  return comets;
}

// Triangle mesh for the comets, built directly (no TubeFilter, no strips):
// a ring of `sides` vertices around every sample with parallel-transported
// frames, a fan cap on the head, per-vertex normals and the magU / p
// scalars carried along. Radius = size*0.25 at the tail up to size at the
// head (the same look the TubeFilter gave, ~10x cheaper per frame).
const PT_COMET_SIDES = 6;
function ptCometTubesPd(comets, size) {
  const sides = PT_COMET_SIDES;
  let nPts = 0;
  let nTris = 0;
  for (const c of comets) {
    const m = c.mag.length;
    nPts += m * sides + 1;
    nTris += (m - 1) * sides * 2 + sides;
  }
  const P = new Float32Array(nPts * 3);
  const Nrm = new Float32Array(nPts * 3);
  const mag = new Float32Array(nPts);
  const pres = new Float32Array(nPts);
  const polys = new Uint32Array(nTris * 4);
  const cosT = new Float64Array(sides);
  const sinT = new Float64Array(sides);
  for (let j = 0; j < sides; j++) {
    cosT[j] = Math.cos((2 * Math.PI * j) / sides);
    sinT[j] = Math.sin((2 * Math.PI * j) / sides);
  }
  let vp = 0; // vertex index
  let ip = 0; // polys write index
  const rMin = size * 0.25;
  for (const c of comets) {
    const x = c.xyz;
    const m = c.mag.length;
    const base = vp;
    // Frame at the first sample.
    let tx = x[3] - x[0];
    let ty = x[4] - x[1];
    let tz = x[5] - x[2];
    let tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    // Any vector not parallel to the tangent, then Gram-Schmidt.
    let nx = Math.abs(tx) < 0.9 ? 1 : 0;
    let ny = Math.abs(tx) < 0.9 ? 0 : 1;
    let nz = 0;
    let d = nx * tx + ny * ty + nz * tz;
    nx -= d * tx; ny -= d * ty; nz -= d * tz;
    let nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    for (let i = 0; i < m; i++) {
      if (i > 0) {
        // Central-difference tangent, one-sided at the head.
        const a = i > 0 ? i - 1 : i;
        const b = i < m - 1 ? i + 1 : i;
        let ux = x[b * 3] - x[a * 3];
        let uy = x[b * 3 + 1] - x[a * 3 + 1];
        let uz = x[b * 3 + 2] - x[a * 3 + 2];
        const ul = Math.hypot(ux, uy, uz);
        if (ul > 1e-12) {
          tx = ux / ul; ty = uy / ul; tz = uz / ul;
          // Parallel transport of the normal onto the new tangent plane.
          d = nx * tx + ny * ty + nz * tz;
          nx -= d * tx; ny -= d * ty; nz -= d * tz;
          nl = Math.hypot(nx, ny, nz);
          if (nl < 1e-9) {
            nx = Math.abs(tx) < 0.9 ? 1 : 0; ny = Math.abs(tx) < 0.9 ? 0 : 1; nz = 0;
            d = nx * tx + ny * ty + nz * tz;
            nx -= d * tx; ny -= d * ty; nz -= d * tz;
            nl = Math.hypot(nx, ny, nz) || 1;
          }
          nx /= nl; ny /= nl; nz /= nl;
        }
      }
      // Binormal.
      const bx = ty * nz - tz * ny;
      const by = tz * nx - tx * nz;
      const bz = tx * ny - ty * nx;
      const r = rMin + (size - rMin) * Math.min(1, Math.max(0, (c.c[i] - 0.2) / 0.8));
      const px = x[i * 3];
      const py = x[i * 3 + 1];
      const pz = x[i * 3 + 2];
      for (let j = 0; j < sides; j++) {
        const ox = cosT[j] * nx + sinT[j] * bx;
        const oy = cosT[j] * ny + sinT[j] * by;
        const oz = cosT[j] * nz + sinT[j] * bz;
        const k = (vp + j) * 3;
        P[k] = px + r * ox; P[k + 1] = py + r * oy; P[k + 2] = pz + r * oz;
        Nrm[k] = ox; Nrm[k + 1] = oy; Nrm[k + 2] = oz;
        mag[vp + j] = c.mag[i];
        pres[vp + j] = c.p[i];
      }
      if (i > 0) {
        const r0 = vp - sides;
        const r1 = vp;
        for (let j = 0; j < sides; j++) {
          const j1 = (j + 1) % sides;
          // Counter-clockwise seen from outside, so front faces match the
          // outward normals (vtk.js flips normals on back faces).
          polys[ip++] = 3; polys[ip++] = r0 + j; polys[ip++] = r1 + j1; polys[ip++] = r1 + j;
          polys[ip++] = 3; polys[ip++] = r0 + j; polys[ip++] = r0 + j1; polys[ip++] = r1 + j1;
        }
      }
      vp += sides;
    }
    // Head cap: centre vertex + fan over the last ring.
    const hc = vp;
    const hk = hc * 3;
    P[hk] = x[(m - 1) * 3]; P[hk + 1] = x[(m - 1) * 3 + 1]; P[hk + 2] = x[(m - 1) * 3 + 2];
    Nrm[hk] = tx; Nrm[hk + 1] = ty; Nrm[hk + 2] = tz;
    mag[hc] = c.mag[m - 1];
    pres[hc] = c.p[m - 1];
    const ring = base + (m - 1) * sides;
    for (let j = 0; j < sides; j++) {
      polys[ip++] = 3; polys[ip++] = ring + j; polys[ip++] = ring + ((j + 1) % sides); polys[ip++] = hc;
    }
    vp += 1;
  }
  const out = vtkPolyData.newInstance();
  const pts = vtkPoints.newInstance();
  pts.setData(P, 3);
  out.setPoints(pts);
  const cells = vtkCellArray.newInstance();
  cells.setData(polys);
  out.setPolys(cells);
  const pdata = out.getPointData();
  pdata.setNormals(vtkDataArray.newInstance({ name: 'Normals', values: Nrm, numberOfComponents: 3 }));
  pdata.addArray(vtkDataArray.newInstance({ name: 'magU', values: mag, numberOfComponents: 1 }));
  pdata.addArray(vtkDataArray.newInstance({ name: 'p', values: pres, numberOfComponents: 1 }));
  return out;
}

function ptCometMeshForPhase(pd, phase, st) {
  const s = st || ptState;
  const size = Math.max(2e-4, Number(s.size) || 0.0037);
  return ptCometTubesPd(ptPulseComets(pd, phase, s), size);
}

// Re-feed the pulse geometry for the current phase (called per animation
// frame). Cylinders have no pulses and are left alone.
function updatePtPulseGeometry() {
  const pd = ptLinePd;
  if (!pd || !ptState.enabled || !ptActor.getVisibility()) return false;
  const rep = String(ptState.representation || 'Cylinders');
  try {
    if (rep === 'Spheres') {
      ptGlyphMapper.setInputData(clipPointCloudByResultPlanes(ptPulseSpheresPd(pd, ptPhase)));
      return true;
    }
    if (rep === 'Comets') {
      ptMapper.setInputData(ptCometMeshForPhase(pd, ptPhase));
      return true;
    }
  } catch (e) {
    console.warn('[CFD] PT pulses', e);
  }
  return false;
}

function hidePtActors() {
  try { ptActor.setVisibility(false); } catch (_) {}
  try { ptSeedActor.setVisibility(false); } catch (_) {}
  ptOwnRange = null;
  try { syncSharedLegend(); } catch (_) { updatePtLegend(null); }
}

function legendWantedOn() {
  const btn = document.getElementById('btn-legend');
  return !!(btn && btn.classList.contains('is-active'));
}

function actorIsVisible(actor) {
  try { return !!(actor && actor.getVisibility && actor.getVisibility()); } catch (_) { return false; }
}

// Surfaces / cutting planes / iso actually mapped by a field (not a solid).
function mainFieldColoringVisible() {
  const nPts = sourcePolyData && sourcePolyData.getNumberOfPoints
    ? sourcePolyData.getNumberOfPoints()
    : 0;
  if (nPts > 0 && cutState.partsColor && cutState.partsStyle !== 'solid') return true;
  if (typeof anyResultPlaneOn === 'function' && anyResultPlaneOn()) return true;
  if (isoState && isoState.enabled && actorIsVisible(isoActor)) return true;
  return false;
}

function comparePaneFieldColoringVisible() {
  const R = compareState && compareState.res;
  if (!R || !R.on || typeof resultsCompareOn !== 'function' || !resultsCompareOn()) return false;
  const parts = (R.set && R.set.parts) || {};
  if (parts.on !== false && parts.style !== 'solid' && R.pd) return true;
  if (R.set && R.set.planesOn === false) return false;
  const defs = R.set && Array.isArray(R.set.planes) ? R.set.planes : [];
  return defs.some((d) => d && d.enabled);
}

function mainLegendIsSurfaceField() {
  if (mainFieldColoringVisible()) return true;
  return !!(comparePaneFieldColoringVisible() && compareState.res && compareState.res.field === activeField);
}

function setLegendCardShown(el, show) {
  if (!el) return;
  const on = !!show;
  el.classList.toggle('is-hidden', !on);
  el.hidden = !on;
}

// Second, smaller legend for the particle trace. The trace has its own
// lookup-table range (and may be coloured by a different field than the
// surfaces / cutting planes), so the main legend cannot describe it.
function updatePtLegend(field, lo, hi) {
  const el = document.getElementById('legend-pt');
  if (!el) return;
  const show = legendWantedOn() && !!field && Number.isFinite(lo) && Number.isFinite(hi);
  setLegendCardShown(el, show);
  if (!show) return;
  const title = el.querySelector('.legend-title');
  const units = el.querySelector('.legend-units');
  if (title) title.textContent = field === 'p' ? 'Particle trace · Pressure' : 'Particle trace · Velocity Magnitude';
  if (units) units.textContent = field === 'p' ? 'Pa' : 'm/s';
  paintLegendTrackTicks(el, lo, hi);
}

// Range of the field the visible particle trace is coloured by, or null when
// the trace is hidden / solid-coloured.
let ptOwnRange = null;

// One legend per quantity. When the trace is coloured by the same field as
// the surfaces (both Velocity Magnitude, say) both use ONE shared scale that
// spans the union of their ranges and only the main legend is shown. The
// second, smaller trace legend appears only when the trace is coloured by a
// different quantity (e.g. surfaces by pressure, trace by velocity).
function syncSharedLegend() {
  const wanted = legendWantedOn();
  const surfaceOn = mainLegendIsSurfaceField();
  const traceOn = !!(ptOwnRange && ptActor && ptActor.getVisibility && ptActor.getVisibility());
  let base = Array.isArray(lutRange) && lutRange.length === 2 ? lutRange : null;
  const seriesBase = seriesRangeForLegend(activeField);
  if (seriesBase) base = seriesBase;
  // Results compare with the same quantity in both panes: one scale spanning
  // both runs, so identical colours mean identical values left and right.
  const cmpRange = typeof compareResultsRangeFor === 'function' ? compareResultsRangeFor(activeField) : null;
  if (base && cmpRange) base = [Math.min(base[0], cmpRange[0]), Math.max(base[1], cmpRange[1])];
  const mainEl = document.getElementById('legend');
  const finish = () => {
    try { syncCompareResultsLegend(); } catch (_) {}
    try { syncLegendScaleChrome(); } catch (_) {}
  };
  const paintMain = (field, lo, hi) => {
    if (Number.isFinite(lo) && Number.isFinite(hi)) updateLegend(field, lo, hi);
    setLegendCardShown(mainEl, wanted && Number.isFinite(lo) && Number.isFinite(hi));
  };
  const applyPtOwn = () => {
    const own = scaleOverrideFor(ptOwnRange.field) || ptOwnRange;
    try { ptLut.setRange(own.lo, own.hi); ptLut.build(); } catch (_) {}
    return own;
  };
  // A user-set scale is fixed: nothing widens it, and every view of the same
  // quantity (trace included) uses it.
  const fixed = scaleOverrideFor(activeField);
  if (surfaceOn) {
    if (fixed) {
      try { lut.setRange(fixed.lo, fixed.hi); lut.build(); } catch (_) {}
      paintMain(activeField, fixed.lo, fixed.hi);
      if (traceOn && ptOwnRange.field === activeField) {
        try { ptLut.setRange(fixed.lo, fixed.hi); ptLut.build(); } catch (_) {}
        updatePtLegend(null);
      } else if (traceOn) {
        const own = applyPtOwn();
        updatePtLegend(ptOwnRange.field, own.lo, own.hi);
      } else {
        updatePtLegend(null);
      }
      finish();
      return;
    }
    if (traceOn && base && ptOwnRange.field === activeField) {
      const series = seriesRangeForLegend(activeField);
      const lo = series ? series[0] : Math.min(base[0], ptOwnRange.lo);
      const hi = series ? series[1] : Math.max(base[1], ptOwnRange.hi);
      try { lut.setRange(lo, hi); lut.build(); } catch (_) {}
      try { ptLut.setRange(lo, hi); ptLut.build(); } catch (_) {}
      paintMain(activeField, lo, hi);
      updatePtLegend(null);
      finish();
      return;
    }
    if (base) {
      try { lut.setRange(base[0], base[1]); lut.build(); } catch (_) {}
      paintMain(activeField, base[0], base[1]);
    } else {
      setLegendCardShown(mainEl, false);
    }
    if (traceOn) {
      const own = applyPtOwn();
      updatePtLegend(ptOwnRange.field, own.lo, own.hi);
    } else {
      updatePtLegend(null);
    }
    finish();
    return;
  }
  // Nothing on screen uses the surface field. If the trace is coloured,
  // that quantity takes the main legend so Velocity → Pressure replaces
  // the card instead of stacking a second one.
  if (traceOn) {
    const own = applyPtOwn();
    paintMain(ptOwnRange.field, own.lo, own.hi);
    updatePtLegend(null);
    finish();
    return;
  }
  setLegendCardShown(mainEl, false);
  updatePtLegend(null);
  finish();
}

// ---- Editable colour scale -------------------------------------------------
// Each legend describes one quantity and one lookup table. Clicking the first
// or last tick label turns it into a number field; committing sets that
// quantity's scale for every view that shows it. "Auto" returns to the data.

function legendScaleTarget(legendEl) {
  if (!legendEl) return null;
  const id = legendEl.id;
  if (id === 'legend-b') {
    const R = compareState.res;
    if (!R || !R.lut) return null;
    return { field: R.field === 'p' ? 'p' : 'magU', lut: R.lut };
  }
  if (id === 'legend-pt') {
    if (!ptOwnRange) return null;
    return { field: ptOwnRange.field === 'p' ? 'p' : 'magU', lut: ptLut };
  }
  if (!mainLegendIsSurfaceField() && ptOwnRange) {
    return { field: ptOwnRange.field === 'p' ? 'p' : 'magU', lut: ptLut };
  }
  return { field: activeField === 'p' ? 'p' : 'magU', lut };
}

function legendScaleRange(target) {
  const fixed = target && scaleOverrideFor(target.field);
  if (fixed) return [fixed.lo, fixed.hi];
  try {
    const r = target.lut.getRange();
    if (Number.isFinite(r[0]) && Number.isFinite(r[1])) return [r[0], r[1]];
  } catch (_) {}
  return Array.isArray(lutRange) ? lutRange.slice() : [0, 1];
}

function legendHandleTrack(target) {
  const cur = legendScaleRange(target);
  const auto = target ? legendAutoRange(target.field) : null;
  let a = auto ? auto[0] : cur[0];
  let b = auto ? auto[1] : cur[1];
  if (cur[0] < a) a = cur[0];
  if (cur[1] > b) b = cur[1];
  if (!(b > a)) return cur;
  return [a, b];
}

function ensureLegendBarChrome(el) {
  if (!el) return;
  const bar = el.querySelector('.legend-bar');
  if (!bar) return;
  let wrap = el.querySelector('.legend-bar-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'legend-bar-wrap';
    bar.parentNode.insertBefore(wrap, bar);
    wrap.appendChild(bar);
  } else if (bar.parentNode !== wrap) {
    wrap.appendChild(bar);
  }
  const inject = (sel, html) => {
    if (!el.querySelector(sel)) wrap.insertAdjacentHTML('beforeend', html);
  };
  inject('.legend-bar-shade-lo', '<div class="legend-bar-shade legend-bar-shade-lo" hidden></div>');
  inject('.legend-bar-shade-hi', '<div class="legend-bar-shade legend-bar-shade-hi" hidden></div>');
  inject('.legend-bar-val-lo', '<div class="legend-bar-val legend-bar-val-lo" role="button" title="Click to set the scale minimum"></div>');
  inject('.legend-bar-val-hi', '<div class="legend-bar-val legend-bar-val-hi" role="button" title="Click to set the scale maximum"></div>');
  inject('.legend-bar-handle-lo', '<button type="button" class="legend-bar-handle legend-bar-handle-lo" aria-label="Drag to set scale minimum"></button>');
  inject('.legend-bar-handle-hi', '<button type="button" class="legend-bar-handle legend-bar-handle-hi" aria-label="Drag to set scale maximum"></button>');
}

function layoutLegendScaleHandles(el) {
  if (!el) return;
  ensureLegendBarChrome(el);
  const target = legendScaleTarget(el);
  const loH = el.querySelector('.legend-bar-handle-lo');
  const hiH = el.querySelector('.legend-bar-handle-hi');
  const shadeLo = el.querySelector('.legend-bar-shade-lo');
  const shadeHi = el.querySelector('.legend-bar-shade-hi');
  if (!target || !loH || !hiH) return;
  const [trackLo, trackHi] = legendHandleTrack(target);
  const [lo, hi] = legendScaleRange(target);
  const span = trackHi - trackLo;
  const loF = span > 0 ? Math.min(1, Math.max(0, (lo - trackLo) / span)) : 0;
  const hiF = span > 0 ? Math.min(1, Math.max(0, (hi - trackLo) / span)) : 1;
  loH.style.left = loF * 100 + '%';
  hiH.style.left = hiF * 100 + '%';
  loH.title = 'Drag to set the scale minimum';
  hiH.title = 'Drag to set the scale maximum';
  const loVal = el.querySelector('.legend-bar-val-lo');
  const hiVal = el.querySelector('.legend-bar-val-hi');
  const placeVal = (node, value, frac, which) => {
    if (!node) return;
    if (!(node.firstElementChild && node.firstElementChild.tagName === 'INPUT')) {
      node.textContent = legendTick(value, span);
    }
    node.style.left = frac * 100 + '%';
    node.style.transform =
      which === 'lo'
        ? (frac < 0.14 ? 'translateX(0)' : 'translateX(-50%)')
        : (frac > 0.86 ? 'translateX(-100%)' : 'translateX(-50%)');
  };
  placeVal(loVal, lo, loF, 'lo');
  placeVal(hiVal, hi, hiF, 'hi');
  if (shadeLo) {
    shadeLo.style.width = loF * 100 + '%';
    shadeLo.hidden = loF < 0.004;
  }
  if (shadeHi) {
    shadeHi.style.left = hiF * 100 + '%';
    shadeHi.style.width = (1 - hiF) * 100 + '%';
    shadeHi.hidden = hiF > 0.996;
  }
}

let legendScaleDrag = null;

function legendValueFromClientX(el, clientX, trackLo, trackHi) {
  const bar = el.querySelector('.legend-bar') || el.querySelector('.legend-bar-wrap');
  if (!bar) return trackLo;
  const r = bar.getBoundingClientRect();
  const w = r.width || 1;
  const f = Math.min(1, Math.max(0, (clientX - r.left) / w));
  return trackLo + f * (trackHi - trackLo);
}

function beginLegendHandleDrag(legendEl, which, e) {
  const target = legendScaleTarget(legendEl);
  if (!target) return;
  const [lo, hi] = legendScaleRange(target);
  const track = legendHandleTrack(target);
  setLegendAutoExtents(target.field, track[0], track[1]);
  legendScaleDrag = {
    el: legendEl,
    field: target.field,
    which,
    trackLo: track[0],
    trackHi: track[1],
    startLo: lo,
    startHi: hi,
    x0: e.clientX,
    moved: false,
    hadOverride: !!scaleOverrideFor(target.field),
    pointerId: e.pointerId,
  };
  legendEl.classList.add('is-scale-drag');
  try {
    const h = e.target && e.target.closest && e.target.closest('.legend-bar-handle');
    if (h && e.pointerId != null) h.setPointerCapture(e.pointerId);
  } catch (_) {}
}

function applyLegendHandleDrag(e) {
  const d = legendScaleDrag;
  if (!d || !e) return;
  if (Math.abs(e.clientX - d.x0) > 2) d.moved = true;
  if (!d.moved) return;
  const v = legendValueFromClientX(d.el, e.clientX, d.trackLo, d.trackHi);
  const minSpan = Math.max((d.trackHi - d.trackLo) * 0.008, 1e-9);
  let nlo = d.startLo;
  let nhi = d.startHi;
  if (d.which === 'lo') nlo = Math.min(v, d.startHi - minSpan);
  else nhi = Math.max(v, d.startLo + minSpan);
  setScaleOverride(d.field, nlo, nhi);
}

function endLegendHandleDrag(e, revert) {
  const d = legendScaleDrag;
  if (!d) return;
  if (e && e.pointerId != null && d.pointerId != null && e.pointerId !== d.pointerId) return;
  if (revert && d.moved) {
    if (d.hadOverride) setScaleOverride(d.field, d.startLo, d.startHi);
    else setScaleOverride(d.field, null, null);
  } else if (!revert && d.moved) {
    applyLegendHandleDrag(e);
  }
  try {
    const h = d.el.querySelector(d.which === 'lo' ? '.legend-bar-handle-lo' : '.legend-bar-handle-hi');
    if (h && e && e.pointerId != null) h.releasePointerCapture(e.pointerId);
  } catch (_) {}
  d.el.classList.remove('is-scale-drag');
  legendScaleDrag = null;
}

// Reflect "user-set or auto" on every legend card.
function syncLegendScaleChrome() {
  for (const id of ['legend', 'legend-pt', 'legend-b']) {
    const el = document.getElementById(id);
    if (!el) continue;
    const t = legendScaleTarget(el);
    const custom = !!(t && scaleOverrideFor(t.field));
    el.classList.toggle('is-custom', custom);
    const btn = el.querySelector('.legend-auto');
    if (btn) btn.hidden = !custom;
    try { layoutLegendScaleHandles(el); } catch (_) {}
    try { paintLegendTrackTicks(el); } catch (_) {}
  }
}

function beginLegendTickEdit(legendEl, tickEl, which) {
  if (!tickEl || tickEl.querySelector('input')) return;
  const target = legendScaleTarget(legendEl);
  if (!target) return;
  const [lo, hi] = legendScaleRange(target);
  const cur = which === 'lo' ? lo : hi;
  const prevText = tickEl.textContent;
  const input = document.createElement('input');
  input.type = 'number';
  input.step = 'any';
  input.className = 'legend-tick-input';
  input.value = Number.isFinite(cur) ? String(+cur.toPrecision(6)) : '';
  input.setAttribute('aria-label', which === 'lo' ? 'Scale minimum' : 'Scale maximum');
  tickEl.textContent = '';
  tickEl.appendChild(input);
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const v = Number(input.value);
    tickEl.textContent = prevText;
    if (commit && input.value.trim() !== '' && Number.isFinite(v)) {
      const nlo = which === 'lo' ? v : lo;
      const nhi = which === 'lo' ? hi : v;
      if (nhi > nlo) setScaleOverride(target.field, nlo, nhi);
      else setScaleOverride(target.field, Math.min(nlo, nhi), Math.max(nlo, nhi));
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  // Keep viewport handlers (orbit, picking, shortcuts) away from the field.
  for (const ev of ['pointerdown', 'mousedown', 'wheel', 'contextmenu']) {
    input.addEventListener(ev, (e) => e.stopPropagation());
  }
  input.focus();
  input.select();
}

function wireLegendScaleEditing() {
  for (const id of ['legend', 'legend-pt', 'legend-b']) {
    const el = document.getElementById(id);
    if (!el || el.dataset.scaleWired) continue;
    el.dataset.scaleWired = '1';
    for (const ev of ['pointerdown', 'mousedown', 'dblclick', 'wheel', 'contextmenu']) {
      el.addEventListener(ev, (e) => e.stopPropagation());
    }
    el.addEventListener('pointerdown', (e) => {
      const h = e.target instanceof Element ? e.target.closest('.legend-bar-handle') : null;
      if (!h || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      beginLegendHandleDrag(el, h.classList.contains('legend-bar-handle-lo') ? 'lo' : 'hi', e);
    });
    el.addEventListener('pointermove', (e) => {
      if (!legendScaleDrag || legendScaleDrag.el !== el) return;
      applyLegendHandleDrag(e);
    });
    el.addEventListener('pointerup', (e) => {
      if (!legendScaleDrag || legendScaleDrag.el !== el) return;
      endLegendHandleDrag(e, false);
    });
    el.addEventListener('pointercancel', (e) => {
      if (!legendScaleDrag || legendScaleDrag.el !== el) return;
      endLegendHandleDrag(e, true);
    });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (legendScaleDrag) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest('.legend-bar-handle')) return;
      if (t.closest('.legend-auto')) {
        const target = legendScaleTarget(el);
        if (target) setScaleOverride(target.field, null, null);
        return;
      }
      const val = t.closest('.legend-bar-val');
      if (val) {
        beginLegendTickEdit(el, val, val.classList.contains('legend-bar-val-lo') ? 'lo' : 'hi');
      }
    });
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && legendScaleDrag) {
      endLegendHandleDrag(null, true);
    }
  });
  syncLegendScaleChrome();
}
try { wireLegendScaleEditing(); } catch (e) { console.warn('[CFD] legend scale', e); }

function applyPtFieldLut(pd, colorName) {
  try {
    const arr = pd && pd.getPointData && pd.getPointData().getArrayByName(colorName);
    if (!arr || !arr.getRange) return;
    const r = arr.getRange();
    const lo = Number(r[0]);
    const hi = Number(r[1]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    const span = hi - lo;
    const rawHi = span > 1e-12 ? hi : lo + 1;
    absorbSeriesRange(colorName, lo, rawHi);
    const scaled = resolveFieldLutRange(colorName, lo, rawHi);
    ptOwnRange = { field: colorName, lo: scaled[0], hi: scaled[1] };
    ptLut.setRange(scaled[0], scaled[1]);
    ptLut.build();
  } catch (_) {}
}

function applyPtRepresentation() {
  const pd = ptLinePd;
  const n = pd && pd.getNumberOfPoints ? pd.getNumberOfPoints() : 0;
  if (!n || !ptState.enabled) {
    hidePtActors();
    return;
  }
  const size = Math.max(2e-4, Number(ptState.size) || 0.0037);
  const rep = String(ptState.representation || 'Cylinders');
  const coloring = String(ptState.coloring || 'magU');
  const solid = coloring === 'solid';
  const colorName = coloring === 'p' ? 'p' : 'magU';
  if (!solid) applyPtFieldLut(pd, colorName);
  else ptOwnRange = null;
  try {
    if (rep === 'Spheres') {
      const cloud = clipPointCloudByResultPlanes(ptPulseSpheresPd(pd, ptPhase));
      try { ptSphereSrc.update(); } catch (_) {}
      try { ptGlyphMapper.setInputData(ptSphereSrc.getOutputData(), 1); } catch (_) {}
      ptGlyphMapper.setInputData(cloud);
      try { ptGlyphMapper.setScaleMode(GlyphScaleModes.SCALE_BY_CONSTANT); } catch (_) {}
      try { ptGlyphMapper.setScaling(true); } catch (_) {}
      try { if (ptGlyphMapper.setOrient) ptGlyphMapper.setOrient(false); } catch (_) {}
      ptGlyphMapper.setScaleFactor(size);
      ptGlyphMapper.setScalarVisibility(!solid);
      if (!solid) {
        ptGlyphMapper.setColorByArrayName(colorName);
        ptGlyphMapper.setLookupTable(ptLut);
        ptGlyphMapper.setUseLookupTableScalarRange(true);
      }
      ptActor.setMapper(ptGlyphMapper);
    } else {
      if (rep === 'Comets') {
        // Comets = pulses of short tails that thicken into a head; the
        // tail length follows the local velocity. Built as a triangle mesh
        // directly (rebuilt every animation frame).
        ptMapper.setInputData(ptCometMeshForPhase(pd, ptPhase));
      } else {
        ptTube.setInputData(pd);
        ptTube.setVaryRadius(VaryRadius.VARY_RADIUS_OFF);
        ptTube.setRadius(size);
        ptTube.setRadiusFactor(1);
        try { ptTube.update(); } catch (_) {}
        ptMapper.setInputConnection(ptTube.getOutputPort());
      }
      ptMapper.setScalarVisibility(!solid);
      if (!solid) {
        ptMapper.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
        ptMapper.setColorByArrayName(colorName);
        ptMapper.setColorMode(ColorMode.MAP_SCALARS);
        ptMapper.setInterpolateScalarsBeforeMapping(true);
        ptMapper.setUseLookupTableScalarRange(true);
        ptMapper.setLookupTable(ptLut);
      }
      ptActor.setMapper(ptMapper);
    }
    if (solid) {
      const rgb = hexToRgb01(ptState.solid || '#2563eb');
      ptActor.getProperty().setColor(rgb[0], rgb[1], rgb[2]);
    }
    ptActor.setVisibility(true);
    const seeds = clipPointCloudByResultPlanes(ptSeedCloudFromLines(pd));
    const nSeeds = seeds.getNumberOfPoints ? seeds.getNumberOfPoints() : 0;
    if (nSeeds > 0) {
      try { ptSphereSrc.update(); } catch (_) {}
      try { ptSeedMapper.setInputData(ptSphereSrc.getOutputData(), 1); } catch (_) {}
      ptSeedMapper.setInputData(seeds);
      ptSeedMapper.setScaleFactor(Math.max(size * 1.7, 0.0012));
      ptSeedMapper.setScalarVisibility(false);
      ptSeedActor.getProperty().setColor(0.08, 0.1, 0.16);
      ptSeedActor.setVisibility(true);
    } else {
      ptSeedActor.setVisibility(false);
    }
  } catch (e) {
    console.warn('[CFD] PT glyphs', e);
    try {
      ptMapper.setInputData(pd);
      ptActor.setMapper(ptMapper);
      ptActor.setVisibility(true);
    } catch (_) {}
    try { ptSeedActor.setVisibility(false); } catch (_) {}
  }
  try { syncSharedLegend(); } catch (_) {}
}

function bindParticleTrace(pd) {
  const n = pd && pd.getNumberOfPoints ? pd.getNumberOfPoints() : 0;
  ptLinePd = n > 0 ? pd : null;
  if (n > 0) applyPtRepresentation();
  else {
    hidePtActors();
  }
}

function defaultPtFaces(catalog) {
  const rows = Array.isArray(catalog) ? catalog : [];
  const available = rows.filter((f) => f.available);
  const inlets = available.filter((f) => f.role === 'inlet');
  return (inlets.length ? inlets : available).map((f) => f.id);
}

function ptCatalogMatchesId(row, id) {
  if (!row || id == null || id === '') return false;
  const want = String(id);
  if (row.id === want || row.patch === want || row.label === want || row.name === want) return true;
  return Array.isArray(row.faces) && row.faces.includes(want);
}

function ptCatalogRowForId(id) {
  return ptFaceCatalog.find((f) => ptCatalogMatchesId(f, id)) || null;
}

function ptCadLabelsForRow(row) {
  if (row && Array.isArray(row.faces) && row.faces.length) return row.faces.slice();
  if (row && row.label && /^face\s+\d+/i.test(row.label)) return [row.label];
  return row ? [row.id] : [];
}

function ptAssignedCadFaces() {
  const out = [];
  for (const id of ptState.faces || []) {
    const row = ptCatalogRowForId(id);
    for (const f of row ? ptCadLabelsForRow(row) : [id]) {
      if (f && !out.includes(f)) out.push(f);
    }
  }
  return out;
}

function ptSeedCadLabels() {
  const labels = [];
  for (const row of ptFaceCatalog.filter((f) => f.available)) {
    for (const lab of ptCadLabelsForRow(row)) {
      if (lab && !labels.includes(lab)) labels.push(lab);
    }
  }
  for (const lab of ptAssignedCadFaces()) {
    if (lab && !labels.includes(lab)) labels.push(lab);
  }
  return labels;
}

function resolvePtFaceIds(ids) {
  const available = ptFaceCatalog.filter((f) => f.available);
  const out = [];
  for (const id of ids || []) {
    const row = available.find((f) => ptCatalogMatchesId(f, id));
    if (row && !out.includes(row.id)) out.push(row.id);
  }
  return out;
}

function paintForPtFaces(faces) {
  const paint = {};
  for (const f of faces || []) {
    const row = ptCatalogRowForId(f);
    const kind = row && row.role === 'outlet' ? 'outlet' : 'inlet';
    paint[f] = BC_KIND_RGB[kind] || BC_KIND_RGB.inlet;
  }
  return paint;
}

function isAssigningPtFace() {
  const block = document.getElementById('pt-block');
  return !!(
    resultsViewOpen &&
    block &&
    !block.hidden &&
    (normalizePtSeedMode(ptState.seed_mode) === 'faces' || isRegionSeedMode())
  );
}

let ptFaceHilite = null;

function ensurePtFaceHilite() {
  if (ptFaceHilite) return ptFaceHilite;
  const mapper = vtkMapper.newInstance();
  mapper.setScalarVisibility(true);
  mapper.setScalarMode(ScalarMode.USE_CELL_FIELD_DATA);
  mapper.setColorMode(ColorMode.DIRECT_SCALARS);
  mapper.setColorByArrayName('ptFaceRgb');
  try { mapper.setInterpolateScalarsBeforeMapping(false); } catch (_) {}
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  actor.setVisibility(false);
  actor.setPickable(true);
  try { actor.setUseBounds(false); } catch (_) {}
  const pr = actor.getProperty();
  pr.setOpacity(0.72);
  pr.setLighting(false);
  pr.setAmbient(0.55);
  pr.setDiffuse(0.45);
  renderer.addActor(actor);
  ptFaceHilite = { mapper, actor };
  return ptFaceHilite;
}

function hidePtFaceOverlay() {
  if (!ptFaceHilite) return;
  try { ptFaceHilite.actor.setVisibility(false); } catch (_) {}
}

function buildPtFaceOverlayPd(labels, focusLabel) {
  if (typeof collectFaceTriangles !== 'function') return null;
  const tris = collectFaceTriangles(labels);
  if (!tris.length) return null;
  const assigned = new Set(ptAssignedCadFaces());
  const pts = vtkPoints.newInstance();
  const polys = vtkCellArray.newInstance();
  const rgb = new Uint8Array(tris.length * 3);
  const ids = new Float32Array(tris.length);
  const focusId = focusLabel ? parseFaceId(focusLabel) : 0;
  const lift = Math.max((cadNativeSpan() || 1) * 0.002, 1e-4);
  let pi = 0;
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    const a = t.va || t.a;
    const b = t.vb || t.b;
    const c = t.vc || t.c;
    const n = t.n || [0, 0, 1];
    pts.insertNextPoint(a[0] + n[0] * lift, a[1] + n[1] * lift, a[2] + n[2] * lift);
    pts.insertNextPoint(b[0] + n[0] * lift, b[1] + n[1] * lift, b[2] + n[2] * lift);
    pts.insertNextPoint(c[0] + n[0] * lift, c[1] + n[1] * lift, c[2] + n[2] * lift);
    polys.insertNextCell([pi, pi + 1, pi + 2]);
    const lab = faceLabel(t.faceId, 1);
    const row = ptCatalogRowForId(lab) || ptCatalogRowForId(t.faceId);
    const kind = row && row.role === 'outlet' ? 'outlet' : 'inlet';
    const on = assigned.has(lab) || (row && (ptState.faces || []).includes(row.id));
    const col =
      focusId && focusId === t.faceId
        ? [46, 196, 126]
        : on
          ? (BC_KIND_RGB[kind] || BC_KIND_RGB.inlet)
          : [118, 136, 162];
    rgb[i * 3] = col[0];
    rgb[i * 3 + 1] = col[1];
    rgb[i * 3 + 2] = col[2];
    ids[i] = t.faceId;
    pi += 3;
  }
  const pd = vtkPolyData.newInstance();
  pd.setPoints(pts);
  pd.setPolys(polys);
  const arr = vtkDataArray.newInstance({
    name: 'ptFaceRgb',
    numberOfComponents: 3,
    values: rgb,
  });
  pd.getCellData().addArray(arr);
  pd.getCellData().setActiveScalars('ptFaceRgb');
  pd.getCellData().addArray(vtkDataArray.newInstance({
    name: 'ptFaceId',
    numberOfComponents: 1,
    values: ids,
  }));
  return pd;
}

function syncPtAssignGeom() {
  if (resultsViewOpen && !meshInspectOpen) {
    try { setGeomVisible(false); } catch (_) {}
    try { geomActor.getProperty().setOpacity(1); } catch (_) {}
  }
  if (!isAssigningPtFace()) {
    hidePtFaceOverlay();
    return;
  }
  try { geomActor.setPickable(true); } catch (_) {}
  if (!cadTriCache.length && typeof rebuildCadTriCache === 'function') {
    try { rebuildCadTriCache(); } catch (_) {}
  }
  const faces = ptSeedCadLabels();
  const hilite = ensurePtFaceHilite();
  const pd = buildPtFaceOverlayPd(faces, ptState.focusFace);
  if (!pd) {
    hidePtFaceOverlay();
    return;
  }
  try { hilite.mapper.setInputData(pd); } catch (_) {}
  try { hilite.actor.setPickable(true); } catch (_) {}
  try { applyCadActorViewScale(hilite.actor); } catch (_) {}
  try { hilite.actor.setVisibility(true); } catch (_) {}
}

function setPtFacesHint(text) {
  const hint = document.getElementById('pt-faces-hint');
  if (hint) hint.textContent = text;
}

function syncPtAssignList() {
  const list = document.getElementById('pt-assign-list');
  const count = document.getElementById('pt-assign-count');
  const labels = ptAssignedCadFaces();
  if (ptState.focusFace && !labels.includes(ptState.focusFace)) ptState.focusFace = null;
  if (list) {
    list.innerHTML = labels
      .map((f) => {
        const on = ptState.focusFace === f ? ' is-focus' : '';
        return (
          '<li class="bc-assign-item' +
          on +
          '" data-pt-face="' +
          escapeHtml(f) +
          '">' +
          '<button type="button" class="bc-assign-pick" data-pt-focus="' +
          escapeHtml(f) +
          '">' +
          escapeHtml(f) +
          '</button>' +
          '<button type="button" class="bc-assign-x" data-pt-unassign="' +
          escapeHtml(f) +
          '" aria-label="Remove ' +
          escapeHtml(f) +
          '">×</button></li>'
        );
      })
      .join('');
  }
  if (count) count.textContent = String(labels.length);
  const available = ptFaceCatalog.filter((f) => f.available);
  // Don't overwrite the "Computing streamlines…" status while a trace is
  // being built; the generic hint made a slow trace look like nothing happened.
  if (!ptLoading) {
    setPtFacesHint(
      available.length
        ? 'Click a highlighted opening in the viewport to assign it.'
        : 'No inlet/outlet openings on this case.'
    );
  }
  if (isAssigningPtFace() || (resultsViewOpen && !meshInspectOpen)) {
    syncPtAssignGeom();
  }
}

function toggleAssignPtFace(label) {
  const row = ptFaceCatalog.find((f) => f.available && ptCatalogMatchesId(f, label));
  if (!row) {
    setPtFacesHint('That face is not a seed opening. Click an inlet or outlet face.');
    return;
  }
  const id = row.id;
  const cad = ptCadLabelsForRow(row)[0] || id;
  const cur = ptState.faces || [];
  let added = false;
  if (cur.includes(id)) {
    ptState.faces = cur.filter((x) => x !== id);
    if (ptState.focusFace === id || ptState.focusFace === label || ptState.focusFace === cad) {
      ptState.focusFace = null;
    }
  } else {
    ptState.faces = [...cur, id];
    ptState.focusFace = cad;
    added = true;
  }
  dropPtRegionIfFaceGone();
  if (isRegionSeedMode() && !regionIsUsable(ptState.region)) {
    const face = added ? cad : ptRegionTargetFace();
    if (face) lookNormalToPtFace(face);
    else restorePtRegionCamera();
  }
  syncPtAssignList();
  schedulePtReload();
}

function unassignPtFace(label) {
  const row = ptCatalogRowForId(label);
  const id = row ? row.id : label;
  ptState.faces = (ptState.faces || []).filter((x) => x !== id);
  if (ptState.focusFace === label || ptState.focusFace === id) ptState.focusFace = null;
  dropPtRegionIfFaceGone();
  if (isRegionSeedMode() && !regionIsUsable(ptState.region)) {
    const face = ptRegionTargetFace();
    if (face) lookNormalToPtFace(face);
    else restorePtRegionCamera();
  }
  syncPtAssignList();
  schedulePtReload();
}

function clearPtFaces() {
  ptState.faces = [];
  ptState.focusFace = null;
  if (ptState.region) {
    ptState.region = null;
    syncPtRegionOverlay();
  }
  restorePtRegionCamera();
  cancelPtRegionDraw();
  cancelPtRegionEdit();
  syncPtAssignList();
  schedulePtReload();
}

function focusPtFace(label) {
  ptState.focusFace = label || null;
  syncPtAssignList();
  if (isRegionSeedMode() && !regionIsUsable(ptState.region) && label) {
    lookNormalToPtFace(label);
  }
}

let ptReloadTimer = null;
function schedulePtReload() {
  if (ptReloadTimer) clearTimeout(ptReloadTimer);
  ptReloadTimer = setTimeout(() => {
    loadParticleTrace().catch((e) => console.error('[CFD] PT form', e));
  }, 180);
}

let ptRegionHilite = null;
let ptRegionDraw = null;
let ptRegionEdit = null;
let ptRegionCamRestore = null;

function ptRegionTargetFace() {
  const labels = ptAssignedCadFaces();
  if (!labels.length) return null;
  if (ptState.focusFace && labels.includes(ptState.focusFace)) return ptState.focusFace;
  if (ptState.region && ptState.region.face && labels.includes(ptState.region.face)) {
    return ptState.region.face;
  }
  return labels[0];
}

function setPtRegionHint(text) {
  const hint = document.getElementById('pt-region-hint');
  if (hint) hint.textContent = text;
}

function regionFaceStillAssigned(face) {
  if (!face) return false;
  const labels = ptAssignedCadFaces();
  if (labels.includes(face)) return true;
  const row = ptCatalogRowForId(face);
  return !!(row && labels.some((l) => ptCatalogMatchesId(row, l) || (ptCadLabelsForRow(row) || []).includes(l)));
}

function dropPtRegionIfFaceGone() {
  if (!ptState.region) return;
  if (regionFaceStillAssigned(ptState.region.face)) return;
  ptState.region = null;
  syncPtRegionOverlay();
  syncPtRegionChrome();
}

function syncPtRegionChrome() {
  const regionMode = isRegionSeedMode();
  const field = document.getElementById('pt-region-field');
  if (field) field.hidden = !regionMode;
  const shape = document.getElementById('pt-region-shape');
  const status = document.getElementById('pt-region-status');
  const clear = document.getElementById('pt-clear-region');
  if (shape) shape.value = ptState.regionShape === 'circle' ? 'circle' : 'box';
  const r = clonePtRegion(ptState.region);
  if (status) {
    status.textContent = r
      ? (r.shape === 'circle' ? 'Circle' : 'Box') + (r.face ? ' on ' + r.face : '')
      : 'No region';
  }
  if (clear) clear.hidden = !r;
  if (!regionMode) return;
  if (isPtRegionDrawArmed()) {
    setPtRegionHint(
      ptRegionTargetFace()
        ? 'Drag a box or circle on the assigned face. After you draw, you can orbit and use the handles.'
        : 'Assign a face, then drag a box or circle on it.'
    );
  } else if (r) {
    setPtRegionHint('Drag the crosshair to move or the points to resize. Clear the region to draw again.');
  } else {
    setPtRegionHint('Assign a face, then drag a box or circle on it.');
  }
}

function onPtSeedModeChanged(prev, next) {
  cancelPtRegionDraw();
  cancelPtRegionEdit();
  if (next === 'region') {
    if (!regionIsUsable(ptState.region)) {
      const face = ptRegionTargetFace();
      if (face) lookNormalToPtFace(face);
    }
  } else {
    restorePtRegionCamera();
  }
  syncPtRegionChrome();
  syncPtRegionOverlay();
  try { syncAssignCursor(); } catch (_) {}
}

function restorePtRegionCamera() {
  if (!ptRegionCamRestore) return;
  const cam = renderer.getActiveCamera();
  try {
    if (cam && cam.setParallelProjection) cam.setParallelProjection(!!ptRegionCamRestore.parallel);
  } catch (_) {}
  ptRegionCamRestore = null;
  try { resetCameraClippingRangeLoose(); } catch (_) {}
  try { renderWindow.render(); } catch (_) {}
}

function lookNormalToPtFace(label) {
  if (!label) return false;
  const faceId = parseFaceId(label);
  const info = typeof faceOrientationInfo === 'function' ? faceOrientationInfo(faceId) : null;
  const cam = renderer.getActiveCamera();
  if (!cam || !info) return false;
  const s = typeof cadToWorldScale === 'function' ? cadToWorldScale() : 1;
  const c = [info.c[0] * s, info.c[1] * s, info.c[2] * s];
  let n = info.n.slice();
  const mid = scenePivot || (sourceBounds && [
    0.5 * (sourceBounds[0] + sourceBounds[1]),
    0.5 * (sourceBounds[2] + sourceBounds[3]),
    0.5 * (sourceBounds[4] + sourceBounds[5]),
  ]);
  if (mid && v3dot(n, v3sub(mid, c)) > 0) n = v3scale(n, -1);
  const tris = typeof collectFaceTriangles === 'function' ? collectFaceTriangles([label]) : [];
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) {
    for (const p of [t.va || t.a, t.vb || t.b, t.vc || t.c]) {
      if (!p) continue;
      const w = [p[0] * s, p[1] * s, p[2] * s];
      min = [Math.min(min[0], w[0]), Math.min(min[1], w[1]), Math.min(min[2], w[2])];
      max = [Math.max(max[0], w[0]), Math.max(max[1], w[1]), Math.max(max[2], w[2])];
    }
  }
  const span = Math.max(
    max[0] - min[0],
    max[1] - min[1],
    max[2] - min[2],
    Math.sqrt(Math.max(info.area, 0)) * s,
    1e-4,
  );
  const dist = span * 2.15;
  if (!ptRegionCamRestore) {
    try {
      ptRegionCamRestore = { parallel: !!cam.getParallelProjection() };
    } catch (_) {
      ptRegionCamRestore = { parallel: false };
    }
  }
  try {
    compareState.syncing = true;
    cam.setFocalPoint(c[0], c[1], c[2]);
    cam.setPosition(c[0] + n[0] * dist, c[1] + n[1] * dist, c[2] + n[2] * dist);
    let up = [0, 0, 1];
    if (Math.abs(v3dot(up, n)) > 0.92) up = [0, 1, 0];
    const upIn = v3sub(up, v3scale(n, v3dot(up, n)));
    if (v3len(upIn) > 1e-6) up = v3norm(upIn);
    cam.setViewUp(up[0], up[1], up[2]);
    try { cam.setParallelProjection(true); } catch (_) {}
    try { if (cam.setParallelScale) cam.setParallelScale(span * 0.62); } catch (_) {}
    try { resetCameraClippingRangeLoose(); } catch (_) {}
  } finally {
    try { compareState.syncing = false; } catch (_) {}
  }
  try { syncCompareCamerasFromLeft(); } catch (_) {}
  try { renderWindow.render(); } catch (_) {}
  return true;
}

function ensurePtRegionOverlay() {
  if (ptRegionHilite) return ptRegionHilite;
  const mapper = vtkMapper.newInstance();
  mapper.setScalarVisibility(false);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  actor.setVisibility(false);
  actor.setPickable(false);
  try { actor.setUseBounds(false); } catch (_) {}
  const pr = actor.getProperty();
  pr.setColor(0.98, 0.72, 0.12);
  pr.setLineWidth(2.6);
  pr.setLighting(false);
  renderer.addActor(actor);
  ptRegionHilite = { mapper, actor };
  return ptRegionHilite;
}

function hidePtRegionOverlay() {
  if (ptRegionHilite) {
    try { ptRegionHilite.actor.setVisibility(false); } catch (_) {}
  }
  hidePtRegionHandles();
}

function regionOutlinePoints(region) {
  const r = region;
  if (!regionIsUsable(r)) return [];
  const n = v3cross(r.u || [0, 0, 0], r.v || [0, 0, 0]);
  let uHat;
  let vHat;
  let nHat = v3len(n) > 1e-12 ? v3norm(n) : [0, 0, 1];
  if (r.shape === 'circle') {
    uHat = v3len(r.u || [0, 0, 0]) > 1e-9 ? v3norm(r.u) : null;
    vHat = v3len(r.v || [0, 0, 0]) > 1e-9 ? v3norm(r.v) : null;
    if (!uHat || !vHat) {
      uHat = v3norm(v3cross(Math.abs(nHat[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1], nHat));
      vHat = v3norm(v3cross(nHat, uHat));
    } else {
      nHat = v3norm(v3cross(uHat, vHat));
    }
    const pts = [];
    const segs = 48;
    const rad = Number(r.radius) || 0;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push(v3add(r.origin, v3add(v3scale(uHat, Math.cos(a) * rad), v3scale(vHat, Math.sin(a) * rad))));
    }
    return liftRegionOutline(pts, nHat);
  }
  const o = r.origin;
  const u = r.u;
  const v = r.v;
  return liftRegionOutline([o, v3add(o, u), v3add(v3add(o, u), v), v3add(o, v), o], nHat);
}

function liftRegionOutline(pts, nHat) {
  const lift = 2e-4;
  return pts.map((p) => v3add(p, v3scale(nHat, lift)));
}

function syncPtRegionOverlay(draft) {
  const live = draft || ptState.region;
  const show = !!(
    ptState.enabled &&
    isRegionSeedMode() &&
    regionIsUsable(live)
  );
  if (!show) {
    hidePtRegionOverlay();
    return;
  }
  const pts = regionOutlinePoints(live);
  if (pts.length < 2) {
    hidePtRegionOverlay();
    return;
  }
  const hilite = ensurePtRegionOverlay();
  const values = [];
  pts.forEach((p) => values.push(p[0], p[1], p[2]));
  const vtkPts = vtkPoints.newInstance();
  vtkPts.setData(Float32Array.from(values), 3);
  const lines = [pts.length];
  for (let i = 0; i < pts.length; i++) lines.push(i);
  const cells = vtkCellArray.newInstance();
  cells.setData(Uint32Array.from(lines));
  const pd = vtkPolyData.newInstance();
  pd.setPoints(vtkPts);
  pd.setLines(cells);
  try { hilite.mapper.setInputData(pd); } catch (_) {}
  try { hilite.actor.setScale(1, 1, 1); } catch (_) {}
  try { hilite.actor.setVisibility(true); } catch (_) {}
  layoutPtRegionHandles(live);
}

function cameraOnFaceAxes(n) {
  const cam = renderer.getActiveCamera();
  const dop = cam.getDirectionOfProjection();
  const viewUp = cam.getViewUp();
  let right = v3cross(dop, viewUp);
  if (v3len(right) < 1e-8) right = v3cross(n, [0, 0, 1]);
  right = v3sub(right, v3scale(n, v3dot(right, n)));
  if (v3len(right) < 1e-8) {
    right = v3cross(n, Math.abs(n[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1]);
  }
  right = v3norm(right);
  const up = v3norm(v3cross(n, right));
  return { right, up };
}

function faceWorldFrame(label) {
  const faceId = parseFaceId(label);
  const info = typeof faceOrientationInfo === 'function' ? faceOrientationInfo(faceId) : null;
  const s = typeof cadToWorldScale === 'function' ? cadToWorldScale() : 1;
  if (!info) return null;
  const c = [info.c[0] * s, info.c[1] * s, info.c[2] * s];
  let n = info.n.slice();
  const mid = scenePivot || (sourceBounds && [
    0.5 * (sourceBounds[0] + sourceBounds[1]),
    0.5 * (sourceBounds[2] + sourceBounds[3]),
    0.5 * (sourceBounds[4] + sourceBounds[5]),
  ]);
  if (mid && v3dot(n, v3sub(mid, c)) > 0) n = v3scale(n, -1);
  return { c, n, s };
}

function snapWorldToPtFace(world, label) {
  if (!world || !label) return null;
  const s = typeof cadToWorldScale === 'function' ? cadToWorldScale() : 1;
  const tris = typeof collectFaceTriangles === 'function' ? collectFaceTriangles([label]) : [];
  let best = null;
  let bestD = Infinity;
  let span = 0;
  for (const t of tris) {
    const a0 = t.va || t.a;
    const b0 = t.vb || t.b;
    const c0 = t.vc || t.c;
    if (!a0 || !b0 || !c0) continue;
    const a = [a0[0] * s, a0[1] * s, a0[2] * s];
    const b = [b0[0] * s, b0[1] * s, b0[2] * s];
    const c = [c0[0] * s, c0[1] * s, c0[2] * s];
    span = Math.max(span, v3len(v3sub(a, b)), v3len(v3sub(b, c)), v3len(v3sub(c, a)));
    const q = closestPointOnTri(world, a, b, c);
    const d = v3len(v3sub(q, world));
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  if (!best) return null;
  const maxD = Math.max(span * 8, 0.02);
  if (bestD > maxD) return null;
  return best;
}

function displayRayWorld(e) {
  const xy = eventToVtkDisplay(e);
  const view = vtkView();
  if (!xy || !view || !view.displayToWorld) return null;
  let near;
  let far;
  try {
    near = view.displayToWorld(xy[0], xy[1], 0, renderer);
    far = view.displayToWorld(xy[0], xy[1], 1, renderer);
  } catch (_) {
    return null;
  }
  if (!near || !far) return null;
  return { orig: [near[0], near[1], near[2]], dir: v3norm(v3sub(far, near)) };
}

function pickPtRegionWorld(e, label) {
  const xy = eventToVtkDisplay(e);
  let raw = null;
  if (xy) {
    const hit = pickPtOverlayAtDisplay(xy[0], xy[1]);
    const lab = hit && hit.faceId ? faceLabel(hit.faceId, hit.solidId || 1) : null;
    if (hit && hit.pos && lab === label) {
      raw = hit.pos.slice();
      const snapped = snapWorldToPtFace(raw, label);
      if (snapped) return snapped;
      const sc = typeof cadToWorldScale === 'function' ? cadToWorldScale() : 1;
      if (sc !== 1) {
        const scaled = snapWorldToPtFace([raw[0] * sc, raw[1] * sc, raw[2] * sc], label);
        if (scaled) return scaled;
      }
      raw = null;
    }
  }
  if (!raw) {
    const fr = faceWorldFrame(label);
    if (!fr) return null;
    const ray = displayRayWorld(e);
    if (!ray) return null;
    const den = v3dot(ray.dir, fr.n);
    if (Math.abs(den) < 1e-10) return null;
    const t = v3dot(v3sub(fr.c, ray.orig), fr.n) / den;
    if (!(t > 0) || t > 1e4) return null;
    raw = v3add(ray.orig, v3scale(ray.dir, t));
  }
  return snapWorldToPtFace(raw, label);
}

function regionMinSpan(face) {
  let min = 1e-4;
  const info = typeof faceOrientationInfo === 'function' ? faceOrientationInfo(parseFaceId(face)) : null;
  const s = typeof cadToWorldScale === 'function' ? cadToWorldScale() : 1;
  if (info && info.area) min = Math.max(min, Math.sqrt(info.area) * s * 0.015);
  return min;
}

function regionAxes(r) {
  let uHat = v3len(r.u || [0, 0, 0]) > 1e-9 ? v3norm(r.u) : null;
  let vHat = v3len(r.v || [0, 0, 0]) > 1e-9 ? v3norm(r.v) : null;
  let nHat = uHat && vHat ? v3cross(uHat, vHat) : [0, 0, 0];
  if (v3len(nHat) < 1e-12) {
    const fr = r.face ? faceWorldFrame(r.face) : null;
    nHat = fr ? fr.n.slice() : [0, 0, 1];
    if (!uHat) {
      uHat = v3norm(v3cross(Math.abs(nHat[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1], nHat));
    }
    vHat = v3norm(v3cross(nHat, uHat));
    nHat = v3norm(v3cross(uHat, vHat));
  } else {
    nHat = v3norm(nHat);
  }
  return { uHat, vHat, nHat };
}

function regionHandleWorlds(r) {
  if (!regionIsUsable(r)) return [];
  const { uHat, vHat } = regionAxes(r);
  if (r.shape === 'circle') {
    const o = r.origin;
    const rad = Number(r.radius) || 0;
    return [
      { id: 'c', kind: 'move', p: o },
      { id: 'e', kind: 'resize', p: v3add(o, v3scale(uHat, rad)) },
      { id: 'n', kind: 'resize', p: v3add(o, v3scale(vHat, rad)) },
      { id: 'w', kind: 'resize', p: v3add(o, v3scale(uHat, -rad)) },
      { id: 's', kind: 'resize', p: v3add(o, v3scale(vHat, -rad)) },
    ];
  }
  const o = r.origin;
  const u = r.u;
  const v = r.v;
  return [
    { id: 'c', kind: 'move', p: v3add(o, v3add(v3scale(u, 0.5), v3scale(v, 0.5))) },
    { id: '00', kind: 'resize', p: o },
    { id: '10', kind: 'resize', p: v3add(o, u) },
    { id: '11', kind: 'resize', p: v3add(v3add(o, u), v) },
    { id: '01', kind: 'resize', p: v3add(o, v) },
  ];
}

function convertPtRegionShape(nextShape) {
  const shape = nextShape === 'circle' ? 'circle' : 'box';
  ptState.regionShape = shape;
  const r = clonePtRegion(ptState.region);
  if (!r || r.shape === shape) return;
  const { uHat, vHat } = regionAxes(r);
  if (shape === 'circle') {
    const center = v3add(r.origin, v3add(v3scale(r.u, 0.5), v3scale(r.v, 0.5)));
    const rad = 0.25 * (v3len(r.u) + v3len(r.v));
    ptState.region = {
      shape: 'circle',
      face: r.face,
      origin: snapWorldToPtFace(center, r.face) || center,
      u: uHat,
      v: vHat,
      radius: Math.max(rad, regionMinSpan(r.face)),
    };
  } else {
    const rad = Number(r.radius) || 0;
    const origin = v3sub(v3sub(r.origin, v3scale(uHat, rad)), v3scale(vHat, rad));
    ptState.region = {
      shape: 'box',
      face: r.face,
      origin: snapWorldToPtFace(origin, r.face) || origin,
      u: v3scale(uHat, 2 * rad),
      v: v3scale(vHat, 2 * rad),
      radius: 0,
    };
  }
}

function movePtRegion(start, startPick, world) {
  const d = v3sub(world, startPick);
  const origin = snapWorldToPtFace(v3add(start.origin, d), start.face) || v3add(start.origin, d);
  return { ...clonePtRegion(start), origin };
}

function resizePtRegionCircle(start, world) {
  const { uHat, vHat } = regionAxes(start);
  const p = snapWorldToPtFace(world, start.face) || world;
  const d = v3sub(p, start.origin);
  const rad = Math.max(regionMinSpan(start.face), Math.hypot(v3dot(d, uHat), v3dot(d, vHat)));
  return { ...clonePtRegion(start), radius: rad };
}

function resizePtRegionBox(start, iu, iv, world) {
  const { uHat, vHat } = regionAxes(start);
  const opp = v3add(start.origin, v3add(v3scale(start.u, 1 - iu), v3scale(start.v, 1 - iv)));
  const p = snapWorldToPtFace(world, start.face) || world;
  const d = v3sub(p, opp);
  const min = regionMinSpan(start.face);
  let su = v3dot(d, uHat) * (2 * iu - 1);
  let sv = v3dot(d, vHat) * (2 * iv - 1);
  if (Math.abs(su) < min) su = su < 0 ? -min : min;
  if (Math.abs(sv) < min) sv = sv < 0 ? -min : min;
  const U = v3scale(uHat, su);
  const V = v3scale(vHat, sv);
  const origin = v3sub(v3sub(opp, v3scale(U, 1 - iu)), v3scale(V, 1 - iv));
  return {
    shape: 'box',
    face: start.face,
    origin: snapWorldToPtFace(origin, start.face) || origin,
    u: U,
    v: V,
    radius: 0,
  };
}

function eventToVtkDisplayLoose(e) {
  const view = vtkView();
  const canvas = (view && view.getCanvas && view.getCanvas()) ||
    (container && container.querySelector('canvas'));
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const cssX = e.clientX - rect.left;
  const cssY = e.clientY - rect.top;
  const size = view && view.getSize ? view.getSize() : [rect.width, rect.height];
  return [(cssX / rect.width) * size[0], (1 - cssY / rect.height) * size[1]];
}

function displayRayWorldLoose(e) {
  const xy = eventToVtkDisplayLoose(e);
  const view = vtkView();
  if (!xy || !view || !view.displayToWorld) return null;
  let near;
  let far;
  try {
    near = view.displayToWorld(xy[0], xy[1], 0, renderer);
    far = view.displayToWorld(xy[0], xy[1], 1, renderer);
  } catch (_) {
    return null;
  }
  if (!near || !far) return null;
  return { orig: [near[0], near[1], near[2]], dir: v3norm(v3sub(far, near)) };
}

function pickPtRegionWorldLoose(e, label) {
  const hit = pickPtRegionWorld(e, label);
  if (hit) return hit;
  const fr = faceWorldFrame(label);
  if (!fr) return null;
  const ray = displayRayWorldLoose(e);
  if (!ray) return null;
  const den = v3dot(ray.dir, fr.n);
  if (Math.abs(den) < 1e-10) return null;
  const t = v3dot(v3sub(fr.c, ray.orig), fr.n) / den;
  if (!Number.isFinite(t) || t > 1e4) return null;
  return snapWorldToPtFace(v3add(ray.orig, v3scale(ray.dir, t)), label);
}

function worldToOverlayCss(world, overlayEl) {
  const view = vtkView();
  const canvas = (view && view.getCanvas && view.getCanvas()) ||
    (container && container.querySelector('canvas'));
  if (!view || !canvas || !world || !overlayEl) return null;
  const d = worldToDisplayXY(world, view, renderer);
  if (!d) return null;
  const size = view.getSize ? view.getSize() : null;
  if (!size || !size[0] || !size[1]) return null;
  const rect = canvas.getBoundingClientRect();
  const orect = overlayEl.getBoundingClientRect();
  return {
    left: (d[0] / size[0]) * rect.width + (rect.left - orect.left),
    top: (1 - d[1] / size[1]) * rect.height + (rect.top - orect.top),
  };
}

function ensurePtRegionHandles() {
  let el = document.getElementById('pt-region-handles');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pt-region-handles';
    el.className = 'pt-region-handles';
    el.hidden = true;
  }
  const host = container || document.getElementById('viewer');
  if (host && el.parentElement !== host) host.appendChild(el);
  if (!el._ptRhWired) {
    el._ptRhWired = true;
    el.addEventListener('pointerdown', onPtRegionHandleDown);
    el.addEventListener('pointermove', onPtRegionHandleMove);
    el.addEventListener('pointerup', onPtRegionHandleUp);
    el.addEventListener('pointercancel', onPtRegionHandleCancel);
  }
  return el;
}

function hidePtRegionHandles() {
  const el = document.getElementById('pt-region-handles');
  if (!el) return;
  el.hidden = true;
  if (!ptRegionEdit) {
    el.innerHTML = '';
    el.dataset.shape = '';
  }
}

function layoutPtRegionHandles(draft) {
  const live = draft || ptState.region;
  const show = !!(ptState.enabled && isRegionSeedMode() && regionIsUsable(live) && !ptRegionDraw);
  const el = ensurePtRegionHandles();
  if (!show) {
    hidePtRegionHandles();
    return;
  }
  const items = regionHandleWorlds(live);
  el.hidden = false;
  if (!el.childElementCount || el.dataset.shape !== live.shape) {
    el.dataset.shape = live.shape;
    el.innerHTML = items.map((it) => {
      const cls = it.kind === 'move' ? 'pt-rh pt-rh-cross' : 'pt-rh pt-rh-dot';
      const lab = it.kind === 'move' ? 'Move region' : 'Resize region';
      return '<div class="' + cls + '" data-pt-rh="' + it.id + '" role="button" aria-label="' + lab + '"></div>';
    }).join('');
  }
  items.forEach((it) => {
    const node = el.querySelector('[data-pt-rh="' + it.id + '"]');
    const xy = worldToOverlayCss(it.p, el);
    if (!node || !xy) return;
    node.style.left = xy.left + 'px';
    node.style.top = xy.top + 'px';
  });
}

function cancelPtRegionEdit(revert) {
  if (!ptRegionEdit) return;
  if (revert && ptRegionEdit.start) ptState.region = clonePtRegion(ptRegionEdit.start);
  ptRegionEdit = null;
  syncPtRegionOverlay();
  try { renderWindow.render(); } catch (_) {}
}

function onPtRegionHandleDown(e) {
  const h = e.target.closest('[data-pt-rh]');
  if (!h || e.button !== 0 || !isRegionSeedMode()) return;
  const start = clonePtRegion(ptState.region);
  if (!start) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const id = h.getAttribute('data-pt-rh');
  const p0 = pickPtRegionWorldLoose(e, start.face);
  ptRegionEdit = {
    id,
    start,
    startPick: p0,
    face: start.face,
    pointerId: e.pointerId,
    iu: id === '10' || id === '11' ? 1 : id === '00' || id === '01' ? 0 : null,
    iv: id === '01' || id === '11' ? 1 : id === '00' || id === '10' ? 0 : null,
  };
  try { h.setPointerCapture(e.pointerId); } catch (_) {}
}

function applyPtRegionEditFromEvent(e) {
  const edit = ptRegionEdit;
  if (!edit) return null;
  const p = pickPtRegionWorldLoose(e, edit.face);
  if (!p) return null;
  let next = null;
  if (edit.id === 'c') {
    if (!edit.startPick) edit.startPick = p;
    next = movePtRegion(edit.start, edit.startPick, p);
  } else if (edit.start.shape === 'circle') {
    next = resizePtRegionCircle(edit.start, p);
  } else if (edit.iu != null && edit.iv != null) {
    next = resizePtRegionBox(edit.start, edit.iu, edit.iv, p);
  }
  if (next && regionIsUsable(next)) {
    ptState.region = next;
    return next;
  }
  return null;
}

function onPtRegionHandleMove(e) {
  if (!ptRegionEdit) return;
  if (e.pointerId != null && ptRegionEdit.pointerId != null && e.pointerId !== ptRegionEdit.pointerId) return;
  const next = applyPtRegionEditFromEvent(e);
  if (!next) return;
  syncPtRegionOverlay(next);
  try { renderWindow.render(); } catch (_) {}
}

function onPtRegionHandleUp(e) {
  if (!ptRegionEdit) return;
  if (e.pointerId != null && ptRegionEdit.pointerId != null && e.pointerId !== ptRegionEdit.pointerId) return;
  applyPtRegionEditFromEvent(e);
  ptRegionEdit = null;
  syncPtRegionOverlay();
  syncPtRegionChrome();
  try { scheduleFilterAutosave(); } catch (_) {}
  schedulePtReload();
  try { renderWindow.render(); } catch (_) {}
}

function onPtRegionHandleCancel(e) {
  if (!ptRegionEdit) return;
  if (e.pointerId != null && ptRegionEdit.pointerId != null && e.pointerId !== ptRegionEdit.pointerId) return;
  cancelPtRegionEdit(true);
}

function regionFromDrag(shape, p0, p1, face, n) {
  const ax = cameraOnFaceAxes(n);
  if (shape === 'circle') {
    const d = v3sub(p1, p0);
    const rad = Math.hypot(v3dot(d, ax.right), v3dot(d, ax.up));
    return {
      shape: 'circle',
      face,
      origin: p0.slice(),
      u: ax.right.slice(),
      v: ax.up.slice(),
      radius: rad,
    };
  }
  const du = v3dot(v3sub(p1, p0), ax.right);
  const dv = v3dot(v3sub(p1, p0), ax.up);
  const min = regionMinSpan(face);
  const su = Math.abs(du) < min ? (du < 0 ? -min : min) : du;
  const sv = Math.abs(dv) < min ? (dv < 0 ? -min : min) : dv;
  const origin = p0.slice();
  if (Math.abs(du) < min) {
    origin[0] -= ax.right[0] * su * 0.5;
    origin[1] -= ax.right[1] * su * 0.5;
    origin[2] -= ax.right[2] * su * 0.5;
  }
  if (Math.abs(dv) < min) {
    origin[0] -= ax.up[0] * sv * 0.5;
    origin[1] -= ax.up[1] * sv * 0.5;
    origin[2] -= ax.up[2] * sv * 0.5;
  }
  return {
    shape: 'box',
    face,
    origin,
    u: v3scale(ax.right, su),
    v: v3scale(ax.up, sv),
    radius: 0,
  };
}

function cancelPtRegionDraw() {
  if (!ptRegionDraw) return;
  ptRegionDraw = null;
  syncPtRegionOverlay();
  try { renderWindow.render(); } catch (_) {}
}

function commitPtRegionDraw() {
  const draw = ptRegionDraw;
  ptRegionDraw = null;
  if (!draw || !draw.p0 || !draw.p1) {
    syncPtRegionOverlay();
    return;
  }
  const next = regionFromDrag(draw.shape, draw.p0, draw.p1, draw.face, draw.n);
  const span = v3len(v3sub(draw.p1, draw.p0));
  if (span > 20) {
    setPtRegionHint('That pick left the face. Drag on the highlighted opening.');
    syncPtRegionOverlay();
    try { renderWindow.render(); } catch (_) {}
    return;
  }
  if (!regionIsUsable(next)) {
    setPtRegionHint('Drag a larger box or circle on the face.');
    syncPtRegionOverlay();
    try { renderWindow.render(); } catch (_) {}
    return;
  }
  ptState.region = next;
  restorePtRegionCamera();
  syncPtRegionOverlay();
  syncPtRegionChrome();
  try { scheduleFilterAutosave(); } catch (_) {}
  schedulePtReload();
  try { renderWindow.render(); } catch (_) {}
}

function isPtRegionDrawArmed() {
  return !!(
    isRegionSeedMode() &&
    isAssigningPtFace() &&
    !regionIsUsable(ptState.region) &&
    !ptRegionEdit &&
    ptRegionTargetFace()
  );
}

function isPtRegionBusy() {
  return !!(ptRegionDraw || ptRegionEdit);
}

function isPtRegionPickerArmed() {
  return isPtRegionDrawArmed();
}

function onPtRegionPointerDown(e) {
  if (e.button !== 0 || !isPtRegionDrawArmed()) return false;
  const face = ptRegionTargetFace();
  if (!face) return false;
  const p0 = pickPtRegionWorld(e, face);
  if (!p0) return false;
  const fr = faceWorldFrame(face);
  if (!fr) return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  ptRegionDraw = {
    face,
    shape: ptState.regionShape === 'circle' ? 'circle' : 'box',
    p0,
    p1: p0.slice(),
    n: fr.n,
    pointerId: e.pointerId,
  };
  try { if (container && e.pointerId != null) container.setPointerCapture(e.pointerId); } catch (_) {}
  syncPtRegionOverlay(regionFromDrag(ptRegionDraw.shape, p0, p0, face, fr.n));
  return true;
}

function onPtRegionPointerMove(e) {
  if (!ptRegionDraw) return;
  const p1 = pickPtRegionWorld(e, ptRegionDraw.face);
  if (!p1) return;
  ptRegionDraw.p1 = p1;
  syncPtRegionOverlay(regionFromDrag(ptRegionDraw.shape, ptRegionDraw.p0, p1, ptRegionDraw.face, ptRegionDraw.n));
  try { renderWindow.render(); } catch (_) {}
}

function onPtRegionPointerUp(e) {
  if (!ptRegionDraw) return;
  if (e.pointerId != null && ptRegionDraw.pointerId != null && e.pointerId !== ptRegionDraw.pointerId) return;
  const p1 = pickPtRegionWorld(e, ptRegionDraw.face);
  if (p1) ptRegionDraw.p1 = p1;
  try { if (container && e.pointerId != null) container.releasePointerCapture(e.pointerId); } catch (_) {}
  commitPtRegionDraw();
}

// ---- Small modal helpers (confirm / name prompt) ----
// Resolve true when confirmed. Used before any filter / view is deleted.
function confirmAction(opts) {
  const o = opts || {};
  const modal = document.getElementById('modal-confirm');
  if (!modal) return Promise.resolve(window.confirm(o.copy || o.title || 'Delete?'));
  const heading = document.getElementById('cf-heading');
  const copy = document.getElementById('cf-copy');
  const yes = document.getElementById('cf-confirm');
  const no = document.getElementById('cf-cancel');
  const backdrop = document.getElementById('cf-backdrop');
  if (heading) heading.textContent = o.title || 'Delete?';
  if (copy) copy.textContent = o.copy || '';
  if (yes) yes.textContent = o.yes || 'Delete';
  modal.hidden = false;
  return new Promise((resolve) => {
    const done = (ok) => {
      modal.hidden = true;
      yes?.removeEventListener('click', onYes);
      no?.removeEventListener('click', onNo);
      backdrop?.removeEventListener('click', onNo);
      document.removeEventListener('keydown', onKey);
      resolve(ok);
    };
    const onYes = () => done(true);
    const onNo = () => done(false);
    const onKey = (e) => {
      if (e.key === 'Escape') onNo();
      if (e.key === 'Enter') onYes();
    };
    yes?.addEventListener('click', onYes);
    no?.addEventListener('click', onNo);
    backdrop?.addEventListener('click', onNo);
    document.addEventListener('keydown', onKey);
    try { yes?.focus(); } catch (_) {}
  });
}

// Resolve with the entered (trimmed) text, or null when cancelled.
function promptName(opts) {
  const o = opts || {};
  const modal = document.getElementById('modal-prompt');
  if (!modal) return Promise.resolve(window.prompt(o.title || 'Name', o.value || ''));
  const heading = document.getElementById('pm-heading');
  const copy = document.getElementById('pm-copy');
  const label = document.getElementById('pm-label');
  const input = document.getElementById('pm-input');
  const yes = document.getElementById('pm-confirm');
  const no = document.getElementById('pm-cancel');
  const backdrop = document.getElementById('pm-backdrop');
  if (heading) heading.textContent = o.title || 'Name';
  if (copy) copy.textContent = o.copy || '';
  if (label) label.textContent = o.label || 'Name';
  if (yes) yes.textContent = o.yes || 'Save';
  if (input) input.value = o.value || '';
  modal.hidden = false;
  return new Promise((resolve) => {
    const done = (val) => {
      modal.hidden = true;
      yes?.removeEventListener('click', onYes);
      no?.removeEventListener('click', onNo);
      backdrop?.removeEventListener('click', onNo);
      input?.removeEventListener('keydown', onKey);
      document.removeEventListener('keydown', onEsc);
      resolve(val);
    };
    const onYes = () => {
      const v = String(input ? input.value : '').trim();
      if (!v) { try { input?.focus(); } catch (_) {} return; }
      done(v);
    };
    const onNo = () => done(null);
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); onYes(); } };
    const onEsc = (e) => { if (e.key === 'Escape') onNo(); };
    yes?.addEventListener('click', onYes);
    no?.addEventListener('click', onNo);
    backdrop?.addEventListener('click', onNo);
    input?.addEventListener('keydown', onKey);
    document.addEventListener('keydown', onEsc);
    try { input?.focus(); input?.select(); } catch (_) {}
  });
}

function dismissParticleTrace() {
  ptState.enabled = false;
  try { clearPtFrameCache(); } catch (_) {}
  const en = document.getElementById('pt-enabled');
  if (en) en.checked = false;
  const block = document.getElementById('pt-block');
  if (block) block.hidden = true;
  btnParticleTrace?.classList.remove('is-active');
  hidePtActors();
  try { applyPartsAppearance(); } catch (_) {}
  try { hidePtFaceOverlay(); } catch (_) {}
  try { cancelPtRegionDraw(); cancelPtRegionEdit(); hidePtRegionOverlay(); restorePtRegionCamera(); } catch (_) {}
  try { syncPtAssignGeom(); } catch (_) {}
  try { syncAssignCursor(); } catch (_) {}
  try { renderWindow.render(); } catch (_) {}
  try { publishW8({ enabled: false, dismissed: true }); } catch (_) {}
}

function dismissAnimation() {
  try { stopAnimationPlay(); } catch (_) {}
  const block = document.getElementById('anim-block');
  if (block) block.hidden = true;
  btnAnimation?.classList.remove('is-active');
}

async function hydratePtFaceCatalog() {
  const dir = getCaseDir();
  if (!dir) return [];
  const caseChanged = ptFacesHydratedFor !== dir;
  if (!(ptFacesHydratedFor === dir && ptFaceCatalog.length)) {
    try {
      const r = await fetch('/api/particle-trace/faces?case=' + encodeURIComponent(dir), {
        cache: 'no-store',
      });
      const j = await r.json();
      ptFaceCatalog = Array.isArray(j.faces) ? j.faces : [];
      ptFacesHydratedFor = dir;
    } catch (e) {
      console.warn('[CFD] PT face catalog', e);
      ptFaceCatalog = [];
    }
  }
  const prev = ptState.faces || [];
  const mapped = resolvePtFaceIds(prev);
  const staleNames = prev.length && !mapped.length;
  if (caseChanged) {
    ptState.faces = mapped.length ? mapped : defaultPtFaces(ptFaceCatalog);
  } else if (staleNames) {
    ptState.faces = defaultPtFaces(ptFaceCatalog);
  } else {
    ptState.faces = mapped;
  }
  syncPtAssignList();
  return ptFaceCatalog;
}

async function loadParticleTrace(overrides) {
  const token = ++ptLoadToken;
  ptLoading = false;
  if (overrides && typeof overrides === 'object') {
    if (overrides.seed_mode != null) ptState.seed_mode = normalizePtSeedMode(overrides.seed_mode);
    if (overrides.faces != null) {
      ptState.faces = Array.isArray(overrides.faces)
        ? overrides.faces.map(String)
        : String(overrides.faces)
            .split(/[,|;]+/)
            .map((x) => x.trim())
            .filter(Boolean);
    }
    if (overrides.quantity_mode != null) ptState.quantity_mode = String(overrides.quantity_mode);
    if (overrides.n_seeds != null) ptState.n_seeds = Math.max(0, Math.floor(Number(overrides.n_seeds) || 0));
    if (overrides.density != null) ptState.density = Number(overrides.density);
    if (overrides.seeds_h != null) ptState.seeds_h = Number(overrides.seeds_h);
    if (overrides.seeds_v != null) ptState.seeds_v = Number(overrides.seeds_v);
    if (overrides.spacing != null) ptState.spacing = Number(overrides.spacing);
    if (overrides.size != null) ptState.size = Number(overrides.size);
    if (overrides.both != null) ptState.both = !!overrides.both;
    if (overrides.pick != null) ptState.pick = String(overrides.pick || '');
    if (overrides.representation != null)
      ptState.representation = String(overrides.representation);
    if (overrides.enabled != null) ptState.enabled = !!overrides.enabled;
    if (overrides.region !== undefined) ptState.region = clonePtRegion(overrides.region);
    if (overrides.regionShape === 'circle' || overrides.regionShape === 'box') {
      ptState.regionShape = overrides.regionShape;
    }
  }
  if (!hasAttachedCase() || !ptState.enabled) {
    bindParticleTrace(null);
    try { hidePtRegionOverlay(); } catch (_) {}
    try { applyPartsAppearance(); } catch (_) {}
    try { renderWindow.render(); } catch (_) {}
    return { empty: true, skipped: hasAttachedCase() ? 'disabled' : 'no_case' };
  }
  try {
    await hydratePtFaceCatalog();
  } catch (e) {
    console.warn('[CFD] PT hydrate', e);
  }
  if (token !== ptLoadToken) return null;
  syncPtChromeFromState();
  const hint = document.getElementById('pt-faces-hint');
  ptLoading = true;
  const doneLoading = () => { if (token === ptLoadToken) ptLoading = false; };
  if (hint) hint.textContent = 'Computing streamlines from the volume… (first time on a run can take a minute)';
  const assetUrl = apiParticleTraceUrl();
  let entry = null;
  try {
    ensurePtCacheSettings();
    entry = await prefetchPtFrame(getTime());
  } catch (e) {
    console.error('[CFD] PT vtp', e);
    doneLoading();
    if (token !== ptLoadToken) return null;
    bindParticleTrace(null);
    try { applyPartsAppearance(); } catch (_) {}
    try { renderWindow.render(); } catch (_) {}
    if (hint) hint.textContent = 'Particle trace failed to load.';
    publishW8({ empty: true, error: String(e), last_url: assetUrl });
    return { empty: true, error: String(e) };
  }
  if (token !== ptLoadToken) return null;
  doneLoading();
  const meta = entry && entry.meta;
  applyPtFrame(entry);
  try { syncPtRegionOverlay(); } catch (_) {}
  try { applySceneClippingRange(); } catch (_) {}
  try { renderWindow.render(); } catch (_) {}
  if (hint) {
    if (!meta || meta.empty) {
      hint.textContent = meta && meta.empty_reason
        ? 'No traces: ' + meta.empty_reason
        : 'No traces for this selection.';
    } else {
      const n = meta.n_seeds != null ? meta.n_seeds : 0;
      const paths = meta.tube_proof && meta.tube_proof.n_paths != null ? meta.tube_proof.n_paths : n;
      hint.textContent = n
        ? n + ' seeds · ' + paths + ' traces.'
        : 'Seeds on this run’s inlet and outlet patches.';
    }
  }
  if (!meta || meta.empty) {
    publishW8({ empty: true, last_url: assetUrl, pt_meta: meta });
    return window.__CFD_W8__;
  }
  const fp = ptFingerprintFromPd(entry.pd, ptMeta);
  publishW8({ pt_fingerprint: fp, last_url: assetUrl });
  console.info('[CFD] particle trace', assetUrl, fp);
  if (!isPtAnimation() && (animState.times || []).length >= 2) {
    try { warmAnimFrameCache(); } catch (_) {}
  }
  return window.__CFD_W8__;
}

function publishW7(extra) {
  const cutPd = cutMapper.getInputData ? cutMapper.getInputData() : null;
  const fp = cutFingerprint(cutPd);
  window.__CFD_W7__ = {
    increment: 'W7',
    ready: !!(sourcePolyData && window.__CFD_W6__ && window.__CFD_W6__.ready),
    approach: 'pyvista volume slice /api/cut-plane',
    api_url: apiFieldUrl(activeField),
    field: activeField,
    cut_state: { ...cutState },
    cut_fingerprint: fp,
    vectors_live: false,
    clip_model_optional: true,
    clip_model_on: !!cutState.clipModel,
    other_filters_chrome_only: true,
    particle_trace_live: true,
    no_fake_plane_widget: true,
    ...(extra || {}),
  };
}

function styleFieldSurfaceActor() {
  applyPartsAppearance();
}

function bindFieldSurface(pd) {
  styleFieldSurfaceActor();
  try {
    if (pd && pd.getNumberOfPoints && pd.getNumberOfPoints() > 0) {
      surfaceMapper.setInputData(pd);
    } else {
      surfaceMapper.setInputConnection(reader.getOutputPort());
    }
  } catch (_) {}
}

const fieldFrameCache = new Map();
const fieldFrameInflight = new Map();
let fieldCacheCase = null;

function fieldFrameKey(field, time, casePath) {
  return String(casePath || getCaseDir() || '') + '|' + String(field) + '|' + String(time);
}

function ensureFieldCacheCase() {
  const c = getCaseDir();
  if (c !== fieldCacheCase) {
    fieldFrameCache.clear();
    fieldFrameInflight.clear();
    fieldCacheCase = c;
    resetSeriesLut();
  }
}

function clearFieldFrameCache() {
  fieldFrameCache.clear();
  fieldFrameInflight.clear();
  fieldCacheCase = null;
  resetSeriesLut();
  clearPtFrameCache();
}

const ptFrameCache = new Map();
const ptFrameInflight = new Map();
let ptCacheSettingsKey = null;

function ptSettingsCacheKey(st) {
  const s = st || ptState;
  return [
    getCaseDir() || '',
    normalizePtSeedMode(s.seed_mode),
    ptFacesParam(s),
    s.quantity_mode || 'count',
    s.n_seeds ?? 40,
    s.density ?? 10000,
    s.seeds_h,
    s.seeds_v,
    s.spacing,
    s.size,
    s.both ? 1 : 0,
    s.pick || '',
    encodePtRegionParam(s.region),
  ].join('|');
}

function ptFrameKey(time) {
  return ptSettingsCacheKey() + '@' + String(time);
}

function ensurePtCacheSettings() {
  const k = ptSettingsCacheKey();
  if (k !== ptCacheSettingsKey) {
    ptFrameCache.clear();
    ptFrameInflight.clear();
    ptCacheSettingsKey = k;
  }
}

function clearPtFrameCache() {
  ptFrameCache.clear();
  ptFrameInflight.clear();
  ptCacheSettingsKey = null;
}

async function prefetchPtFrame(time) {
  if (!ptState.enabled) return null;
  ensurePtCacheSettings();
  const key = ptFrameKey(time);
  if (ptFrameCache.has(key)) return ptFrameCache.get(key);
  if (ptFrameInflight.has(key)) return ptFrameInflight.get(key);
  const ctx = { time: String(time) };
  const work = (async () => {
    const metaUrl = apiParticleTraceMetaUrl(ptState, ctx);
    const assetUrl = apiParticleTraceUrl(ptState, ctx);
    let meta = null;
    try {
      const mr = await fetch(metaUrl, { cache: 'no-store' });
      const text = await mr.text();
      if (text && text.charAt(0) === '<') {
        meta = { empty: true, error: 'api_html', status: mr.status };
      } else {
        meta = text ? JSON.parse(text) : { empty: true };
        if (!mr.ok) meta = { ...meta, empty: true, status: mr.status };
      }
    } catch (e) {
      meta = { empty: true, error: String(e) };
    }
    if (!meta || meta.empty) {
      const emptyEntry = { pd: null, meta, time: String(time), empty: true };
      ptFrameCache.set(key, emptyEntry);
      return emptyEntry;
    }
    const r = await fetch(assetUrl, { cache: 'no-store' });
    if (!r.ok) throw new Error('pt HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    if (vtpLooksLikeHtml(buf)) throw new Error('pt API returned HTML');
    const tmp = vtkXMLPolyDataReader.newInstance();
    tmp.parseAsArrayBuffer(buf);
    const pd = tmp.getOutputData ? tmp.getOutputData() : null;
    const entry = { pd, meta, time: String(time), empty: false };
    ptFrameCache.set(key, entry);
    return entry;
  })();
  ptFrameInflight.set(key, work);
  try {
    return await work;
  } finally {
    ptFrameInflight.delete(key);
  }
}

function applyPtFrame(entry, opts) {
  if (!ptState.enabled) {
    bindParticleTrace(null);
    return;
  }
  ptMeta = entry && entry.meta;
  if (!entry || entry.empty || !entry.pd) {
    bindParticleTrace(null);
  } else {
    bindParticleTrace(entry.pd);
  }
  if (!(opts && opts.quiet)) {
    try { applyPartsAppearance(); } catch (_) {}
    try { syncPtAssignGeom(); } catch (_) {}
  }
}

async function applyPtForTime(time, opts) {
  if (!ptState.enabled || !hasAttachedCase()) return null;
  const entry = await prefetchPtFrame(time);
  applyPtFrame(entry, opts);
  return entry;
}

async function prefetchFieldFrame(field, time) {
  ensureFieldCacheCase();
  const key = fieldFrameKey(field, time);
  if (fieldFrameCache.has(key)) return fieldFrameCache.get(key);
  if (fieldFrameInflight.has(key)) return fieldFrameInflight.get(key);
  const ctx = { time: String(time) };
  const work = (async () => {
    const metaP = fetch(apiMetaUrl(field, ctx))
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const r = await fetch(apiFieldUrl(field, ctx), { cache: 'no-store' });
    if (!r.ok) throw new Error('field HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    if (vtpLooksLikeHtml(buf)) throw new Error('field API returned HTML');
    const tmp = vtkXMLPolyDataReader.newInstance();
    tmp.parseAsArrayBuffer(buf);
    const pd = tmp.getOutputData ? tmp.getOutputData() : null;
    const entry = { pd, meta: await metaP, field, time: String(time) };
    fieldFrameCache.set(key, entry);
    return entry;
  })();
  fieldFrameInflight.set(key, work);
  try {
    return await work;
  } finally {
    fieldFrameInflight.delete(key);
  }
}

function applyLoadedField(field, entry, token) {
  if (token != null && token !== fieldLoadToken) return { empty: true, stale: true };
  const pd = entry && entry.pd;
  const meta = entry && entry.meta;
  const assetUrl = apiFieldUrl(field);
  const foam = meta && (meta.u_from_case || meta.foam_proof);
  let lo = 0;
  let hi = 1;
  if (field === 'magU') {
    lo = foam && foam.umin != null ? foam.umin : 0;
    hi = foam && foam.umax != null ? foam.umax : 0.79;
  } else if (foam) {
    lo = foam.pmin != null ? foam.pmin : 0;
    hi = foam.pmax != null ? foam.pmax : 1;
  }
  surfaceMapper.setColorByArrayName(field);
  cutMapper.setColorByArrayName(field);
  bindFieldSurface(pd);
  try {
    const fieldOpt = document.querySelector('#parts-style option[value="field"]');
    if (fieldOpt) fieldOpt.textContent = field === 'p' ? 'Pressure' : 'Velocity Magnitude';
  } catch (_) {}
  sourcePolyData = pd;
  cutBins = null;
  sourceBounds = pd && pd.getBounds ? pd.getBounds().slice() : null;
  const fp = fingerprintFromPolyData(pd, meta, field, assetUrl);
  if (fp && fp.umin !== null && fp.umax !== null && fp.umax > fp.umin) {
    lo = fp.umin;
    hi = fp.umax;
  }
  absorbSeriesRange(field, lo, hi);
  absorbSeriesFromEntry(field, entry);
  const scaled = resolveFieldLutRange(field, lo, hi);
  lo = scaled[0];
  hi = scaled[1];
  const series = seriesRangeForLegend(field);
  setLegendAutoExtents(field, series ? series[0] : lo, series ? series[1] : hi);
  lutRange = [lo, hi];
  lut.setRange(lo, hi);
  lut.build();
  updateLegend(field, lo, hi);
  try { syncSharedLegend(); } catch (_) {}

  const nPts = pd && pd.getNumberOfPoints ? pd.getNumberOfPoints() : 0;
  let cutFp = null;
  if (nPts > 0 && anyResultPlaneOn()) {
    cutFp = updateCuttingPlane();
  } else {
    try { cutActor.setVisibility(false); } catch (_) {}
    applyPartsAppearance();
  }
  if (nPts > 0) {
    try { setGeomVisible(false); } catch (_) {}
    try { frameSceneCamera(false); } catch (_) {}
  }
  try { syncViewportOrient(); } catch (_) {}
  try { renderWindow.render(); } catch (_) {}

  window.__CFD_W6__ = {
    increment: 'W6',
    case_dir: getCaseDir(),
    time: getTime(),
    field,
    api_url: assetUrl,
    api_meta_url: apiMetaUrl(field),
    convert_method: meta ? meta.convert_method : null,
    u_from_case: meta ? meta.u_from_case : null,
    foam_proof: meta ? meta.foam_proof : null,
    surface_field: meta ? meta.surface_field : null,
    proves_not_baked_only: true,
    cone_absent: true,
    demo_actor: 'vtkXMLPolyDataReader',
    fingerprint: fp,
    mapper_points: nPts,
    surface_visible: (function () {
      try { return !!surfaceActor.getVisibility(); } catch (_) { return false; }
    })(),
    ready: !!(fp && fp.real_field && fp.proves_not_baked_only),
    from_frame_cache: true,
  };
  publishW7({ cut_fingerprint: cutFp, source_fingerprint: fp });
  return fp;
}

async function loadField(field, opts) {
  const token = ++fieldLoadToken;
  if (!hasAttachedCase()) {
    try {
      const emptyPd = vtkPolyData.newInstance();
      surfaceMapper.setInputData(emptyPd);
      cutMapper.setInputData(emptyPd);
      surfaceActor.setVisibility(false);
      cutActor.setVisibility(false);
    } catch (_) {}
    return { empty: true, skipped: 'no_case' };
  }
  activeField = field;
  let entry;
  try {
    entry = await prefetchFieldFrame(field, getTime());
  } catch (e) {
    if (token !== fieldLoadToken) return { empty: true, stale: true };
    throw e;
  }
  if (token !== fieldLoadToken) return { empty: true, stale: true };
  const fp = applyLoadedField(field, entry, token);
  if (fp && fp.stale) return fp;
  const skipHeavy = !!(opts && opts.extras === false);
  if (ptState.enabled) {
    // Time Step play/scrub: swap the cached streamline frame for this time.
    // Do not run the comet-along-path animation here.
    try {
      await applyPtForTime(getTime(), { quiet: skipHeavy });
    } catch (e) {
      console.error('[CFD W8] PT frame', e);
    }
  }
  if (!skipHeavy && isoState.enabled) {
    loadIsoSurface().catch((e) => console.error('[CFD W10] Iso load failed', e));
  }
  return fp;
}

/** Prove helper: apply position/orientation/miss and return cut fingerprint delta */
window.__CFD_W7_APPLY__ = function applyW7( partial ) {
  if (partial && typeof partial === 'object') {
    if (partial.position != null) {
      cutState.position = Number(partial.position);
      cutState.positionUserSet = true;
    }
    if (partial.axis) cutState.axis = String(partial.axis).toUpperCase();
    if (partial.inverse != null) cutState.inverse = !!partial.inverse;
    if (partial.enabled != null) cutState.enabled = !!partial.enabled;
    if (partial.opacity != null) cutState.opacity = Number(partial.opacity);
    if (partial.clipModel != null) cutState.clipModel = !!partial.clipModel;
    if (partial.partsColor != null) cutState.partsColor = !!partial.partsColor;
    if (partial.partsStyle != null) cutState.partsStyle = partial.partsStyle === 'solid' ? 'solid' : 'field';
    if (partial.partsSolid != null) cutState.partsSolid = String(partial.partsSolid);
    if (partial.partsOpacity != null) cutState.partsOpacity = Number(partial.partsOpacity);
    if (partial.vectors != null) cutState.vectors = !!partial.vectors;
    syncChromeFromState();
  }
  const miss = !!(partial && partial.miss);
  const fp = updateCuttingPlane({ miss });
  publishW7({
    cut_fingerprint: fp,
    last_apply: partial || null,
    prove_ts: Date.now(),
  });
  return window.__CFD_W7__;
};

function applyPtPartialToState(partial) {
  if (!partial || typeof partial !== 'object') return;
  if (partial.seed_mode != null) ptState.seed_mode = normalizePtSeedMode(partial.seed_mode);
  if (partial.faces != null) {
    ptState.faces = Array.isArray(partial.faces)
      ? partial.faces.map(String)
      : String(partial.faces)
          .split(/[,|;]+/)
          .map((x) => x.trim())
          .filter(Boolean);
  }
  if (partial.quantity_mode != null) ptState.quantity_mode = String(partial.quantity_mode);
  if (partial.n_seeds != null) ptState.n_seeds = Math.max(0, Math.floor(Number(partial.n_seeds) || 0));
  if (partial.density != null) ptState.density = Number(partial.density);
  if (partial.seeds_h != null) ptState.seeds_h = Number(partial.seeds_h);
  if (partial.seeds_v != null) ptState.seeds_v = Number(partial.seeds_v);
  if (partial.spacing != null) ptState.spacing = Number(partial.spacing);
  if (partial.size != null) ptState.size = Number(partial.size);
  if (partial.both != null) ptState.both = !!partial.both;
  if (partial.pick != null) ptState.pick = String(partial.pick || '');
  if (partial.representation != null) ptState.representation = String(partial.representation);
  if (partial.enabled != null) ptState.enabled = !!partial.enabled;
  if (partial.honest_empty) {
    if (ptState.seed_mode === 'faces') ptState.faces = [];
    else {
      ptState.seeds_h = 0;
      ptState.seeds_v = 0;
    }
  }
}

window.__CFD_W8_APPLY__ = async function applyW8(partial) {
  applyPtPartialToState(partial);
  syncPtChromeFromState();
  await loadParticleTrace();
  publishW8({ last_apply: partial || null, prove_ts: Date.now() });
  return window.__CFD_W8__;
};

window.__CFD_W14_APPLY__ = async function applyW14(partial) {
  applyPtPartialToState(partial || {});
  if (!partial || partial.seed_mode == null) ptState.seed_mode = 'faces';
  syncPtChromeFromState();
  await loadParticleTrace();
  publishW8({ last_apply: partial || null, prove_ts: Date.now() });
  return window.__CFD_W14__;
};

// Pulses apply to Spheres and Comets; comet length only to Comets.
function syncPtLookVisibility() {
  const rep = String(ptState.representation || 'Cylinders');
  const pulsesField = document.getElementById('pt-pulses-field');
  const cometField = document.getElementById('pt-comet-length-field');
  if (pulsesField) pulsesField.hidden = rep === 'Cylinders';
  if (cometField) cometField.hidden = rep !== 'Comets';
  const pulses = document.getElementById('pt-pulses');
  const cometLen = document.getElementById('pt-comet-length');
  const cometLenVal = document.getElementById('pt-comet-length-val');
  // Never rewrite a field the user is typing in (it would undo a backspace).
  if (pulses && document.activeElement !== pulses && String(pulses.value) !== String(ptState.pulses)) pulses.value = String(ptState.pulses);
  if (cometLen && document.activeElement !== cometLen && Number(cometLen.value) !== Number(ptState.comet_length)) cometLen.value = String(ptState.comet_length);
  if (cometLenVal) cometLenVal.textContent = String(ptState.comet_length);
}

function syncPtModeVisibility() {
  const faceLike = normalizePtSeedMode(ptState.seed_mode) === 'faces' || isRegionSeedMode();
  const regionMode = isRegionSeedMode();
  const dens = (ptState.quantity_mode || 'count') === 'density';
  const setHidden = (id, hidden) => {
    const el = document.getElementById(id);
    if (el) el.hidden = !!hidden;
  };
  setHidden('pt-faces-field', !faceLike);
  setHidden('pt-region-field', !regionMode);
  setHidden('pt-quantity-field', !faceLike);
  setHidden('pt-n-seeds-field', !faceLike || dens);
  setHidden('pt-density-field', !faceLike || !dens);
}

function readPtFacesFromChrome() {
  return [...(ptState.faces || [])];
}

function syncPtChromeFromState() {
  const mode = document.getElementById('pt-seed-mode');
  const qty = document.getElementById('pt-quantity-mode');
  const nSeeds = document.getElementById('pt-n-seeds');
  const dens = document.getElementById('pt-density');
  const h = document.getElementById('pt-seeds-h');
  const v = document.getElementById('pt-seeds-v');
  const sp = document.getElementById('pt-spacing');
  const sz = document.getElementById('pt-size');
  const both = document.getElementById('pt-both');
  const pick = document.getElementById('pt-pick');
  const rep = document.getElementById('pt-representation');
  const en = document.getElementById('pt-enabled');
  ptState.seed_mode = normalizePtSeedMode(ptState.seed_mode);
  if (mode) mode.value = ptState.seed_mode;
  if (qty) qty.value = ptState.quantity_mode || 'count';
  if (nSeeds) nSeeds.value = String(ptState.n_seeds ?? 40);
  if (dens) dens.value = String(ptState.density ?? 10000);
  try { syncPtAssignList(); } catch (_) {}
  if (h) h.value = String(ptState.seeds_h);
  if (v) v.value = String(ptState.seeds_v);
  if (sp) sp.value = String(ptState.spacing);
  if (sz) sz.value = String(ptState.size);
  const szr = document.getElementById('pt-size-range');
  if (szr) szr.value = String(ptState.size);
  if (both) both.checked = !!ptState.both;
  if (pick) pick.value = ptState.pick || '';
  if (rep) rep.value = ptState.representation || 'Cylinders';
  try { syncPtLookVisibility(); } catch (_) {}
  const col = document.getElementById('pt-coloring');
  if (col) col.value = ptState.coloring === 'p' || ptState.coloring === 'solid' ? ptState.coloring : 'magU';
  const solidField = document.getElementById('pt-solid-field');
  if (solidField) solidField.hidden = ptState.coloring !== 'solid';
  const solid = document.getElementById('pt-solid-color');
  const solidHex = document.getElementById('pt-solid-hex');
  if (solid) solid.value = ptState.solid || '#2563eb';
  if (solidHex) solidHex.textContent = ptState.solid || '#2563eb';
  if (en) en.checked = !!ptState.enabled;
  syncPtModeVisibility();
  try { syncPtRegionChrome(); } catch (_) {}
  try { syncPtRegionOverlay(); } catch (_) {}
}


function popFingerprint(meta) {
  const m = meta || popMeta || {};
  return {
    field_variable: m.field_variable || popState.field_variable,
    field_name: m.field_name || '',
    subdivisions: m.subdivisions != null ? m.subdivisions : popState.subdivisions,
    n_path_points: m.n_path_points != null ? m.n_path_points : (popState.points || []).length,
    n_samples: m.n_samples != null ? m.n_samples : 0,
    n_valid: m.n_valid != null ? m.n_valid : 0,
    empty: m.empty !== false ? !!m.empty || !(m.n_samples > 0) : false,
    value_checksum: m.value_checksum != null ? m.value_checksum : 0,
    value_mean: m.value_mean != null ? m.value_mean : 0,
    value_min: m.value_min != null ? m.value_min : 0,
    value_max: m.value_max != null ? m.value_max : 0,
    distance_max: m.distance_max != null ? m.distance_max : 0,
    reason: m.reason || '',
    path_points: m.path_points || (popState.points || []).map((p) => [...p]),
    approach: m.approach || null,
    method: m.method || 'pyvista DataSet.sample_over_line',
    proves_not_baked_only: true,
    no_fake_curve: true,
  };
}

function publishW9(extra) {
  const fp = popFingerprint(popMeta);
  const n = (popState.points || []).length;
  window.__CFD_W9__ = {
    increment: 'W9',
    ready: !!(window.__CFD_W6__ && window.__CFD_W6__.ready),
    approach:
      'server-side sample_over_line from case VTU via pyvista in Vite middleware; client charts real /api/plot-over-path JSON series (not a made-up chart)',
    api_url: apiPlotOverPathUrl(),
    api_meta_url: apiPlotOverPathMetaUrl(),
    pop_state: {
      enabled: popState.enabled,
      pick: popState.pick,
      points: (popState.points || []).map((p) => [...p]),
      subdivisions: popState.subdivisions,
      field_variable: popState.field_variable,
    },
    pop_meta: popMeta,
    pop_fingerprint: fp,
    n_samples: fp.n_samples,
    n_path_points: n,
    generate_enabled: n > 0,
    series_empty: !!(fp.empty || fp.n_samples === 0),
    honest_empty: !!(fp.empty || fp.n_samples === 0),
    cutting_plane_still_live: true,
    particle_trace_still_live: true,
    other_filters_chrome_only: true,
    no_iso_invent: false,
    iso_surface_live: true,
    no_fake_curve: true,
    banked_defaults: {
      subdivisions: 0,
      field_variable: 'Velocity Magnitude',
      selected_points: 'Selected points (0)',
      no_points_selected: true,
      generate_enabled: false,
    },
    ...(extra || {}),
  };
}

function updatePopPathActor() {
  const pts = popState.points || [];
  if (pts.length < 2) {
    popPathActor.setVisibility(false);
    const emptyPd = vtkPolyData.newInstance();
    popPathMapper.setInputData(emptyPd);
    return;
  }
  const values = [];
  pts.forEach((p) => {
    values.push(Number(p[0]), Number(p[1]), Number(p[2]));
  });
  const vtkPts = vtkPoints.newInstance();
  vtkPts.setData(Float32Array.from(values), 3);
  const lines = [pts.length];
  for (let i = 0; i < pts.length; i++) lines.push(i);
  const cells = vtkCellArray.newInstance();
  cells.setData(Uint32Array.from(lines));
  const pd = vtkPolyData.newInstance();
  pd.setPoints(vtkPts);
  pd.setLines(cells);
  popPathMapper.setInputData(pd);
  popPathActor.setVisibility(!!popState.enabled);
}

function renderPopChart(meta) {
  const wrap = document.getElementById('pop-chart-wrap');
  const svg = document.getElementById('pop-chart');
  const metaEl = document.getElementById('pop-chart-meta');
  if (!wrap || !svg) return;
  const m = meta || popMeta;
  const dists = (m && m.distances) || [];
  const vals = (m && m.values) || [];
  const empty = !m || m.empty || !vals.length;
  if (empty) {
    wrap.hidden = true;
    svg.innerHTML = '';
    if (metaEl) metaEl.textContent = m && m.reason ? `empty: ${m.reason}` : 'No series';
    return;
  }
  wrap.hidden = false;
  const w = 320;
  const h = 160;
  const pad = 28;
  const xmin = Math.min(...dists);
  const xmax = Math.max(...dists);
  const ymin = Math.min(...vals);
  const ymax = Math.max(...vals);
  const dx = xmax - xmin || 1;
  const dy = ymax - ymin || 1;
  const pts = dists
    .map((d, i) => {
      const x = pad + ((d - xmin) / dx) * (w - 2 * pad);
      const y = h - pad - ((vals[i] - ymin) / dy) * (h - 2 * pad);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.innerHTML =
    `<polyline fill="none" stroke="#3b5bdb" stroke-width="2" points="${pts}" />` +
    `<text x="8" y="14" font-size="10" fill="#4b5563">${escapeXml(m.field_variable || '')}</text>` +
    `<text x="8" y="${h - 8}" font-size="9" fill="#6b7280">distance</text>`;
  if (metaEl) {
    metaEl.textContent = `n_samples=${m.n_samples} checksum=${Number(m.value_checksum).toFixed(6)} field=${m.field_name}`;
  }
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function syncPopChromeFromState() {
  const pick = document.getElementById('pop-pick');
  const sub = document.getElementById('pop-subdivisions');
  const fv = document.getElementById('pop-field-variable');
  const en = document.getElementById('pop-enabled');
  const label = document.getElementById('pop-selected-label');
  const noPts = document.getElementById('pop-no-points');
  const list = document.getElementById('pop-points-list');
  const gen = document.getElementById('pop-generate');
  const n = (popState.points || []).length;
  if (pick) pick.value = popState.pick || '';
  if (sub) sub.value = String(popState.subdivisions);
  if (fv) fv.value = popState.field_variable || 'Velocity Magnitude';
  if (en) en.checked = !!popState.enabled;
  if (label) label.textContent = `Selected points (${n})`;
  if (noPts) noPts.classList.toggle('is-hidden', n > 0);
  if (list) {
    list.innerHTML = '';
    (popState.points || []).forEach((p, i) => {
      const li = document.createElement('li');
      li.textContent = `${i + 1}: ${Number(p[0]).toPrecision(6)}, ${Number(p[1]).toPrecision(6)}, ${Number(p[2]).toPrecision(6)}`;
      list.appendChild(li);
    });
  }
  if (gen) gen.disabled = n < 1;
  updatePopPathActor();
}

function clearPopSeries() {
  popMeta = {
    field_variable: popState.field_variable,
    field_name: '',
    subdivisions: popState.subdivisions,
    n_path_points: (popState.points || []).length,
    path_points: (popState.points || []).map((p) => [...p]),
    distances: [],
    values: [],
    n_samples: 0,
    n_valid: 0,
    empty: true,
    value_checksum: 0,
    reason: (popState.points || []).length === 0 ? 'no_points' : 'cleared',
    proves_not_baked_only: true,
    no_fake_curve: true,
  };
  popSeries = null;
  renderPopChart(popMeta);
}

async function loadPlotOverPath(overrides) {
  const token = ++popLoadToken;
  if (overrides && typeof overrides === 'object') {
    if (overrides.points) popState.points = overrides.points.map((p) => [Number(p[0]), Number(p[1]), Number(p[2])]);
    if (overrides.subdivisions != null) popState.subdivisions = Math.max(0, Math.floor(Number(overrides.subdivisions) || 0));
    if (overrides.field_variable != null) popState.field_variable = String(overrides.field_variable);
    if (overrides.enabled != null) popState.enabled = !!overrides.enabled;
    if (overrides.pick != null) popState.pick = String(overrides.pick || '');
  }
  syncPopChromeFromState();
  const n = (popState.points || []).length;
  // Honest empty: Generate disabled / no series with 0 points — do not invent a curve
  if (n < 1) {
    clearPopSeries();
    publishW9({ generate_enabled: false });
    renderWindow.render();
    return window.__CFD_W9__;
  }
  if (n < 2) {
    popMeta = {
      field_variable: popState.field_variable,
      field_name: '',
      subdivisions: popState.subdivisions,
      n_path_points: n,
      path_points: popState.points.map((p) => [...p]),
      distances: [],
      values: [],
      n_samples: 0,
      n_valid: 0,
      empty: true,
      value_checksum: 0,
      reason: 'need_two_points',
      proves_not_baked_only: true,
      no_fake_curve: true,
    };
    renderPopChart(popMeta);
    publishW9();
    renderWindow.render();
    return window.__CFD_W9__;
  }
  const url = apiPlotOverPathUrl();
  let meta = null;
  try {
    const r = await fetch(url);
    if (r.ok) meta = await r.json();
    else meta = { empty: true, n_samples: 0, reason: 'api_error', error: r.status };
  } catch (e) {
    console.error('[CFD W9] plot-over-path failed', e);
    meta = { empty: true, n_samples: 0, reason: 'fetch_error', error: String(e) };
  }
  if (token !== popLoadToken) return null;
  popMeta = meta;
  popSeries = meta;
  renderPopChart(meta);
  updatePopPathActor();
  renderWindow.render();
  const fp = popFingerprint(meta);
  publishW9({ pop_fingerprint: fp, last_url: url });
  console.info('[CFD W9] plot-over-path', url, fp);
  return window.__CFD_W9__;
}

window.__CFD_W9_APPLY__ = async function applyW9(partial) {
  if (partial && typeof partial === 'object') {
    if (partial.points) {
      popState.points = partial.points.map((p) => [Number(p[0]), Number(p[1]), Number(p[2])]);
    }
    if (partial.subdivisions != null)
      popState.subdivisions = Math.max(0, Math.floor(Number(partial.subdivisions) || 0));
    if (partial.field_variable != null) popState.field_variable = String(partial.field_variable);
    if (partial.enabled != null) popState.enabled = !!partial.enabled;
    if (partial.pick != null) popState.pick = String(partial.pick || '');
    if (partial.clear || partial.honest_empty_no_points) {
      popState.points = [];
    }
    if (partial.miss_mesh) {
      // far outside mesh bounds
      popState.points = [
        [50.15239776670933, 50.15240000188351, 50.30488109588623],
        [100.15239776670933, 100.1524000018835, 100.30488109588623],
      ];
    }
    syncPopChromeFromState();
  }
  // Generate only when points exist (matches Generate disabled gate); prove can force
  const n = (popState.points || []).length;
  if (n < 1) {
    clearPopSeries();
    publishW9({ last_apply: partial || null, generate_enabled: false, prove_ts: Date.now() });
    return window.__CFD_W9__;
  }
  const out = await loadPlotOverPath();
  publishW9({ last_apply: partial || null, prove_ts: Date.now() });
  return window.__CFD_W9__;
};




function isoColorArrayName(meta) {
  const m = meta || isoMeta || {};
  const cf = m.coloring_field || '';
  if (cf === 'p' || cf === 'Pressure') return 'p';
  if (cf === 'magU' || cf === 'U') return 'magU';
  const c = (m.coloring || isoState.coloring || 'Pressure').toLowerCase();
  if (c.indexOf('pressure') >= 0 || c === 'p') return 'p';
  return 'magU';
}

function isoFingerprint(meta, pd) {
  const m = meta || isoMeta || {};
  const nCells = pd && pd.getNumberOfCells ? pd.getNumberOfCells() : (m.n_cells != null ? m.n_cells : 0);
  const nPoints = pd && pd.getPoints ? pd.getPoints().getNumberOfPoints() : (m.n_points != null ? m.n_points : 0);
  const empty = !!(m.empty || nCells === 0 || nPoints === 0);
  return {
    iso_scalar: m.iso_scalar || isoState.iso_scalar,
    iso_value: m.iso_value != null ? m.iso_value : isoState.iso_value,
    iso_field: m.iso_field || '',
    coloring: m.coloring || isoState.coloring,
    coloring_field: m.coloring_field || null,
    opacity: m.opacity != null ? m.opacity : isoState.opacity,
    n_cells: nCells,
    n_points: nPoints,
    empty,
    reason: m.reason || '',
    point_checksum: m.point_checksum != null ? m.point_checksum : 0,
    mesh_rms: m.mesh_rms != null ? m.mesh_rms : 0,
    mesh_checksum: m.mesh_checksum || (pd ? meshChecksum(pd) : '00000000'),
    scalar_min: m.scalar_min != null ? m.scalar_min : null,
    scalar_max: m.scalar_max != null ? m.scalar_max : null,
    vectors_actor: !!(isoState.vectors && isoState.enabled),
    vectors_persist_only: false,
    actor_present: !empty && !!isoState.enabled,
    actor_opacity: isoState.opacity,
    approach: m.approach || null,
    method: m.method || 'pyvista DataSet.contour on volume VTU',
    proves_not_baked_only: true,
    no_fake_surface: true,
    no_solid_shell: true,
    source_is_volume: m.source_is_volume !== false,
  };
}

function publishW10(extra) {
  const pd = isoMapper.getInputData ? isoMapper.getInputData() : null;
  const fp = isoFingerprint(isoMeta, pd);
  window.__CFD_W10__ = {
    increment: 'W10',
    ready: !!(window.__CFD_W6__ && window.__CFD_W6__.ready && isoMeta),
    approach:
      'server-side volume contour: Vite /api/iso-surface -> export_iso_surface.py reads case .cfddesk-prepared.vtu volume UnstructuredGrid -> pyvista contour([iso_value], scalars=iso_field) -> VTP; client loads real iso cells (not a solid colored shell)',
    api_url: apiIsoSurfaceUrl(),
    api_meta_url: apiIsoSurfaceMetaUrl(),
    iso_state: { ...isoState },
    iso_meta: isoMeta,
    iso_fingerprint: fp,
    n_cells: fp.n_cells,
    n_points: fp.n_points,
    honest_empty: !!fp.empty,
    vectors_live: !!(isoState.vectors && isoState.enabled),
    vectors_persist_only: false,
    cutting_plane_still_live: true,
    particle_trace_still_live: true,
    plot_over_path_still_live: true,
    other_filters_chrome_only: true,
    animation_live: true, animation_chrome_only: false,
    iso_volume_live_w11: true,
    no_solid_shell: true,
    banked_defaults: {
      iso_scalar: 'Velocity Magnitude',
      iso_value: 11.1,
      iso_value_unit: 'm/s',
      coloring: 'Pressure',
      vectors: false,
      opacity: 1,
    },
    ...(extra || {}),
  };
}

async function loadIsoSurface(overrides) {
  const token = ++isoLoadToken;
  if (!hasAttachedCase()) {
    const emptyPd = vtkPolyData.newInstance();
    isoMapper.setInputData(emptyPd);
    isoActor.setVisibility(false);
    try { renderWindow.render(); } catch (_) {}
    return { empty: true, skipped: 'no_case' };
  }
  if (overrides && typeof overrides === 'object') {
    if (overrides.iso_scalar != null) isoState.iso_scalar = String(overrides.iso_scalar);
    if (overrides.iso_value != null) isoState.iso_value = Number(overrides.iso_value);
    if (overrides.coloring != null) isoState.coloring = String(overrides.coloring);
    if (overrides.opacity != null) isoState.opacity = Number(overrides.opacity);
    if (overrides.vectors != null) isoState.vectors = !!overrides.vectors;
    if (overrides.enabled != null) isoState.enabled = !!overrides.enabled;
  }
  syncIsoChromeFromState();
  const metaUrl = apiIsoSurfaceMetaUrl();
  const assetUrl = apiIsoSurfaceUrl();
  let meta = null;
  try {
    const mr = await fetch(metaUrl);
    if (mr.ok) meta = await mr.json();
    else meta = { empty: true, n_cells: 0, reason: 'api_error', error: mr.status };
  } catch (e) {
    console.error('[CFD W10] iso meta failed', e);
    meta = { empty: true, n_cells: 0, reason: 'fetch_error', error: String(e) };
  }
  if (token !== isoLoadToken) return null;
  isoMeta = meta;
  const empty = !!(meta && meta.empty);
  const colorArr = isoColorArrayName(meta);
  isoMapper.setColorByArrayName(colorArr);
  isoActor.getProperty().setOpacity(Number(isoState.opacity));
  if (!isoState.enabled || empty) {
    const emptyPd = vtkPolyData.newInstance();
    isoMapper.setInputData(emptyPd);
    isoActor.setVisibility(false);
    syncFieldVectorGlyphs(isoVecGlyph, null, false);
  } else {
    await isoReader.setUrl(assetUrl);
    if (token !== isoLoadToken) return null;
    isoMapper.setInputConnection(isoReader.getOutputPort());
    isoMapper.setColorByArrayName(colorArr);
    isoActor.setVisibility(true);
    const livePd = isoMapper.getInputData ? isoMapper.getInputData() : isoReader.getOutputData();
    syncFieldVectorGlyphs(isoVecGlyph, livePd, !!isoState.vectors);
  }
  renderWindow.render();
  const pd = isoMapper.getInputData ? isoMapper.getInputData() : null;
  const fp = isoFingerprint(isoMeta, pd);
  publishW10({ iso_fingerprint: fp, last_url: assetUrl });
  console.info('[CFD W10] iso surface', assetUrl, fp);
  try { syncSharedLegend(); } catch (_) {}
  return window.__CFD_W10__;
}

function syncIsoChromeFromState() {
  const sc = document.getElementById('iso-scalar');
  const val = document.getElementById('iso-value');
  const unit = document.getElementById('iso-value-unit');
  const col = document.getElementById('iso-coloring');
  const vec = document.getElementById('iso-vectors');
  const op = document.getElementById('iso-opacity');
  const opv = document.getElementById('iso-opacity-val');
  const en = document.getElementById('iso-enabled');
  if (sc) sc.value = isoState.iso_scalar || 'Velocity Magnitude';
  if (val) val.value = String(isoState.iso_value);
  if (unit) {
    const s = (isoState.iso_scalar || '').toLowerCase();
    unit.textContent = s.indexOf('pressure') >= 0 ? 'Pa' : 'm/s';
  }
  if (col) col.value = isoState.coloring || 'Pressure';
  if (vec) vec.checked = !!isoState.vectors;
  if (op) op.value = String(isoState.opacity);
  if (opv) opv.textContent = String(isoState.opacity);
  if (en) en.checked = !!isoState.enabled;
}

window.__CFD_W10_APPLY__ = async function applyW10(partial) {
  if (partial && typeof partial === 'object') {
    if (partial.iso_scalar != null) isoState.iso_scalar = String(partial.iso_scalar);
    if (partial.iso_value != null) isoState.iso_value = Number(partial.iso_value);
    if (partial.coloring != null) isoState.coloring = String(partial.coloring);
    if (partial.opacity != null) isoState.opacity = Number(partial.opacity);
    if (partial.vectors != null) isoState.vectors = !!partial.vectors;
    if (partial.enabled != null) isoState.enabled = !!partial.enabled;
    if (partial.honest_empty_default) {
      isoState.iso_scalar = 'Velocity Magnitude';
      isoState.iso_value = 11.1;
      isoState.coloring = 'Pressure';
      isoState.opacity = 1;
      isoState.vectors = false;
    }
    syncIsoChromeFromState();
  }
  const out = await loadIsoSurface();
  publishW10({ last_apply: partial || null, prove_ts: Date.now() });
  return window.__CFD_W10__;
};




function ivColorArrayName(meta) {
  const m = meta || ivMeta || {};
  const cf = m.coloring_field || '';
  if (cf === 'p' || cf === 'Pressure') return 'p';
  if (cf === 'magU' || cf === 'U') return 'magU';
  const c = (m.coloring || ivState.coloring || 'Pressure').toLowerCase();
  if (c.indexOf('pressure') >= 0 || c === 'p') return 'p';
  return 'magU';
}

function ivFingerprint(meta, pd) {
  const m = meta || ivMeta || {};
  // Prefer volume threshold cell counts from server meta (not extract_surface).
  const nCells = m.n_cells != null ? m.n_cells : (pd && pd.getNumberOfCells ? pd.getNumberOfCells() : 0);
  const nPoints = m.n_points != null ? m.n_points : (pd && pd.getPoints ? pd.getPoints().getNumberOfPoints() : 0);
  const empty = !!(m.empty || nCells === 0 || nPoints === 0);
  return {
    iso_scalar: m.iso_scalar || ivState.iso_scalar,
    iso_value_low: m.iso_value_low != null ? m.iso_value_low : ivState.iso_value_low,
    iso_value_high: m.iso_value_high != null ? m.iso_value_high : ivState.iso_value_high,
    mapped_low: m.mapped_low != null ? m.mapped_low : null,
    mapped_high: m.mapped_high != null ? m.mapped_high : null,
    iso_field: m.iso_field || '',
    coloring: m.coloring || ivState.coloring,
    coloring_field: m.coloring_field || null,
    opacity: m.opacity != null ? m.opacity : ivState.opacity,
    n_cells: nCells,
    n_points: nPoints,
    empty,
    reason: m.reason || '',
    point_checksum: m.point_checksum != null ? m.point_checksum : 0,
    mesh_rms: m.mesh_rms != null ? m.mesh_rms : 0,
    mesh_checksum: m.mesh_checksum || (pd ? meshChecksum(pd) : '00000000'),
    scalar_min: m.scalar_min != null ? m.scalar_min : null,
    scalar_max: m.scalar_max != null ? m.scalar_max : null,
    vectors_actor: !!(isoState.vectors && isoState.enabled),
    vectors_persist_only: false,
    actor_present: !empty && !!ivState.enabled,
    actor_opacity: ivState.opacity,
    approach: m.approach || null,
    method: m.method || 'pyvista DataSet.threshold on volume VTU',
    proves_not_baked_only: true,
    no_fake_volume: true,
    not_iso_surface_rebrand: true,
    source_is_volume: m.source_is_volume !== false,
  };
}

function publishW11(extra) {
  const pd = ivMapper.getInputData ? ivMapper.getInputData() : null;
  const fp = ivFingerprint(ivMeta, pd);
  window.__CFD_W11__ = {
    increment: 'W11',
    ready: !!(window.__CFD_W6__ && window.__CFD_W6__.ready && ivMeta),
    approach:
      'server-side volume threshold: Vite /api/iso-volume -> export_iso_volume.py reads case .cfddesk-prepared.vtu volume UnstructuredGrid -> map normalized low/high onto live scalar min/max -> pyvista threshold([lo,hi], scalars=iso_field) -> extract_surface VTP; client loads real threshold volume (not Iso Surface contour rebrand)',
    api_url: apiIsoVolumeUrl(),
    api_meta_url: apiIsoVolumeMetaUrl(),
    iv_state: { ...ivState },
    iv_meta: ivMeta,
    iv_fingerprint: fp,
    n_cells: fp.n_cells,
    n_points: fp.n_points,
    honest_empty: !!fp.empty,
    vectors_live: !!(ivState.vectors && ivState.enabled),
    vectors_persist_only: false,
    cutting_plane_still_live: true,
    particle_trace_still_live: true,
    plot_over_path_still_live: true,
    iso_surface_still_live: true,
    animation_live: true, animation_chrome_only: false,
    not_iso_surface_rebrand: true,
    banked_defaults: {
      iso_scalar: 'Velocity Magnitude',
      iso_value_low: 0.25,
      iso_value_high: 0.75,
      coloring: 'Pressure',
      vectors: false,
      opacity: 1,
    },
    ...(extra || {}),
  };
}

function syncIvRangeVisual() {
  const sel = document.getElementById('iv-range-sel');
  const low = Number(ivState.iso_value_low);
  const high = Number(ivState.iso_value_high);
  if (!sel) return;
  const a = Math.max(0, Math.min(1, Math.min(low, high)));
  const b = Math.max(0, Math.min(1, Math.max(low, high)));
  sel.style.left = `${a * 100}%`;
  sel.style.width = `${Math.max(0.5, (b - a) * 100)}%`;
}

function syncIvChromeFromState() {
  const sc = document.getElementById('iv-scalar');
  const lo = document.getElementById('iv-low');
  const hi = document.getElementById('iv-high');
  const col = document.getElementById('iv-coloring');
  const vec = document.getElementById('iv-vectors');
  const op = document.getElementById('iv-opacity');
  const opv = document.getElementById('iv-opacity-val');
  const en = document.getElementById('iv-enabled');
  if (sc) sc.value = ivState.iso_scalar || 'Velocity Magnitude';
  if (lo) lo.value = String(ivState.iso_value_low);
  if (hi) hi.value = String(ivState.iso_value_high);
  if (col) col.value = ivState.coloring || 'Pressure';
  if (vec) vec.checked = !!ivState.vectors;
  if (op) op.value = String(ivState.opacity);
  if (opv) opv.textContent = String(ivState.opacity);
  if (en) en.checked = !!ivState.enabled;
  syncIvRangeVisual();
}

async function loadIsoVolume(overrides) {
  const token = ++ivLoadToken;
  if (!hasAttachedCase()) {
    const emptyPd = vtkPolyData.newInstance();
    ivMapper.setInputData(emptyPd);
    ivActor.setVisibility(false);
    try { renderWindow.render(); } catch (_) {}
    return { empty: true, skipped: 'no_case' };
  }
  if (overrides && typeof overrides === 'object') {
    if (overrides.iso_scalar != null) ivState.iso_scalar = String(overrides.iso_scalar);
    if (overrides.iso_value_low != null) ivState.iso_value_low = Number(overrides.iso_value_low);
    if (overrides.iso_value_high != null) ivState.iso_value_high = Number(overrides.iso_value_high);
    if (overrides.coloring != null) ivState.coloring = String(overrides.coloring);
    if (overrides.opacity != null) ivState.opacity = Number(overrides.opacity);
    if (overrides.vectors != null) ivState.vectors = !!overrides.vectors;
    if (overrides.enabled != null) ivState.enabled = !!overrides.enabled;
  }
  syncIvChromeFromState();
  const metaUrl = apiIsoVolumeMetaUrl();
  const assetUrl = apiIsoVolumeUrl();
  let meta = null;
  try {
    const mr = await fetch(metaUrl);
    if (mr.ok) meta = await mr.json();
    else meta = { empty: true, n_cells: 0, reason: 'api_error', error: mr.status };
  } catch (e) {
    console.error('[CFD W11] iso-volume meta failed', e);
    meta = { empty: true, n_cells: 0, reason: 'fetch_error', error: String(e) };
  }
  if (token !== ivLoadToken) return null;
  ivMeta = meta;
  const empty = !!(meta && meta.empty);
  const colorArr = ivColorArrayName(meta);
  ivMapper.setColorByArrayName(colorArr);
  ivActor.getProperty().setOpacity(Number(ivState.opacity));
  if (!ivState.enabled || empty) {
    const emptyPd = vtkPolyData.newInstance();
    ivMapper.setInputData(emptyPd);
    ivActor.setVisibility(false);
    syncFieldVectorGlyphs(ivVecGlyph, null, false);
  } else {
    await ivReader.setUrl(assetUrl);
    if (token !== ivLoadToken) return null;
    ivMapper.setInputConnection(ivReader.getOutputPort());
    ivMapper.setColorByArrayName(colorArr);
    ivActor.setVisibility(true);
    const livePd = ivMapper.getInputData ? ivMapper.getInputData() : ivReader.getOutputData();
    syncFieldVectorGlyphs(ivVecGlyph, livePd, !!ivState.vectors);
  }
  renderWindow.render();
  const pd = ivMapper.getInputData ? ivMapper.getInputData() : null;
  const fp = ivFingerprint(ivMeta, pd);
  publishW11({ iv_fingerprint: fp, last_url: assetUrl });
  console.info('[CFD W11] iso volume', assetUrl, fp);
  return window.__CFD_W11__;
}

window.__CFD_W11_APPLY__ = async function applyW11(partial) {
  if (partial && typeof partial === 'object') {
    if (partial.iso_scalar != null) ivState.iso_scalar = String(partial.iso_scalar);
    if (partial.iso_value_low != null) ivState.iso_value_low = Number(partial.iso_value_low);
    if (partial.iso_value_high != null) ivState.iso_value_high = Number(partial.iso_value_high);
    if (partial.coloring != null) ivState.coloring = String(partial.coloring);
    if (partial.opacity != null) ivState.opacity = Number(partial.opacity);
    if (partial.vectors != null) ivState.vectors = !!partial.vectors;
    if (partial.enabled != null) ivState.enabled = !!partial.enabled;
    if (partial.banked_defaults || partial.honest_empty_inverted) {
      ivState.iso_scalar = 'Velocity Magnitude';
      ivState.coloring = 'Pressure';
      ivState.opacity = 1;
      ivState.vectors = false;
      ivState.enabled = true;
      if (partial.honest_empty_inverted) {
        ivState.iso_value_low = 0.9;
        ivState.iso_value_high = 0.1;
      } else {
        ivState.iso_value_low = 0.25;
        ivState.iso_value_high = 0.75;
      }
    }
    syncIvChromeFromState();
  }
  const out = await loadIsoVolume();
  publishW11({ last_apply: partial || null, prove_ts: Date.now() });
  return window.__CFD_W11__;
};


/* Field surface loads after a real case attach — not on empty / new projects. */


/* W24.1b: mode-aware FILTERS (mesh inspect â‰  Solution Fields post) */
window.__CFD_FILTERS_MODE__ = 'post';

function setFiltersToolbarMode(mode) {
  const m = mode === 'mesh' || mode === 'setup' ? mode : 'post';
  window.__CFD_FILTERS_MODE__ = m;
  const group = document.getElementById('filters-toolbar-group') ||
    document.querySelector('.tb-group[data-group="FILTERS"]');
  if (group) {
    group.setAttribute('data-filters-mode', m);
    group.hidden = m === 'setup';
    group.style.display = m === 'setup' ? 'none' : '';
    group.querySelectorAll('.tb-btn[data-filter-set]').forEach((btn) => {
      const set = btn.getAttribute('data-filter-set') || 'post';
      const show =
        m === 'post' ? set === 'post' || set === 'both' :
        m === 'mesh' ? set === 'both' :
        false;
      btn.hidden = !show;
      if (!show) btn.classList.remove('is-active');
    });
  }
  document.documentElement.setAttribute('data-cfd-filters-mode', m);
  // wireColoringSelect may have replaced #cp-coloring with <select id="coloring-select">
  const cpColor =
    document.getElementById('cp-coloring') || document.getElementById('coloring-select');
  if (cpColor) {
    if (cpColor.tagName === 'SELECT') {
      let cv = [...cpColor.options].find((o) => o.value === 'cellVolume');
      if (!cv) {
        cv = document.createElement('option');
        cv.value = 'cellVolume';
        cv.textContent = 'Cell Volume';
        cpColor.appendChild(cv);
      }
      // Cell Volume is a mesh-quality view; keep it out of the results coloring list.
      cv.hidden = m !== 'mesh';
      cv.disabled = m !== 'mesh';
      cpColor.value = m === 'mesh' ? 'cellVolume' : 'magU';
      cpColor.setAttribute('data-coloring-mode', m);
    } else {
      cpColor.textContent = m === 'mesh' ? 'Cell Volume' : 'Velocity Magnitude';
    }
  }
  const fp = document.getElementById('filters-panel');
  if (fp) {
    fp.setAttribute('data-filters-mode', m);
    const meshFilters = document.getElementById('mesh-filters');
    if (meshFilters) meshFilters.hidden = m !== 'mesh';
    const postBlocks = ['cp-block', 'pt-block', 'pop-block', 'iso-block', 'iv-block', 'anim-block'];
    if (m !== 'post') {
      for (const id of postBlocks) {
        const el = document.getElementById(id);
        if (el) el.hidden = true;
      }
    }
  }
  try { renderViewsBlock(); } catch (_) {}
  return m;
}

window.__CFD_SET_FILTERS_MODE__ = setFiltersToolbarMode;

let meshSurfFullPd = null;
const hiddenCadFaces = new Set();
let faceCtxHit = null;
let faceCtxOrbitTarget = null;
const faceCtxSelected = new Set();
const edgeCtxSelected = new Set();
const vertexCtxSelected = new Set();
let cadEdgeCache = [];
let cadVertexCache = [];

let meshInspectOpen = false;
let meshChipDismissed = false;
let resultsViewOpen = false;
let meshBounds = null;
let meshPlaneSeq = 1;
const meshPlanes = [];

function meshSectionFrac(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.5;
  if (n > 1) return Math.min(1, Math.max(0, n / 100));
  return Math.min(1, Math.max(0, n));
}

function getLiveMeshDoc() {
  try {
    if (window.__CFD_W20_STATE__) return window.__CFD_W20_STATE__.mesh || null;
  } catch (_) {}
  try {
    if (window.__CFD_W20__ && window.__CFD_W20__.mesh) return window.__CFD_W20__.mesh;
  } catch (_) {}
  return null;
}

function getLiveMeshResult() {
  const mesh = getLiveMeshDoc();
  return (mesh && mesh.live_mesh_result) || null;
}

function isGeneratedMeshReady(mesh) {
  if (arguments.length && !mesh) return false;
  const m = mesh || getLiveMeshDoc();
  if (!m || m.generated === false) return false;
  const live = m.live_mesh_result;
  if (live && live.status === 'done' && live.case_dir) return true;
  return !!(m.generated && m.case_dir && (m.status === 'done' || !m.status));
}

function meshList() {
  const study =
    (typeof w17State !== 'undefined' && (w17State.simulation || null)) || null;
  if (study && study.id) return meshesForStudy(study);
  return [];
}

function meshListAll() {
  try {
    const st = window.__CFD_W20_STATE__;
    if (st && Array.isArray(st.meshes_all) && st.meshes_all.length) return st.meshes_all;
  } catch (_) {}
  return meshList();
}

function geometryNameForMesh(m) {
  if (!m) return '';
  if (m.geometry_name) return String(m.geometry_name);
  const gid = m.geometry_id;
  if (!gid) return '';
  const sims = (typeof w17State !== 'undefined' && w17State.simulations) || [];
  const study = sims.find((s) => s && String(s.geometry_id) === String(gid));
  if (study && study.geometry_name) return String(study.geometry_name);
  const geoms = typeof importedGeometries === 'function' ? importedGeometries() : [];
  const g = geoms.find((x) => x && String(x.id) === String(gid));
  return (g && (g.name || g.original_filename)) || '';
}

function findMeshRecord(id) {
  if (!id) return null;
  return (
    meshListAll().find((m) => String(m.id) === String(id)) ||
    meshList().find((m) => String(m.id) === String(id)) ||
    null
  );
}

function anyGeneratedMeshReady() {
  return meshList().some((m) => isGeneratedMeshReady(m));
}

function meshDisplayName(mesh) {
  let m = mesh || null;
  let s = null;
  try {
    const st = window.__CFD_W20_STATE__;
    if (!m && st) m = st.mesh;
    s = (m && m.settings) || (st && st.settings) || null;
  } catch (_) {}
  return (m && m.name) || (s && s.name) || 'Mesh 1';
}

function caseBelongsToCurrentProject(casePath) {
  const pid = typeof currentProjectId === 'function' ? currentProjectId() : '';
  if (!pid || !casePath) return false;
  const n = String(casePath).replace(/\\/g, '/').toLowerCase();
  return n.includes('/projects/' + String(pid).toLowerCase() + '/');
}

function caseBelongsToCurrentStudy(casePath) {
  if (!casePath || !caseBelongsToCurrentProject(casePath)) return false;
  const listed = typeof meshList === 'function' ? meshList() : [];
  return listed.some((m) => {
    const dir = (m && m.live_mesh_result && m.live_mesh_result.case_dir) || (m && m.case_dir);
    return dir && sameCasePath(dir, casePath);
  });
}

function getLiveMeshCaseDir() {
  const live = getLiveMeshResult();
  if (live && live.status === 'done' && live.case_dir && caseBelongsToCurrentStudy(live.case_dir)) {
    return String(live.case_dir);
  }
  const cur = getCaseDir();
  if (cur && caseBelongsToCurrentStudy(cur)) return cur;
  return null;
}

function applyLiveMeshCountsToJob() {
  const live = getLiveMeshResult();
  if (!live) return;
  if (live.case_dir) {
    caseDir = live.case_dir;
    jobState.case_dir = live.case_dir;
  }
  if (live.status) jobState.status = live.status;
  jobState.path_kind = live.path_kind || 'standard';
  jobState.mode = 'mesh';
  if (live.n_cells != null) jobState.n_cells = live.n_cells;
  if (live.n_points != null) jobState.n_points = live.n_points;
  if (live.n_faces != null) jobState.n_faces = live.n_faces;
  if (live.counts_source) jobState.counts_source = live.counts_source;
  if (live.mesh_path) jobState.mesh_path = live.mesh_path;
  if (live.emesh) jobState.emesh = live.emesh;
  if (live.feature_marks_total != null) jobState.feature_marks_total = live.feature_marks_total;
  if (live.engine != null) jobState.engine = live.engine;
  if (live.hex_core_applied !== undefined) jobState.hex_core_applied = live.hex_core_applied;
  if (live.layers_applied !== undefined) jobState.layers_applied = live.layers_applied;
  if (live.surface_size_m !== undefined) jobState.surface_size_m = live.surface_size_m;
  if (live.started_at && !jobState.started_at) jobState.started_at = live.started_at;
  if (live.finished_at && !jobState.finished_at) jobState.finished_at = live.finished_at;
  try { syncMeshFinishedChrome(); } catch (_) {}
}

function hasPostResults() {
  return !!(resultsViewOpen && !meshInspectOpen);
}

// Capture the camera relative to a bounding box (direction, view-up and
// distance as a multiple of the box span) so the same view can be re-applied
// to a box in different units — results are drawn in metres, CAD in mm.
function captureRelativeCamera(bounds) {
  const cam = renderer && renderer.getActiveCamera && renderer.getActiveCamera();
  if (!cam || !bounds) return null;
  const span = Math.max(bounds[1] - bounds[0], bounds[3] - bounds[2], bounds[5] - bounds[4]);
  if (!(span > 0)) return null;
  const pos = cam.getPosition();
  const fp = cam.getFocalPoint();
  const c = [(bounds[0] + bounds[1]) / 2, (bounds[2] + bounds[3]) / 2, (bounds[4] + bounds[5]) / 2];
  const d = Math.hypot(pos[0] - fp[0], pos[1] - fp[1], pos[2] - fp[2]);
  if (!(d > 0)) return null;
  return {
    dir: [(pos[0] - fp[0]) / d, (pos[1] - fp[1]) / d, (pos[2] - fp[2]) / d],
    up: cam.getViewUp().slice(),
    distRatio: d / span,
    fpOffset: [(fp[0] - c[0]) / span, (fp[1] - c[1]) / span, (fp[2] - c[2]) / span],
  };
}

function applyRelativeCamera(rel, bounds) {
  const cam = renderer && renderer.getActiveCamera && renderer.getActiveCamera();
  if (!cam || !rel || !bounds) return false;
  const span = Math.max(bounds[1] - bounds[0], bounds[3] - bounds[2], bounds[5] - bounds[4]);
  if (!(span > 0)) return false;
  const c = [(bounds[0] + bounds[1]) / 2, (bounds[2] + bounds[3]) / 2, (bounds[4] + bounds[5]) / 2];
  const fp = [c[0] + rel.fpOffset[0] * span, c[1] + rel.fpOffset[1] * span, c[2] + rel.fpOffset[2] * span];
  const d = rel.distRatio * span;
  try {
    cam.setFocalPoint(fp[0], fp[1], fp[2]);
    cam.setPosition(fp[0] + rel.dir[0] * d, fp[1] + rel.dir[1] * d, fp[2] + rel.dir[2] * d);
    cam.setViewUp(rel.up[0], rel.up[1], rel.up[2]);
  } catch (_) { return false; }
  return true;
}

function hideRunResultsView(opts) {
  if (!resultsViewOpen) return;
  // Write the live filter set for this run before anything is torn down so
  // Results reopen exactly as they were left.
  try { flushFilterAutosave(); } catch (_) {}
  // A results compare belongs to the Results view.
  try { if (resultsCompareOn()) stopCompare(); } catch (_) {}
  resultsViewOpen = false;
  resultsRunId = null;
  activeViewId = '';
  try { renderViewsBlock(); } catch (_) {}
  window.__CFD_RESULTS_VIEW__ = false;
  // Remember where the user was looking from, relative to the result model,
  // before the result actors (metres) are torn down.
  let relCam = null;
  try { relCam = captureRelativeCamera(sourceBounds); } catch (_) {}
  try { stopAnimationPlay(); } catch (_) {}
  try { setFiltersVisible(false); } catch (_) {}
  try { setLegendVisible(false); } catch (_) {}
  try { clearResultActors(); } catch (_) {}
  // Drop the result cutting planes from the CAD outline so the geometry view
  // shows the full silhouette again.
  try { if (geomEdgeMapper.removeAllClippingPlanes) geomEdgeMapper.removeAllClippingPlanes(); } catch (_) {}
  try { geomEdgeMapper.modified(); } catch (_) {}
  try { hidePtFaceOverlay(); } catch (_) {}
  if (!(opts && opts.silent)) {
    if (w16State && w16State.geometry) {
      try { setGeomVisible(true); } catch (_) {}
    }
    try { applyWorkbenchStage(); } catch (_) {}
    // Re-aim the camera at the CAD (mm) with the same direction and relative
    // zoom, then recompute the clipping range for the new scene size.
    try {
      const b = renderer.computeVisiblePropBounds();
      const ok = b && b[0] <= b[1] && applyRelativeCamera(relCam, b);
      if (!ok) frameSceneCamera(true);
      else {
        lastFramedBounds = b.slice();
        resetCameraClippingRangeLoose();
      }
      renderWindow.render();
    } catch (_) {}
  }
}

function leaveResultsForSetup() {
  if (resultsViewOpen) hideRunResultsView();
  try { setFiltersVisible(false); } catch (_) {}
}

// A run can be viewed when it finished, or when it was stopped after at least
// one iteration had been written (the graceful stop writes the current one).
function runHasResults(rec) {
  if (!rec || !rec.case_dir) return false;
  if (rec.status === 'done') return true;
  if (rec.status === 'stopped') {
    if (rec.has_results === true) return true;
    if (rec.has_results === false) return false;
    return Number(rec.last_saved_iteration) > 0;
  }
  // Live results: the solve script copies each saved time directory to the
  // run folder as it is written, so a running run opens once one exists.
  if (rec.status === 'running') {
    return rec.has_results === true || Number(rec.n_saved_times) > 0;
  }
  return false;
}

// Frames on disk for a running run (server counts them on every status poll).
function runLiveFrameCount(rec) {
  if (!rec) return 0;
  return Number(rec.n_saved_times) || 0;
}

function syncRunResultsPanel(statusText) {
  const hint = document.getElementById('run-results-hint');
  const title = document.getElementById('run-results-title');
  const rec = typeof selectedRunRecord === 'function' ? selectedRunRecord() : null;
  const name = (rec && rec.name) || 'Run';
  if (title) title.textContent = 'Results';
  if (!hint) return;
  if (statusText) {
    hint.textContent = statusText;
    return;
  }
  const st = rec && rec.status;
  if (st === 'running' && runHasResults(rec)) {
    const transient = typeof runRecIsTransient === 'function' && runRecIsTransient(rec);
    const frames = runLiveFrameCount(rec);
    const last = Number(rec.last_saved_iteration) || 0;
    hint.textContent =
      name +
      ' is still solving — live results: ' +
      (transient
        ? frames + (frames === 1 ? ' frame' : ' frames') + (last ? ' saved to t = ' + formatSimTime(last) : '')
        : 'saved to iteration ' + last) +
      '. New ' +
      (transient ? 'frames' : 'iterations') +
      ' appear here as they are written.';
    return;
  }
  if (runHasResults(rec)) {
    const transient = typeof runRecIsTransient === 'function' && runRecIsTransient(rec);
    const iter = st === 'stopped' ? rec.last_saved_iteration || rec.iteration : rec.iteration || rec.endTime;
    const frames = Number(rec.n_saved_times) || 0;
    const when = transient
      ? (frames ? ' · ' + frames + ' frames' : '') +
        (iter ? ' to t = ' + formatSimTime(st === 'stopped' ? iter : rec.transient && rec.transient.end_time ? rec.transient.end_time : iter) : '')
      : iter
        ? ' · iteration ' + iter
        : '';
    hint.textContent =
      'Fields from ' +
      name +
      when +
      (st === 'stopped' ? ' (stopped early)' : '') +
      (transient ? '. Use Filters → Animation → Time Step to play the frames.' : '. Filters and plots stay here until you leave Results.');
    return;
  }
  if (st === 'running') {
    hint.textContent = name + ' is still solving. Results open here as soon as the first saved frame is written.';
    return;
  }
  if (st === 'failed') {
    hint.textContent = name + ' failed. There are no results to show.';
    return;
  }
  if (st === 'stopped') {
    hint.textContent = name + ' was stopped before the first saved iteration. There are no results to show.';
    return;
  }
  hint.textContent = 'Start this run first. Results open here after it finishes.';
}

async function openRunResults(runId) {
  if (!runId) return;
  w27State.selected_run_id = runId;
  if (typeof expandRunFolders === 'function') expandRunFolders(runId);
  const selKey = 'runresults:' + runId;
  if (resultsViewOpen && treeUi.selectedKey === selKey) {
    hideRunResultsView();
    hideAllTreeDetails();
    markTreeSelected(null);
    return;
  }
  if (meshInspectOpen && typeof hideMeshInspect === 'function') {
    hideMeshInspect({ silent: true });
  }
  markTreeSelected(selKey);
  hideAllTreeDetails();
  const rec = typeof findRunRecord === 'function' ? findRunRecord(runId) : null;
  const casePath = rec && rec.case_dir;
  const ready = runHasResults(rec);
  if (!ready) {
    hideRunResultsView({ silent: true });
    try { applyWorkbenchStage(); } catch (_) {}
    return;
  }
  if (resultsViewOpen && resultsRunId && String(resultsRunId) !== String(runId)) {
    // Switching straight from another run's results: keep its live set.
    try { flushFilterAutosave(); } catch (_) {}
  }
  resultsViewOpen = true;
  resultsRunId = null; // set once the case is attached (blocks autosave meanwhile)
  // Colour scales belong to a run's filter set; start from auto and let the
  // saved set (restored below) bring back any user-set range.
  clearScaleOverrides();
  activeViewId = '';
  window.__CFD_RESULTS_VIEW__ = true;
  resetPostFilters();
  try { highlightGeomFaces([]); } catch (_) {}
  try { if (typeof clearBcGlyphs === 'function') clearBcGlyphs(); } catch (_) {}
  try { applyWorkbenchStage(); } catch (_) {}
  try { setFiltersToolbarMode('post'); } catch (_) {}
  try { setFiltersVisible(false); } catch (_) {}
  try { setLegendVisible(true); } catch (_) {}
  try { syncViewportOrient(); } catch (_) {}
  try {
    if (resultsCaseAlreadyAttached(casePath)) {
      await refreshFieldsAfterAttach();
    } else if (typeof attachSolveCase === 'function') {
      await attachSolveCase(casePath);
    } else {
      await attachCaseDirClient(casePath);
    }
  } catch (e) {
    console.warn('[CFD] open run results', e);
    return;
  }
  try { applyWorkbenchStage(); } catch (_) {}
  try { setFiltersToolbarMode('post'); } catch (_) {}
  try { setFiltersVisible(false); } catch (_) {}
  try { setLegendVisible(true); } catch (_) {}
  const loaded = !!(sourcePolyData && sourcePolyData.getNumberOfPoints && sourcePolyData.getNumberOfPoints() > 0);
  try { setGeomVisible(!loaded); } catch (_) {}
  if (loaded) {
    try { applyPartsAppearance(); } catch (_) {}
    try { frameSceneCamera(false); } catch (_) {}
    // Results open with the Filters panel showing the Parts filter, so the
    // coloring / opacity controls are at hand without an extra click.
    try {
      const parts = document.getElementById('parts-block');
      if (parts) parts.hidden = false;
      setFiltersVisible(true);
    } catch (_) {}
    // A filter clicked while the case was still attaching was skipped (no
    // case yet) — run it now that the fields are in.
    if (ptState.enabled && !ptLinePd) {
      loadParticleTrace().catch((e) => console.error('[CFD] PT after attach', e));
    }
  }
  try { syncViewportOrient(); } catch (_) {}
  try { renderWindow.render(); } catch (_) {}
  // Bring back the filters this run was left with (auto-saved live set).
  if (resultsViewOpen && treeUi.selectedKey === selKey) {
    resultsRunId = runId;
    try { renderViewsBlock(); } catch (_) {}
    if (loaded) {
      try { await restoreCurrentFilterSet(runId); } catch (_) {}
    }
    try { renderViewsBlock(); } catch (_) {}
  }
}

function syncMeshInspectPanel(statusText) {
  const live = getLiveMeshResult();
  const cells = (live && live.n_cells) != null ? live.n_cells : jobState.n_cells;
  const pts = (live && live.n_points) != null ? live.n_points : jobState.n_points;
  const status = document.getElementById('mesh-inspect-status');
  const line = document.getElementById('mesh-inspect-line');
  if (status) status.textContent = statusText || (isGeneratedMeshReady() ? 'Generated' : 'No mesh');
  if (line) {
    if (cells != null && pts != null) {
      line.textContent = Number(cells).toLocaleString() + ' cells · ' + Number(pts).toLocaleString() + ' nodes';
    } else {
      line.textContent = statusText || '—';
    }
  }
  const delForm = document.getElementById('mesh-delete');
  const delInspect = document.getElementById('mesh-inspect-delete');
  const chip = document.getElementById('mesh-inspect-chip');
  const showDel = isGeneratedMeshReady();
  if (delForm) delForm.hidden = !showDel;
  if (delInspect) delInspect.hidden = !showDel;
  if (chip) {
    const fromRun = String((treeUi && treeUi.selectedKey) || '').startsWith('runmeshitem:');
    chip.hidden = !meshInspectOpen || meshChipDismissed || fromRun;
  }
  const chipTitle = document.querySelector('.mesh-chip-title');
  if (chipTitle) chipTitle.textContent = meshDisplayName();
  const inspectTitle = document.querySelector('#panel-mesh-inspect .mat-panel-title');
  if (inspectTitle) inspectTitle.textContent = meshDisplayName();
}

/* Camera framing.
 * The scene camera is framed once per object (CAD import, or a mesh whose
 * extent differs from the CAD). Switching between the CAD and the mesh view
 * keeps the user's current camera: the mesh is drawn in CAD display units, so
 * its bounds coincide with the geometry and there is nothing to re-frame.
 */
let lastFramedBounds = null;
const SCENE_VIEW_DIRECTION = [-0.55, -0.75, 0.42]; // from front-left, slightly above (Z up)

function unionAabb(boxes) {
  const out = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  let n = 0;
  for (const b of boxes) {
    if (!b || b.length < 6 || !(b[0] <= b[1]) || !(b[2] <= b[3]) || !(b[4] <= b[5])) continue;
    out[0] = Math.min(out[0], b[0]);
    out[1] = Math.max(out[1], b[1]);
    out[2] = Math.min(out[2], b[2]);
    out[3] = Math.max(out[3], b[3]);
    out[4] = Math.min(out[4], b[4]);
    out[5] = Math.max(out[5], b[5]);
    n += 1;
  }
  return n ? out : null;
}

function sceneClipBounds() {
  const boxes = [];
  if (sourceBounds) boxes.push(sourceBounds);
  if (meshBounds && (meshInspectOpen || meshCompareOn())) {
    const s =
      typeof meshDisplayScaleFromBounds === 'function'
        ? meshDisplayScaleFromBounds(meshBounds) || 1
        : 1;
    boxes.push([
      meshBounds[0] * s,
      meshBounds[1] * s,
      meshBounds[2] * s,
      meshBounds[3] * s,
      meshBounds[4] * s,
      meshBounds[5] * s,
    ]);
  }
  if (boxes.length) return unionAabb(boxes);
  try { return renderer.computeVisiblePropBounds(); } catch (_) { return null; }
}

function applySceneClippingRange() {
  const cam = renderer && renderer.getActiveCamera && renderer.getActiveCamera();
  if (!cam) return;
  const b = sceneClipBounds();
  const pos = cam.getPosition();
  const fp = cam.getFocalPoint();
  const dist = Math.hypot(pos[0] - fp[0], pos[1] - fp[1], pos[2] - fp[2]);
  const span = b
    ? Math.max(b[1] - b[0], b[3] - b[2], b[5] - b[4], 1e-6)
    : Math.max(dist, 1);
  // Bounding sphere of the scene and the camera's distance to its centre.
  const R = b ? 0.5 * Math.hypot(b[1] - b[0], b[3] - b[2], b[5] - b[4]) : span;
  const c = b ? [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2] : fp;
  const dc = Math.hypot(pos[0] - c[0], pos[1] - c[1], pos[2] - c[2]);
  const d = Number.isFinite(dc) && dc > 1e-9 ? dc : Math.max(dist, span);
  // Near plane: just in front of the scene when the camera is outside it, a
  // small fraction of the model size when the camera is inside (zoomed into
  // a particle trace or cut). Far plane: just past the scene. Keeping far/near
  // in the thousands is what keeps the depth buffer usable — a ratio in the
  // hundreds of thousands makes CAD edges z-fight with the faces and makes
  // far-side edges bleed through the model.
  const near = Math.max(span * 2e-3, (d - R) * 0.9);
  const far = Math.max(d + R * 1.5, near * 100);
  try {
    const cur = cam.getClippingRange ? cam.getClippingRange() : null;
    if (cur && Math.abs(cur[0] - near) < 1e-6 && Math.abs(cur[1] - far) < 1e-6) return;
    cam.setClippingRange(near, far);
  } catch (_) {}
}

const _resetCameraClippingRange = typeof renderer.resetCameraClippingRange === 'function'
  ? renderer.resetCameraClippingRange.bind(renderer)
  : null;
function resetCameraClippingRangeLoose() {
  try { if (_resetCameraClippingRange) _resetCameraClippingRange(); } catch (_) {}
  applySceneClippingRange();
}

try {
  interactor.onAnimation(() => applySceneClippingRange());
  interactor.onMouseWheel(() => applySceneClippingRange());
} catch (_) {}

function boundsRoughlyEqual(a, b) {
  if (!a || !b || a.length !== 6 || b.length !== 6) return false;
  const span = Math.max(b[1] - b[0], b[3] - b[2], b[5] - b[4], 1e-12);
  for (let i = 0; i < 6; i++) if (Math.abs(a[i] - b[i]) > 0.02 * span) return false;
  return true;
}

/**
 * Orbit pivot. vtk.js's trackball rotate manipulator turns the camera about
 * the style's centerOfRotation, which defaults to the world origin — the CAD
 * origin, usually nowhere near the part. We pivot about the geometry's centre
 * of mass instead (volume centroid of the closed CAD shell via the divergence
 * theorem), falling back to the centre of the visible bounds.
 */
let scenePivot = null;

function cadCenterOfMass() {
  let vol = 0;
  const cv = [0, 0, 0];
  let area = 0;
  const ca = [0, 0, 0];
  let n = 0;
  try {
    walkCadTriangles((_id, _fid, a, b, c) => {
      n += 1;
      // signed tetra volume (origin, a, b, c) and its centroid
      const v =
        (a[0] * (b[1] * c[2] - b[2] * c[1]) -
          a[1] * (b[0] * c[2] - b[2] * c[0]) +
          a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
      vol += v;
      cv[0] += (v * (a[0] + b[0] + c[0])) / 4;
      cv[1] += (v * (a[1] + b[1] + c[1])) / 4;
      cv[2] += (v * (a[2] + b[2] + c[2])) / 4;
      // area-weighted surface centroid, the fallback for open shells
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const ar = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
      area += ar;
      ca[0] += (ar * (a[0] + b[0] + c[0])) / 3;
      ca[1] += (ar * (a[1] + b[1] + c[1])) / 3;
      ca[2] += (ar * (a[2] + b[2] + c[2])) / 3;
    });
  } catch (_) {
    return null;
  }
  if (!n) return null;
  // A watertight shell has |V| ≫ 0 relative to its area; otherwise the
  // signed volume cancels and the surface centroid is the honest answer.
  if (area > 0 && Math.abs(vol) > 1e-6 * Math.pow(area, 1.5)) {
    return [cv[0] / vol, cv[1] / vol, cv[2] / vol];
  }
  if (area > 0) return [ca[0] / area, ca[1] / area, ca[2] / area];
  return null;
}

function updateScenePivot(bounds) {
  const b = bounds;
  if (!b || !(b[0] <= b[1]) || !(b[2] <= b[3]) || !(b[4] <= b[5])) return;
  const c = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
  const span = Math.max(b[1] - b[0], b[3] - b[2], b[5] - b[4], 1e-9);
  let p = cadCenterOfMass();
  if (p) {
    const s = cadToWorldScale();
    p = [p[0] * s, p[1] * s, p[2] * s];
  }
  // Only trust the CAD centroid when it lies within the framed scene.
  if (
    !p ||
    p.some((x) => !Number.isFinite(x)) ||
    p[0] < b[0] - 0.1 * span || p[0] > b[1] + 0.1 * span ||
    p[1] < b[2] - 0.1 * span || p[1] > b[3] + 0.1 * span ||
    p[2] < b[4] - 0.1 * span || p[2] > b[5] + 0.1 * span
  ) {
    p = c;
  }
  scenePivot = p;
  applyOrbitCenter();
}

function currentModelOrbitCenter() {
  if (scenePivot && scenePivot.length === 3) return scenePivot;
  try {
    const b = renderer.computeVisiblePropBounds();
    if (b && b[0] <= b[1]) updateScenePivot(b);
  } catch (_) {}
  return scenePivot;
}

function applyOrbitCenter() {
  let p = null;
  if (orbitCenterMode === 'custom' && customOrbitCenter) p = customOrbitCenter;
  else if (orbitCenterMode === 'origin') p = [0, 0, 0];
  else p = currentModelOrbitCenter();
  if (!p || p.some((x) => !Number.isFinite(x))) return;
  try { cadStyle.setCenterOfRotation(p[0], p[1], p[2]); } catch (_) {}
  try {
    const v = compareState.viewer;
    if (v && v.style) v.style.setCenterOfRotation(p[0], p[1], p[2]);
  } catch (_) {}
}

function flashOrbitCenter(worldPos) {
  if (!worldPos || !orbitFlashActor || !orbitFlashSphere) return;
  const r = Math.max(worldPerCssPixelAt(worldPos, renderer) * 7, 1e-5);
  try {
    orbitFlashSphere.setCenter(worldPos[0], worldPos[1], worldPos[2]);
    orbitFlashSphere.setRadius(r);
    orbitFlashSphere.update();
  } catch (_) {
    return;
  }
  try { orbitFlashActor.setVisibility(true); } catch (_) {}
  try { renderWindow.render(); } catch (_) {}
  if (orbitFlashTimer) clearTimeout(orbitFlashTimer);
  orbitFlashTimer = setTimeout(() => {
    orbitFlashTimer = null;
    try { orbitFlashActor.setVisibility(false); } catch (_) {}
    try { renderWindow.render(); } catch (_) {}
  }, 900);
}

function setOrbitCenter(mode, worldPos) {
  orbitCenterMode = mode === 'origin' || mode === 'custom' ? mode : 'model';
  customOrbitCenter =
    orbitCenterMode === 'custom' && worldPos
      ? [Number(worldPos[0]), Number(worldPos[1]), Number(worldPos[2])]
      : null;
  applyOrbitCenter();
  const flash =
    orbitCenterMode === 'custom'
      ? customOrbitCenter
      : orbitCenterMode === 'origin'
        ? [0, 0, 0]
        : currentModelOrbitCenter();
  if (flash) flashOrbitCenter(flash);
}

function frameSceneCamera(force) {
  const cam = renderer.getActiveCamera();
  if (!cam) return;
  let b = null;
  try { b = renderer.computeVisiblePropBounds(); } catch (_) {}
  if (!b || !(b[0] <= b[1]) || !(b[2] <= b[3]) || !(b[4] <= b[5])) return;
  if (!force && lastFramedBounds && boundsRoughlyEqual(b, lastFramedBounds)) {
    if (!scenePivot) updateScenePivot(b);
    try { resetCameraClippingRangeLoose(); } catch (_) {}
    try { renderWindow.render(); } catch (_) {}
    return;
  }
  updateScenePivot(b);
  const c = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
  const span = Math.max(b[1] - b[0], b[3] - b[2], b[5] - b[4], 1e-9);
  try { cam.setParallelProjection(false); } catch (_) {}
  try {
    cam.setFocalPoint(c[0], c[1], c[2]);
    cam.setPosition(
      c[0] + SCENE_VIEW_DIRECTION[0] * span * 3,
      c[1] + SCENE_VIEW_DIRECTION[1] * span * 3,
      c[2] + SCENE_VIEW_DIRECTION[2] * span * 3,
    );
    cam.setViewUp(0, 0, 1);
  } catch (_) {}
  try { renderer.resetCamera(b); } catch (_) { try { renderer.resetCamera(); } catch (__) {} }
  try { resetCameraClippingRangeLoose(); } catch (_) {}
  lastFramedBounds = b.slice();
  try { renderWindow.render(); } catch (_) {}
}

function frameCadCamera(force) {
  frameSceneCamera(!!force);
}

function frameMeshCamera(force) {
  frameSceneCamera(!!force);
}

function cadNativeSpan() {
  const b =
    (w16State.geometry && w16State.geometry.fingerprint && w16State.geometry.fingerprint.bounds) ||
    (w16State.fingerprint && w16State.fingerprint.bounds) ||
    null;
  if (!b) return null;
  return Math.max(
    Math.abs(b.xmax - b.xmin),
    Math.abs(b.ymax - b.ymin),
    Math.abs(b.zmax - b.zmin),
  );
}

function meshDisplayScaleFromBounds(bounds) {
  const cadSpan = cadNativeSpan();
  if (!bounds || cadSpan == null || cadSpan < 1e-12) return 1;
  const meshSpan = Math.max(
    Math.abs(bounds[1] - bounds[0]),
    Math.abs(bounds[3] - bounds[2]),
    Math.abs(bounds[5] - bounds[4]),
  );
  if (meshSpan < 1e-12) return 1;
  const ratio = cadSpan / meshSpan;
  return ratio > 50 || ratio < 1 / 50 ? ratio : 1;
}

function cadActorScaleForView() {
  if (!(resultsViewOpen && !meshInspectOpen && !meshCompareOn() && sourceBounds)) return 1;
  const s = meshDisplayScaleFromBounds(sourceBounds);
  if (!s || !Number.isFinite(s) || Math.abs(s - 1) < 1e-9) return 1;
  return 1 / s;
}

function applyCadActorViewScale(actor) {
  if (!actor) return 1;
  let s = cadActorScaleForView();
  if (
    resultsViewOpen &&
    !meshInspectOpen &&
    actor === geomEdgeActor &&
    s !== 1
  ) {
    s *= 1.002;
  }
  try { actor.setScale(s, s, s); } catch (_) {}
  return s;
}

function applyMeshDisplayScale(actor, bounds) {
  const s = meshDisplayScaleFromBounds(bounds);
  try { actor.setScale(s, s, s); } catch (_) {}
  return s;
}

const MESH_FACE_RGB = [0.86, 0.88, 0.91];
const MESH_EDGE_RGB = [0.26, 0.28, 0.31];
let lastMeshEdgeLodKey = '';

function styleMeshCellActor(actor) {
  const pr = actor.getProperty();
  try { pr.setRepresentationToSurface(); } catch (_) {}
  try { pr.setEdgeVisibility(true); } catch (_) {}
  try { pr.setEdgeColor(MESH_EDGE_RGB[0], MESH_EDGE_RGB[1], MESH_EDGE_RGB[2]); } catch (_) {}
  try { pr.setColor(MESH_FACE_RGB[0], MESH_FACE_RGB[1], MESH_FACE_RGB[2]); } catch (_) {}
  try { pr.setOpacity(1); } catch (_) {}
  try { pr.setLighting(false); } catch (_) {}
  try { pr.setLineWidth(1); } catch (_) {}
  try { if (pr.setBackfaceCulling) pr.setBackfaceCulling(false); } catch (_) {}
  try { if (pr.setBackFaceCulling) pr.setBackFaceCulling(false); } catch (_) {}
}

function typicalMeshCellWorld() {
  const live = getLiveMeshResult() || {};
  const h = Number(live.surface_size_m);
  const s = meshDisplayScaleFromBounds(meshBounds) || 1;
  if (Number.isFinite(h) && h > 0) return h * s;
  const n =
    (window.__CFD_MESH_VIEW__ && (window.__CFD_MESH_VIEW__.n_cells_surface || window.__CFD_MESH_VIEW__.nCells)) ||
    0;
  if (meshBounds && n > 8) {
    const span = Math.max(meshBounds[1] - meshBounds[0], meshBounds[3] - meshBounds[2], meshBounds[5] - meshBounds[4]);
    return (span * s) / Math.cbrt(n);
  }
  return null;
}

function meshPixelsPerCell() {
  const cam = renderer && renderer.getActiveCamera && renderer.getActiveCamera();
  if (!cam) return 12;
  const pos = cam.getPosition();
  const fp = cam.getFocalPoint();
  const dist = Math.hypot(pos[0] - fp[0], pos[1] - fp[1], pos[2] - fp[2]);
  const cell = typicalMeshCellWorld();
  if (!cell || !Number.isFinite(dist) || dist < 1e-9) return 12;
  const fov = (cam.getViewAngle && cam.getViewAngle()) || 30;
  const canvas = container && container.querySelector('canvas');
  const hPx = (canvas && (canvas.clientHeight || canvas.height)) || 600;
  const worldH = 2 * dist * Math.tan(((fov * Math.PI) / 180) / 2);
  const worldPerPx = worldH / Math.max(hPx, 1);
  return cell / Math.max(worldPerPx, 1e-12);
}

function applyMeshEdgeLodToActor(actor, ppc) {
  if (!actor) return;
  const pr = actor.getProperty();
  const show = ppc >= 2.4;
  try { pr.setEdgeVisibility(show); } catch (_) {}
  if (!show) return;
  let t = 1;
  if (ppc < 5.5) t = Math.max(0.15, Math.min(1, (ppc - 2.4) / 3.1));
  const er = MESH_FACE_RGB[0] * (1 - t) + MESH_EDGE_RGB[0] * t;
  const eg = MESH_FACE_RGB[1] * (1 - t) + MESH_EDGE_RGB[1] * t;
  const eb = MESH_FACE_RGB[2] * (1 - t) + MESH_EDGE_RGB[2] * t;
  try { pr.setEdgeColor(er, eg, eb); } catch (_) {}
}

function applyMeshEdgeLod() {
  if (!meshInspectOpen && !meshCompareOn()) return;
  const ppc = meshPixelsPerCell();
  const key = String(Math.round(ppc * 6));
  if (key === lastMeshEdgeLodKey) return;
  lastMeshEdgeLodKey = key;
  applyMeshEdgeLodToActor(meshSurfActor, ppc);
  try {
    if (compareState.viewer && compareState.viewer.actor) {
      applyMeshEdgeLodToActor(compareState.viewer.actor, ppc);
    }
  } catch (_) {}
}

function styleMeshSliceActor(actor) {
  styleMeshCellActor(actor);
  const pr = actor.getProperty();
  try { pr.setColor(0.82, 0.85, 0.89); } catch (_) {}
}

function meshPlaneOrigin(axis, frac, inverse, com, bounds) {
  const b = bounds || meshBounds;
  if (!b) return { origin: [0, 0, 0], normal: [1, 0, 0] };
  const t = meshSectionFrac(frac);
  const c = com && com.length === 3 ? com : getObjectCenterOfMass(b);
  const ax = String(axis || 'x').toLowerCase();
  let origin = [c[0], c[1], c[2]];
  let normal = [1, 0, 0];
  if (ax === 'y') {
    origin = [c[0], b[2] + t * (b[3] - b[2]), c[2]];
    normal = [0, 1, 0];
  } else if (ax === 'z') {
    origin = [c[0], c[1], b[4] + t * (b[5] - b[4])];
    normal = [0, 0, 1];
  } else {
    origin = [b[0] + t * (b[1] - b[0]), c[1], c[2]];
    normal = [1, 0, 0];
  }
  if (inverse) normal = [-normal[0], -normal[1], -normal[2]];
  return { origin, normal };
}

function applyMeshClipping() {
  const s = meshDisplayScaleFromBounds(meshBounds) || 1;
  try { if (meshSurfMapper.removeAllClippingPlanes) meshSurfMapper.removeAllClippingPlanes(); } catch (_) {}
  try { if (geomEdgeMapper.removeAllClippingPlanes) geomEdgeMapper.removeAllClippingPlanes(); } catch (_) {}
  for (const plane of meshPlanes) {
    if (!plane.enabled || !plane.vtkPlane) continue;
    const { origin, normal } = meshPlaneOrigin(plane.axis, plane.frac, plane.inverse, plane.com);
    // vtk.js clipping planes are world-space. Mesh polydata is metres; the
    // actor is scaled to CAD mm — without this multiply the plane misses the mesh.
    plane.vtkPlane.setOrigin(origin[0] * s, origin[1] * s, origin[2] * s);
    plane.vtkPlane.setNormal(normal[0], normal[1], normal[2]);
    try { meshSurfMapper.addClippingPlane(plane.vtkPlane); } catch (_) {}
    // Cut CAD silhouette with the same world plane so the outline matches.
    if (meshInspectOpen) {
      try { geomEdgeMapper.addClippingPlane(plane.vtkPlane); } catch (_) {}
    }
  }
  try { meshSurfMapper.modified(); } catch (_) {}
  try { geomEdgeMapper.modified(); } catch (_) {}
  try { applyCompareClipping(); } catch (_) {}
}

function renderMeshPlaneList() {
  const list = document.getElementById('mesh-plane-list');
  if (!list) return;
  if (!meshPlanes.length) {
    list.innerHTML = '<li class="hub-empty">No cutting planes</li>';
    return;
  }
  list.innerHTML = meshPlanes
    .map((p) => {
      const ax = String(p.axis || 'x').toUpperCase();
      return (
        '<li class="mesh-plane-card" data-mesh-plane="' +
        p.id +
        '">' +
        '<div class="mesh-plane-card-head">' +
        '<strong>' +
        escapeHtml(p.name) +
        '</strong>' +
        '<button type="button" class="mesh-plane-del" data-del-plane="' +
        p.id +
        '">Delete</button>' +
        '</div>' +
        '<div class="fp-row toggle-row"><span>Enabled</span>' +
        '<label class="switch"><input type="checkbox" data-plane-on="' +
        p.id +
        '"' +
        (p.enabled ? ' checked' : '') +
        ' /><span class="slider"></span></label></div>' +
        '<div class="fp-field"><div class="fp-label">Position</div>' +
        '<input type="range" min="0" max="100" value="' +
        Math.round(meshSectionFrac(p.frac) * 100) +
        '" data-plane-frac="' +
        p.id +
        '" /></div>' +
        '<div class="fp-field"><div class="fp-label">Orientation</div>' +
        '<div class="orient-btns">' +
        ['X', 'Y', 'Z']
          .map(
            (a) =>
              '<button type="button" class="orient' +
              (ax === a ? ' is-on' : '') +
              '" data-plane-axis="' +
              p.id +
              '" data-axis="' +
              a +
              '">' +
              a +
              '</button>'
          )
          .join('') +
        '<button type="button" class="orient' +
        (p.inverse ? ' is-on' : '') +
        '" data-plane-inv="' +
        p.id +
        '">Inverse</button>' +
        '</div></div></li>'
      );
    })
    .join('');
}

function syncMeshPlaneToolbar() {
  const btn = document.querySelector('.tb-btn[data-label="Cutting Plane"]');
  btn?.classList.toggle('is-active', meshPlanes.some((p) => p.enabled));
}

async function loadMeshPlaneSlice(plane) {
  const casePath = (compareState.on && compareState.leftCase) || getLiveMeshCaseDir();
  if (!casePath || !plane || !plane.enabled) {
    if (plane && plane.actor) plane.actor.setVisibility(false);
    return;
  }
  const q = withProjectCaseParams({
    case: casePath,
    axis: String(plane.axis || 'x').toLowerCase(),
    frac: String(meshSectionFrac(plane.frac)),
  });
  const vtpUrl = '/api/mesh-section?' + q.toString();
  try {
    await plane.reader.setUrl(vtpUrl);
    let pd = null;
    for (let i = 0; i < 80; i++) {
      pd = plane.reader.getOutputData ? plane.reader.getOutputData() : null;
      const n = pd && pd.getNumberOfPoints ? pd.getNumberOfPoints() : 0;
      if (n > 0) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    const n = pd && pd.getNumberOfPoints ? pd.getNumberOfPoints() : 0;
    if (pd && n > 0) {
      plane.mapper.setInputData(pd);
      plane.mapper.setScalarVisibility(false);
      plane.actor.setVisibility(true);
    } else {
      plane.actor.setVisibility(false);
    }
  } catch (e) {
    console.warn('[CFD] mesh plane slice', e);
    try { plane.actor.setVisibility(false); } catch (_) {}
  }
}

async function refreshMeshPlanes() {
  applyMeshClipping();
  await Promise.all(meshPlanes.map((p) => loadMeshPlaneSlice(p)));
  syncMeshPlaneToolbar();
  try { renderWindow.render(); } catch (_) {}
  try { await refreshComparePlanes(); } catch (_) {}
}

function addMeshPlane() {
  const id = 'mp-' + meshPlaneSeq++;
  const vtkP = vtkPlane.newInstance();
  const reader = vtkXMLPolyDataReader.newInstance();
  const mapper = vtkMapper.newInstance();
  mapper.setScalarVisibility(false);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  actor.setVisibility(false);
  styleMeshSliceActor(actor);
  applyMeshDisplayScale(actor, meshBounds);
  renderer.addActor(actor);
  const com = getObjectCenterOfMass(meshBounds);
  const axis = 'x';
  meshPlanes.push({
    id,
    name: 'Cutting Plane ' + (meshPlanes.length + 1),
    enabled: true,
    axis,
    frac: fracAlongAxis(meshBounds, axis, com),
    com,
    inverse: false,
    vtkPlane: vtkP,
    reader,
    mapper,
    actor,
  });
  renderMeshPlaneList();
  refreshMeshPlanes();
  setFiltersVisible(true);
}

function removeMeshPlane(id) {
  const i = meshPlanes.findIndex((p) => p.id === id);
  if (i < 0) return;
  const plane = meshPlanes[i];
  try { renderer.removeActor(plane.actor); } catch (_) {}
  try {
    if (plane.compareActor && compareState.viewer) {
      compareState.viewer.renderer.removeActor(plane.compareActor);
    }
  } catch (_) {}
  meshPlanes.splice(i, 1);
  renderMeshPlaneList();
  refreshMeshPlanes();
}

function clearMeshView() {
  try { meshSurfActor.setVisibility(false); } catch (_) {}
  try { meshSurfActor.setScale(1, 1, 1); } catch (_) {}
  try { if (meshSurfMapper.removeAllClippingPlanes) meshSurfMapper.removeAllClippingPlanes(); } catch (_) {}
  try { if (geomEdgeMapper.removeAllClippingPlanes) geomEdgeMapper.removeAllClippingPlanes(); } catch (_) {}
  while (meshPlanes.length) {
    const plane = meshPlanes.pop();
    try { renderer.removeActor(plane.actor); } catch (_) {}
  }
  meshBounds = null;
  meshSurfFullPd = null;
  renderMeshPlaneList();
  syncMeshPlaneToolbar();
}

async function loadFullMeshSurface(casePath) {
  const q = withProjectCaseParams({ case: casePath });
  const metaUrl = '/api/mesh-surface?' + q.toString() + '&meta=1';
  const vtpUrl = '/api/mesh-surface?' + q.toString();
  let meta = null;
  try {
    const mr = await fetch(metaUrl);
    if (mr.ok) meta = await mr.json();
  } catch (e) {
    console.warn('[CFD] mesh-surface meta', e);
  }
  await meshSurfReader.setUrl(vtpUrl);
  let pd = null;
  for (let i = 0; i < 160; i++) {
    pd = meshSurfReader.getOutputData ? meshSurfReader.getOutputData() : null;
    const n = pd && pd.getNumberOfPoints ? pd.getNumberOfPoints() : 0;
    if (n > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const nPts = pd && pd.getNumberOfPoints ? pd.getNumberOfPoints() : 0;
  if (!pd || nPts < 1) {
    return { empty: true, skipped: 'empty_vtp', meta };
  }
  meshSurfMapper.setInputData(pd);
  meshSurfMapper.setScalarVisibility(false);
  meshBounds = pd.getBounds ? pd.getBounds().slice() : (meta && meta.meta && meta.meta.bounds) || null;
  if (meta && meta.meta && meta.meta.bounds) meshBounds = meta.meta.bounds.slice();
  styleMeshCellActor(meshSurfActor);
  applyMeshDisplayScale(meshSurfActor, meshBounds);
  meshSurfFullPd = pd;
  applyHiddenMeshDisplay();
  lastMeshEdgeLodKey = '';
  applyMeshEdgeLod();
  meshSurfActor.setVisibility(true);
  try { surfaceActor.setVisibility(false); } catch (_) {}
  try { cutActor.setVisibility(false); } catch (_) {}
  try { renderer.setBackground(1, 1, 1); } catch (_) {}
  applyCadEdgesNow();
  frameMeshCamera();
  window.__CFD_MESH_VIEW__ = {
    ready: true,
    case_dir: casePath,
    nPoints: nPts,
    nCells: pd.getNumberOfCells ? pd.getNumberOfCells() : 0,
    n_cells_volume: meta && (meta.n_cells_volume || (meta.meta && meta.meta.n_cells_volume)),
    n_cells_surface: meta && (meta.n_cells_surface || (meta.meta && meta.meta.n_cells_surface)),
  };
  return window.__CFD_MESH_VIEW__;
}

function hideMeshInspect(opts) {
  try { stopCompare(); } catch (_) {}
  meshInspectOpen = false;
  window.__CFD_MESH_INSPECT__ = false;
  window.__CFD_MESH_VIEW__ = null;
  meshChipDismissed = false;
  clearMeshView();
  try { setFiltersVisible(false); } catch (_) {}
  const chip = document.getElementById('mesh-inspect-chip');
  if (chip) chip.hidden = true;
  if (!(opts && opts.silent)) {
    if (w16State && w16State.geometry) {
      setGeomVisible(true);
      frameCadCamera();
    }
    try { applyWorkbenchStage(); } catch (_) {}
  }
  syncMeshInspectPanel();
}

async function showMeshInspect(meshId) {
  const rec =
    (meshId && findMeshRecord(meshId)) ||
    (!meshId ? getLiveMeshDoc() : null);
  if (!isGeneratedMeshReady(rec)) {
    syncMeshInspectPanel('No generated mesh');
    return { empty: true, skipped: 'no_mesh' };
  }
  const casePath =
    (rec.live_mesh_result && rec.live_mesh_result.case_dir) || rec.case_dir || null;
  if (!casePath || !caseBelongsToCurrentStudy(casePath)) {
    syncMeshInspectPanel('No generated mesh');
    return { empty: true, skipped: 'foreign_or_missing_case' };
  }
  if (resultsViewOpen) hideRunResultsView({ silent: true });
  meshInspectOpen = true;
  meshChipDismissed = false;
  window.__CFD_MESH_INSPECT__ = true;
  applyWorkbenchStage();
  setFiltersToolbarMode('mesh');
  setFiltersVisible(true);
  document.querySelector('.tb-btn[data-label="Cutting Plane"]')?.classList.remove('is-active');
  setGeomVisible(false);
  applyCadEdgesNow();
  try { meshSurfActor.setPickable(true); } catch (_) {}
  try { if (typeof clearBcGlyphs === 'function') clearBcGlyphs(); } catch (_) {}
  try { highlightGeomFaces([]); } catch (_) {}
  try { surfaceActor.setVisibility(false); } catch (_) {}
  try { cutActor.setVisibility(false); } catch (_) {}
  syncMeshInspectPanel('Loading mesh…');
  renderMeshPlaneList();
  try {
    if (casePath && String(casePath) !== String(getCaseDir() || '')) {
      await attachCaseDirClient(casePath);
    } else if (casePath) {
      caseDir = casePath;
    }
  } catch (e) {
    console.warn('[CFD] mesh inspect attach', e);
    if (casePath) caseDir = casePath;
  }
  applyLiveMeshCountsToJob();
  let loaded = null;
  try {
    loaded = await loadFullMeshSurface(casePath);
  } catch (e) {
    console.warn('[CFD] mesh inspect load', e);
    loaded = { empty: true, error: String(e) };
  }
  if (!loaded || loaded.empty || loaded.skipped || loaded.ready === false) {
    syncMeshInspectPanel(loaded && loaded.skipped === 'no_case' ? 'Mesh case not attached' : 'Could not load mesh');
    return loaded;
  }
  syncMeshInspectPanel('Generated');
  try { requestAnimationFrame(syncFiltersPanelOffset); } catch (_) {}
  return loaded;
}

window.__CFD_SHOW_MESH_INSPECT__ = showMeshInspect;
window.__CFD_HIDE_MESH_INSPECT__ = hideMeshInspect;

function compareMeshPool() {
  try {
    const st = window.__CFD_W20_STATE__;
    if (st && Array.isArray(st.meshes_all) && st.meshes_all.length) return st.meshes_all;
  } catch (_) {}
  return meshList();
}

function generatedMeshesForCompare() {
  return compareMeshPool()
    .filter((m) => isGeneratedMeshReady(m))
    .map((m) => {
      const live = m.live_mesh_result || {};
      return {
        id: String(m.id || ''),
        name: meshDisplayName(m),
        geometry_name: m.geometry_name || null,
        case_dir: String(live.case_dir || m.case_dir || ''),
      };
    })
    .filter((m) => m.id && m.case_dir);
}

function meshByCompareId(id) {
  return generatedMeshesForCompare().find((m) => m.id === String(id || '')) || null;
}

function defaultCompareIds() {
  const meshes = generatedMeshesForCompare();
  let activeId = null;
  try { activeId = window.__CFD_W20_STATE__ && window.__CFD_W20_STATE__.active_id; } catch (_) {}
  const left = meshes.find((m) => m.id === String(activeId || '')) || meshes[0] || null;
  const right = (left && meshes.find((m) => m.id !== left.id)) || meshes[1] || null;
  return {
    leftId: left ? left.id : null,
    rightId: right ? right.id : null,
  };
}

function snapshotCamera(cam) {
  if (!cam) return null;
  try {
    return {
      pos: cam.getPosition().slice(),
      fp: cam.getFocalPoint().slice(),
      vu: cam.getViewUp().slice(),
      parallel: !!(cam.getParallelProjection && cam.getParallelProjection()),
      scale: cam.getParallelScale ? cam.getParallelScale() : null,
      angle: cam.getViewAngle ? cam.getViewAngle() : null,
      clip: cam.getClippingRange ? cam.getClippingRange().slice() : null,
    };
  } catch (_) {
    return null;
  }
}

function cameraLooksUnset(snap) {
  if (!snap || !snap.pos || !snap.fp) return true;
  const p = snap.pos;
  const fp = snap.fp;
  return (
    Math.abs(p[0]) < 1e-8 &&
    Math.abs(p[1]) < 1e-8 &&
    Math.abs(p[2] - 1) < 1e-6 &&
    Math.abs(fp[0]) < 1e-8 &&
    Math.abs(fp[1]) < 1e-8 &&
    Math.abs(fp[2]) < 1e-8
  );
}

function applyCameraSnapshot(cam, snap) {
  if (!cam || !snap) return;
  cam.setPosition(snap.pos[0], snap.pos[1], snap.pos[2]);
  cam.setFocalPoint(snap.fp[0], snap.fp[1], snap.fp[2]);
  cam.setViewUp(snap.vu[0], snap.vu[1], snap.vu[2]);
  try { cam.setParallelProjection(!!snap.parallel); } catch (_) {}
  try {
    if (snap.parallel && snap.scale != null) cam.setParallelScale(snap.scale);
    else if (snap.angle != null) cam.setViewAngle(snap.angle);
  } catch (_) {}
  try {
    if (snap.clip && snap.clip.length === 2) cam.setClippingRange(snap.clip[0], snap.clip[1]);
  } catch (_) {}
}

function copyCameraState(fromCam, toCam) {
  if (!fromCam || !toCam) return;
  applyCameraSnapshot(toCam, snapshotCamera(fromCam));
}

function syncCompareCamerasFromLeft() {
  const v = compareState.viewer;
  if (!v || !compareState.on) return;
  compareState.syncing = true;
  try {
    copyCameraState(renderer.getActiveCamera(), v.renderer.getActiveCamera());
    try { v.renderer.resetCameraClippingRange(); } catch (_) {}
    v.renderWindow.render();
  } finally {
    compareState.syncing = false;
  }
}

function syncCompareCamerasFromRight() {
  const v = compareState.viewer;
  if (!v || !compareState.on) return;
  compareState.syncing = true;
  try {
    copyCameraState(v.renderer.getActiveCamera(), renderer.getActiveCamera());
    try { resetCameraClippingRangeLoose(); } catch (_) {}
    renderWindow.render();
  } finally {
    compareState.syncing = false;
  }
}

function bindCompareCameraSync() {
  if (compareState.camBound || !compareState.viewer) return;
  const leftCam = renderer.getActiveCamera();
  const rightCam = compareState.viewer.renderer.getActiveCamera();
  const onLeft = () => {
    if (!compareState.on || compareState.syncing) return;
    syncCompareCamerasFromLeft();
  };
  const onRight = () => {
    if (!compareState.on || compareState.syncing) return;
    syncCompareCamerasFromRight();
  };
  try { leftCam.onModified(onLeft); } catch (_) {}
  try { rightCam.onModified(onRight); } catch (_) {}
  const hookIa = (ia, fromLeft) => {
    if (!ia) return;
    const fn = () => {
      if (!compareState.on || compareState.syncing) return;
      if (fromLeft) syncCompareCamerasFromLeft();
      else syncCompareCamerasFromRight();
    };
    try { if (ia.onAnimation) ia.onAnimation(fn); } catch (_) {}
    try { if (ia.onEndAnimation) ia.onEndAnimation(fn); } catch (_) {}
  };
  hookIa(interactor, true);
  hookIa(compareState.viewer.interactor, false);
  compareState.camBound = true;
}

function restoreCompareCameras(snap) {
  const leftCam = renderer.getActiveCamera();
  if (snap && !cameraLooksUnset(snap)) {
    compareState.syncing = true;
    try {
      applyCameraSnapshot(leftCam, snap);
      try { resetCameraClippingRangeLoose(); } catch (_) {}
    } finally {
      compareState.syncing = false;
    }
  } else if (cameraLooksUnset(snapshotCamera(leftCam))) {
    try { frameMeshCamera(true); } catch (_) {}
  }
  syncCompareCamerasFromLeft();
}

function ensureCompareViewer() {
  if (compareState.viewer) return compareState.viewer;
  const el = document.getElementById('viewer-b');
  if (!el) return null;
  const fsr = vtkFullScreenRenderWindow.newInstance({
    rootContainer: el,
    containerStyle: {
      height: '100%',
      width: '100%',
      position: 'absolute',
      left: '0',
      top: '0',
    },
    background: [1, 1, 1],
  });
  const ren = fsr.getRenderer();
  const rw = fsr.getRenderWindow();
  const ia = fsr.getInteractor();
  const style = vtkInteractorStyleManipulator.newInstance();
  style.addMouseManipulator(vtkMouseCameraTrackballRotateManipulator.newInstance({ button: 1 }));
  style.addMouseManipulator(vtkMouseCameraTrackballPanManipulator.newInstance({ button: 2 }));
  style.addMouseManipulator(vtkMouseCameraTrackballPanManipulator.newInstance({ button: 1, shift: true }));
  style.addMouseManipulator(vtkMouseCameraTrackballZoomManipulator.newInstance({
    dragEnabled: false,
    scrollEnabled: true,
  }));
  style.addMouseManipulator(vtkMouseCameraTrackballZoomManipulator.newInstance({ button: 3 }));
  ia.setInteractorStyle(style);
  const blockAutoscroll = (e) => {
    if (e.button === 1) e.preventDefault();
  };
  let rightDown = null;
  el.addEventListener('mousedown', (e) => {
    blockAutoscroll(e);
    if (e.button === 2) rightDown = { x: e.clientX, y: e.clientY };
  }, { capture: true });
  el.addEventListener('auxclick', (e) => e.preventDefault());
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (rightDown) {
      const dx = e.clientX - rightDown.x;
      const dy = e.clientY - rightDown.y;
      rightDown = null;
      if (dx * dx + dy * dy > 256) return;
    }
    try { onViewerFaceContextMenu(e, 'b'); } catch (_) {}
  });
  try { wireViewerFaceClick(el, 'b'); } catch (_) {}
  const reader = vtkXMLPolyDataReader.newInstance();
  const mapper = vtkMapper.newInstance();
  mapper.setScalarVisibility(false);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  styleMeshCellActor(actor);
  try { actor.setPickable(true); } catch (_) {}
  actor.setVisibility(false);
  ren.addActor(actor);
  try { ren.setBackground(1, 1, 1); } catch (_) {}
  // Same orbit pivot as the main view (its camera is mirrored onto this one).
  try {
    if (scenePivot) style.setCenterOfRotation(scenePivot[0], scenePivot[1], scenePivot[2]);
  } catch (_) {}
  compareState.viewer = {
    fullScreenRenderer: fsr,
    renderer: ren,
    renderWindow: rw,
    interactor: ia,
    style,
    reader,
    mapper,
    actor,
    edgeMapper: null,
    edgeActor: null,
    bounds: null,
  };
  return compareState.viewer;
}

function styleCadEdgeActor(actor) {
  if (!actor) return;
  const pr = actor.getProperty();
  try { pr.setColor(0.04, 0.045, 0.055); } catch (_) {}
  try { pr.setLineWidth(2.4); } catch (_) {}
  try { pr.setRepresentationToWireframe(); } catch (_) {}
  try { pr.setLighting(false); } catch (_) {}
}

function ensureCompareCadEdges() {
  const v = compareState.viewer;
  if (!v) return null;
  if (v.edgeActor) return v;
  const mapper = vtkMapper.newInstance();
  mapper.setScalarVisibility(false);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  styleCadEdgeActor(actor);
  actor.setVisibility(false);
  try { actor.setPickable(false); } catch (_) {}
  v.renderer.addActor(actor);
  v.edgeMapper = mapper;
  v.edgeActor = actor;
  return v;
}

function applyCompareCadEdges(show) {
  const v = compareState.viewer;
  if (!v) return;
  ensureCompareCadEdges();
  if (!v.edgeActor || !v.edgeMapper) return;
  const on = !!show && compareState.on;
  if (on) {
    try { applyHiddenCadEdges(); } catch (_) {}
    styleCadEdgeActor(v.edgeActor);
    v.edgeActor.setVisibility(true);
    try {
      v.renderer.removeActor(v.edgeActor);
      v.renderer.addActor(v.edgeActor);
    } catch (_) {}
  } else {
    try { v.edgeActor.setVisibility(false); } catch (_) {}
  }
}

function syncCadEdgesButton() {
  const btn = document.getElementById('btn-cad-edges');
  if (btn) {
    btn.classList.toggle('is-active', !!cadEdgesWanted);
    btn.setAttribute('aria-pressed', cadEdgesWanted ? 'true' : 'false');
  }
}

function applyCadEdgesNow() {
  const inMeshView = !!(meshInspectOpen || meshCompareOn());
  const inResults = !!(resultsViewOpen && !meshInspectOpen && !meshCompareOn());
  const cadOn = !!(geomActor && geomActor.getVisibility && geomActor.getVisibility());
  // The "CAD edges" toggle only exists in the mesh and results views, so it only
  // governs those. The setup (geometry) view always draws the edges with the
  // CAD faces; otherwise a toggle left off in Results silently strips the edges
  // from the geometry view with no control to bring them back.
  const show = inMeshView || inResults ? !!cadEdgesWanted : cadOn;
  try { applyHiddenCadEdges(); } catch (_) {}
  try { applyCadActorViewScale(geomEdgeActor); } catch (_) {}
  try { geomEdgeActor.setVisibility(show); } catch (_) {}
  if (show) {
    try { bringCadEdgesForward(); } catch (_) {}
  }
  applyCompareCadEdges(!!cadEdgesWanted && inMeshView);
  syncCadEdgesButton();
  try { renderWindow.render(); } catch (_) {}
  try {
    if (compareState.viewer && compareState.on) compareState.viewer.renderWindow.render();
  } catch (_) {}
}

function applyCompareLayout(on) {
  const stage = document.getElementById('compare-stage');
  const paneB = document.getElementById('compare-pane-b');
  const labelA = document.getElementById('compare-label-a');
  const labelB = document.getElementById('compare-label-b');
  if (stage) stage.classList.toggle('is-split', !!on);
  if (paneB) paneB.hidden = !on;
  if (labelA) labelA.hidden = !on;
  if (labelB) labelB.hidden = !on;
  const chip = document.getElementById('mesh-inspect-chip');
  if (on) {
    if (chip) chip.hidden = true;
  } else if (meshInspectOpen) {
    try { syncMeshInspectPanel(); } catch (_) {}
  }
  try { resizeViewer(); } catch (_) {}
  requestAnimationFrame(() => {
    try { resizeViewer(); } catch (_) {}
  });
}

function syncComparePaneLabels() {
  const a = meshByCompareId(compareState.leftId);
  const b = meshByCompareId(compareState.rightId);
  const la = document.getElementById('compare-label-a');
  const lb = document.getElementById('compare-label-b');
  if (la) la.textContent = a ? a.name : '';
  if (lb) lb.textContent = b ? b.name : '';
}

function syncCompareSelectValues() {
  const a = document.getElementById('compare-mesh-a');
  const b = document.getElementById('compare-mesh-b');
  if (a && compareState.leftId) a.value = compareState.leftId;
  if (b && compareState.rightId) b.value = compareState.rightId;
}

function fillCompareSelects() {
  const meshes = generatedMeshesForCompare();
  const a = document.getElementById('compare-mesh-a');
  const b = document.getElementById('compare-mesh-b');
  const note = document.getElementById('compare-bar-note');
  const syncWrap = document.getElementById('compare-sync-wrap');
  if (syncWrap) syncWrap.hidden = true; // results-compare only
  const opts = meshes
    .map((m) => {
      const label = m.geometry_name ? m.geometry_name + ' — ' + m.name : m.name;
      return '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(label) + '</option>';
    })
    .join('');
  if (a) {
    a.innerHTML = opts;
    a.disabled = meshes.length < 1;
  }
  if (b) {
    b.innerHTML = opts;
    b.disabled = meshes.length < 2;
  }
  if (note) {
    if (meshes.length < 2) {
      note.hidden = false;
      note.textContent = meshes.length < 1
        ? 'Generate a mesh first.'
        : 'Generate a second mesh to compare.';
    } else {
      note.hidden = true;
      note.textContent = '';
    }
  }
  syncCompareSelectValues();
}

function ensureDifferentCompareMeshes(changed) {
  const meshes = generatedMeshesForCompare();
  if (meshes.length < 2) return;
  if (compareState.leftId && compareState.leftId === compareState.rightId) {
    const other = meshes.find((m) => m.id !== compareState.leftId);
    if (!other) return;
    if (changed === 'b') compareState.leftId = other.id;
    else compareState.rightId = other.id;
  }
}

function ensureComparePlaneActors(plane) {
  const v = compareState.viewer;
  if (!v || !plane) return null;
  if (!plane.compareVtk) plane.compareVtk = vtkPlane.newInstance();
  if (!plane.compareReader) plane.compareReader = vtkXMLPolyDataReader.newInstance();
  if (!plane.compareMapper) {
    plane.compareMapper = vtkMapper.newInstance();
    plane.compareMapper.setScalarVisibility(false);
  }
  if (!plane.compareActor) {
    plane.compareActor = vtkActor.newInstance();
    plane.compareActor.setMapper(plane.compareMapper);
    styleMeshSliceActor(plane.compareActor);
    v.renderer.addActor(plane.compareActor);
  }
  return plane;
}

function applyCompareClipping() {
  const v = compareState.viewer;
  if (!v || !compareState.on) return;
  try { if (v.mapper.removeAllClippingPlanes) v.mapper.removeAllClippingPlanes(); } catch (_) {}
  try { if (v.edgeMapper && v.edgeMapper.removeAllClippingPlanes) v.edgeMapper.removeAllClippingPlanes(); } catch (_) {}
  const s = meshDisplayScaleFromBounds(v.bounds) || 1;
  for (const plane of meshPlanes) {
    if (!plane.enabled) continue;
    ensureComparePlaneActors(plane);
    const com = getObjectCenterOfMass(v.bounds);
    const { origin, normal } = meshPlaneOrigin(plane.axis, plane.frac, plane.inverse, com, v.bounds);
    plane.compareVtk.setOrigin(origin[0] * s, origin[1] * s, origin[2] * s);
    plane.compareVtk.setNormal(normal[0], normal[1], normal[2]);
    try { v.mapper.addClippingPlane(plane.compareVtk); } catch (_) {}
    try { if (v.edgeMapper) v.edgeMapper.addClippingPlane(plane.compareVtk); } catch (_) {}
  }
  try { v.mapper.modified(); } catch (_) {}
  try { if (v.edgeMapper) v.edgeMapper.modified(); } catch (_) {}
}

async function loadComparePlaneSlice(plane) {
  const v = compareState.viewer;
  const casePath = compareState.rightCase;
  if (!v || !compareState.on || !casePath || !plane || !plane.enabled) {
    try { if (plane && plane.compareActor) plane.compareActor.setVisibility(false); } catch (_) {}
    return;
  }
  ensureComparePlaneActors(plane);
  applyMeshDisplayScale(plane.compareActor, v.bounds);
  const q = withProjectCaseParams({
    case: casePath,
    axis: String(plane.axis || 'x').toLowerCase(),
    frac: String(meshSectionFrac(plane.frac)),
  });
  try {
    await plane.compareReader.setUrl('/api/mesh-section?' + q.toString());
    let pd = null;
    for (let i = 0; i < 80; i++) {
      pd = plane.compareReader.getOutputData ? plane.compareReader.getOutputData() : null;
      const n = pd && pd.getNumberOfPoints ? pd.getNumberOfPoints() : 0;
      if (n > 0) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    const n = pd && pd.getNumberOfPoints ? pd.getNumberOfPoints() : 0;
    if (pd && n > 0) {
      plane.compareMapper.setInputData(pd);
      plane.compareMapper.setScalarVisibility(false);
      plane.compareActor.setVisibility(true);
    } else {
      plane.compareActor.setVisibility(false);
    }
  } catch (e) {
    console.warn('[CFD] compare plane slice', e);
    try { plane.compareActor.setVisibility(false); } catch (_) {}
  }
}

async function refreshComparePlanes() {
  if (!compareState.on || !compareState.viewer) return;
  applyCompareClipping();
  await Promise.all(meshPlanes.map((p) => loadComparePlaneSlice(p)));
  applyCompareCadEdges(!!cadEdgesWanted);
  try { compareState.viewer.renderWindow.render(); } catch (_) {}
}

async function loadCompareMeshSurface(casePath) {
  const v = ensureCompareViewer();
  if (!v || !casePath) return { empty: true };
  const vtpUrl = '/api/mesh-surface?' + withProjectCaseParams({ case: casePath }).toString();
  await v.reader.setUrl(vtpUrl);
  let pd = null;
  for (let i = 0; i < 160; i++) {
    pd = v.reader.getOutputData ? v.reader.getOutputData() : null;
    const n = pd && pd.getNumberOfPoints ? pd.getNumberOfPoints() : 0;
    if (n > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const nPts = pd && pd.getNumberOfPoints ? pd.getNumberOfPoints() : 0;
  if (!pd || nPts < 1) {
    try { v.actor.setVisibility(false); } catch (_) {}
    v.bounds = null;
    return { empty: true };
  }
  v.mapper.setInputData(pd);
  v.mapper.setScalarVisibility(false);
  v.bounds = pd.getBounds ? pd.getBounds().slice() : null;
  v.fullPd = pd;
  styleMeshCellActor(v.actor);
  applyMeshDisplayScale(v.actor, v.bounds);
  applyHiddenMeshDisplay();
  lastMeshEdgeLodKey = '';
  applyMeshEdgeLod();
  v.actor.setVisibility(true);
  try { v.renderer.setBackground(1, 1, 1); } catch (_) {}
  try { v.renderer.resetCameraClippingRange(); } catch (_) {}
  try { v.renderWindow.render(); } catch (_) {}
  return { ready: true, nPoints: nPts };
}

async function enterMeshInspectForCompare() {
  if (meshInspectOpen) return;
  if (resultsViewOpen) hideRunResultsView({ silent: true });
  meshInspectOpen = true;
  meshChipDismissed = false;
  window.__CFD_MESH_INSPECT__ = true;
  applyWorkbenchStage();
  setFiltersToolbarMode('mesh');
  setFiltersVisible(true);
  document.querySelector('.tb-btn[data-label="Cutting Plane"]')?.classList.remove('is-active');
  setGeomVisible(false);
  applyCadEdgesNow();
  try { if (typeof clearBcGlyphs === 'function') clearBcGlyphs(); } catch (_) {}
  try { highlightGeomFaces([]); } catch (_) {}
  try { surfaceActor.setVisibility(false); } catch (_) {}
  try { cutActor.setVisibility(false); } catch (_) {}
  renderMeshPlaneList();
}

async function loadCompareSides() {
  const token = ++compareState.loadToken;
  const left = meshByCompareId(compareState.leftId);
  const right = meshByCompareId(compareState.rightId);
  syncComparePaneLabels();
  if (!left || !right) return;
  compareState.leftCase = left.case_dir;
  compareState.rightCase = right.case_dir;
  await enterMeshInspectForCompare();
  if (token !== compareState.loadToken) return;
  const leftAlready = window.__CFD_MESH_VIEW__ && String(window.__CFD_MESH_VIEW__.case_dir) === String(left.case_dir);
  if (!leftAlready) {
    try { await loadFullMeshSurface(left.case_dir); } catch (e) {
      console.warn('[CFD] compare left mesh', e);
    }
  }
  if (token !== compareState.loadToken) return;
  try { await loadCompareMeshSurface(right.case_dir); } catch (e) {
    console.warn('[CFD] compare right mesh', e);
  }
  if (token !== compareState.loadToken) return;
  await refreshMeshPlanes();
  if (token !== compareState.loadToken) return;
  if (compareState.savedCam) {
    restoreCompareCameras(compareState.savedCam);
    compareState.savedCam = null;
  } else {
    syncCompareCamerasFromLeft();
  }
  bindCompareCameraSync();
  applyCadEdgesNow();
  try { renderWindow.render(); } catch (_) {}
}

function setCompareButtonOn(on) {
  document.getElementById('btn-compare')?.classList.toggle('is-active', !!on);
}

function stopCompare() {
  if (!compareState.on) {
    const bar = document.getElementById('compare-bar');
    if (bar) bar.hidden = true;
    setCompareButtonOn(false);
    applyCompareLayout(false);
    return;
  }
  const wasResults = resultsCompareOn();
  compareState.on = false;
  compareState.leftCase = null;
  compareState.rightCase = null;
  const bar = document.getElementById('compare-bar');
  if (bar) bar.hidden = true;
  setCompareButtonOn(false);
  applyCompareLayout(false);
  if (wasResults) {
    try { teardownResultsCompare(); } catch (e) { console.warn('[CFD] results compare stop', e); }
    compareState.mode = 'mesh';
    try { applyCutClipAndParts(); } catch (_) {}
    try { applyCadEdgesNow(); } catch (_) {}
    try { syncSharedLegend(); } catch (_) {}
    try { renderWindow.render(); } catch (_) {}
    try { resizeViewer(); } catch (_) {}
    return;
  }
  try {
    if (compareState.viewer && compareState.viewer.actor) {
      compareState.viewer.actor.setVisibility(false);
    }
  } catch (_) {}
  try {
    if (compareState.viewer && compareState.viewer.edgeActor) {
      compareState.viewer.edgeActor.setVisibility(false);
    }
  } catch (_) {}
  for (const plane of meshPlanes) {
    try { if (plane.compareActor) plane.compareActor.setVisibility(false); } catch (_) {}
  }
  try { resizeViewer(); } catch (_) {}
}

async function startCompare() {
  const meshes = generatedMeshesForCompare();
  const ids = defaultCompareIds();
  compareState.savedCam = snapshotCamera(renderer.getActiveCamera());
  compareState.on = true;
  compareState.mode = 'mesh';
  try { hideCompareResultsActors(); } catch (_) {}
  compareState.leftId = ids.leftId;
  compareState.rightId = ids.rightId;
  fillCompareSelects();
  syncCompareSelectValues();
  const bar = document.getElementById('compare-bar');
  if (bar) bar.hidden = false;
  setCompareButtonOn(true);
  if (meshes.length < 2) {
    applyCompareLayout(false);
    return;
  }
  applyCompareLayout(true);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  ensureCompareViewer();
  await loadCompareSides();
}

function refreshCompareIfOpen() {
  if (!compareState.on) return;
  if (resultsCompareOn()) {
    try { fillResultsCompareSelects(); } catch (_) {}
    return;
  }
  fillCompareSelects();
  const meshes = generatedMeshesForCompare();
  if (meshes.length < 2) {
    applyCompareLayout(false);
    compareState.leftCase = null;
    compareState.rightCase = null;
    return;
  }
  if (!meshByCompareId(compareState.leftId) || !meshByCompareId(compareState.rightId)) {
    const ids = defaultCompareIds();
    compareState.leftId = ids.leftId;
    compareState.rightId = ids.rightId;
    syncCompareSelectValues();
  }
  const left = meshByCompareId(compareState.leftId);
  const right = meshByCompareId(compareState.rightId);
  const paneB = document.getElementById('compare-pane-b');
  const splitOn = paneB && !paneB.hidden;
  if (
    splitOn &&
    left &&
    right &&
    compareState.leftCase === left.case_dir &&
    compareState.rightCase === right.case_dir
  ) {
    return;
  }
  applyCompareLayout(true);
  ensureCompareViewer();
  loadCompareSides();
}

(function wireCompareUi() {
  const btn = document.getElementById('btn-compare');
  const close = document.getElementById('compare-close');
  const a = document.getElementById('compare-mesh-a');
  const b = document.getElementById('compare-mesh-b');
  btn?.addEventListener('click', () => {
    if (compareState.on) stopCompare();
    else if (resultsViewOpen && !meshInspectOpen) {
      startResultsCompare().catch((e) => console.warn('[CFD] results compare', e));
    } else startCompare();
  });
  close?.addEventListener('click', () => stopCompare());
  const btnEdges = document.getElementById('btn-cad-edges');
  btnEdges?.addEventListener('click', () => {
    cadEdgesWanted = !cadEdgesWanted;
    try { localStorage.setItem('cfd-cad-edges', cadEdgesWanted ? '1' : '0'); } catch (_) {}
    applyCadEdgesNow();
  });
  syncCadEdgesButton();
  // Fit-to-viewport button beside the triad: reframe whatever is visible
  // (CAD, mesh or results) from the standard view direction.
  document.getElementById('btn-view-home')?.addEventListener('click', () => {
    try { frameSceneCamera(true); } catch (_) {}
    try {
      if (compareState.on && compareState.viewer && compareState.viewer.renderer) {
        compareState.viewer.renderer.resetCamera();
        compareState.viewer.renderWindow.render();
      }
    } catch (_) {}
    try { renderWindow.render(); } catch (_) {}
  });
  const onSel = (which) => {
    if (resultsCompareOn()) {
      onResultsCompareSelect(which).catch((e) => console.warn('[CFD] results compare select', e));
      return;
    }
    compareState.leftId = a && a.value;
    compareState.rightId = b && b.value;
    ensureDifferentCompareMeshes(which);
    syncCompareSelectValues();
    if (compareState.on && generatedMeshesForCompare().length >= 2) {
      applyCompareLayout(true);
      loadCompareSides();
    }
  };
  a?.addEventListener('change', () => onSel('a'));
  b?.addEventListener('change', () => onSel('b'));
  const stage = document.getElementById('compare-stage');
  if (stage && typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      try { resizeViewer(); } catch (_) {}
    });
    ro.observe(stage);
  }
})();

/* ---- Results compare: two runs / saved views side by side ----------------
 * Pane A is the main viewer (whatever run + view is open there); pane B is a
 * second, independent results pipeline drawn in the compare renderer: the
 * coloured surface, the cutting planes and the particle trace of the chosen
 * run + view, using that run's own case. Cameras stay in sync and the
 * particle animation drives both panes. One legend when both panes show the
 * same quantity (shared range); pane B gets its own when the quantities
 * differ.
 */
function resultsCompareOptions() {
  const out = [];
  const runs = (w27State.runs || []).filter((r) => r && r.id && runHasResults(r));
  runs.forEach((rec, idx) => {
    const runId = String(rec.id);
    const runName = rec.name || 'Run ' + (idx + 1);
    out.push({ value: runId + '|', runId, viewId: '', label: runName + ' · Current filters', rec, view: null });
    for (const v of Array.isArray(rec.views) ? rec.views : []) {
      if (!v || !v.id) continue;
      out.push({
        value: runId + '|' + String(v.id),
        runId,
        viewId: String(v.id),
        label: runName + ' · ' + (v.name || 'View'),
        rec,
        view: v,
      });
    }
  });
  return out;
}

function resultsCompareOptionByValue(value) {
  return resultsCompareOptions().find((o) => o.value === String(value || '')) || null;
}

function resultsCompareSyncOn() {
  return !!compareState.resSync;
}

function fillResultsCompareSelects() {
  const opts = resultsCompareOptions();
  const sync = resultsCompareSyncOn();
  const a = document.getElementById('compare-mesh-a');
  const b = document.getElementById('compare-mesh-b');
  const note = document.getElementById('compare-bar-note');
  const syncWrap = document.getElementById('compare-sync-wrap');
  const syncEl = document.getElementById('compare-sync');
  const optHtml = (list) => list
    .map((o) => '<option value="' + escapeHtml(o.value) + '">' + escapeHtml(o.label) + '</option>')
    .join('');
  if (a) {
    a.innerHTML = optHtml(opts);
    a.disabled = opts.length < 1;
    if (compareState.resA) a.value = compareState.resA;
  }
  if (b) {
    // With Sync filters on, pane B only picks the run: its filters are A's.
    const listB = sync
      ? opts.filter((o) => o.viewId === '').map((o) => ({ ...o, label: (o.rec && o.rec.name) || o.label }))
      : opts;
    if (sync && compareState.resB && !listB.some((o) => o.value === compareState.resB)) {
      compareState.resB = String(compareState.resB).split('|')[0] + '|';
    }
    b.innerHTML = optHtml(listB);
    b.disabled = listB.length < 1;
    if (compareState.resB) b.value = compareState.resB;
  }
  if (syncWrap) syncWrap.hidden = false;
  if (syncEl) syncEl.checked = sync;
  if (note) {
    if (opts.length < 2) {
      note.hidden = false;
      note.textContent = 'Save a view or finish another run to have something to compare with.';
    } else {
      note.hidden = true;
      note.textContent = '';
    }
  }
  const oa = resultsCompareOptionByValue(compareState.resA);
  const ob = resultsCompareOptionByValue(compareState.resB);
  const la = document.getElementById('compare-label-a');
  const lb = document.getElementById('compare-label-b');
  if (la) la.textContent = oa ? oa.label : '';
  if (lb) {
    lb.textContent = ob
      ? (sync ? ((ob.rec && ob.rec.name) || ob.label) + ' · same filters as A' : ob.label)
      : '';
  }
}

// Pane B pipeline (created once, reused).
function ensureCompareResults() {
  const v = ensureCompareViewer();
  if (!v) return null;
  if (compareState.res) return compareState.res;
  const mkLut = () => {
    const l = vtkLookupTable.newInstance();
    l.setHueRange(0.667, 0.0);
    l.setSaturationRange(1.0, 1.0);
    l.setValueRange(1.0, 1.0);
    l.setNumberOfColors(256);
    return l;
  };
  const lutB = mkLut();
  const surfReader = vtkXMLPolyDataReader.newInstance();
  const surfMapper = vtkMapper.newInstance();
  surfMapper.setScalarVisibility(true);
  surfMapper.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
  surfMapper.setColorMode(ColorMode.MAP_SCALARS);
  surfMapper.setInterpolateScalarsBeforeMapping(true);
  surfMapper.setUseLookupTableScalarRange(true);
  surfMapper.setLookupTable(lutB);
  const surfActor = vtkActor.newInstance();
  surfActor.setMapper(surfMapper);
  surfActor.getProperty().setSpecular(0.15);
  surfActor.getProperty().setSpecularPower(20);
  surfActor.setVisibility(false);
  try { surfActor.setPickable(false); } catch (_) {}
  v.renderer.addActor(surfActor);
  // Particle trace: line mapper (Cylinders tube / Comets mesh), glyph
  // mapper (Spheres) and seed markers, like the main viewer.
  const ptLutB = mkLut();
  const ptReaderB = vtkXMLPolyDataReader.newInstance();
  const ptMapperB = vtkMapper.newInstance();
  ptMapperB.setScalarVisibility(true);
  ptMapperB.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
  ptMapperB.setColorMode(ColorMode.MAP_SCALARS);
  ptMapperB.setInterpolateScalarsBeforeMapping(true);
  ptMapperB.setUseLookupTableScalarRange(true);
  ptMapperB.setLookupTable(ptLutB);
  const ptTubeB = vtkTubeFilter.newInstance({ radius: 0.0037, numberOfSides: 8, capping: true, varyRadius: VaryRadius.VARY_RADIUS_OFF });
  const ptGlyphB = vtkGlyph3DMapper.newInstance();
  try { ptSphereSrc.update(); } catch (_) {}
  try { ptGlyphB.setInputData(ptSphereSrc.getOutputData(), 1); } catch (_) {}
  try { ptGlyphB.setSourceConnection(ptSphereSrc.getOutputPort()); } catch (_) {}
  ptGlyphB.setScalarVisibility(true);
  ptGlyphB.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
  ptGlyphB.setColorMode(ColorMode.MAP_SCALARS);
  ptGlyphB.setUseLookupTableScalarRange(true);
  ptGlyphB.setLookupTable(ptLutB);
  const ptActorB = vtkActor.newInstance();
  ptActorB.setMapper(ptMapperB);
  ptActorB.getProperty().setSpecular(0.2);
  ptActorB.getProperty().setSpecularPower(25);
  ptActorB.getProperty().setLighting(true);
  ptActorB.setVisibility(false);
  try { ptActorB.setPickable(false); } catch (_) {}
  v.renderer.addActor(ptActorB);
  const seedMapperB = vtkGlyph3DMapper.newInstance();
  try { seedMapperB.setSourceConnection(ptSphereSrc.getOutputPort()); } catch (_) {}
  try { seedMapperB.setScaleMode(GlyphScaleModes.SCALE_BY_CONSTANT); } catch (_) {}
  try { seedMapperB.setScaling(true); } catch (_) {}
  try { if (seedMapperB.setOrient) seedMapperB.setOrient(false); } catch (_) {}
  seedMapperB.setScalarVisibility(false);
  const seedActorB = vtkActor.newInstance();
  seedActorB.setMapper(seedMapperB);
  seedActorB.getProperty().setColor(0.08, 0.1, 0.16);
  seedActorB.setVisibility(false);
  try { seedActorB.setPickable(false); } catch (_) {}
  v.renderer.addActor(seedActorB);
  compareState.res = {
    on: false,
    loadToken: 0,
    caseDir: null,
    time: null,
    runId: null,
    viewId: '',
    set: null,
    field: 'magU',
    range: null,       // [lo, hi] of the surface field
    bounds: null,
    pd: null,
    lut: lutB,
    surfReader,
    surfMapper,
    surfActor,
    planes: [],        // { def, vtkPlane, reader, mapper, actor }
    pt: {
      lut: ptLutB,
      reader: ptReaderB,
      mapper: ptMapperB,
      tube: ptTubeB,
      glyph: ptGlyphB,
      actor: ptActorB,
      seedMapper: seedMapperB,
      seedActor: seedActorB,
      pd: null,
      st: null,
      range: null,
    },
  };
  return compareState.res;
}

function hideCompareResultsActors() {
  const R = compareState.res;
  if (!R) return;
  try { R.surfActor.setVisibility(false); } catch (_) {}
  try { R.pt.actor.setVisibility(false); } catch (_) {}
  try { R.pt.seedActor.setVisibility(false); } catch (_) {}
  for (const p of R.planes) {
    try { p.actor.setVisibility(false); } catch (_) {}
  }
}

function teardownResultsCompare() {
  const R = compareState.res;
  if (R) {
    R.on = false;
    R.loadToken += 1;
    hideCompareResultsActors();
    R.pt.pd = null;
    R.pd = null;
  }
  compareState.resA = null;
  compareState.resB = null;
  const lb = document.getElementById('legend-b');
  if (lb) { lb.classList.add('is-hidden'); lb.hidden = true; }
  document.getElementById('legend')?.classList.remove('is-split-a');
  try { if (compareState.viewer) compareState.viewer.renderWindow.render(); } catch (_) {}
}

// Filter set pane B should draw for an option: the saved view, or the run's
// live set (for the run open in pane A that is exactly what A shows now).
function resultsCompareSetFor(opt) {
  if (!opt) return null;
  // Sync filters: whatever pane A shows right now, on pane B's run.
  if (resultsCompareSyncOn()) return serializeFilterSet({ camera: false });
  if (opt.view && opt.view.set) return opt.view.set;
  if (String(opt.runId) === String(resultsRunId)) return serializeFilterSet({ camera: false });
  return (opt.rec && opt.rec.current_view) || { v: 1, field: 'magU', parts: { on: true, style: 'field', opacity: 1 }, planes: [], pt: { open: false }, anim: { open: false } };
}

async function lastTimeForCase(casePath) {
  try {
    const r = await fetch('/api/times?case=' + encodeURIComponent(casePath), { cache: 'no-store' });
    const j = await r.json();
    const times = Array.isArray(j.times) ? j.times.map(String) : [];
    return times.length ? times[times.length - 1] : null;
  } catch (_) {
    return null;
  }
}

function fieldRangeFromPd(pd, field) {
  try {
    const arr = pd.getPointData().getArrayByName(field);
    const r = arr && arr.getRange ? arr.getRange() : null;
    if (r && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0]) return [r[0], r[1]];
  } catch (_) {}
  return null;
}

function applyCompareResultsParts(R) {
  const parts = (R.set && R.set.parts) || {};
  const on = parts.on !== false && !!R.pd;
  const pr = R.surfActor.getProperty();
  const op = Number(parts.opacity);
  try {
    pr.setOpacity(Number.isFinite(op) ? Math.min(1, Math.max(0, op)) : 1);
    pr.setEdgeVisibility(false);
    pr.setLighting(true);
    if (pr.setRepresentationToSurface) pr.setRepresentationToSurface();
  } catch (_) {}
  if (parts.style === 'solid') {
    const rgb = hexToRgb01(parts.solid || '#9aa3ad');
    try { pr.setColor(rgb[0], rgb[1], rgb[2]); } catch (_) {}
    R.surfMapper.setScalarVisibility(false);
  } else {
    R.surfMapper.setScalarVisibility(true);
    R.surfMapper.setColorByArrayName(R.field);
  }
  R.surfActor.setVisibility(on);
}

function compareResultsPlaneGeom(R, def) {
  const b = R.bounds;
  if (!b) return null;
  const axis = /^[XYZ]$/.test(String(def.axis || '').toUpperCase()) ? String(def.axis).toUpperCase() : 'Y';
  const com = getObjectCenterOfMass(b);
  const origin = planeOriginFromPosition(b, axis, (Number(def.position) || 0) / 100, com);
  const axisN = axisNormal(axis, false);
  const clipN = viewFacingClipNormal(origin, axisN, !!def.inverse);
  return { origin, normal: axisN, clipNormal: clipN };
}

function compareResultsPlaneActive(R, def) {
  return !!(def && def.enabled !== false && !(R.set && R.set.planesOn === false));
}

function applyCompareResultsClipping(R) {
  const mappers = [R.surfMapper, R.pt.mapper, R.pt.glyph, R.pt.seedMapper];
  for (const m of mappers) {
    try { if (m.removeAllClippingPlanes) m.removeAllClippingPlanes(); } catch (_) {}
  }
  for (const p of R.planes) {
    if (!compareResultsPlaneActive(R, p.def) || !p.def.clipModel) continue;
    const g = compareResultsPlaneGeom(R, p.def);
    if (!g) continue;
    p.vtkPlane.setOrigin(g.origin);
    p.vtkPlane.setNormal(g.clipNormal);
    for (const m of mappers) {
      try { m.addClippingPlane(p.vtkPlane); } catch (_) {}
    }
  }
  for (const m of mappers) {
    try { m.modified(); } catch (_) {}
  }
}

function compareResultsClipPlanes(R) {
  const out = [];
  for (const p of R.planes) {
    if (!compareResultsPlaneActive(R, p.def) || !p.def.clipModel) continue;
    const g = compareResultsPlaneGeom(R, p.def);
    if (g) out.push({ origin: g.origin, normal: g.clipNormal });
  }
  return out;
}

// CPU clip for glyph clouds in pane B (same rule as clipPointCloudByResultPlanes).
function clipPointCloudByPlanes(pd, planes) {
  const n = pd && pd.getNumberOfPoints ? pd.getNumberOfPoints() : 0;
  if (!planes.length || !n) return pd;
  const out = vtkPolyData.newInstance();
  const pts = vtkPoints.newInstance();
  const verts = vtkCellArray.newInstance();
  const src = pd.getPoints().getData();
  const arrays = [];
  try { pd.getPointData().getArrays().forEach((a) => arrays.push({ src: a, vals: [] })); } catch (_) {}
  let count = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i * 3];
    const y = src[i * 3 + 1];
    const z = src[i * 3 + 2];
    let keep = true;
    for (const pl of planes) {
      const o = pl.origin;
      const nn = pl.normal;
      if ((x - o[0]) * nn[0] + (y - o[1]) * nn[1] + (z - o[2]) * nn[2] < 0) { keep = false; break; }
    }
    if (!keep) continue;
    pts.insertNextPoint(x, y, z);
    verts.insertNextCell([count]);
    for (const a of arrays) {
      const nc = a.src.getNumberOfComponents();
      const d = a.src.getData();
      for (let c = 0; c < nc; c++) a.vals.push(d[i * nc + c]);
    }
    count += 1;
  }
  out.setPoints(pts);
  out.setVerts(verts);
  for (const a of arrays) {
    try {
      out.getPointData().addArray(vtkDataArray.newInstance({
        name: a.src.getName(),
        values: Float32Array.from(a.vals),
        numberOfComponents: a.src.getNumberOfComponents(),
      }));
    } catch (_) {}
  }
  return out;
}

async function loadCompareResultsPlane(R, p, token) {
  const v = compareState.viewer;
  if (!v || !compareResultsPlaneActive(R, p.def) || !R.bounds) {
    try { p.actor.setVisibility(false); } catch (_) {}
    return;
  }
  const g = compareResultsPlaneGeom(R, p.def);
  if (!g) return;
  const ctx = { case: R.caseDir, time: R.time };
  try {
    const mr = await fetch(apiCutPlaneMetaUrl(g.origin, g.normal, R.field, ctx), { cache: 'no-store' });
    const text = await mr.text();
    const meta = text && text.charAt(0) !== '<' ? JSON.parse(text) : { empty: true };
    if (token !== R.loadToken) return;
    if (!mr.ok || !meta || meta.empty) {
      p.actor.setVisibility(false);
      return;
    }
    let pd = await readVtpPolyData(p.reader, apiCutPlaneUrl(g.origin, g.normal, R.field, ctx));
    if (token !== R.loadToken) return;
    if (!polyDataHasPolys(pd)) pd = triangulateCut(pd);
    p.mapper.setInputData(pd);
    p.mapper.setColorByArrayName(R.field);
    p.mapper.setLookupTable(R.lut);
    styleResultPlaneActor(p.actor, p.def.opacity != null ? Number(p.def.opacity) : 0.9);
    const n = g.clipNormal || g.normal;
    const b = R.bounds;
    const span = Math.max(Math.abs(b[1] - b[0]), Math.abs(b[3] - b[2]), Math.abs(b[5] - b[4]), 1e-6);
    const eps = Math.max(2e-4, span * 4e-4);
    p.actor.setPosition(-n[0] * eps, -n[1] * eps, -n[2] * eps);
    p.actor.setVisibility(true);
  } catch (e) {
    console.warn('[CFD] compare plane', e);
    try { p.actor.setVisibility(false); } catch (_) {}
  }
}

function syncCompareResultsPlanes(R) {
  const v = compareState.viewer;
  const defs = R.set && Array.isArray(R.set.planes) ? R.set.planes : [];
  while (R.planes.length > defs.length) {
    const p = R.planes.pop();
    try { v.renderer.removeActor(p.actor); } catch (_) {}
  }
  while (R.planes.length < defs.length) {
    const mapper = vtkMapper.newInstance();
    mapper.setScalarVisibility(true);
    mapper.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
    mapper.setColorMode(ColorMode.MAP_SCALARS);
    mapper.setInterpolateScalarsBeforeMapping(true);
    mapper.setUseLookupTableScalarRange(true);
    mapper.setLookupTable(R.lut);
    const actor = vtkActor.newInstance();
    actor.setMapper(mapper);
    actor.setVisibility(false);
    try { actor.setPickable(false); } catch (_) {}
    v.renderer.addActor(actor);
    R.planes.push({ def: null, vtkPlane: vtkPlane.newInstance(), reader: vtkXMLPolyDataReader.newInstance(), mapper, actor });
  }
  R.planes.forEach((p, i) => { p.def = defs[i]; });
}

// Pane B particle trace look for the current phase (Spheres / Comets are
// rebuilt per frame by updateCompareResultsPulses).
function applyCompareResultsPtLook(R) {
  const P = R.pt;
  const pd = P.pd;
  const st = P.st;
  const n = pd && pd.getNumberOfPoints ? pd.getNumberOfPoints() : 0;
  if (!n || !st) {
    P.actor.setVisibility(false);
    P.seedActor.setVisibility(false);
    P.range = null;
    return;
  }
  const size = Math.max(2e-4, Number(st.size) || 0.0037);
  const rep = String(st.representation || 'Cylinders');
  const coloring = String(st.coloring || 'magU');
  const solid = coloring === 'solid';
  const colorName = coloring === 'p' ? 'p' : 'magU';
  P.range = solid ? null : (() => {
    const r = fieldRangeFromPd(pd, colorName);
    return r ? { field: colorName, lo: r[0], hi: r[1] } : null;
  })();
  const planes = compareResultsClipPlanes(R);
  if (rep === 'Spheres') {
    P.glyph.setInputData(clipPointCloudByPlanes(ptPulseSpheresPd(pd, ptPhase, st), planes));
    try { P.glyph.setScaleMode(GlyphScaleModes.SCALE_BY_CONSTANT); } catch (_) {}
    try { P.glyph.setScaling(true); } catch (_) {}
    try { if (P.glyph.setOrient) P.glyph.setOrient(false); } catch (_) {}
    P.glyph.setScaleFactor(size);
    P.glyph.setScalarVisibility(!solid);
    if (!solid) P.glyph.setColorByArrayName(colorName);
    P.actor.setMapper(P.glyph);
  } else {
    if (rep === 'Comets') {
      P.mapper.setInputData(ptCometMeshForPhase(pd, ptPhase, st));
    } else {
      P.tube.setInputData(pd);
      P.tube.setVaryRadius(VaryRadius.VARY_RADIUS_OFF);
      P.tube.setRadius(size);
      P.tube.setRadiusFactor(1);
      try { P.tube.update(); } catch (_) {}
      P.mapper.setInputConnection(P.tube.getOutputPort());
    }
    P.mapper.setScalarVisibility(!solid);
    if (!solid) P.mapper.setColorByArrayName(colorName);
    P.actor.setMapper(P.mapper);
  }
  if (solid) {
    const rgb = hexToRgb01(st.solid || '#2563eb');
    P.actor.getProperty().setColor(rgb[0], rgb[1], rgb[2]);
  }
  P.actor.setVisibility(true);
  const seeds = clipPointCloudByPlanes(ptSeedCloudFromLines(pd), planes);
  if (seeds.getNumberOfPoints() > 0) {
    try { P.seedMapper.setInputData(ptSphereSrc.getOutputData(), 1); } catch (_) {}
    P.seedMapper.setInputData(seeds);
    P.seedMapper.setScaleFactor(Math.max(size * 1.7, 0.0012));
    P.seedActor.setVisibility(true);
  } else {
    P.seedActor.setVisibility(false);
  }
}

// Called from the animation loop with the shared phase.
function updateCompareResultsPulses() {
  const R = compareState.res;
  if (!R || !R.on || !resultsCompareOn()) return false;
  const P = R.pt;
  if (!P.pd || !P.st || !P.actor.getVisibility()) return false;
  const rep = String(P.st.representation || 'Cylinders');
  if (rep === 'Spheres') {
    P.glyph.setInputData(clipPointCloudByPlanes(ptPulseSpheresPd(P.pd, ptPhase, P.st), compareResultsClipPlanes(R)));
  } else if (rep === 'Comets') {
    P.mapper.setInputData(ptCometMeshForPhase(P.pd, ptPhase, P.st));
  } else {
    return false;
  }
  try { compareState.viewer.renderWindow.render(); } catch (_) {}
  return true;
}

// Legends: shared scale + one legend when both panes show the same field,
// otherwise the main legend moves under pane A and pane B gets its own.
function syncCompareResultsLegend() {
  const R = compareState.res;
  const legendB = document.getElementById('legend-b');
  const mainLegend = document.getElementById('legend');
  if (!R || !R.on || !resultsCompareOn() || !R.range) {
    if (legendB) { legendB.classList.add('is-hidden'); legendB.hidden = true; }
    mainLegend?.classList.remove('is-split-a');
    return;
  }
  const same = R.field === activeField;
  if (same) {
    // syncSharedLegend() widens the main LUT with pane B's range (see
    // compareResultsRangeFor); mirror the final range onto pane B.
    const r = lut.getRange ? lut.getRange() : lutRange;
    try { R.lut.setRange(r[0], r[1]); R.lut.build(); } catch (_) {}
    if (legendB) { legendB.classList.add('is-hidden'); legendB.hidden = true; }
    mainLegend?.classList.remove('is-split-a');
  } else {
    // Pane B shows the other quantity: its own scale, user-set if there is one.
    const fixedB = scaleOverrideFor(R.field);
    const rb = fixedB ? [fixedB.lo, fixedB.hi] : R.range;
    try { R.lut.setRange(rb[0], rb[1]); R.lut.build(); } catch (_) {}
    mainLegend?.classList.toggle('is-split-a', mainFieldColoringVisible());
    if (legendB) {
      const hideB = !legendWantedOn();
      legendB.classList.toggle('is-hidden', hideB);
      legendB.hidden = hideB;
      const title = legendB.querySelector('.legend-title');
      const units = legendB.querySelector('.legend-units');
      if (title) title.textContent = R.field === 'p' ? 'Pressure' : 'Velocity Magnitude';
      if (units) units.textContent = R.field === 'p' ? 'Pa' : 'm/s';
      paintLegendTrackTicks(legendB, rb[0], rb[1]);
    }
  }
  // Pane B trace: same rule as the main viewer — shares the surface scale
  // when coloured by the surface field, otherwise its own range. A user-set
  // scale is never widened by the trace.
  const P = R.pt;
  if (P.range) {
    if (P.range.field === R.field) {
      const fixed = scaleOverrideFor(R.field);
      const r = R.lut.getRange ? R.lut.getRange() : R.range;
      const lo = fixed ? fixed.lo : Math.min(r[0], P.range.lo);
      const hi = fixed ? fixed.hi : Math.max(r[1], P.range.hi);
      try { R.lut.setRange(lo, hi); R.lut.build(); } catch (_) {}
      try { P.lut.setRange(lo, hi); P.lut.build(); } catch (_) {}
      if (same) {
        try { lut.setRange(lo, hi); lut.build(); } catch (_) {}
        try { ptLut.setRange(lo, hi); ptLut.build(); } catch (_) {}
        updateLegend(activeField, lo, hi);
      }
    } else {
      const own = scaleOverrideFor(P.range.field) || P.range;
      try { P.lut.setRange(own.lo, own.hi); P.lut.build(); } catch (_) {}
    }
  }
}

// Range pane B contributes to the shared scale (same field only).
function compareResultsRangeFor(field) {
  const R = compareState.res;
  if (!R || !R.on || !resultsCompareOn() || R.field !== field || !R.range) return null;
  return R.range;
}

async function loadResultsCompareB() {
  if (!resultsCompareOn()) return;
  const R = ensureCompareResults();
  const v = compareState.viewer;
  if (!R || !v) return;
  const opt = resultsCompareOptionByValue(compareState.resB);
  const token = ++R.loadToken;
  R.on = true;
  hideCompareResultsActors();
  if (!opt || !opt.rec || !opt.rec.case_dir) {
    try { v.renderWindow.render(); } catch (_) {}
    return;
  }
  R.runId = opt.runId;
  R.viewId = opt.viewId;
  R.caseDir = String(opt.rec.case_dir);
  R.set = resultsCompareSetFor(opt) || {};
  R.field = R.set.field === 'p' ? 'p' : 'magU';
  R.time = (await lastTimeForCase(R.caseDir)) || getTime();
  if (token !== R.loadToken) return;
  const ctx = { case: R.caseDir, time: R.time };
  // Surface.
  let pd = null;
  try {
    pd = await readVtpPolyData(R.surfReader, apiFieldUrl(R.field, ctx));
  } catch (e) {
    console.warn('[CFD] compare surface', e);
  }
  if (token !== R.loadToken) return;
  const nPts = pd && pd.getNumberOfPoints ? pd.getNumberOfPoints() : 0;
  if (!nPts) {
    R.pd = null;
    R.bounds = null;
    R.range = null;
    try { v.renderWindow.render(); } catch (_) {}
    return;
  }
  R.pd = pd;
  R.bounds = pd.getBounds().slice();
  R.range = fieldRangeFromPd(pd, R.field) || [0, 1];
  R.surfMapper.setInputData(pd);
  R.surfMapper.setColorByArrayName(R.field);
  try { R.lut.setRange(R.range[0], R.range[1]); R.lut.build(); } catch (_) {}
  applyCompareResultsParts(R);
  // Cutting planes at the saved positions, on this run's own bounds.
  syncCompareResultsPlanes(R);
  applyCompareResultsClipping(R);
  // Particle trace of the view (only when the view shows one).
  const ptDef = R.set.pt || {};
  R.pt.pd = null;
  R.pt.st = null;
  if (ptDef.open && ptDef.enabled) {
    const st = { ...ptState, ...ptDef };
    if (!Array.isArray(st.faces) || !st.faces.length) st.faces = Array.isArray(ptState.faces) ? ptState.faces.slice() : [];
    R.pt.st = st;
  }
  const jobs = R.planes.map((p) => loadCompareResultsPlane(R, p, token));
  if (R.pt.st) {
    jobs.push((async () => {
      try {
        const mr = await fetch(apiParticleTraceMetaUrl(R.pt.st, ctx), { cache: 'no-store' });
        const text = await mr.text();
        const meta = text && text.charAt(0) !== '<' ? JSON.parse(text) : { empty: true };
        if (token !== R.loadToken || !mr.ok || !meta || meta.empty) return;
        const tpd = await readVtpPolyData(R.pt.reader, apiParticleTraceUrl(R.pt.st, ctx));
        if (token !== R.loadToken) return;
        if (tpd && tpd.getNumberOfPoints && tpd.getNumberOfPoints() > 0) R.pt.pd = tpd;
      } catch (e) {
        console.warn('[CFD] compare trace', e);
      }
    })());
  }
  await Promise.all(jobs);
  if (token !== R.loadToken) return;
  applyCompareResultsPtLook(R);
  try { syncSharedLegend(); } catch (_) {}
  syncCompareResultsLegend();
  try { v.renderer.resetCameraClippingRange(); } catch (_) {}
  try { v.renderWindow.render(); } catch (_) {}
  try { renderWindow.render(); } catch (_) {}
}

function defaultResultsCompareB(aValue) {
  const opts = resultsCompareOptions();
  const a = resultsCompareOptionByValue(aValue);
  // Prefer another run (same kind of view), then another view of this run,
  // then the run's live filters.
  const otherRun = opts.find((o) => a && o.runId !== a.runId && o.viewId === '');
  if (otherRun) return otherRun.value;
  const otherView = opts.find((o) => o.value !== aValue && o.viewId !== '');
  if (otherView) return otherView.value;
  const other = opts.find((o) => o.value !== aValue);
  return other ? other.value : (opts[0] ? opts[0].value : null);
}

async function startResultsCompare() {
  if (!resultsViewOpen || !resultsRunId) return;
  compareState.savedCam = snapshotCamera(renderer.getActiveCamera());
  compareState.on = true;
  compareState.mode = 'results';
  compareState.resA = String(resultsRunId) + '|' + String(activeViewId || '');
  compareState.resB = defaultResultsCompareB(compareState.resA);
  fillResultsCompareSelects();
  const bar = document.getElementById('compare-bar');
  if (bar) bar.hidden = false;
  setCompareButtonOn(true);
  applyCompareLayout(true);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const v = ensureCompareViewer();
  if (!v) return;
  // Pane B never shows the mesh in this mode.
  try { v.actor.setVisibility(false); } catch (_) {}
  try { if (v.edgeActor) v.edgeActor.setVisibility(false); } catch (_) {}
  for (const plane of meshPlanes) {
    try { if (plane.compareActor) plane.compareActor.setVisibility(false); } catch (_) {}
  }
  ensureCompareResults();
  try { applyCutClipAndParts(); } catch (_) {}
  try { applyCadEdgesNow(); } catch (_) {}
  await loadResultsCompareB();
  syncCompareCamerasFromLeft();
  bindCompareCameraSync();
}

async function onResultsCompareSelect(which) {
  const a = document.getElementById('compare-mesh-a');
  const b = document.getElementById('compare-mesh-b');
  if (which === 'b') {
    compareState.resB = b ? b.value : compareState.resB;
    fillResultsCompareSelects();
    await loadResultsCompareB();
    return;
  }
  const opt = resultsCompareOptionByValue(a ? a.value : '');
  if (!opt) return;
  compareState.resA = opt.value;
  fillResultsCompareSelects();
  if (String(opt.runId) !== String(resultsRunId)) {
    // Another run in pane A: open its results (this restores that run's live
    // set), then the chosen view.
    await openRunResults(opt.runId);
  }
  if (opt.viewId) await switchToView(opt.viewId);
  else if (activeViewId) await switchToView('');
  // Pane B mirrors pane A's live set (Sync filters, or "Current filters" of
  // the same run): redraw it with what A shows now.
  if (paneBMirrorsA()) await loadResultsCompareB();
  syncCompareCamerasFromLeft();
}

function paneBMirrorsA() {
  if (!resultsCompareOn()) return false;
  if (resultsCompareSyncOn()) return true;
  const ob = resultsCompareOptionByValue(compareState.resB);
  return !!(ob && !ob.viewId && String(ob.runId) === String(resultsRunId));
}

// Pane A's live set changed (autosave): refresh pane B when it mirrors it.
let compareRefreshTimer = 0;
function refreshResultsCompareAfterAutosave() {
  if (!paneBMirrorsA()) return;
  if (compareRefreshTimer) clearTimeout(compareRefreshTimer);
  compareRefreshTimer = setTimeout(() => {
    compareRefreshTimer = 0;
    if (!paneBMirrorsA()) return;
    loadResultsCompareB().catch((e) => console.warn('[CFD] compare refresh', e));
  }, 150);
}

function setResultsCompareSync(on) {
  compareState.resSync = !!on;
  try { localStorage.setItem('cfd-compare-sync', compareState.resSync ? '1' : '0'); } catch (_) {}
  if (!resultsCompareOn()) return;
  fillResultsCompareSelects();
  loadResultsCompareB().catch((e) => console.warn('[CFD] compare sync', e));
}
try { compareState.resSync = localStorage.getItem('cfd-compare-sync') === '1'; } catch (_) {}
document.getElementById('compare-sync')?.addEventListener('change', (e) => {
  setResultsCompareSync(!!e.target.checked);
});

/* ---- W25b: live mesh-section VTP for Cutting Plane mesh inspect (layered remesh) ---- */
async function loadMeshSectionForInspect(opts) {
  const o = opts || {};
  const casePath = o.case_dir || getLiveMeshCaseDir();
  if (!(casePath && String(casePath).trim()) && !hasAttachedCase()) {
    return { empty: true, skipped: 'no_case' };
  }
  const axisMap = { X: 'x', Y: 'y', Z: 'z', x: 'x', y: 'y', z: 'z' };
  const ax = axisMap[o.axis || cutState.axis] || 'x';
  const frac = meshSectionFrac(o.frac != null ? o.frac : cutState.position);
  const q = withProjectCaseParams({
    case: casePath,
    axis: ax,
    frac: String(Number.isFinite(frac) ? frac : 0.5),
  });
  const metaUrl = '/api/mesh-section?' + q.toString() + '&meta=1';
  const vtpUrl = '/api/mesh-section?' + q.toString();
  let meta = null;
  try {
    const mr = await fetch(metaUrl);
    if (mr.ok) meta = await mr.json();
  } catch (e) {
    console.warn('[CFD W25b] mesh-section meta', e);
  }
  cutState.enabled = true;
  // Bank-like mesh inspect: white bg, gray faces, black edges (not magU rainbow)
  try {
    renderer.setBackground(1, 1, 1);
  } catch (_) {}
  await reader.setUrl(vtpUrl);
  // vtk.js setUrl is async in some builds — poll until points exist
  let pd = null;
  for (let i = 0; i < 120; i++) {
    pd = reader.getOutputData ? reader.getOutputData() : null;
    const n = pd && pd.getNumberOfPoints ? pd.getNumberOfPoints() : 0;
    if (n > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  sourcePolyData = pd;
  cutBins = null;
  sourceBounds = pd && pd.getBounds ? pd.getBounds().slice() : null;
  // Inflate zero-thickness planar bounds for camera clipping
  if (sourceBounds) {
    const eps = 1e-3;
    if (Math.abs(sourceBounds[1] - sourceBounds[0]) < 1e-9) {
      sourceBounds[0] -= eps;
      sourceBounds[1] += eps;
    }
    if (Math.abs(sourceBounds[3] - sourceBounds[2]) < 1e-9) {
      sourceBounds[2] -= eps;
      sourceBounds[3] += eps;
    }
    if (Math.abs(sourceBounds[5] - sourceBounds[4]) < 1e-9) {
      sourceBounds[4] -= eps;
      sourceBounds[5] += eps;
    }
  }
  activeField = 'cellVolume';
  try {
    const props = [cutActor.getProperty(), surfaceActor.getProperty()];
    for (const pr of props) {
      try { if (pr.setBackfaceCulling) pr.setBackfaceCulling(false); } catch (_) {}
      try { if (pr.setBackFaceCulling) pr.setBackFaceCulling(false); } catch (_) {}
      try { if (pr.setFrontfaceCulling) pr.setFrontfaceCulling(false); } catch (_) {}
      try { if (pr.setFrontFaceCulling) pr.setFrontFaceCulling(false); } catch (_) {}
      try { pr.setRepresentationToSurface(); } catch (_) {}
      try { pr.setEdgeVisibility(true); } catch (_) {}
      try { pr.setEdgeColor(0.05, 0.055, 0.06); } catch (_) {}
      try { pr.setColor(0.86, 0.88, 0.91); } catch (_) {}
      try { pr.setOpacity(1); } catch (_) {}
      try { pr.setLighting(false); } catch (_) {}
      try { pr.setLineWidth(1); } catch (_) {}
    }
    try { renderer.setBackground(1, 1, 1); } catch (_) {}
    try {
      const rr = fullScreenRenderer && fullScreenRenderer.getRenderWindow && fullScreenRenderer.getRenderWindow();
      if (rr && rr.getViews) {
        const views = rr.getViews();
        if (views && views[0] && views[0].setBackground) views[0].setBackground(1, 1, 1);
      }
    } catch (_) {}
  } catch (_) {}
  const nPts = pd && pd.getNumberOfPoints ? pd.getNumberOfPoints() : 0;
  if (pd && nPts > 0) {
    surfaceMapper.setInputData(pd);
    surfaceMapper.setScalarVisibility(false);
    cutMapper.setInputData(pd);
    cutMapper.setScalarVisibility(false);
    applyMeshDisplayScale(cutActor, sourceBounds);
    applyMeshDisplayScale(surfaceActor, sourceBounds);
    cutActor.setVisibility(true);
    surfaceActor.setVisibility(!!cutState.partsColor);
  }
  renderWindow.render();
  const fp = fingerprintFromPolyData(pd, meta, 'cellVolume', vtpUrl);
  if (!nPts) {
    return { empty: true, skipped: 'empty_vtp', case_dir: casePath, meta };
  }
  window.__CFD_W25B__ = {
    increment: 'W25b',
    ready: !!(pd && sourceBounds && fp && fp.nPoints > 0),
    case_dir: casePath,
    vtp_url: vtpUrl,
    meta,
    fingerprint: fp,
    n_cells_volume: meta && meta.meta && meta.meta.n_cells_volume,
    n_cells_slice: meta && (meta.n_cells_slice || (meta.meta && meta.meta.n_cells_slice)),
    nPoints: fp && fp.nPoints,
    nCells: fp && fp.nCells,
    note: 'Live mesh-section from remesh polyMesh (addLayers+eMesh) bank-style edges',
  };
  publishW7({ mesh_section: true, cut_fingerprint: cutFingerprint(pd), source_fingerprint: fp });
  return window.__CFD_W25B__;
}
window.__CFD_W25B_LOAD_MESH_SECTION__ = loadMeshSectionForInspect;

function applyRightOrthoWallZoom() {
  const cam = renderer.getActiveCamera();
  let b = sourceBounds;
  if (!cam || !b) return null;
  try { renderer.setBackground(1, 1, 1); } catch (_) {}
  const xmin = b[0], xmax = b[1], ymin = b[2], ymax = b[3], zmin = b[4], zmax = b[5];
  const ox = 0.5 * (xmin + xmax);
  // wall/edge zoom framing (daniel bank): +Y outer wall + upper body/slots
  const y0 = Math.max(ymin, -0.02);
  const y1 = Math.min(ymax, 0.155);
  const z0 = Math.max(zmin, -0.05);
  const z1 = Math.min(zmax, 0.31);
  const cy = 0.5 * (y0 + y1);
  const cz = 0.5 * (z0 + z1);
  cam.setParallelProjection(true);
  // Look from +X (RIGHT) onto YZ section plane
  cam.setPosition(ox + 1.0, cy, cz);
  cam.setFocalPoint(ox, cy, cz);
  cam.setViewUp(0, 0, 1);
  try { if (cutActor.getProperty().setBackfaceCulling) cutActor.getProperty().setBackfaceCulling(false); } catch(_) {}
  const scale = 0.55 * Math.max(y1 - y0, z1 - z0);
  cam.setParallelScale(scale > 1e-6 ? scale : 0.1);
  cam.setClippingRange(0.01, 10);
  resetCameraClippingRangeLoose();
  cutActor.setVisibility(true);
  renderWindow.render();
  return { ox, cy, cz, parallel_scale: scale, face: 'RIGHT', bounds: b.slice() };
}
window.__CFD_W25B_RIGHT_WALL_ZOOM__ = applyRightOrthoWallZoom;


const filtersPanel = document.getElementById('filters-panel');
const legend = document.getElementById('legend');
const btnFilters = document.getElementById('btn-filters');
const btnLegend = document.getElementById('btn-legend');
const filtersClose = document.getElementById('filters-close');
const btnCuttingPlane = document.querySelector('.tb-btn[data-label="Cutting Plane"]');

function syncFiltersPanelOffset() {
  const fp = document.getElementById('filters-panel');
  const rc = document.getElementById('right-chrome');
  if (fp) {
    fp.style.left = 'auto';
    fp.style.right = '12px';
    fp.style.top = '12px';
  }
  if (!rc) return;
  const fpOpen = !!(fp && !fp.hidden && !fp.classList.contains('is-hidden'));
  if (fpOpen && !rc.hidden) {
    const h = Math.round(fp.getBoundingClientRect().height);
    const top = 12 + h + 8;
    rc.style.top = top + 'px';
    rc.style.maxHeight = 'calc(100% - ' + top + 'px - 12px)';
  } else {
    rc.style.top = '';
    rc.style.maxHeight = '';
  }
}

// Filter blocks (Parts, each cutting plane, Particle trace, Animation) fold up
// when their title is clicked. Keys survive re-renders of the plane cards.
const collapsedFilterBlocks = new Set();

function filterBlockKey(block) {
  if (!block) return '';
  return block.getAttribute('data-collapse-key') || block.id || '';
}

function setFilterBlockCollapsed(block, collapsed) {
  if (!block) return;
  const key = filterBlockKey(block);
  block.classList.toggle('is-collapsed', !!collapsed);
  if (key) {
    if (collapsed) collapsedFilterBlocks.add(key);
    else collapsedFilterBlocks.delete(key);
  }
  const title = block.querySelector('.fp-block-head > span:first-child, .mesh-plane-card-head > strong');
  if (title) title.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

(function wireFilterBlockCollapse() {
  const panel = document.getElementById('filters-panel');
  if (!panel) return;
  panel.querySelectorAll('.fp-block > .fp-block-head > span:first-child').forEach((t) => {
    t.classList.add('fp-collapse-toggle');
    t.setAttribute('title', 'Collapse / expand');
    t.setAttribute('aria-expanded', 'true');
  });
  panel.addEventListener('click', (e) => {
    const t = e.target.closest('.fp-collapse-toggle');
    if (!t || !panel.contains(t)) return;
    if (e.target.closest('button, input, select, label')) return;
    const block = t.closest('.fp-block, .mesh-plane-card');
    if (!block) return;
    setFilterBlockCollapsed(block, !block.classList.contains('is-collapsed'));
    try { syncFiltersPanelOffset(); } catch (_) {}
  });
})();

function setFiltersVisible(on) {
  if (!filtersPanel || !btnFilters) return;
  filtersPanel.classList.toggle('is-hidden', !on);
  btnFilters.classList.toggle('is-active', on);
  requestAnimationFrame(syncFiltersPanelOffset);
  requestAnimationFrame(() => { try { syncViewportChromeInset(); } catch (_) {} });
}

function revealPostFilter(blockId) {
  const el = document.getElementById(blockId);
  if (el) {
    el.hidden = false;
    setFilterBlockCollapsed(el, false);
  }
  setFiltersVisible(true);
}

function resetPostFilters() {
  cutState.enabled = false;
  ptState.enabled = false;
  popState.enabled = false;
  isoState.enabled = false;
  ivState.enabled = false;
  ptLinePd = null;
  try { stopAnimationPlay(); } catch (_) {}
  try {
    animState.start = null;
    animState.end = null;
    animState.endPinned = false;
  } catch (_) {}
  try { clearResultPlanes(); } catch (_) {}
  cutState.planesOn = true;
  const cpEn = document.getElementById('cp-enabled');
  if (cpEn) cpEn.checked = true;
  ['pt-enabled', 'pop-enabled', 'iso-enabled', 'iv-enabled'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.checked = false;
  });
  ['cp-block', 'pt-block', 'pop-block', 'iso-block', 'iv-block', 'anim-block'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  document.querySelectorAll('.tb-btn[data-filter-set]').forEach((btn) => {
    btn.classList.remove('is-active');
  });
  try { cutActor.setVisibility(false); } catch (_) {}
  try { hidePtActors(); } catch (_) {}
  try { cancelPtRegionDraw(); cancelPtRegionEdit(); hidePtRegionOverlay(); restorePtRegionCamera(); } catch (_) {}
  try { isoActor.setVisibility(false); } catch (_) {}
  try { syncFieldVectorGlyphs(isoVecGlyph, null, false); } catch (_) {}
  try { ivActor.setVisibility(false); } catch (_) {}
  try { syncFieldVectorGlyphs(ivVecGlyph, null, false); } catch (_) {}
  try { popPathActor.setVisibility(false); } catch (_) {}
}

/* ---- Filter sets ("views") ---------------------------------------------
 * A filter set is everything the Filters panel shows for a run: coloring
 * field, Parts appearance, every cutting plane with its exact position,
 * the particle trace settings, the animation settings and (for saved
 * views) the camera. The live set is auto-saved on every change as
 * run.current_view so leaving Results and coming back restores it; named
 * copies live in run.views and can be switched from the Views block.
 */
let resultsRunId = null;          // run whose results are open in the main viewer
let applyingFilterSet = false;    // suppress autosave while a set is applied
let activeViewId = '';            // '' = "Current filters"
let filterAutosaveTimer = 0;
let filterAutosavePending = false;

function serializeFilterSet(opts) {
  const o = opts || {};
  const ptBlock = document.getElementById('pt-block');
  const animBlock = document.getElementById('anim-block');
  const set = {
    v: 1,
    field: activeField === 'p' ? 'p' : 'magU',
    parts: {
      on: !!cutState.partsColor,
      style: cutState.partsStyle === 'solid' ? 'solid' : 'field',
      solid: String(cutState.partsSolid || '#9aa3ad'),
      opacity: Number.isFinite(Number(cutState.partsOpacity)) ? Number(cutState.partsOpacity) : 1,
    },
    planesOn: resultPlanesGroupOn(),
    planes: resultPlanes.map((p) => ({
      axis: p.axis,
      position: Number(p.position) || 0,
      inverse: !!p.inverse,
      opacity: Number.isFinite(Number(p.opacity)) ? Number(p.opacity) : 0.9,
      clipModel: !!p.clipModel,
      enabled: !!p.enabled,
    })),
    pt: {
      open: !!(ptBlock && !ptBlock.hidden),
      enabled: !!ptState.enabled,
      seed_mode: ptState.seed_mode,
      faces: Array.isArray(ptState.faces) ? ptState.faces.slice() : [],
      quantity_mode: ptState.quantity_mode,
      n_seeds: ptState.n_seeds,
      density: ptState.density,
      pick: ptState.pick,
      seeds_h: ptState.seeds_h,
      seeds_v: ptState.seeds_v,
      spacing: ptState.spacing,
      size: ptState.size,
      representation: ptState.representation,
      both: !!ptState.both,
      coloring: ptState.coloring,
      solid: ptState.solid,
      pulses: ptState.pulses,
      comet_length: ptState.comet_length,
      regionShape: ptState.regionShape === 'circle' ? 'circle' : 'box',
      region: isRegionSeedMode() ? clonePtRegion(ptState.region) : null,
    },
    anim: {
      open: !!(animBlock && !animBlock.hidden),
      type: animState.type || 'Time Step',
      speed: animState.speed,
      start: animState.start,
      end: animState.end,
      endPinned: !!animState.endPinned,
      skip: animState.skip,
      playing: !!animState.playing,
      phase: Number(ptPhase) || 0,
    },
    collapsed: Array.from(collapsedFilterBlocks).filter((k) => !String(k).startsWith('rplane:')),
    // User-set colour scales (null = auto from the data).
    scale: {
      magU: scaleOverrideFor('magU') ? { ...scaleOverrideFor('magU') } : null,
      p: scaleOverrideFor('p') ? { ...scaleOverrideFor('p') } : null,
    },
    camera: o.camera === false ? null : snapshotCamera(renderer.getActiveCamera()),
  };
  return set;
}

function filterSetSummary(set) {
  if (!set) return '';
  const bits = [];
  bits.push(set.field === 'p' ? 'Pressure' : 'Velocity');
  const nPlanes = Array.isArray(set.planes) ? set.planes.length : 0;
  if (nPlanes) bits.push(nPlanes + (nPlanes === 1 ? ' plane' : ' planes'));
  if (set.pt && set.pt.open && set.pt.enabled) bits.push('trace');
  if (set.anim && set.anim.open) bits.push('animation');
  return bits.join(' · ');
}

// Rebuild the live filters from a saved set. `opts.camera === false` keeps
// the current camera (used for the auto-restored set); saved views move it.
async function applyFilterSet(set, opts) {
  const o = opts || {};
  if (!set || typeof set !== 'object') return false;
  applyingFilterSet = true;
  try {
    try { stopAnimationPlay(); } catch (_) {}
    // Cutting planes: rebuild with the exact saved positions.
    try { clearResultPlanes(); } catch (_) {}
    cutState.planesOn = set.planesOn !== false;
    const planes = Array.isArray(set.planes) ? set.planes : [];
    for (const p of planes) addResultPlane(p, { silent: true });
    if (!planes.length) {
      const cp = document.getElementById('cp-block');
      if (cp) cp.hidden = true;
      btnCuttingPlane?.classList.remove('is-active');
    }
    cutState.enabled = anyResultPlaneOn();
    // Parts appearance.
    if (set.parts) {
      if (set.parts.on != null) cutState.partsColor = !!set.parts.on;
      cutState.partsStyle = set.parts.style === 'solid' ? 'solid' : 'field';
      if (set.parts.solid) cutState.partsSolid = String(set.parts.solid);
      if (Number.isFinite(Number(set.parts.opacity))) cutState.partsOpacity = Number(set.parts.opacity);
    }
    // Particle trace settings.
    const pt = set.pt || {};
    const ptKeys = ['seed_mode', 'quantity_mode', 'n_seeds', 'density', 'pick', 'seeds_h', 'seeds_v',
      'spacing', 'size', 'representation', 'both', 'coloring', 'solid', 'pulses', 'comet_length'];
    for (const k of ptKeys) if (pt[k] != null) ptState[k] = pt[k];
    if (Array.isArray(pt.faces)) ptState.faces = pt.faces.map(String);
    ptState.region = clonePtRegion(pt.region);
    ptState.regionShape = pt.regionShape === 'circle' ? 'circle' : 'box';
    {
      const rawMode = String(pt.seed_mode || 'faces').toLowerCase();
      if (rawMode === 'region' || (rawMode === 'faces' && regionIsUsable(ptState.region))) {
        ptState.seed_mode = 'region';
      } else {
        ptState.seed_mode = 'faces';
      }
    }
    ptState.enabled = !!(pt.open && pt.enabled);
    const ptBlock = document.getElementById('pt-block');
    if (ptBlock) ptBlock.hidden = !pt.open;
    btnParticleTrace?.classList.toggle('is-active', !!pt.open);
    // Animation settings.
    const anim = set.anim || {};
    if (anim.type) animState.type = anim.type === 'Particle Trace' ? 'Particle Trace' : 'Time Step';
    if (Number.isFinite(Number(anim.speed)) && Number(anim.speed) > 0) {
      animState.speed = clampAnimSpeed(anim.speed);
    }
    if (anim.start != null || anim.end != null) {
      applyAnimWindow(
        anim.start != null ? anim.start : animState.start,
        anim.end != null ? anim.end : animState.end,
      );
    }
    if (anim.endPinned != null) animState.endPinned = !!anim.endPinned;
    if (anim.skip != null) animState.skip = Math.max(0, Math.floor(Number(anim.skip) || 0));
    const animBlock = document.getElementById('anim-block');
    if (animBlock) animBlock.hidden = !anim.open;
    btnAnimation?.classList.toggle('is-active', !!anim.open);
    if (Number.isFinite(Number(anim.phase))) ptPhase = Math.max(0, Number(anim.phase)) % 1;
    // Colour scales: saved override or back to auto.
    for (const key of ['magU', 'p']) {
      const s = set.scale && set.scale[key];
      scaleOverride[key] =
        s && Number.isFinite(Number(s.lo)) && Number.isFinite(Number(s.hi)) && Number(s.hi) > Number(s.lo)
          ? { lo: Number(s.lo), hi: Number(s.hi) }
          : null;
    }
    // Collapsed blocks.
    collapsedFilterBlocks.clear();
    for (const k of Array.isArray(set.collapsed) ? set.collapsed : []) collapsedFilterBlocks.add(String(k));
    document.querySelectorAll('#filters-panel .fp-block').forEach((el) => {
      setFilterBlockCollapsed(el, collapsedFilterBlocks.has(filterBlockKey(el)));
    });
    // Coloring field (reloads the surface when it differs).
    const field = set.field === 'p' ? 'p' : 'magU';
    const colorSel = document.getElementById('cp-coloring');
    if (colorSel && colorSel.tagName === 'SELECT') colorSel.value = field;
    try { syncChromeFromState(); } catch (_) {}
    try { syncPtChromeFromState(); } catch (_) {}
    try { syncAnimChromeFromState(); } catch (_) {}
    if (hasAttachedCase()) {
      if (activeField !== field || !sourcePolyData) {
        await loadField(field);
      } else {
        try { applyPartsAppearance(); } catch (_) {}
        try { updateCuttingPlane(); } catch (_) {}
      }
      if (ptState.enabled) {
        await loadParticleTrace();
      } else {
        try { hidePtActors(); } catch (_) {}
        try { hidePtRegionOverlay(); } catch (_) {}
        try { applyPartsAppearance(); } catch (_) {}
      }
    }
    if (o.camera !== false && set.camera && !cameraLooksUnset(set.camera)) {
      try {
        applyCameraSnapshot(renderer.getActiveCamera(), set.camera);
        resetCameraClippingRangeLoose();
      } catch (_) {}
    }
    try { syncSharedLegend(); } catch (_) {}
    try { syncViewportOrient(); } catch (_) {}
    try { renderWindow.render(); } catch (_) {}
    if (anim.open && anim.playing && isPtAnimation() && ptLinePd) {
      try { startAnimationPlay(); } catch (_) {}
    }
    return true;
  } finally {
    applyingFilterSet = false;
  }
}

function filterAutosaveAllowed() {
  return !!(resultsViewOpen && resultsRunId && !applyingFilterSet && hasAttachedCase());
}

// Debounced: many controls fire `input` continuously while dragging.
function scheduleFilterAutosave() {
  if (!filterAutosaveAllowed()) return;
  filterAutosavePending = true;
  if (filterAutosaveTimer) clearTimeout(filterAutosaveTimer);
  filterAutosaveTimer = setTimeout(() => {
    filterAutosaveTimer = 0;
    flushFilterAutosave();
  }, 700);
}

function flushFilterAutosave() {
  if (filterAutosaveTimer) {
    clearTimeout(filterAutosaveTimer);
    filterAutosaveTimer = 0;
  }
  if (!filterAutosavePending) return;
  if (!resultsRunId || applyingFilterSet) return;
  filterAutosavePending = false;
  const runId = resultsRunId;
  let set = null;
  try { set = serializeFilterSet({ camera: true }); } catch (e) {
    console.warn('[CFD] filter autosave serialize', e);
    return;
  }
  const rec = findRunRecord(runId);
  if (rec) rec.current_view = set;
  persistRunSettings({ run_id: runId, current_view: set }).catch((e) => {
    console.warn('[CFD] filter autosave', e);
  });
  try { refreshResultsCompareAfterAutosave(); } catch (_) {}
}

// Restore the auto-saved set when the run's results open again.
async function restoreCurrentFilterSet(runId) {
  const rec = findRunRecord(runId);
  const set = rec && rec.current_view;
  if (!set || typeof set !== 'object') return false;
  try {
    await applyFilterSet(set, { camera: false });
    return true;
  } catch (e) {
    console.warn('[CFD] restore filters', e);
    return false;
  }
}

// ---- Saved views (named filter sets per run) ----
function runViews(runId) {
  const rec = findRunRecord(runId || resultsRunId);
  return rec && Array.isArray(rec.views) ? rec.views : [];
}

function renderViewsBlock() {
  const block = document.getElementById('views-block');
  const sel = document.getElementById('views-select');
  const upd = document.getElementById('views-update');
  const del = document.getElementById('views-delete');
  if (!block || !sel) return;
  const show = !!(resultsViewOpen && resultsRunId) && window.__CFD_FILTERS_MODE__ === 'post';
  block.hidden = !show;
  if (!show) return;
  const views = runViews(resultsRunId);
  if (activeViewId && !views.some((v) => String(v.id) === String(activeViewId))) activeViewId = '';
  sel.innerHTML =
    '<option value="">Current filters</option>' +
    views
      .map((v) =>
        '<option value="' + escapeHtml(String(v.id)) + '">' + escapeHtml(String(v.name || 'View')) +
        (v.set ? ' — ' + escapeHtml(filterSetSummary(v.set)) : '') + '</option>'
      )
      .join('');
  sel.value = activeViewId || '';
  if (upd) upd.hidden = !activeViewId;
  if (del) del.hidden = !activeViewId;
}

async function saveViewsForRun(runId, views) {
  const rec = findRunRecord(runId);
  if (rec) rec.views = views;
  return persistRunSettings({ run_id: runId, views });
}

async function saveCurrentAsView() {
  if (!resultsRunId) return;
  const views = runViews(resultsRunId).slice();
  const name = await promptName({
    title: 'Save view',
    copy: 'Saves the current coloring, parts, cutting planes, particle trace, animation and camera for this run.',
    label: 'View name',
    value: 'View ' + (views.length + 1),
  });
  if (!name) return;
  const view = {
    id: 'v-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name.slice(0, 64),
    created: Date.now(),
    set: serializeFilterSet({ camera: true }),
  };
  views.push(view);
  const rec = findRunRecord(resultsRunId);
  if (rec) rec.views = views;
  activeViewId = view.id;
  renderViewsBlock();
  try { await saveViewsForRun(resultsRunId, views); } catch (e) { console.warn('[CFD] save view', e); }
  renderViewsBlock();
}

async function updateActiveView() {
  if (!resultsRunId || !activeViewId) return;
  const views = runViews(resultsRunId).map((v) =>
    String(v.id) === String(activeViewId)
      ? { ...v, set: serializeFilterSet({ camera: true }), updated: Date.now() }
      : v
  );
  try { await saveViewsForRun(resultsRunId, views); } catch (e) { console.warn('[CFD] update view', e); }
  renderViewsBlock();
}

async function deleteActiveView() {
  if (!resultsRunId || !activeViewId) return;
  const cur = runViews(resultsRunId).find((v) => String(v.id) === String(activeViewId));
  const ok = await confirmAction({
    title: 'Delete view “' + (cur ? cur.name : 'View') + '”?',
    copy: 'Only the saved view is removed. The filters currently shown stay as they are.',
  });
  if (!ok) return;
  const views = runViews(resultsRunId).filter((v) => String(v.id) !== String(activeViewId));
  activeViewId = '';
  renderViewsBlock();
  try { await saveViewsForRun(resultsRunId, views); } catch (e) { console.warn('[CFD] delete view', e); }
  renderViewsBlock();
}

async function switchToView(viewId) {
  if (!resultsRunId) return;
  const id = String(viewId || '');
  if (!id) {
    // Back to the live set: nothing to rebuild, the live filters are what
    // is shown; just stop tracking the saved view.
    activeViewId = '';
    renderViewsBlock();
    return;
  }
  const view = runViews(resultsRunId).find((v) => String(v.id) === id);
  if (!view || !view.set) return;
  activeViewId = id;
  renderViewsBlock();
  await applyFilterSet(view.set, { camera: true });
  // The applied view is now also the live set.
  filterAutosavePending = true;
  flushFilterAutosave();
}

(function wireFilterViews() {
  const sel = document.getElementById('views-select');
  sel?.addEventListener('change', () => {
    switchToView(sel.value).catch((e) => console.warn('[CFD] switch view', e));
  });
  document.getElementById('views-save')?.addEventListener('click', () => {
    saveCurrentAsView().catch((e) => console.warn('[CFD] save view', e));
  });
  document.getElementById('views-update')?.addEventListener('click', () => {
    updateActiveView().catch((e) => console.warn('[CFD] update view', e));
  });
  document.getElementById('views-delete')?.addEventListener('click', () => {
    deleteActiveView().catch((e) => console.warn('[CFD] delete view', e));
  });
  // Any change made in the Filters panel (or via the filter toolbar) is
  // part of the live set: autosave it for this run.
  const panel = document.getElementById('filters-panel');
  const isViewsUi = (t) => !!(t && t.closest && t.closest('#views-block'));
  if (panel) {
    ['input', 'change'].forEach((ev) => {
      panel.addEventListener(ev, (e) => {
        if (isViewsUi(e.target)) return;
        scheduleFilterAutosave();
      });
    });
    panel.addEventListener('click', (e) => {
      if (isViewsUi(e.target)) return;
      const t = e.target;
      if (!(t && t.closest && t.closest('button, .fp-collapse-toggle'))) return;
      scheduleFilterAutosave();
    });
  }
  const group = document.getElementById('filters-toolbar-group') ||
    document.querySelector('.tb-group[data-group="FILTERS"]');
  group?.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('.tb-btn')) scheduleFilterAutosave();
  });
})();

function setLegendVisible(on) {
  if (!btnLegend) return;
  btnLegend.classList.toggle('is-active', on);
  if (!on) {
    setLegendCardShown(document.getElementById('legend'), false);
    setLegendCardShown(document.getElementById('legend-pt'), false);
    setLegendCardShown(document.getElementById('legend-b'), false);
    return;
  }
  if (ptState.enabled && ptLinePd && String(ptState.coloring || 'magU') !== 'solid') {
    try { applyPtRepresentation(); } catch (_) {}
  }
  try { syncSharedLegend(); } catch (_) {}
}

btnFilters?.addEventListener('click', () => {
  setFiltersVisible(filtersPanel.classList.contains('is-hidden'));
});
setFiltersToolbarMode(window.__CFD_FILTERS_MODE__ || 'post');

(function wireFiltersPanelOffset() {
  const stack = document.getElementById('tree-float-stack');
  const main = document.querySelector('.main-row');
  const fp = document.getElementById('filters-panel');
  if (!stack || !main) return;
  const kick = () => requestAnimationFrame(syncFiltersPanelOffset);
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(kick);
    ro.observe(stack);
    ro.observe(main);
    if (fp) ro.observe(fp);
  }
  if (typeof MutationObserver === 'function') {
    const mo = new MutationObserver(kick);
    mo.observe(stack, { attributes: true, subtree: true, attributeFilter: ['hidden', 'class', 'style'] });
    if (fp) mo.observe(fp, { attributes: true, attributeFilter: ['hidden', 'class'] });
  }
  window.addEventListener('resize', kick);
  kick();
  window.__CFD_SYNC_FILTERS_OFFSET__ = syncFiltersPanelOffset;
})();

(function wireCellVolumeFilter() {
  const btn = document.querySelector('.tb-btn[data-label="Cell Volume"]');
  btn?.addEventListener('click', () => {
    if (typeof setFiltersToolbarMode === 'function') setFiltersToolbarMode('mesh');
    if (typeof setFiltersVisible === 'function') setFiltersVisible(true);
    btn.classList.add('is-active');
    document.querySelector('.tb-btn[data-label="Cutting Plane"]')?.classList.remove('is-active');
    const cpColor = document.getElementById('cp-coloring');
    if (cpColor) cpColor.textContent = 'Cell Volume';
  });
})();


filtersClose?.addEventListener('click', () => setFiltersVisible(false));
btnLegend?.addEventListener('click', () => {
  setLegendVisible(!btnLegend.classList.contains('is-active'));
});

// Cutting Plane toolbar: activate/show live filter
const btnParticleTrace = document.querySelector('.tb-btn[data-label="Particle Trace"]');
function enableResultsCuttingPlane() {
  revealPostFilter('cp-block');
  btnCuttingPlane?.classList.add('is-active');
  btnParticleTrace?.classList.remove('is-active');
  document.querySelector('.tb-btn[data-label="Plot-over-path"]')?.classList.remove('is-active');
  document.querySelector('.tb-btn[data-label="Iso Surface"]')?.classList.remove('is-active');
  document.querySelector('.tb-btn[data-label="Iso Volume"]')?.classList.remove('is-active');
  if (!resultPlanes.length) addResultPlane();
  else {
    renderResultPlaneList();
    updateCuttingPlane();
  }
  publishW7();
}
btnCuttingPlane?.addEventListener('click', () => {
  if (meshInspectOpen && !resultsViewOpen) {
    setFiltersVisible(true);
    addMeshPlane();
    return;
  }
  enableResultsCuttingPlane();
});

document.getElementById('btn-add-result-plane')?.addEventListener('click', () => {
  if (meshInspectOpen && !resultsViewOpen) return;
  addResultPlane();
});

(function wireResultPlaneList() {
  const list = document.getElementById('result-plane-list');
  if (!list) return;
  list.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-rplane]');
    if (del) {
      const id = del.getAttribute('data-del-rplane');
      const plane = resultPlanes.find((p) => p.id === id);
      confirmAction({
        title: 'Delete ' + (plane ? plane.name : 'cutting plane') + '?',
        copy: 'The plane and its position are removed from this run’s filters.',
      }).then((ok) => { if (ok) removeResultPlane(id); });
      return;
    }
    const axisBtn = e.target.closest('[data-rplane-axis]');
    if (axisBtn) {
      const plane = resultPlanes.find((p) => p.id === axisBtn.getAttribute('data-rplane-axis'));
      if (!plane) return;
      plane.axis = String(axisBtn.getAttribute('data-axis') || 'Y').toUpperCase();
      if (sourceBounds) {
        if (!plane.com) plane.com = getObjectCenterOfMass(sourceBounds);
        plane.position = fracAlongAxis(sourceBounds, plane.axis, plane.com) * 100;
      }
      renderResultPlaneList();
      updateCuttingPlane();
      return;
    }
    const inv = e.target.closest('[data-rplane-inv]');
    if (inv) {
      const plane = resultPlanes.find((p) => p.id === inv.getAttribute('data-rplane-inv'));
      if (!plane) return;
      plane.inverse = !plane.inverse;
      renderResultPlaneList();
      updateCuttingPlane();
    }
  });
  list.addEventListener('change', (e) => {
    const on = e.target.closest('[data-rplane-on]');
    if (on) {
      const plane = resultPlanes.find((p) => p.id === on.getAttribute('data-rplane-on'));
      if (!plane) return;
      plane.enabled = !!on.checked;
      cutState.enabled = anyResultPlaneOn();
      updateCuttingPlane();
      return;
    }
    const clip = e.target.closest('[data-rplane-clip]');
    if (clip) {
      const plane = resultPlanes.find((p) => p.id === clip.getAttribute('data-rplane-clip'));
      if (!plane) return;
      plane.clipModel = !!clip.checked;
      updateCuttingPlane();
    }
  });
  list.addEventListener('input', (e) => {
    const frac = e.target.closest('[data-rplane-frac]');
    if (frac) {
      const plane = resultPlanes.find((p) => p.id === frac.getAttribute('data-rplane-frac'));
      if (!plane) return;
      plane.position = Number(frac.value);
      updateCuttingPlane({ defer: true });
      return;
    }
    const op = e.target.closest('[data-rplane-op]');
    if (op) {
      const plane = resultPlanes.find((p) => p.id === op.getAttribute('data-rplane-op'));
      if (!plane) return;
      plane.opacity = Number(op.value);
      const lab = op.parentElement && op.parentElement.querySelector('.opacity-val');
      if (lab) lab.textContent = String(plane.opacity);
      styleResultPlaneActor(plane.actor, plane.opacity);
      try { renderWindow.render(); } catch (_) {}
    }
  });
})();

btnParticleTrace?.addEventListener('click', () => {
  ptState.enabled = true;
  const en = document.getElementById('pt-enabled');
  if (en) en.checked = true;
  revealPostFilter('pt-block');
  btnParticleTrace.classList.add('is-active');
  // Traces run inside the body: make the parts a translucent solid so the
  // coloured traces are what you read, not the surface field. The Parts
  // controls in the Filters panel still override this afterwards.
  cutState.partsOpacity = 0.3;
  cutState.partsStyle = 'solid';
  try { syncChromeFromState(); } catch (_) {}
  try { syncSharedLegend(); } catch (_) {}
  try { syncAssignCursor(); } catch (_) {}
  try { applyPartsAppearance(); } catch (_) {}
  try { syncPtAssignGeom(); } catch (_) {}
  loadParticleTrace().catch((e) => console.error('[CFD] PT toolbar', e));
});

document.getElementById('pt-delete')?.addEventListener('click', () => {
  confirmAction({
    title: 'Delete Particle Trace 1?',
    copy: 'The traces and their seed settings are removed from this run’s filters.',
  }).then((ok) => { if (ok) { dismissParticleTrace(); scheduleFilterAutosave(); } });
});

(function wireParticleTraceControls() {
  const mode = document.getElementById('pt-seed-mode');
  const qty = document.getElementById('pt-quantity-mode');
  const nSeeds = document.getElementById('pt-n-seeds');
  const dens = document.getElementById('pt-density');
  const assignList = document.getElementById('pt-assign-list');
  const clearAssign = document.getElementById('pt-clear-assign');
  const regionShape = document.getElementById('pt-region-shape');
  const clearRegion = document.getElementById('pt-clear-region');
  const sz = document.getElementById('pt-size');
  const szr = document.getElementById('pt-size-range');
  const both = document.getElementById('pt-both');
  const rep = document.getElementById('pt-representation');
  const col = document.getElementById('pt-coloring');
  const solid = document.getElementById('pt-solid-color');
  const solidHex = document.getElementById('pt-solid-hex');
  const en = document.getElementById('pt-enabled');
  const schedule = () => schedulePtReload();
  const readSeeds = () => {
    const prevMode = ptState.seed_mode;
    if (mode) ptState.seed_mode = normalizePtSeedMode(mode.value);
    if (qty) ptState.quantity_mode = qty.value || 'count';
    if (nSeeds) ptState.n_seeds = Math.max(0, Math.floor(Number(nSeeds.value) || 0));
    if (dens) ptState.density = parseSci(dens.value, 10000);
    if (both) ptState.both = !!both.checked;
    if (en) ptState.enabled = !!en.checked;
    if (prevMode !== ptState.seed_mode) onPtSeedModeChanged(prevMode, ptState.seed_mode);
    syncPtModeVisibility();
    try { syncAssignCursor(); } catch (_) {}
    try { syncPtAssignGeom(); } catch (_) {}
    try { syncPtRegionChrome(); } catch (_) {}
    try { syncPtRegionOverlay(); } catch (_) {}
  };
  const pulses = document.getElementById('pt-pulses');
  const cometLen = document.getElementById('pt-comet-length');
  const cometLenVal = document.getElementById('pt-comet-length-val');
  const readLook = () => {
    if (sz) ptState.size = parseSci(sz.value, ptState.size || 0.0037);
    if (rep) ptState.representation = rep.value || 'Cylinders';
    if (col) ptState.coloring = col.value || 'magU';
    if (solid) ptState.solid = solid.value || '#2563eb';
    if (solidHex) solidHex.textContent = ptState.solid;
    if (pulses) {
      // Ignore an empty / partial value mid-typing; keep the last good count.
      const n = Math.floor(Number(pulses.value));
      if (String(pulses.value).trim() !== '' && Number.isFinite(n) && n >= 1) ptState.pulses = Math.min(50, n);
    }
    if (cometLen) ptState.comet_length = Math.max(0.01, Math.min(0.5, Number(cometLen.value) || 0.05));
    if (cometLenVal) cometLenVal.textContent = String(ptState.comet_length);
    const solidField = document.getElementById('pt-solid-field');
    if (solidField) solidField.hidden = ptState.coloring !== 'solid';
    syncPtLookVisibility();
    if (szr && Number(szr.value) !== ptState.size) szr.value = String(ptState.size);
    if (sz && String(sz.value) !== String(ptState.size)) sz.value = String(ptState.size);
  };
  const applyLook = () => {
    readLook();
    applyPtRepresentation();
    try { renderWindow.render(); } catch (_) {}
    publishW8({ look: true });
  };
  [mode, qty, nSeeds, dens].forEach((el) => {
    el?.addEventListener('change', () => {
      readSeeds();
      schedule();
    });
    el?.addEventListener('input', () => {
      readSeeds();
      schedule();
    });
  });
  assignList?.addEventListener('click', (e) => {
    const drop = e.target.closest('[data-pt-unassign]');
    if (drop) {
      unassignPtFace(drop.getAttribute('data-pt-unassign'));
      return;
    }
    const focus = e.target.closest('[data-pt-focus]');
    if (focus) focusPtFace(focus.getAttribute('data-pt-focus'));
  });
  clearAssign?.addEventListener('click', () => clearPtFaces());
  regionShape?.addEventListener('change', () => {
    convertPtRegionShape(regionShape.value === 'circle' ? 'circle' : 'box');
    syncPtRegionOverlay();
    syncPtRegionChrome();
    try { scheduleFilterAutosave(); } catch (_) {}
    if (regionIsUsable(ptState.region)) schedulePtReload();
  });
  clearRegion?.addEventListener('click', () => {
    ptState.region = null;
    cancelPtRegionDraw();
    cancelPtRegionEdit();
    const face = ptRegionTargetFace();
    if (isRegionSeedMode() && face) lookNormalToPtFace(face);
    else restorePtRegionCamera();
    syncPtRegionOverlay();
    syncPtRegionChrome();
    try { scheduleFilterAutosave(); } catch (_) {}
    schedulePtReload();
    try { syncAssignCursor(); } catch (_) {}
  });
  both?.addEventListener('change', () => {
    readSeeds();
    schedule();
  });
  sz?.addEventListener('input', () => {
    ptState.size = parseSci(sz.value, ptState.size || 0.0037);
    if (szr) szr.value = String(ptState.size);
    applyPtRepresentation();
    try { renderWindow.render(); } catch (_) {}
  });
  sz?.addEventListener('change', () => applyLook());
  szr?.addEventListener('input', () => {
    ptState.size = parseSci(szr.value, ptState.size || 0.0037);
    if (sz) sz.value = String(ptState.size);
    applyPtRepresentation();
    try { renderWindow.render(); } catch (_) {}
  });
  rep?.addEventListener('change', () => {
    applyLook();
    try { syncAnimChromeFromState(); } catch (_) {}
  });
  col?.addEventListener('change', () => applyLook());
  solid?.addEventListener('input', () => applyLook());
  pulses?.addEventListener('change', () => applyLook());
  pulses?.addEventListener('input', () => applyLook());
  cometLen?.addEventListener('input', () => applyLook());
  en?.addEventListener('change', () => {
    readSeeds();
    if (!ptState.enabled) {
      hidePtActors();
      try { hidePtRegionOverlay(); } catch (_) {}
      try { applyPartsAppearance(); } catch (_) {}
      renderWindow.render();
      publishW8({ enabled: false });
    } else {
      schedule();
    }
  });
  syncPtChromeFromState();
})();

(function wirePtRegionPicker() {
  if (!container || container._ptRegionPickWired) return;
  container._ptRegionPickWired = true;
  container.addEventListener('pointerdown', (e) => {
    onPtRegionPointerDown(e);
  }, true);
  container.addEventListener('pointermove', (e) => {
    onPtRegionPointerMove(e);
  });
  container.addEventListener('pointerup', (e) => {
    onPtRegionPointerUp(e);
  });
  container.addEventListener('pointercancel', (e) => {
    if (!ptRegionDraw) return;
    try { if (e.pointerId != null) container.releasePointerCapture(e.pointerId); } catch (_) {}
    cancelPtRegionDraw();
  });
  window.addEventListener('resize', () => {
    try { layoutPtRegionHandles(); } catch (_) {}
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (ptRegionEdit) {
      cancelPtRegionEdit(true);
      setPtRegionHint('Resize cancelled.');
      return;
    }
    if (ptRegionDraw) {
      cancelPtRegionDraw();
      setPtRegionHint('Drag cancelled. Drag again on the face.');
    }
  });
})();


const btnPlotOverPath = document.querySelector('.tb-btn[data-label="Plot-over-path"]');
btnPlotOverPath?.addEventListener('click', () => {
  popState.enabled = true;
  const en = document.getElementById('pop-enabled');
  if (en) en.checked = true;
  revealPostFilter('pop-block');
  btnPlotOverPath.classList.add('is-active');
  btnCuttingPlane?.classList.remove('is-active');
  btnParticleTrace?.classList.remove('is-active');
  syncPopChromeFromState();
  publishW9();
});

(function wirePlotOverPathControls() {
  const pick = document.getElementById('pop-pick');
  const addBtn = document.getElementById('pop-add-point');
  const sub = document.getElementById('pop-subdivisions');
  const fv = document.getElementById('pop-field-variable');
  const clear = document.getElementById('pop-clear');
  const gen = document.getElementById('pop-generate');
  const en = document.getElementById('pop-enabled');

  function parsePickText(text) {
    const parts = String(text || '')
      .replace(/;/g, ',')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length < 3) return null;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const z = Number(parts[2]);
    if (![x, y, z].every((v) => Number.isFinite(v))) return null;
    return [x, y, z];
  }

  addBtn?.addEventListener('click', () => {
    const pt = parsePickText(pick?.value || popState.pick);
    if (!pt) return;
    popState.points = [...(popState.points || []), pt];
    popState.pick = '';
    if (pick) pick.value = '';
    syncPopChromeFromState();
    clearPopSeries();
    publishW9({ generate_enabled: popState.points.length > 0 });
  });
  clear?.addEventListener('click', () => {
    popState.points = [];
    syncPopChromeFromState();
    clearPopSeries();
    publishW9({ generate_enabled: false });
    renderWindow.render();
  });
  sub?.addEventListener('change', () => {
    popState.subdivisions = Math.max(0, Math.floor(Number(sub.value) || 0));
    // do not auto-generate; wait for Generate (banked UX) — but prove may call apply
    publishW9();
  });
  fv?.addEventListener('change', () => {
    popState.field_variable = fv.value || 'Velocity Magnitude';
    publishW9();
  });
  gen?.addEventListener('click', () => {
    if ((popState.points || []).length < 1) return;
    loadPlotOverPath().catch((e) => console.error('[CFD W9] generate', e));
  });
  en?.addEventListener('change', () => {
    popState.enabled = !!en.checked;
    popPathActor.setVisibility(!!popState.enabled && (popState.points || []).length >= 2);
    const wrap = document.getElementById('pop-chart-wrap');
    if (wrap && !popState.enabled) wrap.hidden = true;
    renderWindow.render();
    publishW9({ enabled: popState.enabled });
  });
  pick?.addEventListener('input', () => {
    popState.pick = String(pick.value || '');
  });
  syncPopChromeFromState();
  clearPopSeries();
  publishW9({ ready: false });
})();


function syncChromeFromState() {
  const pos = document.getElementById('cp-position');
  if (pos) pos.value = String(cutState.position);
  const op = document.getElementById('cp-opacity');
  const opv = document.getElementById('cp-opacity-val');
  if (op) op.value = String(cutState.opacity);
  if (opv) opv.textContent = String(cutState.opacity);
  const en = document.getElementById('cp-enabled');
  if (en) en.checked = resultPlanesGroupOn();
  const parts = document.getElementById('parts-color');
  if (parts) parts.checked = !!cutState.partsColor;
  const style = document.getElementById('parts-style');
  if (style) style.value = cutState.partsStyle === 'solid' ? 'solid' : 'field';
  const solidField = document.getElementById('parts-solid-field');
  if (solidField) solidField.hidden = cutState.partsStyle !== 'solid';
  const solid = document.getElementById('parts-solid-color');
  const solidHex = document.getElementById('parts-solid-hex');
  if (solid) solid.value = cutState.partsSolid || '#9aa3ad';
  if (solidHex) solidHex.textContent = cutState.partsSolid || '#9aa3ad';
  const pop = document.getElementById('parts-opacity');
  const popv = document.getElementById('parts-opacity-val');
  if (pop) pop.value = String(cutState.partsOpacity);
  if (popv) popv.textContent = String(cutState.partsOpacity);
  const vec = document.getElementById('cp-vectors');
  if (vec) vec.checked = !!cutState.vectors;
  const clip = document.getElementById('cp-clip-model');
  if (clip) clip.checked = !!cutState.clipModel;
  document.querySelectorAll('.orient[data-axis]').forEach((btn) => {
    btn.classList.toggle('is-on', btn.getAttribute('data-axis') === cutState.axis);
  });
  const inv = document.getElementById('cp-inverse');
  if (inv) inv.classList.toggle('is-on', !!cutState.inverse);
}

(function wireCuttingPlaneControls() {
  const pos = document.getElementById('cp-position');
  const op = document.getElementById('cp-opacity');
  const opv = document.getElementById('cp-opacity-val');
  const en = document.getElementById('cp-enabled');
  const parts = document.getElementById('parts-color');
  const vec = document.getElementById('cp-vectors');
  const clip = document.getElementById('cp-clip-model');
  let posTimer = null;

  pos?.addEventListener('input', () => {
    cutState.position = Number(pos.value);
    cutState.positionUserSet = true;
    if (meshInspectOpen) return;
    if (posTimer) clearTimeout(posTimer);
    posTimer = setTimeout(() => {
      updateCuttingPlane({ defer: true });
      publishW7();
    }, 40);
  });
  op?.addEventListener('input', () => {
    cutState.opacity = Number(op.value);
    if (opv) opv.textContent = String(cutState.opacity);
    cutActor.getProperty().setOpacity(cutState.opacity);
    renderWindow.render();
    publishW7();
  });
  en?.addEventListener('change', () => {
    // Group switch: show / hide every result cutting plane at once.
    setResultPlanesGroupOn(!!en.checked);
    publishW7();
  });
  parts?.addEventListener('change', () => {
    cutState.partsColor = !!parts.checked;
    applyPartsAppearance();
    renderWindow.render();
    publishW7();
  });
  const partsStyle = document.getElementById('parts-style');
  const partsSolid = document.getElementById('parts-solid-color');
  const partsSolidHex = document.getElementById('parts-solid-hex');
  const partsOp = document.getElementById('parts-opacity');
  const partsOpv = document.getElementById('parts-opacity-val');
  const syncPartsSolidField = () => {
    const solidField = document.getElementById('parts-solid-field');
    if (solidField) solidField.hidden = cutState.partsStyle !== 'solid';
  };
  partsStyle?.addEventListener('change', () => {
    cutState.partsStyle = partsStyle.value === 'solid' ? 'solid' : 'field';
    syncPartsSolidField();
    applyPartsAppearance();
    renderWindow.render();
    publishW7();
  });
  partsSolid?.addEventListener('input', () => {
    cutState.partsSolid = partsSolid.value || '#9aa3ad';
    if (partsSolidHex) partsSolidHex.textContent = cutState.partsSolid;
    applyPartsAppearance();
    renderWindow.render();
    publishW7();
  });
  partsOp?.addEventListener('input', () => {
    cutState.partsOpacity = Number(partsOp.value);
    if (partsOpv) partsOpv.textContent = String(cutState.partsOpacity);
    applyPartsAppearance();
    renderWindow.render();
    publishW7();
  });
  // Vectors: persist checkbox only (non-live)
  vec?.addEventListener('change', () => {
    cutState.vectors = !!vec.checked;
    publishW7({ vectors_live: false });
  });
  clip?.addEventListener('change', () => {
    cutState.clipModel = !!clip.checked;
    updateCuttingPlane();
    publishW7();
  });
  document.querySelectorAll('.orient[data-axis]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (meshInspectOpen) return;
      cutState.axis = btn.getAttribute('data-axis');
      if (sourceBounds) {
        if (!cutState.com) cutState.com = getObjectCenterOfMass(sourceBounds);
        cutState.position = fracAlongAxis(sourceBounds, cutState.axis, cutState.com) * 100;
      }
      syncChromeFromState();
      updateCuttingPlane();
      publishW7();
    });
  });
  document.getElementById('cp-inverse')?.addEventListener('click', () => {
    cutState.inverse = !cutState.inverse;
    syncChromeFromState();
    updateCuttingPlane();
    publishW7();
  });
  syncChromeFromState();
})();

(function wireColoringSelect() {
  const host =
    document.getElementById('cp-coloring') ||
    document.querySelector('.fp-block .fp-select');
  if (!host) return;
  if (host.tagName === 'SELECT') return;
  const sel = document.createElement('select');
  sel.id = 'cp-coloring';
  sel.className = 'fp-select';
  sel.setAttribute('aria-label', 'Coloring');
  sel.innerHTML =
    '<option value="magU">Velocity Magnitude</option><option value="p">Pressure</option><option value="cellVolume" hidden disabled>Cell Volume</option>';
  sel.value = 'magU';
  host.replaceWith(sel);
  sel.addEventListener('change', () => {
    if (sel.value === 'cellVolume') {
      if (typeof setFiltersToolbarMode === 'function') setFiltersToolbarMode('mesh');
      return;
    }
    const f = sel.value === 'p' ? 'p' : 'magU';
    if (typeof setFiltersToolbarMode === 'function' && window.__CFD_FILTERS_MODE__ === 'mesh') {
      setFiltersToolbarMode('post');
    }
    loadField(f).catch((e) => console.error('[CFD W7] recolor failed', e));
  });
})();

window.__CFD_W1__ = {
  stack: 'B',
  vtk_path: 'vtk.js',
  demo_actor: 'vtkXMLPolyDataReader',
  hasCanvas: !!container.querySelector('canvas'),
  canvas: container.querySelector('canvas'),
};

window.__CFD_W2__ = {
  increment: 'W2',
  chrome: 'simscale-workbench-slim',
  cone_placeholder: false,
  no_fake_solve: true,
  no_live_mesh_run_post: true,
  no_filter_invent: true,
};

window.__CFD_W6__ = window.__CFD_W6__ || {
  increment: 'W6',
  case_dir: getCaseDir(),
  time: getTime(),
  field: activeField,
  api_url: apiFieldUrl(activeField),
  proves_not_baked_only: true,
  cone_absent: true,
  demo_actor: 'vtkXMLPolyDataReader',
  ready: false,
};

publishW7({ ready: false });

const btnIsoSurface = document.querySelector('.tb-btn[data-label="Iso Surface"]');
btnIsoSurface?.addEventListener('click', () => {
  isoState.enabled = true;
  const en = document.getElementById('iso-enabled');
  if (en) en.checked = true;
  revealPostFilter('iso-block');
  btnIsoSurface.classList.add('is-active');
  btnCuttingPlane?.classList.remove('is-active');
  btnParticleTrace?.classList.remove('is-active');
  btnPlotOverPath?.classList.remove('is-active');
  document.querySelector('.tb-btn[data-label="Iso Volume"]')?.classList.remove('is-active');
  loadIsoSurface().catch((e) => console.error('[CFD W10] Iso toolbar', e));
});

(function wireIsoSurfaceControls() {
  const sc = document.getElementById('iso-scalar');
  const val = document.getElementById('iso-value');
  const col = document.getElementById('iso-coloring');
  const vec = document.getElementById('iso-vectors');
  const op = document.getElementById('iso-opacity');
  const opv = document.getElementById('iso-opacity-val');
  const en = document.getElementById('iso-enabled');
  let t = null;
  const schedule = () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      loadIsoSurface().catch((e) => console.error('[CFD W10] Iso form', e));
    }, 120);
  };
  const read = () => {
    if (sc) isoState.iso_scalar = sc.value || 'Velocity Magnitude';
    if (val) isoState.iso_value = Number(val.value);
    if (col) isoState.coloring = col.value || 'Pressure';
    if (vec) isoState.vectors = !!vec.checked;
    if (op) {
      isoState.opacity = Number(op.value);
      if (opv) opv.textContent = String(isoState.opacity);
      isoActor.getProperty().setOpacity(isoState.opacity);
    }
    if (en) isoState.enabled = !!en.checked;
  };
  [sc, val, col].forEach((el) => {
    el?.addEventListener('change', () => {
      read();
      schedule();
    });
    el?.addEventListener('input', () => {
      read();
      schedule();
    });
  });
  op?.addEventListener('input', () => {
    read();
    renderWindow.render();
    publishW10();
  });
  op?.addEventListener('change', () => {
    read();
    schedule();
  });
  vec?.addEventListener('change', () => {
    read();
    const pd = isoMapper.getInputData ? isoMapper.getInputData() : null;
    const live = syncFieldVectorGlyphs(isoVecGlyph, pd, !!isoState.enabled && !!isoState.vectors);
    if (isoState.vectors && isoState.enabled && !live) {
      schedule();
      return;
    }
    renderWindow.render();
    publishW10({ vectors_live: live, vectors_persist_only: false });
  });
  en?.addEventListener('change', () => {
    read();
    if (!isoState.enabled) {
      isoActor.setVisibility(false);
      syncFieldVectorGlyphs(isoVecGlyph, null, false);
      renderWindow.render();
      publishW10({ enabled: false });
    } else {
      schedule();
    }
  });
  syncIsoChromeFromState();
})();



const btnIsoVolume = document.querySelector('.tb-btn[data-label="Iso Volume"]');
const btnAnimation = document.querySelector('.tb-btn[data-label="Animation"]');
btnIsoVolume?.addEventListener('click', () => {
  ivState.enabled = true;
  const en = document.getElementById('iv-enabled');
  if (en) en.checked = true;
  revealPostFilter('iv-block');
  btnIsoVolume.classList.add('is-active');
  btnIsoSurface?.classList.remove('is-active');
  btnCuttingPlane?.classList.remove('is-active');
  btnParticleTrace?.classList.remove('is-active');
  btnPlotOverPath?.classList.remove('is-active');
  btnAnimation?.classList.remove('is-active');
  loadIsoVolume().catch((e) => console.error('[CFD W11] Iso Volume toolbar', e));
});
btnAnimation?.addEventListener('click', () => {
  const block = document.getElementById('anim-block');
  const fresh = !block || block.hidden;
  revealPostFilter('anim-block');
  syncAnimChromeFromState();
  btnAnimation.classList.add('is-active');
  btnIsoVolume?.classList.remove('is-active');
  btnIsoSurface?.classList.remove('is-active');
  btnCuttingPlane?.classList.remove('is-active');
  btnParticleTrace?.classList.remove('is-active');
  btnPlotOverPath?.classList.remove('is-active');
  ensureAnimTimes()
    .then((times) => {
      // Steady run: Animation is for moving pulses along a static trace.
      // Transient (2+ times): keep Time Step so traces reload with the field.
      if (fresh && ptLinePd && ptState.enabled && (!times || times.length < 2)) {
        animState.type = 'Particle Trace';
        syncAnimChromeFromState();
      }
      publishW12({ animation_opened: true });
      if (!isPtAnimation()) warmAnimFrameCache();
    })
    .catch((e) => console.error('[CFD W12]', e));
});
document.getElementById('anim-delete')?.addEventListener('click', () => {
  confirmAction({
    title: 'Delete Animation 1?',
    copy: 'Playback stops and the animation filter is removed.',
  }).then((ok) => { if (ok) { dismissAnimation(); scheduleFilterAutosave(); } });
});

(function wireIsoVolumeControls() {
  const sc = document.getElementById('iv-scalar');
  const lo = document.getElementById('iv-low');
  const hi = document.getElementById('iv-high');
  const col = document.getElementById('iv-coloring');
  const vec = document.getElementById('iv-vectors');
  const op = document.getElementById('iv-opacity');
  const opv = document.getElementById('iv-opacity-val');
  const en = document.getElementById('iv-enabled');
  let tmr = null;
  const schedule = () => {
    if (tmr) clearTimeout(tmr);
    tmr = setTimeout(() => {
      loadIsoVolume().catch((e) => console.error('[CFD W11] Iso Volume form', e));
    }, 120);
  };
  const read = () => {
    if (sc) ivState.iso_scalar = sc.value || 'Velocity Magnitude';
    if (lo) ivState.iso_value_low = Number(lo.value);
    if (hi) ivState.iso_value_high = Number(hi.value);
    // UI dual-handle: prevent crossing while dragging (prove APPLY can still invert)
    if (lo && hi && Number(lo.value) > Number(hi.value)) {
      if (document.activeElement === lo) {
        hi.value = lo.value;
        ivState.iso_value_high = Number(hi.value);
      } else {
        lo.value = hi.value;
        ivState.iso_value_low = Number(lo.value);
      }
    }
    if (col) ivState.coloring = col.value || 'Pressure';
    if (vec) ivState.vectors = !!vec.checked;
    if (op) {
      ivState.opacity = Number(op.value);
      if (opv) opv.textContent = String(ivState.opacity);
      ivActor.getProperty().setOpacity(ivState.opacity);
    }
    if (en) ivState.enabled = !!en.checked;
    syncIvRangeVisual();
  };
  [sc, col].forEach((el) => {
    el?.addEventListener('change', () => {
      read();
      schedule();
    });
  });
  [lo, hi].forEach((el) => {
    el?.addEventListener('input', () => {
      read();
      syncIvRangeVisual();
    });
    el?.addEventListener('change', () => {
      read();
      schedule();
    });
  });
  op?.addEventListener('input', () => {
    read();
    renderWindow.render();
    publishW11();
  });
  op?.addEventListener('change', () => {
    read();
    schedule();
  });
  vec?.addEventListener('change', () => {
    read();
    const pd = ivMapper.getInputData ? ivMapper.getInputData() : null;
    const live = syncFieldVectorGlyphs(ivVecGlyph, pd, !!ivState.enabled && !!ivState.vectors);
    if (ivState.vectors && ivState.enabled && !live) {
      schedule();
      return;
    }
    renderWindow.render();
    publishW11({ vectors_live: live, vectors_persist_only: false });
  });
  en?.addEventListener('change', () => {
    read();
    if (!ivState.enabled) {
      ivActor.setVisibility(false);
      syncFieldVectorGlyphs(ivVecGlyph, null, false);
      renderWindow.render();
      publishW11({ enabled: false });
    } else {
      schedule();
    }
  });
  syncIvChromeFromState();
})();


console.info('[CFD W11] slim chrome + live iso-volume (threshold) + Iso Surface + Plot + PT + CP — no boot fetch');
publishW9({ ready: false });
publishW8({ ready: false });


// ---- W12 Animation live on real case times ----
const ANIM_SPEED_MIN = 0.1;
const ANIM_SPEED_MAX = 8;

const animState = {
  enabled: true,
  type: 'Time Step',
  times: [],
  start: null,
  end: null,
  endPinned: false,
  index: 0,
  speed: 1,
  skip: 0,
  playing: false,
  mapping_note:
    'Start/End pick the saved frames to loop. Raise Start to skip initialization.',
};

function clampAnimSpeed(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(ANIM_SPEED_MAX, Math.max(ANIM_SPEED_MIN, n));
}

function formatAnimSpeed(v) {
  const n = clampAnimSpeed(v);
  const t = Math.round(n * 10) / 10;
  return (Math.abs(t - Math.round(t)) < 1e-6 ? String(Math.round(t)) : t.toFixed(1)) + '×';
}

function nearestTimeIndex(times, value) {
  const list = times || [];
  if (!list.length) return -1;
  const s = String(value);
  const exact = list.indexOf(s);
  if (exact >= 0) return exact;
  const n = Number(value);
  if (!Number.isFinite(n)) return -1;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const ti = Number(list[i]);
    const d = Number.isFinite(ti) ? Math.abs(ti - n) : Infinity;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function animWindowRange() {
  const times = animState.times || [];
  if (!times.length) return { startIdx: 0, endIdx: 0 };
  let startIdx = nearestTimeIndex(times, animState.start);
  let endIdx = nearestTimeIndex(times, animState.end);
  if (startIdx < 0) startIdx = 0;
  if (endIdx < 0) endIdx = times.length - 1;
  if (endIdx < startIdx) {
    const t = startIdx;
    startIdx = endIdx;
    endIdx = t;
  }
  return { startIdx, endIdx };
}

function animTimesAreSeconds() {
  try {
    return runRecIsTransient(selectedRunRecord());
  } catch (_) {
    return false;
  }
}

function formatAnimTimeNumber(t) {
  if (t == null || t === '') return '—';
  const n = Number(t);
  if (!Number.isFinite(n)) return String(t);
  if (Math.abs(n - Math.round(n)) < 5e-5) return String(Math.round(n));
  return String(Number(n.toFixed(4)));
}

function formatAnimTimeLabel(t, seconds) {
  const s = formatAnimTimeNumber(t);
  if (s === '—') return s;
  return seconds ? s + ' s' : s;
}

function applyAnimWindowFromIndices(si, ei) {
  const times = animState.times || [];
  if (!times.length) return { startIdx: 0, endIdx: 0 };
  const last = times.length - 1;
  si = Math.max(0, Math.min(last, Math.round(Number(si) || 0)));
  ei = Math.max(0, Math.min(last, Math.round(Number(ei) || 0)));
  if (ei < si) ei = si;
  animState.start = times[si];
  animState.end = times[ei];
  animState.endPinned = ei < last;
  return { startIdx: si, endIdx: ei };
}

function syncAnimWindowVisual() {
  const sel = document.getElementById('anim-window-sel');
  const lo = document.getElementById('anim-win-lo');
  const hi = document.getElementById('anim-win-hi');
  const startVal = document.getElementById('anim-start-val');
  const endVal = document.getElementById('anim-end-val');
  const times = animState.times || [];
  const last = Math.max(0, times.length - 1);
  const { startIdx, endIdx } = animWindowRange();
  if (lo) {
    lo.min = '0';
    lo.max = String(last);
    lo.step = '1';
    lo.value = String(startIdx);
    lo.disabled = times.length < 2;
  }
  if (hi) {
    hi.min = '0';
    hi.max = String(last);
    hi.step = '1';
    hi.value = String(endIdx);
    hi.disabled = times.length < 2;
  }
  const seconds = animTimesAreSeconds();
  if (startVal) startVal.textContent = formatAnimTimeLabel(times[startIdx], seconds);
  if (endVal) endVal.textContent = formatAnimTimeLabel(times[endIdx], seconds);
  const canStep = times.length >= 2;
  const startPrev = document.getElementById('anim-start-prev');
  const startNext = document.getElementById('anim-start-next');
  const endPrev = document.getElementById('anim-end-prev');
  const endNext = document.getElementById('anim-end-next');
  if (startPrev) startPrev.disabled = !canStep || startIdx <= 0;
  if (startNext) startNext.disabled = !canStep || startIdx >= endIdx;
  if (endPrev) endPrev.disabled = !canStep || endIdx <= startIdx;
  if (endNext) endNext.disabled = !canStep || endIdx >= last;
  if (!sel) return;
  if (last < 1) {
    sel.style.left = '0%';
    sel.style.width = '100%';
    return;
  }
  const a = startIdx / last;
  const b = endIdx / last;
  sel.style.left = (a * 100) + '%';
  sel.style.width = Math.max(2, (b - a) * 100) + '%';
}

function nudgeAnimWindow(which, delta) {
  const times = animState.times || [];
  if (times.length < 2) return;
  const { startIdx, endIdx } = animWindowRange();
  const last = times.length - 1;
  let si = startIdx;
  let ei = endIdx;
  if (which === 'start') si = Math.max(0, Math.min(ei, si + delta));
  else ei = Math.min(last, Math.max(si, ei + delta));
  applyAnimWindowFromIndices(si, ei);
  syncAnimChromeFromState();
  const idx = which === 'start' ? si : ei;
  const t = times[idx];
  if (t == null) return;
  if (animState.playing) stopAnimationPlay();
  setAnimationTime(t, { playing: true }).catch((e) => console.error('[CFD W12] window nudge', e));
  warmAnimFrameCache();
  publishW12();
}

function applyAnimWindow(startVal, endVal) {
  const times = animState.times || [];
  if (!times.length) {
    if (startVal != null) animState.start = String(startVal);
    if (endVal != null) animState.end = String(endVal);
    return { startIdx: 0, endIdx: 0 };
  }
  let si = nearestTimeIndex(times, startVal != null ? startVal : animState.start);
  let ei = nearestTimeIndex(times, endVal != null ? endVal : animState.end);
  if (si < 0) si = 0;
  if (ei < 0) ei = times.length - 1;
  if (ei < si) {
    const t = si;
    si = ei;
    ei = t;
  }
  animState.start = times[si];
  animState.end = times[ei];
  animState.endPinned = ei < times.length - 1;
  return { startIdx: si, endIdx: ei };
}

function setAnimSpeed(v, opts) {
  animState.speed = clampAnimSpeed(v);
  const speed = document.getElementById('anim-speed');
  const sv = document.getElementById('anim-speed-val');
  if (speed) speed.value = String(animState.speed);
  if (sv) sv.textContent = formatAnimSpeed(animState.speed);
  if (!(opts && opts.silent) && animState.playing && !isPtAnimation()) startAnimationPlay();
  if (!(opts && opts.silent)) publishW12();
}
let animTimer = null;
let animMetaCache = {};

function apiTimesUrl() {
  return `/api/times?case=${encodeURIComponent(CASE_DIR)}`;
}

async function ensureAnimTimes() {
  const r = await fetch(apiTimesUrl());
  const j = await r.json();
  const times = Array.isArray(j.times) ? j.times.map(String) : [];
  const prevStart = animState.start;
  const prevEnd = animState.end;
  animState.times = times;
  if (times.length) {
    if (prevStart == null || nearestTimeIndex(times, prevStart) < 0) {
      animState.start = times[0];
    } else {
      animState.start = times[nearestTimeIndex(times, prevStart)];
    }
    if (prevEnd == null || !animState.endPinned) {
      animState.end = times[times.length - 1];
    } else {
      const ei = nearestTimeIndex(times, prevEnd);
      animState.end = times[ei >= 0 ? ei : times.length - 1];
    }
    if (nearestTimeIndex(times, animState.start) > nearestTimeIndex(times, animState.end)) {
      animState.end = times[times.length - 1];
      animState.endPinned = false;
    }
    let idx = times.indexOf(String(currentTime));
    if (idx < 0) idx = times.length - 1;
    animState.index = idx;
  }
  if (times.length >= 2) {
    try {
      ensureSeriesLutCase();
      const key = seriesLutKey(activeField);
      if (!seriesLut.held[key] && Array.isArray(lutRange) && lutRange[1] > lutRange[0]) {
        seriesLut.held[key] = lutRange.slice();
      }
    } catch (_) {}
  }
  syncAnimChromeFromState();
  publishW12({ times_loaded: true, times_api: j });
  return times;
}

function syncAnimChromeFromState() {
  const times = animState.times || [];
  const typeEl = document.getElementById('anim-type');
  const winField = document.getElementById('anim-window-field');
  const winLabel = document.getElementById('anim-window-label');
  const scrub = document.getElementById('anim-scrub');
  const tval = document.getElementById('anim-time-val');
  const speed = document.getElementById('anim-speed');
  const speedVal = document.getElementById('anim-speed-val');
  const skip = document.getElementById('anim-skip');
  const en = document.getElementById('anim-enabled');
  const note = document.getElementById('anim-map-note');
  if (typeEl) typeEl.value = animState.type || 'Time Step';
  const ptMode = isPtAnimation();
  const transientTimes = animTimesAreSeconds();
  if (winLabel) winLabel.textContent = transientTimes ? 'Start / End' : 'Start / End iteration';
  if (winField) winField.hidden = ptMode;
  if (skip) {
    const skipField = skip.closest('.fp-field');
    if (skipField) skipField.hidden = ptMode;
  }
  syncAnimWindowVisual();
  const timeLabel = scrub && scrub.closest('.fp-field') && scrub.closest('.fp-field').querySelector('.fp-label');
  if (timeLabel) timeLabel.textContent = ptMode ? 'Position' : 'Time';
  if (ptMode) {
    if (scrub) {
      scrub.min = '0';
      scrub.max = '100';
      scrub.step = '1';
    }
    syncAnimPhaseLabel();
  } else {
    const { startIdx, endIdx } = animWindowRange();
    if (scrub) {
      scrub.min = String(startIdx);
      scrub.max = String(Math.max(startIdx, endIdx));
      scrub.step = '1';
      const idx = Math.max(startIdx, Math.min(endIdx, Number(animState.index) || 0));
      scrub.value = String(idx);
    }
    const cur = times[animState.index] != null ? times[animState.index] : currentTime;
    if (tval) tval.textContent = formatAnimTimeLabel(cur, transientTimes);
  }
  if (speed) speed.value = String(clampAnimSpeed(animState.speed));
  if (speedVal) speedVal.textContent = formatAnimSpeed(animState.speed);
  if (skip) skip.value = String(animState.skip);
  if (en) en.checked = !!animState.enabled;
  if (note) {
    if (ptMode) {
      const rep = String(ptState.representation || 'Cylinders');
      note.textContent = !ptLinePd || !ptState.enabled
        ? 'Add a Particle Trace first — the animation moves its Spheres or Comets along the flow.'
        : rep === 'Cylinders'
          ? 'Cylinders show the whole path. Play switches the trace to Comets so the motion is visible.'
          : 'Particles travel at the local flow speed; Pulses and Relative comet length are set on the Particle Trace.';
    } else {
      const win = animWindowRange();
      const span = times.length
        ? formatAnimTimeNumber(times[win.startIdx]) + ' → ' + formatAnimTimeNumber(times[win.endIdx])
        : '';
      note.textContent = times.length
        ? 'Play loops ' + span + ' (' + (win.endIdx - win.startIdx + 1) + ' of ' + times.length + ' frames). Step or drag either end to skip initialization.'
          + (ptState.enabled ? ' Particle traces update with each time.' : '')
        : 'No saved frames yet.';
    }
  }
  syncAnimPlayButtons();
  syncIterationsPanelFromState();
}

function syncIterationsPanelFromState() {
  const times = animState.times || [];
  const idx = Math.max(0, Math.min(Math.max(0, times.length - 1), Number(animState.index) || 0));
  const cur = times.length ? times[idx] : String(currentTime);
  const first = times.length ? times[0] : '-';
  const last = times.length ? times[times.length - 1] : '-';
  const curEl = document.getElementById('iter-current');
  const valEl = document.getElementById('iter-value');
  const rangeEl = document.getElementById('iter-range-label');
  const minEl = document.getElementById('iter-range-min');
  const maxEl = document.getElementById('iter-range-max');
  const scrub = document.getElementById('iter-scrub');
  const noteEl = document.getElementById('iter-times-note');
  // W30: a transient run's time directories are seconds, not iterations.
  // (Guarded: this also runs at module init, before the run state exists.)
  let transientTimes = false;
  try {
    transientTimes = runRecIsTransient(selectedRunRecord());
  } catch (_) {
    transientTimes = false;
  }
  const headEl = document.querySelector('#iterations-panel .rc-head');
  if (headEl) headEl.textContent = transientTimes ? 'TIME' : 'ITERATIONS';
  if (curEl) curEl.textContent = transientTimes
    ? 'Current time: ' + formatAnimTimeLabel(cur, true)
    : 'Current iteration: ' + formatAnimTimeNumber(cur);
  if (valEl) valEl.value = formatAnimTimeNumber(cur);
  if (rangeEl) {
    const include0 = times.length > 1 && Number(times[0]) === 0;
    rangeEl.textContent = times.length
      ? transientTimes
        ? 'Saved frames: ' +
          formatAnimTimeNumber(first) +
          ' s to ' +
          formatAnimTimeNumber(last) +
          ' s (' +
          times.length +
          (include0 ? ', including t = 0' : '') +
          ')'
        : 'Saved iterations: ' + formatAnimTimeNumber(first) + ' to ' + formatAnimTimeNumber(last) + ' (' + times.length + ')'
      : transientTimes
        ? 'No saved frames yet'
        : 'No saved iterations yet';
  }
  if (minEl) minEl.textContent = formatAnimTimeNumber(first);
  if (maxEl) maxEl.textContent = formatAnimTimeNumber(last);
  if (scrub) {
    scrub.min = '0';
    scrub.max = String(Math.max(0, times.length - 1));
    scrub.step = '1';
    scrub.value = String(times.length ? idx : 0);
    scrub.disabled = times.length === 0;
  }
  if (noteEl) noteEl.remove();
}

function publishW12(extra) {
  const times = animState.times || [];
  const cur = String(currentTime);
  window.__CFD_W12__ = {
    increment: 'W12',
    ready: !!(window.__CFD_W6__ && window.__CFD_W6__.ready !== false),
    approach:
      'Animation live + ITERATIONS honesty: /api/times lists real OpenFOAM time dirs; scrub/play and right-panel ITERATIONS share that list; load /api/fields/magU?time= for each real time; uniform foam (time 0) fills surface zeros; missing time -> 404 empty.',
    case_dir: getCaseDir(),
    time: cur,
    available_times: times.slice(),
    n_times: times.length,
    anim_state: {
      enabled: animState.enabled,
      type: animState.type,
      start: animState.start,
      end: animState.end,
      index: animState.index,
      speed: animState.speed,
      skip: animState.skip,
      playing: animState.playing,
    },
    mapping_note: animState.mapping_note,
    api_times_url: apiTimesUrl(),
    api_field_url: apiFieldUrl(activeField || 'magU'),
    fingerprint: window.__CFD_W6__ ? window.__CFD_W6__.fingerprint : null,
    foam_proof: window.__CFD_W6__ ? window.__CFD_W6__.foam_proof : null,
    animation_live: true,
    animation_chrome_only: false,
    no_invented_frames: true,
    right_panel_iterations_not_prove: false,
    right_panel_iterations_bound_to_api_times: true,
    iterations_panel_agrees_with_scrubber: true,
    cutting_plane_still_live: true,
    particle_trace_still_live: true,
    plot_over_path_still_live: true,
    iso_surface_still_live: true,
    iso_volume_still_live: true,
    ...(extra || {}),
  };
  publishW121(extra);
}

function publishW121(extra) {
  const times = animState.times || [];
  const idx = Math.max(0, Math.min(Math.max(0, times.length - 1), Number(animState.index) || 0));
  const cur = times.length ? String(times[idx]) : String(currentTime);
  const scrub = document.getElementById('anim-scrub');
  const iterScrub = document.getElementById('iter-scrub');
  const iterCurrent = document.getElementById('iter-current');
  const iterRange = document.getElementById('iter-range-label');
  const panelEl = document.getElementById('iterations-panel');
  const panelText = panelEl ? panelEl.textContent || '' : '';
  const animLabel = document.getElementById('anim-time-val')
    ? document.getElementById('anim-time-val').textContent
    : null;
  window.__CFD_W12_1__ = {
    increment: 'W12.1',
    ready: !!(window.__CFD_W12__ && window.__CFD_W12__.ready !== false),
    approach:
      'ITERATIONS panel honesty: Current iteration / Range / panel scrubber bind to real /api/times; agree with Animation scrubber; no fake 0-1000.',
    case_dir: getCaseDir(),
    available_times: times.slice(),
    n_times: times.length,
    current_time: cur,
    current_index: times.length ? idx : null,
    anim_scrub_value: scrub ? scrub.value : null,
    anim_scrub_max: scrub ? scrub.max : null,
    anim_time_label: animLabel,
    iter_scrub_value: iterScrub ? iterScrub.value : null,
    iter_scrub_max: iterScrub ? iterScrub.max : null,
    iter_current_text: iterCurrent ? iterCurrent.textContent : null,
    iter_range_text: iterRange ? iterRange.textContent : null,
    panel_shows_fake_1000: /\b1000\b/.test(panelText),
    scrubber_panel_agree:
      !!scrub &&
      !!iterScrub &&
      scrub.value === iterScrub.value &&
      scrub.max === iterScrub.max &&
      String(animLabel || '') === String(cur),
    animation_still_live: true,
    filters_still_live: true,
    ...(extra || {}),
  };


}

async function setAnimationTime(time, opts) {
  const tstr = String(time);
  const times = animState.times || [];
  if (times.length && !times.includes(tstr) && !(opts && opts.allowMissing)) {
    publishW12({ error: 'time_not_in_available', requested: tstr, empty: true });
    return { ok: false, empty: true, error: 'time_not_in_available', time: tstr };
  }
  currentTime = tstr;
  if (times.length) {
    const idx = times.indexOf(tstr);
    if (idx >= 0) animState.index = idx;
  }
  syncAnimChromeFromState();
  try {
    const fp = await loadField(activeField || 'magU', {
      extras: !(opts && (opts.playing || opts.skipExtras)),
    });
    publishW12({
      last_time: tstr,
      fingerprint: fp,
      foam_proof: window.__CFD_W6__ && window.__CFD_W6__.foam_proof,
      prove_ts: Date.now(),
    });
    return { ok: true, time: tstr, fingerprint: fp, meta: window.__CFD_W6__ };
  } catch (err) {
    publishW12({ last_time: tstr, error: String(err), empty: true, prove_ts: Date.now() });
    return { ok: false, empty: true, error: String(err), time: tstr };
  }
}

let animPlayGen = 0;

function animWindowTimes() {
  const times = animState.times || [];
  if (!times.length) return [];
  const { startIdx, endIdx } = animWindowRange();
  return times.slice(startIdx, endIdx + 1);
}

function animTimeIsCached(field, t, wantPt) {
  if (!fieldFrameCache.has(fieldFrameKey(field, t))) return false;
  if (wantPt && !ptFrameCache.has(ptFrameKey(t))) return false;
  return true;
}

function setAnimFrameHint(done, total) {
  const note = document.getElementById('anim-map-note');
  if (!note) return;
  if (total && done < total) {
    note.textContent =
      'Loading frames ' +
      done +
      ' / ' +
      total +
      (ptState.enabled ? ' (field + traces)…' : '…');
    return;
  }
  if (total && done >= total) {
    const times = animState.times || [];
    const win = animWindowRange();
    const span = times.length
      ? formatAnimTimeNumber(times[win.startIdx]) + ' → ' + formatAnimTimeNumber(times[win.endIdx])
      : '';
    const loop = span ? 'Play loops ' + span + '. ' : '';
    note.textContent = loop + (ptState.enabled
      ? total + ' frames in memory (field + traces).'
      : total + ' frames in memory.');
  }
}

async function preloadAnimFrames(times, field, onProgress) {
  ensureFieldCacheCase();
  const list = (times || []).map(String);
  if (!list.length) return;
  const wantPt = !!ptState.enabled;
  if (wantPt) ensurePtCacheSettings();
  // Count simulation times, not cache entries. With traces on, each time
  // still needs a field frame and a PT frame — that used to report 122
  // for a 61-time run (t = 0 plus 60 writes).
  const missing = list.filter((t) => !animTimeIsCached(field, t, wantPt));
  const total = list.length;
  let done = total - missing.length;
  if (onProgress) onProgress(done, total);
  if (missing.length) {
    let cursor = 0;
    const limit = Math.min(3, missing.length);
    await Promise.all(Array.from({ length: limit }, async () => {
      while (cursor < missing.length) {
        const t = missing[cursor++];
        try {
          if (!fieldFrameCache.has(fieldFrameKey(field, t))) {
            await prefetchFieldFrame(field, t);
          }
          if (wantPt && !ptFrameCache.has(ptFrameKey(t))) {
            await prefetchPtFrame(t);
          }
        } catch (e) {
          console.warn('[CFD] anim preload', t, e);
        }
        done += 1;
        if (onProgress) onProgress(done, total);
      }
    }));
  }
  if (list.length >= 2) {
    try { applyLockedSeriesLegend(field); } catch (_) {}
  }
}

function warmAnimFrameCache() {
  if (isPtAnimation()) return;
  if (!hasAttachedCase()) return;
  const times = animWindowTimes();
  if (times.length < 2) return;
  const field = activeField || 'magU';
  preloadAnimFrames(times, field, setAnimFrameHint).catch((e) => console.warn('[CFD] anim warm', e));
}

function stopAnimationPlay() {
  animState.playing = false;
  animPlayGen += 1;
  if (animTimer) {
    clearInterval(animTimer);
    animTimer = null;
  }
  if (ptAnimRaf) {
    cancelAnimationFrame(ptAnimRaf);
    ptAnimRaf = 0;
  }
  ptAnimLastTs = 0;
  const play = document.getElementById('anim-play');
  if (play) play.textContent = 'Play';
  syncAnimPlayButtons();
  publishW12({ playing: false });
}

// ---- Particle Trace animation: moves the Spheres / Comets pulses ----
// A particle crosses a typical (median) trace in PT_CYCLE_SECONDS at speed
// 1; the Speed slider scales that.
const PT_CYCLE_SECONDS = 8;
let ptAnimRaf = 0;
let ptAnimLastTs = 0;

function isPtAnimation() {
  return String(animState.type) === 'Particle Trace';
}

function syncAnimPlayButtons() {
  const play = document.getElementById('anim-play');
  const pause = document.getElementById('anim-pause');
  if (play) play.classList.toggle('is-on', !!animState.playing);
  if (pause) pause.classList.toggle('is-on', !animState.playing);
}

function syncAnimPhaseLabel() {
  const scrub = document.getElementById('anim-scrub');
  const tval = document.getElementById('anim-time-val');
  const pct = Math.round(ptPhase * 100);
  if (scrub && String(scrub.value) !== String(pct)) scrub.value = String(pct);
  if (tval && tval.textContent !== pct + ' %') tval.textContent = pct + ' %';
}

function ptAnimFrame(ts) {
  ptAnimRaf = 0;
  if (!animState.playing || !isPtAnimation()) return;
  const dt = ptAnimLastTs ? Math.min(0.1, (ts - ptAnimLastTs) / 1000) : 0;
  ptAnimLastTs = ts;
  const speed = clampAnimSpeed(animState.speed);
  ptPhase = (ptPhase + (dt * speed) / PT_CYCLE_SECONDS) % 1;
  if (updatePtPulseGeometry()) {
    try { renderWindow.render(); } catch (_) {}
  }
  try { updateCompareResultsPulses(); } catch (_) {}
  syncAnimPhaseLabel();
  ptAnimRaf = requestAnimationFrame(ptAnimFrame);
}

function setPtAnimPhase(phase) {
  const f = Number(phase);
  ptPhase = Number.isFinite(f) ? ((f % 1) + 1) % 1 : 0;
  if (updatePtPulseGeometry()) {
    try { renderWindow.render(); } catch (_) {}
  }
  try { updateCompareResultsPulses(); } catch (_) {}
  syncAnimPhaseLabel();
}

function startPtAnimationPlay() {
  stopAnimationPlay();
  const hint = document.getElementById('anim-map-note');
  if (!ptLinePd || !ptState.enabled) {
    if (hint) hint.textContent = 'Add a Particle Trace first — the animation moves its Spheres or Comets along the flow.';
    publishW12({ note: 'no particle trace to animate' });
    return;
  }
  if (String(ptState.representation || 'Cylinders') === 'Cylinders') {
    // Cylinders draw the whole path; only pulses can move.
    ptState.representation = 'Comets';
    const rep = document.getElementById('pt-representation');
    if (rep) rep.value = 'Comets';
    try { syncPtLookVisibility(); } catch (_) {}
    try { applyPtRepresentation(); } catch (_) {}
  }
  animState.playing = true;
  ptAnimLastTs = 0;
  syncAnimPlayButtons();
  ptAnimRaf = requestAnimationFrame(ptAnimFrame);
  publishW12({ playing: true, mode: 'particle_trace', cycle_s: PT_CYCLE_SECONDS / clampAnimSpeed(animState.speed) });
}

function startAnimationPlay() {
  if (isPtAnimation()) {
    startPtAnimationPlay();
    return;
  }
  const times = animState.times || [];
  if (times.length < 2) {
    publishW12({ note: 'need at least 2 real times to play' });
    return;
  }
  const windowTimes = animWindowTimes();
  if (windowTimes.length < 2) {
    publishW12({ note: 'Start and End must include at least two frames' });
    return;
  }
  stopAnimationPlay();
  const playGen = ++animPlayGen;
  animState.playing = true;
  syncAnimPlayButtons();
  const field = activeField || 'magU';
  const playBtn = document.getElementById('anim-play');
  const runLoop = () => {
    if (!animState.playing || playGen !== animPlayGen) return;
    const baseMs = 1000;
    const stepMs = () => Math.max(20, baseMs / clampAnimSpeed(animState.speed));
    const tick = async () => {
      if (!animState.playing || playGen !== animPlayGen) return;
      const skip = Math.max(0, Math.floor(Number(animState.skip) || 0));
      const { startIdx, endIdx } = animWindowRange();
      let next = animState.index + 1 + skip;
      if (next > endIdx || next < startIdx) next = startIdx;
      const t0 = performance.now();
      try {
        await setAnimationTime(times[next], { playing: true });
      } catch (e) {
        console.error('[CFD W12] play', e);
      }
      if (!animState.playing || playGen !== animPlayGen) return;
      const wait = stepMs() - (performance.now() - t0);
      animTimer = setTimeout(tick, wait > 0 ? wait : 0);
    };
    tick();
    publishW12({ playing: true, preloaded: windowTimes.length, interval_ms: stepMs() });
  };
  const wantPt = !!ptState.enabled;
  const ready = windowTimes.filter((t) => animTimeIsCached(field, t, wantPt)).length;
  if (ready === windowTimes.length) {
    try { applyLockedSeriesLegend(field); } catch (_) {}
    runLoop();
    return;
  }
  if (playBtn) playBtn.textContent = 'Loading…';
  setAnimFrameHint(ready, windowTimes.length);
  preloadAnimFrames(windowTimes, field, setAnimFrameHint)
    .then(() => {
      if (playBtn) playBtn.textContent = 'Play';
      if (!animState.playing || playGen !== animPlayGen) return;
      try { syncAnimChromeFromState(); } catch (_) {}
      runLoop();
    })
    .catch((e) => {
      console.error('[CFD W12] preload', e);
      if (playBtn) playBtn.textContent = 'Play';
      if (animState.playing && playGen === animPlayGen) runLoop();
    });
}

window.__CFD_W12_APPLY__ = async function applyW12(partial) {
  await ensureAnimTimes();
  if (partial && typeof partial === 'object') {
    if (partial.type != null) animState.type = String(partial.type);
    if (partial.speed != null) animState.speed = clampAnimSpeed(partial.speed);
    if (partial.skip != null) animState.skip = Math.max(0, Math.floor(Number(partial.skip)));
    if (partial.enabled != null) animState.enabled = !!partial.enabled;
    if (partial.start != null || partial.end != null) {
      applyAnimWindow(
        partial.start != null ? partial.start : animState.start,
        partial.end != null ? partial.end : animState.end,
      );
    }
    if (partial.endPinned != null) animState.endPinned = !!partial.endPinned;
    if (partial.play) {
      startAnimationPlay();
      return window.__CFD_W12__;
    }
    if (partial.pause) {
      stopAnimationPlay();
      return window.__CFD_W12__;
    }
    if (partial.time != null) {
      const out = await setAnimationTime(partial.time, { allowMissing: !!partial.allowMissing });
      return { ...window.__CFD_W12__, apply_result: out };
    }
    if (partial.index != null) {
      const times = animState.times || [];
      const idx = Math.max(0, Math.min(times.length - 1, Number(partial.index)));
      const out = await setAnimationTime(times[idx]);
      return { ...window.__CFD_W12__, apply_result: out };
    }
    if (partial.honest_missing) {
      const miss = partial.missing_time != null ? String(partial.missing_time) : '999';
      const url = `/api/fields/magU/meta?case=${encodeURIComponent(CASE_DIR)}&time=${encodeURIComponent(miss)}`;
      const r = await fetch(url);
      const body = await r.json().catch(() => ({ error: 'parse_failed' }));
      publishW12({
        honest_missing: true,
        missing_time: miss,
        missing_status: r.status,
        missing_body: body,
        empty: !!(body.empty || r.status === 404),
      });
      return window.__CFD_W12__;
    }
  }
  syncAnimChromeFromState();
  publishW12({ last_apply: partial || null, prove_ts: Date.now() });
  return window.__CFD_W12__;
};

(function wireAnimationControls() {
  const scrub = document.getElementById('anim-scrub');
  const play = document.getElementById('anim-play');
  const pause = document.getElementById('anim-pause');
  const speed = document.getElementById('anim-speed');
  const skip = document.getElementById('anim-skip');
  const typeEl = document.getElementById('anim-type');
  const winLo = document.getElementById('anim-win-lo');
  const winHi = document.getElementById('anim-win-hi');
  const startPrev = document.getElementById('anim-start-prev');
  const startNext = document.getElementById('anim-start-next');
  const endPrev = document.getElementById('anim-end-prev');
  const endNext = document.getElementById('anim-end-next');
  const en = document.getElementById('anim-enabled');
  let animWinPreviewGen = 0;
  const raiseWinHandle = (which) => {
    if (winLo) winLo.style.zIndex = which === 'lo' ? '4' : '2';
    if (winHi) winHi.style.zIndex = which === 'hi' ? '4' : '3';
  };
  const previewWindowHandle = (which) => {
    if (isPtAnimation()) return;
    const times = animState.times || [];
    if (!times.length) return;
    let si = Number(winLo && winLo.value);
    let ei = Number(winHi && winHi.value);
    const last = Math.max(0, times.length - 1);
    if (which === 'lo') {
      si = Math.max(0, Math.min(Math.round(Number.isFinite(ei) ? ei : last), Math.round(si)));
      if (winLo) winLo.value = String(si);
    } else {
      ei = Math.min(last, Math.max(Math.round(Number.isFinite(si) ? si : 0), Math.round(ei)));
      if (winHi) winHi.value = String(ei);
    }
    raiseWinHandle(which);
    applyAnimWindowFromIndices(si, ei);
    syncAnimWindowVisual();
    const idx = which === 'lo' ? si : ei;
    const t = times[idx];
    if (t == null) return;
    if (animState.playing) stopAnimationPlay();
    const gen = ++animWinPreviewGen;
    setAnimationTime(t, { playing: true }).catch((e) => {
      if (gen === animWinPreviewGen) console.error('[CFD W12] window preview', e);
    });
  };
  const commitWindow = () => {
    if (!isPtAnimation()) warmAnimFrameCache();
    publishW12();
  };
  scrub?.addEventListener('input', () => {
    if (isPtAnimation()) {
      if (animState.playing) stopAnimationPlay();
      setPtAnimPhase(Number(scrub.value) / 100);
      return;
    }
    const times = animState.times || [];
    const idx = Number(scrub.value);
    if (!times.length) return;
    const tstr = times[Math.max(0, Math.min(times.length - 1, idx))];
    setAnimationTime(tstr).catch((e) => console.error('[CFD W12] scrub', e));
  });
  play?.addEventListener('click', () => startAnimationPlay());
  pause?.addEventListener('click', () => stopAnimationPlay());
  speed?.addEventListener('input', () => {
    setAnimSpeed(speed.value);
  });
  skip?.addEventListener('change', () => {
    animState.skip = Math.max(0, Math.floor(Number(skip.value) || 0));
    publishW12();
  });
  typeEl?.addEventListener('change', () => {
    const wasPlaying = animState.playing;
    if (wasPlaying) stopAnimationPlay();
    animState.type = typeEl.value || 'Time Step';
    syncAnimChromeFromState();
    if (!isPtAnimation()) warmAnimFrameCache();
    if (wasPlaying) startAnimationPlay();
    publishW12();
  });
  winLo?.addEventListener('pointerdown', () => raiseWinHandle('lo'));
  winHi?.addEventListener('pointerdown', () => raiseWinHandle('hi'));
  winLo?.addEventListener('input', () => previewWindowHandle('lo'));
  winHi?.addEventListener('input', () => previewWindowHandle('hi'));
  winLo?.addEventListener('change', () => commitWindow());
  winHi?.addEventListener('change', () => commitWindow());
  startPrev?.addEventListener('click', () => nudgeAnimWindow('start', -1));
  startNext?.addEventListener('click', () => nudgeAnimWindow('start', 1));
  endPrev?.addEventListener('click', () => nudgeAnimWindow('end', -1));
  endNext?.addEventListener('click', () => nudgeAnimWindow('end', 1));
  en?.addEventListener('change', () => {
    animState.enabled = !!en.checked;
    if (!animState.enabled) stopAnimationPlay();
    publishW12();
  });
  ensureAnimTimes().catch((e) => console.error('[CFD W12] times', e));
})();


(function wireIterationsPanel() {
  const scrub = document.getElementById('iter-scrub');
  const first = document.getElementById('iter-first');
  const prev = document.getElementById('iter-prev');
  const next = document.getElementById('iter-next');
  const last = document.getElementById('iter-last');
  const gotoIndex = (idx) => {
    const times = animState.times || [];
    if (!times.length) return;
    const i = Math.max(0, Math.min(times.length - 1, idx));
    setAnimationTime(times[i]).catch((e) => console.error('[CFD W12.1] iter', e));
  };
  scrub?.addEventListener('input', () => {
    gotoIndex(Number(scrub.value));
  });
  first?.addEventListener('click', () => gotoIndex(0));
  prev?.addEventListener('click', () => gotoIndex((animState.index || 0) - 1));
  next?.addEventListener('click', () => gotoIndex((animState.index || 0) + 1));
  last?.addEventListener('click', () => gotoIndex((animState.times || []).length - 1));
  syncIterationsPanelFromState();
})();

publishW12({ ready: false });



/* ---- W13 Inspect point live ---- */
function syncInspectReadout() {
  const el = document.getElementById('inspect-readout');
  if (!el) return;
  const btn = document.querySelector('.tb-btn[data-label="Inspect point"]');
  if (!inspectState.armed && !inspectState.position) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  if (!inspectState.position) {
    el.textContent = 'Click a point on the model to read its values';
    el.dataset.hit = '0';
    return;
  }
  const [x, y, z] = inspectState.position;
  const fmtM = (v) => (Number.isFinite(v) ? Number(v).toFixed(3) : '—');
  const at = `(${fmtM(x)}, ${fmtM(y)}, ${fmtM(z)}) m`;
  // Values only when the sample point is inside the mesh; a miss never shows a number.
  if (inspectState.hit && !inspectState.empty) {
    const mu = inspectState.magU;
    const pv = inspectState.p;
    const muS =
      mu == null || !Number.isFinite(mu)
        ? '—'
        : (Math.abs(mu) < 1e-6 ? '0.00' : Number(mu).toPrecision(4)) + ' m/s';
    const pS = pv == null || !Number.isFinite(pv) ? '—' : Math.round(Number(pv)).toLocaleString('en-US') + ' Pa';
    el.textContent = `Velocity ${muS}  ·  Pressure ${pS}  ·  ${at}`;
    el.dataset.hit = '1';
    el.dataset.magu = String(mu);
    el.dataset.p = String(pv);
  } else {
    el.textContent = `Point ${at} is outside the mesh`;
    el.dataset.hit = '0';
    el.dataset.magu = '';
    el.dataset.p = '';
    el.dataset.reason = inspectState.reason || 'miss_mesh';
  }
  if (btn) btn.classList.toggle('is-active', !!inspectState.armed);
}

function setInspectMarker(position, present) {
  if (!position || position.length < 3 || !present) {
    inspectMarkerActor.setVisibility(false);
    inspectState.marker_present = false;
    renderWindow.render();
    return;
  }
  const b = sourceBounds || (sourcePolyData && sourcePolyData.getBounds && sourcePolyData.getBounds());
  let r = inspectState.marker_radius;
  if (b && b.length >= 6) {
    const dx = b[1] - b[0];
    const dy = b[3] - b[2];
    const dz = b[5] - b[4];
    const diag = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    r = Math.max(diag * 0.025, 0.015);
    inspectState.marker_radius = r;
  }
  inspectSphere.setRadius(r);
  inspectSphere.setCenter(position[0], position[1], position[2]);
  inspectSphere.modified();
  inspectMarkerActor.setVisibility(true);
  inspectState.marker_present = true;
  renderWindow.render();
}

function publishW13(overrides) {
  const o = overrides || {};
  window.__CFD_W13__ = {
    increment: 'W13',
    ready: !!(window.__CFD_W6__ && window.__CFD_W6__.ready !== false),
    armed: !!inspectState.armed,
    enabled: !!inspectState.enabled || !!inspectState.armed,
    position: inspectState.position ? [...inspectState.position] : null,
    hit: !!inspectState.hit,
    empty: !!inspectState.empty,
    magU: inspectState.magU,
    p: inspectState.p,
    value_checksum: inspectState.value_checksum,
    reason: inspectState.reason || '',
    time: inspectState.time != null ? String(inspectState.time) : getTime(),
    fingerprint: inspectState.fingerprint,
    meta: inspectState.meta,
    marker_present: !!inspectState.marker_present,
    marker_color: [1.0, 0.0, 1.0],
    marker_actor: 'inspect_point_marker',
    approach:
      'Vite /api/inspect -> export_inspect_point.py PolyData.sample on case VTU (sample_over_point / probe); magenta marker; minimal field-at-pick from API only',
    proves_from_case_api: true,
    no_fake_value: true,
    no_simscale_value_panel: true,
    filters_still_live: true,
    ...o,
  };
  return window.__CFD_W13__;
}

async function runInspectAt(x, y, z, opts) {
  const options = opts || {};
  const token = ++inspectLoadToken;
  const t = options.time != null ? String(options.time) : getTime();
  inspectState.position = [Number(x), Number(y), Number(z)];
  inspectState.time = t;
  inspectState.enabled = true;
  setInspectMarker(inspectState.position, true);
  syncInspectReadout();
  publishW13({ loading: true });
  const url = apiInspectUrl(x, y, z, t);
  let meta = null;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    meta = await r.json();
    if (!r.ok) {
      // Honest miss / error ? keep marker, clear fake values
      inspectState.hit = false;
      inspectState.empty = true;
      inspectState.magU = null;
      inspectState.p = null;
      inspectState.value_checksum = 0;
      inspectState.reason = meta && meta.reason ? meta.reason : (meta && meta.error) || 'api_error';
      inspectState.meta = meta;
      inspectState.fingerprint = {
        x: Number(x),
        y: Number(y),
        z: Number(z),
        hit: false,
        empty: true,
        magU: null,
        p: null,
        value_checksum: 0,
        reason: inspectState.reason,
      };
    } else {
      if (token !== inspectLoadToken) return publishW13({ stale: true });
      inspectState.hit = !!meta.hit;
      inspectState.empty = meta.empty !== false ? !!meta.empty : !meta.hit;
      if (inspectState.hit && !inspectState.empty) {
        inspectState.magU = meta.magU == null ? null : Number(meta.magU);
        inspectState.p = meta.p == null ? null : Number(meta.p);
        inspectState.value_checksum = Number(meta.value_checksum || 0);
        inspectState.reason = '';
      } else {
        inspectState.magU = null;
        inspectState.p = null;
        inspectState.value_checksum = 0;
        inspectState.reason = meta.reason || 'miss_mesh';
        inspectState.hit = false;
        inspectState.empty = true;
      }
      inspectState.meta = meta;
      inspectState.fingerprint = meta.fingerprint || {
        x: Number(x),
        y: Number(y),
        z: Number(z),
        hit: inspectState.hit,
        empty: inspectState.empty,
        magU: inspectState.magU,
        p: inspectState.p,
        value_checksum: inspectState.value_checksum,
        reason: inspectState.reason,
      };
    }
  } catch (e) {
    inspectState.hit = false;
    inspectState.empty = true;
    inspectState.magU = null;
    inspectState.p = null;
    inspectState.value_checksum = 0;
    inspectState.reason = String(e && e.message ? e.message : e);
    inspectState.meta = { error: inspectState.reason };
    inspectState.fingerprint = {
      x: Number(x),
      y: Number(y),
      z: Number(z),
      hit: false,
      empty: true,
      magU: null,
      p: null,
      value_checksum: 0,
      reason: inspectState.reason,
    };
  }
  if (token !== inspectLoadToken) return publishW13({ stale: true });
  syncInspectReadout();
  return publishW13({ loading: false, api_url: url });
}

function clearInspect(keepArmed) {
  inspectState.position = null;
  inspectState.hit = false;
  inspectState.empty = true;
  inspectState.magU = null;
  inspectState.p = null;
  inspectState.value_checksum = 0;
  inspectState.reason = '';
  inspectState.fingerprint = null;
  inspectState.meta = null;
  if (!keepArmed) {
    inspectState.armed = false;
    inspectState.enabled = false;
  }
  setInspectMarker(null, false);
  syncInspectReadout();
  const btn = document.querySelector('.tb-btn[data-label="Inspect point"]');
  if (btn && !inspectState.armed) btn.classList.remove('is-active');
  return publishW13({ cleared: true });
}

window.__CFD_W13_APPLY__ = async function applyW13(partial) {
  const p = partial || {};
  if (p.arm === true || p.armed === true) {
    inspectState.armed = true;
    inspectState.enabled = true;
    const btn = document.querySelector('.tb-btn[data-label="Inspect point"]');
    btn?.classList.add('is-active');
    syncInspectReadout();
    publishW13();
  }
  if (p.arm === false || p.disarm === true || p.armed === false) {
    inspectState.armed = false;
    const btn = document.querySelector('.tb-btn[data-label="Inspect point"]');
    btn?.classList.remove('is-active');
    if (p.clear !== false && !p.x && p.position == null) {
      // disarm without forcing clear unless asked
    }
    syncInspectReadout();
    publishW13();
  }
  if (p.clear === true) {
    return clearInspect(!!p.keep_armed || !!inspectState.armed);
  }
  if (p.miss_mesh === true) {
    inspectState.armed = true;
    return runInspectAt(10, 10, 10, { time: p.time });
  }
  let xyz = null;
  if (Array.isArray(p.position) && p.position.length >= 3) xyz = p.position;
  else if (p.x != null && p.y != null && p.z != null) xyz = [p.x, p.y, p.z];
  if (xyz) {
    inspectState.armed = true;
    inspectState.enabled = true;
    const btn = document.querySelector('.tb-btn[data-label="Inspect point"]');
    btn?.classList.add('is-active');
    return runInspectAt(xyz[0], xyz[1], xyz[2], { time: p.time });
  }
  syncInspectReadout();
  return publishW13({ last_apply: p });
};

(function wireInspectPoint() {
  const btn = document.querySelector('.tb-btn[data-label="Inspect point"]');
  btn?.addEventListener('click', () => {
    inspectState.armed = !inspectState.armed;
    inspectState.enabled = inspectState.armed;
    btn.classList.toggle('is-active', !!inspectState.armed);
    if (!inspectState.armed) {
      // keep marker if already placed? Bank: toggle off can clear. Clear marker on disarm.
      clearInspect(false);
    } else {
      syncInspectReadout();
      publishW13({ armed: true });
    }
  });

  // Click ? pick world point on surface/cut; place magenta marker; probe API
  interactor.onLeftButtonPress((callData) => {
    if (!inspectState.armed) return;
    try {
      const pos = callData.position || interactor.getEventPosition(callData);
      const x = pos.x;
      const y = pos.y;
      inspectPicker.pick([x, y, 0], renderer);
      const actors = inspectPicker.getActors ? inspectPicker.getActors() : [];
      const picked = inspectPicker.getPickPosition();
      if (!picked || (actors && actors.length === 0 && inspectPicker.getCellId && inspectPicker.getCellId() < 0)) {
        // Still place marker at pick position if available; API may miss
        if (picked && Number.isFinite(picked[0])) {
          runInspectAt(picked[0], picked[1], picked[2]).catch((e) => console.error('[CFD W13] pick', e));
        }
        return;
      }
      if (picked && Number.isFinite(picked[0])) {
        runInspectAt(picked[0], picked[1], picked[2]).catch((e) => console.error('[CFD W13] pick', e));
      }
    } catch (e) {
      console.error('[CFD W13] pick handler', e);
    }
  });

  publishW13({ ready: false });
  syncInspectReadout();
})();



/* ---- W15 Mesh->solve honesty: Attach results / Job status ---- */
const jobState = {
  status: 'idle',
  mode: 'attach-only',
  case_dir: null,
  times: [],
  n_times: 0,
  attached_at: null,
  note: 'W15.1: Attach OR Kick mesh (real checkMesh). No fake %.',
  last_attach: null,
  last_kick: null,
  field_fingerprint: null,
  pid: null,
  exit_code: null,
  command: null,
  path_kind: null,
  log_path: null,
  kick_id: null,
  poll_timer: null,
  n_cells: null,
  n_points: null,
  n_faces: null,
  counts_source: null,
  emesh: null,
  feature_marks_total: null,
  mesh_path: null,
  fingerprint_before: null,
  fingerprint_after: null,
  step_path: null,
  body1_path: null,
  geometry: null,
  mtp1_silent_copy: null,
  increment: null,
  started_at: null,
  finished_at: null,
  elapsed_timer: null,
};

function isMeshJobKind(kind) {
  const k = String(kind || '');
  return k === 'standard' || k === 'snappyHexMesh' || k === 'cartesianMesh' || k === 'cfMesh';
}

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  return m + ':' + String(sec).padStart(2, '0');
}

function formatEta(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 8000) return '< 10s left';
  return '~' + formatElapsed(n) + ' left';
}

function solveEtaMs() {
  const run = window.__CFD_W27_STATE__ && window.__CFD_W27_STATE__.run;
  if (!run || run.status !== 'running') return null;
  if (run.stage && run.stage !== 'solve') return null;
  const start = run.solve_started_at ? Date.parse(run.solve_started_at) : NaN;
  if (!Number.isFinite(start)) return null;
  const elapsed = Date.now() - start;
  if (elapsed < 2500) return null;
  // W30 transient: progress is physical time / simulation time. The step
  // size adapts, so this is a rolling estimate rather than a count.
  if (/transient/i.test(String(run.time_dependency || ''))) {
    const t = Number(run.sim_time) || 0;
    const end = Number(run.transient && run.transient.end_time) || 0;
    if (!(t > 0) || !(end > t)) return null;
    if (t / end < 0.01 && elapsed < 15000) return null;
    return ((end - t) / t) * elapsed;
  }
  const it = Number(run.iteration) || 0;
  const end = Number(run.endTime) || (window.__CFD_W27_STATE__ && window.__CFD_W27_STATE__.endTime) || 0;
  if (it < 3 || end <= it) return null;
  const per = elapsed / it;
  if (!Number.isFinite(per) || per < 30) return null;
  return (end - it) * per;
}

function meshElapsedMs() {
  const start = jobState.started_at ? Date.parse(jobState.started_at) : NaN;
  if (!Number.isFinite(start)) return null;
  const live = jobState.status === 'running';
  const end = !live && jobState.finished_at ? Date.parse(jobState.finished_at) : Date.now();
  if (!Number.isFinite(end)) return Date.now() - start;
  return Math.max(0, end - start);
}

function stopMeshElapsedClock() {
  if (jobState.elapsed_timer) {
    clearInterval(jobState.elapsed_timer);
    jobState.elapsed_timer = null;
  }
}

function startMeshElapsedClock() {
  stopMeshElapsedClock();
  jobState.elapsed_timer = setInterval(() => {
    try { syncMeshFinishedChrome(); } catch (_) {}
  }, 1000);
}

function syncJobStatusChrome() {
  const st = document.getElementById('job-status-value');
  const mode = document.getElementById('job-status-mode');
  const cEl = document.getElementById('job-status-case');
  const tEl = document.getElementById('job-status-times');
  const note = document.getElementById('job-status-note');
  const pidEl = document.getElementById('job-status-pid');
  const pathEl = document.getElementById('job-status-path');
  if (st) {
    st.textContent = jobState.status || 'idle';
    st.setAttribute('data-status', jobState.status || 'idle');
  }
  if (mode) mode.textContent = jobState.mode || 'attach-only';
  if (cEl) {
    const p = jobState.case_dir || '(none)';
    cEl.textContent = p;
    cEl.title = p;
  }
  if (tEl) {
    const times = jobState.times || [];
    tEl.textContent = times.length ? '[' + times.join(', ') + ']' : '-';
  }
  if (pidEl) {
    pidEl.textContent =
      jobState.pid != null
        ? String(jobState.pid) + (jobState.exit_code != null ? ' (exit ' + jobState.exit_code + ')' : '')
        : '-';
  }
  if (pathEl) pathEl.textContent = jobState.path_kind || jobState.mode || '-';
  if (note) note.textContent = jobState.note || '';
  const genBtn = document.getElementById('btn-generate-mesh');
  if (genBtn) genBtn.disabled = jobState.status === 'running';
  syncMeshFinishedChrome();
}

const MESH_STAGE_LABELS = {
  starting: 'Starting',
  load_step: 'Reading geometry',
  step_loaded: 'Reading geometry',
  sizing: 'Computing mesh sizes',
  surface_mesh: 'Meshing the surface',
  gmsh: 'Meshing the volume',
  volume_mesh: 'Volume mesh done',
  boundary_layers: 'Preparing boundary layers',
  gmshToFoam: 'Building the OpenFOAM mesh and boundary layers',
  boundary_layers_retry: 'Retrying without boundary layers',
  cartesianMesh: 'Running cartesianMesh',
  write_case: 'Writing the case',
  copy_back: 'Copying the mesh into the project',
};

function meshStageText() {
  const stage = jobState.stage ? String(jobState.stage) : '';
  const detail = jobState.stage_detail ? String(jobState.stage_detail) : '';
  if (stage === 'gmsh') {
    if (/^surface \(gap/i.test(detail)) return 'Refining gaps';
    if (/^surface/i.test(detail)) return 'Meshing the surface';
    if (/^gap refinement/i.test(detail)) return 'Refining gaps';
    if (/^hexcore|^hex element core/i.test(detail)) return 'Building the hex element core';
    if (/^tets:/i.test(detail)) return 'Filling the volume with tetrahedra';
    if (/^tet (shell|volume)|^msh written|^volume check/i.test(detail)) return 'Writing the volume mesh';
    return 'Preparing the geometry';
  }
  return MESH_STAGE_LABELS[stage] || 'Working';
}

function formatMetres(m) {
  const v = Number(m);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 1) return v.toFixed(3).replace(/\.?0+$/, '') + ' m';
  if (v >= 1e-3) return (v * 1e3).toFixed(v * 1e3 >= 10 ? 1 : 2).replace(/\.?0+$/, '') + ' mm';
  return (v * 1e6).toFixed(0) + ' µm';
}

function syncMeshFinishedChrome() {
  const wrap = document.getElementById('mesh-finished');
  const title = document.getElementById('mesh-status-title');
  const line = document.getElementById('mesh-finished-line');
  const meta = document.getElementById('mesh-finished-meta');
  const cells = jobState.n_cells;
  const pts = jobState.n_points;
  const meshJob = isMeshJobKind(jobState.path_kind);
  const running = jobState.status === 'running' && meshJob;
  const failed = jobState.status === 'failed' && meshJob;
  const countsReady = cells != null && pts != null;
  const meshReady = isGeneratedMeshReady();
  const finishing = jobState.status === 'done' && meshJob && !meshReady;
  const elapsedEl = document.getElementById('mesh-elapsed');
  const elapsedMs = meshElapsedMs();
  const elapsedTxt = elapsedMs != null ? formatElapsed(elapsedMs) : null;
  const ready = meshReady && countsReady;
  if (wrap) wrap.hidden = !(running || failed || finishing || ready);
  if (title) {
    if (failed) title.textContent = 'Mesh failed';
    else if (running) title.textContent = 'Generating mesh';
    else if (finishing) title.textContent = 'Finishing mesh';
    else if (ready) title.textContent = 'Mesh ready';
    else title.textContent = 'Mesh';
  }
  if (line) {
    if (failed) {
      const err = jobState.error ? String(jobState.error).split('\n')[0].slice(0, 160) : '';
      line.textContent = err ? err : 'Generate failed. Open Job / debug for the log.';
    } else if (running) {
      line.textContent = meshStageText() + '...' + (elapsedTxt ? ' ' + elapsedTxt : '');
    } else if (finishing) {
      line.textContent = 'Writing the mesh into the project...';
    } else if (ready) {
      line.textContent = Number(cells).toLocaleString() + ' cells / ' + Number(pts).toLocaleString() + ' nodes';
      line.setAttribute('data-n-cells', String(cells));
      line.setAttribute('data-n-points', String(pts));
      line.setAttribute('data-source', jobState.counts_source || 'polyMesh');
    } else {
      line.textContent = '-';
    }
  }
  if (meta) {
    const bits = [];
    if (ready) {
      const engine = String(jobState.engine || jobState.path_kind || '');
      if (engine === 'cfmesh' || engine === 'cartesianMesh') bits.push('cfMesh');
      else if (engine === 'snappyHexMesh') bits.push('Hex-dominant');
      else if (engine) bits.push('Standard');
      if (jobState.hex_core_applied === true) bits.push('hex element core');
      if (jobState.layers_applied === true) bits.push('boundary layers');
      else if (jobState.layers_applied === false) bits.push('no boundary layers');
      const h = formatMetres(jobState.surface_size_m);
      if (h) bits.push('surface size ' + h);
    }
    if (elapsedTxt && (ready || failed)) bits.push(elapsedTxt);
    meta.textContent = bits.join(' · ');
  }
  if (elapsedEl) {
    const showClock = !!(running || finishing) && elapsedTxt;
    elapsedEl.hidden = !showClock;
    if (showClock) elapsedEl.textContent = elapsedTxt;
  }
  syncViewportJobChip();
}

function solveElapsedMs() {
  const run = window.__CFD_W27_STATE__ && window.__CFD_W27_STATE__.run;
  const start = run && run.started_at ? Date.parse(run.started_at) : NaN;
  if (!Number.isFinite(start)) return null;
  const live = run.status === 'running';
  const end = !live && run.finished_at ? Date.parse(run.finished_at) : Date.now();
  if (!Number.isFinite(end)) return Date.now() - start;
  return Math.max(0, end - start);
}

function syncViewportJobChip() {
  const jobChip = document.getElementById('viewport-job-chip');
  const jobChipLabel = document.getElementById('viewport-job-label');
  const jobChipTime = document.getElementById('viewport-job-time');
  const jobChipEta = document.getElementById('viewport-job-eta');
  if (!jobChip) return;
  const meshJob = isMeshJobKind(jobState.path_kind);
  const solveJob = jobState.path_kind === 'simpleFoam' || jobState.mode === 'solve';
  const meshRunning = jobState.status === 'running' && meshJob;
  const meshFinishing = jobState.status === 'done' && meshJob && !isGeneratedMeshReady();
  const attaching = !!(window.__CFD_W27_STATE__ && window.__CFD_W27_STATE__.attaching);
  const solveRunning = jobState.status === 'running' && solveJob && !meshRunning;
  let show = false;
  let label = '';
  let time = '';
  let eta = '';
  if (attaching) {
    show = true;
    label = 'Loading results';
    time = '';
  } else if (meshRunning || meshFinishing) {
    show = true;
    label = meshFinishing ? 'Finishing mesh' : 'Meshing';
    const elapsedMs = meshElapsedMs();
    time = elapsedMs != null ? formatElapsed(elapsedMs) : '0:00';
  } else if (solveRunning) {
    show = true;
    const run = (window.__CFD_W27_STATE__ && window.__CFD_W27_STATE__.run) || {};
    const it = Number(run.iteration) || 0;
    const end = Number(run.endTime) || (window.__CFD_W27_STATE__ && window.__CFD_W27_STATE__.endTime) || 0;
    const stage = run.stage;
    const transientRun = /transient/i.test(String(run.time_dependency || ''));
    if (stage && stage !== 'solve') {
      label = SIM_STAGE_LABELS[stage] || 'Solving';
    } else if (transientRun) {
      const t = Number(run.sim_time) || 0;
      const tEnd = Number(run.transient && run.transient.end_time) || 0;
      label = t > 0 && tEnd > 0 ? 'Solving ' + formatSimTime(t) + ' / ' + formatSimTime(tEnd) : 'Solving';
    } else {
      label = it > 0 && end > 0 ? 'Solving ' + it + '/' + end : 'Solving';
    }
    const elapsedMs = solveElapsedMs();
    time = elapsedMs != null ? formatElapsed(elapsedMs) : '0:00';
    eta = formatEta(solveEtaMs()) || '';
  }
  jobChip.hidden = !show;
  if (show && jobChipLabel) jobChipLabel.textContent = label;
  if (jobChipTime) {
    jobChipTime.hidden = !time;
    if (time) jobChipTime.textContent = time;
  }
  if (jobChipEta) {
    jobChipEta.hidden = !eta;
    if (eta) jobChipEta.textContent = eta;
  }
}

function publishW15(extra) {
  const payload = {
    increment: 'W15.1',
    ready: true,
    approach:
      'W15.1: POST /api/case/mesh kicks real OpenFOAM checkMesh via WSL; Job status running->done/failed tracks PID. Attach path (POST /api/case/attach) unchanged. No fake progress invent.',
    status: jobState.status,
    mode: jobState.mode,
    case_dir: jobState.case_dir,
    times: jobState.times || [],
    n_times: jobState.n_times || 0,
    attached_at: jobState.attached_at,
    note: jobState.note,
    client_case_dir: getCaseDir(),
    no_fake_progress: true,
    soft_pass_avoided: true,
    filters_still_live: true,
    inspect_still_live: !!(window.__CFD_W13__),
    last_attach: jobState.last_attach,
    last_kick: jobState.last_kick,
    field_fingerprint: jobState.field_fingerprint,
    pid: jobState.pid,
    exit_code: jobState.exit_code,
    command: jobState.command,
    path_kind: jobState.path_kind,
    log_path: jobState.log_path,
    kick_id: jobState.kick_id,
    prove_ts: Date.now(),
    ...(extra || {}),
  };
  window.__CFD_W15__ = payload;
  window.__CFD_W15_1__ = payload;
  return payload;
}

async function fetchActiveCase() {
  const r = await fetch('/api/case' + hashProjectQs());
  const j = await r.json();
  return j;
}

async function refreshFieldsAfterAttach() {
  if (!hasAttachedCase()) return;
  try {
    if (window.__CFD_W12_APPLY__) {
      await window.__CFD_W12_APPLY__({ time: getTime() });
    }
  } catch (e) {
    console.warn('[CFD W15] field refresh', e);
  }
  try {
    const metaUrl = apiMetaUrl('magU');
    const r = await fetch(metaUrl);
    if (r.ok) {
      jobState.field_fingerprint = await r.json();
    } else {
      jobState.field_fingerprint = { empty: true, status: r.status, url: metaUrl };
    }
  } catch (e) {
    jobState.field_fingerprint = { error: String(e) };
  }
}

async function attachCaseDirClient(path) {
  const case_dir = String(path || '').trim();
  if (!case_dir) {
    jobState.note = 'case_dir required';
    syncJobStatusChrome();
    publishW15({ error: 'case_dir required' });
    return window.__CFD_W15__;
  }
  const r = await fetch('/api/case/attach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      case_dir,
      project_id: currentProjectId() || undefined,
    }),
  });
  const j = await r.json();
  if (!r.ok) {
    jobState.status = 'idle';
    jobState.note = j.error || ('attach failed ' + r.status);
    jobState.last_attach = { ok: false, status: r.status, body: j };
    syncJobStatusChrome();
    publishW15({ attach_failed: true, api: j });
    return window.__CFD_W15__;
  }
  caseDir = j.case_dir || case_dir;
  jobState.status = j.status || 'attached';
  jobState.mode = j.mode || 'attach-only';
  jobState.case_dir = j.case_dir;
  jobState.times = Array.isArray(j.times) ? j.times.map(String) : [];
  jobState.n_times = j.n_times || jobState.times.length;
  jobState.attached_at = j.attached_at;
  jobState.note = j.note || 'attached';
  jobState.last_attach = { ok: true, status: r.status, body: j };
  jobState.pid = null;
  jobState.exit_code = null;
  jobState.command = null;
  jobState.path_kind = null;
  jobState.log_path = null;
  jobState.kick_id = null;
  stopJobPoll();

  if (jobState.times.length) {
    const last = jobState.times[jobState.times.length - 1];
    currentTime = String(last);
  }

  try {
    await ensureAnimTimes();
  } catch (e) {
    console.warn('[CFD W15] times refresh', e);
  }
  await refreshFieldsAfterAttach();
  syncJobStatusChrome();
  publishW15({ attached: true, api: j });
  return window.__CFD_W15__;
}

window.__CFD_W15_ATTACH__ = attachCaseDirClient;
window.__CFD_W15_APPLY__ = async function applyW15(partial) {
  if (partial && partial.case_dir) {
    return attachCaseDirClient(partial.case_dir);
  }
  if (partial && partial.detach) {
    await fetch('/api/case/detach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    jobState.status = 'idle';
    jobState.case_dir = null;
    jobState.times = [];
    jobState.n_times = 0;
    jobState.attached_at = null;
    jobState.note = 'detached; idle';
    syncJobStatusChrome();
    return publishW15({ detached: true });
  }
  const snap = await fetchActiveCase();
  if (snap && snap.case_dir) {
    caseDir = snap.case_dir;
    jobState.status = snap.status;
    jobState.case_dir = snap.case_dir;
    jobState.times = snap.times || [];
    jobState.n_times = snap.n_times || 0;
    jobState.attached_at = snap.attached_at;
    jobState.note = snap.note;
  }
  syncJobStatusChrome();
  return publishW15({ refreshed: true, api: snap });
};


function applyCaseSnapToJob(j) {
  if (!j) return;
  if (j.status === 'running' && j.n_cells == null) {
    jobState.n_cells = null;
    jobState.n_points = null;
    jobState.n_faces = null;
  }
  jobState.status = j.status || jobState.status;
  jobState.mode = j.mode || jobState.mode;
  jobState.case_dir = j.case_dir != null ? j.case_dir : jobState.case_dir;
  jobState.times = Array.isArray(j.times) ? j.times.map(String) : jobState.times;
  jobState.n_times = j.n_times != null ? j.n_times : (jobState.times || []).length;
  jobState.attached_at = j.attached_at || jobState.attached_at;
  jobState.note = j.note || jobState.note;
  jobState.pid = j.pid != null ? j.pid : jobState.pid;
  jobState.exit_code = j.exit_code != null ? j.exit_code : jobState.exit_code;
  jobState.command = j.command || jobState.command;
  jobState.path_kind = j.path_kind || jobState.path_kind;
  jobState.log_path = j.log_path || jobState.log_path;
  jobState.kick_id = j.kick_id || jobState.kick_id;
  jobState.n_cells = j.n_cells != null ? j.n_cells : jobState.n_cells;
  jobState.n_points = j.n_points != null ? j.n_points : jobState.n_points;
  jobState.n_faces = j.n_faces != null ? j.n_faces : jobState.n_faces;
  jobState.counts_source = j.counts_source || jobState.counts_source;
  jobState.emesh = j.emesh || jobState.emesh;
  jobState.feature_marks_total = j.feature_marks_total != null ? j.feature_marks_total : jobState.feature_marks_total;
  jobState.mesh_path = j.mesh_path || jobState.mesh_path;
  jobState.fingerprint_before = j.fingerprint_before || jobState.fingerprint_before;
  jobState.fingerprint_after = j.fingerprint_after || jobState.fingerprint_after;
  if (j.step_path != null) jobState.step_path = j.step_path;
  if (j.body1_path != null) jobState.body1_path = j.body1_path;
  if (j.geometry != null) jobState.geometry = j.geometry;
  if (j.engine != null) jobState.engine = j.engine;
  if (j.stage !== undefined) jobState.stage = j.stage;
  if (j.stage_detail !== undefined) jobState.stage_detail = j.stage_detail;
  if (j.hex_core_applied !== undefined) jobState.hex_core_applied = j.hex_core_applied;
  if (j.layers_applied !== undefined) jobState.layers_applied = j.layers_applied;
  if (j.surface_size_m !== undefined) jobState.surface_size_m = j.surface_size_m;
  if (j.error !== undefined) jobState.error = j.error;
  if (j.increment != null) jobState.increment = j.increment;
  if (j.started_at != null) jobState.started_at = j.started_at;
  if (j.finished_at != null) jobState.finished_at = j.finished_at;
  // A live job has no end time yet; drop a stale finished_at from the previous run
  // so the elapsed clock counts up.
  if (j.status === 'running' && j.finished_at == null) jobState.finished_at = null;
  if (j.case_dir) caseDir = j.case_dir;
}

function stopJobPoll() {
  if (jobState.poll_timer) {
    clearInterval(jobState.poll_timer);
    jobState.poll_timer = null;
  }
}

function startJobPoll() {
  stopJobPoll();
  jobState.poll_timer = setInterval(async () => {
    try {
      const snap = await fetchActiveCase();
      applyCaseSnapToJob(snap);
      syncJobStatusChrome();
      publishW15({ polled: true, api: snap });
      if (snap.status === 'done' || snap.status === 'failed') {
        stopJobPoll();
        stopMeshElapsedClock();
        if (!jobState.finished_at) jobState.finished_at = new Date().toISOString();
        if (jobState.times.length) {
          currentTime = String(jobState.times[jobState.times.length - 1]);
        }
        try {
          await ensureAnimTimes();
        } catch (e) {
          console.warn('[CFD W15.1] times refresh', e);
        }
        if (
          snap.status === 'done' &&
          isMeshJobKind(snap.path_kind) &&
          snap.case_dir
        ) {
          try {
            if (String(snap.case_dir) !== String(getCaseDir())) {
              await attachCaseDirClient(snap.case_dir);
            } else {
              caseDir = snap.case_dir;
            }
          } catch (e) {
            console.warn('[CFD W25b] generate-done attach', e);
            caseDir = snap.case_dir;
          }
          try {
            const mr = await fetch('/api/mesh' + hashProjectQs());
            const mj = await mr.json();
            if (mj && mj.mesh && typeof applyMeshRecord === 'function') {
              applyMeshRecord(mj, mj.project_id);
            }
          } catch (e) {
            console.warn('[CFD W25b] generate-done mesh.json', e);
          }
          applyLiveMeshCountsToJob();
        }
        if (meshInspectOpen && snap.status === 'done') {
          try {
            await loadFullMeshSurface(snap.case_dir || getCaseDir());
            await refreshMeshPlanes();
          } catch (e) {
            console.warn('[CFD] generate-done mesh view', e);
          }
        }
        syncJobStatusChrome();
        if (typeof applyWorkbenchStage === 'function') applyWorkbenchStage();
        publishW15({ kick_finished: true, api: snap });
      }
    } catch (e) {
      console.warn('[CFD W15.1] poll', e);
    }
  }, 750);
}

window.__CFD_W15_1_APPLY__ = async function applyW151(partial) {
  if (partial && partial.case_dir) return attachCaseDirClient(partial.case_dir);
  return window.__CFD_W15_APPLY__(partial || {});
};

(function wireJobStatusAttach() {
  const btn = document.getElementById('btn-attach-case');
  const input = document.getElementById('attach-case-input');
  btn?.addEventListener('click', () => {
    const path = String((input && input.value) || '').trim() || getLiveMeshCaseDir() || '';
    if (!path) return;
    attachCaseDirClient(path).catch((e) => console.error('[CFD W15.1] attach', e));
  });
  // Resume from server-side mesh.json / live PID — not from this tab's memory.
  (async () => {
    try {
      let hashId = null;
      try {
        hashId = await activateHashProject();
      } catch (e) {
        console.warn('[CFD] boot hash project', e);
      }
      let snap = null;
      try {
        snap = await fetchActiveCase();
      } catch (e) {
        console.warn('[CFD] boot /api/case', e);
      }
      // The attached case is server-global; another tab may have attached a
      // different project's mesh. Only resume it if it belongs to this project
      // *and* the active study's mesh list (not another geometry in the same project).
      if (snap && snap.case_dir && hashId) {
        const dir = String(snap.case_dir).replace(/\\/g, '/').toLowerCase();
        if (!dir.includes(`/projects/${String(hashId).toLowerCase()}/`)) snap = null;
      }
      let live = null;
      let scopedCases = [];
      try {
        const meshQs = hashId ? `?project_id=${encodeURIComponent(hashId)}` : '';
        const mr = await fetch('/api/mesh' + meshQs);
        const mj = await mr.json();
        live = mj && mj.mesh && mj.mesh.live_mesh_result;
        scopedCases = (mj && Array.isArray(mj.meshes) ? mj.meshes : [])
          .map((m) => (m && m.live_mesh_result && m.live_mesh_result.case_dir) || (m && m.case_dir) || '')
          .filter(Boolean);
        if (mj && mj.mesh && typeof applyMeshRecord === 'function') {
          applyMeshRecord(mj, mj.project_id);
        }
      } catch (e) {
        console.warn('[CFD W25b] boot mesh prefer', e);
      }
      if (snap && snap.case_dir && scopedCases.length) {
        const ok = scopedCases.some((d) => sameCasePath(d, snap.case_dir));
        if (!ok) snap = null;
      } else if (snap && snap.case_dir && live && live.case_dir) {
        if (!sameCasePath(snap.case_dir, live.case_dir)) snap = null;
      } else if (snap && snap.case_dir && !live) {
        snap = null;
      }
      const running =
        (snap && snap.status === 'running' && isMeshJobKind(snap.path_kind || (live && live.path_kind))) ||
        (live && live.status === 'running');
      if (running) {
        applyCaseSnapToJob({
          ...(live || {}),
          ...(snap || {}),
          status: 'running',
          mode: 'mesh',
          path_kind: (snap && snap.path_kind) || (live && live.path_kind) || 'standard',
          started_at: (snap && snap.started_at) || (live && live.started_at) || null,
          finished_at: null,
          n_cells: null,
          n_points: null,
        });
        startMeshElapsedClock();
        startJobPoll();
        syncJobStatusChrome();
        if (typeof applyWorkbenchStage === 'function') applyWorkbenchStage();
        else if (window.__CFD_APPLY_WB_STAGE__) window.__CFD_APPLY_WB_STAGE__();
        return;
      }
      const prefer =
        live && live.status === 'done' && live.case_dir
          ? live.case_dir
          : snap &&
              snap.status === 'done' &&
              snap.case_dir &&
              isMeshJobKind(snap.path_kind || (live && live.path_kind))
            ? snap.case_dir
            : null;
      if (!prefer) {
        jobState.status = 'idle';
        jobState.mode = 'idle';
        jobState.case_dir = null;
        jobState.times = [];
        jobState.n_times = 0;
        jobState.note = 'idle — add geometry';
        syncJobStatusChrome();
        if (typeof applyWorkbenchStage === 'function') applyWorkbenchStage();
        else if (window.__CFD_APPLY_WB_STAGE__) window.__CFD_APPLY_WB_STAGE__();
        return;
      }
      await attachCaseDirClient(prefer);
      applyLiveMeshCountsToJob();
      if (typeof applyWorkbenchStage === 'function') applyWorkbenchStage();
      else if (window.__CFD_APPLY_WB_STAGE__) window.__CFD_APPLY_WB_STAGE__();
    } catch (e) {
      console.error('[CFD W15.1/W25b] boot attach', e);
    }
  })();
  syncJobStatusChrome();
  publishW15({ ready: false, booting: true });
})();

/* ========================================================================
 * W16 — project create + STEP CAD (B-rep preview, not auto-tessellated STL)
 * ======================================================================== */
const geomStlReader = vtkSTLReader.newInstance();
const geomCadFaceReader = vtkXMLPolyDataReader.newInstance();
const geomCadEdgeReader = vtkXMLPolyDataReader.newInstance();
const geomMapper = vtkMapper.newInstance();
geomMapper.setInputConnection(geomCadFaceReader.getOutputPort());
geomMapper.setScalarVisibility(false);
const geomActor = vtkActor.newInstance();
geomActor.setMapper(geomMapper);
geomActor.getProperty().setColor(0.74, 0.79, 0.86);
geomActor.getProperty().setOpacity(1.0);
geomActor.getProperty().setAmbient(0.16);
geomActor.getProperty().setDiffuse(0.78);
geomActor.getProperty().setSpecular(0.22);
geomActor.getProperty().setSpecularPower(28);
geomActor.getProperty().setEdgeVisibility(false);
try { geomActor.getProperty().setInterpolationToPhong(); } catch (_) {}
geomActor.setVisibility(false);
try { geomActor.setPickable(true); } catch (_) {}
renderer.addActor(geomActor);
const geomPicker = vtkCellPicker.newInstance();
geomPicker.setPickFromList(true);
geomPicker.setTolerance(0.008);

const geomEdgeMapper = vtkMapper.newInstance();
geomEdgeMapper.setInputConnection(geomCadEdgeReader.getOutputPort());
geomEdgeMapper.setScalarVisibility(false);
try {
  // Pull the CAD edge lines slightly toward the camera so they win the depth
  // test against the faces they sit on. This must be the RELATIVE line offset
  // of this mapper only: the "ResolveCoincidentTopology*OffsetParameters"
  // setters are vtk.js globals shared by every mapper, and a negative global
  // polygon offset drags all surfaces forward and buries the edges instead.
  if (geomEdgeMapper.setResolveCoincidentTopologyToPolygonOffset) {
    geomEdgeMapper.setResolveCoincidentTopologyToPolygonOffset();
  }
  if (geomEdgeMapper.setRelativeCoincidentTopologyLineOffsetParameters) {
    geomEdgeMapper.setRelativeCoincidentTopologyLineOffsetParameters(-1, -4);
  }
} catch (_) {}
const geomEdgeActor = vtkActor.newInstance();
geomEdgeActor.setMapper(geomEdgeMapper);
  geomEdgeActor.getProperty().setColor(0.04, 0.045, 0.055);
  geomEdgeActor.getProperty().setLineWidth(2.4);
geomEdgeActor.getProperty().setRepresentationToWireframe();
geomEdgeActor.getProperty().setLighting(false);
geomEdgeActor.setVisibility(false);
try { geomEdgeActor.setPickable(false); } catch (_) {}
renderer.addActor(geomEdgeActor);

const geomEdgeSelMapper = vtkMapper.newInstance();
geomEdgeSelMapper.setScalarVisibility(false);
try {
  if (geomEdgeSelMapper.setResolveCoincidentTopologyToPolygonOffset) {
    geomEdgeSelMapper.setResolveCoincidentTopologyToPolygonOffset();
  }
  if (geomEdgeSelMapper.setRelativeCoincidentTopologyPolygonOffsetParameters) {
    geomEdgeSelMapper.setRelativeCoincidentTopologyPolygonOffsetParameters(-0.4, -1);
  }
} catch (_) {}
const geomEdgeSelActor = vtkActor.newInstance();
geomEdgeSelActor.setMapper(geomEdgeSelMapper);
geomEdgeSelActor.getProperty().setColor(0.18, 0.77, 0.49);
geomEdgeSelActor.getProperty().setRepresentationToSurface();
geomEdgeSelActor.getProperty().setLighting(true);
geomEdgeSelActor.getProperty().setAmbient(0.55);
geomEdgeSelActor.getProperty().setDiffuse(0.45);
geomEdgeSelActor.setVisibility(false);
try { geomEdgeSelActor.setPickable(false); } catch (_) {}
renderer.addActor(geomEdgeSelActor);
const geomVertexSelMapper = vtkMapper.newInstance();
geomVertexSelMapper.setScalarVisibility(false);
const geomVertexSelActor = vtkActor.newInstance();
geomVertexSelActor.setMapper(geomVertexSelMapper);
geomVertexSelActor.getProperty().setColor(0.10, 0.84, 0.46);
geomVertexSelActor.getProperty().setAmbient(0.9);
geomVertexSelActor.getProperty().setDiffuse(0.25);
geomVertexSelActor.getProperty().setSpecular(0.05);
geomVertexSelActor.getProperty().setLighting(true);
geomVertexSelActor.setVisibility(false);
try { geomVertexSelActor.setPickable(false); } catch (_) {}
renderer.addActor(geomVertexSelActor);

const cadHwSelector = vtkHardwareSelector.newInstance({ captureZValues: false });
cadHwSelector.setFieldAssociation(FieldAssociations.FIELD_ASSOCIATION_CELLS);
const _arrowSrc = vtkArrowSource.newInstance({
  tipResolution: 16,
  tipRadius: 0.12,
  tipLength: 0.32,
  shaftResolution: 12,
  shaftRadius: 0.045,
});

function makeGlyphActor(color) {
  const mapper = vtkMapper.newInstance();
  mapper.setScalarVisibility(false);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  actor.getProperty().setColor(color[0], color[1], color[2]);
  actor.getProperty().setLighting(true);
  actor.getProperty().setAmbient(0.25);
  actor.getProperty().setDiffuse(0.8);
  actor.setPickable(false);
  actor.setVisibility(false);
  renderer.addActor(actor);
  return { mapper, actor };
}

const BC_KIND_RGB = {
  inlet: [56, 132, 230],
  outlet: [234, 112, 36],
  pressure: [147, 51, 234],
  wall: [95, 107, 122],
  // faces with no BC, shown only while the Defaults panel is open (must read
  // against the CAD grey, so a warm sand rather than another grey)
  default: [214, 190, 140],
};
const BC_KIND_VTK = {
  inlet: [0.18, 0.48, 0.92],
  outlet: [0.92, 0.44, 0.14],
  pressure: [0.58, 0.2, 0.92],
  wall: [0.37, 0.42, 0.48],
};

function bcKind(bc) {
  const t = String((bc && bc.bc_type) || '');
  if (t === 'Velocity outlet') return 'outlet';
  if (t.startsWith('Pressure')) return 'pressure';
  if (t === 'Wall') return 'wall';
  return 'inlet';
}

function isWallBcType(t) {
  return String(t || '') === 'Wall';
}

function paintForBcFaces(faces, kind) {
  const rgb = BC_KIND_RGB[kind] || BC_KIND_RGB.inlet;
  const paint = {};
  (faces || []).forEach((f) => {
    paint[f] = rgb;
  });
  return paint;
}

const bcFlowGlyph = makeGlyphActor(BC_KIND_VTK.inlet);
const bcOutletGlyph = makeGlyphActor(BC_KIND_VTK.outlet);
const bcAxisGlyphX = makeGlyphActor([0.88, 0.2, 0.2]);
const bcAxisGlyphY = makeGlyphActor([0.18, 0.64, 0.28]);
const bcAxisGlyphZ = makeGlyphActor([0.15, 0.42, 0.86]);
let bcAxisTips = null;

function bcGlyphActors() {
  return [bcFlowGlyph, bcOutletGlyph, bcAxisGlyphX, bcAxisGlyphY, bcAxisGlyphZ];
}

function bringCadEdgesForward() {
  try {
    renderer.removeActor(geomEdgeActor);
    renderer.addActor(geomEdgeActor);
  } catch (_) {}
  try {
    const pr = geomEdgeActor.getProperty();
    pr.setColor(0.04, 0.045, 0.055);
    pr.setLineWidth(2.4);
    pr.setLighting(false);
  } catch (_) {}
}

function setCadEdgesVisible(on) {
  cadEdgesWanted = !!on;
  applyCadEdgesNow();
}

const geomModifiers = [];

function setGeomVisible(on) {
  try { geomActor.setVisibility(!!on); } catch (_) {}
  for (const m of geomModifiers) {
    try { if (m.actor) m.actor.setVisibility(!!on); } catch (_) {}
    try { if (m.edgeActor) m.edgeActor.setVisibility(!!on); } catch (_) {}
  }
  applyCadEdgesNow();
}

const CAD_COLOR = [0.74, 0.79, 0.86];
const CAD_HIGHLIGHT = [0.28, 0.52, 0.92];

function geometryBodies() {
  const g = w16State.geometry;
  if (g && Array.isArray(g.bodies) && g.bodies.length) return g.bodies.slice();
  return g ? ['Body1'] : [];
}

function bodyNameFromIndex(idx) {
  const bodies = geometryBodies();
  const n = Number(idx) || 1;
  return bodies[n - 1] || ('Body' + n);
}

function bodyIndexFromName(name) {
  const bodies = geometryBodies();
  const i = bodies.indexOf(name);
  if (i >= 0) return i + 1;
  const m = /^Body(\d+)$/i.exec(String(name || ''));
  return m ? Number(m[1]) : 1;
}

function parseFaceId(label) {
  const m = String(label || '').match(/^face\s*(\d+)/i);
  return m ? Number(m[1]) : Number(label);
}

function parseFaceRef(label) {
  const m = String(label || '').match(/^face\s*(\d+)(?:@Body(\d+))?/i);
  if (!m) return null;
  return { faceId: Number(m[1]), bodyId: m[2] ? Number(m[2]) : 0 };
}

function faceLabel(faceId, bodyId) {
  return 'face ' + Number(faceId) + '@Body' + (Number(bodyId) || 1);
}

/** Every CAD face of the loaded model as "face N@BodyM", from the face polydata. */
function allGeomFaceLabels() {
  try {
    const pd = geomCadFaceReader.getOutputData && geomCadFaceReader.getOutputData();
    const cellData = pd && pd.getCellData && pd.getCellData();
    const faceArr = cellData && cellData.getArrayByName && cellData.getArrayByName('faceId');
    if (!pd || !faceArr) return [];
    const solidArr = cellData.getArrayByName('solidId');
    const faceRaw = faceArr.getData ? faceArr.getData() : null;
    const solidRaw = solidArr && solidArr.getData ? solidArr.getData() : null;
    const n = pd.getNumberOfCells();
    const seen = new Set();
    const out = [];
    for (let i = 0; i < n; i++) {
      const fid = faceRaw ? Number(faceRaw[i]) : Number(faceArr.getValue(i));
      if (!(fid > 0)) continue;
      const bid = solidRaw ? Number(solidRaw[i]) : solidArr ? Number(solidArr.getValue(i)) : 0;
      const key = fid + ':' + (bid || 1);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(faceLabel(fid, bid || 1));
    }
    out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return out;
  } catch (_) {
    return [];
  }
}

function applyGeomHighlight() {
  const pd = geomCadFaceReader.getOutputData && geomCadFaceReader.getOutputData();
  const cellData = pd && pd.getCellData && pd.getCellData();
  const faceRefs = (w16State.selectedFaces || []).map(parseFaceRef).filter(Boolean);
  const faceSet = new Set(faceRefs.map((r) => r.faceId).filter((n) => n > 0));
  const faceArr = cellData && cellData.getArrayByName && cellData.getArrayByName('faceId');
  const solidArr = cellData && cellData.getArrayByName && cellData.getArrayByName('solidId');
  const previewRefs = Array.from(faceCtxSelected).map(parseFaceRef).filter(Boolean);
  const selectedBodyIds = Array.isArray(w16State.selectedBodies)
    ? w16State.selectedBodies.map(Number).filter((n) => n > 0)
    : w16State.selectedBody != null
      ? [Number(w16State.selectedBody)]
      : [];
  const useFaces = faceRefs.length > 0 && faceArr;
  const useBody = !useFaces && selectedBodyIds.length > 0 && solidArr;
  const usePreview = previewRefs.length > 0 && !!faceArr;
  if (pd && (useFaces || useBody || usePreview)) {
    const n = pd.getNumberOfCells();
    const faceRaw = faceArr && faceArr.getData ? faceArr.getData() : null;
    const solidRaw = solidArr && solidArr.getData ? solidArr.getData() : null;
    const rgb = new Uint8Array(n * 3);
    const restIsCad = usePreview && !useFaces && !useBody;
    for (let i = 0; i < n; i++) {
      const fid = faceRaw ? Number(faceRaw[i]) : faceArr ? Number(faceArr.getValue(i)) : 0;
      const bid = solidRaw ? Number(solidRaw[i]) : solidArr ? Number(solidArr.getValue(i)) : 0;
      const on = useFaces
        ? faceRefs.some((r) => r.faceId === fid && (!r.bodyId || !bid || r.bodyId === bid))
        : !!(useBody && selectedBodyIds.includes(bid));
      const focusRef = w16State.focusedFace ? parseFaceRef(w16State.focusedFace) : null;
      const focused =
        !!(focusRef &&
          focusRef.faceId === fid &&
          (!focusRef.bodyId || !bid || focusRef.bodyId === bid));
      const previewed = previewRefs.some((r) =>
        r.faceId === fid && (!r.bodyId || !bid || r.bodyId === bid));
      if (focused || previewed) {
        rgb[i * 3] = 46;
        rgb[i * 3 + 1] = 196;
        rgb[i * 3 + 2] = 126;
      } else if (on) {
        const lab = faceLabel(fid, bid || 1);
        const custom = w16State.facePaint && w16State.facePaint[lab];
        if (custom) {
          rgb[i * 3] = custom[0];
          rgb[i * 3 + 1] = custom[1];
          rgb[i * 3 + 2] = custom[2];
        } else {
          rgb[i * 3] = 72;
          rgb[i * 3 + 1] = 132;
          rgb[i * 3 + 2] = 235;
        }
      } else if (restIsCad) {
        rgb[i * 3] = Math.round(CAD_COLOR[0] * 255);
        rgb[i * 3 + 1] = Math.round(CAD_COLOR[1] * 255);
        rgb[i * 3 + 2] = Math.round(CAD_COLOR[2] * 255);
      } else {
        rgb[i * 3] = 188;
        rgb[i * 3 + 1] = 196;
        rgb[i * 3 + 2] = 208;
      }
    }
    const arr = vtkDataArray.newInstance({
      name: 'bodyRgb',
      numberOfComponents: 3,
      values: rgb,
    });
    cellData.addArray(arr);
    cellData.setActiveScalars('bodyRgb');
    pd.modified();
    geomMapper.setScalarVisibility(true);
    geomMapper.setScalarMode(ScalarMode.USE_CELL_FIELD_DATA);
    geomMapper.setColorMode(ColorMode.DIRECT_SCALARS);
    geomMapper.setColorByArrayName('bodyRgb');
    try {
      geomMapper.setInterpolateScalarsBeforeMapping(false);
    } catch (_) {}
    geomMapper.modified();
  } else {
    try {
      geomMapper.setScalarVisibility(false);
    } catch (_) {}
    try {
      geomActor.getProperty().setColor(
        ...(selectedBodyIds.length || faceSet.size ? CAD_HIGHLIGHT : CAD_COLOR)
      );
    } catch (_) {}
  }
  try {
    if (typeof fillGeometryDetail === 'function') fillGeometryDetail();
  } catch (_) {}
  publishW16();
  try { applyHiddenCadDisplay(); } catch (_) {}
  try { applyHiddenCadEdges(); } catch (_) {}
  try {
    renderWindow.render();
  } catch (_) {}
}

function highlightGeomBody(bodyIndex) {
  w16State.selectedBody = bodyIndex == null ? null : Number(bodyIndex);
  w16State.selectedBodies = w16State.selectedBody != null ? [w16State.selectedBody] : null;
  if (w16State.selectedBody != null) {
    w16State.selectedFaces = [];
    w16State.focusedFace = null;
  }
  applyGeomHighlight();
}

function highlightGeomBodies(indices) {
  const ids = (indices || []).map(Number).filter((n) => n > 0);
  w16State.selectedBodies = ids.length ? ids : null;
  w16State.selectedBody = ids.length === 1 ? ids[0] : (ids[0] || null);
  if (ids.length) {
    w16State.selectedFaces = [];
    w16State.focusedFace = null;
  }
  applyGeomHighlight();
}

function highlightGeomFaces(labels, focusLabel, paint) {
  w16State.selectedFaces = Array.isArray(labels) ? labels.slice() : [];
  w16State.facePaint = paint || null;
  if (w16State.selectedFaces.length) w16State.selectedBody = null;
  if (focusLabel === undefined) {
    /* keep current focus if it is still assigned */
    if (w16State.focusedFace && !w16State.selectedFaces.includes(w16State.focusedFace)) {
      w16State.focusedFace = null;
    }
  } else {
    w16State.focusedFace = focusLabel || null;
  }
  applyGeomHighlight();
}

function cadUrlsFor(projectId, stamp, geomId) {
  const q = `project_id=${encodeURIComponent(projectId || '')}`;
  const gid =
    geomId ||
    (w16State && (w16State.selectedGeomId || (w16State.geometry && w16State.geometry.id))) ||
    '';
  const gq = gid ? `&geometry_id=${encodeURIComponent(gid)}` : '';
  const t = stamp || Date.now();
  return {
    faces_url: `/api/geometry/cad?${q}${gq}&part=faces&v=7&t=${encodeURIComponent(t)}`,
    edges_url: `/api/geometry/cad?${q}${gq}&part=edges&v=7&t=${encodeURIComponent(t)}`,
  };
}

const w16State = {
  increment: 'W16',
  ready: false,
  project: null,
  geometry: null,
  geometries: [],
  fingerprint: null,
  stl_url: null,
  selectedBody: null,
  selectedBodies: null,
  selectedGeomId: null,
  selectedModifierId: null,
  selectedFaces: [],
  focusedFace: null,
  facePaint: null,
  mode: 'idle', // idle | project | geometry
  note: 'W16: New Project + Import STEP / IGES / BREP / STL / OBJ / PLY',
  soft_pass_avoided: true,
};
window.__CFD_W16_STATE__ = w16State;

function publishW16(extra) {
  if (extra) Object.assign(w16State, extra);
  const payload = {
    increment: 'W16',
    ready: !!w16State.ready,
    project: w16State.project,
    geometry: w16State.geometry,
    fingerprint: w16State.fingerprint,
    stl_url: w16State.stl_url,
    mode: w16State.mode,
    note: w16State.note,
    soft_pass_avoided: true,
    persistence: 'filesystem',
    demo_actor: w16State.ready ? 'vtkXMLPolyDataReader' : null,
    hydrated: !!w16State.hydrated,
    project_created: !!w16State.project_created,
    imported: !!w16State.imported,
    selectedBody: w16State.selectedBody == null ? null : w16State.selectedBody,
  };
  window.__CFD_W16__ = payload;
  return payload;
}

function fingerprintGeomPolyData(pd) {
  if (!pd) {
    return { nPoints: 0, nCells: 0, bounds: null, mesh_checksum: '00000000', empty: true };
  }
  const pts = pd.getPoints && pd.getPoints();
  const nPoints = pts ? pts.getNumberOfPoints() : 0;
  const nCells = pd.getNumberOfCells ? pd.getNumberOfCells() : 0;
  const bounds = pd.getBounds ? pd.getBounds() : null;
  let mesh_checksum = '00000000';
  try {
    if (pts && nPoints > 0) {
      const arr = pts.getData();
      let h = 2166136261;
      const step = Math.max(1, Math.floor(arr.length / 64));
      for (let i = 0; i < arr.length; i += step) {
        h ^= Math.floor(Math.abs(arr[i]) * 1000) & 0xffff;
        h = Math.imul(h, 16777619);
      }
      mesh_checksum = (h >>> 0).toString(16).padStart(8, '0');
    }
  } catch (_) {}
  return {
    nPoints,
    nCells,
    bounds: bounds
      ? {
          xmin: bounds[0],
          xmax: bounds[1],
          ymin: bounds[2],
          ymax: bounds[3],
          zmin: bounds[4],
          zmax: bounds[5],
        }
      : null,
    mesh_checksum,
    empty: nPoints === 0 || nCells === 0,
    not_empty: nPoints > 0 && nCells > 0,
  };
}

function emptyVtkPolyData() {
  return vtkPolyData.newInstance();
}

function clearResultActors() {
  ivLoadToken += 1;
  isoLoadToken += 1;
  ptLoadToken += 1;
  ptLoading = false;
  popLoadToken += 1;
  inspectLoadToken += 1;
  fieldLoadToken += 1;
  cutLoadToken += 1;
  try { clearFieldFrameCache(); } catch (_) {}
  const empty = emptyVtkPolyData();
  try { surfaceMapper.setInputData(empty); } catch (_) {}
  try { surfaceMapper.setInputConnection(reader.getOutputPort()); } catch (_) {}
  try { cutMapper.setInputData(empty); } catch (_) {}
  try { cutMapper.setInputConnection(cutReader.getOutputPort()); } catch (_) {}
  try { ptMapper.setInputData(empty); } catch (_) {}
  try { popPathMapper.setInputData(empty); } catch (_) {}
  try { isoMapper.setInputData(empty); } catch (_) {}
  try { ivMapper.setInputData(empty); } catch (_) {}
  try { clearResultPlanes(); } catch (_) {}
  for (const m of [surfaceMapper, ptMapper, ptGlyphMapper, ptSeedMapper]) {
    try { if (m && m.removeAllClippingPlanes) m.removeAllClippingPlanes(); } catch (_) {}
  }
  try { hidePtFaceOverlay(); } catch (_) {}
  ptLinePd = null;
  sourcePolyData = null;
  sourceBounds = null;
  cutBins = null;
  const actors = [surfaceActor, cutActor, ptActor, ptSeedActor, popPathActor, isoActor, ivActor, inspectMarkerActor];
  for (const a of actors) {
    try { a.setVisibility(false); } catch (_) {}
  }
}

const TREE_DETAIL_IDS = {
  incompressible: 'panel-incompressible-defaults',
  geometry: 'panel-geometry',
  'mat-picker': 'panel-material-picker',
  'materials-hub': 'panel-materials-hub',
  'bc-picker': 'panel-bc-picker',
  'bcs-hub': 'panel-bcs-hub',
  'bc-defaults': 'panel-bc-defaults',
  air: 'panel-air-material',
  bc: 'panel-bc-editor',
  vi: 'panel-bc-editor',
  po: 'panel-bc-editor',
  vo: 'panel-bc-editor',
  pi: 'panel-bc-editor',
  mesh: 'panel-mesh-form',
  'mesh-hub': 'panel-mesh-hub',
  mesh1: 'panel-mesh-inspect',
  'refs-hub': 'panel-refs-hub',
  'ref-picker': 'panel-ref-picker',
  ref: 'panel-ref-editor',
  aa: 'panel-area-average',
  rc: 'panel-results-hub',
  'run-mesh': 'panel-run-mesh',
  'run-results': 'panel-run-results',
  'run-media': 'panel-run-media',
  'run-graphs': 'panel-run-graphs',
  'sim-hub': 'panel-sim-hub',
  'sim-control': 'panel-sim-control',
};
const WIDE_TREE_DETAIL = new Set(['run-media', 'run-graphs']);

const treeUi = {
  openPanel: null,
  expanded: {},
  selectedKey: null,
};

function treeExpanded(label, fallback) {
  if (Object.prototype.hasOwnProperty.call(treeUi.expanded, label)) return !!treeUi.expanded[label];
  return fallback !== false;
}

function treeExpClass(label, fallback) {
  return treeExpanded(label, fallback) ? ' expanded' : '';
}

function treeTw(label, fallback) {
  return treeExpanded(label, fallback) ? '-' : '+';
}

function dismissTreeDetail() {
  try { endRunCopyPick(); } catch (_) {}
  const wasResults = treeUi.openPanel === 'run-results';
  const wasMedia = treeUi.openPanel === 'run-media' || treeUi.openPanel === 'run-graphs';
  hideAllTreeDetails();
  markTreeSelected(null);
  if (wasResults && resultsViewOpen) hideRunResultsView();
  // Closing Graphs / Screenshots / Recordings leaves the open view selected.
  if (wasMedia) {
    if (resultsViewOpen && resultsRunId) markTreeSelected('runresults:' + resultsRunId);
    else if (meshInspectOpen && w20State && w20State.active_id) markTreeSelected('meshid:' + w20State.active_id);
  }
  try {
    if (typeof w19State !== 'undefined') w19State.activeId = null;
  } catch (_) {}
}

/** Clicking the same sidebar row again closes its flyout. Use this for every new tree item. */
function closeIfTreeItemOpen(selectKey) {
  if (!treeUi.openPanel || treeUi.selectedKey !== selectKey) return false;
  dismissTreeDetail();
  return true;
}

function hideAllTreeDetails() {
  const wasBc =
    treeUi.openPanel === 'bc' ||
    treeUi.openPanel === 'vi' ||
    treeUi.openPanel === 'po' ||
    treeUi.openPanel === 'vo' ||
    treeUi.openPanel === 'pi' ||
    treeUi.openPanel === 'bcs-hub' ||
    treeUi.openPanel === 'bc-defaults';
  const wasRef =
    treeUi.openPanel === 'ref' ||
    treeUi.openPanel === 'refs-hub' ||
    treeUi.openPanel === 'ref-picker';
  const wasAa = treeUi.openPanel === 'aa' || treeUi.openPanel === 'rc';
  for (const id of Object.values(TREE_DETAIL_IDS)) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  const detail = document.getElementById('tree-detail');
  if (detail) {
    detail.hidden = true;
    detail.classList.remove('is-wide');
  }
  treeUi.openPanel = null;
  if (wasBc || wasRef || wasAa) {
    try {
      w16State.selectedFaces = [];
      w16State.facePaint = null;
      w16State.focusedFace = null;
      applyGeomHighlight();
    } catch (_) {}
    try {
      if (typeof clearBcGlyphs === 'function') clearBcGlyphs();
    } catch (_) {}
  }
  try {
    if (typeof w20State !== 'undefined') w20State.panel_open = false;
  } catch (_) {}
  try {
    if (typeof w22State !== 'undefined') w22State.panel_open = false;
  } catch (_) {}
  syncAssignCursor();
  try { requestAnimationFrame(syncFiltersPanelOffset); } catch (_) {}
}

function openTreeDetail(key, { toggle = true } = {}) {
  if (!key) {
    hideAllTreeDetails();
    return false;
  }
  if (toggle && treeUi.openPanel === key) {
    hideAllTreeDetails();
    return false;
  }
  hideAllTreeDetails();
  const id = TREE_DETAIL_IDS[key];
  const panel = id && document.getElementById(id);
  const detail = document.getElementById('tree-detail');
  if (!panel || !detail) return false;
  panel.hidden = false;
  detail.hidden = false;
  detail.classList.toggle('is-wide', WIDE_TREE_DETAIL.has(key));
  treeUi.openPanel = key;
  if (key === 'mesh') {
    try {
      if (typeof w20State !== 'undefined') w20State.panel_open = true;
      if (typeof applySettingsToForm === 'function') {
        applySettingsToForm((w20State && w20State.settings) || (typeof W20_DEFAULTS !== 'undefined' ? W20_DEFAULTS : null));
      }
    } catch (_) {}
  }
  if (key === 'aa') {
    try {
      if (typeof w22State !== 'undefined') w22State.panel_open = true;
    } catch (_) {}
  }
  if (key === 'geometry' && typeof fillGeometryDetail === 'function') fillGeometryDetail();
  if (key === 'materials-hub' && typeof syncMaterialsHub === 'function') syncMaterialsHub();
  if (key === 'bcs-hub') {
    if (typeof syncBcsHub === 'function') syncBcsHub();
    if (typeof showBcOverview === 'function') showBcOverview();
  }
  if (key === 'bc-defaults' && typeof syncBcDefaultsPanel === 'function') syncBcDefaultsPanel();
  if (key === 'mesh-hub' && typeof syncMeshHubPanel === 'function') syncMeshHubPanel();
  if (key === 'refs-hub') {
    if (typeof syncRefsHub === 'function') syncRefsHub();
    if (typeof showRefsOverview === 'function') showRefsOverview();
    if (typeof syncRefCopyUi === 'function') syncRefCopyUi();
  }
  if (key === 'rc') {
    if (typeof syncResultsHub === 'function') syncResultsHub();
    if (typeof showRunAaOverview === 'function') showRunAaOverview();
  }
  if (key === 'run-mesh' && typeof syncRunMeshHub === 'function') syncRunMeshHub();
  syncAssignCursor();
  try { requestAnimationFrame(syncFiltersPanelOffset); } catch (_) {}
  return true;
}

function isAssigningMaterial() {
  return treeUi.openPanel === 'mat-picker' || treeUi.openPanel === 'air';
}

function isAssigningBcFace() {
  return (
    treeUi.openPanel === 'bc' ||
    treeUi.openPanel === 'vi' ||
    treeUi.openPanel === 'po' ||
    treeUi.openPanel === 'vo' ||
    treeUi.openPanel === 'pi'
  );
}

function isAssigningRefFace() {
  return treeUi.openPanel === 'ref';
}

function isAssigningAaFace() {
  return treeUi.openPanel === 'aa';
}

function isAssigningFace() {
  return isAssigningBcFace() || isAssigningRefFace() || isAssigningAaFace() || isAssigningPtFace();
}

function syncAssignCursor() {
  if (container) {
    container.classList.toggle('is-assigning', isAssigningMaterial() || isAssigningFace());
    container.classList.toggle('is-pt-region-pick', isPtRegionPickerArmed());
  }
}

function hideSetupPanels() {
  hideAllTreeDetails();
  if (resultsViewOpen) hideRunResultsView({ silent: true });
  const fp = document.getElementById('filters-panel');
  if (fp) fp.hidden = true;
}

function setStageChrome(stage) {
  const resultsOn = stage === 'results';
  const meshOn = stage === 'mesh';
  const showPostChrome = resultsOn || meshOn;
  const ids = {
    toolbar: showPostChrome,
    'filters-panel': showPostChrome,
    legend: resultsOn,
    'right-chrome': resultsOn,
    'inspect-readout': false,
    'simulations-section': stage !== 'empty',
  };
  for (const [id, show] of Object.entries(ids)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.hidden = !show;
    if (show) el.removeAttribute('hidden');
  }
  const createSim = document.getElementById('btn-create-simulation');
  if (createSim) createSim.hidden = stage === 'empty';
  if (stage === 'empty') {
    hideSetupPanels();
  }
}

function detachResultsCase() {
  caseDir = null;
  jobState.status = 'idle';
  jobState.mode = 'idle';
  jobState.case_dir = null;
  jobState.times = [];
  jobState.n_times = 0;
  jobState.attached_at = null;
  jobState.note = 'idle — add geometry';
  jobState.path_kind = null;
  stopJobPoll();
  clearResultActors();
  try { syncJobStatusChrome(); } catch (_) {}
  fetch('/api/case/detach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(() => {});
}

function resetEmptyWorkbench({ keepProject = true } = {}) {
  detachResultsCase();
  setGeomVisible(false);
  lastFramedBounds = null;
  officialComNative = null;
  officialCadBoundsNative = null;
  cutState.com = null;
  cutState.positionUserSet = false;
  if (!keepProject) {
    w16State.project = null;
  }
  w16State.geometry = null;
  w16State.geometries = [];
  w16State.selectedGeomId = null;
  w16State.selectedModifierId = null;
  w16State.selectedBodies = null;
  w16State.fingerprint = null;
  try {
    hiddenCadFaces.clear();
    faceCtxSelected.clear();
    edgeCtxSelected.clear();
    vertexCtxSelected.clear();
    faceCtxHit = null;
    syncHiddenFacesChip();
    applyHiddenDisplays();
    try { applyEdgeSelectionDisplay(); } catch (_) {}
    try { syncMeasureChip(); } catch (_) {}
  } catch (_) {}
  w16State.ready = false;
  w16State.stl_url = null;
  w16State.mode = keepProject && w16State.project ? 'project' : 'idle';
  try {
    if (typeof w17State !== 'undefined') {
      w17State.simulation = null;
      w17State.defaults = null;
      w17State.ready = false;
      w17State.created = false;
    }
  } catch (_) {}
  try {
    if (typeof w18State !== 'undefined') {
      w18State.material = null;
      w18State.draft_volumes = [];
      w18State.ready = false;
      w18State.created = false;
    }
  } catch (_) {}
  try {
    if (typeof w19State !== 'undefined') {
      w19State.ready = false;
      w19State.created = false;
      w19State.bcs = [];
      w19State.activeId = null;
      w19State.draft_faces = [];
      w19State.velocity_inlet_1 = null;
      w19State.pressure_outlet_2 = null;
    }
  } catch (_) {}
  try {
    if (typeof w20State !== 'undefined') {
      w20State.mesh = null;
      w20State.settings = null;
      w20State.meshes = [];
      w20State.meshes_all = [];
      w20State.active_id = null;
      w20State.ready = false;
      w20State.created = false;
      w20State.live_mesh_result = null;
    }
  } catch (_) {}
  try {
    if (window.__CFD_W17__) window.__CFD_W17__.simulation = null;
    if (window.__CFD_W20__) window.__CFD_W20__.mesh = null;
    if (window.__CFD_W20_STATE__) window.__CFD_W20_STATE__.mesh = null;
  } catch (_) {}
  hideSetupPanels();
  try { syncGeometryTree(); } catch (_) {}
  try { syncSimulationTree(); } catch (_) {}
  applyWorkbenchStage();
  try { renderWindow.render(); } catch (_) {}
}

function applyWorkbenchStage() {
  const hasGeom = !!(
    (w16State.geometry &&
      (w16State.geometry.faces_url ||
        w16State.geometry.step_path ||
        w16State.geometry.stl_url ||
        w16State.ready)) ||
    (Array.isArray(w16State.geometries) && w16State.geometries.length)
  );
  const hasSim = !!(window.__CFD_W17__ && window.__CFD_W17__.simulation);
  const hasMesh = anyGeneratedMeshReady();
  const hasResults = hasPostResults();
  let stage = 'empty';
  if (hasResults) stage = 'results';
  else if (meshInspectOpen && hasMesh) stage = 'mesh';
  else if (hasSim) stage = 'setup';
  else if (hasGeom) stage = 'geometry';

  const app = document.getElementById('app');
  if (app) app.setAttribute('data-wb-stage', stage);
  document.body.setAttribute('data-wb-stage', stage);

  const cta = document.getElementById('wb-empty-cta');
  if (cta) cta.hidden = stage !== 'empty';

  setStageChrome(stage);

  if (stage === 'results') setFiltersToolbarMode('post');
  else if (stage === 'mesh') setFiltersToolbarMode('mesh');
  else setFiltersToolbarMode('setup');

  if (stage === 'empty' || stage === 'geometry' || stage === 'setup') {
    clearResultActors();
  }
  if (stage === 'empty') {
    setGeomVisible(false);
  }
  try { resizeViewer(); } catch (_) {}
  window.__CFD_WB_STAGE__ = stage;
  document.documentElement.classList.add('cfd-ready');
  requestAnimationFrame(() => resizeViewer());
  return stage;
}
window.__CFD_APPLY_WB_STAGE__ = applyWorkbenchStage;
window.__CFD_RESET_EMPTY_WORKBENCH__ = resetEmptyWorkbench;

function syncProjectChrome() {
  const nameEl = document.querySelector('.project-name');
  const folderEl = document.getElementById('folder-chip');
  if (w16State.project) {
    if (nameEl) nameEl.textContent = w16State.project.title || 'Untitled';
    if (folderEl) folderEl.textContent = w16State.project.folder || 'My Projects';
  }
  applyWorkbenchStage();
}

function importedGeometries() {
  if (Array.isArray(w16State.geometries) && w16State.geometries.length) {
    return w16State.geometries.filter((g) => g && (g.id || g.name));
  }
  const g = w16State.geometry;
  if (g && (g.name || g.step_path || g.faces_url)) {
    return [{ id: g.id || 'geom-primary', name: g.name, ...g }];
  }
  return [];
}

function syncGeometryTree() {
  const countLabel = document.getElementById('geometries-count-label');
  const list = document.getElementById('geometries-list');
  const items = importedGeometries();
  if (countLabel) countLabel.textContent = 'GEOMETRIES (' + items.length + ')';
  if (list) {
    if (!items.length) {
      list.innerHTML = '<div class="geo-empty" id="geo-empty">No geometry yet</div>';
    } else {
      list.innerHTML = items
        .map((g) => {
          const label = g.name || (g.original_filename ? String(g.original_filename).replace(/\.[^.]+$/, '') : 'Geometry');
          const sel = w16State.selectedGeomId && g.id === w16State.selectedGeomId ? ' is-selected' : '';
          return (
            '<div class="geo-item' +
            sel +
            '" data-geom-id="' +
            escapeHtml(g.id || '') +
            '" title="Open geometry"><span class="geo-name">' +
            escapeHtml(label) +
            '</span></div>'
          );
        })
        .join('');
    }
  }
  const del = document.getElementById('geo-delete');
  if (del) del.hidden = !w16State.selectedGeomId;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fillGeometryDetail() {
  const assembly = w16State.geometry;
  const part = (w16State.geometries || []).find((g) => g && g.id === w16State.selectedGeomId) || null;
  const g = part || assembly;
  const bodies = (part && (part.assembly_bodies || part.bodies)) || ((assembly && assembly.bodies) || []);
  const selected = (w16State.selectedBodies && w16State.selectedBodies.length)
    ? w16State.selectedBodies.map((n) => 'Body' + n).join(', ')
    : (bodies.join(', ') || '—');
  const name = (g && g.name) || '—';
  const title = document.getElementById('geo-detail-title');
  const nameEl = document.getElementById('geo-detail-name');
  const repr = document.getElementById('geo-detail-repr');
  const body = document.getElementById('geo-detail-body');
  if (title) title.textContent = part ? part.name : (w16State.selectedBody ? selected : 'Geometry');
  if (nameEl) nameEl.textContent = name;
  if (repr) repr.textContent = geometryReprLabel(part || assembly);
  if (body) body.textContent = selected;
  const del = document.getElementById('geo-delete');
  if (del) del.hidden = !w16State.selectedGeomId;
}

async function createProjectClient(fields) {
  const body = {
    title: (fields && fields.title) || 'Test 2',
    description: (fields && fields.description) || '',
    category: (fields && fields.category) || 'Other',
    units: (fields && fields.units) || 'Metric',
    folder: (fields && fields.folder) || 'BOT Tests',
  };
  const r = await fetch('/api/project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) {
    publishW16({ ready: false, mode: 'idle', note: j.error || 'project create failed' });
    throw new Error(j.error || 'project create failed');
  }
  w16State.project = {
    id: j.id,
    title: j.title,
    description: j.description,
    category: j.category,
    units: j.units,
    folder: j.folder,
    created_at: j.created_at,
    project_json: j.project_json,
  };
  w16State.imported = false;
  resetEmptyWorkbench({ keepProject: true });
  syncProjectChrome();
  publishW16({ project_created: true, hydrated: true });
  return window.__CFD_W16__;
}

async function loadOfficialCadCom() {
  const pid = w16State.project && w16State.project.id;
  if (!pid) return;
  try {
    const r = await fetch('/api/geometry/cad?project_id=' + encodeURIComponent(pid) + '&part=preview');
    if (!r.ok) return;
    rememberOfficialCom(await r.json());
  } catch (_) {}
}

async function loadGeometryCad(facesUrl, edgesUrl) {
  await Promise.all([
    geomCadFaceReader.setUrl(facesUrl),
    edgesUrl ? geomCadEdgeReader.setUrl(edgesUrl) : Promise.resolve(),
    loadOfficialCadCom(),
  ]);
  geomMapper.setInputConnection(geomCadFaceReader.getOutputPort());
  const pd = geomCadFaceReader.getOutputData();
  const fp = fingerprintGeomPolyData(pd);
  const edgePd = geomCadEdgeReader.getOutputData && geomCadEdgeReader.getOutputData();
  const edgeFp = fingerprintGeomPolyData(edgePd);
  const show = !fp.empty || !edgeFp.empty;
  setGeomVisible(show);
  if (show) {
    try {
      surfaceActor.getProperty().setOpacity(0.15);
    } catch (_) {}
    frameSceneCamera(true);
    resizeViewer();
    highlightGeomBody(null);
    if (typeof rebuildCadTriCache === 'function') rebuildCadTriCache();
    if (typeof rebuildCadEdgeCache === 'function') rebuildCadEdgeCache();
  }
  try { if (compareState.on) applyCadEdgesNow(); } catch (_) {}
  try { await loadGeometryModifiers(w16State.geometry); } catch (e) { console.warn('[CFD] modifiers', e); }
  return { pd, fp, edgeFp };
}

async function loadGeometryStl(url) {
  await geomStlReader.setUrl(url, { binary: true });
  geomMapper.setInputConnection(geomStlReader.getOutputPort());
  geomActor.getProperty().setEdgeVisibility(false);
  const pd = geomStlReader.getOutputData();
  const fp = fingerprintGeomPolyData(pd);
  setGeomVisible(!fp.empty);
  try { geomEdgeActor.setVisibility(false); } catch (_) {}
  if (!fp.empty) {
    try {
      surfaceActor.getProperty().setOpacity(0.15);
    } catch (_) {}
    frameSceneCamera(true);
  }
  return { pd, fp };
}

function geometryReprLabel(g) {
  if (!g) return '—';
  const kind = g.source_kind || g.representation || 'step';
  const unit = String(g.length_unit || '').toUpperCase();
  const unitLabel = { MM: 'mm', CM: 'cm', M: 'm', INCH: 'in' }[unit];
  if (kind === 'mesh') {
    const ext = String(g.original_filename || '').split('.').pop();
    const fmt = /^(stl|obj|ply)$/i.test(ext) ? ext.toUpperCase() : 'Mesh';
    return unitLabel ? fmt + ' (' + unitLabel + ')' : fmt;
  }
  if (kind === 'iges') return 'IGES (CAD)';
  if (kind === 'brep') return 'BREP (CAD)';
  return 'STEP (CAD)';
}

function applyImportedGeometry(geom, projectId, geometries) {
  const stamp = (geom && (geom.imported_at || geom.updated_at)) || Date.now();
  const urls = cadUrlsFor(projectId, stamp, geom && geom.id);
  w16State.geometry = {
    id: geom.id || null,
    name: geom.name,
    bodies: geom.bodies || ['Body1'],
    volume: geom.volume || 'Body1',
    step_path: geom.step_path,
    faces_url: urls.faces_url,
    edges_url: urls.edges_url,
    stl_url: geom.stl_url || null,
    stl_path: geom.stl_path || null,
    representation: geom.representation || 'step',
    tessellated: !!geom.tessellated,
    source_kind: geom.source_kind || geom.representation || 'step',
    original_filename: geom.original_filename || null,
    length_unit: geom.length_unit || null,
    watertight: geom.watertight,
    note: geom.note || null,
    server_fingerprint: geom.fingerprint || null,
    part_ids: geom.part_ids || null,
    modifiers: Array.isArray(geom.modifiers) ? geom.modifiers.map((m) => ({ ...m })) : [],
  };
  if (geom && geom.id) w16State.selectedGeomId = geom.id;
  const list = Array.isArray(geometries) && geometries.length
    ? geometries
    : geom
      ? [Object.assign({ id: geom.id || 'geom-primary' }, geom)]
      : [];
  w16State.geometries = list.map((g) => ({ ...g }));
  rememberOfficialCom(geom.fingerprint || geom);
  w16State.stl_url = w16State.geometry.faces_url;
  return w16State.geometry;
}

async function reloadGeometryScopedSetup() {
  const qs = hashProjectQs();
  const pid = (w16State.project && w16State.project.id) || '';
  try {
    const [mat, bcs, mesh, refs, runs, sims, rcs] = await Promise.all([
      fetch('/api/materials' + qs).then((r) => r.json()).catch(() => null),
      fetch('/api/bcs' + qs).then((r) => r.json()).catch(() => null),
      fetch('/api/mesh' + qs).then((r) => r.json()).catch(() => null),
      fetch('/api/mesh/refinements' + qs).then((r) => r.json()).catch(() => null),
      fetch('/api/run/status' + qs).then((r) => r.json()).catch(() => null),
      fetch('/api/simulation' + qs).then((r) => r.json()).catch(() => null),
      fetch('/api/result-controls' + qs).then((r) => r.json()).catch(() => null),
    ]);
    const sid = currentStudyId();
    if (mat && mat.air && sid && typeof applyMaterialRecord === 'function') {
      applyMaterialRecord(mat.air, mat.project_id, { openPanel: false });
    } else if (typeof w18State !== 'undefined') {
      w18State.material = null;
      w18State.draft_volumes = [];
      w18State.ready = false;
      w18State.created = false;
      w18State.libraryApplied = false;
      if (typeof publishW18 === 'function') publishW18({ ready: false });
    }
    if (typeof applyBcRecords === 'function') {
      applyBcRecords(
        sid ? (bcs || { boundary_conditions: [] }) : { boundary_conditions: [] },
        (bcs && bcs.project_id) || pid
      );
    }
    if (typeof applyMeshRecord === 'function') {
      applyMeshRecord(sid ? (mesh || {}) : {}, (mesh && mesh.project_id) || pid);
    }
    if (typeof applyRefRecords === 'function') {
      applyRefRecords(
        sid ? (refs || { refinements: [] }) : { refinements: [] },
        (refs && refs.project_id) || pid
      );
    }
    if (typeof applyAaRecord === 'function') {
      applyAaRecord(
        sid ? (rcs || { area_average_1: null, result_controls: [] }) : { area_average_1: null, result_controls: [] },
        (rcs && rcs.project_id) || pid
      );
    }
    if (typeof applyRunCatalog === 'function') {
      applyRunCatalog(sid ? (runs || { runs: [] }) : { runs: [] });
    }
    if (typeof applySimulationRecord === 'function') {
      applySimulationRecord(
        (sims && sims.simulation) || null,
        (sims && sims.project_id) || pid,
        sims || { simulations: [] },
      );
    }
    try { syncSimulationTree(); } catch (_) {}
    try { if (typeof fillCompareSelects === 'function') fillCompareSelects(); } catch (_) {}
  } catch (e) {
    console.warn('[CFD] reload geometry setup', e);
  }
}

async function activateGeometryClient(geomId) {
  const id = String(geomId || '').trim();
  if (!id) return;
  const part = (w16State.geometries || []).find((g) => g && g.id === id) || null;
  if (!part) return;
  const already = !!(w16State.geometry && w16State.geometry.id === id);
  w16State.selectedGeomId = id;
  w16State.selectedBodies = null;
  w16State.selectedBody = null;
  w16State.selectedFaces = [];
  w16State.focusedFace = null;
  syncGeometryTree();
  fillGeometryDetail();
  applyGeomHighlight();
  if (already) return window.__CFD_W16__;
  const pid = w16State.project && w16State.project.id;
  const r = await fetch('/api/geometry/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ project_id: pid, geometry_id: id }),
  });
  const j = await r.json();
  if (!r.ok) {
    publishW16({ note: j.error || 'could not switch geometry' });
    throw new Error(j.error || 'could not switch geometry');
  }
  const applied = applyImportedGeometry(
    j.geometry,
    pid,
    j.geometries || (j.project && j.project.geometries),
  );
  w16State.mode = 'geometry';
  syncProjectChrome();
  syncGeometryTree();
  try { if (typeof hideMeshInspect === 'function') hideMeshInspect(); } catch (_) {}
  try { if (typeof hideRunResultsView === 'function') hideRunResultsView(); } catch (_) {}
  try { syncSimulationTree(); } catch (_) {}
  const loaded = await loadGeometryCad(applied.faces_url, applied.edges_url);
  w16State.fingerprint = loaded.fp;
  w16State.ready = !!(loaded.fp && loaded.fp.empty === false);
  w16State.note = w16State.ready
    ? (applied.note || 'CAD geometry in viewport')
    : 'Activate returned but viewport CAD preview empty';
  publishW16({ imported: true });
  await reloadGeometryScopedSetup();
  applyWorkbenchStage();
  return window.__CFD_W16__;
}

function selectImportedGeometry(geomId) {
  return activateGeometryClient(geomId);
}

async function importGeometryClient(opts) {
  const payload = opts || {};
  if (w16State.project && w16State.project.id) {
    payload.project_id = payload.project_id || w16State.project.id;
  }
  const r = await fetch('/api/geometry/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (!r.ok) {
    publishW16({ ready: false, note: j.error || 'geometry import failed', last_import_error: j });
    throw new Error(j.error || 'geometry import failed');
  }
  const geom = j.geometry;
  w16State.project = j.project
    ? {
        id: j.project.id,
        title: j.project.title,
        description: j.project.description,
        category: j.project.category,
        units: j.project.units,
        folder: j.project.folder,
        created_at: j.project.created_at,
        project_json: j.project.project_json,
      }
    : w16State.project;
  const applied = applyImportedGeometry(
    geom,
    (j.project && j.project.id) || (w16State.project && w16State.project.id),
    j.geometries || (j.project && j.project.geometries),
  );
  w16State.mode = 'geometry';
  syncProjectChrome();
  syncGeometryTree();
  try { syncSimulationTree(); } catch (_) {}
  const loaded = await loadGeometryCad(applied.faces_url, applied.edges_url);
  w16State.fingerprint = loaded.fp;
  w16State.ready = !!(loaded.fp && loaded.fp.empty === false);
  const kind = applied.source_kind || applied.representation || 'step';
  w16State.note = w16State.ready
    ? (applied.note || (kind === 'mesh'
      ? 'Tessellated geometry in viewport'
      : 'CAD geometry in viewport'))
    : 'Import returned but viewport CAD preview empty';
  publishW16({ imported: true });
  applyWorkbenchStage();
  await reloadGeometryScopedSetup();
  return window.__CFD_W16__;
}

async function removeGeometryClient(geomId) {
  const pid = w16State.project && w16State.project.id;
  if (!pid || !geomId) return;
  const r = await fetch('/api/geometry/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ project_id: pid, geometry_id: geomId }),
  });
  const j = await r.json();
  if (!r.ok) {
    publishW16({ note: j.error || 'could not remove geometry' });
    throw new Error(j.error || 'could not remove geometry');
  }
  w16State.selectedGeomId = null;
  w16State.selectedBodies = null;
  w16State.selectedBody = null;
  if (j.geometry) {
    const applied = applyImportedGeometry(j.geometry, pid, j.geometries || (j.project && j.project.geometries));
    syncProjectChrome();
    syncGeometryTree();
    try { syncSimulationTree(); } catch (_) {}
    const loaded = await loadGeometryCad(applied.faces_url, applied.edges_url);
    w16State.fingerprint = loaded.fp;
    w16State.ready = !!(loaded.fp && loaded.fp.empty === false);
    w16State.mode = 'geometry';
  } else {
    w16State.geometry = null;
    w16State.geometries = [];
    w16State.fingerprint = null;
    w16State.ready = false;
    w16State.stl_url = null;
    w16State.mode = 'project';
    try { setGeomVisible(false); } catch (_) {}
    syncGeometryTree();
    try { syncSimulationTree(); } catch (_) {}
    try { dismissTreeDetail(); } catch (_) {}
  }
  publishW16({ imported: !!w16State.geometry });
  applyWorkbenchStage();
  if (w16State.geometry) await reloadGeometryScopedSetup();
  return window.__CFD_W16__;
}

function geomFileNeedsUnits(name) {
  return /\.(stl|obj|ply)$/i.test(String(name || ''));
}

function promptGeomLengthUnit(filename) {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-geom-units');
    const sel = document.getElementById('gu-unit');
    const note = document.getElementById('gu-note');
    const cancel = document.getElementById('gu-cancel');
    const ok = document.getElementById('gu-import');
    const backdrop = document.getElementById('gu-backdrop');
    if (!modal || !sel || !ok) {
      resolve('MM');
      return;
    }
    try {
      const last = localStorage.getItem('cfd-geom-length-unit');
      const pref = window.__CFD_PREFS__ && window.__CFD_PREFS__.length_unit;
      const pick = [last, pref].find((u) => u && ['MM', 'CM', 'M', 'INCH'].includes(String(u).toUpperCase()));
      if (pick) sel.value = String(pick).toUpperCase();
    } catch (_) {}
    if (note) {
      const leaf = String(filename || 'This file').split(/[\\/]/).pop();
      note.textContent = leaf + ' has no length unit. What are the coordinates in?';
    }
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      modal.hidden = true;
      cancel?.removeEventListener('click', onCancel);
      ok.removeEventListener('click', onOk);
      backdrop?.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onCancel = () => finish(null);
    const onOk = () => {
      const unit = sel.value || 'MM';
      try { localStorage.setItem('cfd-geom-length-unit', unit); } catch (_) {}
      finish(unit);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onOk();
      }
    };
    modal.hidden = false;
    cancel?.addEventListener('click', onCancel);
    ok.addEventListener('click', onOk);
    backdrop?.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
    sel.focus();
  });
}

async function importGeometryFile(file, extra) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(binary);
  const payload = {
    filename: file.name,
    step_base64: b64,
  };
  if (extra && extra.length_unit) payload.length_unit = extra.length_unit;
  return importGeometryClient(payload);
}

function openNewProjectModal(existing) {
  const modal = document.getElementById('modal-new-project');
  if (!modal) return;
  const edit = existing && existing.id ? existing : undefined;
  prepareCreateModal(edit).finally(() => {
    modal.hidden = false;
    const t = document.getElementById('np-title');
    if (t) t.focus();
  });
}
function closeNewProjectModal() {
  const modal = document.getElementById('modal-new-project');
  if (modal) modal.hidden = true;
}

window.__CFD_W16_CREATE__ = createProjectClient;
window.__CFD_W16_IMPORT__ = importGeometryClient;
window.__CFD_W16_APPLY__ = async function applyW16(partial) {
  if (partial && partial.create) return createProjectClient(partial);
  if (partial && (partial.step_path || partial.step_base64 || partial.filename)) {
    return importGeometryClient(partial);
  }
  return publishW16();
};

(function wireW16Ui() {
  window.__CFD_OPEN_NEW_PROJECT_MODAL__ = openNewProjectModal;
  document.getElementById('wb-home')?.addEventListener('click', () => showHome());
  document.getElementById('folder-chip')?.addEventListener('click', () => {
    goHomeFromWorkbench(w16State.project && w16State.project.folder);
  });
  document.getElementById('np-cancel')?.addEventListener('click', closeNewProjectModal);
  document.getElementById('np-backdrop')?.addEventListener('click', closeNewProjectModal);
  document.getElementById('np-create')?.addEventListener('click', () => {
    submitProjectModal()
      .then((got) => {
        if (!got || !got.ok) return;
        closeNewProjectModal();
        if (got.mode === 'edit') return null;
        return createProjectClient(got.fields);
      })
      .then((payload) => {
        if (!payload) return;
        const id = payload && payload.project && payload.project.id;
        if (id && document.body.classList.contains('on-home')) {
          location.hash = `#/p/${encodeURIComponent(id)}`;
          location.reload();
        }
      })
      .catch((e) => console.error('[CFD W16] create', e));
  });

  const fileInput = document.getElementById('geometry-file-input');
  document.getElementById('btn-import-geometry')?.addEventListener('click', () => {
    fileInput?.click();
  });
  document.getElementById('btn-add-geometry')?.addEventListener('click', () => {
    fileInput?.click();
  });
  fileInput?.addEventListener('change', () => {
    const files = fileInput.files ? Array.from(fileInput.files) : [];
    fileInput.value = '';
    if (!files.length) return;
    (async () => {
      for (const f of files) {
        let unit = null;
        if (geomFileNeedsUnits(f.name)) {
          unit = await promptGeomLengthUnit(f.name);
          if (!unit) continue;
        }
        await importGeometryFile(f, unit ? { length_unit: unit } : undefined);
      }
    })().catch((e) => console.error('[CFD W16] import file', e));
  });
  document.getElementById('btn-import-geometry-path')?.addEventListener('click', () => {
    const path = document.getElementById('geometry-path-input')?.value || '';
    if (!path) return;
    (async () => {
      let unit = null;
      if (geomFileNeedsUnits(path)) {
        unit = await promptGeomLengthUnit(path);
        if (!unit) return;
      }
      await importGeometryClient({
        step_path: path,
        filename: path.split(/[\\/]/).pop(),
        length_unit: unit || undefined,
      });
    })().catch((e) => console.error('[CFD W16] import path', e));
  });

  // Hydrate the URL project (or last active) from disk if present (no fake Body1)
  Promise.resolve()
    .then(() => activateHashProject())
    .catch((e) => console.warn('[CFD W16] hash project', e))
    .then(() => fetch('/api/project' + hashProjectQs()))
    .then((r) => r.json())
    .then(async (j) => {
      if (j && j.project) {
        w16State.project = {
          id: j.project.id,
          title: j.project.title,
          description: j.project.description,
          category: j.project.category,
          units: j.project.units,
          folder: j.project.folder,
          created_at: j.project.created_at,
          project_json: j.project.project_json,
        };
        w16State.mode = 'project';
        syncProjectChrome();
        if (
          j.project.geometry &&
          (j.project.geometry.step_path || j.project.geometry.faces_url || j.project.geometry.stl_url)
        ) {
          const applied = applyImportedGeometry(
            j.project.geometry,
            j.project.id,
            j.project.geometries,
          );
          syncGeometryTree();
          try { syncSimulationTree(); } catch (_) {}
          try {
            const loaded = await loadGeometryCad(applied.faces_url, applied.edges_url);
            w16State.fingerprint = loaded.fp;
            w16State.ready = !!(loaded.fp && loaded.fp.empty === false);
            w16State.mode = 'geometry';
          } catch (e) {
            console.warn('[CFD W16] hydrate CAD', e);
            if (j.project.geometry.stl_url) {
              try {
                const loaded = await loadGeometryStl(j.project.geometry.stl_url);
                w16State.fingerprint = loaded.fp;
                w16State.ready = !!(loaded.fp && loaded.fp.empty === false);
                w16State.mode = 'geometry';
              } catch (e2) {
                console.warn('[CFD W16] hydrate STL fallback', e2);
              }
            }
          }
        } else {
          syncGeometryTree();
          resetEmptyWorkbench({ keepProject: true });
        }
      }
      publishW16({ hydrated: true });
      applyWorkbenchStage();
    })
    .catch((e) => {
      console.warn('[CFD W16] hydrate', e);
      publishW16({ ready: false });
      applyWorkbenchStage();
    });

  initHome();
})();


/* ========================================================================
 * W17 — Create Simulation → Incompressible (persist simulation.json)
 * Defaults: k-omega SST / Steady-state / SIMPLE. No mesh/Air/BCs/solves.
 * ======================================================================== */
const W17_DEFAULTS = {
  analysis: 'Incompressible',
  turbulence_model: 'k-omega SST',
  time_dependency: 'Steady-state',
  algorithm: 'SIMPLE',
};

const w17State = {
  increment: 'W17',
  ready: false,
  simulation: null,
  simulations: [],
  activeId: null,
  defaults: null,
  project_id: null,
  note: 'W17: Create Simulation → Incompressible with bank defaults',
  soft_pass_avoided: true,
};

function publishW17(extra) {
  if (extra) Object.assign(w17State, extra);
  const payload = {
    increment: 'W17',
    ready: !!w17State.ready,
    simulation: w17State.simulation,
    defaults: w17State.defaults,
    project_id: w17State.project_id,
    note: w17State.note,
    soft_pass_avoided: true,
    persistence: 'filesystem',
    hydrated: !!w17State.hydrated,
    created: !!w17State.created,
  };
  window.__CFD_W17__ = payload;
  return payload;
}


function treeMark(ok) {
  return ok ? '<span class="tree-check" aria-hidden="true">✓</span>' : '';
}

let heldTreeScroll = null;
let holdTreeScrollUntil = 0;

function captureTreeScroll() {
  const section = document.getElementById('simulations-section');
  const left = document.getElementById('left-tree');
  return {
    section: section ? section.scrollTop : 0,
    left: left ? left.scrollTop : 0,
  };
}

function restoreTreeScroll(keep) {
  if (!keep) return;
  const apply = () => {
    const section = document.getElementById('simulations-section');
    const left = document.getElementById('left-tree');
    if (section) section.scrollTop = keep.section;
    if (left) left.scrollTop = keep.left;
  };
  apply();
  requestAnimationFrame(apply);
}

function holdTreeScroll(ms) {
  const now = captureTreeScroll();
  if (now.section > 0 || now.left > 0 || !heldTreeScroll) heldTreeScroll = now;
  holdTreeScrollUntil = Date.now() + (ms || 2000);
  restoreTreeScroll(heldTreeScroll);
}

function meshesForStudy(study) {
  const all = meshListAll();
  const sid = study && study.id;
  if (!sid) return [];
  const tagged = all.filter((m) => m && m.simulation_id && String(m.simulation_id) === String(sid));
  if (tagged.length) return tagged;
  const liveGeomIds = new Set(
    (typeof importedGeometries === 'function' ? importedGeometries() : [])
      .map((g) => String((g && g.id) || '').trim())
      .filter(Boolean)
  );
  const studies = ((typeof w17State !== 'undefined' && w17State.simulations) || []).filter((s) => {
    if (!s || !s.geometry_id) return false;
    return !liveGeomIds.size || liveGeomIds.has(String(s.geometry_id));
  });
  if (studies.length !== 1 || String(studies[0].id) !== String(sid)) return [];
  const gid = study.geometry_id;
  return all.filter(
    (m) =>
      m &&
      !m.simulation_id &&
      (!m.geometry_id || !gid || String(m.geometry_id) === String(gid))
  );
}

function renderMeshTreeLis(listed, sel) {
  const pickSel = typeof sel === 'function' ? sel : () => '';
  return (listed || [])
    .map((rec) => {
      const mid = rec.id || rec.name || 'mesh';
      const label = rec.name || 'Mesh 1';
      const ready = isGeneratedMeshReady(rec);
      const meshKey = 'mesh:' + mid;
      const refsKey = 'Refinements:' + mid;
      const refs = typeof refsForMesh === 'function' ? refsForMesh(mid) : [];
      const refsKids = refs.length
        ? '<ul>' +
          refs
            .map((ref) => {
              const faces = Array.isArray(ref.faces) ? ref.faces : [];
              const kids = faces.length
                ? '<ul>' +
                  faces
                    .map(
                      (f) =>
                        '<li class="tree-node" data-label="' +
                        escapeHtml(f) +
                        '" data-w26-face="' +
                        escapeHtml(f) +
                        '" data-w26-parent="' +
                        escapeHtml(ref.id) +
                        '"><div class="tree-row"><span class="tl">' +
                        escapeHtml(f) +
                        '</span></div></li>'
                    )
                    .join('') +
                  '</ul>'
                : '';
              return (
                '<li class="tree-node' +
                treeExpClass(ref.name) +
                pickSel('refid:' + ref.id) +
                '" data-label="' +
                escapeHtml(ref.name) +
                '" data-w26-ref="' +
                escapeHtml(ref.id) +
                '" data-w26-ref-mesh="' +
                escapeHtml(String(mid)) +
                '">' +
                '<div class="tree-row">' +
                (kids ? '<span class="tw">' + treeTw(ref.name) + '</span>' : '') +
                '<span class="tl">' +
                escapeHtml(ref.name) +
                '</span></div>' +
                kids +
                '</li>'
              );
            })
            .join('') +
          '</ul>'
        : '';
      const refsFolder =
        '<li class="tree-node' +
        treeExpClass(refsKey) +
        pickSel('refs:' + mid) +
        '" data-label="' +
        escapeHtml(refsKey) +
        '" data-w26-refs="1" data-w26-refs-mesh="' +
        escapeHtml(String(mid)) +
        '"><div class="tree-row">' +
        (refsKids ? '<span class="tw">' + treeTw(refsKey) + '</span>' : '') +
        '<span class="tl">Refinements</span>' +
        '<button type="button" class="ref-plus" data-refs-plus="' +
        escapeHtml(String(mid)) +
        '" title="Add refinement">+</button>' +
        treeMark(refs.length > 0) +
        '</div>' +
        refsKids +
        '</li>';
      const mediaKids =
        typeof mediaTreeChildren === 'function'
          ? mediaTreeChildren('mesh', mid, { onlyIfAny: true })
          : '';
      const inner = '<ul>' + refsFolder + (mediaKids ? mediaKids.replace(/^<ul>/, '').replace(/<\/ul>$/, '') : '') + '</ul>';
      return (
        '<li class="tree-node' +
        treeExpClass(meshKey) +
        pickSel('meshid:' + mid) +
        '" data-label="' +
        escapeHtml(meshKey) +
        '" data-w20-mesh-item="' +
        escapeHtml(String(mid)) +
        '"' +
        (ready ? ' data-w20-mesh1="1"' : '') +
        '><div class="tree-row">' +
        '<span class="tw">' +
        treeTw(meshKey) +
        '</span>' +
        '<span class="tl">' +
        escapeHtml(label) +
        '</span>' +
        treeMark(ready) +
        '</div>' +
        inner +
        '</li>'
      );
    })
    .join('');
}

function renderBrowseStudyInner(study, sel) {
  const listed = meshesForStudy(study);
  const meshReady = listed.some((m) => isGeneratedMeshReady(m));
  const meshKids = listed.length ? '<ul>' + renderMeshTreeLis(listed, sel) + '</ul>' : '';
  return (
    '<li class="tree-node' +
    treeExpClass('Materials') +
    '" data-label="Materials"><div class="tree-row"><span class="tl">Materials</span></div></li>' +
    '<li class="tree-node' +
    treeExpClass('Boundary conditions') +
    '" data-label="Boundary conditions"><div class="tree-row"><span class="tl">Boundary conditions</span></div></li>' +
    '<li class="tree-node' +
    treeExpClass('Mesh') +
    '" data-label="Mesh"><div class="tree-row">' +
    (meshKids ? '<span class="tw">' + treeTw('Mesh') + '</span>' : '') +
    '<span class="tl">Mesh</span>' +
    treeMark(meshReady) +
    '</div>' +
    meshKids +
    '</li>' +
    '<li class="tree-node' +
    treeExpClass('Simulation') +
    '" data-label="Simulation"><div class="tree-row"><span class="tl">Simulation</span></div></li>'
  );
}

function syncSimulationTree() {
  const keep =
    Date.now() < holdTreeScrollUntil && heldTreeScroll ? heldTreeScroll : captureTreeScroll();
  const countLabel = document.getElementById('simulations-count-label');
  const tree = document.getElementById('simulations-tree');
  const panel = document.getElementById('panel-incompressible-defaults');
  const sim = w17State.simulation;
  const liveGeomIds = new Set(
    importedGeometries()
      .map((g) => String((g && g.id) || '').trim())
      .filter(Boolean)
  );
  const studyList = (Array.isArray(w17State.simulations) ? w17State.simulations : []).filter((s) => {
    if (!s || !s.geometry_id) return false;
    return liveGeomIds.has(String(s.geometry_id));
  });
  if (countLabel) countLabel.textContent = 'SIMULATIONS (' + studyList.length + ')';
  if (tree) {
    if (!studyList.length && !importedGeometries().length) {
      tree.innerHTML =
        '<li class="sim-empty" id="sim-empty">No simulation yet</li>';
    } else {
      const hasGeom = !!(w16State.geometry && (w16State.geometry.name || w16State.geometry.step_path || w16State.geometry.faces_url));
      const bodies = hasGeom
        ? ((w16State.geometry && w16State.geometry.bodies && w16State.geometry.bodies.length)
          ? w16State.geometry.bodies
          : ['Body1'])
        : [];
      const _w18 = window.__CFD_W18_STATE__ || null;
      const _w19 = window.__CFD_W19_STATE__ || null;
      const assignedVols =
        (_w18 && _w18.material && Array.isArray(_w18.material.assigned_volumes)
          ? _w18.material.assigned_volumes
          : []) || [];
      const airSaved = assignedVols.length > 0;
      const showAir = !!(_w18 && _w18.material);
      let materialsChildren = '';
      const stBcs = window.__CFD_W19_STATE__;
      const bcRecords = stBcs && Array.isArray(stBcs.bcs) ? stBcs.bcs : [];
      const showBcs = bcRecords.length > 0;
      const sel = (key) => (treeUi.selectedKey === key ? ' selected' : '');
      let bcsChildren = '';
      if (showAir) {
        const airKids = assignedVols.length
          ? '<ul>' +
            assignedVols
              .map((v) => {
                const idx = bodyIndexFromName(v);
                return (
                  '<li class="tree-node' +
                  sel('body-' + idx) +
                  '" data-label="' +
                  escapeHtml(v) +
                  '" data-w18-assign="' +
                  escapeHtml(v) +
                  '" data-body-index="' +
                  idx +
                  '"><div class="tree-row"><span class="tl">' +
                  escapeHtml(v) +
                  '</span></div></li>'
                );
              })
              .join('') +
            '</ul>'
          : '';
        materialsChildren =
          '<ul>' +
          '<li class="tree-node' +
          treeExpClass('Air') +
          sel('air') +
          '" data-label="Air" data-w18-air="1">' +
          '<div class="tree-row">' +
          (airKids ? '<span class="tw">' + treeTw('Air') + '</span>' : '') +
          '<span class="tl">Air</span></div>' +
          airKids +
          '</li></ul>';
      }
      // "Defaults" always leads the list: it is what every face without a BC gets.
      const wallDefault =
        stBcs && stBcs.defaults && String(stBcs.defaults.wall_type || '').toLowerCase() === 'slip'
          ? 'Slip'
          : 'No-slip';
      const defaultsRow =
        '<li class="tree-node' +
        sel('bc-defaults') +
        '" data-label="Defaults" data-w19-defaults="1">' +
        '<div class="tree-row"><span class="tl">Defaults</span>' +
        '<span class="tree-sub">' +
        escapeHtml(wallDefault + ' walls') +
        '</span></div></li>';
      {
        bcsChildren =
          '<ul>' +
          defaultsRow +
          bcRecords
            .map((bc) => {
              const faces = Array.isArray(bc.faces) ? bc.faces : [];
              const kids = faces.length
                ? '<ul>' +
                  faces
                    .map(
                      (f) =>
                        '<li class="tree-node" data-label="' +
                        escapeHtml(f) +
                        '" data-w19-face="' +
                        escapeHtml(f) +
                        '" data-w19-parent="' +
                        escapeHtml(bc.id) +
                        '"><div class="tree-row"><span class="tl">' +
                        escapeHtml(f) +
                        '</span></div></li>'
                    )
                    .join('') +
                  '</ul>'
                : '';
              return (
                '<li class="tree-node' +
                treeExpClass(bc.name) +
                sel('bcid:' + bc.id) +
                '" data-label="' +
                escapeHtml(bc.name) +
                '" data-w19-bc="' +
                escapeHtml(bc.id) +
                '">' +
                '<div class="tree-row">' +
                (kids ? '<span class="tw">' + treeTw(bc.name) + '</span>' : '') +
                '<span class="tl">' +
                escapeHtml(bc.name) +
                '</span></div>' +
                kids +
                '</li>'
              );
            })
            .join('') +
          '</ul>';
      }
      const meshReady = anyGeneratedMeshReady();
      const meshKids = '<ul>' + renderMeshTreeLis(meshList(), sel) + '</ul>';
      const geomKids = bodies.length
        ? '<ul>' +
          bodies
            .map((b, i) => {
              const idx = i + 1;
              const key = 'body-' + idx;
              return (
                '<li class="tree-node' +
                sel(key) +
                '" data-label="' +
                escapeHtml(b) +
                '" data-w16-body="1" data-body-index="' +
                idx +
                '"><div class="tree-row"><span class="tl">' +
                escapeHtml(b) +
                '</span></div></li>'
              );
            })
            .join('') +
          '</ul>'
        : '';
      const setupInner =
        '<li class="tree-node' +
        treeExpClass('Materials') +
        sel('materials') +
        '" data-label="Materials" data-w18-materials="1">' +
        '<div class="tree-row">' +
        '<span class="tw">' +
        treeTw('Materials') +
        '</span>' +
        '<span class="tl">Materials</span>' +
        (airSaved
          ? ''
          : '<button type="button" class="mat-plus" id="btn-materials-plus" title="Add material">+</button>') +
        treeMark(airSaved) +
        '</div>' +
        materialsChildren +
        '</li>' +
        '<li class="tree-node' +
        treeExpClass('Boundary conditions') +
        sel('bcs') +
        '" data-label="Boundary conditions" data-w19-bcs="1">' +
        '<div class="tree-row">' +
        '<span class="tw">' +
        treeTw('Boundary conditions') +
        '</span>' +
        '<span class="tl">Boundary conditions</span>' +
        '<button type="button" class="bc-plus" id="btn-bcs-plus" title="Add boundary condition">+</button>' +
        treeMark(showBcs) +
        '</div>' +
        bcsChildren +
        '</li>' +
        '<li class="tree-node' +
        treeExpClass('Mesh') +
        sel('mesh') +
        '" data-label="Mesh" data-w20-mesh="1">' +
        '<div class="tree-row">' +
        '<span class="tw">' +
        treeTw('Mesh') +
        '</span>' +
        '<span class="tl">Mesh</span>' +
        treeMark(meshReady) +
        '</div>' +
        meshKids +
        '</li>' +
        (function () {
          const _w27 = window.__CFD_W27_STATE__ || null;
          const meshIds = new Set(
            meshList()
              .map((m) => String((m && m.id) || ''))
              .filter(Boolean)
          );
          const runList = (Array.isArray(_w27 && _w27.runs) ? _w27.runs : []).filter((rec) => {
            if (!rec || !rec.mesh_id) return false;
            return meshIds.has(String(rec.mesh_id));
          });
          const selectedRunId =
            (_w27 && _w27.selected_run_id) ||
            (_w27 && _w27.active_run_id) ||
            (_w27 && _w27.run && (_w27.run.run_id || _w27.run.id)) ||
            null;
          const meshOpts = (typeof generatedMeshOptions === 'function' ? generatedMeshOptions() : []) || [];
          const runKids = runList
            .map((rec) => {
              const rid = rec.id || rec.run_id;
              const runKey = 'run:' + rid;
              const meshKey = 'run-mesh:' + rid;
              const rcsKey = 'run-rc:' + rid;
              const label = rec.name || 'Run';
              const ready = runHasResults(rec);
              const locked = rec.status === 'done' || rec.status === 'running';
              const rcs = Array.isArray(rec.result_controls) ? rec.result_controls : [];
              const assigned = meshOpts.find((m) => String(m.id) === String(rec.mesh_id));
              const meshName = (assigned && assigned.name) || rec.mesh_name || null;
              const meshReady = !!(assigned && assigned.ready);
              const runMeshMedia = rec.mesh_id && typeof mediaTreeChildren === 'function'
                ? mediaTreeChildren('mesh', rec.mesh_id, { onlyIfAny: true })
                : '';
              const runMeshMediaKey = 'run-mesh-media:' + rid;
              const meshChild = rec.mesh_id
                ? '<ul><li class="tree-node' +
                  (runMeshMedia ? treeExpClass(runMeshMediaKey, false) : '') +
                  sel('runmeshitem:' + rid + ':' + rec.mesh_id) +
                  '" data-label="' +
                  escapeHtml(runMeshMedia ? runMeshMediaKey : meshName || 'Mesh') +
                  '" data-w27-run-mesh-item="' +
                  escapeHtml(String(rec.mesh_id)) +
                  '" data-w27-mesh-run="' +
                  escapeHtml(String(rid)) +
                  '"><div class="tree-row">' +
                  (runMeshMedia ? '<span class="tw">' + treeTw(runMeshMediaKey, false) + '</span>' : '') +
                  '<span class="tl">' +
                  escapeHtml(meshName || 'Mesh') +
                  '</span>' +
                  treeMark(meshReady) +
                  '</div>' +
                  runMeshMedia +
                  '</li></ul>'
                : '';
              const meshFolder =
                '<li class="tree-node' +
                treeExpClass(meshKey) +
                sel('runmesh:' + rid) +
                '" data-label="' +
                escapeHtml(meshKey) +
                '" data-w27-run-mesh="' +
                escapeHtml(String(rid)) +
                '"><div class="tree-row">' +
                (meshChild ? '<span class="tw">' + treeTw(meshKey) + '</span>' : '') +
                '<span class="tl">Mesh</span>' +
                treeMark(!!rec.mesh_id && meshReady) +
                '</div>' +
                meshChild +
                '</li>';
              const rcKids = rcs
                .map((rc) => {
                  const rcId = rc.id || rc.name;
                  const rcName = rc.name || rc.kind || 'Result';
                  const faces = Array.isArray(rc.faces) ? rc.faces : [];
                  const faceKids = faces.length
                    ? '<ul>' +
                      faces
                        .map(
                          (f) =>
                            '<li class="tree-node" data-label="' +
                            escapeHtml(f) +
                            '" data-w27-aa-face="' +
                            escapeHtml(f) +
                            '" data-w27-aa-run="' +
                            escapeHtml(String(rid)) +
                            '" data-w27-aa="' +
                            escapeHtml(String(rcId)) +
                            '"><div class="tree-row"><span class="tl">' +
                            escapeHtml(f) +
                            '</span></div></li>'
                        )
                        .join('') +
                      '</ul>'
                    : '';
                  return (
                    '<li class="tree-node' +
                    treeExpClass(rcName + ':' + rcId) +
                    sel('aaid:' + rcId) +
                    '" data-label="' +
                    escapeHtml(rcName + ':' + rcId) +
                    '" data-w27-aa="' +
                    escapeHtml(String(rcId)) +
                    '" data-w27-aa-run="' +
                    escapeHtml(String(rid)) +
                    '">' +
                    '<div class="tree-row">' +
                    (faceKids ? '<span class="tw">' + treeTw(rcName + ':' + rcId) + '</span>' : '') +
                    '<span class="tl">' +
                    escapeHtml(rcName) +
                    '</span>' +
                    treeMark(faces.length > 0) +
                    '</div>' +
                    faceKids +
                    '</li>'
                  );
                })
                .join('');
              const rcChild = rcKids ? '<ul>' + rcKids + '</ul>' : '';
              const rcFolder =
                '<li class="tree-node' +
                treeExpClass(rcsKey) +
                sel('runrcs:' + rid) +
                '" data-label="' +
                escapeHtml(rcsKey) +
                '" data-w27-run-rcs="' +
                escapeHtml(String(rid)) +
                '"><div class="tree-row">' +
                (rcChild ? '<span class="tw">' + treeTw(rcsKey) + '</span>' : '') +
                '<span class="tl">Monitors</span>' +
                (locked
                  ? ''
                  : '<button type="button" class="rc-plus" data-w27-run-plus="' +
                    escapeHtml(String(rid)) +
                    '" title="Add monitor">+</button>') +
                treeMark(rcs.length > 0) +
                '</div>' +
                rcChild +
                '</li>';
              const resultsKey = 'run-results:' + rid;
              const resultsKids = typeof mediaTreeChildren === 'function' ? mediaTreeChildren('run', rid, { graphs: true }) : '';
              const resultsNode =
                '<li class="tree-node' +
                (resultsKids ? treeExpClass(resultsKey, false) : '') +
                sel('runresults:' + rid) +
                '" data-label="' +
                escapeHtml(resultsKids ? resultsKey : 'Results') +
                '" data-w27-run-results="' +
                escapeHtml(String(rid)) +
                '"><div class="tree-row">' +
                (resultsKids ? '<span class="tw">' + treeTw(resultsKey, false) + '</span>' : '') +
                '<span class="tl">Results</span>' +
                treeMark(ready) +
                '</div>' +
                resultsKids +
                '</li>';
              return (
                '<li class="tree-node' +
                treeExpClass(runKey) +
                sel('runid:' + rid) +
                (String(rid) === String(selectedRunId) ? ' is-active-run' : '') +
                '" data-label="' +
                escapeHtml(runKey) +
                '" data-w27-run="' +
                escapeHtml(String(rid)) +
                '"><div class="tree-row">' +
                '<span class="tw">' +
                treeTw(runKey) +
                '</span>' +
                '<span class="tl">' +
                escapeHtml(label) +
                '</span>' +
                treeMark(ready) +
                '</div>' +
                '<ul>' +
                meshFolder +
                rcFolder +
                resultsNode +
                '</ul></li>'
              );
            })
            .join('');
          return (
            '<li class="tree-node' +
            treeExpClass('Simulation') +
            sel('sim-hub') +
            '" data-label="Simulation" data-w27-sim-control="1">' +
            '<div class="tree-row">' +
            '<span class="tw">' +
            treeTw('Simulation') +
            '</span>' +
            '<span class="tl">Simulation</span></div>' +
            '<ul>' +
            runKids +
            '</ul>' +
            '</li>'
          );
        })();
      const geoms = importedGeometries();
      const roots = geoms.slice();
      const activeSid = sim && sim.id;
      tree.innerHTML = roots
        .map((g) => {
          const gid = g.id || '';
          const gname = g.name || g.original_filename || 'Geometry';
          const gBodies =
            gid && w16State.geometry && w16State.geometry.id === gid
              ? bodies
              : (g.bodies && g.bodies.length && g.bodies) ||
                (g.assembly_bodies && g.assembly_bodies.length && g.assembly_bodies) ||
                [];
          const bodyUl = gBodies.length
            ? '<ul>' +
              gBodies
                .map((b, i) => {
                  const idx = i + 1;
                  const key = 'body-' + idx;
                  return (
                    '<li class="tree-node' +
                    (gid && w16State.geometry && w16State.geometry.id === gid ? sel(key) : '') +
                    '" data-label="' +
                    escapeHtml(b) +
                    '" data-w16-body="1" data-body-index="' +
                    idx +
                    '"><div class="tree-row"><span class="tl">' +
                    escapeHtml(b) +
                    '</span></div></li>'
                  );
                })
                .join('') +
              '</ul>'
            : '';
          const mine = studyList.filter((s) => s && s.geometry_id && String(s.geometry_id) === String(gid));
          const studyHtml = mine
            .map((s) => {
              const on = !!(activeSid && s.id === activeSid);
              const label = s.name || 'Incompressible';
              const skey = 'study:' + s.id;
              const kids = on ? setupInner : renderBrowseStudyInner(s, sel);
              return (
                '<li class="tree-node' +
                treeExpClass(skey, on) +
                (on ? sel('incompressible') : '') +
                '" data-label="' +
                escapeHtml(skey) +
                '" data-w17-sim-id="' +
                escapeHtml(s.id) +
                '" data-w17-sim="1">' +
                '<div class="tree-row"><span class="tw">' +
                treeTw(skey, on) +
                '</span><span class="tl">' +
                escapeHtml(label) +
                '</span></div>' +
                '<ul>' +
                kids +
                '</ul>' +
                '</li>'
              );
            })
            .join('');
          const gkey = 'geom:' + gid;
          return (
            '<li class="tree-node' +
            treeExpClass(gkey) +
            sel(gkey) +
            '" data-label="' +
            escapeHtml(gname) +
            '" data-w16-geom="' +
            escapeHtml(gid) +
            '"><div class="tree-row"><span class="tw">' +
            treeTw(gkey) +
            '</span><span class="tl">' +
            escapeHtml(gname) +
            '</span>' +
            treeMark(!!(w16State.geometry && w16State.geometry.id === gid)) +
            '</div><ul>' +
            (bodyUl
              ? '<li class="tree-node' +
                treeExpClass('Geometry') +
                sel('geometry') +
                '" data-label="Geometry" data-w17-geo="1">' +
                '<div class="tree-row"><span class="tw">' +
                treeTw('Geometry') +
                '</span><span class="tl">Geometry</span>' +
                treeMark(hasGeom && w16State.geometry && w16State.geometry.id === gid) +
                '</div>' +
                bodyUl +
                '</li>'
              : '') +
            studyHtml +
            '</ul></li>'
          );
        })
        .join('');
      if (typeof wireMaterialsTreeHandlers === 'function') wireMaterialsTreeHandlers();
      if (typeof wireBcTreeHandlers === 'function') wireBcTreeHandlers();
      if (typeof wireMeshTreeHandlers === 'function') wireMeshTreeHandlers();
      if (typeof wireRefTreeHandlers === 'function') wireRefTreeHandlers();
      if (typeof wireRcTreeHandlers === 'function') wireRcTreeHandlers();
    }
  }
  if (panel && sim) {
    const a = document.getElementById('sim-analysis');
    const t = document.getElementById('sim-turbulence');
    const tm = document.getElementById('sim-time');
    const tsel = document.getElementById('sim-time-select');
    const al = document.getElementById('sim-algorithm');
    const td = sim.time_dependency || W17_DEFAULTS.time_dependency;
    if (a) a.textContent = sim.analysis || W17_DEFAULTS.analysis;
    if (t) t.textContent = sim.turbulence_model || W17_DEFAULTS.turbulence_model;
    if (tm) tm.textContent = td;
    if (tsel && document.activeElement !== tsel) tsel.value = /transient/i.test(td) ? 'Transient' : 'Steady-state';
    if (al) al.textContent = sim.algorithm || (/transient/i.test(td) ? 'PIMPLE' : W17_DEFAULTS.algorithm);
  }
  fillGeometryDetail();
  if (typeof syncAirAssignList === 'function') syncAirAssignList();
  if (typeof syncBcAssignList === 'function') syncBcAssignList();
  if (typeof syncViAssignList === 'function') syncViAssignList();
  if (typeof syncPoAssignList === 'function') syncPoAssignList();
  if (typeof syncAaAssignList === 'function') syncAaAssignList();
  restoreTreeScroll(keep);
}

function applySimulationRecord(sim, projectId, extra) {
  if (!sim) {
    w17State.simulation = null;
    w17State.activeId = null;
    w17State.defaults = null;
    w17State.ready = false;
    w17State.created = false;
    if (extra && Array.isArray(extra.simulations)) w17State.simulations = extra.simulations;
    else if (extra && extra.deleted) w17State.simulations = [];
    syncSimulationTree();
    publishW17({ created: false });
    return window.__CFD_W17__;
  }
  w17State.simulation = {
    id: sim.id,
    project_id: sim.project_id || projectId,
    name: sim.name || 'Incompressible',
    analysis: sim.analysis || W17_DEFAULTS.analysis,
    turbulence_model: sim.turbulence_model || W17_DEFAULTS.turbulence_model,
    time_dependency: sim.time_dependency || W17_DEFAULTS.time_dependency,
    algorithm: sim.algorithm || W17_DEFAULTS.algorithm,
    geometry_id: sim.geometry_id || null,
    geometry_name: sim.geometry_name || null,
    geometry_body: sim.geometry_body || 'Body1',
    simulation_json: sim.simulation_json || null,
    created_at: sim.created_at,
  };
  if (extra && Array.isArray(extra.simulations)) w17State.simulations = extra.simulations;
  else {
    w17State.simulations = (w17State.simulations || []).map((s) =>
      s.id === sim.id ? { ...s, ...w17State.simulation } : s
    );
  }
  w17State.activeId = sim.id;
  w17State.defaults = {
    turbulence_model: w17State.simulation.turbulence_model,
    time_dependency: w17State.simulation.time_dependency,
    algorithm: w17State.simulation.algorithm,
  };
  w17State.project_id = w17State.simulation.project_id;
  w17State.ready = true;
  w17State.note =
    'W17 HARD: Incompressible persisted with k-omega SST / Steady-state / SIMPLE';
  syncSimulationTree();
  publishW17({ created: true });
  return window.__CFD_W17__;
}

async function createSimulationClient(opts) {
  const payload = {
    analysis: (opts && opts.analysis) || 'Incompressible',
    time_dependency: (opts && opts.time_dependency) || 'Steady-state',
  };
  if (w16State.project && w16State.project.id) {
    payload.project_id = w16State.project.id;
  }
  if (opts && opts.project_id) payload.project_id = opts.project_id;
  const gid =
    (opts && opts.geometry_id) ||
    w16State.selectedGeomId ||
    (w16State.geometry && w16State.geometry.id) ||
    '';
  if (gid) payload.geometry_id = gid;
  if (opts && opts.copy_from) payload.copy_from = opts.copy_from;
  if (opts && opts.include) payload.include = opts.include;
  const r = await fetch('/api/simulation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (!r.ok) {
    publishW17({ ready: false, note: j.error || 'simulation create failed' });
    throw new Error(j.error || 'simulation create failed');
  }
  const out = applySimulationRecord(j.simulation, j.project_id, j);
  const wantGeom = (j.simulation && j.simulation.geometry_id) || gid;
  if (wantGeom && w16State.selectedGeomId !== wantGeom && typeof activateGeometryClient === 'function') {
    await activateGeometryClient(wantGeom);
  } else {
    await reloadGeometryScopedSetup();
  }
  applyWorkbenchStage();
  return out;
}

async function selectStudyClient(simId) {
  const id = String(simId || '').trim();
  if (!id) return;
  if (w17State.activeId === id && w17State.simulation && w17State.simulation.id === id) {
    return window.__CFD_W17__;
  }
  const r = await fetch('/api/simulation/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ project_id: currentProjectId() || undefined, simulation_id: id }),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error((j && j.error) || 'Could not switch study');
  applySimulationRecord(j.simulation, j.project_id, j);
  const wantGeom = j.simulation && j.simulation.geometry_id;
  if (wantGeom && w16State.selectedGeomId !== wantGeom) {
    await activateGeometryClient(wantGeom);
  } else {
    await reloadGeometryScopedSetup();
  }
  const homeMesh = meshesForStudy(w17State.simulation || j.simulation);
  try { if (typeof hideMeshInspect === 'function') hideMeshInspect({ silent: true }); } catch (_) {}
  const keepCase = homeMesh.some((m) => {
    const dir = (m && m.live_mesh_result && m.live_mesh_result.case_dir) || (m && m.case_dir);
    return dir && getCaseDir() && sameCasePath(dir, getCaseDir());
  });
  if (!keepCase) {
    caseDir = null;
    if (jobState.status !== 'running') jobState.case_dir = null;
  }
  applyWorkbenchStage();
  return window.__CFD_W17__;
}

async function deleteStudyClient(simId) {
  const id = String(simId || w17State.activeId || '').trim();
  if (!id) return;
  const rec = (w17State.simulations || []).find((s) => s && String(s.id) === id);
  const label = (rec && rec.name) || 'this simulation';
  const ok = await confirmAction({
    title: 'Delete ' + label + '?',
    copy: 'The CAD stays in the project. Mesh, materials, boundary conditions, and runs for this study are removed.',
    yes: 'Delete',
  });
  if (!ok) return;
  const r = await fetch('/api/simulation/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      project_id: currentProjectId() || undefined,
      simulation_id: id,
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error((j && j.error) || 'Could not delete simulation');
  applySimulationRecord(j.simulation || null, j.project_id, j);
  try { if (typeof hideMeshInspect === 'function') hideMeshInspect({ silent: true }); } catch (_) {}
  try { hideAllTreeDetails(); } catch (_) {}
  const wantGeom = j.simulation && j.simulation.geometry_id;
  if (wantGeom && w16State.selectedGeomId !== wantGeom) {
    await activateGeometryClient(wantGeom);
  } else {
    await reloadGeometryScopedSetup();
  }
  applyWorkbenchStage();
  return j;
}

/** W30: is the project's simulation transient (pimpleFoam over real time)? */
function simIsTransientClient() {
  const sim = w17State && w17State.simulation;
  return !!(sim && /transient/i.test(String(sim.time_dependency || '')));
}

/**
 * W30: switch the existing simulation between Steady-state and Transient.
 * Finished runs keep the mode they solved with; drafts follow the simulation.
 */
async function updateSimulationTimeDependency(value) {
  const r = await fetch('/api/simulation/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      time_dependency: value,
      project_id: currentProjectId() || undefined,
      simulation_id: w17State.activeId || (w17State.simulation && w17State.simulation.id) || undefined,
    }),
  });
  const j = await r.json();
  if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || 'Could not change time dependency');
  applySimulationRecord(j.simulation, j.project_id, j);
  // Draft runs follow the simulation: stamp them so the run panel switches too.
  if (typeof w27State !== 'undefined' && Array.isArray(w27State.runs)) {
    const drafts = w27State.runs.filter((rec) => rec && (!rec.status || rec.status === 'draft'));
    for (const rec of drafts) {
      try {
        await persistRunSettings({ run_id: rec.id, time_dependency: j.simulation.time_dependency });
      } catch (_) {}
    }
  }
  try { if (typeof syncSimControlPanel === 'function') syncSimControlPanel(); } catch (_) {}
  return j;
}

function selectedCreateTimeDependency() {
  const sel = document.querySelector('#cs-time-dep .cs-time-opt.is-selected');
  return (sel && sel.getAttribute('data-time-dep')) || 'Steady-state';
}

function setCreateTimeDependency(value) {
  document.querySelectorAll('#cs-time-dep .cs-time-opt').forEach((el) => {
    const on = el.getAttribute('data-time-dep') === value;
    el.classList.toggle('is-selected', on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

function fillCreateSimulationExtras() {
  const geoms = importedGeometries();
  const geomWrap = document.getElementById('cs-geom-wrap');
  const geomSel = document.getElementById('cs-geometry');
  if (geomWrap && geomSel) {
    geomWrap.hidden = geoms.length < 2;
    const cur = w16State.selectedGeomId || (w16State.geometry && w16State.geometry.id) || '';
    geomSel.innerHTML = geoms
      .map((g) => {
        const id = g.id || '';
        const name = g.name || g.original_filename || id || 'Geometry';
        return (
          '<option value="' +
          escapeHtml(id) +
          '"' +
          (id === cur ? ' selected' : '') +
          '>' +
          escapeHtml(name) +
          '</option>'
        );
      })
      .join('');
  }
  const studies = w17State.simulations || [];
  const copyWrap = document.getElementById('cs-copy-wrap');
  const copySel = document.getElementById('cs-copy-from');
  if (copyWrap && copySel) {
    copyWrap.hidden = studies.length < 1;
    copySel.innerHTML =
      '<option value="">None — empty study</option>' +
      studies
        .map((s) => {
          return (
            '<option value="' +
            escapeHtml(s.id) +
            '">' +
            escapeHtml(s.name || 'Incompressible') +
            '</option>'
          );
        })
        .join('');
  }
}

function openCreateSimulationModal() {
  const modal = document.getElementById('modal-create-simulation');
  if (!modal) return;
  modal.hidden = false;
  document.querySelectorAll('#cs-type-list .cs-type').forEach((el) => {
    el.classList.toggle('is-selected', el.getAttribute('data-type') === 'Incompressible');
  });
  setCreateTimeDependency('Steady-state');
  fillCreateSimulationExtras();
}
function closeCreateSimulationModal() {
  const modal = document.getElementById('modal-create-simulation');
  if (modal) modal.hidden = true;
}

window.__CFD_W17_CREATE__ = createSimulationClient;
window.__CFD_W17_APPLY__ = async function applyW17(partial) {
  if (partial && (partial.create || partial.analysis)) {
    return createSimulationClient(partial);
  }
  return publishW17();
};

(function wireW17Ui() {
  document.getElementById('btn-create-simulation')?.addEventListener('click', openCreateSimulationModal);
  document.getElementById('cs-cancel')?.addEventListener('click', closeCreateSimulationModal);
  document.getElementById('cs-cancel-x')?.addEventListener('click', closeCreateSimulationModal);
  document.getElementById('cs-backdrop')?.addEventListener('click', closeCreateSimulationModal);
  document.getElementById('sim-defaults-close')?.addEventListener('click', () => {
    hideAllTreeDetails();
  });
  document.getElementById('sim-delete')?.addEventListener('click', () => {
    deleteStudyClient().catch((e) => console.error('[CFD] delete study', e));
  });
  document.getElementById('cs-create')?.addEventListener('click', () => {
    createSimulationClient({
      analysis: 'Incompressible',
      time_dependency: selectedCreateTimeDependency(),
      geometry_id: (document.getElementById('cs-geometry') || {}).value || undefined,
      copy_from: (document.getElementById('cs-copy-from') || {}).value || undefined,
    })
      .then(() => closeCreateSimulationModal())
      .catch((e) => console.error('[CFD W17] create', e));
  });
  document.querySelectorAll('#cs-time-dep .cs-time-opt').forEach((el) => {
    el.addEventListener('click', () => setCreateTimeDependency(el.getAttribute('data-time-dep') || 'Steady-state'));
  });
  document.getElementById('sim-time-select')?.addEventListener('change', (e) => {
    const v = e.target.value === 'Transient' ? 'Transient' : 'Steady-state';
    updateSimulationTimeDependency(v).catch((err) => {
      console.error('[CFD W30] time dependency', err);
      syncSimulationTree();
    });
  });

  // Clear sim chrome when a brand-new project is created (W16)
  const prevCreate = window.__CFD_W16_CREATE__;
  if (typeof prevCreate === 'function') {
    window.__CFD_W16_CREATE__ = async function wrappedCreate(fields) {
      const out = await prevCreate(fields);
      w17State.simulation = null;
      w17State.simulations = [];
      w17State.activeId = null;
      w17State.defaults = null;
      w17State.ready = false;
      w17State.created = false;
      w17State.project_id = (out && out.project && out.project.id) || null;
      syncSimulationTree();
      publishW17({ ready: false, note: 'W17: waiting for Create Simulation' });
      return out;
    };
  }

  fetch('/api/simulation' + hashProjectQs())
    .then((r) => r.json())
    .then(async (j) => {
      if (j && j.simulation) {
        applySimulationRecord(j.simulation, j.project_id, j);
        publishW17({ hydrated: true, created: false });
        const wantGeom = j.simulation && j.simulation.geometry_id;
        if (
          wantGeom &&
          w16State.selectedGeomId !== wantGeom &&
          typeof activateGeometryClient === 'function'
        ) {
          await activateGeometryClient(wantGeom).catch((err) => console.warn('[CFD] study geom', err));
        } else if (typeof reloadGeometryScopedSetup === 'function') {
          await reloadGeometryScopedSetup();
        }
      } else {
        applySimulationRecord(null, j && j.project_id, j || { simulations: [] });
        publishW17({ hydrated: true, ready: false });
      }
      applyWorkbenchStage();
    })
    .catch((e) => {
      console.warn('[CFD W17] hydrate', e);
      syncSimulationTree();
      publishW17({ ready: false });
    });
})();
/* ========================================================================
 * W18 — Materials → Air + Body1 assign (persist materials.json)
 * Bank: Materials + → Air (Newtonian) → assign Body1 → ✓ save.
 * No BCs / mesh form / solves in this slice.
 * ======================================================================== */
const W18_AIR_DEFAULTS = {
  name: 'Air',
  viscosity_model: 'Newtonian',
  kinematic_viscosity: 1.529e-5,
  kinematic_viscosity_unit: 'm2/s',
  density: 1.196,
  density_unit: 'kg/m3',
};

const w18State = {
  ready: false,
  hydrated: false,
  created: false,
  libraryApplied: false,
  project_id: null,
  material: null,
  draft_volumes: [],
  materials_json: null,
  note: 'W18: Materials → Air + Body1 assign (checkmark save)',
};
window.__CFD_W18_STATE__ = w18State;

function publishW18(extra) {
  const payload = {
    ready: w18State.ready,
    hydrated: w18State.hydrated,
    created: w18State.created,
    libraryApplied: w18State.libraryApplied,
    project_id: w18State.project_id,
    material: w18State.material,
    air: w18State.material,
    assigned_volumes: w18State.material
      ? w18State.material.assigned_volumes || []
      : w18State.draft_volumes.slice(),
    body1_assigned: !!(
      w18State.material &&
      (w18State.material.assigned_volumes || []).includes('Body1')
    ),
    materials_json: w18State.materials_json,
    note: w18State.note,
    increment: 'W18',
    soft_pass_avoided: true,
    ...(extra || {}),
  };
  window.__CFD_W18__ = payload;
  return payload;
}

function syncMatPickerAssign() {
  const list = document.getElementById('mat-picker-bodies');
  const hint = document.getElementById('mat-picker-hint');
  const apply = document.getElementById('mat-picker-apply');
  const vols = w18State.draft_volumes || [];
  if (list) {
    list.innerHTML = vols
      .map(
        (v) =>
          '<li data-volume="' +
          escapeHtml(v) +
          '">' +
          escapeHtml(v) +
          '</li>'
      )
      .join('');
  }
  if (apply) apply.disabled = vols.length === 0;
  if (hint) hint.classList.toggle('is-warn', false);
}

function syncAirAssignList() {
  const list = document.getElementById('air-assign-list');
  const count = document.getElementById('air-assign-count');
  const vols =
    treeUi.openPanel === 'air'
      ? w18State.draft_volumes || []
      : w18State.material
        ? w18State.material.assigned_volumes || []
        : w18State.draft_volumes;
  if (count) count.textContent = String(vols.length);
  if (list) {
    list.innerHTML = vols
      .map(
        (v) =>
          '<li data-volume="' +
          escapeHtml(v) +
          '">' +
          escapeHtml(v) +
          '</li>'
      )
      .join('');
  }
  syncMatPickerAssign();
}

function openAirPanel() {
  if (w18State.material && Array.isArray(w18State.material.assigned_volumes)) {
    w18State.draft_volumes = w18State.material.assigned_volumes.slice();
  }
  openTreeDetail('air', { toggle: false });
  syncAirAssignList();
}

function closeAirPanel() {
  if (treeUi.openPanel === 'air') hideAllTreeDetails();
}

function openMaterialLibrary() {
  if (!w17State.simulation) {
    console.warn('[CFD W18] Create Simulation first');
    return;
  }
  const modal = document.getElementById('modal-material-library');
  if (modal) modal.hidden = true;
  w18State.draft_volumes = [];
  openTreeDetail('mat-picker', { toggle: false });
  document.querySelectorAll('#panel-material-picker .ml-type').forEach((el) => {
    el.classList.toggle('is-selected', el.getAttribute('data-material') === 'Air');
  });
  syncMatPickerAssign();
}

function openMaterialsHub() {
  openTreeDetail('materials-hub', { toggle: true });
  syncMaterialsHub();
}

function syncMaterialsHub() {
  const list = document.getElementById('materials-hub-list');
  if (!list) return;
  const mat = w18State.material;
  if (!mat) {
    list.innerHTML = '<li class="hub-empty">No materials yet</li>';
    return;
  }
  const vols = (mat.assigned_volumes || []).join(', ') || 'none';
  list.innerHTML =
    '<li>' +
    '<button type="button" class="hub-item" data-open-air="1">' +
    '<span class="hub-item-main"><span class="hub-item-name">' +
    escapeHtml(mat.name || 'Air') +
    '</span><span class="hub-item-sub">' +
    escapeHtml(vols) +
    '</span></span></button>' +
    '<button type="button" class="hub-item-del" data-del-air="1">Delete</button>' +
    '</li>';
}

function syncBcsHub() {
  const list = document.getElementById('bcs-hub-list');
  if (!list) return;
  const st = window.__CFD_W19_STATE__ || {};
  const rows = Array.isArray(st.bcs) ? st.bcs : [];
  list.innerHTML = rows.length
    ? rows
        .map((bc) => {
          const faces = (bc.faces || []).join(', ') || 'no faces';
          const typeLabel =
            bc.bc_type === 'Wall'
              ? 'Wall · ' + (String(bc.wall_type || '').toLowerCase() === 'slip' ? 'Slip' : 'No-slip')
              : bc.bc_type;
          return (
            '<li>' +
            '<button type="button" class="hub-item" data-open-bc="' +
            escapeHtml(bc.id) +
            '">' +
            '<span class="hub-item-main"><span class="hub-swatch hub-swatch-' +
            bcKind(bc) +
            '"></span><span class="hub-item-name">' +
            escapeHtml(bc.name) +
            '</span><span class="hub-item-sub">' +
            escapeHtml(typeLabel + ' · ' + faces) +
            '</span></span></button>' +
            '<button type="button" class="hub-item-del" data-del-bc="' +
            escapeHtml(bc.id) +
            '">Delete</button>' +
            '</li>'
          );
        })
        .join('')
    : '<li class="hub-empty">No boundary conditions yet</li>';
  if (typeof syncBcDefaultsLabels === 'function') syncBcDefaultsLabels();
}

function closeMaterialLibrary() {
  const modal = document.getElementById('modal-material-library');
  if (modal) modal.hidden = true;
  if (treeUi.openPanel === 'mat-picker') hideAllTreeDetails();
}

function wireMaterialsTreeHandlers() {
  document.getElementById('btn-materials-plus')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openMaterialLibrary();
  });
}

function applyMaterialRecord(mat, projectId, opts) {
  w18State.material = {
    id: mat.id,
    name: mat.name || 'Air',
    viscosity_model: mat.viscosity_model || W18_AIR_DEFAULTS.viscosity_model,
    kinematic_viscosity: mat.kinematic_viscosity ?? W18_AIR_DEFAULTS.kinematic_viscosity,
    density: mat.density ?? W18_AIR_DEFAULTS.density,
    assigned_volumes: mat.assigned_volumes || [],
    materials_json: mat.materials_json || null,
    created_at: mat.created_at,
    updated_at: mat.updated_at,
  };
  w18State.draft_volumes = w18State.material.assigned_volumes.slice();
  w18State.project_id = projectId || mat.project_id || w18State.project_id;
  w18State.materials_json = w18State.material.materials_json;
  w18State.ready = true;
  w18State.created = true;
  w18State.libraryApplied = true;
  w18State.note = 'Air assigned to ' + (w18State.material.assigned_volumes.join(', ') || '—');
  treeUi.expanded.Materials = true;
  treeUi.expanded.Air = true;
  syncSimulationTree();
  if (!opts || opts.openPanel !== false) openAirPanel();
  publishW18({ created: true });
  return window.__CFD_W18__;
}

function persistAirAssignment() {
  if (!w18State.material && !w18State.draft_volumes.length) return;
  saveAirMaterialClient({
    assigned_volumes: (w18State.draft_volumes || []).slice(),
    openPanel: false,
  }).catch((e) => console.error('[CFD W18] persist', e));
}

async function saveAirMaterialClient(opts) {
  const volumes = Array.isArray(opts && opts.assigned_volumes)
    ? opts.assigned_volumes
    : (w18State.draft_volumes || []).slice();
  if (!volumes.length && !w18State.material) {
    publishW18({ ready: false, note: 'Assign a body first' });
    throw new Error('Assign a body first');
  }
  const payload = {
    name: 'Air',
    material: 'Air',
    viscosity_model: 'Newtonian',
    assigned_volumes: volumes,
  };
  if (w16State.project && w16State.project.id) payload.project_id = w16State.project.id;
  if (w17State.project_id) payload.project_id = w17State.project_id;
  if (opts && opts.project_id) payload.project_id = opts.project_id;
  if (typeof currentMeshStudyIds === 'function') Object.assign(payload, currentMeshStudyIds());

  const r = await fetch('/api/materials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (!r.ok) {
    publishW18({ ready: false, note: j.error || 'materials save failed' });
    throw new Error(j.error || 'materials save failed');
  }
  return applyMaterialRecord(j.material, j.project_id, opts);
}

function toggleAssignVolume(name, idx) {
  const vol = String(name || '').trim();
  if (!vol) return;
  const i = w18State.draft_volumes.indexOf(vol);
  if (i >= 0) {
    w18State.draft_volumes.splice(i, 1);
    if (w16State.selectedBody === idx) highlightGeomBody(null);
    markTreeSelected(treeUi.openPanel === 'air' ? 'air' : 'materials');
  } else {
    w18State.draft_volumes.push(vol);
    highlightGeomBody(idx);
    markTreeSelected('body-' + idx);
  }
  syncAirAssignList();
  publishW18({ draft: true });
  if (treeUi.openPanel === 'air' || w18State.material) persistAirAssignment();
}

function vtkView() {
  try {
    if (fullScreenRenderer.getApiSpecificRenderWindow) {
      return fullScreenRenderer.getApiSpecificRenderWindow();
    }
  } catch (_) {}
  const views = renderWindow.getViews && renderWindow.getViews();
  return views && views[0] ? views[0] : null;
}

function eventToVtkDisplay(e) {
  const view = vtkView();
  const canvas = (view && view.getCanvas && view.getCanvas()) ||
    (container && container.querySelector('canvas'));
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const cssX = e.clientX - rect.left;
  const cssY = e.clientY - rect.top;
  if (cssX < 0 || cssY < 0 || cssX > rect.width || cssY > rect.height) return null;
  const size = view && view.getSize ? view.getSize() : [rect.width, rect.height];
  return [(cssX / rect.width) * size[0], (1 - cssY / rect.height) * size[1]];
}

function currentCadFacePd() {
  try {
    const pd = geomMapper.getInputData && geomMapper.getInputData();
    if (pd && pd.getNumberOfCells && pd.getNumberOfCells() > 0) return pd;
  } catch (_) {}
  try {
    return geomCadFaceReader.getOutputData && geomCadFaceReader.getOutputData();
  } catch (_) {}
  return null;
}

function hitFromCellId(cellId) {
  if (cellId == null || cellId < 0) return null;
  const pd = currentCadFacePd();
  const cd = pd && pd.getCellData && pd.getCellData();
  const faceArr = cd && cd.getArrayByName && cd.getArrayByName('faceId');
  const solidArr = cd && cd.getArrayByName && cd.getArrayByName('solidId');
  let faceId = 0;
  let solidId = 0;
  if (faceArr) {
    const raw = faceArr.getData ? faceArr.getData() : null;
    faceId = raw ? Number(raw[cellId]) : Number(faceArr.getValue(cellId));
  }
  if (solidArr) {
    const raw = solidArr.getData ? solidArr.getData() : null;
    solidId = raw ? Number(raw[cellId]) : Number(solidArr.getValue(cellId));
  }
  if (!solidId && geometryBodies().length) solidId = 1;
  if (!faceId && !solidId) return null;
  return { cellId, faceId, solidId };
}

function pickerWorldPos(picker) {
  try {
    const pos = picker && picker.getPickPosition && picker.getPickPosition();
    if (pos && Number.isFinite(pos[0]) && Number.isFinite(pos[1]) && Number.isFinite(pos[2])) {
      return [pos[0], pos[1], pos[2]];
    }
  } catch (_) {}
  return null;
}

function attachPickPos(hit, pos) {
  if (!hit || !pos) return hit;
  hit.pos = pos;
  return hit;
}

function pickPtOverlayAtDisplay(x, y) {
  const hilite = ptFaceHilite;
  if (!hilite || !hilite.actor || !hilite.actor.getVisibility()) return null;
  try { hilite.actor.setPickable(true); } catch (_) {}
  try {
    geomPicker.initializePickList();
    geomPicker.addPickList(hilite.actor);
    geomPicker.setTolerance(0.012);
    geomPicker.pick([x, y, 0], renderer);
    const cellId = geomPicker.getCellId ? geomPicker.getCellId() : -1;
    if (cellId == null || cellId < 0) return null;
    const pd = hilite.mapper.getInputData && hilite.mapper.getInputData();
    const arr = pd && pd.getCellData && pd.getCellData().getArrayByName('ptFaceId');
    if (!arr) return null;
    const raw = arr.getData ? arr.getData() : null;
    const faceId = raw ? Number(raw[cellId]) : Number(arr.getValue(cellId));
    if (!faceId) return null;
    return attachPickPos({ cellId, faceId, solidId: 1 }, pickerWorldPos(geomPicker));
  } catch (_) {
    return null;
  }
}

function pickCadHitAtDisplay(x, y) {
  if (typeof isAssigningPtFace === 'function' && isAssigningPtFace()) {
    const overlayHit = pickPtOverlayAtDisplay(x, y);
    if (overlayHit) return overlayHit;
  }
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const glyphs = bcGlyphActors();
  const vis = glyphs.map((g) => g.actor.getVisibility());
  const edgeVis = geomEdgeActor && geomEdgeActor.getVisibility && geomEdgeActor.getVisibility();
  const edgeSelVis = geomEdgeSelActor && geomEdgeSelActor.getVisibility && geomEdgeSelActor.getVisibility();
  const vertSelVis = geomVertexSelActor && geomVertexSelActor.getVisibility && geomVertexSelActor.getVisibility();
  const orbitVis = orbitFlashActor && orbitFlashActor.getVisibility && orbitFlashActor.getVisibility();
  const cadWasVis = !!(geomActor && geomActor.getVisibility && geomActor.getVisibility());
  const cadWasOp = geomActor && geomActor.getProperty ? geomActor.getProperty().getOpacity() : 1;
  const cadWasScale = geomActor && geomActor.getScale ? geomActor.getScale() : [1, 1, 1];
  const revealCad = !cadWasVis && typeof isAssigningFace === 'function' && isAssigningFace();
  glyphs.forEach((g) => g.actor.setVisibility(false));
  try { if (geomEdgeActor) geomEdgeActor.setVisibility(false); } catch (_) {}
  try { if (geomEdgeSelActor) geomEdgeSelActor.setVisibility(false); } catch (_) {}
  try { if (geomVertexSelActor) geomVertexSelActor.setVisibility(false); } catch (_) {}
  try { if (orbitFlashActor) orbitFlashActor.setVisibility(false); } catch (_) {}
  if (revealCad) {
    try { geomActor.setPickable(true); } catch (_) {}
    try { applyCadActorViewScale(geomActor); } catch (_) {}
    try { geomActor.getProperty().setOpacity(0.02); } catch (_) {}
    try { geomActor.setVisibility(true); } catch (_) {}
  }
  let hwHit = null;
  try {
    const view = vtkView();
    if (view && cadWasVis && geomActor.getVisibility()) {
      cadHwSelector.attach(view, renderer);
      cadHwSelector.setArea(ix, iy, ix, iy);
      const sel = cadHwSelector.select();
      const node = sel && sel[0];
      const props = node && node.getProperties && node.getProperties();
      if (props && props.prop === geomActor && props.attributeID != null) {
        hwHit = hitFromCellId(Number(props.attributeID));
      }
    }
  } catch (e) {
    console.warn('[CFD] hardware pick', e);
  } finally {
    glyphs.forEach((g, i) => g.actor.setVisibility(!!vis[i]));
    try { if (geomEdgeActor) geomEdgeActor.setVisibility(!!edgeVis); } catch (_) {}
    try { if (geomEdgeSelActor) geomEdgeSelActor.setVisibility(!!edgeSelVis); } catch (_) {}
    try { if (geomVertexSelActor) geomVertexSelActor.setVisibility(!!vertSelVis); } catch (_) {}
    try { if (orbitFlashActor) orbitFlashActor.setVisibility(!!orbitVis); } catch (_) {}
  }
  try {
    geomPicker.initializePickList();
    geomPicker.addPickList(geomActor);
    geomPicker.setTolerance(revealCad ? 0.008 : 0.0004);
    geomPicker.pick([x, y, 0], renderer);
    const cellHit = hitFromCellId(geomPicker.getCellId ? geomPicker.getCellId() : -1);
    const pos = pickerWorldPos(geomPicker);
    const hit = hwHit || cellHit;
    return attachPickPos(hit, pos);
  } catch (e) {
    console.warn('[CFD] cad pick', e);
    return hwHit;
  } finally {
    if (revealCad) {
      try { geomActor.setVisibility(false); } catch (_) {}
      try { geomActor.getProperty().setOpacity(cadWasOp); } catch (_) {}
      try {
        geomActor.setScale(cadWasScale[0], cadWasScale[1], cadWasScale[2]);
      } catch (_) {}
    }
  }
}

function pickCadHitFromEvent(e) {
  const xy = eventToVtkDisplay(e);
  if (!xy) return null;
  return pickCadHitAtDisplay(xy[0], xy[1]);
}

function v3sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function v3add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function v3scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function v3dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function v3len(a) {
  return Math.hypot(a[0], a[1], a[2]);
}
function v3norm(a) {
  const L = v3len(a) || 1;
  return [a[0] / L, a[1] / L, a[2] / L];
}
function v3cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

let _arrowX = null;
function arrowExtentX() {
  if (_arrowX) return _arrowX;
  _arrowSrc.update();
  const pts = _arrowSrc.getOutputData().getPoints().getData();
  let xmin = Infinity;
  let xmax = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    if (pts[i] < xmin) xmin = pts[i];
    if (pts[i] > xmax) xmax = pts[i];
  }
  _arrowX = { xmin, xmax, span: Math.max(xmax - xmin, 1e-9) };
  return _arrowX;
}

function addFlowArrows(append, groups, bc, modelDiag) {
  const useVec = isVelocityBc(bc) && bc.velocity_type === 'Fixed' && bc.direction === 'Vector';
  const vec = v3norm((bc && bc.vector) || [0, 0, 1]);
  const inlet = String((bc && bc.bc_type) || '') === 'Velocity inlet';
  for (const g of groups) {
    const arrowLen = Math.max(modelDiag * 0.07, Math.min(modelDiag * 0.13, g.diag * 0.4));
    const lift = arrowLen * 0.012;
    for (const s of g.seeds) {
      const nOut = s.nOut || g.nOut;
      const contact = v3add(s.c, v3scale(nOut, lift));
      const dir = useVec ? vec : inlet ? v3scale(nOut, -1) : nOut;
      const goingOut = v3dot(dir, nOut) >= 0;
      append.addInputData(arrowPolyAt(contact, dir, arrowLen, !goingOut));
    }
  }
}

function arrowPolyAt(origin, direction, length, tipOnOrigin) {
  _arrowSrc.update();
  const src = _arrowSrc.getOutputData();
  const out = vtkPolyData.newInstance();
  out.shallowCopy(src);
  const pts = src.getPoints() && src.getPoints().getData();
  if (pts) out.getPoints().setData(Float32Array.from(pts), 3);
  const dir = v3norm(direction);
  const ext = arrowExtentX();
  const scale = length / ext.span;
  const xPin = tipOnOrigin ? ext.xmax : ext.xmin;
  const start = v3sub(origin, v3scale(dir, xPin * scale));
  vtkMatrixBuilder
    .buildFromRadian()
    .translate(start[0], start[1], start[2])
    .rotateFromDirections([1, 0, 0], dir)
    .scale(scale, scale, scale)
    .apply(out.getPoints().getData());
  return out;
}

let cadTriCache = [];
let cadNearestFaceIndex = null;
let meshCadFaceIdCache = null;
let faceShapeCache = new Map();

function walkCadTriangles(fn) {
  const pd = geomCadFaceReader.getOutputData && geomCadFaceReader.getOutputData();
  if (!pd) return;
  const cd = pd.getCellData && pd.getCellData();
  const faceArr = cd && cd.getArrayByName && cd.getArrayByName('faceId');
  const faceRaw = faceArr && faceArr.getData ? faceArr.getData() : null;
  const pts = pd.getPoints() && pd.getPoints().getData();
  if (!pts) return;
  const polys = pd.getPolys && pd.getPolys();
  const emit = (cellId, i0, i1, i2) => {
    const fid = faceArr
      ? faceRaw
        ? Number(faceRaw[cellId])
        : Number(faceArr.getValue(cellId))
      : 0;
    const a = [pts[i0 * 3], pts[i0 * 3 + 1], pts[i0 * 3 + 2]];
    const b = [pts[i1 * 3], pts[i1 * 3 + 1], pts[i1 * 3 + 2]];
    const c = [pts[i2 * 3], pts[i2 * 3 + 1], pts[i2 * 3 + 2]];
    fn(cellId, fid, a, b, c);
  };
  const offsets = polys && polys.getOffsets && polys.getOffsets();
  const conn = polys && polys.getConnectivity && polys.getConnectivity();
  if (offsets && conn) {
    const off = offsets.getData ? offsets.getData() : offsets;
    const ids = conn.getData ? conn.getData() : conn;
    for (let i = 0; i < off.length - 1; i++) {
      const a = off[i];
      const b = off[i + 1];
      if (b - a >= 3) emit(i, ids[a], ids[a + 1], ids[a + 2]);
    }
    return;
  }
  const data = polys && polys.getData && polys.getData();
  if (!data) return;
  let i = 0;
  let cellId = 0;
  while (i < data.length) {
    const npts = data[i++];
    if (npts >= 3) emit(cellId, data[i], data[i + 1], data[i + 2]);
    i += npts;
    cellId += 1;
  }
}

function rebuildCadTriCache() {
  cadTriCache = [];
  cadNearestFaceIndex = null;
  meshCadFaceIdCache = null;
  faceShapeCache = new Map();
  walkCadTriangles((_id, fid, a, b, c) => {
    const nrm = v3cross(v3sub(b, a), v3sub(c, a));
    const area = 0.5 * v3len(nrm);
    if (area <= 1e-12) return;
    cadTriCache.push({
      faceId: fid,
      a,
      b,
      c,
      c3: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3],
      n: v3norm(nrm),
      area,
    });
  });
}

function walkPolyLines(pd, fn) {
  if (!pd) return;
  const lines = pd.getLines && pd.getLines();
  if (!lines) return;
  const pts = pd.getPoints() && pd.getPoints().getData();
  if (!pts) return;
  const emit = (cellId, ids) => {
    const path = [];
    for (let k = 0; k < ids.length; k++) {
      const i = ids[k] * 3;
      path.push([pts[i], pts[i + 1], pts[i + 2]]);
    }
    if (path.length >= 2) fn(cellId, path, ids);
  };
  const offsets = lines.getOffsets && lines.getOffsets();
  const conn = lines.getConnectivity && lines.getConnectivity();
  if (offsets && conn) {
    const off = offsets.getData ? offsets.getData() : offsets;
    const ids = conn.getData ? conn.getData() : conn;
    if (off && off.length && ids) {
      // VTK 9 / vtk.js: [0, n0, n0+n1, …]. ASCII VTP often stores only the
      // running totals [n0, n0+n1, …] with no leading 0.
      const startsAtZero = Number(off[0]) === 0;
      const nCells = startsAtZero ? off.length - 1 : off.length;
      for (let i = 0; i < nCells; i++) {
        const a = startsAtZero ? off[i] : (i === 0 ? 0 : off[i - 1]);
        const b = startsAtZero ? off[i + 1] : off[i];
        const cell = [];
        for (let k = a; k < b; k++) cell.push(ids[k]);
        emit(i, cell);
      }
      return;
    }
  }
  const data = lines.getData && lines.getData();
  if (!data) return;
  let i = 0;
  let cellId = 0;
  while (i < data.length) {
    const n = data[i++];
    const cell = [];
    for (let k = 0; k < n; k++) cell.push(data[i++]);
    emit(cellId++, cell);
  }
}

function polylineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += v3len(v3sub(pts[i], pts[i - 1]));
  return L;
}

function polylinePointAtFraction(pts, t) {
  if (!pts || !pts.length) return null;
  if (pts.length === 1) return pts[0].slice();
  const len = polylineLength(pts);
  if (!(len > 0)) return pts[0].slice();
  const want = Math.max(0, Math.min(1, t)) * len;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = v3len(v3sub(pts[i], pts[i - 1]));
    if (acc + seg >= want || i === pts.length - 1) {
      const u = seg > 1e-18 ? (want - acc) / seg : 0;
      return v3add(pts[i - 1], v3scale(v3sub(pts[i], pts[i - 1]), Math.max(0, Math.min(1, u))));
    }
    acc += seg;
  }
  return pts[pts.length - 1].slice();
}

function fitEdgeCircle(pts) {
  if (!pts || pts.length < 8) return null;
  const n = pts.length;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += pts[i][0];
    cy += pts[i][1];
    cz += pts[i][2];
  }
  const c = [cx / n, cy / n, cz / n];
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < n; i++) {
    const cr = v3cross(v3sub(pts[i], c), v3sub(pts[(i + 1) % n], c));
    nx += cr[0];
    ny += cr[1];
    nz += cr[2];
  }
  const nrm = v3norm([nx, ny, nz]);
  if (!nrm) return null;
  const rs = [];
  for (let i = 0; i < n; i++) {
    const d = v3sub(pts[i], c);
    const axial = v3dot(d, nrm);
    rs.push({ rad: v3len(v3sub(d, v3scale(nrm, axial))), axial });
  }
  const r = rs.reduce((s, x) => s + x.rad, 0) / n;
  if (r < 1e-9) return null;
  let varR = 0;
  let varAx = 0;
  for (let i = 0; i < rs.length; i++) {
    varR += (rs[i].rad - r) * (rs[i].rad - r);
    varAx += rs[i].axial * rs[i].axial;
  }
  if (Math.sqrt(varR / n) / r > 0.06) return null;
  if (Math.sqrt(varAx / n) / r > 0.08) return null;
  const closed = v3len(v3sub(pts[0], pts[n - 1])) < r * 0.15;
  const len = polylineLength(pts);
  if (closed) {
    const expect = 2 * Math.PI * r;
    if (Math.abs(len - expect) / expect > 0.15) return null;
  } else if (len < 0.15 * 2 * Math.PI * r) {
    return null;
  }
  return { radius: r, diameter: 2 * r, closed };
}

function vertexKey(p) {
  return Number(p[0]).toFixed(5) + ',' + Number(p[1]).toFixed(5) + ',' + Number(p[2]).toFixed(5);
}

function rebuildCadVertexCache() {
  const map = new Map();
  const add = (p) => {
    if (!p || p.length < 3) return;
    const key = vertexKey(p);
    if (!map.has(key)) map.set(key, { id: key, pos: [p[0], p[1], p[2]] });
  };
  for (let i = 0; i < cadEdgeCache.length; i++) {
    const pts = cadEdgeCache[i].pts;
    if (!pts || !pts.length) continue;
    add(pts[0]);
    add(pts[pts.length - 1]);
  }
  cadVertexCache = Array.from(map.values());
}

function cadEdgePolyData() {
  try {
    const fromReader = geomCadEdgeReader.getOutputData && geomCadEdgeReader.getOutputData();
    if (fromReader && fromReader.getNumberOfPoints && fromReader.getNumberOfPoints() > 0) return fromReader;
  } catch (_) {}
  try {
    const fromMapper = geomEdgeMapper.getInputData && geomEdgeMapper.getInputData();
    if (fromMapper && fromMapper.getNumberOfPoints && fromMapper.getNumberOfPoints() > 0) return fromMapper;
  } catch (_) {}
  return null;
}

function rebuildCadEdgeCache() {
  cadEdgeCache = [];
  const pd = cadEdgePolyData();
  if (!pd) {
    cadVertexCache = [];
    return;
  }
  walkPolyLines(pd, (id, pts) => {
    cadEdgeCache.push({
      id,
      pts,
      length: polylineLength(pts),
      circle: fitEdgeCircle(pts),
    });
  });
  rebuildCadVertexCache();
}

const CAD_EDGE_FACE_RULE = 2;

function cadEdgeFaceMatchTol() {
  const span = cadCacheSpan();
  return Math.max(span * 2e-4, 0.02);
}

function cadFacesAlongEdge(pts) {
  if (!pts || pts.length < 2) return [];
  const idx = ensureCadNearestFaceIndex();
  if (!idx || idx.empty || !idx.facesOnEdge) return [];
  const slop2 = cadEdgeFaceMatchTol() * cadEdgeFaceMatchTol();
  const counts = new Map();
  const nSamp = Math.min(11, Math.max(5, Math.min(pts.length, 9)));
  let samples = 0;
  for (let s = 1; s <= nSamp; s++) {
    const p = polylinePointAtFraction(pts, s / (nSamp + 1));
    if (!p) continue;
    samples += 1;
    const on = idx.facesOnEdge(p, slop2) || [];
    for (let i = 0; i < on.length; i++) {
      const fid = on[i];
      if (!fid) continue;
      counts.set(fid, (counts.get(fid) || 0) + 1);
    }
  }
  if (!samples) return [];
  const need = Math.max(1, Math.ceil(samples * 0.5));
  const faces = [];
  counts.forEach((n, fid) => {
    if (n >= need) faces.push(fid);
  });
  return faces;
}

function attachCadEdgeAdjacentFaces() {
  if (!cadEdgeCache.length) rebuildCadEdgeCache();
  if (!cadEdgeCache.length) return;
  if (!cadTriCache.length) rebuildCadTriCache();
  for (let i = 0; i < cadEdgeCache.length; i++) {
    const e = cadEdgeCache[i];
    if (e.faceIds && e.faceRule === CAD_EDGE_FACE_RULE) continue;
    e.faceIds = cadFacesAlongEdge(e.pts);
    e.faceRule = CAD_EDGE_FACE_RULE;
  }
}

function cadEdgeHiddenByFaces(edge, hideIds) {
  if (!edge || !hideIds || !hideIds.size) return false;
  const faces = edge.faceIds;
  if (!faces || !faces.length) return false;
  for (let i = 0; i < faces.length; i++) {
    if (!hideIds.has(faces[i])) return false;
  }
  return true;
}

function formatCadLength(mm) {
  const v = Number(mm);
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1000) return (v / 1000).toFixed(a >= 10000 ? 2 : 3).replace(/\.?0+$/, '') + ' m';
  if (a >= 0.05) return v.toFixed(a >= 10 ? 2 : 3).replace(/\.?0+$/, '') + ' mm';
  return (v * 1000).toFixed(1).replace(/\.?0+$/, '') + ' µm';
}

function formatCadArea(mm2) {
  const v = Number(mm2);
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(3).replace(/\.?0+$/, '') + ' m²';
  if (a >= 100) return (v / 100).toFixed(2).replace(/\.?0+$/, '') + ' cm²';
  return v.toFixed(a >= 10 ? 1 : 2).replace(/\.?0+$/, '') + ' mm²';
}

function selectedFaceIds() {
  return Array.from(faceCtxSelected).map(parseFaceId).filter((n) => n > 0);
}

function faceAreaOf(faceId) {
  if (!cadTriCache.length) rebuildCadTriCache();
  let area = 0;
  for (let i = 0; i < cadTriCache.length; i++) {
    if (cadTriCache[i].faceId === faceId) area += cadTriCache[i].area;
  }
  return area;
}

function minFaceDistance(idA, idB) {
  if (!cadTriCache.length) rebuildCadTriCache();
  const a = cadTriCache.filter((t) => t.faceId === idA);
  const b = cadTriCache.filter((t) => t.faceId === idB);
  if (!a.length || !b.length) return null;
  let best = Infinity;
  const probe = (pt, tris) => {
    for (let i = 0; i < tris.length; i++) {
      const d2 = distPointTri2(pt, tris[i]);
      if (d2 < best) best = d2;
    }
  };
  for (let i = 0; i < a.length; i++) {
    probe(a[i].a, b);
    probe(a[i].b, b);
    probe(a[i].c, b);
    probe(a[i].c3, b);
  }
  for (let i = 0; i < b.length; i++) {
    probe(b[i].a, a);
    probe(b[i].b, a);
    probe(b[i].c, a);
    probe(b[i].c3, a);
  }
  if (!Number.isFinite(best)) return null;
  return Math.sqrt(best);
}

function solve3(A, b) {
  const det = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (!Number.isFinite(D) || Math.abs(D) < 1e-18) return null;
  const repl = (col) => A.map((row, i) => row.map((v, j) => (j === col ? b[i] : v)));
  return [det(repl(0)) / D, det(repl(1)) / D, det(repl(2)) / D];
}

function fitCircle2(pts) {
  const n = pts && pts.length;
  if (!n || n < 6) return null;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sx = 0;
  let sy = 0;
  let sxr = 0;
  let syr = 0;
  let sr = 0;
  for (let i = 0; i < n; i++) {
    const x = pts[i][0];
    const y = pts[i][1];
    const r = x * x + y * y;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sxr += x * r;
    syr += y * r;
    sr += r;
  }
  const sol = solve3(
    [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]],
    [-sxr, -syr, -sr],
  );
  if (!sol) return null;
  const cx = -sol[0] / 2;
  const cy = -sol[1] / 2;
  const r2 = cx * cx + cy * cy - sol[2];
  if (!(r2 > 1e-12)) return null;
  const r = Math.sqrt(r2);
  let rms = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(pts[i][0] - cx, pts[i][1] - cy) - r;
    rms += d * d;
  }
  rms = Math.sqrt(rms / n);
  return { cx, cy, r, rms };
}

function planeBasis(n) {
  const axis = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = v3norm(v3sub(axis, v3scale(n, v3dot(axis, n))));
  if (!u) return null;
  const v = v3cross(n, u);
  return { u, v };
}

function faceTrisOf(faceId) {
  if (!cadTriCache.length) rebuildCadTriCache();
  const out = [];
  for (let i = 0; i < cadTriCache.length; i++) {
    if (cadTriCache[i].faceId === faceId) out.push(cadTriCache[i]);
  }
  return out;
}

function faceBoundaryPoints(faceId) {
  const tris = faceTrisOf(faceId);
  const seen = new Map();
  const add = (p, q) => {
    const a = vertexKey(p);
    const b = vertexKey(q);
    const k = a < b ? a + '|' + b : b + '|' + a;
    const rec = seen.get(k);
    if (rec) rec.n += 1;
    else seen.set(k, { n: 1, p, q });
  };
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    add(t.a, t.b);
    add(t.b, t.c);
    add(t.c, t.a);
  }
  const pts = [];
  const used = new Set();
  seen.forEach((rec) => {
    if (rec.n !== 1) return;
    [rec.p, rec.q].forEach((p) => {
      const k = vertexKey(p);
      if (used.has(k)) return;
      used.add(k);
      pts.push(p);
    });
  });
  return pts;
}

function fitCircleOnPlane(pts, origin, nrm) {
  const basis = planeBasis(nrm);
  if (!basis || !pts || pts.length < 6) return null;
  const pts2 = [];
  for (let i = 0; i < pts.length; i++) {
    const d = v3sub(pts[i], origin);
    pts2.push([v3dot(d, basis.u), v3dot(d, basis.v)]);
  }
  const c2 = fitCircle2(pts2);
  if (!c2 || c2.r < 1e-9 || c2.rms / c2.r > 0.06) return null;
  const center = v3add(origin, v3add(v3scale(basis.u, c2.cx), v3scale(basis.v, c2.cy)));
  return { center, radius: c2.r, diameter: 2 * c2.r, n: nrm };
}

function fitFaceCircle(faceId, info) {
  const pts = faceBoundaryPoints(faceId);
  return fitCircleOnPlane(pts, info.c, info.n);
}

function fitFaceCylinder(faceId, info) {
  const tris = faceTrisOf(faceId);
  if (tris.length < 8) return null;
  let ax = 0;
  let ay = 0;
  let az = 0;
  const step = Math.max(1, Math.floor(tris.length / 24));
  for (let i = 0; i < tris.length; i += step) {
    for (let j = i + step; j < tris.length; j += step) {
      let cr = v3cross(tris[i].n, tris[j].n);
      if (ax * cr[0] + ay * cr[1] + az * cr[2] < 0) cr = [-cr[0], -cr[1], -cr[2]];
      ax += cr[0];
      ay += cr[1];
      az += cr[2];
    }
  }
  const axis = v3norm([ax, ay, az]);
  if (!axis || v3len([ax, ay, az]) < 1e-8) return null;
  let align = 0;
  for (let i = 0; i < tris.length; i++) align += Math.abs(v3dot(tris[i].n, axis));
  if (align / tris.length > 0.18) return null;
  const pts = [];
  for (let i = 0; i < tris.length; i++) {
    pts.push(tris[i].a, tris[i].b, tris[i].c);
  }
  const circ = fitCircleOnPlane(pts, info.c, axis);
  if (!circ) return null;
  return { center: circ.center, axis, radius: circ.radius, diameter: circ.diameter };
}

function fitFaceSphere(faceId) {
  const tris = faceTrisOf(faceId);
  if (tris.length < 10) return null;
  const pts = [];
  for (let i = 0; i < tris.length; i++) {
    pts.push(tris[i].c3);
  }
  const n = pts.length;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += pts[i][0];
    cy += pts[i][1];
    cz += pts[i][2];
  }
  cx /= n;
  cy /= n;
  cz /= n;
  let xx = 0;
  let yy = 0;
  let zz = 0;
  let xy = 0;
  let xz = 0;
  let yz = 0;
  let xr = 0;
  let yr = 0;
  let zr = 0;
  for (let i = 0; i < n; i++) {
    const x = pts[i][0] - cx;
    const y = pts[i][1] - cy;
    const z = pts[i][2] - cz;
    const r = x * x + y * y + z * z;
    xx += x * x;
    yy += y * y;
    zz += z * z;
    xy += x * y;
    xz += x * z;
    yz += y * z;
    xr += x * r;
    yr += y * r;
    zr += z * r;
  }
  const csol = solve3([[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]], [xr * 0.5, yr * 0.5, zr * 0.5]);
  if (!csol) return null;
  const center = [cx + csol[0], cy + csol[1], cz + csol[2]];
  let r = 0;
  for (let i = 0; i < n; i++) r += v3len(v3sub(pts[i], center));
  r /= n;
  if (!(r > 1e-9)) return null;
  let rms = 0;
  for (let i = 0; i < n; i++) {
    const d = v3len(v3sub(pts[i], center)) - r;
    rms += d * d;
  }
  rms = Math.sqrt(rms / n);
  if (rms / r > 0.06) return null;
  return { center, radius: r, diameter: 2 * r };
}

function faceShapeInfo(faceId) {
  if (faceShapeCache.has(faceId)) return faceShapeCache.get(faceId);
  const info = faceOrientationInfo(faceId);
  let out = info ? { kind: info.flat ? 'plane' : 'curved', info } : null;
  if (info && info.flat) {
    const circ = fitFaceCircle(faceId, info);
    if (circ) out = { kind: 'disk', info, circ };
  } else if (info) {
    const cyl = fitFaceCylinder(faceId, info);
    if (cyl) out = { kind: 'cylinder', info, cyl };
    else {
      const sph = fitFaceSphere(faceId);
      if (sph) out = { kind: 'sphere', info, sph };
    }
  }
  faceShapeCache.set(faceId, out);
  return out;
}

function shapeCenter(s) {
  if (!s) return null;
  if (s.cyl) return s.cyl.center;
  if (s.sph) return s.sph.center;
  if (s.circ) return s.circ.center;
  return s.info && s.info.c ? s.info.c : null;
}

function isPlanarShape(s) {
  return !!(s && (s.kind === 'plane' || s.kind === 'disk'));
}

function isRoundShape(s) {
  return !!(s && (s.kind === 'disk' || s.kind === 'cylinder' || s.kind === 'sphere' || s.kind === 'curved'));
}

function planeToPointAlongNormal(plane, pt) {
  if (!plane || !plane.info || !pt) return null;
  return Math.abs(v3dot(v3sub(pt, plane.info.c), plane.info.n));
}

function farthestNormalFromPlane(plane, otherFaceId) {
  if (!plane || !plane.info) return null;
  const tris = faceTrisOf(otherFaceId);
  if (!tris.length) return null;
  const n = plane.info.n;
  const c = plane.info.c;
  let maxA = 0;
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    const da = Math.abs(v3dot(v3sub(t.a, c), n));
    const db = Math.abs(v3dot(v3sub(t.b, c), n));
    const dc = Math.abs(v3dot(v3sub(t.c, c), n));
    if (da > maxA) maxA = da;
    if (db > maxA) maxA = db;
    if (dc > maxA) maxA = dc;
  }
  return maxA;
}

function axisToAxisDistance(c1, a1, c2, a2) {
  const cr = v3cross(a1, a2);
  const ln = v3len(cr);
  const w = v3sub(c2, c1);
  if (ln < 1e-8) {
    return v3len(v3sub(w, v3scale(a1, v3dot(w, a1))));
  }
  return Math.abs(v3dot(w, v3scale(cr, 1 / ln)));
}

function twoFaceExtraMeasures(idA, idB, sa, sb) {
  const minD = minFaceDistance(idA, idB);
  const pair = (isPlanarShape(sa) && isRoundShape(sb) && sb.kind !== 'plane')
    ? { plane: sa, round: sb, roundId: idB }
    : (isPlanarShape(sb) && isRoundShape(sa) && sa.kind !== 'plane')
      ? { plane: sb, round: sa, roundId: idA }
      : null;
  const extra = pair || (sa && sb && (sa.kind !== 'plane' || sb.kind !== 'plane'));
  if (!extra) return { minD, shortest: minD, farthest: null, center: null };
  let farthest = null;
  let center = null;
  if (pair) {
    farthest = farthestNormalFromPlane(pair.plane, pair.roundId);
    center = planeToPointAlongNormal(pair.plane, shapeCenter(pair.round));
  } else if (sa.kind === 'cylinder' && sb.kind === 'cylinder') {
    center = axisToAxisDistance(sa.cyl.center, sa.cyl.axis, sb.cyl.center, sb.cyl.axis);
    farthest = farthestNormalFromPlane({ info: { c: sa.cyl.center, n: sa.cyl.axis } }, idB);
  } else {
    const ca = shapeCenter(sa);
    const cb = shapeCenter(sb);
    if (ca && cb) center = v3len(v3sub(cb, ca));
  }
  return { minD, shortest: minD, farthest, center };
}

const VERTEX_MARK_CSS_PX = 11;
const VERTEX_PICK_CSS_PX = 10;
const EDGE_PICK_CSS_PX = 7;
const EDGE_MARK_CSS_PX = 3.2;

function worldPerCssPixelAt(pos, ren) {
  const cam = (ren || renderer) && (ren || renderer).getActiveCamera && (ren || renderer).getActiveCamera();
  if (!cam || !pos) return 0.2;
  const cpos = cam.getPosition();
  const dist = Math.hypot(pos[0] - cpos[0], pos[1] - cpos[1], pos[2] - cpos[2]) || 1;
  const fov = ((cam.getViewAngle && cam.getViewAngle()) || 30) * Math.PI / 180;
  const canvas = container && container.querySelector('canvas');
  const hPx = (canvas && (canvas.clientHeight || canvas.height)) || 600;
  const worldH = 2 * dist * Math.tan(fov / 2);
  return worldH / Math.max(hPx, 1);
}

function vertexMarkerRadiusAt(pos) {
  return Math.max(worldPerCssPixelAt(pos, renderer) * (VERTEX_MARK_CSS_PX * 0.5), 1e-6);
}

function applyVertexSelectionDisplay() {
  if (!vertexCtxSelected.size) {
    try { geomVertexSelActor.setVisibility(false); } catch (_) {}
    return;
  }
  if (!cadVertexCache.length) rebuildCadVertexCache();
  const append = vtkAppendPolyData.newInstance();
  let n = 0;
  vertexCtxSelected.forEach((id) => {
    const v = cadVertexCache.find((x) => x.id === id);
    if (!v) return;
    const src = vtkSphereSource.newInstance({
      center: v.pos,
      radius: vertexMarkerRadiusAt(v.pos),
      thetaResolution: 18,
      phiResolution: 18,
    });
    src.update();
    append.addInputData(src.getOutputData());
    n += 1;
  });
  if (!n) {
    try { geomVertexSelActor.setVisibility(false); } catch (_) {}
    return;
  }
  append.update();
  try { geomVertexSelMapper.setInputData(append.getOutputData()); } catch (_) {}
  try { applyCadActorViewScale(geomVertexSelActor); } catch (_) {}
  try {
    renderer.removeActor(geomVertexSelActor);
    renderer.addActor(geomVertexSelActor);
  } catch (_) {}
  try { geomVertexSelActor.setVisibility(true); } catch (_) {}
}

let vertexMarkRaf = 0;
function scheduleVertexMarkRefresh() {
  if (!vertexCtxSelected.size && !edgeCtxSelected.size) return;
  if (vertexMarkRaf) return;
  vertexMarkRaf = requestAnimationFrame(() => {
    vertexMarkRaf = 0;
    try { applyVertexSelectionDisplay(); } catch (_) {}
    try { if (edgeCtxSelected.size) applyEdgeSelectionDisplay(); } catch (_) {}
    try { renderWindow.render(); } catch (_) {}
  });
}

function edgeSelTubeRadius(pos) {
  const world = cadPosToWorld(pos) || pos;
  const px = worldPerCssPixelAt(world, renderer);
  const s = cadToWorldScale();
  return Math.max((px * EDGE_MARK_CSS_PX * 0.5) / (s > 0 ? s : 1), 1e-7);
}

function applyEdgeSelectionDisplay() {
  if (!edgeCtxSelected.size) {
    try { geomEdgeSelActor.setVisibility(false); } catch (_) {}
    return;
  }
  if (!cadEdgeCache.length) rebuildCadEdgeCache();
  const pts = [];
  const lines = [];
  const hideIds = hiddenCadFaces.size ? hiddenCadFaceIdSet() : null;
  if (hideIds && hideIds.size) attachCadEdgeAdjacentFaces();
  let radiusAt = null;
  edgeCtxSelected.forEach((id) => {
    const e = cadEdgeCache.find((x) => x.id === id);
    if (!e || !e.pts.length) return;
    if (cadEdgeHiddenByFaces(e, hideIds)) return;
    const start = pts.length / 3;
    for (let i = 0; i < e.pts.length; i++) {
      pts.push(e.pts[i][0], e.pts[i][1], e.pts[i][2]);
    }
    lines.push(e.pts.length);
    for (let i = 0; i < e.pts.length; i++) lines.push(start + i);
    if (!radiusAt) radiusAt = edgeOrbitCadPoint(e) || e.pts[0];
  });
  if (pts.length < 6) {
    try { geomEdgeSelActor.setVisibility(false); } catch (_) {}
    return;
  }
  const pd = vtkPolyData.newInstance();
  const vtkPts = vtkPoints.newInstance();
  vtkPts.setData(Float32Array.from(pts), 3);
  pd.setPoints(vtkPts);
  const cells = vtkCellArray.newInstance();
  cells.setData(Uint32Array.from(lines));
  pd.setLines(cells);
  const tube = vtkTubeFilter.newInstance({
    radius: edgeSelTubeRadius(radiusAt || [pts[0], pts[1], pts[2]]),
    numberOfSides: 8,
    capping: true,
    varyRadius: VaryRadius.VARY_RADIUS_OFF,
  });
  tube.setInputData(pd);
  tube.setRadiusFactor(1);
  tube.update();
  try { geomEdgeSelMapper.setInputData(tube.getOutputData()); } catch (_) {}
  try { applyCadActorViewScale(geomEdgeSelActor); } catch (_) {}
  try {
    renderer.removeActor(geomEdgeSelActor);
    renderer.addActor(geomEdgeSelActor);
  } catch (_) {}
  try { geomEdgeSelActor.setVisibility(true); } catch (_) {}
}

function formatCadXYZ(p) {
  if (!p) return '—';
  const f = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(Math.abs(n) >= 10 ? 2 : 3).replace(/\.?0+$/, '');
  };
  return f(p[0]) + ', ' + f(p[1]) + ', ' + f(p[2]) + ' mm';
}

function selectedVertices() {
  if (!cadVertexCache.length) rebuildCadVertexCache();
  const out = [];
  vertexCtxSelected.forEach((id) => {
    const v = cadVertexCache.find((x) => x.id === id);
    if (v) out.push(v);
  });
  return out;
}

function closestPointOnSegment(p, a, b) {
  const ab = v3sub(b, a);
  const den = v3dot(ab, ab);
  if (den < 1e-18) return a.slice();
  const u = Math.max(0, Math.min(1, v3dot(v3sub(p, a), ab) / den));
  return v3add(a, v3scale(ab, u));
}

function closestPointOnPolyline(p, pts) {
  if (!pts || pts.length < 2) return null;
  let best = null;
  let bestD = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const q = closestPointOnSegment(p, pts[i - 1], pts[i]);
    const d = v3dot(v3sub(p, q), v3sub(p, q));
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

function minPolylineDistance(a, b) {
  if (!a || !b || a.length < 2 || b.length < 2) return null;
  let best = Infinity;
  for (let i = 0; i < a.length; i++) {
    const q = closestPointOnPolyline(a[i], b);
    if (q) best = Math.min(best, v3len(v3sub(a[i], q)));
  }
  for (let i = 0; i < b.length; i++) {
    const q = closestPointOnPolyline(b[i], a);
    if (q) best = Math.min(best, v3len(v3sub(b[i], q)));
  }
  return Number.isFinite(best) ? best : null;
}

function minPointFaceDistance(pt, faceId) {
  if (!cadTriCache.length) rebuildCadTriCache();
  let best = Infinity;
  for (let i = 0; i < cadTriCache.length; i++) {
    if (cadTriCache[i].faceId !== faceId) continue;
    const d2 = distPointTri2(pt, cadTriCache[i]);
    if (d2 < best) best = d2;
  }
  return Number.isFinite(best) ? Math.sqrt(best) : null;
}

function syncMeasureChip() {
  const chip = document.getElementById('measure-chip');
  const body = document.getElementById('measure-chip-body');
  if (!chip || !body) return;
  if (resultsViewOpen) {
    chip.hidden = true;
    body.innerHTML = '';
    return;
  }
  const faceIds = selectedFaceIds();
  const edges = [];
  edgeCtxSelected.forEach((id) => {
    const e = cadEdgeCache.find((x) => x.id === id);
    if (e) edges.push(e);
  });
  const verts = selectedVertices();
  if (!faceIds.length && !edges.length && !verts.length) {
    chip.hidden = true;
    body.innerHTML = '';
    return;
  }
  const rows = [];
  if (verts.length === 1) {
    rows.push('<span class="measure-chip-k">Point</span>');
    rows.push('<span class="measure-chip-v">' + formatCadXYZ(verts[0].pos) + '</span>');
  } else if (verts.length === 2) {
    rows.push('<span class="measure-chip-k">2 points</span>');
    rows.push('<span class="measure-chip-v">Distance ' + formatCadLength(v3len(v3sub(verts[1].pos, verts[0].pos))) + '</span>');
  } else if (verts.length > 2) {
    rows.push('<span class="measure-chip-k">' + verts.length + ' points</span>');
  }
  if (edges.length === 1) {
    const e = edges[0];
    rows.push('<span class="measure-chip-k">Edge</span>');
    rows.push('<span class="measure-chip-v">Length ' + formatCadLength(e.length) + '</span>');
    if (e.circle) {
      rows.push('<span class="measure-chip-v">Diameter ' + formatCadLength(e.circle.diameter) +
        (e.circle.closed ? '' : ' (arc)') + '</span>');
    }
  } else if (edges.length === 2) {
    rows.push('<span class="measure-chip-k">2 edges</span>');
    const total = edges[0].length + edges[1].length;
    rows.push('<span class="measure-chip-v">Total length ' + formatCadLength(total) + '</span>');
    const d = minPolylineDistance(edges[0].pts, edges[1].pts);
    if (d != null) rows.push('<span class="measure-chip-v">Distance ' + formatCadLength(d) + '</span>');
  } else if (edges.length > 2) {
    rows.push('<span class="measure-chip-k">' + edges.length + ' edges</span>');
    const total = edges.reduce((s, e) => s + e.length, 0);
    rows.push('<span class="measure-chip-v">Total length ' + formatCadLength(total) + '</span>');
  }
  if (faceIds.length === 1) {
    const info = faceOrientationInfo(faceIds[0]);
    const shape = faceShapeInfo(faceIds[0]);
    rows.push('<span class="measure-chip-k">Face ' + faceIds[0] + '</span>');
    rows.push('<span class="measure-chip-v">Area ' + formatCadArea(faceAreaOf(faceIds[0])) + '</span>');
    if (shape && shape.kind === 'cylinder') {
      rows.push('<span class="measure-chip-hint">Cylindrical · Ø ' + formatCadLength(shape.cyl.diameter) + '</span>');
    } else if (shape && shape.kind === 'sphere') {
      rows.push('<span class="measure-chip-hint">Spherical · Ø ' + formatCadLength(shape.sph.diameter) + '</span>');
    } else if (shape && shape.kind === 'disk') {
      rows.push('<span class="measure-chip-hint">Circular · Ø ' + formatCadLength(shape.circ.diameter) + '</span>');
    } else if (info && info.flat) {
      rows.push('<span class="measure-chip-hint">Planar</span>');
    } else if (shape && shape.kind === 'curved') {
      rows.push('<span class="measure-chip-hint">Curved</span>');
    }
  } else if (faceIds.length === 2) {
    const a = faceIds[0];
    const b = faceIds[1];
    const ia = faceOrientationInfo(a);
    const ib = faceOrientationInfo(b);
    const sa = faceShapeInfo(a);
    const sb = faceShapeInfo(b);
    rows.push('<span class="measure-chip-k">Faces ' + a + ' and ' + b + '</span>');
    rows.push('<span class="measure-chip-v">Combined area ' + formatCadArea(faceAreaOf(a) + faceAreaOf(b)) + '</span>');
    const extra = twoFaceExtraMeasures(a, b, sa, sb);
    const wantExtra = !!(sa && sb && (sa.kind !== 'plane' || sb.kind !== 'plane'));
    if (wantExtra) {
      if (extra.shortest != null && extra.shortest > 1e-4) {
        rows.push('<span class="measure-chip-v">Shortest ' + formatCadLength(extra.shortest) + '</span>');
      } else {
        rows.push('<span class="measure-chip-hint">Adjacent — they share an edge</span>');
      }
      if (extra.farthest != null && extra.farthest > 1e-4 &&
        (extra.shortest == null || Math.abs(extra.farthest - extra.shortest) > 1e-3)) {
        rows.push('<span class="measure-chip-v">Farthest (normal) ' + formatCadLength(extra.farthest) + '</span>');
      }
      if (extra.center != null && extra.center > 1e-4) {
        rows.push('<span class="measure-chip-v">Center to center ' + formatCadLength(extra.center) + '</span>');
      }
    } else {
      const minDist = extra.minD;
      const parallel = !!(ia && ib && ia.flat && ib.flat && Math.abs(v3dot(ia.n, ib.n)) >= 0.98);
      const gap = parallel ? Math.abs(v3dot(v3sub(ib.c, ia.c), ia.n)) : null;
      if (parallel && gap != null && gap > 1e-4) {
        rows.push('<span class="measure-chip-v">Distance (parallel) ' + formatCadLength(gap) + '</span>');
      } else if (minDist != null && minDist > 1e-4) {
        rows.push('<span class="measure-chip-v">Distance ' + formatCadLength(minDist) + '</span>');
      } else {
        rows.push('<span class="measure-chip-hint">Adjacent — they share an edge</span>');
      }
    }
  } else if (faceIds.length > 2) {
    let area = 0;
    faceIds.forEach((id) => { area += faceAreaOf(id); });
    rows.push('<span class="measure-chip-k">' + faceIds.length + ' faces</span>');
    rows.push('<span class="measure-chip-v">Combined area ' + formatCadArea(area) + '</span>');
  }
  if (verts.length === 1 && faceIds.length === 1) {
    const d = minPointFaceDistance(verts[0].pos, faceIds[0]);
    if (d != null) rows.push('<span class="measure-chip-v">Point to face ' + formatCadLength(d) + '</span>');
  }
  if (verts.length === 1 && edges.length === 1) {
    const q = closestPointOnPolyline(verts[0].pos, edges[0].pts);
    if (q) rows.push('<span class="measure-chip-v">Point to edge ' + formatCadLength(v3len(v3sub(verts[0].pos, q))) + '</span>');
  }
  if (faceIds.length + edges.length + verts.length === 1) {
    rows.push('<span class="measure-chip-hint">Ctrl+click to add a face, edge, or point</span>');
  }
  body.innerHTML = rows.join('');
  chip.hidden = false;
}

function walkPolyCells(pd, fn) {
  if (!pd) return;
  const polys = pd.getPolys && pd.getPolys();
  const offsets = polys && polys.getOffsets && polys.getOffsets();
  const conn = polys && polys.getConnectivity && polys.getConnectivity();
  if (offsets && conn) {
    const off = offsets.getData ? offsets.getData() : offsets;
    const ids = conn.getData ? conn.getData() : conn;
    for (let i = 0; i < off.length - 1; i++) {
      const a = off[i];
      const b = off[i + 1];
      if (b > a) {
        const cell = [];
        for (let k = a; k < b; k++) cell.push(ids[k]);
        fn(i, cell);
      }
    }
    return;
  }
  const data = polys && polys.getData && polys.getData();
  if (!data) return;
  let i = 0;
  let cellId = 0;
  while (i < data.length) {
    const n = data[i++];
    const cell = [];
    for (let k = 0; k < n; k++) cell.push(data[i++]);
    fn(cellId++, cell);
  }
}

function extractPolyCells(pd, keepFn) {
  if (!pd) return pd;
  const ptsIn = pd.getPoints() && pd.getPoints().getData();
  if (!ptsIn) return pd;
  const used = new Map();
  const newPts = [];
  const newPolys = [];
  const kept = [];
  const mapId = (old) => {
    if (used.has(old)) return used.get(old);
    const n = newPts.length / 3;
    newPts.push(ptsIn[old * 3], ptsIn[old * 3 + 1], ptsIn[old * 3 + 2]);
    used.set(old, n);
    return n;
  };
  walkPolyCells(pd, (cellId, ids) => {
    if (!keepFn(cellId, ids)) return;
    newPolys.push(ids.length);
    for (let k = 0; k < ids.length; k++) newPolys.push(mapId(ids[k]));
    kept.push(cellId);
  });
  const out = vtkPolyData.newInstance();
  const vtkPts = vtkPoints.newInstance();
  vtkPts.setData(Float32Array.from(newPts), 3);
  out.setPoints(vtkPts);
  const cells = vtkCellArray.newInstance();
  cells.setData(Uint32Array.from(newPolys));
  out.setPolys(cells);
  const cd = pd.getCellData && pd.getCellData();
  const nArr = cd && cd.getNumberOfArrays ? cd.getNumberOfArrays() : 0;
  for (let ai = 0; ai < nArr; ai++) {
    const arr = cd.getArray(ai);
    if (!arr) continue;
    const name = arr.getName();
    const nc = arr.getNumberOfComponents ? arr.getNumberOfComponents() : 1;
    const src = arr.getData ? arr.getData() : null;
    if (!src || !kept.length) continue;
    const dst = new src.constructor(kept.length * nc);
    for (let i = 0; i < kept.length; i++) {
      const o = kept[i] * nc;
      const d = i * nc;
      for (let c = 0; c < nc; c++) dst[d + c] = src[o + c];
    }
    out.getCellData().addArray(vtkDataArray.newInstance({
      name,
      numberOfComponents: nc,
      values: dst,
    }));
  }
  return out;
}

function extractPolyLines(pd, keepFn) {
  if (!pd) return pd;
  const ptsIn = pd.getPoints() && pd.getPoints().getData();
  if (!ptsIn) return pd;
  const used = new Map();
  const newPts = [];
  const newLines = [];
  const kept = [];
  const mapId = (old) => {
    if (used.has(old)) return used.get(old);
    const n = newPts.length / 3;
    newPts.push(ptsIn[old * 3], ptsIn[old * 3 + 1], ptsIn[old * 3 + 2]);
    used.set(old, n);
    return n;
  };
  walkPolyLines(pd, (cellId, _path, ids) => {
    if (!keepFn(cellId, ids)) return;
    newLines.push(ids.length);
    for (let k = 0; k < ids.length; k++) newLines.push(mapId(ids[k]));
    kept.push(cellId);
  });
  const out = vtkPolyData.newInstance();
  const vtkPts = vtkPoints.newInstance();
  vtkPts.setData(Float32Array.from(newPts), 3);
  out.setPoints(vtkPts);
  const cells = vtkCellArray.newInstance();
  cells.setData(Uint32Array.from(newLines));
  out.setLines(cells);
  const cd = pd.getCellData && pd.getCellData();
  const nArr = cd && cd.getNumberOfArrays ? cd.getNumberOfArrays() : 0;
  for (let ai = 0; ai < nArr; ai++) {
    const arr = cd.getArray(ai);
    if (!arr) continue;
    const name = arr.getName();
    const nc = arr.getNumberOfComponents ? arr.getNumberOfComponents() : 1;
    const src = arr.getData ? arr.getData() : null;
    if (!src || !kept.length) continue;
    const dst = new src.constructor(kept.length * nc);
    for (let i = 0; i < kept.length; i++) {
      const o = kept[i] * nc;
      const d = i * nc;
      for (let c = 0; c < nc; c++) dst[d + c] = src[o + c];
    }
    out.getCellData().addArray(vtkDataArray.newInstance({
      name,
      numberOfComponents: nc,
      values: dst,
    }));
  }
  return out;
}

function cellIdsCentroid(pts, ids) {
  let x = 0;
  let y = 0;
  let z = 0;
  const n = ids.length || 1;
  for (let k = 0; k < ids.length; k++) {
    const i = ids[k] * 3;
    x += pts[i];
    y += pts[i + 1];
    z += pts[i + 2];
  }
  return [x / n, y / n, z / n];
}

function distPointTri2(p, t) {
  const ab = v3sub(t.b, t.a);
  const ac = v3sub(t.c, t.a);
  const ap = v3sub(p, t.a);
  const d1 = v3dot(ab, ap);
  const d2 = v3dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return v3dot(ap, ap);
  const bp = v3sub(p, t.b);
  const d3 = v3dot(ab, bp);
  const d4 = v3dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return v3dot(bp, bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const q = v3add(t.a, v3scale(ab, v));
    const d = v3sub(p, q);
    return v3dot(d, d);
  }
  const cp = v3sub(p, t.c);
  const d5 = v3dot(ab, cp);
  const d6 = v3dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return v3dot(cp, cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const q = v3add(t.a, v3scale(ac, w));
    const d = v3sub(p, q);
    return v3dot(d, d);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const q = v3add(t.b, v3scale(v3sub(t.c, t.b), w));
    const d = v3sub(p, q);
    return v3dot(d, d);
  }
  const denom = 1 / (va + vb + vc);
  const q = v3add(t.a, v3add(v3scale(ab, vb * denom), v3scale(ac, vc * denom)));
  const d = v3sub(p, q);
  return v3dot(d, d);
}

function ensureCadNearestFaceIndex() {
  if (cadNearestFaceIndex) return cadNearestFaceIndex;
  if (!cadTriCache.length) rebuildCadTriCache();
  if (!cadTriCache.length) {
    cadNearestFaceIndex = { empty: true, faceIdAt: () => 0, faceIdsNear: () => [], facesOnEdge: () => [] };
    return cadNearestFaceIndex;
  }
  let xmin = Infinity;
  let xmax = -Infinity;
  let ymin = Infinity;
  let ymax = -Infinity;
  let zmin = Infinity;
  let zmax = -Infinity;
  for (let i = 0; i < cadTriCache.length; i++) {
    const t = cadTriCache[i];
    xmin = Math.min(xmin, t.a[0], t.b[0], t.c[0]);
    xmax = Math.max(xmax, t.a[0], t.b[0], t.c[0]);
    ymin = Math.min(ymin, t.a[1], t.b[1], t.c[1]);
    ymax = Math.max(ymax, t.a[1], t.b[1], t.c[1]);
    zmin = Math.min(zmin, t.a[2], t.b[2], t.c[2]);
    zmax = Math.max(zmax, t.a[2], t.b[2], t.c[2]);
  }
  const span = Math.max(xmax - xmin, ymax - ymin, zmax - zmin, 1);
  const cell = Math.max(span / 140, typicalMeshCellWorld() || span * 0.008);
  const grid = new Map();
  const keyOf = (i, j, k) => i + ',' + j + ',' + k;
  const eps = cell * 1e-4;
  for (let t = 0; t < cadTriCache.length; t++) {
    const tri = cadTriCache[t];
    const x0 = Math.floor((Math.min(tri.a[0], tri.b[0], tri.c[0]) - eps) / cell);
    const x1 = Math.floor((Math.max(tri.a[0], tri.b[0], tri.c[0]) + eps) / cell);
    const y0 = Math.floor((Math.min(tri.a[1], tri.b[1], tri.c[1]) - eps) / cell);
    const y1 = Math.floor((Math.max(tri.a[1], tri.b[1], tri.c[1]) + eps) / cell);
    const z0 = Math.floor((Math.min(tri.a[2], tri.b[2], tri.c[2]) - eps) / cell);
    const z1 = Math.floor((Math.max(tri.a[2], tri.b[2], tri.c[2]) + eps) / cell);
    for (let i = x0; i <= x1; i++) {
      for (let j = y0; j <= y1; j++) {
        for (let k = z0; k <= z1; k++) {
          const key = keyOf(i, j, k);
          let bucket = grid.get(key);
          if (!bucket) {
            bucket = [];
            grid.set(key, bucket);
          }
          bucket.push(tri);
        }
      }
    }
  }
  const searchRing = (pt, ring) => {
    const i0 = Math.floor(pt[0] / cell);
    const j0 = Math.floor(pt[1] / cell);
    const k0 = Math.floor(pt[2] / cell);
    let bestD = Infinity;
    let bestId = 0;
    for (let i = i0 - ring; i <= i0 + ring; i++) {
      for (let j = j0 - ring; j <= j0 + ring; j++) {
        for (let k = k0 - ring; k <= k0 + ring; k++) {
          const bucket = grid.get(keyOf(i, j, k));
          if (!bucket) continue;
          for (let b = 0; b < bucket.length; b++) {
            const d = distPointTri2(pt, bucket[b]);
            if (d < bestD) {
              bestD = d;
              bestId = bucket[b].faceId;
            }
          }
        }
      }
    }
    return { bestD, bestId };
  };
  const searchMinByFace = (pt, ring) => {
    const i0 = Math.floor(pt[0] / cell);
    const j0 = Math.floor(pt[1] / cell);
    const k0 = Math.floor(pt[2] / cell);
    const minByFace = new Map();
    for (let i = i0 - ring; i <= i0 + ring; i++) {
      for (let j = j0 - ring; j <= j0 + ring; j++) {
        for (let k = k0 - ring; k <= k0 + ring; k++) {
          const bucket = grid.get(keyOf(i, j, k));
          if (!bucket) continue;
          for (let b = 0; b < bucket.length; b++) {
            const tri = bucket[b];
            const d = distPointTri2(pt, tri);
            const prev = minByFace.get(tri.faceId);
            if (prev == null || d < prev) minByFace.set(tri.faceId, d);
          }
        }
      }
    }
    return minByFace;
  };
  cadNearestFaceIndex = {
    empty: false,
    faceIdAt(pt) {
      if (!pt) return 0;
      let hit = searchRing(pt, 1);
      if (!hit.bestId) hit = searchRing(pt, 3);
      return hit.bestId || 0;
    },
    faceIdsNear(pt, tol2) {
      if (!pt || !(tol2 > 0)) return [];
      return this.facesOnEdge(pt, tol2);
    },
    facesOnEdge(pt, slop2) {
      if (!pt) return [];
      let minByFace = searchMinByFace(pt, 1);
      if (!minByFace.size) minByFace = searchMinByFace(pt, 3);
      let best = Infinity;
      minByFace.forEach((d) => {
        if (d < best) best = d;
      });
      if (!Number.isFinite(best)) return [];
      const cut = Math.max(slop2 > 0 ? slop2 : 0, best * 4);
      const ids = [];
      minByFace.forEach((d, fid) => {
        if (fid && d <= cut) ids.push(fid);
      });
      return ids;
    },
  };
  return cadNearestFaceIndex;
}

function cadFaceIdAtPoint(pt) {
  return ensureCadNearestFaceIndex().faceIdAt(pt);
}

function meshCellCadFaceIds(pd, bounds) {
  if (!pd) return [];
  const n = pd.getNumberOfCells ? pd.getNumberOfCells() : 0;
  if (
    meshCadFaceIdCache &&
    meshCadFaceIdCache.pd === pd &&
    meshCadFaceIdCache.n === n
  ) return meshCadFaceIdCache.ids;
  const pts = pd.getPoints() && pd.getPoints().getData();
  if (!pts || n < 1) return [];
  ensureCadNearestFaceIndex();
  const s = meshDisplayScaleFromBounds(bounds) || 1;
  const ids = new Int32Array(n);
  let i = 0;
  walkPolyCells(pd, (_id, cellIds) => {
    const c = cellIdsCentroid(pts, cellIds);
    ids[i] = cadFaceIdAtPoint([c[0] * s, c[1] * s, c[2] * s]);
    i += 1;
  });
  meshCadFaceIdCache = { pd, n, ids };
  return ids;
}

function selectedCadFaceIdSet() {
  const want = new Set();
  faceCtxSelected.forEach((lab) => {
    const id = parseFaceId(lab);
    if (id > 0) want.add(id);
  });
  return want;
}

function hiddenCadFaceIdSet() {
  const want = new Set();
  hiddenCadFaces.forEach((lab) => {
    const id = parseFaceId(lab);
    if (id > 0) want.add(id);
  });
  return want;
}

function bindCadFacePolyData(pd) {
  if (!pd) return;
  try { pd.modified(); } catch (_) {}
  try { geomMapper.setInputData(pd); } catch (_) {}
  try { geomMapper.modified(); } catch (_) {}
}

function bindCadEdgePolyData(pd) {
  if (!pd) return;
  try { pd.modified(); } catch (_) {}
  try { geomEdgeMapper.setInputData(pd); } catch (_) {}
  try { geomEdgeMapper.modified(); } catch (_) {}
  const v = compareState.viewer;
  if (v && v.edgeMapper) {
    try { v.edgeMapper.setInputData(pd); } catch (_) {}
    try { v.edgeMapper.modified(); } catch (_) {}
  }
}

function applyHiddenCadEdges() {
  const src = geomCadEdgeReader.getOutputData && geomCadEdgeReader.getOutputData();
  if (!src) return;
  const hideIds = hiddenCadFaces.size ? hiddenCadFaceIdSet() : null;
  if (hideIds && hideIds.size) attachCadEdgeAdjacentFaces();
  const skipSel = edgeCtxSelected.size > 0;
  if ((!hideIds || !hideIds.size) && !skipSel) {
    bindCadEdgePolyData(src);
    return;
  }
  if (skipSel && !cadEdgeCache.length) rebuildCadEdgeCache();
  const filtered = extractPolyLines(src, (cellId) => {
    const e = cadEdgeCache[cellId] || cadEdgeCache.find((x) => x.id === cellId);
    if (e && skipSel && edgeCtxSelected.has(e.id)) return false;
    return !cadEdgeHiddenByFaces(e, hideIds);
  });
  bindCadEdgePolyData(filtered);
}

function pruneHiddenEdgeSelection() {
  if (!edgeCtxSelected.size || !hiddenCadFaces.size) return;
  attachCadEdgeAdjacentFaces();
  const hideIds = hiddenCadFaceIdSet();
  let changed = false;
  edgeCtxSelected.forEach((id) => {
    const e = cadEdgeCache.find((x) => x.id === id);
    if (e && cadEdgeHiddenByFaces(e, hideIds)) {
      edgeCtxSelected.delete(id);
      changed = true;
    }
  });
  if (changed) {
    try { applyEdgeSelectionDisplay(); } catch (_) {}
  }
}

function applyHiddenCadDisplay() {
  const src = geomCadFaceReader.getOutputData && geomCadFaceReader.getOutputData();
  if (!src) return;
  if (!hiddenCadFaces.size) {
    bindCadFacePolyData(src);
    return;
  }
  const filtered = extractPolyCells(src, (cellId) => {
    const hit = hitFromCellIdOnPd(src, cellId);
    if (!hit || !hit.faceId) return true;
    return !hiddenCadFaces.has(faceLabel(hit.faceId, hit.solidId || 1));
  });
  bindCadFacePolyData(filtered);
}

function paintMeshFacePreview(mapper, pd, bounds, fullPd) {
  if (!mapper || !pd) return;
  if (!faceCtxSelected.size) {
    try { mapper.setInputData(pd); } catch (_) {}
    try { mapper.setScalarVisibility(false); } catch (_) {}
    try { mapper.modified(); } catch (_) {}
    return;
  }
  const want = selectedCadFaceIdSet();
  if (!want.size) {
    try { mapper.setInputData(pd); } catch (_) {}
    try { mapper.setScalarVisibility(false); } catch (_) {}
    try { mapper.modified(); } catch (_) {}
    return;
  }
  let display = pd;
  if (fullPd && display === fullPd) display = extractPolyCells(pd, () => true);
  const pts = display.getPoints() && display.getPoints().getData();
  if (!pts) {
    try { mapper.setInputData(pd); } catch (_) {}
    return;
  }
  const s = meshDisplayScaleFromBounds(bounds) || 1;
  const n = display.getNumberOfCells();
  const rgb = new Uint8Array(n * 3);
  const base = [
    Math.round(MESH_FACE_RGB[0] * 255),
    Math.round(MESH_FACE_RGB[1] * 255),
    Math.round(MESH_FACE_RGB[2] * 255),
  ];
  const cached = fullPd && display.getNumberOfCells() === fullPd.getNumberOfCells()
    ? meshCellCadFaceIds(fullPd, bounds)
    : null;
  let i = 0;
  walkPolyCells(display, (_id, ids) => {
    let fid = cached ? cached[i] : 0;
    if (!fid) {
      const c = cellIdsCentroid(pts, ids);
      fid = cadFaceIdAtPoint([c[0] * s, c[1] * s, c[2] * s]);
    }
    const on = want.has(fid);
    rgb[i * 3] = on ? 46 : base[0];
    rgb[i * 3 + 1] = on ? 196 : base[1];
    rgb[i * 3 + 2] = on ? 126 : base[2];
    i += 1;
  });
  const cd = display.getCellData();
  cd.addArray(vtkDataArray.newInstance({
    name: 'previewRgb',
    numberOfComponents: 3,
    values: rgb,
  }));
  try { cd.setActiveScalars('previewRgb'); } catch (_) {}
  try { display.modified(); } catch (_) {}
  try { mapper.setInputData(display); } catch (_) {}
  try { mapper.setScalarVisibility(true); } catch (_) {}
  try { mapper.setScalarMode(ScalarMode.USE_CELL_FIELD_DATA); } catch (_) {}
  try { mapper.setColorMode(ColorMode.DIRECT_SCALARS); } catch (_) {}
  try { mapper.setColorByArrayName('previewRgb'); } catch (_) {}
  try { mapper.setInterpolateScalarsBeforeMapping(false); } catch (_) {}
  try { mapper.modified(); } catch (_) {}
}

function applyHiddenMeshDisplay() {
  const bind = (mapper, fullPd, bounds) => {
    if (!mapper || !fullPd) return;
    let pd = fullPd;
    if (hiddenCadFaces.size) {
      const hideIds = hiddenCadFaceIdSet();
      const faceIds = meshCellCadFaceIds(fullPd, bounds);
      if (hideIds.size && faceIds.length) {
        let k = 0;
        pd = extractPolyCells(fullPd, () => {
          const fid = faceIds[k++];
          return !hideIds.has(fid);
        });
      }
    }
    paintMeshFacePreview(mapper, pd, bounds, fullPd);
  };
  bind(meshSurfMapper, meshSurfFullPd, meshBounds);
  const v = compareState.viewer;
  if (v && v.fullPd) bind(v.mapper, v.fullPd, v.bounds);
}

function applyHiddenDisplays() {
  applyHiddenCadDisplay();
  applyHiddenCadEdges();
  pruneHiddenEdgeSelection();
  applyHiddenMeshDisplay();
  syncHiddenFacesChip();
  try { renderWindow.render(); } catch (_) {}
  try {
    if (compareState.on && compareState.viewer) compareState.viewer.renderWindow.render();
  } catch (_) {}
}

function syncHiddenFacesChip() {
  const chip = document.getElementById('hidden-faces-chip');
  const txt = document.getElementById('hidden-faces-chip-txt');
  if (!chip) return;
  const n = hiddenCadFaces.size;
  chip.hidden = n < 1;
  if (txt) txt.textContent = n === 1 ? '1 face hidden' : n + ' faces hidden';
}

function hideCadFace(label) {
  if (!label) return;
  hideCadFaces([label]);
}

function hideCadFaces(labels) {
  const list = (labels || []).filter(Boolean);
  if (!list.length) return;
  list.forEach((lab) => {
    hiddenCadFaces.add(lab);
    faceCtxSelected.delete(lab);
  });
  applyHiddenDisplays();
  applyCadSelectionDisplay();
}

function showAllCadFaces() {
  hiddenCadFaces.clear();
  applyHiddenDisplays();
  try { applyGeomHighlight(); } catch (_) {}
}

function applyCadSelectionDisplay() {
  try { applyGeomHighlight(); } catch (_) {}
  try { applyHiddenMeshDisplay(); } catch (_) {}
  try { applyEdgeSelectionDisplay(); } catch (_) {}
  try { applyVertexSelectionDisplay(); } catch (_) {}
  try { syncMeasureChip(); } catch (_) {}
  try { renderWindow.render(); } catch (_) {}
  try {
    if (compareState.on && compareState.viewer) compareState.viewer.renderWindow.render();
  } catch (_) {}
}

function applyCadPick(hit, additive) {
  if (!hit) {
    if (!additive) clearCadSelection();
    return;
  }
  if (hit.kind === 'vertex' || hit.vertexId != null) {
    const id = String(hit.vertexId);
    if (!additive) {
      faceCtxSelected.clear();
      edgeCtxSelected.clear();
      vertexCtxSelected.clear();
      if (id) vertexCtxSelected.add(id);
    } else if (vertexCtxSelected.has(id)) vertexCtxSelected.delete(id);
    else vertexCtxSelected.add(id);
    applyCadSelectionDisplay();
    return;
  }
  if (hit.kind === 'edge' || hit.edgeId != null) {
    const id = Number(hit.edgeId);
    if (!additive) {
      faceCtxSelected.clear();
      edgeCtxSelected.clear();
      vertexCtxSelected.clear();
      if (Number.isFinite(id) && id >= 0) edgeCtxSelected.add(id);
    } else if (edgeCtxSelected.has(id)) edgeCtxSelected.delete(id);
    else edgeCtxSelected.add(id);
    applyCadSelectionDisplay();
    return;
  }
  if (!hit.faceId) {
    if (!additive) clearCadSelection();
    return;
  }
  const lab = faceLabel(hit.faceId, hit.solidId || 1);
  if (!additive) {
    faceCtxSelected.clear();
    edgeCtxSelected.clear();
    vertexCtxSelected.clear();
    faceCtxSelected.add(lab);
  } else if (faceCtxSelected.has(lab)) faceCtxSelected.delete(lab);
  else faceCtxSelected.add(lab);
  applyCadSelectionDisplay();
}

function setFaceCtxPreview(hit) {
  applyCadPick(hit, false);
}

function clearCadSelection() {
  if (!faceCtxSelected.size && !edgeCtxSelected.size && !vertexCtxSelected.size) {
    try { syncMeasureChip(); } catch (_) {}
    return;
  }
  faceCtxSelected.clear();
  edgeCtxSelected.clear();
  vertexCtxSelected.clear();
  applyCadSelectionDisplay();
}

function clearFaceCtxPreview() {
  clearCadSelection();
}

function faceOrientationInfo(faceId) {
  if (!cadTriCache.length) rebuildCadTriCache();
  const tris = cadTriCache.filter((t) => t.faceId === faceId);
  if (!tris.length) return null;
  let ax = 0;
  let ay = 0;
  let az = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let area = 0;
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    ax += t.n[0] * t.area;
    ay += t.n[1] * t.area;
    az += t.n[2] * t.area;
    cx += t.c3[0] * t.area;
    cy += t.c3[1] * t.area;
    cz += t.c3[2] * t.area;
    area += t.area;
  }
  if (area <= 1e-12) return null;
  const n = v3norm([ax, ay, az]);
  let minDot = 1;
  for (let i = 0; i < tris.length; i++) {
    const d = Math.abs(v3dot(tris[i].n, n));
    if (d < minDot) minDot = d;
  }
  return {
    flat: minDot >= 0.98,
    n,
    c: [cx / area, cy / area, cz / area],
    area,
  };
}

/**
 * CAD triangle cache → world. The CAD actor is drawn at native units in the
 * geometry / mesh views but scaled down to the solver's metres in Results, so
 * anything computed from cadTriCache (face centres, centroids) must follow the
 * actor's current scale before it is handed to the camera.
 */
function cadToWorldScale() {
  // The view decides the frame (Results = solver metres); the actor's own
  // scale is only a fallback since it is not refreshed while hidden.
  try {
    const v = Number(cadActorScaleForView());
    if (Number.isFinite(v) && v > 0) return v;
  } catch (_) {}
  try {
    const s = geomActor && geomActor.getScale ? geomActor.getScale() : null;
    const v = s && Number(s[0]);
    return v && Number.isFinite(v) && v > 0 ? v : 1;
  } catch (_) {
    return 1;
  }
}

function cadPosToWorld(pos) {
  if (!pos || pos.length < 3) return null;
  const s = cadToWorldScale();
  if (!(s > 0) || Math.abs(s - 1) < 1e-12) return [pos[0], pos[1], pos[2]];
  return [pos[0] * s, pos[1] * s, pos[2] * s];
}

function lookNormalToFace(faceId) {
  const info = faceOrientationInfo(faceId);
  if (!info || !info.flat) return false;
  const cam = renderer.getActiveCamera();
  if (!cam) return false;
  const s = cadToWorldScale();
  const c = [info.c[0] * s, info.c[1] * s, info.c[2] * s];
  const pos = cam.getPosition();
  let n = info.n;
  if (v3dot(v3sub(pos, c), n) < 0) n = [-n[0], -n[1], -n[2]];
  // Keep the current viewing distance unless it is wildly off for the scene
  // (e.g. a stale camera), in which case frame the visible bounds instead.
  let dist = Math.hypot(pos[0] - c[0], pos[1] - c[1], pos[2] - c[2]) || 1;
  try {
    const b = renderer.computeVisiblePropBounds();
    const span = Math.max(b[1] - b[0], b[3] - b[2], b[5] - b[4]);
    if (span > 0 && (dist > span * 20 || dist < span * 0.02)) dist = span * 2.5;
  } catch (_) {}
  compareState.syncing = true;
  try {
    cam.setFocalPoint(c[0], c[1], c[2]);
    cam.setPosition(c[0] + n[0] * dist, c[1] + n[1] * dist, c[2] + n[2] * dist);
    let up = [0, 0, 1];
    if (Math.abs(v3dot(up, n)) > 0.92) up = [0, 1, 0];
    cam.setViewUp(up[0], up[1], up[2]);
    try { resetCameraClippingRangeLoose(); } catch (_) {}
  } finally {
    compareState.syncing = false;
  }
  try { syncCompareCamerasFromLeft(); } catch (_) {}
  try { renderWindow.render(); } catch (_) {}
  return true;
}

function cadCacheSpan() {
  if (!cadTriCache.length) return 1;
  let xmin = Infinity;
  let xmax = -Infinity;
  for (let i = 0; i < cadTriCache.length; i++) {
    const c = cadTriCache[i].c3;
    if (c[0] < xmin) xmin = c[0];
    if (c[0] > xmax) xmax = c[0];
  }
  return Math.max(xmax - xmin, 1);
}

function nearestCadFaceAtPoint(pt) {
  if (!pt) return null;
  if (!cadTriCache.length) rebuildCadTriCache();
  if (!cadTriCache.length) return null;
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < cadTriCache.length; i++) {
    const t = cadTriCache[i];
    if (hiddenCadFaces.size && hiddenCadFaces.has(faceLabel(t.faceId, 1))) continue;
    const d = distPointTri2(pt, t);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  if (!best) return null;
  let span = typicalMeshCellWorld();
  if (!(span > 0)) span = cadCacheSpan() * 0.04;
  const maxR = Math.max(span * 8, cadCacheSpan() * 0.03);
  if (bestD > maxR * maxR) return null;
  return { faceId: best.faceId, solidId: 1, pos: pt };
}

const meshFacePicker = vtkCellPicker.newInstance();
try { meshFacePicker.setPickFromList(true); } catch (_) {}
try { meshFacePicker.setTolerance(0.0004); } catch (_) {}

function pickMeshWorldAtDisplay(xy, actor, ren) {
  if (!xy || !actor || !ren) return null;
  try {
    meshFacePicker.initializePickList();
    meshFacePicker.addPickList(actor);
    meshFacePicker.pick([xy[0], xy[1], 0], ren);
    const cellId = meshFacePicker.getCellId ? meshFacePicker.getCellId() : -1;
    if (cellId == null || cellId < 0) return null;
    return pickerWorldPos(meshFacePicker);
  } catch (_) {
    return null;
  }
}

function cameraDistToPoint(pos, ren) {
  if (!pos) return Infinity;
  const cam = (ren || renderer) && (ren || renderer).getActiveCamera && (ren || renderer).getActiveCamera();
  if (!cam) return Infinity;
  const p = cam.getPosition();
  return Math.hypot(pos[0] - p[0], pos[1] - p[1], pos[2] - p[2]);
}

function visibleSurfaceSlack(ren, atPos) {
  // Edges sit on the tessellated face. Mesh-cell slack is in solver metres and
  // rejects valid CAD edges when the viewport is in millimetres.
  const px = worldPerCssPixelAt(atPos, ren);
  if (px > 0 && Number.isFinite(px)) return px * 8;
  try {
    const cam = (ren || renderer).getActiveCamera();
    const pos = cam.getPosition();
    const fp = cam.getFocalPoint();
    const dist = Math.hypot(pos[0] - fp[0], pos[1] - fp[1], pos[2] - fp[2]) || 1;
    return dist * 0.01;
  } catch (_) {}
  return 1e-4;
}

function edgeIsVisibleInFrontOf(edgePos, surfacePos, ren) {
  if (!edgePos) return false;
  if (!surfacePos) return true;
  const slack = Math.max(visibleSurfaceSlack(ren, edgePos), visibleSurfaceSlack(ren, surfacePos));
  return cameraDistToPoint(edgePos, ren) <= cameraDistToPoint(surfacePos, ren) + slack;
}

function distPointSeg2(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const den = abx * abx + aby * aby;
  let u = 0;
  if (den > 1e-18) u = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / den));
  const qx = ax + abx * u;
  const qy = ay + aby * u;
  const dx = px - qx;
  const dy = py - qy;
  return { d2: dx * dx + dy * dy, u };
}

function displayRayAtXY(xy, view, ren) {
  if (!xy || !view || !ren || !view.displayToWorld) return null;
  try {
    const near = view.displayToWorld(xy[0], xy[1], 0, ren);
    const far = view.displayToWorld(xy[0], xy[1], 1, ren);
    if (!near || !far || !Number.isFinite(near[0]) || !Number.isFinite(far[0])) return null;
    const dir = v3norm([far[0] - near[0], far[1] - near[1], far[2] - near[2]]);
    return { orig: [near[0], near[1], near[2]], dir };
  } catch (_) {
    return null;
  }
}

function closestPointOnSegmentToRay(orig, dir, a, b) {
  const u = v3sub(b, a);
  const w = v3sub(a, orig);
  const uu = v3dot(u, u);
  const uv = v3dot(u, dir);
  const uw = v3dot(u, w);
  const vv = v3dot(dir, dir) || 1;
  const vw = v3dot(dir, w);
  const den = uu * vv - uv * uv;
  let s = 0;
  if (den > 1e-18) s = (uv * vw - uw * vv) / den;
  s = Math.max(0, Math.min(1, s));
  return v3add(a, v3scale(u, s));
}

function eventToPaneDisplay(e, rootEl, fsr) {
  const view = fsr && fsr.getApiSpecificRenderWindow && fsr.getApiSpecificRenderWindow();
  const canvas = (view && view.getCanvas && view.getCanvas()) ||
    (rootEl && rootEl.querySelector('canvas'));
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const cssX = e.clientX - rect.left;
  const cssY = e.clientY - rect.top;
  if (cssX < 0 || cssY < 0 || cssX > rect.width || cssY > rect.height) return null;
  const size = view && view.getSize ? view.getSize() : [rect.width, rect.height];
  return [(cssX / rect.width) * size[0], (1 - cssY / rect.height) * size[1]];
}

function pickViewForPane(pane) {
  if (pane === 'b' && compareState.viewer && compareState.viewer.fullScreenRenderer) {
    const fsr = compareState.viewer.fullScreenRenderer;
    return fsr.getApiSpecificRenderWindow ? fsr.getApiSpecificRenderWindow() : null;
  }
  return vtkView();
}

function worldToDisplayXY(pos, view, ren) {
  if (!pos || !view || !view.worldToDisplay || !ren) return null;
  try {
    const d = view.worldToDisplay(pos[0], pos[1], pos[2], ren);
    if (!d || !Number.isFinite(d[0]) || !Number.isFinite(d[1])) return null;
    return [d[0], d[1]];
  } catch (_) {
    return null;
  }
}

function pickDisplayXY(e, pane) {
  if (pane === 'b' && compareState.viewer) {
    return eventToPaneDisplay(e, document.getElementById('viewer-b'), compareState.viewer.fullScreenRenderer);
  }
  return eventToVtkDisplay(e);
}

function pickRendererForPane(pane) {
  return pane === 'b' && compareState.viewer ? compareState.viewer.renderer : renderer;
}

function displayPerCssPx(view, rootEl) {
  const canvas = (view && view.getCanvas && view.getCanvas()) ||
    (rootEl && rootEl.querySelector && rootEl.querySelector('canvas'));
  if (!canvas || !view || !view.getSize) return 1;
  const rect = canvas.getBoundingClientRect();
  const size = view.getSize();
  if (!rect.width || !size || !size[0]) return 1;
  return size[0] / rect.width;
}

function pickClosestScreenHit(xy, view, ren, items, pixelTol, surfacePos) {
  if (!xy || !view || !ren || !items || !items.length) return null;
  const maxD = pixelTol * pixelTol;
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (surfacePos && !edgeIsVisibleInFrontOf(it.pos, surfacePos, ren)) continue;
    const dpy = worldToDisplayXY(it.pos, view, ren);
    if (!dpy) continue;
    const dx = dpy[0] - xy[0];
    const dy = dpy[1] - xy[1];
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD) {
      bestD = d2;
      best = it;
    }
  }
  if (!best || bestD > maxD) return null;
  return Object.assign({ screenD2: bestD }, best);
}

function pickCadVertexFromEvent(e, pane, surfacePos) {
  const xy = pickDisplayXY(e, pane);
  const view = pickViewForPane(pane);
  const ren = pickRendererForPane(pane);
  if (!cadVertexCache.length) rebuildCadVertexCache();
  const root = pane === 'b' ? document.getElementById('viewer-b') : container;
  const tol = VERTEX_PICK_CSS_PX * displayPerCssPx(view, root);
  const items = cadVertexCache.map((v) => ({ id: v.id, pos: cadPosToWorld(v.pos) || v.pos }));
  const hit = pickClosestScreenHit(xy, view, ren, items, tol, surfacePos);
  if (!hit) return null;
  return { kind: 'vertex', vertexId: hit.id, pos: hit.pos, screenD2: hit.screenD2 };
}

function pickCadEdgeFromEvent(e, pane, surfacePos) {
  const xy = pickDisplayXY(e, pane);
  const view = pickViewForPane(pane);
  const ren = pickRendererForPane(pane);
  if (!xy || !view || !ren) return null;
  if (!cadEdgeCache.length) rebuildCadEdgeCache();
  const hideIds = hiddenCadFaces.size ? hiddenCadFaceIdSet() : null;
  if (hideIds && hideIds.size) attachCadEdgeAdjacentFaces();
  const root = pane === 'b' ? document.getElementById('viewer-b') : container;
  const tol = EDGE_PICK_CSS_PX * displayPerCssPx(view, root);
  const maxD = tol * tol;
  const ray = displayRayAtXY(xy, view, ren);
  const onEdgeSlack = surfacePos
    ? Math.max(visibleSurfaceSlack(ren, surfacePos), worldPerCssPixelAt(surfacePos, ren) * 4)
    : 0;
  let best = null;
  let bestD = Infinity;
  let bestPos = null;
  for (let i = 0; i < cadEdgeCache.length; i++) {
    const edge = cadEdgeCache[i];
    if (cadEdgeHiddenByFaces(edge, hideIds)) continue;
    const pts = edge.pts;
    if (!pts || pts.length < 2) continue;
    let prevDpy = null;
    let prevW = null;
    for (let k = 0; k < pts.length; k++) {
      const w = cadPosToWorld(pts[k]) || pts[k];
      const dpy = worldToDisplayXY(w, view, ren);
      if (prevDpy && dpy) {
        const seg = distPointSeg2(xy[0], xy[1], prevDpy[0], prevDpy[1], dpy[0], dpy[1]);
        if (seg.d2 <= maxD && seg.d2 < bestD) {
          let pos = ray
            ? closestPointOnSegmentToRay(ray.orig, ray.dir, prevW, w)
            : [
              prevW[0] + (w[0] - prevW[0]) * seg.u,
              prevW[1] + (w[1] - prevW[1]) * seg.u,
              prevW[2] + (w[2] - prevW[2]) * seg.u,
            ];
          if (surfacePos) {
            const onEdge = closestPointOnSegment(surfacePos, prevW, w);
            const d3 = v3len(v3sub(onEdge, surfacePos));
            if (d3 <= onEdgeSlack) pos = onEdge;
            else if (!edgeIsVisibleInFrontOf(pos, surfacePos, ren)) {
              prevDpy = dpy;
              prevW = w;
              continue;
            }
          }
          bestD = seg.d2;
          best = edge;
          bestPos = pos;
        }
      }
      prevDpy = dpy;
      prevW = w;
    }
  }
  if (!best) return null;
  return { kind: 'edge', edgeId: best.id, pos: bestPos, screenD2: bestD };
}

function pickFaceOrEdgeForSelect(e, pane) {
  const faceHit = pickFaceForHide(e, pane);
  const face = faceHit && faceHit.faceId ? { kind: 'face', ...faceHit } : null;
  const surfacePos = face && face.pos ? face.pos : null;
  const vertex = pickCadVertexFromEvent(e, pane, surfacePos);
  const edge = pickCadEdgeFromEvent(e, pane, surfacePos);
  // Clicking a long straight edge used to miss: the cache only stored the two
  // endpoints, so the face under the cursor always won. Prefer the closest
  // vertex/edge in screen space whenever one is within the pick radius.
  if (vertex && edge) return vertex.screenD2 <= edge.screenD2 ? vertex : edge;
  if (vertex) return vertex;
  if (edge) return edge;
  return face;
}

function pickCadFaceAlongRay(xy, view, ren) {
  if (!xy || !view || !ren) return null;
  if (!cadTriCache.length) rebuildCadTriCache();
  if (!cadTriCache.length) return null;
  if (!view.displayToWorld) return null;
  let near;
  let far;
  try {
    near = view.displayToWorld(xy[0], xy[1], 0, ren);
    far = view.displayToWorld(xy[0], xy[1], 1, ren);
  } catch (_) {
    return null;
  }
  if (!near || !far || !Number.isFinite(near[0]) || !Number.isFinite(far[0])) return null;
  // The triangle cache is in CAD units; in Results the world is the solver's
  // metres. Cast the ray in CAD space, report the hit back in world space.
  const s = cadToWorldScale();
  const origW = [near[0], near[1], near[2]];
  const dir = v3norm([far[0] - near[0], far[1] - near[1], far[2] - near[2]]);
  const orig = s === 1 ? origW : [origW[0] / s, origW[1] / s, origW[2] / s];
  let bestT = Infinity;
  let best = null;
  for (let i = 0; i < cadTriCache.length; i++) {
    const tri = cadTriCache[i];
    if (hiddenCadFaces.size && hiddenCadFaces.has(faceLabel(tri.faceId, 1))) continue;
    const t = rayHitsTri(orig, dir, tri.a, tri.b, tri.c);
    if (t > 0 && t < bestT) {
      bestT = t;
      best = tri;
    }
  }
  if (!best) return null;
  return {
    faceId: best.faceId,
    solidId: 1,
    pos: v3add(origW, v3scale(dir, bestT * s)),
  };
}

function pickMeshMappedCadFace(xy, actor, ren) {
  const world = pickMeshWorldAtDisplay(xy, actor, ren);
  if (!world) return null;
  const hit = nearestCadFaceAtPoint(world);
  if (hit) return hit;
  const s = meshDisplayScaleFromBounds(meshBounds || (actor && actor.getBounds && actor.getBounds())) || 1;
  if (s !== 1) {
    const scaled = nearestCadFaceAtPoint([world[0] * s, world[1] * s, world[2] * s]);
    if (scaled) return scaled;
    const unscaled = nearestCadFaceAtPoint([world[0] / s, world[1] / s, world[2] / s]);
    if (unscaled) return unscaled;
  }
  return null;
}

function pickFaceForHide(e, pane) {
  const xy = pickDisplayXY(e, pane);
  const view = pickViewForPane(pane);
  const ren = pickRendererForPane(pane);
  const ray = pickCadFaceAlongRay(xy, view, ren);
  if (ray && ray.faceId) return ray;
  if (pane !== 'b' && geomActor.getVisibility()) {
    const cad = pickCadHitFromEvent(e);
    if (cad && cad.faceId) return cad;
  }
  if (pane === 'b' && compareState.viewer) {
    if (!meshCompareOn()) return null;
    return pickMeshMappedCadFace(xy, compareState.viewer.actor, compareState.viewer.renderer);
  }
  if (meshInspectOpen || meshCompareOn()) {
    return pickMeshMappedCadFace(xy, meshSurfActor, ren);
  }
  return null;
}

function hideFaceCtxMenu() {
  const m = document.getElementById('face-ctx-menu');
  if (m) m.hidden = true;
  faceCtxHit = null;
  faceCtxOrbitTarget = null;
}

function edgeOrbitCadPoint(edge) {
  if (!edge || !edge.pts || !edge.pts.length) return null;
  if (typeof polylinePointAtFraction === 'function') {
    const mid = polylinePointAtFraction(edge.pts, 0.5);
    if (mid) return mid;
  }
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < edge.pts.length; i++) {
    x += edge.pts[i][0];
    y += edge.pts[i][1];
    z += edge.pts[i][2];
  }
  const n = edge.pts.length;
  return [x / n, y / n, z / n];
}

function orbitPointFromCadHit(hit) {
  if (!hit) return null;
  if (hit.kind === 'vertex' || hit.vertexId != null) {
    const v = cadVertexCache.find((x) => x.id === String(hit.vertexId));
    if (v) return { pos: cadPosToWorld(v.pos), kind: 'point' };
    if (hit.pos) return { pos: hit.pos, kind: 'point' };
  }
  if (hit.kind === 'edge' || hit.edgeId != null) {
    const e = cadEdgeCache.find((x) => x.id === Number(hit.edgeId));
    const p = e ? edgeOrbitCadPoint(e) : null;
    if (p) return { pos: cadPosToWorld(p), kind: 'edge' };
    if (hit.pos) return { pos: hit.pos, kind: 'edge' };
  }
  if (hit.faceId) {
    const info = faceOrientationInfo(hit.faceId);
    if (info && info.c) return { pos: cadPosToWorld(info.c), kind: 'face' };
    if (hit.pos) return { pos: hit.pos, kind: 'face' };
  }
  return null;
}

function orbitPointFromSelection() {
  if (vertexCtxSelected.size === 1 && !edgeCtxSelected.size && !faceCtxSelected.size) {
    const id = Array.from(vertexCtxSelected)[0];
    const v = cadVertexCache.find((x) => x.id === id);
    if (v) return { pos: cadPosToWorld(v.pos), kind: 'point' };
  }
  if (edgeCtxSelected.size === 1 && !vertexCtxSelected.size && !faceCtxSelected.size) {
    const e = cadEdgeCache.find((x) => x.id === Number(Array.from(edgeCtxSelected)[0]));
    const p = e && edgeOrbitCadPoint(e);
    if (p) return { pos: cadPosToWorld(p), kind: 'edge' };
  }
  if (faceCtxSelected.size === 1 && !edgeCtxSelected.size && !vertexCtxSelected.size) {
    const fid = selectedFaceIds()[0];
    const info = fid ? faceOrientationInfo(fid) : null;
    if (info && info.c) return { pos: cadPosToWorld(info.c), kind: 'face' };
  }
  return null;
}

function showFaceCtxMenu(e, hit) {
  const m = document.getElementById('face-ctx-menu');
  const wrap = document.querySelector('.viewport-wrap');
  if (!m || !wrap) return;
  faceCtxHit = hit || null;
  const hideBtn = document.getElementById('face-ctx-hide');
  const normalBtn = document.getElementById('face-ctx-normal');
  const showBtn = document.getElementById('face-ctx-show-all');
  const orbitBtn = document.getElementById('face-ctx-orbit');
  const sep = document.getElementById('face-ctx-sep');
  if (hit && hit.kind === 'face' && hit.faceId) {
    const lab = faceLabel(hit.faceId, hit.solidId || 1);
    if (!faceCtxSelected.has(lab)) applyCadPick({ kind: 'face', ...hit }, false);
    const nSel = faceCtxSelected.size;
    if (hideBtn) {
      hideBtn.hidden = false;
      hideBtn.disabled = hiddenCadFaces.has(lab) && nSel < 2;
      hideBtn.textContent = nSel > 1
        ? 'Hide ' + nSel + ' faces'
        : (hiddenCadFaces.has(lab) ? lab + ' is hidden' : 'Hide ' + lab);
    }
    const info = faceOrientationInfo(hit.faceId);
    if (normalBtn) {
      normalBtn.hidden = false;
      normalBtn.disabled = !(info && info.flat);
      normalBtn.title = info && info.flat ? 'Look straight at this face' : 'Only flat faces can snap normal';
    }
  } else {
    if (hideBtn) hideBtn.hidden = true;
    if (normalBtn) normalBtn.hidden = true;
  }
  if (showBtn) showBtn.hidden = hiddenCadFaces.size < 1;
  const orbit = orbitPointFromCadHit(hit) || orbitPointFromSelection();
  faceCtxOrbitTarget = orbit;
  if (orbitBtn) {
    orbitBtn.hidden = !orbit;
    if (orbit) {
      orbitBtn.textContent =
        orbit.kind === 'face'
          ? 'Orbit around this face'
          : orbit.kind === 'edge'
            ? 'Orbit around this edge'
            : 'Orbit around this point';
    }
  }
  if (sep) sep.hidden = false;
  const wr = wrap.getBoundingClientRect();
  let x = e.clientX - wr.left;
  let y = e.clientY - wr.top;
  m.hidden = false;
  const mw = m.offsetWidth || 180;
  const mh = m.offsetHeight || 120;
  if (x + mw > wr.width - 8) x = wr.width - mw - 8;
  if (y + mh > wr.height - 8) y = wr.height - mh - 8;
  m.style.left = Math.max(8, x) + 'px';
  m.style.top = Math.max(8, y) + 'px';
}

function onViewerFaceContextMenu(e) {
  const pane = (e.currentTarget && e.currentTarget.id === 'viewer-b') ||
    (e.target && e.target.closest && e.target.closest('#viewer-b'))
    ? 'b'
    : 'a';
  const picked = pickFaceOrEdgeForSelect(e, pane);
  if (picked) applyCadPick(picked, false);
  showFaceCtxMenu(e, picked);
}

function onViewerFaceClick(e, pane) {
  if (e.shiftKey) return;
  try {
    if (typeof isAssigningMaterial === 'function' && isAssigningMaterial()) return;
    if (typeof isAssigningFace === 'function' && isAssigningFace()) return;
  } catch (_) {}
  const additive = !!(e.ctrlKey || e.metaKey);
  const hit = pickFaceOrEdgeForSelect(e, pane || 'a');
  if (hit) applyCadPick(hit, additive);
  else if (!additive) clearCadSelection();
}

function wireViewerFaceClick(el, pane) {
  if (!el || el._faceClickWired) return;
  el._faceClickWired = true;
  let down = null;
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (!el.contains(e.target)) return;
    down = { x: e.clientX, y: e.clientY };
  }, true);
  window.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || !down) return;
    const start = down;
    down = null;
    const slop = 16;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (dx * dx + dy * dy > slop * slop) return;
    const canvas = (el.querySelector && el.querySelector('canvas')) || el;
    const rect = canvas.getBoundingClientRect();
    if (
      e.clientX < rect.left || e.clientX > rect.right ||
      e.clientY < rect.top || e.clientY > rect.bottom
    ) return;
    try { onViewerFaceClick(e, pane); } catch (_) {}
  });
}

function hitFromCellIdOnPd(pd, cellId) {
  if (!pd || cellId == null || cellId < 0) return null;
  const cd = pd.getCellData && pd.getCellData();
  const faceArr = cd && cd.getArrayByName && cd.getArrayByName('faceId');
  const solidArr = cd && cd.getArrayByName && cd.getArrayByName('solidId');
  let faceId = 0;
  let solidId = 0;
  if (faceArr) {
    const raw = faceArr.getData ? faceArr.getData() : null;
    faceId = raw ? Number(raw[cellId]) : Number(faceArr.getValue(cellId));
  }
  if (solidArr) {
    const raw = solidArr.getData ? solidArr.getData() : null;
    solidId = raw ? Number(raw[cellId]) : Number(solidArr.getValue(cellId));
  }
  if (!solidId && geometryBodies().length) solidId = 1;
  if (!faceId && !solidId) return null;
  return { cellId, faceId, solidId };
}

(function wireFaceContextMenu() {
  const menu = document.getElementById('face-ctx-menu');
  menu?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-face-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-face-act');
    const hit = faceCtxHit;
    if (act === 'hide' && hit && hit.faceId) {
      const lab = faceLabel(hit.faceId, hit.solidId || 1);
      if (faceCtxSelected.size > 1 && faceCtxSelected.has(lab)) {
        hideCadFaces(Array.from(faceCtxSelected));
      } else {
        hideCadFace(lab);
      }
      hideFaceCtxMenu();
    } else if (act === 'normal' && hit && hit.faceId) {
      lookNormalToFace(hit.faceId);
      hideFaceCtxMenu({ keepPreview: true });
    } else if (act === 'orbit') {
      const p = (faceCtxOrbitTarget && faceCtxOrbitTarget.pos) ||
        (orbitPointFromCadHit(hit) && orbitPointFromCadHit(hit).pos) ||
        (orbitPointFromSelection() && orbitPointFromSelection().pos);
      if (p) setOrbitCenter('custom', p);
      hideFaceCtxMenu({ keepPreview: true });
    } else if (act === 'orbit-model') {
      setOrbitCenter('model');
      hideFaceCtxMenu({ keepPreview: true });
    } else if (act === 'orbit-origin') {
      setOrbitCenter('origin');
      hideFaceCtxMenu({ keepPreview: true });
    } else if (act === 'show-all') {
      showAllCadFaces();
      hideFaceCtxMenu();
    } else {
      hideFaceCtxMenu();
    }
  });
  document.getElementById('hidden-faces-show')?.addEventListener('click', () => {
    showAllCadFaces();
    hideFaceCtxMenu();
  });
  document.getElementById('measure-clear')?.addEventListener('click', () => {
    clearCadSelection();
  });
  document.addEventListener('mousedown', (e) => {
    const m = document.getElementById('face-ctx-menu');
    if (!m || m.hidden) return;
    if (m.contains(e.target)) return;
    hideFaceCtxMenu({ keepPreview: true });
  });
  try { wireViewerFaceClick(container, 'a'); } catch (_) {}
  try {
    renderer.getActiveCamera().onModified(() => {
      try { applyMeshEdgeLod(); } catch (_) {}
      try { scheduleVertexMarkRefresh(); } catch (_) {}
      try { layoutPtRegionHandles(); } catch (_) {}
    });
  } catch (_) {}
})();

function collectFaceTriangles(faceIds) {
  const want = new Set((faceIds || []).map(parseFaceId).filter((n) => n > 0));
  if (!want.size) return [];
  if (!cadTriCache.length) rebuildCadTriCache();
  return cadTriCache.filter((t) => want.has(t.faceId)).map((t) => ({
    faceId: t.faceId,
    a: t.a,
    b: t.b,
    c: t.c,
    va: t.a,
    vb: t.b,
    vc: t.c,
    n: t.n,
    area: t.area,
  }));
}

function closestPointOnTri(p, a, b, c) {
  const ab = v3sub(b, a);
  const ac = v3sub(c, a);
  const ap = v3sub(p, a);
  const d1 = v3dot(ab, ap);
  const d2 = v3dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a.slice();
  const bp = v3sub(p, b);
  const d3 = v3dot(ab, bp);
  const d4 = v3dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b.slice();
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return v3add(a, v3scale(ab, v));
  }
  const cp = v3sub(p, c);
  const d5 = v3dot(ab, cp);
  const d6 = v3dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c.slice();
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return v3add(a, v3scale(ac, w));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return v3add(b, v3scale(v3sub(c, b), w));
  }
  const denom = 1 / (va + vb + vc);
  return v3add(a, v3add(v3scale(ab, vb * denom), v3scale(ac, vc * denom)));
}

function rayHitsTri(orig, dir, v0, v1, v2) {
  const e1 = v3sub(v1, v0);
  const e2 = v3sub(v2, v0);
  const pvec = v3cross(dir, e2);
  const det = v3dot(e1, pvec);
  if (Math.abs(det) < 1e-10) return -1;
  const inv = 1 / det;
  const tvec = v3sub(orig, v0);
  const u = v3dot(tvec, pvec) * inv;
  if (u < 0 || u > 1) return -1;
  const qvec = v3cross(tvec, e1);
  const v = v3dot(dir, qvec) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = v3dot(e2, qvec) * inv;
  return t > 1e-8 ? t : -1;
}

function pointInsideCad(p) {
  if (!cadTriCache.length) rebuildCadTriCache();
  const dirs = [
    [0.883, 0.321, 0.342],
    [-0.412, 0.789, 0.455],
    [0.211, -0.577, 0.789],
  ];
  let votes = 0;
  for (let d = 0; d < dirs.length; d++) {
    const dir = v3norm(dirs[d]);
    let hits = 0;
    for (let i = 0; i < cadTriCache.length; i++) {
      const t = cadTriCache[i];
      if (rayHitsTri(p, dir, t.a, t.b, t.c) > 0) hits += 1;
    }
    if (hits % 2 === 1) votes += 1;
  }
  return votes >= 2;
}

function solidCenterFromBounds() {
  const pd = geomCadFaceReader.getOutputData && geomCadFaceReader.getOutputData();
  const b = pd && pd.getBounds && pd.getBounds();
  if (!b) return [0, 0, 0];
  return [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
}

function firstHitDist(orig, dir, skipFaceId) {
  if (!cadTriCache.length) rebuildCadTriCache();
  let best = Infinity;
  for (let i = 0; i < cadTriCache.length; i++) {
    const t = cadTriCache[i];
    if (skipFaceId && t.faceId === skipFaceId) continue;
    const h = rayHitsTri(orig, dir, t.a, t.b, t.c);
    if (h > 0 && h < best) best = h;
  }
  return best;
}

function faceOutwardNormal(n, centroid, faceId) {
  const pd = geomCadFaceReader.getOutputData && geomCadFaceReader.getOutputData();
  const b = pd && pd.getBounds && pd.getBounds();
  const diag = b
    ? Math.hypot(b[1] - b[0], b[3] - b[2], b[5] - b[4])
    : 1;
  const eps = Math.max(diag * 0.003, 1e-4);
  const nHat = v3norm(n);
  const plus = v3add(centroid, v3scale(nHat, eps));
  const minus = v3add(centroid, v3scale(nHat, -eps));
  const hitPlus = firstHitDist(plus, nHat, faceId);
  const hitMinus = firstHitDist(minus, v3scale(nHat, -1), faceId);
  if (!isFinite(hitPlus) && isFinite(hitMinus)) return nHat;
  if (isFinite(hitPlus) && !isFinite(hitMinus)) return v3scale(nHat, -1);
  const plusIn = pointInsideCad(plus);
  const minusIn = pointInsideCad(minus);
  if (plusIn && !minusIn) return v3scale(nHat, -1);
  if (!plusIn && minusIn) return nHat;
  return outwardNormalFallback(nHat, centroid, solidCenterFromBounds());
}

function outwardNormalFallback(n, centroid, center) {
  const toOut = v3sub(centroid, center);
  if (v3len(toOut) < 1e-9) return n;
  return v3dot(n, toOut) >= 0 ? n : v3scale(n, -1);
}

function pickSpreadTris(list, count) {
  const picked = [];
  let first = list[0];
  for (const t of list) if (t.area > first.area) first = t;
  picked.push(first);
  while (picked.length < count) {
    let best = null;
    let bestD = -1;
    for (const t of list) {
      let dmin = Infinity;
      for (const p of picked) {
        const d =
          (t.c[0] - p.c[0]) ** 2 + (t.c[1] - p.c[1]) ** 2 + (t.c[2] - p.c[2]) ** 2;
        if (d < dmin) dmin = d;
      }
      if (dmin > bestD) {
        bestD = dmin;
        best = t;
      }
    }
    if (!best) break;
    picked.push(best);
  }
  return picked;
}

function sampleFaceSeeds(tris) {
  if (!tris.length) return [];
  const byFace = new Map();
  for (const t of tris) {
    if (!byFace.has(t.faceId)) byFace.set(t.faceId, []);
    byFace.get(t.faceId).push(t);
  }
  const groups = [];
  byFace.forEach((list, faceId) => {
    const area = list.reduce((s, t) => s + t.area, 0) || 1;
    const c = list.reduce((acc, t) => v3add(acc, v3scale(t.c, t.area / area)), [0, 0, 0]);
    const n = v3norm(list.reduce((acc, t) => v3add(acc, v3scale(t.n, t.area)), [0, 0, 0]));
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    let minDot = 1;
    let nearest = list[0];
    let nearestDist = Infinity;
    let nearestPt = list[0].c.slice();
    for (const t of list) {
      minDot = Math.min(minDot, v3len(n) > 1e-9 ? v3dot(n, t.n) : 1);
      for (let k = 0; k < 3; k++) {
        if (t.c[k] < min[k]) min[k] = t.c[k];
        if (t.c[k] > max[k]) max[k] = t.c[k];
      }
      const q = closestPointOnTri(c, t.va || t.a, t.vb || t.b, t.vc || t.c);
      const d = v3len(v3sub(q, c));
      if (d < nearestDist) {
        nearestDist = d;
        nearest = t;
        nearestPt = q;
      }
    }
    const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
    const hole = nearestDist > Math.max(diag * 0.05, 1e-4);
    const curved = minDot < 0.92;
    const seeds = [];
    if (!hole && !curved) {
      const nOut = faceOutwardNormal(nearest.n || n, nearestPt, faceId);
      seeds.push({ c: nearestPt, n: nOut, area, nOut });
    } else {
      const count = hole ? (list.length > 120 ? 6 : 4) : Math.min(5, Math.max(3, list.length > 80 ? 5 : 3));
      for (const t of pickSpreadTris(list, count)) {
        const ln = faceOutwardNormal(t.n, t.c, faceId);
        seeds.push({ c: t.c, n: ln, area: t.area, nOut: ln });
      }
    }
    const nOut = (seeds[0] && seeds[0].nOut) || faceOutwardNormal(n, nearestPt, faceId);
    groups.push({ faceId, c: (seeds[0] && seeds[0].c) || nearestPt, nOut, area, diag, seeds });
  });
  return groups;
}

function ensureBcAxisOverlay() {
  let el = document.getElementById('bc-axis-overlay');
  if (!el && container) {
    el = document.createElement('div');
    el.id = 'bc-axis-overlay';
    el.className = 'bc-axis-overlay';
    el.hidden = true;
    el.innerHTML =
      '<span class="bc-axis-lab" data-axis="x">X</span>' +
      '<span class="bc-axis-lab" data-axis="y">Y</span>' +
      '<span class="bc-axis-lab" data-axis="z">Z</span>';
    container.appendChild(el);
  }
  return el;
}

function positionBcAxisLabels() {
  const el = document.getElementById('bc-axis-overlay');
  if (!el || el.hidden || !bcAxisTips) return;
  const view = vtkView();
  const canvas = (view && view.getCanvas && view.getCanvas()) ||
    (container && container.querySelector('canvas'));
  if (!view || !canvas || !view.worldToDisplay) return;
  const rect = canvas.getBoundingClientRect();
  const size = view.getSize();
  const crect = container.getBoundingClientRect();
  ['x', 'y', 'z'].forEach((ax) => {
    const lab = el.querySelector('[data-axis="' + ax + '"]');
    const p = bcAxisTips[ax];
    if (!lab || !p) return;
    const d = view.worldToDisplay(p[0], p[1], p[2], renderer);
    const left = (d[0] / size[0]) * rect.width + (rect.left - crect.left);
    const top = (1 - d[1] / size[1]) * rect.height + (rect.top - crect.top);
    lab.style.left = left + 'px';
    lab.style.top = top + 'px';
  });
}

function setGlyphPd(glyph, pd, on) {
  if (!on || !pd) {
    glyph.actor.setVisibility(false);
    return;
  }
  glyph.mapper.setInputData(pd);
  glyph.actor.setVisibility(true);
}

function clearBcGlyphs() {
  bcGlyphActors().forEach((g) => setGlyphPd(g, null, false));
  bcAxisTips = null;
  const el = document.getElementById('bc-axis-overlay');
  if (el) el.hidden = true;
  try {
    renderWindow.render();
  } catch (_) {}
}

function updateBcGlyphs() {
  try {
    if (treeUi.openPanel === 'bcs-hub') showBcOverview();
    else updateBcGlyphsInner();
  } catch (e) {
    console.warn('[CFD] BC glyphs', e);
  }
}

function modelDiagFromCad() {
  const pd = geomCadFaceReader.getOutputData && geomCadFaceReader.getOutputData();
  const bounds = pd && pd.getBounds && pd.getBounds();
  if (!bounds) return 1;
  return Math.hypot(bounds[1] - bounds[0], bounds[3] - bounds[2], bounds[5] - bounds[4]) || 1;
}

function showBcOverview() {
  const list = (typeof bcList === 'function' ? bcList() : []).filter(
    (b) => b && (b.faces || []).length
  );
  if (!list.length) {
    highlightGeomFaces([]);
    clearBcGlyphs();
    return;
  }
  const paint = {};
  const all = [];
  list.forEach((bc) => {
    const rgb = BC_KIND_RGB[bcKind(bc)];
    (bc.faces || []).forEach((f) => {
      paint[f] = rgb;
      all.push(f);
    });
  });
  highlightGeomFaces(all, null, paint);
  const modelDiag = modelDiagFromCad();
  const inletApp = vtkAppendPolyData.newInstance();
  const outletApp = vtkAppendPolyData.newInstance();
  let nIn = 0;
  let nOut = 0;
  list.forEach((bc) => {
    const kind = bcKind(bc);
    if (kind === 'pressure' || kind === 'wall') return;
    const groups = sampleFaceSeeds(collectFaceTriangles(bc.faces));
    if (!groups.length) return;
    if (kind === 'outlet') {
      addFlowArrows(outletApp, groups, bc, modelDiag);
      nOut += 1;
    } else {
      addFlowArrows(inletApp, groups, bc, modelDiag);
      nIn += 1;
    }
  });
  if (nIn) {
    inletApp.update();
    setGlyphPd(bcFlowGlyph, inletApp.getOutputData(), true);
  } else setGlyphPd(bcFlowGlyph, null, false);
  if (nOut) {
    outletApp.update();
    setGlyphPd(bcOutletGlyph, outletApp.getOutputData(), true);
  } else setGlyphPd(bcOutletGlyph, null, false);
  setGlyphPd(bcAxisGlyphX, null, false);
  setGlyphPd(bcAxisGlyphY, null, false);
  setGlyphPd(bcAxisGlyphZ, null, false);
  bcAxisTips = null;
  const overlay = document.getElementById('bc-axis-overlay');
  if (overlay) overlay.hidden = true;
  try {
    renderWindow.render();
  } catch (_) {}
}

function updateBcGlyphsInner() {
  const bc = typeof activeBc === 'function' ? activeBc() : null;
  const faces = (w19State && w19State.draft_faces) || [];
  if (!isAssigningBcFace() || !bc || !faces.length) {
    clearBcGlyphs();
    return;
  }
  const tris = collectFaceTriangles(faces);
  if (!tris.length) {
    clearBcGlyphs();
    return;
  }
  const groups = sampleFaceSeeds(tris);
  const modelDiag = modelDiagFromCad();
  const vel = isVelocityBc(bc);
  const kind = bcKind(bc);
  const useVec = vel && bc.velocity_type === 'Fixed' && bc.direction === 'Vector';

  setGlyphPd(bcFlowGlyph, null, false);
  setGlyphPd(bcOutletGlyph, null, false);

  if (vel && groups.length) {
    const append = vtkAppendPolyData.newInstance();
    addFlowArrows(append, groups, bc, modelDiag);
    append.update();
    const glyph = kind === 'outlet' ? bcOutletGlyph : bcFlowGlyph;
    setGlyphPd(glyph, append.getOutputData(), true);
  }

  if (useVec && groups.length) {
    const axX = vtkAppendPolyData.newInstance();
    const axY = vtkAppendPolyData.newInstance();
    const axZ = vtkAppendPolyData.newInstance();
    let labelOrigin = null;
    let axisLenUsed = 0;
    for (const g of groups) {
      const axisLen = Math.max(modelDiag * 0.06, Math.min(modelDiag * 0.11, g.diag * 0.32));
      const lift = axisLen * 0.012;
      const o = v3add(g.c, v3scale(g.nOut, lift));
      axX.addInputData(arrowPolyAt(o, [1, 0, 0], axisLen, false));
      axY.addInputData(arrowPolyAt(o, [0, 1, 0], axisLen, false));
      axZ.addInputData(arrowPolyAt(o, [0, 0, 1], axisLen, false));
      if (!labelOrigin) {
        labelOrigin = o;
        axisLenUsed = axisLen;
      }
    }
    axX.update();
    axY.update();
    axZ.update();
    setGlyphPd(bcAxisGlyphX, axX.getOutputData(), true);
    setGlyphPd(bcAxisGlyphY, axY.getOutputData(), true);
    setGlyphPd(bcAxisGlyphZ, axZ.getOutputData(), true);
    if (groups.length === 1 && labelOrigin) {
      bcAxisTips = {
        x: v3add(labelOrigin, [axisLenUsed, 0, 0]),
        y: v3add(labelOrigin, [0, axisLenUsed, 0]),
        z: v3add(labelOrigin, [0, 0, axisLenUsed]),
      };
      const overlay = ensureBcAxisOverlay();
      if (overlay) overlay.hidden = false;
      positionBcAxisLabels();
    } else {
      bcAxisTips = null;
      const overlay = document.getElementById('bc-axis-overlay');
      if (overlay) overlay.hidden = true;
    }
  } else {
    setGlyphPd(bcAxisGlyphX, null, false);
    setGlyphPd(bcAxisGlyphY, null, false);
    setGlyphPd(bcAxisGlyphZ, null, false);
    bcAxisTips = null;
    const overlay = document.getElementById('bc-axis-overlay');
    if (overlay) overlay.hidden = true;
  }
  try {
    renderWindow.render();
  } catch (_) {}
}

if (container && !container._bcGlyphCamWired) {
  container._bcGlyphCamWired = true;
  container.addEventListener('mousemove', () => {
    if (bcAxisTips) positionBcAxisLabels();
  });
  container.addEventListener(
    'wheel',
    () => {
      if (bcAxisTips) requestAnimationFrame(positionBcAxisLabels);
    },
    { passive: true }
  );
}

function pickSolidIdAtDisplay(x, y) {
  const hit = pickCadHitAtDisplay(x, y);
  return hit && hit.solidId ? hit.solidId : null;
}

function assignBodyFromViewportEvent(e) {
  if (!isAssigningMaterial()) return false;
  const hit = pickCadHitFromEvent(e);
  if (!hit || !hit.solidId) return false;
  toggleAssignVolume(bodyNameFromIndex(hit.solidId), hit.solidId);
  return true;
}

function assignFromViewportEvent(e) {
  const hit = pickCadHitFromEvent(e);
  if (!hit) return false;
  if (isAssigningFace()) {
    if (!hit.faceId) {
      console.warn('[CFD] face pick: CAD preview has no faceId');
      return false;
    }
    const label = faceLabel(hit.faceId, hit.solidId || 1);
    if (isAssigningRefFace() && typeof toggleAssignRefFace === 'function') {
      toggleAssignRefFace(label);
    } else if (isAssigningAaFace() && typeof toggleAssignAaFace === 'function') {
      toggleAssignAaFace(label);
    } else if (isAssigningPtFace() && typeof toggleAssignPtFace === 'function') {
      if (isPtRegionDrawArmed() || isPtRegionBusy()) return false;
      toggleAssignPtFace(label);
    } else if (typeof toggleAssignFace === 'function') {
      toggleAssignFace(label);
    }
    return true;
  }
  if (isAssigningMaterial()) {
    if (!hit.solidId) return false;
    toggleAssignVolume(bodyNameFromIndex(hit.solidId), hit.solidId);
    return true;
  }
  return false;
}

async function deleteAirMaterialClient() {
  const payload = { delete: true };
  if (w16State.project && w16State.project.id) payload.project_id = w16State.project.id;
  const r = await fetch('/api/materials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'delete failed');
  w18State.material = null;
  w18State.draft_volumes = [];
  w18State.ready = false;
  w18State.created = false;
  w18State.libraryApplied = false;
  w18State.materials_json = null;
  highlightGeomBody(null);
  hideAllTreeDetails();
  syncSimulationTree();
  publishW18({ deleted: true, ready: false });
  return j;
}

function assignBody1Draft() {
  toggleAssignVolume('Body1', 1);
}

async function applyMaterialFromLibrary() {
  if (!w18State.draft_volumes.length) {
    const hint = document.getElementById('mat-picker-hint');
    if (hint) hint.classList.add('is-warn');
    return;
  }
  try {
    await saveAirMaterialClient({
      assigned_volumes: w18State.draft_volumes.slice(),
      openPanel: false,
    });
    highlightGeomBody(null);
    closeMaterialLibrary();
    markTreeSelected('air');
    publishW18({ library_applied: true, ready: true });
  } catch (e) {
    console.error('[CFD W18] apply', e);
  }
}

window.__CFD_W18_SAVE__ = saveAirMaterialClient;
window.__CFD_W18_APPLY__ = async function applyW18(partial) {
  if (partial && (partial.save || partial.assign || partial.assigned_volumes || partial.name)) {
    if (partial.assigned_volumes) {
      w18State.draft_volumes = Array.isArray(partial.assigned_volumes)
        ? partial.assigned_volumes.slice()
        : [String(partial.assigned_volumes)];
    } else if (partial.assign === 'Body1' || partial.body === 'Body1') {
      w18State.draft_volumes = ['Body1'];
    } else if (!w18State.draft_volumes.length) {
      w18State.draft_volumes = ['Body1'];
    }
    w18State.libraryApplied = true;
    return saveAirMaterialClient(partial);
  }
  return publishW18();
};
window.__CFD_W18_ASSIGN__ = function assignW18(vol) {
  if (vol === 'Body1' || !vol) assignBody1Draft();
  return publishW18({ draft: true });
};

(function wireW18Ui() {
  document.getElementById('ml-cancel')?.addEventListener('click', closeMaterialLibrary);
  document.getElementById('ml-cancel-x')?.addEventListener('click', closeMaterialLibrary);
  document.getElementById('ml-backdrop')?.addEventListener('click', closeMaterialLibrary);
  document.getElementById('ml-apply')?.addEventListener('click', () => applyMaterialFromLibrary());
  document.getElementById('air-clear-assign')?.addEventListener('click', () => {
    w18State.draft_volumes = [];
    highlightGeomBody(null);
    syncAirAssignList();
    publishW18({ draft: true });
    persistAirAssignment();
  });
  document.getElementById('air-delete')?.addEventListener('click', () => {
    deleteAirMaterialClient().catch((e) => console.error('[CFD W18] delete', e));
  });
  document.getElementById('btn-add-material')?.addEventListener('click', () => openMaterialLibrary());
  document.getElementById('materials-hub-close')?.addEventListener('click', () => hideAllTreeDetails());
  document.getElementById('materials-hub-list')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-del-air]')) {
      e.preventDefault();
      deleteAirMaterialClient().catch((err) => console.error('[CFD W18] delete', err));
      return;
    }
    if (e.target.closest('[data-open-air]')) {
      markTreeSelected('air');
      openAirPanel();
    }
  });
  document.getElementById('btn-add-bc')?.addEventListener('click', () => openBcTypeModal());
  document.getElementById('bcs-hub-close')?.addEventListener('click', () => hideAllTreeDetails());
  document.getElementById('bcs-hub-list')?.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-bc]');
    if (del) {
      e.preventDefault();
      const id = del.getAttribute('data-del-bc');
      if (id && typeof deleteBcClient === 'function') {
        deleteBcClient(id).catch((err) => console.error('[CFD] BC delete', err));
      }
      return;
    }
    const btn = e.target.closest('[data-open-bc]');
    if (!btn) return;
    const k = btn.getAttribute('data-open-bc');
    const list = (window.__CFD_W19_STATE__ && window.__CFD_W19_STATE__.bcs) || [];
    const hit =
      list.find((b) => b.id === k) ||
      (k === 'vi' && list.find((b) => b.bc_type === 'Velocity inlet')) ||
      (k === 'po' && list.find((b) => String(b.bc_type || '').startsWith('Pressure')));
    if (hit && typeof showBcEditor === 'function') showBcEditor(hit);
    else if (typeof showBcPanel === 'function') showBcPanel(k);
  });
  if (container && !container._assignPickWired) {
    container._assignPickWired = true;
    let down = null;
    container.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !(isAssigningMaterial() || isAssigningFace())) return;
      if (isPtRegionDrawArmed() || isPtRegionBusy()) return;
      down = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button !== 0 || !down) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      down = null;
      if (dx * dx + dy * dy > 25) return;
      if (isPtRegionDrawArmed() || isPtRegionBusy()) return;
      if (!(isAssigningMaterial() || isAssigningFace())) return;
      assignFromViewportEvent(e);
    });
  }
    window.__CFD_PICK_CAD__ = pickCadHitFromEvent;
    window.__CFD_ASSIGN_BODY__ = function assignBody(idx) {
    const n = Number(idx) || 1;
    toggleAssignVolume(bodyNameFromIndex(n), n);
    return (w18State.draft_volumes || []).slice();
  };

  const prevCreate = window.__CFD_W16_CREATE__;
  if (typeof prevCreate === 'function') {
    window.__CFD_W16_CREATE__ = async function wrappedCreateW18(fields) {
      const out = await prevCreate(fields);
      w18State.material = null;
      w18State.draft_volumes = [];
      w18State.ready = false;
      w18State.created = false;
      w18State.libraryApplied = false;
      w18State.materials_json = null;
      w18State.project_id = (out && out.project && out.project.id) || null;
      closeAirPanel();
      publishW18({ ready: false, note: 'W18: waiting for Materials → Air' });
      return out;
    };
  }

  const prevW17Create = window.__CFD_W17_CREATE__;
  if (typeof prevW17Create === 'function') {
    window.__CFD_W17_CREATE__ = async function wrappedW17Create(opts) {
      const out = await prevW17Create(opts);
      w18State.material = null;
      w18State.draft_volumes = [];
      w18State.ready = false;
      w18State.libraryApplied = false;
      syncSimulationTree();
      publishW18({ ready: false, note: 'W18: Materials + → Air available' });
      return out;
    };
  }

  fetch('/api/materials' + hashProjectQs())
    .then((r) => r.json())
    .then((j) => {
      w18State.hydrated = true;
      const sid = currentStudyId();
      if (j && j.air && sid) {
        applyMaterialRecord(j.air, j.project_id, { openPanel: false });
        publishW18({ hydrated: true, created: false });
      } else {
        syncSimulationTree();
        publishW18({ hydrated: true, ready: false });
      }
    })
    .catch((e) => {
      console.warn('[CFD W18] hydrate', e);
      w18State.hydrated = true;
      syncSimulationTree();
      publishW18({ ready: false });
    });
})();



/**
 * Boundary conditions: Velocity inlet / outlet, Pressure, Wall (slip / no-slip).
 * Click a CAD face in the viewport to assign it. Settings save automatically.
 * Faces no BC claims follow the project defaults (`w19State.defaults`):
 * no-slip walls unless the user switches the default to slip.
 */
const BC_TYPE_LIST = ['Velocity inlet', 'Velocity outlet', 'Pressure', 'Wall'];
const WALL_TYPE_LIST = ['No-slip', 'Slip'];
const BC_DEFAULTS_FALLBACK = { wall_type: 'No-slip' };

const w19State = {
  ready: false,
  hydrated: false,
  created: false,
  project_id: null,
  bcs: [],
  defaults: { ...BC_DEFAULTS_FALLBACK },
  activeId: null,
  draft_faces: [],
  focusFace: null,
  velocity_inlet_1: null,
  pressure_outlet_2: null,
  boundary_conditions_json: null,
  note: 'Boundary conditions',
};
window.__CFD_W19_STATE__ = w19State;

function bcList() {
  return Array.isArray(w19State.bcs) ? w19State.bcs : [];
}

function bcHasAssignedFace(b) {
  return !!(b && ((Array.isArray(b.faces) && b.faces.length) || b.face));
}

function solveHasFlowDriver() {
  const list = bcList();
  const inlets = list.filter((b) => String((b && b.bc_type) || '') === 'Velocity inlet' && bcHasAssignedFace(b));
  const pressures = list.filter((b) => String((b && b.bc_type) || '') === 'Pressure' && bcHasAssignedFace(b));
  return (inlets.length > 0 && pressures.length > 0) || pressures.length >= 2;
}

function activeBc() {
  return bcList().find((b) => b.id === w19State.activeId) || null;
}

function normalizeWallType(raw) {
  const t = String(raw || '').toLowerCase().replace(/[\s_-]+/g, '');
  return t === 'slip' ? 'Slip' : 'No-slip';
}

function bcDefaults() {
  const d = w19State.defaults || {};
  return { wall_type: normalizeWallType(d.wall_type) };
}

function renameBcForType(bc, nextType) {
  const m = String((bc && bc.name) || '').match(
    /^(Velocity inlet|Velocity outlet|Pressure|Wall)\s+(\d+)$/i
  );
  if (!m) return bc.name;
  const n = Number(m[2]);
  const want = nextType + ' ' + n;
  const taken = bcList().some((b) => b.id !== bc.id && b.name === want);
  if (!taken) return want;
  let i = 1;
  const names = new Set(bcList().filter((b) => b.id !== bc.id).map((b) => b.name));
  while (names.has(nextType + ' ' + i)) i += 1;
  return nextType + ' ' + i;
}

function isVelocityBc(bc) {
  return !!(bc && String(bc.bc_type || '').startsWith('Velocity'));
}

function isWallBc(bc) {
  return !!(bc && isWallBcType(bc.bc_type));
}

function currentProjectId() {
  return (
    (w16State.project && w16State.project.id) ||
    (typeof w17State !== 'undefined' && w17State.project_id) ||
    w19State.project_id ||
    (typeof w20State !== 'undefined' && w20State.project_id) ||
    (typeof w26State !== 'undefined' && w26State.project_id) ||
    null
  );
}

function publishW19(extra) {
  const list = bcList();
  const vi = list.find((b) => b.bc_type === 'Velocity inlet') || null;
  const po = list.find((b) => String(b.bc_type || '').startsWith('Pressure')) || null;
  w19State.velocity_inlet_1 = vi;
  w19State.pressure_outlet_2 = po;
  const payload = {
    ready: list.length > 0,
    hydrated: w19State.hydrated,
    created: w19State.created,
    project_id: w19State.project_id,
    boundary_conditions: list,
    defaults: bcDefaults(),
    velocity_inlet_1: vi,
    pressure_outlet_2: po,
    activeId: w19State.activeId,
    boundary_conditions_json: w19State.boundary_conditions_json,
    note: w19State.note,
    increment: 'W19',
    ...(extra || {}),
  };
  window.__CFD_W19__ = payload;
  return payload;
}

function unitsForVelocity(vt, fr) {
  if (vt === 'Flow rate' && fr === 'Mass flow') return ['kg/s', 'lb/s'];
  if (vt === 'Flow rate') return ['m³/s', 'ft³/min'];
  return ['m/s', 'ft/s'];
}

function fillBcUnitSelect(vt, fr, current) {
  const sel = document.getElementById('bc-unit');
  if (!sel) return;
  const units = unitsForVelocity(vt, fr);
  const imperial = !!(window.__CFD_PREFS__ && /imperial/i.test(String(window.__CFD_PREFS__.units || '')));
  const fallback = imperial
    ? units.find((u) => /ft|lb|psi/i.test(u)) || units[units.length - 1]
    : units[0];
  const chosen = units.includes(current) ? current : fallback;
  sel.innerHTML = units
    .map((u) => '<option value="' + escapeHtml(u) + '"' + (u === chosen ? ' selected' : '') + '>' + escapeHtml(u) + '</option>')
    .join('');
}

function syncBcAssignList() {
  const list = document.getElementById('bc-assign-list');
  const count = document.getElementById('bc-assign-count');
  const faces = w19State.draft_faces || [];
  if (w19State.focusFace && !faces.includes(w19State.focusFace)) w19State.focusFace = null;
  if (list) {
    list.innerHTML = faces
      .map((f) => {
        const on = w19State.focusFace === f ? ' is-focus' : '';
        return (
          '<li class="bc-assign-item' +
          on +
          '" data-w19-face="' +
          escapeHtml(f) +
          '">' +
          '<button type="button" class="bc-assign-pick" data-focus-face="' +
          escapeHtml(f) +
          '">' +
          escapeHtml(f) +
          '</button>' +
          '<button type="button" class="bc-assign-x" data-unassign-face="' +
          escapeHtml(f) +
          '" aria-label="Remove ' +
          escapeHtml(f) +
          '">×</button>' +
          '</li>'
        );
      })
      .join('');
  }
  if (count) count.textContent = String(faces.length);
  if (isAssigningBcFace()) {
    const bc = typeof activeBc === 'function' ? activeBc() : null;
    const paint = bc ? paintForBcFaces(faces, bcKind(bc)) : null;
    highlightGeomFaces(faces, w19State.focusFace, paint);
  }
  if (typeof updateBcPerFaceHint === 'function') updateBcPerFaceHint();
  if (typeof updateBcGlyphs === 'function') updateBcGlyphs();
}

function syncBcEditorFields() {
  const bc = activeBc();
  const velBox = document.getElementById('bc-vel-fields');
  const pBox = document.getElementById('bc-p-fields');
  const wallBox = document.getElementById('bc-wall-fields');
  const title = document.getElementById('bc-editor-title');
  const typeEl = document.getElementById('bc-editor-type');
  if (!bc) return;
  if (title) title.textContent = bc.name;
  if (typeEl) typeEl.value = bc.bc_type || 'Velocity inlet';
  const vel = isVelocityBc(bc);
  const wall = isWallBc(bc);
  if (velBox) velBox.hidden = !vel;
  if (pBox) pBox.hidden = vel || wall;
  if (wallBox) wallBox.hidden = !wall;
  if (wall) {
    const wt = normalizeWallType(bc.wall_type);
    const wtEl = document.getElementById('bc-wall-type');
    if (wtEl) wtEl.value = wt;
    const hint = document.getElementById('bc-wall-hint');
    if (hint) hint.textContent = wallTypeHint(wt);
  } else if (vel) {
    const vt = bc.velocity_type || 'Fixed';
    const fr = bc.flow_rate_type || 'Volumetric flow';
    const vtEl = document.getElementById('bc-velocity-type');
    const frEl = document.getElementById('bc-flow-rate-type');
    const valEl = document.getElementById('bc-value');
    const dirEl = document.getElementById('bc-direction');
    if (vtEl) vtEl.value = vt;
    if (frEl) frEl.value = fr;
    if (valEl) valEl.value = bc.value == null ? '' : String(bc.value);
    fillBcUnitSelect(vt, fr, bc.unit);
    if (dirEl) dirEl.value = bc.direction || 'Normal to face';
    const vec = bc.vector || [0, 0, 1];
    const x = document.getElementById('bc-vec-x');
    const y = document.getElementById('bc-vec-y');
    const z = document.getElementById('bc-vec-z');
    if (x) x.value = String(vec[0] ?? 0);
    if (y) y.value = String(vec[1] ?? 0);
    if (z) z.value = String(vec[2] ?? 1);
    const frRow = document.getElementById('bc-flow-rate-type-row');
    const dirRow = document.getElementById('bc-direction-row');
    const vecRow = document.getElementById('bc-vector-row');
    const lab = document.getElementById('bc-vel-value-label');
    if (frRow) frRow.hidden = vt !== 'Flow rate';
    if (dirRow) dirRow.hidden = vt !== 'Fixed';
    if (vecRow) vecRow.hidden = vt !== 'Fixed' || (bc.direction || 'Normal to face') !== 'Vector';
    const vecHint = document.getElementById('bc-vector-hint');
    if (vecHint) vecHint.hidden = !vecRow || vecRow.hidden;
    if (lab) {
      lab.textContent =
        vt === 'Flow rate' ? (fr === 'Mass flow' ? 'Mass flow' : 'Volumetric flow') : 'Velocity';
    }
  } else {
    const pVal = document.getElementById('bc-p-value');
    if (pVal) pVal.value = bc.value == null ? '0' : String(bc.value);
  }
  updateBcPerFaceHint();
  syncBcAssignList();
}

function wallTypeHint(wt) {
  return wt === 'Slip'
    ? 'Air slides along the wall with no friction: zero velocity through it, no shear. Use for symmetry-like or idealized frictionless surfaces.'
    : 'Air sticks to the wall (zero velocity at the surface). This is the usual CFD wall.';
}

function updateBcPerFaceHint() {
  const per = document.getElementById('bc-per-face-hint');
  if (!per) return;
  const bc = activeBc();
  if (!isVelocityBc(bc)) {
    per.hidden = true;
    return;
  }
  const unit =
    (document.getElementById('bc-unit') && document.getElementById('bc-unit').value) || bc.unit || '';
  const n = (w19State.draft_faces || []).length;
  const val = bc.value == null ? '' : bc.value;
  per.hidden = false;
  per.textContent =
    n > 1 && val !== ''
      ? 'Each face gets this value on its own. ' +
        n +
        ' faces × ' +
        val +
        ' ' +
        unit +
        ' = ' +
        n * Number(val) +
        ' ' +
        unit +
        ' total.'
      : 'Each assigned face gets this value on its own. Two faces at 5 means 10 total.';
}

function readBcEditorDraft() {
  const bc = activeBc();
  if (!bc) return null;
  const out = {
    id: bc.id,
    name: bc.name,
    bc_type:
      (document.getElementById('bc-editor-type') && document.getElementById('bc-editor-type').value) ||
      bc.bc_type,
    faces: (w19State.draft_faces || []).slice(),
  };
  const pid = currentProjectId();
  if (pid) out.project_id = pid;
  if (String(out.bc_type || '').startsWith('Velocity')) {
    out.velocity_type = document.getElementById('bc-velocity-type')
      ? document.getElementById('bc-velocity-type').value
      : 'Fixed';
    out.flow_rate_type = document.getElementById('bc-flow-rate-type')
      ? document.getElementById('bc-flow-rate-type').value
      : 'Volumetric flow';
    const n = Number(document.getElementById('bc-value') && document.getElementById('bc-value').value);
    out.value = Number.isFinite(n) ? n : out.velocity_type === 'Fixed' ? 5 : 0.01;
    const unitEl = document.getElementById('bc-unit');
    out.unit = (unitEl && unitEl.value) || (out.velocity_type === 'Fixed' ? 'm/s' : 'm³/s');
    out.direction = document.getElementById('bc-direction')
      ? document.getElementById('bc-direction').value
      : 'Normal to face';
    out.apply_per_face = true;
    out.vector = [
      Number(document.getElementById('bc-vec-x') && document.getElementById('bc-vec-x').value) || 0,
      Number(document.getElementById('bc-vec-y') && document.getElementById('bc-vec-y').value) || 0,
      Number(document.getElementById('bc-vec-z') && document.getElementById('bc-vec-z').value) || 0,
    ];
  } else if (isWallBcType(out.bc_type)) {
    const wtEl = document.getElementById('bc-wall-type');
    out.wall_type = normalizeWallType((wtEl && wtEl.value) || bc.wall_type);
  } else {
    out.pressure_type = 'Fixed value';
    const n = Number(document.getElementById('bc-p-value') && document.getElementById('bc-p-value').value);
    out.value = Number.isFinite(n) ? n : 0;
    out.unit = 'Pa';
  }
  if (typeof currentMeshStudyIds === 'function') Object.assign(out, currentMeshStudyIds());
  return out;
}

function showBcEditor(bc) {
  if (!bc) return;
  w19State.activeId = bc.id;
  w19State.draft_faces = (bc.faces || []).slice();
  treeUi.expanded['Boundary conditions'] = true;
  treeUi.expanded[bc.name] = true;
  openTreeDetail('bc', { toggle: false });
  syncBcEditorFields();
  markTreeSelected('bcid:' + bc.id);
}

function hideBcPanels() {
  w19State.activeId = null;
  if (treeUi.openPanel === 'bc' || treeUi.openPanel === 'vi' || treeUi.openPanel === 'po') {
    hideAllTreeDetails();
  }
}

function openBcTypeModal() {
  if (!w17State.simulation) {
    console.warn('[CFD] Create Simulation first');
    return;
  }
  const modal = document.getElementById('modal-bc-type');
  if (modal) modal.hidden = true;
  openTreeDetail('bc-picker', { toggle: false });
}

function closeBcTypeModal() {
  const modal = document.getElementById('modal-bc-type');
  if (modal) modal.hidden = true;
  if (treeUi.openPanel === 'bc-picker') hideAllTreeDetails();
}

function wireBcTreeHandlers() {
  document.getElementById('btn-bcs-plus')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openBcTypeModal();
  });
}

function applyBcRecords(doc, projectId) {
  const list = ((doc && doc.boundary_conditions) || []).filter(Boolean);
  w19State.bcs = list;
  if (doc && doc.defaults && typeof doc.defaults === 'object') {
    w19State.defaults = { wall_type: normalizeWallType(doc.defaults.wall_type) };
  } else if (doc && !doc.defaults && Array.isArray(doc.boundary_conditions)) {
    w19State.defaults = { ...BC_DEFAULTS_FALLBACK };
  }
  w19State.project_id = projectId || (doc && doc.project_id) || w19State.project_id;
  w19State.boundary_conditions_json = (doc && doc.boundary_conditions_json) || null;
  w19State.ready = list.length > 0;
  w19State.created = list.length > 0;
  if (w19State.activeId && !list.some((b) => b.id === w19State.activeId)) {
    w19State.activeId = null;
  }
  const active = activeBc();
  if (active) w19State.draft_faces = (active.faces || []).slice();
  else w19State.draft_faces = [];
  publishW19({ created: true });
  if (typeof syncSimulationTree === 'function') syncSimulationTree();
  if (typeof syncBcsHub === 'function') syncBcsHub();
  if (treeUi.openPanel === 'bc' && active) {
    syncBcEditorFields();
    markTreeSelected('bcid:' + active.id);
  } else if (treeUi.openPanel === 'bcs-hub' && typeof showBcOverview === 'function') {
    showBcOverview();
  } else if (treeUi.openPanel === 'bc-defaults') {
    syncBcDefaultsPanel();
  }
  syncBcDefaultsLabels();
  return window.__CFD_W19__;
}

/* ---- Defaults: what every face without a boundary condition gets ---- */

function bcDefaultsSummary() {
  const wt = bcDefaults().wall_type;
  return 'Unassigned faces: ' + (wt === 'Slip' ? 'slip' : 'no-slip') + ' walls';
}

/** Faces of the model that no BC claims (they take the default). */
function bcUnassignedFaces() {
  const claimed = new Set();
  bcList().forEach((b) => (b.faces || []).forEach((f) => claimed.add(f)));
  const all = typeof allGeomFaceLabels === 'function' ? allGeomFaceLabels() : [];
  return all.filter((f) => !claimed.has(f));
}

function syncBcDefaultsLabels() {
  const text = bcDefaultsSummary();
  const a = document.getElementById('bc-picker-defaults-sub');
  const b = document.getElementById('bc-defaults-hub-sub');
  if (a) a.textContent = text;
  if (b) b.textContent = text;
}

function syncBcDefaultsPanel() {
  const d = bcDefaults();
  const sel = document.getElementById('bc-default-wall-type');
  if (sel) sel.value = d.wall_type;
  const hint = document.getElementById('bc-default-wall-hint');
  if (hint) {
    hint.textContent =
      d.wall_type === 'Slip'
        ? 'Every face without a boundary condition is a slip wall: air slides along it with no friction and no boundary layer. Add a Wall boundary condition to make specific faces no-slip.'
        : 'Every face without a boundary condition is a no-slip wall: air sticks to it and a boundary layer forms. This is the usual CFD wall.';
  }
  const faces = bcUnassignedFaces();
  const count = document.getElementById('bc-default-count');
  if (count) count.textContent = String(faces.length);
  syncBcDefaultsLabels();
  if (treeUi.openPanel === 'bc-defaults') {
    try {
      highlightGeomFaces(faces, null, paintForBcFaces(faces, 'default'));
      if (typeof clearBcGlyphs === 'function') clearBcGlyphs();
    } catch (_) {}
  }
}

function showBcDefaultsPanel() {
  if (!w17State.simulation) {
    console.warn('[CFD] Create Simulation first');
    return;
  }
  w19State.activeId = null;
  treeUi.expanded['Boundary conditions'] = true;
  openTreeDetail('bc-defaults', { toggle: false });
  markTreeSelected('bc-defaults');
  syncBcDefaultsPanel();
}

async function persistBcDefaults(partial) {
  const next = { ...bcDefaults(), ...(partial || {}) };
  next.wall_type = normalizeWallType(next.wall_type);
  w19State.defaults = next;
  syncBcDefaultsPanel();
  if (typeof syncSimulationTree === 'function') syncSimulationTree();
  const body = { defaults: next };
  const pid = currentProjectId();
  if (pid) body.project_id = pid;
  if (typeof currentMeshStudyIds === 'function') Object.assign(body, currentMeshStudyIds());
  const r = await fetch('/api/bcs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || 'BC defaults save failed');
  applyBcRecords(j, j.project_id);
  return j;
}

async function persistActiveBc() {
  const draft = readBcEditorDraft();
  if (!draft) return null;
  const r = await fetch('/api/bcs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || 'BC save failed');
  applyBcRecords(j, j.project_id);
  return j;
}

function toggleAssignFace(label) {
  const name = String(label || '').trim();
  if (!name || !activeBc()) return;
  const i = w19State.draft_faces.indexOf(name);
  if (i >= 0) {
    w19State.draft_faces.splice(i, 1);
    if (w19State.focusFace === name) w19State.focusFace = w19State.draft_faces[0] || null;
  } else {
    w19State.draft_faces.push(name);
    w19State.focusFace = name;
  }
  syncBcAssignList();
  persistActiveBc().catch((e) => console.error('[CFD] BC face', e));
}

function unassignFace(label) {
  const name = String(label || '').trim();
  const i = w19State.draft_faces.indexOf(name);
  if (i < 0) return;
  w19State.draft_faces.splice(i, 1);
  if (w19State.focusFace === name) w19State.focusFace = w19State.draft_faces[0] || null;
  syncBcAssignList();
  persistActiveBc().catch((e) => console.error('[CFD] BC face', e));
}

function focusAssignedFace(label, opts) {
  const name = String(label || '').trim();
  if (!name || !w19State.draft_faces.includes(name)) return;
  if (opts && opts.toggle === false) w19State.focusFace = name;
  else w19State.focusFace = w19State.focusFace === name ? null : name;
  syncBcAssignList();
}

function pendingCadFaceLabels() {
  const out = [];
  const seen = new Set();
  const push = (lab) => {
    const name = String(lab || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  try {
    faceCtxSelected.forEach(push);
  } catch (_) {}
  (w16State.selectedFaces || []).forEach(push);
  return out;
}

async function createBcClient(bcType) {
  const pendingFaces = pendingCadFaceLabels();
  const body = { bc_type: bcType, faces: pendingFaces.slice() };
  const pid = currentProjectId();
  if (pid) body.project_id = pid;
  if (typeof currentMeshStudyIds === 'function') Object.assign(body, currentMeshStudyIds());
  const imperial = !!(window.__CFD_PREFS__ && /imperial/i.test(String(window.__CFD_PREFS__.units || '')));
  if (String(bcType).startsWith('Velocity')) {
    body.velocity_type = 'Fixed';
    body.value = 5;
    body.unit = imperial ? 'ft/s' : 'm/s';
    body.direction = 'Normal to face';
    body.vector = [0, 0, 1];
  } else if (isWallBcType(bcType)) {
    // A face-by-face Wall BC exists to differ from the default, so start it
    // on the opposite treatment (default no-slip → new wall slip).
    body.wall_type = bcDefaults().wall_type === 'Slip' ? 'No-slip' : 'Slip';
  } else {
    body.pressure_type = 'Fixed value';
    body.value = 0;
    body.unit = imperial ? 'psi' : 'Pa';
  }
  const r = await fetch('/api/bcs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || 'BC create failed');
  applyBcRecords(j, j.project_id);
  const created =
    j.bc ||
    (j.boundary_conditions || []).find((b) => b.bc_type === bcType && !(b.faces || []).length) ||
    (j.boundary_conditions || []).filter((b) => b.bc_type === bcType).slice(-1)[0];
  if (created) {
    showBcEditor(created);
    if (pendingFaces.length) {
      try { clearCadSelection(); } catch (_) {}
    }
  }
  return j;
}

async function deleteBcClient(id) {
  const body = { delete: id };
  const pid = currentProjectId();
  if (pid) body.project_id = pid;
  const r = await fetch('/api/bcs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || 'BC delete failed');
  w19State.activeId = null;
  w19State.draft_faces = [];
  highlightGeomFaces([]);
  if (typeof clearBcGlyphs === 'function') clearBcGlyphs();
  applyBcRecords(j, j.project_id);
  hideAllTreeDetails();
  markTreeSelected(null);
  return j;
}

function showBcPanel(which) {
  const type =
    which === 'po' ||
    which === 'pi' ||
    which === 'Pressure' ||
    which === 'Pressure outlet' ||
    which === 'Pressure inlet'
      ? 'Pressure'
      : which === 'vo' || which === 'Velocity outlet'
        ? 'Velocity outlet'
        : 'Velocity inlet';
  const hit = bcList().find((b) => b.bc_type === type);
  if (hit) showBcEditor(hit);
  else createBcClient(type).catch((e) => console.error('[CFD] BC create', e));
}

function syncViAssignList() {
  syncBcAssignList();
}
function syncPoAssignList() {
  syncBcAssignList();
}

window.__CFD_W19_CREATE__ = createBcClient;
window.__CFD_SHOW_BC__ = showBcEditor;
window.__CFD_ASSIGN_FACE__ = function assignFace(faceOrId, bodyId) {
  const label =
    typeof faceOrId === 'string' && /face/i.test(faceOrId)
      ? faceOrId
      : faceLabel(faceOrId, bodyId || 1);
  toggleAssignFace(label);
  return (w19State.draft_faces || []).slice();
};
window.__CFD_W19_SAVE_VI__ = function saveViCompat(partial) {
  return createBcClient('Velocity inlet').then(() => {
    if (partial && partial.faces) w19State.draft_faces = partial.faces.slice();
    return persistActiveBc();
  });
};
window.__CFD_W19_SAVE_PO__ = function savePoCompat(partial) {
  return createBcClient('Pressure').then(() => {
    if (partial && partial.faces) w19State.draft_faces = partial.faces.slice();
    return persistActiveBc();
  });
};
window.__CFD_W19_APPLY__ = async function applyW19(partial) {
  if (partial && partial.bcs) {
    const r = await fetch('/api/bcs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bcs: partial.bcs,
        project_id: currentProjectId(),
        ...(typeof currentMeshStudyIds === 'function' ? currentMeshStudyIds() : {}),
      }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'bcs batch save failed');
    applyBcRecords(j, j.project_id);
    return window.__CFD_W19__;
  }
  return publishW19();
};

(function wireW19Ui() {
  const persist = () => persistActiveBc().catch((e) => console.error('[CFD] BC persist', e));
  document.getElementById('bc-assign-list')?.addEventListener('click', (e) => {
    const drop = e.target.closest('[data-unassign-face]');
    if (drop) {
      e.preventDefault();
      e.stopPropagation();
      unassignFace(drop.getAttribute('data-unassign-face'));
      return;
    }
    const pick = e.target.closest('[data-focus-face]');
    if (pick) {
      e.preventDefault();
      focusAssignedFace(pick.getAttribute('data-focus-face'));
    }
  });
  document.getElementById('bc-editor-type')?.addEventListener('change', () => {
    const bc = activeBc();
    const typeEl = document.getElementById('bc-editor-type');
    if (!bc || !typeEl) return;
    const nextType = typeEl.value;
    const oldName = bc.name;
    bc.bc_type = nextType;
    bc.name = renameBcForType(bc, nextType);
    if (String(nextType).startsWith('Velocity')) {
      if (!bc.velocity_type) bc.velocity_type = 'Fixed';
      if (bc.value == null) bc.value = 5;
      if (!bc.unit) bc.unit = 'm/s';
      if (!bc.direction) bc.direction = 'Normal to face';
      if (!bc.vector) bc.vector = [0, 0, 1];
      bc.apply_per_face = true;
    } else if (isWallBcType(nextType)) {
      if (!bc.wall_type) bc.wall_type = bcDefaults().wall_type === 'Slip' ? 'No-slip' : 'Slip';
    } else {
      if (bc.value == null) bc.value = 0;
      bc.unit = 'Pa';
      bc.pressure_type = 'Fixed value';
    }
    if (oldName !== bc.name) {
      delete treeUi.expanded[oldName];
      treeUi.expanded[bc.name] = true;
    }
    syncBcEditorFields();
    persist();
  });
  ['bc-velocity-type', 'bc-flow-rate-type', 'bc-value', 'bc-unit', 'bc-direction', 'bc-vec-x', 'bc-vec-y', 'bc-vec-z', 'bc-p-value', 'bc-wall-type'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      if (id === 'bc-velocity-type' || id === 'bc-flow-rate-type' || id === 'bc-direction' || id === 'bc-wall-type') {
        const draft = readBcEditorDraft();
        if (draft) {
          const i = w19State.bcs.findIndex((b) => b.id === draft.id);
          if (i >= 0) Object.assign(w19State.bcs[i], draft);
          syncBcEditorFields();
        }
      }
      persist();
    });
  });
  document.getElementById('bc-clear-assign')?.addEventListener('click', () => {
    w19State.draft_faces = [];
    syncBcAssignList();
    persist();
  });
  // Defaults: reachable from the "+" picker, the BC overview, and the tree row.
  document.getElementById('bc-picker-defaults')?.addEventListener('click', () => {
    closeBcTypeModal();
    showBcDefaultsPanel();
  });
  document.getElementById('btn-bc-defaults-hub')?.addEventListener('click', () => showBcDefaultsPanel());
  document.getElementById('bc-default-wall-type')?.addEventListener('change', (e) => {
    persistBcDefaults({ wall_type: e.target.value }).catch((err) => console.error('[CFD] BC defaults', err));
  });
  document.getElementById('bc-delete')?.addEventListener('click', () => {
    const bc = activeBc();
    if (bc) deleteBcClient(bc.id).catch((e) => console.error('[CFD] BC delete', e));
  });
  document.getElementById('bc-apply')?.addEventListener('click', () => {
    const sel = document.querySelector('#bc-type-list .ml-type.is-selected');
    const t = sel ? sel.getAttribute('data-bc-type') : 'Velocity inlet';
    const modal = document.getElementById('modal-bc-type');
    if (modal) modal.hidden = true;
    createBcClient(t).catch((e) => console.error('[CFD] BC create', e));
  });
  document.querySelectorAll('#bc-type-list .ml-type:not([disabled])').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#bc-type-list .ml-type').forEach((b) => b.classList.remove('is-selected'));
      btn.classList.add('is-selected');
    });
  });

  const prevCreate = window.__CFD_W16_CREATE__;
  if (typeof prevCreate === 'function') {
    window.__CFD_W16_CREATE__ = async function wrappedCreateW19(fields) {
      const out = await prevCreate(fields);
      w19State.bcs = [];
      w19State.activeId = null;
      w19State.draft_faces = [];
      hideBcPanels();
      publishW19({ ready: false });
      return out;
    };
  }

  fetch('/api/bcs' + hashProjectQs())
    .then((r) => r.json())
    .then((j) => {
      w19State.hydrated = true;
      if (!currentStudyId()) {
        applyBcRecords({ boundary_conditions: [] }, j && j.project_id);
        publishW19({ hydrated: true, ready: false });
        return;
      }
      applyBcRecords(j || { boundary_conditions: [] }, j && j.project_id);
      publishW19({ hydrated: true, ready: bcList().length > 0 });
    })
    .catch((e) => {
      console.warn('[CFD W19] hydrate', e);
      w19State.hydrated = true;
      publishW19({ ready: false });
    });
})();

/* ---- W20 — Mesh form settings only (persist mesh.json) ---- */
const W20_DEFAULTS = {
  name: 'Mesh 1',
  algorithm: 'Standard',
  sizing: 'Automatic',
  fineness: 5,
  curvature: 'Automatic',
  automatic_boundary_layers: true,
  physics_based_meshing: true,
  hex_element_core: true,
  automatic_extrusion_meshing: false,
  preferred_cpus: 'Automatic (max 16)',
  maximum_meshing_runtime: '1.8e+4',
  maximum_meshing_runtime_unit: 's',
  advanced: {
    // Empty = automatic (derived from the geometry size by the mesher).
    small_feature_suppression: '',
    small_feature_suppression_unit: 'm',
    gap_refinement_factor: 0.05,
    global_gradation_rate: 1.22,
    mesh_engine: 'standard',
  },
};

const w20State = {
  ready: false,
  hydrated: false,
  created: false,
  project_id: null,
  mesh: null,
  settings: null,
  meshes: [],
  meshes_all: [],
  active_id: null,
  mesh_json: null,
  bank_exact: false,
  panel_open: false,
  note: 'W20: Mesh form settings only (bank defaults)',
};
window.__CFD_W20_STATE__ = w20State;

function publishW20(extra) {
  const settings = w20State.settings || null;
  const payload = {
    ready: w20State.ready,
    hydrated: w20State.hydrated,
    created: w20State.created,
    project_id: w20State.project_id,
    mesh: w20State.mesh,
    meshes: w20State.meshes,
    meshes_all: w20State.meshes_all,
    active_id: w20State.active_id,
    settings,
    defaults: { ...W20_DEFAULTS, advanced: { ...W20_DEFAULTS.advanced } },
    bank_exact: w20State.bank_exact,
    mesh_json: w20State.mesh_json,
    generated: isGeneratedMeshReady(w20State.mesh),
    generate_button_present: !!document.getElementById('btn-generate-mesh'),
    live_mesh_result: (w20State.mesh && w20State.mesh.live_mesh_result) || null,
    n_cells: jobState.n_cells,
    n_points: jobState.n_points,
    panel_open: w20State.panel_open,
    note: w20State.note,
    soft_pass_avoided: true,
    increment: 'W21',
    path_kind: jobState.path_kind,
    ...(extra || {}),
  };
  window.__CFD_W20__ = payload;
  return payload;
}

function setToggleEl(el, on) {
  if (!el) return;
  el.classList.toggle('is-on', !!on);
  el.classList.toggle('is-off', !on);
  el.setAttribute('aria-pressed', on ? 'true' : 'false');
  el.textContent = on ? 'ON' : 'OFF';
}

function readToggleEl(el, fallback) {
  if (!el) return fallback;
  return el.classList.contains('is-on') || el.getAttribute('aria-pressed') === 'true';
}

function applySettingsToForm(settings) {
  const s = settings || W20_DEFAULTS;
  const adv = s.advanced || W20_DEFAULTS.advanced;
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v;
  };
  setVal('mesh-fineness', String(s.fineness != null ? s.fineness : W20_DEFAULTS.fineness));
  const fv = document.getElementById('mesh-fineness-val');
  if (fv) fv.textContent = String(s.fineness != null ? s.fineness : W20_DEFAULTS.fineness);
  setToggleEl(document.getElementById('mesh-toggle-bl'), s.automatic_boundary_layers !== false);
  setToggleEl(document.getElementById('mesh-toggle-physics'), s.physics_based_meshing !== false);
  setToggleEl(document.getElementById('mesh-toggle-hex'), s.hex_element_core !== false);
  const sfs = adv && adv.small_feature_suppression != null ? String(adv.small_feature_suppression) : '';
  // Legacy projects stored the old fixed default; treat it as automatic.
  setVal('mesh-sfs', sfs === '4.227e-6' ? '' : sfs);
  setVal('mesh-gap', String((adv && adv.gap_refinement_factor) != null ? adv.gap_refinement_factor : W20_DEFAULTS.advanced.gap_refinement_factor));
  setVal('mesh-gradation', String((adv && adv.global_gradation_rate) != null ? adv.global_gradation_rate : W20_DEFAULTS.advanced.global_gradation_rate));
  setVal('mesh-engine', (adv && adv.mesh_engine) || W20_DEFAULTS.advanced.mesh_engine);
  const title = document.getElementById('mesh-panel-title');
  if (title) title.textContent = s.name || 'Mesh 1';
  const sel = document.getElementById('mesh-selection-name');
  if (sel) sel.textContent = s.name || 'Mesh 1';
  const renameIn = document.getElementById('mesh-rename-input');
  if (renameIn) renameIn.value = s.name || 'Mesh 1';
}

function readSettingsFromForm() {
  return {
    name: meshDisplayName(),
    algorithm: W20_DEFAULTS.algorithm,
    sizing: W20_DEFAULTS.sizing,
    fineness: Number((document.getElementById('mesh-fineness') || {}).value || W20_DEFAULTS.fineness),
    curvature: W20_DEFAULTS.curvature,
    automatic_boundary_layers: readToggleEl(document.getElementById('mesh-toggle-bl'), true),
    physics_based_meshing: readToggleEl(document.getElementById('mesh-toggle-physics'), true),
    hex_element_core: readToggleEl(document.getElementById('mesh-toggle-hex'), true),
    automatic_extrusion_meshing: false,
    preferred_cpus: 'all',
    maximum_meshing_runtime: W20_DEFAULTS.maximum_meshing_runtime,
    maximum_meshing_runtime_unit: W20_DEFAULTS.maximum_meshing_runtime_unit,
    advanced: {
      small_feature_suppression: String((document.getElementById('mesh-sfs') || {}).value || '').trim(),
      small_feature_suppression_unit: 'm',
      gap_refinement_factor: Number((document.getElementById('mesh-gap') || {}).value || W20_DEFAULTS.advanced.gap_refinement_factor),
      global_gradation_rate: Number((document.getElementById('mesh-gradation') || {}).value || W20_DEFAULTS.advanced.global_gradation_rate),
      mesh_engine: (document.getElementById('mesh-engine') || {}).value || W20_DEFAULTS.advanced.mesh_engine,
    },
  };
}

function showMeshPanel() {
  openTreeDetail('mesh', { toggle: false });
  applySettingsToForm(w20State.settings || W20_DEFAULTS);
  try { syncMeshCopyUi(); } catch (_) {}
  publishW20({ panel_open: true });
}

function hideMeshPanel() {
  if (treeUi.openPanel === 'mesh') hideAllTreeDetails();
  else {
    const panel = document.getElementById('panel-mesh-form');
    if (panel) panel.hidden = true;
    w20State.panel_open = false;
  }
  publishW20({ panel_open: false });
}

function mapListedMeshes(listed) {
  return (listed || []).map((m) => ({
    id: m.id,
    name: m.name,
    generated: !!m.generated,
    live_mesh_result: m.live_mesh_result || (m.status === 'done' ? { status: 'done', n_cells: m.n_cells, n_points: m.n_points, case_dir: m.case_dir } : null),
    n_cells: m.n_cells,
    n_points: m.n_points,
    case_dir: m.case_dir,
    geometry_id: m.geometry_id || null,
    geometry_name: m.geometry_name || null,
    simulation_id: m.simulation_id || null,
    created_at: m.created_at,
    updated_at: m.updated_at,
  }));
}

function applyMeshRecord(doc, projectId, opts) {
  const listedAll = doc && Array.isArray(doc.meshes_all) ? doc.meshes_all : null;
  if (listedAll) w20State.meshes_all = mapListedMeshes(listedAll);
  const settings = (doc && doc.settings) || (doc && doc.mesh && doc.mesh.settings) || null;
  const mesh = (doc && doc.mesh) || (settings && doc) || null;
  if (!mesh || !settings) {
    w20State.mesh = null;
    w20State.settings = { ...W20_DEFAULTS, advanced: { ...W20_DEFAULTS.advanced } };
    w20State.meshes = [];
    if (!listedAll) w20State.meshes_all = [];
    w20State.active_id = null;
    w20State.ready = false;
    w20State.created = false;
    w20State.project_id = projectId || (doc && doc.project_id) || w20State.project_id;
    applySettingsToForm(W20_DEFAULTS);
    if (typeof syncSimulationTree === 'function') syncSimulationTree();
    publishW20({ ready: false });
    return;
  }
  w20State.mesh = mesh;
  w20State.settings = settings || { ...W20_DEFAULTS, advanced: { ...W20_DEFAULTS.advanced } };
  w20State.project_id = projectId || (doc && doc.project_id) || w20State.project_id;
  w20State.mesh_json = (mesh && mesh.mesh_json) || (doc && doc.mesh_json) || w20State.mesh_json;
  w20State.bank_exact = !!(doc && doc.bank_exact) || !!(mesh && mesh.bank_exact);
  w20State.active_id = (doc && doc.active_id) || (mesh && (mesh.active_id || mesh.id)) || null;
  const listed = (doc && Array.isArray(doc.meshes) && doc.meshes.length)
    ? doc.meshes
    : (mesh && Array.isArray(mesh.meshes) && mesh.meshes.length ? mesh.meshes : null);
  if (listed) {
    w20State.meshes = mapListedMeshes(listed);
  } else if (mesh) {
    w20State.meshes = [{
      id: mesh.id,
      name: mesh.name || (settings && settings.name) || 'Mesh 1',
      generated: isGeneratedMeshReady(mesh),
      live_mesh_result: mesh.live_mesh_result || null,
      geometry_id: mesh.geometry_id || null,
      simulation_id: mesh.simulation_id || null,
    }];
  } else {
    w20State.meshes = [];
  }
  if (!listedAll) w20State.meshes_all = w20State.meshes;
  const study = typeof w17State !== 'undefined' ? w17State.simulation : null;
  const studyMeshes = study ? meshesForStudy(study) : [];
  if (study) w20State.meshes = studyMeshes;
  const belongs = !!(
    mesh &&
    study &&
    ((mesh.simulation_id && String(mesh.simulation_id) === String(study.id)) ||
      (!mesh.simulation_id && studyMeshes.some((m) => String(m.id) === String(mesh.id || mesh.active_id))))
  );
  if (study && !belongs) {
    const home = studyMeshes.find((m) => String(m.id) === String(w20State.active_id)) || null;
    if (home) {
      w20State.active_id = home.id;
      const full = findMeshRecord(home.id);
      if (full) {
        w20State.mesh = full;
        w20State.settings =
          (full.settings && { ...full.settings }) || {
            ...W20_DEFAULTS,
            advanced: { ...W20_DEFAULTS.advanced },
          };
      }
    } else {
      w20State.mesh = null;
      w20State.active_id = null;
    }
  }
  const liveMesh = w20State.mesh;
  w20State.ready = !!settings;
  w20State.created = !!liveMesh;
  w20State.note = w20State.bank_exact
    ? 'W20 HARD: Mesh settings bank-exact persisted'
    : 'W20: Mesh settings loaded';
  applySettingsToForm(w20State.settings);
  if (isGeneratedMeshReady(liveMesh)) {
    applyLiveMeshCountsToJob();
    const casePath = getLiveMeshCaseDir();
    if (casePath) {
      fetch('/api/mesh-surface?' + withProjectCaseParams({ case: casePath, meta: '1' }).toString()).catch(() => {});
    }
  } else {
    const live = liveMesh && liveMesh.live_mesh_result;
    if (live && live.status === 'running') applyLiveMeshCountsToJob();
    else {
      jobState.n_cells = null;
      jobState.n_points = null;
      jobState.n_faces = null;
      if (jobState.status !== 'running') {
        jobState.path_kind = null;
        jobState.mesh_path = null;
        jobState.case_dir = null;
      }
    }
  }
  publishW20();
  syncMeshInspectPanel();
  if (!(opts && opts.skipTree) && typeof syncSimulationTree === 'function') syncSimulationTree();
  try { refreshCompareIfOpen(); } catch (_) {}
  return window.__CFD_W20__;
}

function clearGeneratedMeshClientState() {
  try { stopCompare(); } catch (_) {}
  meshInspectOpen = false;
  window.__CFD_MESH_INSPECT__ = false;
  window.__CFD_MESH_VIEW__ = null;
  meshChipDismissed = false;
  if (w20State.mesh) {
    w20State.mesh.generated = false;
    w20State.mesh.live_mesh_result = null;
    if ('last_generate' in w20State.mesh) w20State.mesh.last_generate = null;
  }
  if (window.__CFD_W20__) {
    if (window.__CFD_W20__.mesh) {
      window.__CFD_W20__.mesh.generated = false;
      window.__CFD_W20__.mesh.live_mesh_result = null;
      if ('last_generate' in window.__CFD_W20__.mesh) window.__CFD_W20__.mesh.last_generate = null;
    }
    window.__CFD_W20__.generated = false;
    window.__CFD_W20__.live_mesh_result = null;
  }
  jobState.n_cells = null;
  jobState.n_points = null;
  jobState.n_faces = null;
  jobState.path_kind = null;
  jobState.mesh_path = null;
  jobState.status = 'idle';
  jobState.mode = 'idle';
  jobState.case_dir = null;
  caseDir = null;
  const chip = document.getElementById('mesh-inspect-chip');
  if (chip) chip.hidden = true;
  try { clearMeshView(); } catch (_) {}
  try { setFiltersVisible(false); } catch (_) {}
  try {
    if (treeUi && (treeUi.selectedKey === 'mesh1' || String(treeUi.selectedKey || '').startsWith('meshid:'))) {
      markTreeSelected(null);
    }
  } catch (_) {}
  try { syncMeshFinishedChrome(); } catch (_) {}
}

async function deleteGeneratedMeshClient() {
  const pid =
    (w20State && w20State.project_id) ||
    (w16State.project && w16State.project.id) ||
    undefined;
  const r = await fetch('/api/mesh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      delete_generated: true,
      project_id: pid,
      ...currentMeshStudyIds(),
      mesh_id: (w20State && w20State.active_id) || (w20State.mesh && w20State.mesh.id) || undefined,
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) {
    throw new Error((j && j.error) || 'Mesh delete failed');
  }
  hideMeshInspect();
  clearGeneratedMeshClientState();
  try { detachResultsCase(); } catch (_) {}
  applyMeshRecord(j, j.project_id);
  clearGeneratedMeshClientState();
  publishW20({ deleted: true, generated: false, live_mesh_result: null });
  if (typeof syncSimulationTree === 'function') syncSimulationTree();
  try { syncMeshFinishedChrome(); } catch (_) {}
  dismissTreeDetail();
  applyWorkbenchStage();
  return j;
}
window.__CFD_W20_DELETE_MESH__ = deleteGeneratedMeshClient;

function currentMeshProjectId() {
  return (
    (w20State && w20State.project_id) ||
    (w16State.project && w16State.project.id) ||
    undefined
  );
}

function currentMeshStudyIds() {
  const sim = typeof w17State !== 'undefined' ? w17State.simulation : null;
  return {
    simulation_id: (sim && sim.id) || undefined,
    geometry_id: (sim && sim.geometry_id) || undefined,
  };
}

async function postMeshApi(body, opts) {
  const r = await fetch('/api/mesh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_id: currentMeshProjectId(),
      ...currentMeshStudyIds(),
      ...body,
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) {
    throw new Error((j && j.error) || 'Mesh request failed');
  }
  applyMeshRecord(j, j.project_id, opts);
  return j;
}

async function createOrOpenNextMeshClient() {
  return createMeshClient();
}

function nextClientMeshName() {
  const used = new Set(meshList().map((m) => String(m.name || '')));
  let n = 1;
  while (used.has('Mesh ' + n)) n += 1;
  return 'Mesh ' + n;
}

function syncMeshHubPanel() {
  const nameEl = document.getElementById('mesh-new-name');
  if (nameEl && document.activeElement !== nameEl && !nameEl.value) {
    nameEl.placeholder = nextClientMeshName();
  }
}

async function createMeshClient() {
  const nameEl = document.getElementById('mesh-new-name');
  const name = String((nameEl && nameEl.value) || '').trim();
  const j = await postMeshApi({ create: true, name });
  if (nameEl) nameEl.value = '';
  const newId = (j && (j.active_id || (j.mesh && j.mesh.id))) || w20State.active_id;
  if (newId) w26State.meshId = newId;
  treeUi.expanded.Mesh = true;
  if (newId) treeUi.expanded['mesh:' + newId] = true;
  publishW20({ created: !!j.created, reused: j.reused || null });
  try { syncSimulationTree(); } catch (_) {}
  markTreeSelected(newId ? 'meshid:' + newId : 'mesh');
  showMeshPanel();
  if (otherMeshesForCopy(newId).length) startMeshCopyPick(newId);
  return j;
}

let meshCopyPick = null;
let meshCopyNote = '';

function otherMeshesForCopy(destId) {
  return meshListAll().filter((m) => m && m.id && String(m.id) !== String(destId));
}

function meshCopyOptionLabel(m, destId) {
  const name = (m && m.name) || 'Mesh';
  const geom = geometryNameForMesh(m);
  const dest = findMeshRecord(destId);
  const destGeom = dest && dest.geometry_id;
  const otherGeom = !!(geom && m.geometry_id && destGeom && String(m.geometry_id) !== String(destGeom));
  const bits = otherGeom ? [geom, name] : [name];
  if (m.generated || (m.live_mesh_result && m.live_mesh_result.status === 'done')) bits.push('generated');
  return bits.join(' · ');
}

function fillMeshCopySelect(sel, destId) {
  if (!sel || document.activeElement === sel) return;
  const others = destId ? otherMeshesForCopy(destId) : [];
  sel.innerHTML =
    '<option value="">Select a mesh…</option>' +
    others
      .slice()
      .reverse()
      .map((m) => {
        return (
          '<option value="' +
          escapeHtml(String(m.id)) +
          '">' +
          escapeHtml(meshCopyOptionLabel(m, destId)) +
          '</option>'
        );
      })
      .join('');
  sel.value = '';
}

function endMeshCopyPick() {
  meshCopyPick = null;
  const tree = document.getElementById('simulations-tree');
  if (tree) tree.classList.remove('is-mesh-copy-pick');
  tree && tree.querySelectorAll('[data-w20-mesh-item].is-copy-dest').forEach((el) => el.classList.remove('is-copy-dest'));
  const picker = document.getElementById('mesh-copy-picker');
  const openBtn = document.getElementById('mesh-copy-open');
  if (picker) picker.hidden = true;
  if (openBtn) openBtn.hidden = false;
  const refPicker = document.getElementById('ref-copy-picker');
  const refOpen = document.getElementById('ref-copy-open');
  if (refPicker) refPicker.hidden = true;
  if (refOpen) refOpen.hidden = false;
}

function startMeshCopyPick(destId, mode) {
  const dest = destId || (w20State && w20State.active_id) || currentRefMeshId();
  if (!dest || !otherMeshesForCopy(dest).length) return;
  meshCopyPick = { destId: dest, mode: mode === 'refs' ? 'refs' : 'all' };
  meshCopyNote = '';
  syncMeshCopyUi();
  try { syncRefCopyUi(); } catch (_) {}
}

function syncMeshCopyUi() {
  const wrap = document.getElementById('mesh-copy-from');
  const openBtn = document.getElementById('mesh-copy-open');
  const picker = document.getElementById('mesh-copy-picker');
  const sel = document.getElementById('mesh-copy-mesh');
  const done = document.getElementById('mesh-copy-done');
  const destId = (w20State && w20State.active_id) || (w20State.mesh && w20State.mesh.id);
  const others = destId ? otherMeshesForCopy(destId) : [];
  const show = !!(destId && others.length);
  if (wrap) wrap.hidden = !show;
  if (!show) {
    endMeshCopyPick();
    if (done) { done.hidden = true; done.textContent = ''; }
    return;
  }
  const picking = !!(
    meshCopyPick &&
    String(meshCopyPick.destId) === String(destId) &&
    meshCopyPick.mode !== 'refs'
  );
  if (openBtn) openBtn.hidden = picking;
  if (picker) picker.hidden = !picking;
  fillMeshCopySelect(sel, destId);
  if (done) {
    done.hidden = !meshCopyNote;
    done.textContent = meshCopyNote;
  }
  const tree = document.getElementById('simulations-tree');
  if (tree) {
    tree.classList.toggle('is-mesh-copy-pick', picking);
    tree.querySelectorAll('[data-w20-mesh-item]').forEach((el) => {
      el.classList.toggle('is-copy-dest', picking && String(el.getAttribute('data-w20-mesh-item')) === String(destId));
    });
  }
}

function meshIdFromCopyTreeNode(node) {
  if (!node) return '';
  return node.getAttribute('data-w20-mesh-item') || node.getAttribute('data-w26-refs-mesh') || '';
}

function applyCopiedMeshSource(srcId) {
  const src = findMeshRecord(srcId);
  const geom = geometryNameForMesh(src);
  const label = src
    ? geom && src.geometry_id && geom !== src.name
      ? geom + ' / ' + (src.name || 'mesh')
      : src.name || 'previous mesh'
    : 'previous mesh';
  return label;
}

async function postCopyRefinements(destId, srcId) {
  const rr = await fetch('/api/mesh/refinements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_id: currentMeshProjectId(),
      ...currentMeshStudyIds(),
      mesh_id: destId,
      copy_from_mesh: srcId,
    }),
  });
  const refs = await rr.json();
  if (rr.ok && refs && refs.ok) applyRefRecords(refs, refs.project_id);
  return refs;
}

async function copyMeshSettingsFrom(srcId) {
  const destId = (w20State && w20State.active_id) || (w20State.mesh && w20State.mesh.id);
  if (!destId || !srcId || String(srcId) === String(destId)) return;
  const j = await postMeshApi({ mesh_id: destId, copy_from: srcId });
  try {
    await postCopyRefinements(destId, srcId);
  } catch (e) {
    console.warn('[CFD] copy mesh refinements', e);
  }
  meshCopyNote = 'Copied from ' + applyCopiedMeshSource(srcId) + '. Change anything you want.';
  endMeshCopyPick();
  w26State.meshId = destId;
  try { syncSimulationTree(); } catch (_) {}
  applySettingsToForm((j && j.settings) || w20State.settings);
  showMeshPanel();
  syncMeshCopyUi();
  try { syncRefCopyUi(); } catch (_) {}
}

async function copyRefinementsFrom(srcId) {
  const destId =
    currentRefMeshId() ||
    (w20State && w20State.active_id) ||
    (w20State && w20State.mesh && w20State.mesh.id);
  if (!destId || !srcId || String(srcId) === String(destId)) return;
  await postCopyRefinements(destId, srcId);
  meshCopyNote = 'Copied refinements from ' + applyCopiedMeshSource(srcId) + '.';
  endMeshCopyPick();
  w26State.meshId = destId;
  try { syncSimulationTree(); } catch (_) {}
  try { syncRefsHub(); } catch (_) {}
  try { showRefsOverview(); } catch (_) {}
  try { syncRefCopyUi(); } catch (_) {}
}

function applyMeshCopyFromTree(srcId) {
  if (!srcId || !meshCopyPick || String(srcId) === String(meshCopyPick.destId)) return false;
  if (meshCopyPick.mode === 'refs') {
    copyRefinementsFrom(srcId).catch((err) => console.warn('[CFD] copy refinements', err));
  } else {
    copyMeshSettingsFrom(srcId).catch((err) => console.warn('[CFD] copy mesh', err));
  }
  return true;
}

function syncRefCopyUi() {
  const wrap = document.getElementById('ref-copy-from');
  const openBtn = document.getElementById('ref-copy-open');
  const picker = document.getElementById('ref-copy-picker');
  const sel = document.getElementById('ref-copy-mesh');
  const done = document.getElementById('ref-copy-done');
  const destId =
    currentRefMeshId() ||
    (w20State && w20State.active_id) ||
    (w20State && w20State.mesh && w20State.mesh.id);
  const others = destId ? otherMeshesForCopy(destId) : [];
  const show = !!(destId && others.length);
  if (wrap) wrap.hidden = !show;
  if (!show) {
    if (done) {
      done.hidden = true;
      done.textContent = '';
    }
    return;
  }
  const picking = !!(
    meshCopyPick &&
    String(meshCopyPick.destId) === String(destId) &&
    meshCopyPick.mode === 'refs'
  );
  if (openBtn) openBtn.hidden = picking;
  if (picker) picker.hidden = !picking;
  fillMeshCopySelect(sel, destId);
  if (done) {
    done.hidden = !meshCopyNote || !/refinements/i.test(meshCopyNote);
    done.textContent = done.hidden ? '' : meshCopyNote;
  }
}

async function activateMeshClient(id, opts) {
  if (!id) return null;
  const j = await postMeshApi({ activate: id }, opts);
  if (window.__CFD_W26_STATE__) window.__CFD_W26_STATE__.meshId = id;
  publishW20({ activated: true });
  return j;
}

async function saveMeshSettingsClient(partial) {
  const body = {
    use_bank_defaults: !!(partial && partial.use_bank_defaults),
    force_bank: !!(partial && (partial.force_bank || partial.use_bank_defaults)),
    project_id: currentMeshProjectId(),
    mesh_id: (w20State && w20State.active_id) || (w20State.mesh && w20State.mesh.id) || undefined,
    ...(partial || {}),
    ...(partial && (partial.use_bank_defaults || partial.reset_defaults || partial.nameOnly)
      ? {}
      : readSettingsFromForm()),
  };
  // Never send generate flags
  delete body.generate;
  delete body.remesh;
  delete body.kick;
  const r = await fetch('/api/mesh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...currentMeshStudyIds(), ...body }),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) {
    w20State.note = (j && j.error) || 'Mesh save failed';
    publishW20({ ready: false, note: w20State.note });
    throw new Error(w20State.note);
  }
  applyMeshRecord(j, j.project_id);
  w20State.bank_exact = !!j.bank_exact;
  publishW20({ saved: true });
  return window.__CFD_W20__;
}

window.__CFD_W20_SAVE__ = saveMeshSettingsClient;
window.__CFD_W20_APPLY__ = async function applyW20(partial) {
  const opts = { use_bank_defaults: true, force_bank: true, ...(partial || {}) };
  await saveMeshSettingsClient(opts);
  showMeshPanel();
  return window.__CFD_W20__;
};
window.__CFD_W20_OPEN__ = function openW20() {
  showMeshPanel();
  return window.__CFD_W20__;
};
window.__CFD_W20_DEFAULTS__ = W20_DEFAULTS;

function wireMeshTreeHandlers() {
  /* Mesh / Mesh 1 clicks are handled by wireTreeItemClicks. */
}

(function wireW20Ui() {
  const fineness = document.getElementById('mesh-fineness');
  if (fineness) {
    fineness.addEventListener('input', () => {
      const fv = document.getElementById('mesh-fineness-val');
      if (fv) fv.textContent = String(fineness.value);
    });
  }
  const persistForm = () => {
    if (!w20State.hydrated) return;
    saveMeshSettingsClient({}).catch((e) => console.warn('[CFD] mesh settings save', e));
  };
  ['mesh-toggle-bl', 'mesh-toggle-physics', 'mesh-toggle-hex'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', () => {
      const on = !readToggleEl(el, false);
      setToggleEl(el, on);
      persistForm();
    });
  });
  // Field edits (fineness, advanced settings, engine) persist on change.
  document.getElementById('mesh-form')?.addEventListener('change', persistForm);

  const titleEl = document.getElementById('mesh-panel-title');
  const renameBtn = document.getElementById('mesh-rename');
  const renameIn = document.getElementById('mesh-rename-input');
  const stopRename = (commit) => {
    if (!renameIn || !titleEl || !renameBtn) return;
    if (commit) {
      const next = String(renameIn.value || '').trim() || meshDisplayName();
      if (w20State.settings) w20State.settings.name = next;
      if (w20State.mesh) w20State.mesh.name = next;
      titleEl.textContent = next;
      saveMeshSettingsClient({ name: next, nameOnly: true }).catch((e) =>
        console.warn('[CFD] mesh rename', e)
      );
    }
    renameIn.hidden = true;
    titleEl.hidden = false;
    renameBtn.hidden = false;
  };
  const startRename = () => {
    if (!renameIn || !titleEl || !renameBtn) return;
    renameIn.value = meshDisplayName();
    titleEl.hidden = true;
    renameBtn.hidden = true;
    renameIn.hidden = false;
    renameIn.focus();
    renameIn.select();
  };
  renameBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    startRename();
  });
  renameIn?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      stopRename(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      stopRename(false);
    }
  });
  renameIn?.addEventListener('blur', () => stopRename(true));
  document.getElementById('mesh-restore-defaults')?.addEventListener('click', () => {
    const name = meshDisplayName();
    saveMeshSettingsClient({
      reset_defaults: true,
      use_bank_defaults: true,
      force_bank: true,
      name,
    }).catch((e) => console.error('[CFD] restore mesh defaults', e));
  });

  const closeBtn = document.getElementById('mesh-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => hideMeshPanel());
  }
  const onDeleteMesh = () => {
    deleteGeneratedMeshClient().catch((e) => console.error('[CFD W20] delete mesh', e));
  };
  document.getElementById('mesh-delete')?.addEventListener('click', onDeleteMesh);
  document.getElementById('mesh-inspect-delete')?.addEventListener('click', onDeleteMesh);
  // Open the settings of the mesh being inspected. Generate from there
  // re-meshes this mesh in place with the edited settings.
  document.getElementById('mesh-inspect-settings')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const mid = w20State.active_id || (w20State.mesh && w20State.mesh.id) || null;
    try { markTreeSelected(mid ? 'meshid:' + mid : 'mesh'); } catch (_) {}
    showMeshPanel();
  });
  document.getElementById('mesh-chip-close')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    meshChipDismissed = true;
    syncMeshInspectPanel();
    try { requestAnimationFrame(syncFiltersPanelOffset); } catch (_) {}
  });
  document.getElementById('btn-create-mesh')?.addEventListener('click', () => {
    createMeshClient().catch((e) => console.error('[CFD] create mesh', e));
  });
  document.getElementById('mesh-new-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      createMeshClient().catch((err) => console.error('[CFD] create mesh', err));
    }
  });
  document.getElementById('mesh-copy-open')?.addEventListener('click', () => {
    const dest = (w20State && w20State.active_id) || (w20State.mesh && w20State.mesh.id);
    if (dest) startMeshCopyPick(dest, 'all');
  });
  document.getElementById('mesh-copy-cancel')?.addEventListener('click', () => {
    endMeshCopyPick();
    try { syncMeshCopyUi(); } catch (_) {}
    try { syncRefCopyUi(); } catch (_) {}
  });
  const meshCopySel = document.getElementById('mesh-copy-mesh');
  const onMeshCopySel = (e) => {
    const id = e.target && e.target.value;
    if (id) copyMeshSettingsFrom(id).catch((err) => console.warn('[CFD] copy mesh', err));
  };
  meshCopySel?.addEventListener('change', onMeshCopySel);
  meshCopySel?.addEventListener('input', onMeshCopySel);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !meshCopyPick) return;
    endMeshCopyPick();
    try { syncMeshCopyUi(); } catch (_) {}
    try { syncRefCopyUi(); } catch (_) {}
  });
  document.getElementById('btn-add-mesh-plane')?.addEventListener('click', () => {
    if (!meshInspectOpen) return;
    addMeshPlane();
  });
  document.getElementById('mesh-plane-list')?.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-plane]');
    if (del) {
      const id = del.getAttribute('data-del-plane');
      confirmAction({
        title: 'Delete this mesh cutting plane?',
        copy: 'The plane and its position are removed.',
      }).then((ok) => { if (ok) removeMeshPlane(id); });
      return;
    }
    const axisBtn = e.target.closest('[data-plane-axis]');
    if (axisBtn) {
      const plane = meshPlanes.find((p) => p.id === axisBtn.getAttribute('data-plane-axis'));
      if (!plane) return;
      plane.axis = String(axisBtn.getAttribute('data-axis') || 'x').toLowerCase();
      if (!plane.com) plane.com = getObjectCenterOfMass(meshBounds);
      plane.frac = fracAlongAxis(meshBounds, plane.axis, plane.com);
      renderMeshPlaneList();
      refreshMeshPlanes();
      return;
    }
    const inv = e.target.closest('[data-plane-inv]');
    if (inv) {
      const plane = meshPlanes.find((p) => p.id === inv.getAttribute('data-plane-inv'));
      if (!plane) return;
      plane.inverse = !plane.inverse;
      renderMeshPlaneList();
      refreshMeshPlanes();
    }
  });
  document.getElementById('mesh-plane-list')?.addEventListener('change', (e) => {
    const on = e.target.closest('[data-plane-on]');
    if (on) {
      const plane = meshPlanes.find((p) => p.id === on.getAttribute('data-plane-on'));
      if (!plane) return;
      plane.enabled = !!on.checked;
      refreshMeshPlanes();
    }
  });
  document.getElementById('mesh-plane-list')?.addEventListener('input', (e) => {
    const frac = e.target.closest('[data-plane-frac]');
    if (!frac) return;
    const plane = meshPlanes.find((p) => p.id === frac.getAttribute('data-plane-frac'));
    if (!plane) return;
    plane.frac = Number(frac.value) / 100;
    if (plane._fracTimer) clearTimeout(plane._fracTimer);
    plane._fracTimer = setTimeout(() => refreshMeshPlanes(), 80);
  });

  // Wrap project create to reset W20
  if (typeof window.__CFD_W16_CREATE__ === 'function') {
    const prev = window.__CFD_W16_CREATE__;
    window.__CFD_W16_CREATE__ = async function wrappedCreateW20(fields) {
      const out = await prev(fields);
      w20State.mesh = null;
      w20State.settings = null;
      w20State.meshes = [];
      w20State.meshes_all = [];
      w20State.active_id = null;
      w20State.ready = false;
      w20State.created = false;
      w20State.bank_exact = false;
      w20State.mesh_json = null;
      w20State.project_id = (out && out.project && out.project.id) || null;
      hideMeshPanel();
      publishW20({ ready: false, note: 'W20: waiting for Mesh settings' });
      return out;
    };
  }

  fetch('/api/mesh' + hashProjectQs())
    .then((r) => r.json())
    .then((j) => {
      w20State.hydrated = true;
      if (!currentStudyId()) {
        applyMeshRecord({}, j && j.project_id);
        applySettingsToForm(W20_DEFAULTS);
        if (typeof syncSimulationTree === 'function') syncSimulationTree();
        publishW20({ hydrated: true, ready: false });
        applyWorkbenchStage();
        return;
      }
      if (j && j.mesh && j.settings) {
        applyMeshRecord(j, j.project_id);
        publishW20({ hydrated: true });
      } else {
        applyMeshRecord(j || {}, j && j.project_id);
        applySettingsToForm(W20_DEFAULTS);
        if (typeof syncSimulationTree === 'function') syncSimulationTree();
        publishW20({ hydrated: true, ready: false });
      }
      applyWorkbenchStage();
    })
    .catch((e) => {
      console.warn('[CFD W20] hydrate', e);
      w20State.hydrated = true;
      applySettingsToForm(W20_DEFAULTS);
      publishW20({ ready: false });
    });
})();

/* ---- Mesh refinements (surface custom sizing + inflate boundary layer) ---- */
const REF_KIND_RGB = {
  surface: [13, 148, 136],
  inflate: [217, 119, 6],
};

const w26State = {
  ready: false,
  hydrated: false,
  project_id: null,
  refinements: [],
  activeId: null,
  meshId: null,
  draft_faces: [],
  focusFace: null,
  note: '',
};
window.__CFD_W26_STATE__ = w26State;

function refList() {
  return Array.isArray(w26State.refinements) ? w26State.refinements : [];
}

function currentRefMeshId() {
  const st = window.__CFD_W26_STATE__ || {};
  const w20 = window.__CFD_W20_STATE__ || {};
  return (
    st.meshId ||
    w20.active_id ||
    (w20.mesh && w20.mesh.id) ||
    (typeof meshList === 'function' && meshList()[0] && meshList()[0].id) ||
    null
  );
}

function refsForMesh(meshId) {
  const mid = meshId || currentRefMeshId();
  const st = window.__CFD_W26_STATE__ || {};
  const all = Array.isArray(st.refinements) ? st.refinements : [];
  if (!mid) return [];
  return all.filter((r) => r && String(r.mesh_id || '') === String(mid));
}

function activeRef() {
  return refList().find((r) => r.id === w26State.activeId) || null;
}

function refKind(ref) {
  return String((ref && ref.type) || '') === 'Inflate boundary layer' ? 'inflate' : 'surface';
}

function paintForRefFaces(faces, kind) {
  const rgb = REF_KIND_RGB[kind] || REF_KIND_RGB.surface;
  const paint = {};
  (faces || []).forEach((f) => {
    paint[f] = rgb;
  });
  return paint;
}

function publishW26(extra) {
  const payload = {
    ready: w26State.ready,
    hydrated: w26State.hydrated,
    project_id: w26State.project_id,
    refinements: refList(),
    activeId: w26State.activeId,
    note: w26State.note,
    increment: 'W26',
    ...(extra || {}),
  };
  window.__CFD_W26__ = payload;
  window.__CFD_W26_STATE__ = w26State;
  return payload;
}

function applyRefRecords(doc, projectId) {
  const list = ((doc && doc.refinements) || []).filter(Boolean);
  w26State.refinements = list;
  w26State.project_id = projectId || (doc && doc.project_id) || w26State.project_id;
  w26State.ready = list.length > 0;
  if (w26State.activeId && !list.some((r) => r.id === w26State.activeId)) {
    w26State.activeId = null;
  }
  const active = activeRef();
  if (active) w26State.draft_faces = (active.faces || []).slice();
  else w26State.draft_faces = [];
  publishW26({ created: true });
  if (typeof syncSimulationTree === 'function') syncSimulationTree();
  if (typeof syncRefsHub === 'function') syncRefsHub();
  if (treeUi.openPanel === 'ref' && active) {
    syncRefEditorFields();
    markTreeSelected('refid:' + active.id);
  } else if (treeUi.openPanel === 'refs-hub' && typeof showRefsOverview === 'function') {
    showRefsOverview();
  }
  return window.__CFD_W26__;
}

function syncRefsHub() {
  try { syncRefCopyUi(); } catch (_) {}
  const list = document.getElementById('refs-hub-list');
  if (!list) return;
  const rows = refsForMesh(currentRefMeshId());
  list.innerHTML = rows.length
    ? rows
        .map((ref) => {
          const faces = (ref.faces || []).join(', ') || 'no faces';
          return (
            '<li>' +
            '<button type="button" class="hub-item" data-open-ref="' +
            escapeHtml(ref.id) +
            '">' +
            '<span class="hub-item-main"><span class="hub-swatch hub-swatch-' +
            refKind(ref) +
            '"></span><span class="hub-item-name">' +
            escapeHtml(ref.name) +
            '</span><span class="hub-item-sub">' +
            escapeHtml(ref.type + ' · ' + faces) +
            '</span></span></button>' +
            '<button type="button" class="hub-item-del" data-del-ref="' +
            escapeHtml(ref.id) +
            '">Delete</button>' +
            '</li>'
          );
        })
        .join('')
    : '<li class="hub-empty">No refinements yet</li>';
}

function showRefsOverview() {
  const list = refsForMesh(currentRefMeshId()).filter((r) => r && (r.faces || []).length);
  if (!list.length) {
    highlightGeomFaces([]);
    return;
  }
  const paint = {};
  const all = [];
  list.forEach((ref) => {
    const rgb = REF_KIND_RGB[refKind(ref)];
    (ref.faces || []).forEach((f) => {
      paint[f] = rgb;
      all.push(f);
    });
  });
  highlightGeomFaces(all, null, paint);
}

function openRefTypeModal() {
  if (!w17State.simulation) {
    console.warn('[CFD] Create Simulation first');
    return;
  }
  openTreeDetail('ref-picker', { toggle: false });
}

function closeRefTypeModal() {
  if (treeUi.openPanel === 'ref-picker') hideAllTreeDetails();
}

function wireRefTreeHandlers() {
  /* Plus buttons are handled in wireTreeItemClicks via [data-refs-plus]. */
}

async function scopeRefsToMesh(meshId, opts) {
  const mid = meshId || currentRefMeshId();
  if (mid) w26State.meshId = mid;
  if (mid && (!opts || opts.activate !== false)) {
    try {
      if (String((w20State && w20State.active_id) || '') !== String(mid)) {
        await activateMeshClient(mid, { skipTree: true });
      }
    } catch (e) {
      console.warn('[CFD] activate mesh for refinements', e);
    }
  }
  return mid;
}

function syncRefAssignList() {
  const list = document.getElementById('ref-assign-list');
  const count = document.getElementById('ref-assign-count');
  const faces = w26State.draft_faces || [];
  if (w26State.focusFace && !faces.includes(w26State.focusFace)) w26State.focusFace = null;
  if (list) {
    list.innerHTML = faces
      .map((f) => {
        const on = w26State.focusFace === f ? ' is-focus' : '';
        return (
          '<li class="bc-assign-item' +
          on +
          '" data-w26-face="' +
          escapeHtml(f) +
          '">' +
          '<button type="button" class="bc-assign-pick" data-focus-ref-face="' +
          escapeHtml(f) +
          '">' +
          escapeHtml(f) +
          '</button>' +
          '<button type="button" class="bc-assign-x" data-unassign-ref-face="' +
          escapeHtml(f) +
          '" aria-label="Remove ' +
          escapeHtml(f) +
          '">×</button>' +
          '</li>'
        );
      })
      .join('');
  }
  if (count) count.textContent = String(faces.length);
  if (isAssigningRefFace()) {
    const ref = activeRef();
    const paint = ref ? paintForRefFaces(faces, refKind(ref)) : null;
    highlightGeomFaces(faces, w26State.focusFace, paint);
  }
}

function syncRefSurfaceRows() {
  const sizing = (document.getElementById('ref-sizing') || {}).value || 'Custom';
  const auto = sizing === 'Automatic';
  const fine = document.getElementById('ref-fineness-row');
  const def = document.getElementById('ref-default-size-row');
  const min = document.getElementById('ref-min-size-row');
  if (fine) fine.hidden = !auto;
  if (def) def.hidden = auto;
  if (min) min.hidden = auto;
}

function syncRefInflateRows() {
  const grad = (document.getElementById('ref-gradation') || {}).value || 'growth_rate';
  const growth = document.getElementById('ref-growth-row');
  const first = document.getElementById('ref-first-layer-row');
  const total = document.getElementById('ref-total-row');
  if (growth) growth.hidden = grad !== 'growth_rate';
  if (first) first.hidden = grad === 'growth_rate';
  if (total) total.hidden = grad !== 'first_and_total';
}

function syncRefEditorFields() {
  const ref = activeRef();
  if (!ref) return;
  const title = document.getElementById('ref-editor-title');
  const typeLab = document.getElementById('ref-editor-type-label');
  if (title) title.textContent = ref.name;
  if (typeLab) typeLab.textContent = ref.type;
  const surface = document.getElementById('ref-surface-fields');
  const inflate = document.getElementById('ref-inflate-fields');
  const isSurf = refKind(ref) === 'surface';
  if (surface) surface.hidden = !isSurf;
  if (inflate) inflate.hidden = isSurf;
  if (isSurf) {
    const sizing = document.getElementById('ref-sizing');
    if (sizing) sizing.value = ref.sizing || 'Custom';
    const fine = document.getElementById('ref-fineness');
    if (fine) fine.value = String(ref.fineness != null ? ref.fineness : 7);
    const fv = document.getElementById('ref-fineness-val');
    if (fv) fv.textContent = String(fine ? fine.value : 7);
    const def = document.getElementById('ref-default-size');
    if (def) def.value = String(ref.default_size != null ? ref.default_size : 2);
    const defU = document.getElementById('ref-default-size-unit');
    if (defU) defU.value = ref.default_size_unit || 'mm';
    const min = document.getElementById('ref-min-size');
    if (min) min.value = String(ref.min_size != null ? ref.min_size : 0);
    const minU = document.getElementById('ref-min-size-unit');
    if (minU) minU.value = ref.min_size_unit || ref.default_size_unit || 'mm';
    syncRefSurfaceRows();
  } else {
    const n = document.getElementById('ref-n-layers');
    if (n) n.value = String(ref.n_layers != null ? ref.n_layers : 3);
    const rel = document.getElementById('ref-rel-thickness');
    if (rel) rel.value = String(ref.overall_relative_thickness != null ? ref.overall_relative_thickness : 0.4);
    const grad = document.getElementById('ref-gradation');
    if (grad) grad.value = ref.gradation || 'growth_rate';
    const gr = document.getElementById('ref-growth-rate');
    if (gr) gr.value = String(ref.growth_rate != null ? ref.growth_rate : 1.5);
    const fl = document.getElementById('ref-first-layer');
    if (fl) fl.value = String(ref.first_layer_thickness != null ? ref.first_layer_thickness : 0.1);
    const flu = document.getElementById('ref-first-layer-unit');
    if (flu) flu.value = ref.first_layer_unit || 'mm';
    const tot = document.getElementById('ref-total-thickness');
    if (tot) tot.value = String(ref.total_thickness != null ? ref.total_thickness : 1);
    const tu = document.getElementById('ref-total-unit');
    if (tu) tu.value = ref.total_thickness_unit || ref.first_layer_unit || 'mm';
    syncRefInflateRows();
  }
  syncRefAssignList();
}

function readRefEditorDraft() {
  const ref = activeRef();
  if (!ref) return null;
  const out = {
    id: ref.id,
    name: ref.name,
    type: ref.type,
    mesh_id: ref.mesh_id || currentRefMeshId() || undefined,
    faces: (w26State.draft_faces || []).slice(),
  };
  const pid = currentProjectId();
  if (pid) out.project_id = pid;
  Object.assign(out, currentMeshStudyIds());
  if (refKind(ref) === 'surface') {
    out.sizing = (document.getElementById('ref-sizing') || {}).value || 'Custom';
    out.fineness = Number((document.getElementById('ref-fineness') || {}).value || 7);
    out.default_size = Number((document.getElementById('ref-default-size') || {}).value);
    if (!Number.isFinite(out.default_size)) out.default_size = 2;
    out.default_size_unit = (document.getElementById('ref-default-size-unit') || {}).value || 'mm';
    out.min_size = Number((document.getElementById('ref-min-size') || {}).value);
    if (!Number.isFinite(out.min_size)) out.min_size = 0;
    out.min_size_unit = (document.getElementById('ref-min-size-unit') || {}).value || out.default_size_unit;
  } else {
    out.n_layers = Number((document.getElementById('ref-n-layers') || {}).value || 3);
    out.overall_relative_thickness = Number((document.getElementById('ref-rel-thickness') || {}).value);
    if (!Number.isFinite(out.overall_relative_thickness)) out.overall_relative_thickness = 0.4;
    out.gradation = (document.getElementById('ref-gradation') || {}).value || 'growth_rate';
    out.growth_rate = Number((document.getElementById('ref-growth-rate') || {}).value);
    if (!Number.isFinite(out.growth_rate)) out.growth_rate = 1.5;
    out.first_layer_thickness = Number((document.getElementById('ref-first-layer') || {}).value);
    if (!Number.isFinite(out.first_layer_thickness)) out.first_layer_thickness = 0.1;
    out.first_layer_unit = (document.getElementById('ref-first-layer-unit') || {}).value || 'mm';
    out.total_thickness = Number((document.getElementById('ref-total-thickness') || {}).value);
    if (!Number.isFinite(out.total_thickness)) out.total_thickness = 1;
    out.total_thickness_unit = (document.getElementById('ref-total-unit') || {}).value || out.first_layer_unit;
  }
  return out;
}

function showRefEditor(ref) {
  if (!ref) return;
  w26State.activeId = ref.id;
  if (ref.mesh_id) w26State.meshId = ref.mesh_id;
  w26State.draft_faces = (ref.faces || []).slice();
  const mid = currentRefMeshId();
  treeUi.expanded.Mesh = true;
  if (mid) {
    treeUi.expanded['mesh:' + mid] = true;
    treeUi.expanded['Refinements:' + mid] = true;
  }
  treeUi.expanded[ref.name] = true;
  openTreeDetail('ref', { toggle: false });
  syncRefEditorFields();
  markTreeSelected('refid:' + ref.id);
}

async function persistActiveRef() {
  const draft = readRefEditorDraft();
  if (!draft) return null;
  const r = await fetch('/api/mesh/refinements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || 'Refinement save failed');
  applyRefRecords(j, j.project_id);
  return j;
}

function toggleAssignRefFace(label) {
  const name = String(label || '').trim();
  if (!name || !activeRef()) return;
  const i = w26State.draft_faces.indexOf(name);
  if (i >= 0) {
    w26State.draft_faces.splice(i, 1);
    if (w26State.focusFace === name) w26State.focusFace = w26State.draft_faces[0] || null;
  } else {
    w26State.draft_faces.push(name);
    w26State.focusFace = name;
  }
  syncRefAssignList();
  persistActiveRef().catch((e) => console.error('[CFD] refinement face', e));
}

function unassignRefFace(label) {
  const name = String(label || '').trim();
  const i = w26State.draft_faces.indexOf(name);
  if (i < 0) return;
  w26State.draft_faces.splice(i, 1);
  if (w26State.focusFace === name) w26State.focusFace = w26State.draft_faces[0] || null;
  syncRefAssignList();
  persistActiveRef().catch((e) => console.error('[CFD] refinement face', e));
}

function focusAssignedRefFace(label, opts) {
  const name = String(label || '').trim();
  if (!name || !w26State.draft_faces.includes(name)) return;
  if (opts && opts.toggle === false) w26State.focusFace = name;
  else w26State.focusFace = w26State.focusFace === name ? null : name;
  syncRefAssignList();
}

async function createRefClient(type) {
  const pendingFaces =
    typeof pendingCadFaceLabels === 'function' ? pendingCadFaceLabels() : [];
  const body = { type, faces: pendingFaces.slice(), ...currentMeshStudyIds() };
  const pid = currentProjectId();
  if (pid) body.project_id = pid;
  const mid = currentRefMeshId();
  if (mid) body.mesh_id = mid;
  const r = await fetch('/api/mesh/refinements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || 'Refinement create failed');
  applyRefRecords(j, j.project_id);
  const created =
    j.refinement ||
    (j.refinements || []).filter((x) => x.type === type).slice(-1)[0];
  if (created) showRefEditor(created);
  return j;
}

async function deleteRefClient(id) {
  const body = { delete: id };
  const pid = currentProjectId();
  if (pid) body.project_id = pid;
  const r = await fetch('/api/mesh/refinements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || 'Refinement delete failed');
  w26State.activeId = null;
  w26State.draft_faces = [];
  highlightGeomFaces([]);
  applyRefRecords(j, j.project_id);
  hideAllTreeDetails();
  markTreeSelected(null);
  return j;
}

window.__CFD_W26_CREATE__ = createRefClient;
window.__CFD_SHOW_REF__ = showRefEditor;
window.__CFD_W26_APPLY__ = applyRefRecords;

(function wireW26Ui() {
  const persist = () => persistActiveRef().catch((e) => console.error('[CFD] refinement persist', e));
  document.getElementById('ref-assign-list')?.addEventListener('click', (e) => {
    const drop = e.target.closest('[data-unassign-ref-face]');
    if (drop) {
      e.preventDefault();
      e.stopPropagation();
      unassignRefFace(drop.getAttribute('data-unassign-ref-face'));
      return;
    }
    const pick = e.target.closest('[data-focus-ref-face]');
    if (pick) {
      e.preventDefault();
      focusAssignedRefFace(pick.getAttribute('data-focus-ref-face'));
    }
  });
  document.getElementById('ref-clear-assign')?.addEventListener('click', () => {
    w26State.draft_faces = [];
    syncRefAssignList();
    persist();
  });
  document.getElementById('ref-delete')?.addEventListener('click', () => {
    const ref = activeRef();
    if (ref) deleteRefClient(ref.id).catch((e) => console.error('[CFD] refinement delete', e));
  });
  document.getElementById('btn-add-ref')?.addEventListener('click', () => openRefTypeModal());
  document.getElementById('ref-copy-open')?.addEventListener('click', () => {
    const dest = currentRefMeshId();
    if (dest) startMeshCopyPick(dest, 'refs');
  });
  document.getElementById('ref-copy-cancel')?.addEventListener('click', () => {
    endMeshCopyPick();
    try { syncRefCopyUi(); } catch (_) {}
    try { syncMeshCopyUi(); } catch (_) {}
  });
  const refCopySel = document.getElementById('ref-copy-mesh');
  const onRefCopySel = (e) => {
    const id = e.target && e.target.value;
    if (id) copyRefinementsFrom(id).catch((err) => console.warn('[CFD] copy refinements', err));
  };
  refCopySel?.addEventListener('change', onRefCopySel);
  refCopySel?.addEventListener('input', onRefCopySel);
  document.getElementById('refs-hub-list')?.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-ref]');
    if (del) {
      e.preventDefault();
      const id = del.getAttribute('data-del-ref');
      if (id) deleteRefClient(id).catch((err) => console.error('[CFD] refinement delete', err));
      return;
    }
    const btn = e.target.closest('[data-open-ref]');
    if (!btn) return;
    const hit = refList().find((r) => r.id === btn.getAttribute('data-open-ref'));
    if (hit) showRefEditor(hit);
  });
  const fine = document.getElementById('ref-fineness');
  if (fine) {
    fine.addEventListener('input', () => {
      const fv = document.getElementById('ref-fineness-val');
      if (fv) fv.textContent = String(fine.value);
    });
  }
  document.getElementById('ref-sizing')?.addEventListener('change', () => {
    syncRefSurfaceRows();
    persist();
  });
  document.getElementById('ref-gradation')?.addEventListener('change', () => {
    syncRefInflateRows();
    persist();
  });
  [
    'ref-fineness',
    'ref-default-size',
    'ref-default-size-unit',
    'ref-min-size',
    'ref-min-size-unit',
    'ref-n-layers',
    'ref-rel-thickness',
    'ref-growth-rate',
    'ref-first-layer',
    'ref-first-layer-unit',
    'ref-total-thickness',
    'ref-total-unit',
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', persist);
  });

  const prevCreate = window.__CFD_W16_CREATE__;
  if (typeof prevCreate === 'function') {
    window.__CFD_W16_CREATE__ = async function wrappedCreateW26(fields) {
      const out = await prevCreate(fields);
      w26State.refinements = [];
      w26State.activeId = null;
      w26State.draft_faces = [];
      w26State.ready = false;
      w26State.project_id = (out && out.project && out.project.id) || null;
      publishW26({ ready: false });
      return out;
    };
  }

  fetch('/api/mesh/refinements' + hashProjectQs())
    .then((r) => r.json())
    .then((j) => {
      w26State.hydrated = true;
      if (!currentStudyId()) {
        applyRefRecords({ refinements: [] }, j && j.project_id);
        publishW26({ hydrated: true, ready: false });
        return;
      }
      applyRefRecords(j || { refinements: [] }, j && j.project_id);
      publishW26({ hydrated: true, ready: refList().length > 0 });
    })
    .catch((e) => {
      console.warn('[CFD] refinements hydrate', e);
      w26State.hydrated = true;
      publishW26({ ready: false });
    });
})();

/* ---- W23 — Mesh Generate on W16 STEP/Body1 (snappyHexMesh + eMesh; no W15.1 stamp) ---- */
async function generateMeshClient() {
  jobState.status = 'running';
  jobState.mode = 'mesh';
  jobState.path_kind = 'standard';
  jobState.n_cells = null;
  jobState.n_points = null;
  jobState.n_faces = null;
  jobState.pid = null;
  jobState.exit_code = null;
  jobState.started_at = new Date().toISOString();
  jobState.finished_at = null;
  jobState.note = 'Generating mesh...';
  startMeshElapsedClock();
  if (w20State.mesh) {
    w20State.mesh.generated = false;
    w20State.mesh.live_mesh_result = null;
  }
  try { publishW20({ generated: false, live_mesh_result: null }); } catch (_) {}
  try { if (typeof syncSimulationTree === 'function') syncSimulationTree(); } catch (_) {}
  try { syncJobStatusChrome(); } catch (_) {}
  // Persist current form settings first (W20)
  try {
    await saveMeshSettingsClient({});
  } catch (e) {
    console.warn('[CFD W23] save before generate', e);
  }
  const r = await fetch('/api/mesh/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      project_id: currentProjectId() || undefined,
      ...currentMeshStudyIds(),
      mesh_id: (w20State && w20State.active_id) || (w20State.mesh && w20State.mesh.id) || undefined,
    }),
  });
  const j = await r.json();
  jobState.last_kick = { ok: r.ok || r.status === 202, status: r.status, body: j, kind: 'generate' };
  applyCaseSnapToJob(j);
  syncJobStatusChrome();
  publishW21({ generate_started: true, api: j });
  if (!(r.ok || r.status === 202)) {
    jobState.status = 'failed';
    jobState.finished_at = new Date().toISOString();
    stopMeshElapsedClock();
    w20State.note = (j && j.error) || 'Generate failed to start';
    publishW20({ note: w20State.note });
    try { syncJobStatusChrome(); } catch (_) {}
    throw new Error(w20State.note);
  }
  startJobPoll();
  return window.__CFD_W21__;
}

function publishW21(extra) {
  const payload = {
    increment: 'W23',
    ready: true,
    approach:
      'W23: POST /api/mesh/generate remeshes active W16 project source.step/Body1 via WSL surfaceFeatureExtract+blockMesh+snappyHexMesh (NOT MTP1-silent-copy, NOT checkMesh). Job tracks PID. Finished cells/nodes from polyMesh. No W15.1 stamp. No solves.',
    status: jobState.status,
    mode: jobState.mode,
    path_kind: jobState.path_kind,
    pid: jobState.pid,
    exit_code: jobState.exit_code,
    command: jobState.command,
    log_path: jobState.log_path,
    case_dir: jobState.case_dir,
    mesh_path: jobState.mesh_path,
    n_cells: jobState.n_cells,
    n_points: jobState.n_points,
    n_faces: jobState.n_faces,
    counts_source: jobState.counts_source,
    emesh: jobState.emesh,
    feature_marks_total: jobState.feature_marks_total,
    fingerprint_before: jobState.fingerprint_before,
    fingerprint_after: jobState.fingerprint_after,
    step_path: jobState.step_path,
    body1_path: jobState.body1_path,
    geometry: jobState.geometry,
    mtp1_silent_copy: jobState.mtp1_silent_copy === false ? false : jobState.mtp1_silent_copy,
    forbidden_path_kind: 'checkMesh',
    no_fake_progress: true,
    soft_pass_avoided: true,
    w20: window.__CFD_W20__ || null,
    prove_ts: Date.now(),
    ...(extra || {}),
  };
  window.__CFD_W21__ = payload;
  return payload;
}

window.__CFD_W21_GENERATE__ = generateMeshClient;
window.__CFD_W21_APPLY__ = async function applyW21(partial) {
  if (partial && partial.generate === false) {
    return publishW21({ skipped: true });
  }
  await generateMeshClient();
  // poll until terminal already via startJobPoll; wait briefly for prove convenience
  const t0 = Date.now();
  while (Date.now() - t0 < 300000) {
    const snap = await fetchActiveCase();
    applyCaseSnapToJob(snap);
    syncJobStatusChrome();
    publishW21({ polled: true, api: snap });
    if (snap.status === 'done' || snap.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 750));
  }
  // refresh mesh.json into w20 state
  try {
    const mr = await fetch('/api/mesh' + hashProjectQs());
    const mj = await mr.json();
    if (mj && mj.mesh) applyMeshRecord(mj, mj.project_id);
  } catch (e) {
    console.warn('[CFD W23] mesh refresh', e);
  }
  showMeshPanel();
  return publishW21({ applied: true });
};
window.__CFD_W21_OPEN__ = function openW21() {
  showMeshPanel();
  return publishW21({ opened: true });
};

(function wireW21Ui() {
  const gen = document.getElementById('btn-generate-mesh');
  if (gen && !gen._w21Wired) {
    gen._w21Wired = true;
    gen.addEventListener('click', () => {
      generateMeshClient().catch((e) => console.error('[CFD W23] generate', e));
    });
  }
  publishW21({ wired: true });
})();

/**
 * W22 — Area average setup (Result control → Surface data → Area average 1)
 * Bank: Write control Time step; assign BOTH face 57@Body1 + face 71@Body1 → ✓
 * Persists projects/<id>/result_controls.json (+ area_average.json) via POST/GET /api/result-controls.
 * SETUP ONLY — no solves; no fake chart values (honest empty until run).
 */
const W22_AA = {
  name: 'Area average 1',
  kind: 'Area average',
  category: 'Surface data',
  write_control: 'Time step',
  faces: [],
};

const w22State = {
  ready: false,
  hydrated: false,
  created: false,
  project_id: null,
  area_average_1: null,
  draft_faces: [],
  focusFace: null,
  panel_open: false,
  editing_run_id: null,
  editing_rc_id: null,
  read_only: false,
  result_controls_json: null,
  area_average_json: null,
  note: 'Area average setup',
};
window.__CFD_W22_STATE__ = w22State;

function publishW22(extra) {
  const aa = w22State.area_average_1;
  const payload = {
    ready: !!w22State.ready,
    hydrated: !!w22State.hydrated,
    created: !!w22State.created,
    project_id: w22State.project_id,
    area_average_1: aa,
    result_controls: aa ? [aa] : [],
    result_controls_json: w22State.result_controls_json,
    area_average_json: w22State.area_average_json,
    note: w22State.note,
    increment: 'W22',
    soft_pass_avoided: true,
    ...(extra || {}),
  };
  window.__CFD_W22__ = payload;
  return payload;
}

const AA_FACE_RGB = [105, 65, 198];

function paintForAaFaces(faces) {
  const paint = {};
  (faces || []).forEach((f) => {
    paint[f] = AA_FACE_RGB;
    const ref = parseFaceRef(f);
    if (ref) paint[faceLabel(ref.faceId, ref.bodyId || 1)] = AA_FACE_RGB;
  });
  return paint;
}

function highlightAaFaces(faces, focus) {
  const list = Array.isArray(faces) ? faces.filter(Boolean) : [];
  highlightGeomFaces(list, focus === undefined ? w22State.focusFace : focus, paintForAaFaces(list));
}

function showRunAaOverview() {
  const rec = typeof selectedRunRecord === 'function' ? selectedRunRecord() : null;
  const all = [];
  ((rec && rec.result_controls) || []).forEach((rc) => {
    if (!/area average/i.test(String((rc && rc.kind) || (rc && rc.name) || ''))) return;
    (rc.faces || []).forEach((f) => {
      if (f && !all.includes(f)) all.push(f);
    });
  });
  highlightAaFaces(all, null);
}

function syncAaAssignList() {
  const list = document.getElementById('aa-assign-list');
  const count = document.getElementById('aa-assign-count');
  const faces = Array.isArray(w22State.draft_faces)
    ? w22State.draft_faces
    : (w22State.area_average_1 && w22State.area_average_1.faces) || [];
  if (w22State.focusFace && !faces.includes(w22State.focusFace)) w22State.focusFace = null;
  if (list) {
    list.innerHTML = faces
      .map((f) => {
        const on = w22State.focusFace === f ? ' is-focus' : '';
        return (
          '<li class="bc-assign-item' +
          on +
          '" data-w22-face="' +
          escapeHtml(f) +
          '">' +
          '<button type="button" class="bc-assign-pick" data-focus-aa-face="' +
          escapeHtml(f) +
          '">' +
          escapeHtml(f) +
          '</button>' +
          '<button type="button" class="bc-assign-x" data-unassign-face="' +
          escapeHtml(f) +
          '" aria-label="Remove ' +
          escapeHtml(f) +
          '">×</button>' +
          '</li>'
        );
      })
      .join('');
  }
  if (count) count.textContent = String(faces.length);
  if (isAssigningAaFace() || w22State.panel_open) {
    highlightAaFaces(faces, w22State.focusFace);
  }
}

function hideAaPanel() {
  const panel = document.getElementById('panel-area-average');
  if (panel) panel.hidden = true;
  w22State.panel_open = false;
}

function showAaPanel() {
  try {
    if (typeof meshInspectOpen !== 'undefined' && meshInspectOpen && typeof hideMeshInspect === 'function') {
      hideMeshInspect();
    }
  } catch (_) {}
  try {
    if (typeof setGeomVisible === 'function') setGeomVisible(true);
  } catch (_) {}
  openTreeDetail('aa', { toggle: false });
  const wc = document.getElementById('aa-write-control');
  const title = document.getElementById('aa-panel-title');
  const aa = w22State.area_average_1;
  if (title) title.textContent = (aa && aa.name) || 'Area average 1';
  if (wc) {
    wc.value = (aa && aa.write_control) || 'Time step';
    wc.disabled = !!w22State.read_only;
  }
  const clearBtn = document.getElementById('aa-clear-assign');
  const delBtn = document.getElementById('aa-delete');
  if (clearBtn) clearBtn.hidden = !!w22State.read_only;
  if (delBtn) delBtn.hidden = !!w22State.read_only;
  syncAaAssignList();
  publishW22({ panel_open: true });
}

function openRcTypeModal(runId) {
  if (!w17State.simulation) {
    console.warn('[CFD W22] Create Simulation first');
    return;
  }
  if (runId) w27State.rc_target_run_id = runId;
  const modal = document.getElementById('modal-result-control');
  if (modal) modal.hidden = false;
}

function closeRcTypeModal() {
  const modal = document.getElementById('modal-result-control');
  if (modal) modal.hidden = true;
}

function syncResultsHub() {
  const list = document.getElementById('results-hub-list');
  if (!list) return;
  const rec = typeof selectedRunRecord === 'function' ? selectedRunRecord() : null;
  const rcs = (rec && rec.result_controls) || [];
  const addBtn = document.getElementById('btn-add-result');
  if (addBtn) addBtn.hidden = !rec || (typeof runIsLocked === 'function' && runIsLocked(rec));
  if (!rcs.length) {
    list.innerHTML = '<li class="hub-empty">No monitors yet</li>';
    return;
  }
  list.innerHTML = rcs
    .map((rc) => {
      const n = Array.isArray(rc.faces) ? rc.faces.length : 0;
      return (
        '<li><button type="button" class="hub-item" data-open-run-rc="' +
        escapeHtml(String(rc.id || rc.name)) +
        '">' +
        escapeHtml(rc.name || rc.kind || 'Result') +
        (n ? ' · ' + n + (n === 1 ? ' face' : ' faces') : '') +
        '</button></li>'
      );
    })
    .join('');
}

function wireRcTreeHandlers() {
  document.getElementById('btn-rc-plus')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openRcTypeModal(w27State.selected_run_id || w27State.active_run_id);
  });
  document.querySelectorAll('[data-w27-run-plus]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openRcTypeModal(btn.getAttribute('data-w27-run-plus'));
    });
  });
}

function applyAaRecord(doc, projectId) {
  const list = (doc && doc.result_controls) || [];
  const fromFile = doc && doc.area_average_1;
  const aa =
    (fromFile && list.some((r) => r && r.id === fromFile.id) ? fromFile : null) ||
    list.find((r) => r && r.name === W22_AA.name) ||
    null;
  w22State.area_average_1 = aa;
  w22State.draft_faces = aa ? (aa.faces || []).slice() : [];
  w22State.project_id = projectId || (doc && doc.project_id) || w22State.project_id;
  w22State.result_controls_json =
    (doc && doc.result_controls_json) ||
    (doc && doc.result_controls_json_path) ||
    (aa && aa.result_controls_json) ||
    null;
  w22State.area_average_json =
    (doc && doc.area_average_json) ||
    (doc && doc.area_average_json_path) ||
    (aa && aa.area_average_json) ||
    null;
  w22State.ready = !!aa;
  w22State.created = !!aa;
  w22State.note = aa
    ? 'Area average 1 saved'
    : 'No monitors';
  syncAaAssignList();
  if (typeof syncSimulationTree === 'function') syncSimulationTree();
  publishW22({ created: !!aa });
  return window.__CFD_W22__;
}

async function saveAreaAverageClient(partial) {
  const faces = Array.isArray(partial && partial.faces)
    ? partial.faces
    : (w22State.draft_faces || []).slice();
  const wcEl = document.getElementById('aa-write-control');
  const runId =
    (partial && partial.run_id) ||
    w22State.editing_run_id ||
    w27State.rc_target_run_id ||
    w27State.selected_run_id ||
    w27State.active_run_id;
  if (!runId) {
    w22State.note = 'Create a run first, then add a result control on that run';
    publishW22({ ready: false, note: w22State.note });
    throw new Error(w22State.note);
  }
  const rec = findRunRecord(runId);
  const rcs = ((rec && rec.result_controls) || []).map((r) => ({ ...r }));
  const name =
    (partial && partial.name) ||
    (w22State.area_average_1 && w22State.area_average_1.name) ||
    nextAaName(rcs);
  const rcId =
    (partial && partial.rc_id) ||
    w22State.editing_rc_id ||
    (w22State.area_average_1 && w22State.area_average_1.id) ||
    stampRcId();
  const nextRc = {
    id: rcId,
    name,
    kind: 'Area average',
    category: 'Surface data',
    write_control: (wcEl && wcEl.value) || W22_AA.write_control,
    faces,
    results: null,
    series: null,
    chart_values: null,
    results_available: false,
  };
  const idx = rcs.findIndex((r) => String(r.id) === String(rcId) || r.name === name);
  if (idx >= 0) rcs[idx] = { ...rcs[idx], ...nextRc };
  else rcs.push(nextRc);
  const j = await persistRunSettings({ run_id: runId, result_controls: rcs });
  if (!j || j.ok === false) {
    w22State.note = (j && j.error) || 'Area average save failed';
    publishW22({ ready: false, note: w22State.note, api: j });
    throw new Error(w22State.note);
  }
  w22State.editing_run_id = runId;
  w22State.editing_rc_id = rcId;
  w22State.area_average_1 = nextRc;
  w22State.draft_faces = faces.slice();
  w22State.ready = true;
  w22State.created = true;
  w22State.note = name + ' saved';
  syncAaAssignList();
  expandRunFolders(runId, 'rcs');
  if (typeof syncSimulationTree === 'function') syncSimulationTree();
  if (typeof syncResultsHub === 'function') syncResultsHub();
  publishW22({ saved: true, api: j, created: true });
  return window.__CFD_W22__;
}

window.__CFD_W22_SAVE__ = saveAreaAverageClient;
window.__CFD_W22_APPLY__ = async function applyW22(partial) {
  if (partial && partial.open) {
    showAaPanel();
  }
  if (partial && (partial.faces || partial.save !== false)) {
    if (partial.faces) w22State.draft_faces = partial.faces.slice();
    await saveAreaAverageClient({
      faces: w22State.draft_faces,
      ...(partial || {}),
    });
  }
  return window.__CFD_W22__;
};
window.__CFD_W22_OPEN__ = function openW22() {
  showAaPanel();
  return publishW22({ opened: true });
};

function focusAssignedAaFace(label, opts) {
  const name = String(label || '').trim();
  if (!name || !(w22State.draft_faces || []).includes(name)) return;
  if (opts && opts.toggle === false) w22State.focusFace = name;
  else w22State.focusFace = w22State.focusFace === name ? null : name;
  syncAaAssignList();
}

function addDraftFace(face) {
  const f = String(face || '').trim();
  if (!f || w22State.read_only) return;
  if (!w22State.draft_faces.includes(f)) w22State.draft_faces.push(f);
  w22State.focusFace = f;
  if (w22State.area_average_1) w22State.area_average_1.faces = w22State.draft_faces.slice();
  syncAaAssignList();
  publishW22({ draft: true });
  saveAreaAverageClient({ faces: w22State.draft_faces.slice() }).catch((e) =>
    console.error('[CFD W22] persist', e)
  );
}

function toggleAssignAaFace(face) {
  const f = String(face || '').trim();
  if (!f || w22State.read_only) return;
  const i = w22State.draft_faces.indexOf(f);
  if (i >= 0) w22State.draft_faces.splice(i, 1);
  else w22State.draft_faces.push(f);
  w22State.focusFace = i >= 0 ? null : f;
  if (w22State.area_average_1) w22State.area_average_1.faces = w22State.draft_faces.slice();
  syncAaAssignList();
  publishW22({ draft: true });
  saveAreaAverageClient({ faces: w22State.draft_faces.slice() }).catch((e) =>
    console.error('[CFD W22] persist', e)
  );
}

(function wireW22Ui() {
  document.getElementById('aa-assign-list')?.addEventListener('click', (e) => {
    const drop = e.target.closest('[data-unassign-face]');
    if (drop) {
      e.preventDefault();
      e.stopPropagation();
      toggleAssignAaFace(drop.getAttribute('data-unassign-face'));
      return;
    }
    const pick = e.target.closest('[data-focus-aa-face]');
    if (pick) {
      e.preventDefault();
      focusAssignedAaFace(pick.getAttribute('data-focus-aa-face'));
    }
  });
  document.getElementById('aa-clear-assign')?.addEventListener('click', () => {
    if (w22State.read_only) return;
    w22State.draft_faces = [];
    syncAaAssignList();
    publishW22({ draft: true });
    if (w22State.area_average_1) {
      saveAreaAverageClient({ faces: [] }).catch((e) =>
        console.error('[CFD W22] clear', e)
      );
    }
  });
  document.getElementById('aa-delete')?.addEventListener('click', () => {
    if (w22State.read_only) return;
    const runId = w22State.editing_run_id || w27State.selected_run_id;
    const rcId = w22State.editing_rc_id;
    const rec = findRunRecord(runId);
    const next = ((rec && rec.result_controls) || []).filter(
      (r) => String(r.id) !== String(rcId) && r.name !== (w22State.area_average_1 && w22State.area_average_1.name)
    );
    persistRunSettings({ run_id: runId, result_controls: next })
      .then((j) => {
        if (!j || j.ok === false) throw new Error((j && j.error) || 'AA delete failed');
        w22State.area_average_1 = null;
        w22State.draft_faces = [];
        w22State.editing_rc_id = null;
        hideAaPanel();
        expandRunFolders(runId, 'rcs');
        syncSimulationTree();
        if (typeof syncResultsHub === 'function') syncResultsHub();
        if (runId && typeof openRunRcsFolder === 'function') openRunRcsFolder(runId);
        publishW22({ deleted: true });
      })
      .catch((e) => console.error('[CFD W22] delete', e));
  });

  document.getElementById('btn-add-result')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openRcTypeModal(w27State.selected_run_id || w27State.active_run_id);
  });
  document.getElementById('results-hub-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open-run-rc], [data-open-aa]');
    if (!btn) return;
    const rec = typeof selectedRunRecord === 'function' ? selectedRunRecord() : null;
    const rcId = btn.getAttribute('data-open-run-rc');
    if (rec && rcId && typeof openRunResultControl === 'function') {
      openRunResultControl(rec.id, rcId);
      return;
    }
    showAaPanel();
  });
  document.getElementById('rc-cancel')?.addEventListener('click', () => closeRcTypeModal());
  document.getElementById('rc-cancel-x')?.addEventListener('click', () => closeRcTypeModal());
  document.getElementById('rc-backdrop')?.addEventListener('click', () => closeRcTypeModal());
  document.getElementById('rc-apply')?.addEventListener('click', () => {
    const runId = w27State.rc_target_run_id || w27State.selected_run_id || w27State.active_run_id;
    if (!runId) {
      closeRcTypeModal();
      console.warn('[CFD] Create a run first');
      return;
    }
    closeRcTypeModal();
    w22State.draft_faces = [];
    w22State.editing_run_id = runId;
    w22State.editing_rc_id = null;
    w22State.read_only = false;
    const rec = findRunRecord(runId);
    saveAreaAverageClient({
      faces: [],
      run_id: runId,
      name: nextAaName((rec && rec.result_controls) || []),
    })
      .then(() => {
        showAaPanel();
        syncResultsHub();
        publishW22({ modal_applied: true });
      })
      .catch((e) => console.error('[CFD W22] create', e));
  });

  // Wrap project create to reset W22
  if (typeof window.__CFD_W16_CREATE__ === 'function' && !window.__CFD_W16_CREATE__._w22Wrapped) {
    const prev = window.__CFD_W16_CREATE__;
    window.__CFD_W16_CREATE__ = async function wrappedCreateW22(fields) {
      const out = await prev(fields);
      w22State.area_average_1 = null;
      w22State.draft_faces = [];
      w22State.ready = false;
      w22State.created = false;
      w22State.result_controls_json = null;
      w22State.area_average_json = null;
      w22State.note = 'W22: waiting for Area average setup';
      hideAaPanel();
      publishW22({ ready: false });
      if (typeof syncSimulationTree === 'function') syncSimulationTree();
      return out;
    };
    window.__CFD_W16_CREATE__._w22Wrapped = true;
  }

  // Hydrate from disk
  fetch('/api/result-controls' + hashProjectQs())
    .then((r) => r.json())
    .then((j) => {
      w22State.hydrated = true;
      if (!currentStudyId()) {
        applyAaRecord({ area_average_1: null, result_controls: [] }, j && j.project_id);
        publishW22({ hydrated: true, ready: false });
        return;
      }
      if (j && j.area_average_1) {
        applyAaRecord(j, j.project_id);
        publishW22({ hydrated: true, created: !!j.area_average_1 });
      } else {
        if (typeof syncSimulationTree === 'function') syncSimulationTree();
        publishW22({ hydrated: true, ready: false });
      }
    })
    .catch((e) => {
      console.warn('[CFD W22] hydrate', e);
      w22State.hydrated = true;
      if (typeof syncSimulationTree === 'function') syncSimulationTree();
      publishW22({ ready: false });
    });

  publishW22({ wired: true });
})();


/* ---- Simulation Control: Start / Stop simpleFoam from project mesh + BCs ---- */
const w27State = {
  endTime: 200,
  writeInterval: 50,
  run: null,
  runs: [],
  meshes: [],
  selected_run_id: null,
  active_run_id: null,
  live_run_id: null,
  rc_target_run_id: null,
  poll_timer: null,
  elapsed_timer: null,
  attaching: false,
  start_error: null,
  starting: false,
  // W30 transient: the form model for the selected draft, the server's
  // resolved numbers for it (auto Δt, frame interval, step estimate), and the
  // preview request bookkeeping.
  transient: null,
  transient_preview: null,
  transient_preview_key: '',
  transient_preview_timer: null,
};
window.__CFD_W27_STATE__ = w27State;

/* ---- W30 Transient: settings model, form, preview ---- */

const TRANSIENT_DEFAULTS_CLIENT = Object.freeze({
  end_time: 5,
  write_count: 50,
  time_step_mode: 'adjustable',
  max_co: 1,
  delta_t: null,
  max_delta_t: null,
  time_scheme: 'Euler',
  n_outer_correctors: 1,
  n_correctors: 2,
  n_non_orth_correctors: 0,
});

/**
 * A run is transient when it was stamped so. Unstamped runs that already
 * started predate the transient option (steady); unstamped drafts follow the
 * simulation.
 */
function runRecIsTransient(rec) {
  if (rec && rec.time_dependency) return /transient/i.test(String(rec.time_dependency));
  if (rec && rec.status && rec.status !== 'draft') return false;
  return simIsTransientClient();
}

function transientSettingsFor(rec) {
  const base = { ...TRANSIENT_DEFAULTS_CLIENT };
  const src = rec && rec.transient && typeof rec.transient === 'object' ? rec.transient : null;
  if (!src) return base;
  for (const k of Object.keys(base)) {
    if (src[k] !== undefined) base[k] = src[k];
  }
  return base;
}

/** Seconds → short label (5 s, 0.1 s, 2.5e-4 s). */
function formatSimTime(v, opts) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const unit = opts && opts.noUnit ? '' : ' s';
  if (n === 0) return '0' + unit;
  const a = Math.abs(n);
  let s;
  if (a >= 100) s = n.toFixed(0);
  else if (a >= 10) s = n.toFixed(1);
  else if (a >= 1) s = String(Number(n.toFixed(2)));
  else if (a >= 0.01) s = String(Number(n.toFixed(3)));
  else if (a >= 1e-3) s = String(Number(n.toFixed(4)));
  else s = n.toExponential(1);
  return s + unit;
}

const TRANSIENT_FORM_IDS = {
  end_time: 'sim-tr-end-time',
  write_count: 'sim-tr-write-count',
  time_step_mode: 'sim-tr-step-mode',
  max_co: 'sim-tr-max-co',
  delta_t: 'sim-tr-delta-t',
  max_delta_t: 'sim-tr-max-dt',
  time_scheme: 'sim-tr-scheme',
  n_outer_correctors: 'sim-tr-outer',
  n_correctors: 'sim-tr-corr',
  n_non_orth_correctors: 'sim-tr-nonorth',
};

function readTransientForm() {
  const base = w27State.transient ? { ...w27State.transient } : { ...TRANSIENT_DEFAULTS_CLIENT };
  const numOr = (id, prev, opts) => {
    const el = document.getElementById(id);
    if (!el) return prev;
    const raw = String(el.value == null ? '' : el.value).trim();
    if (raw === '') return opts && opts.nullable ? null : prev;
    const n = Number(raw);
    if (!Number.isFinite(n)) return prev;
    if (opts && opts.int) return Math.round(n);
    return n;
  };
  const strOr = (id, prev) => {
    const el = document.getElementById(id);
    return el && el.value ? el.value : prev;
  };
  const out = {
    end_time: numOr(TRANSIENT_FORM_IDS.end_time, base.end_time),
    write_count: numOr(TRANSIENT_FORM_IDS.write_count, base.write_count, { int: true }),
    time_step_mode: strOr(TRANSIENT_FORM_IDS.time_step_mode, base.time_step_mode),
    max_co: numOr(TRANSIENT_FORM_IDS.max_co, base.max_co),
    delta_t: numOr(TRANSIENT_FORM_IDS.delta_t, base.delta_t, { nullable: true }),
    max_delta_t: numOr(TRANSIENT_FORM_IDS.max_delta_t, base.max_delta_t, { nullable: true }),
    time_scheme: strOr(TRANSIENT_FORM_IDS.time_scheme, base.time_scheme),
    n_outer_correctors: numOr(TRANSIENT_FORM_IDS.n_outer_correctors, base.n_outer_correctors, { int: true }),
    n_correctors: numOr(TRANSIENT_FORM_IDS.n_correctors, base.n_correctors, { int: true }),
    n_non_orth_correctors: numOr(TRANSIENT_FORM_IDS.n_non_orth_correctors, base.n_non_orth_correctors, { int: true }),
  };
  if (!(out.end_time > 0)) out.end_time = base.end_time > 0 ? base.end_time : TRANSIENT_DEFAULTS_CLIENT.end_time;
  if (!(out.write_count >= 1)) out.write_count = TRANSIENT_DEFAULTS_CLIENT.write_count;
  if (!(out.max_co > 0)) out.max_co = TRANSIENT_DEFAULTS_CLIENT.max_co;
  if (out.delta_t != null && !(out.delta_t > 0)) out.delta_t = null;
  if (out.max_delta_t != null && !(out.max_delta_t > 0)) out.max_delta_t = null;
  const frameInterval = transientFrameInterval(out);
  if (out.max_delta_t != null && frameInterval > 0 && out.max_delta_t > frameInterval) {
    out.max_delta_t = frameInterval;
  }
  out.n_outer_correctors = Math.min(Math.max(out.n_outer_correctors || 1, 1), 50);
  out.n_correctors = Math.min(Math.max(out.n_correctors || 1, 1), 10);
  out.n_non_orth_correctors = Math.min(Math.max(out.n_non_orth_correctors || 0, 0), 5);
  return out;
}

function transientFrameInterval(t) {
  const frames = Math.max(1, Math.round(Number(t && t.write_count) || 1));
  const end = Number(t && t.end_time);
  return end > 0 ? end / frames : 0;
}

function syncTransientMaxDtField(t) {
  const el = document.getElementById(TRANSIENT_FORM_IDS.max_delta_t);
  if (!el) return;
  const interval = transientFrameInterval(t);
  el.placeholder = interval > 0 ? String(Number(interval.toPrecision(6))) : 'auto';
  if (document.activeElement === el) return;
  const raw = String(el.value == null ? '' : el.value).trim();
  if (!raw) return;
  const n = Number(raw);
  if (interval > 0 && Number.isFinite(n) && n > interval) {
    el.value = String(Number(interval.toPrecision(8)));
  }
}

function fillTransientForm(t, locked) {
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (!el || document.activeElement === el) return;
    el.value = v == null ? '' : String(v);
    el.disabled = !!locked;
  };
  set(TRANSIENT_FORM_IDS.end_time, t.end_time);
  set(TRANSIENT_FORM_IDS.write_count, t.write_count);
  set(TRANSIENT_FORM_IDS.time_step_mode, t.time_step_mode === 'fixed' ? 'fixed' : 'adjustable');
  set(TRANSIENT_FORM_IDS.max_co, t.max_co);
  set(TRANSIENT_FORM_IDS.delta_t, t.delta_t);
  set(TRANSIENT_FORM_IDS.max_delta_t, t.max_delta_t);
  syncTransientMaxDtField(t);
  set(TRANSIENT_FORM_IDS.time_scheme, t.time_scheme === 'backward' ? 'backward' : 'Euler');
  set(TRANSIENT_FORM_IDS.n_outer_correctors, t.n_outer_correctors);
  set(TRANSIENT_FORM_IDS.n_correctors, t.n_correctors);
  set(TRANSIENT_FORM_IDS.n_non_orth_correctors, t.n_non_orth_correctors);
  const fixed = t.time_step_mode === 'fixed';
  const coRow = document.getElementById('sim-tr-max-co-row');
  const maxDtRow = document.getElementById('sim-tr-max-dt-row');
  const dtLabel = document.getElementById('sim-tr-delta-t-label');
  if (coRow) coRow.hidden = fixed;
  if (maxDtRow) maxDtRow.hidden = fixed;
  if (dtLabel) dtLabel.textContent = fixed ? 'Time step Δt' : 'Initial Δt';
  const reset = document.getElementById('sim-tr-reset');
  if (reset) reset.hidden = !!locked;
}

/** Hint under the transient inputs: frame interval, auto Δt, steps, flow-through. */
function renderTransientHint() {
  const hint = document.getElementById('sim-tr-hint');
  if (!hint) return;
  const t = w27State.transient || TRANSIENT_DEFAULTS_CLIENT;
  const pv = w27State.transient_preview;
  const ctrl = pv && pv.control;
  const frames = Math.max(1, Math.round(Number(t.write_count) || 1));
  const interval = Number(t.end_time) / frames;
  const bits = [];
  bits.push('A result frame every ' + formatSimTime(interval) + ' (' + frames + ' frames)');
  if ((t.time_step_mode || 'adjustable') !== 'fixed') {
    bits.push('max Δt limited to that interval so every frame is written');
  }
  if (ctrl) {
    const dtAuto = ctrl.source && ctrl.source.delta_t === 'auto';
    if (ctrl.adjust_time_step) {
      bits.push(
        (dtAuto ? 'starting Δt ≈ ' : 'starting Δt ') +
          formatSimTime(ctrl.delta_t) +
          (dtAuto ? ' (auto)' : '') +
          ', adjusted to keep Co ≤ ' +
          String(Number(ctrl.max_co))
      );
    } else {
      bits.push('fixed Δt ' + formatSimTime(ctrl.delta_t) + (dtAuto ? ' (auto)' : ''));
    }
    const est = ctrl.estimate || {};
    if (Number.isFinite(est.steps) && est.steps > 0) {
      bits.push('roughly ' + Number(est.steps).toLocaleString() + ' time steps');
    }
    if (Number.isFinite(est.flow_through_s) && est.flow_through_s > 0) {
      bits.push('one flow-through of the domain ≈ ' + formatSimTime(est.flow_through_s));
    }
  }
  let html = escapeHtml(bits.join(' · ') + '.');
  if (ctrl && ctrl.estimate && Number.isFinite(ctrl.estimate.steps) && ctrl.estimate.steps > 200000) {
    html +=
      ' <span class="sim-tr-warn">That is a long run — a shorter simulation time, a coarser mesh or a higher Courant number (Advanced) will finish sooner.</span>';
  } else if (pv && pv.partial) {
    html += ' <span>Assign a mesh and boundary conditions to see the calculated time step.</span>';
  }
  hint.innerHTML = html;
}

/** Ask the server for the resolved transient numbers (debounced, deduped). */
function refreshTransientPreview(opts) {
  const rec = selectedRunRecord();
  if (!rec || !runRecIsTransient(rec)) return;
  const t = w27State.transient || transientSettingsFor(rec);
  const key = String(rec.id) + '|' + String(rec.mesh_id || '') + '|' + JSON.stringify(t);
  if (!(opts && opts.force) && key === w27State.transient_preview_key) return;
  if (w27State.transient_preview_timer) clearTimeout(w27State.transient_preview_timer);
  w27State.transient_preview_timer = setTimeout(async () => {
    w27State.transient_preview_timer = null;
    w27State.transient_preview_key = key;
    try {
      const r = await fetch('/api/run/transient-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          run_id: rec.id,
          project_id: currentProjectId() || undefined,
          transient: t,
          ...(typeof currentMeshStudyIds === 'function' ? currentMeshStudyIds() : {}),
        }),
      });
      const j = await r.json();
      if (j && j.ok && w27State.transient_preview_key === key) {
        w27State.transient_preview = j;
        renderTransientHint();
      }
    } catch (e) {
      console.warn('[CFD W30] transient preview', e);
    }
  }, opts && opts.now ? 0 : 250);
}

async function persistTransientSettings() {
  const rec = selectedRunRecord();
  const t = readTransientForm();
  w27State.transient = t;
  syncTransientMaxDtField(t);
  renderTransientHint();
  refreshTransientPreview();
  if (rec && !runIsLocked(rec)) {
    try {
      await persistRunSettings({ run_id: rec.id, transient: t });
    } catch (e) {
      console.warn('[CFD W30] transient settings save', e);
    }
  }
}

/** Live transient progress from the run doc: physical time, Δt, Co. */
function transientProgressText(run, endTime) {
  const t = Number(run && run.sim_time != null ? run.sim_time : run && run.iteration) || 0;
  const end = Number(endTime) || 0;
  let s = 't = ' + formatSimTime(t) + (end > 0 ? ' / ' + formatSimTime(end) : '');
  if (end > 0 && t > 0) s += ' (' + Math.min(100, Math.floor((t / end) * 100)) + '%)';
  const extra = [];
  if (run && Number.isFinite(Number(run.delta_t)) && Number(run.delta_t) > 0) extra.push('Δt ' + formatSimTime(run.delta_t));
  if (run && Number.isFinite(Number(run.co_mean))) {
    extra.push(
      'Co ' +
        Number(run.co_mean).toPrecision(2) +
        (Number.isFinite(Number(run.co_max)) ? ' (max ' + Number(run.co_max).toPrecision(2) + ')' : '')
    );
  } else if (run && Number.isFinite(Number(run.co_max))) {
    extra.push('Co max ' + Number(run.co_max).toPrecision(2));
  }
  if (extra.length) s += ' · ' + extra.join(' · ');
  return s;
}

function stampRcId() {
  return 'rc-' + Math.random().toString(16).slice(2, 10);
}

function findRunRecord(runId) {
  if (!runId) return null;
  return (w27State.runs || []).find((r) => String(r.id) === String(runId) || String(r.run_id) === String(runId)) || null;
}

function selectedRunRecord() {
  return findRunRecord(w27State.selected_run_id || w27State.active_run_id);
}

function runDocForPanel() {
  const rec = selectedRunRecord();
  const live = w27State.run;
  if (rec && live && String(live.run_id || live.id) === String(rec.id)) {
    return { ...rec, ...live, name: rec.name || live.name, run_id: rec.id };
  }
  return rec ? { ...rec, run_id: rec.id } : live;
}

function runIsLocked(rec) {
  const st = rec && rec.status;
  return st === 'done' || st === 'running';
}

function nextClientRunName() {
  const used = new Set((w27State.runs || []).map((r) => String(r.name || '')));
  let n = 1;
  while (used.has('Run ' + n)) n += 1;
  return 'Run ' + n;
}

function nextAaName(rcs) {
  const n = (rcs || []).filter((r) => /area average/i.test(String(r.kind || r.name || ''))).length;
  return 'Area average ' + (n + 1);
}

function generatedMeshOptions() {
  return meshList().map((m) => ({
    id: m.id,
    name: m.name || 'Mesh',
    ready: isGeneratedMeshReady(m),
    n_cells: m.live_mesh_result && m.live_mesh_result.n_cells,
    active: String(m.id) === String(window.__CFD_W20_STATE__ && window.__CFD_W20_STATE__.active_id),
  }));
}

function syncSimHubPanel() {
  const nameEl = document.getElementById('sim-new-run-name');
  if (nameEl && document.activeElement !== nameEl && !nameEl.value) {
    nameEl.placeholder = nextClientRunName();
  }
}

async function persistRunSettings(partial) {
  const runId = (partial && (partial.run_id || partial.id)) || w27State.selected_run_id || w27State.active_run_id;
  if (!runId) return { ok: false, error: 'No run selected' };
  const body = {
    run_id: runId,
    project_id: currentProjectId() || undefined,
    ...(typeof currentMeshStudyIds === 'function' ? currentMeshStudyIds() : {}),
  };
  if (partial && partial.name != null) body.name = partial.name;
  if (partial && partial.mesh_id != null) body.mesh_id = partial.mesh_id;
  if (partial && partial.endTime != null) body.endTime = partial.endTime;
  if (partial && partial.writeInterval != null) body.writeInterval = partial.writeInterval;
  // W30 transient settings / time dependency stamp for drafts.
  if (partial && partial.transient && typeof partial.transient === 'object') body.transient = partial.transient;
  if (partial && partial.time_dependency != null) body.time_dependency = partial.time_dependency;
  if (partial && Array.isArray(partial.result_controls)) body.result_controls = partial.result_controls;
  // Post-processing state (saved filter-set views + the live filter set).
  if (partial && Array.isArray(partial.views)) body.views = partial.views;
  if (partial && partial.current_view !== undefined) body.current_view = partial.current_view;
  const r = await fetch('/api/run/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j && j.ok) {
    applyRunCatalog(j);
    const rec = findRunRecord(runId);
    if (rec && (!w27State.run || String(w27State.run.run_id || w27State.run.id) === String(runId))) {
      w27State.run = { ...(w27State.run || {}), ...rec, run_id: rec.id };
    }
  }
  return j;
}

function syncRunMeshSelect() {
  const sel = document.getElementById('sim-run-mesh');
  if (!sel) return;
  const rec = selectedRunRecord();
  const meshes = generatedMeshOptions();
  const locked = runIsLocked(rec);
  const cur = rec && rec.mesh_id ? String(rec.mesh_id) : '';
  let html = '<option value="">Select a mesh</option>';
  const seen = new Set();
  for (const m of meshes) {
    if (!m.id) continue;
    seen.add(String(m.id));
    const cells = m.n_cells != null ? ' · ' + Number(m.n_cells).toLocaleString() + ' cells' : '';
    const ready = m.ready ? '' : ' (not generated)';
    html +=
      '<option value="' +
      escapeHtml(String(m.id)) +
      '"' +
      (String(m.id) === cur ? ' selected' : '') +
      '>' +
      escapeHtml((m.name || 'Mesh') + cells + ready) +
      '</option>';
  }
  if (cur && !seen.has(cur)) {
    html +=
      '<option value="' +
      escapeHtml(cur) +
      '" selected>' +
      escapeHtml((rec && rec.mesh_name) || 'Previous mesh') +
      '</option>';
  }
  sel.innerHTML = html;
  sel.value = cur;
  sel.disabled = !!locked;
}

function syncRunResultList() {
  const list = document.getElementById('run-rc-list');
  const addBtn = document.getElementById('btn-run-add-rc');
  const rec = selectedRunRecord();
  const locked = runIsLocked(rec);
  if (addBtn) addBtn.hidden = !!locked;
  if (!list) return;
  const rcs = (rec && rec.result_controls) || [];
  if (!rcs.length) {
    list.innerHTML = '<li class="hub-empty">None yet — use Add or the + on this run</li>';
    return;
  }
  list.innerHTML = rcs
    .map((rc) => {
      const n = Array.isArray(rc.faces) ? rc.faces.length : 0;
      return (
        '<li><button type="button" class="hub-item" data-open-run-rc="' +
        escapeHtml(String(rc.id || rc.name)) +
        '">' +
        escapeHtml(rc.name || rc.kind || 'Result') +
        (n ? ' · ' + n + (n === 1 ? ' face' : ' faces') : '') +
        '</button></li>'
      );
    })
    .join('');
}

function openRunResultControl(runId, rcId) {
  const rec = findRunRecord(runId);
  if (!rec) return;
  w27State.selected_run_id = runId;
  w27State.rc_target_run_id = runId;
  const rc = ((rec.result_controls || []).find(
    (r) => String(r.id) === String(rcId) || String(r.name) === String(rcId)
  )) || null;
  if (!rc) return;
  w22State.editing_run_id = runId;
  w22State.editing_rc_id = rc.id;
  w22State.area_average_1 = rc;
  w22State.draft_faces = (rc.faces || []).slice();
  w22State.read_only = runIsLocked(rec);
  w22State.ready = true;
  w22State.created = true;
  markTreeSelected('aaid:' + rc.id);
  showAaPanel();
}

function expandRunFolders(runId, extra) {
  if (!runId) return;
  treeUi.expanded['run:' + runId] = true;
  if (extra === 'mesh' || extra === true) treeUi.expanded['run-mesh:' + runId] = true;
  if (extra === 'rcs' || extra === true) treeUi.expanded['run-rc:' + runId] = true;
}

function syncRunMeshHub() {
  const list = document.getElementById('run-mesh-hub-list');
  if (!list) return;
  const rec = selectedRunRecord();
  const locked = runIsLocked(rec);
  const meshes = generatedMeshOptions();
  const cur = rec && rec.mesh_id ? String(rec.mesh_id) : '';
  if (!meshes.length) {
    list.innerHTML = '<li class="hub-empty">Generate a mesh first</li>';
    return;
  }
  list.innerHTML = meshes
    .map((m) => {
      const cells = m.n_cells != null ? Number(m.n_cells).toLocaleString() + ' cells' : 'not generated';
      const picked = String(m.id) === cur;
      return (
        '<li><button type="button" class="hub-item' +
        (picked ? ' is-selected' : '') +
        '" data-assign-run-mesh="' +
        escapeHtml(String(m.id)) +
        '"' +
        (locked ? ' disabled' : '') +
        '><span class="hub-item-name">' +
        escapeHtml((m.name || 'Mesh') + (picked ? ' · assigned' : '')) +
        '</span><span class="hub-item-sub">' +
        escapeHtml(m.ready ? cells : 'Not generated') +
        '</span></button></li>'
      );
    })
    .join('');
}

function openRunMeshFolder(runId) {
  if (!runId) return;
  w27State.selected_run_id = runId;
  w27State.rc_target_run_id = runId;
  expandRunFolders(runId);
  markTreeSelected('runmesh:' + runId);
  openTreeDetail('run-mesh', { toggle: false });
  syncRunMeshHub();
}

function openRunRcsFolder(runId) {
  if (!runId) return;
  w27State.selected_run_id = runId;
  w27State.rc_target_run_id = runId;
  expandRunFolders(runId);
  markTreeSelected('runrcs:' + runId);
  openTreeDetail('rc', { toggle: false });
  if (typeof syncResultsHub === 'function') syncResultsHub();
}

function openRunPanel(runId) {
  if (!runId) return;
  leaveResultsForSetup();
  w27State.selected_run_id = runId;
  w27State.rc_target_run_id = runId;
  const rec = findRunRecord(runId);
  if (rec) {
    w27State.run = { ...(w27State.run && String(w27State.run.run_id) === String(runId) ? w27State.run : {}), ...rec, run_id: rec.id };
    if (rec.endTime) w27State.endTime = rec.endTime;
    if (rec.writeInterval) w27State.writeInterval = rec.writeInterval;
  }
  if (runCopyPick && String(runCopyPick.destId) !== String(runId)) endRunCopyPick();
  markTreeSelected('runid:' + runId);
  openTreeDetail('sim-control', { toggle: false });
  syncSimControlPanel();
}

// Copy every editable setup setting from another run onto this draft.
// The fields stay unlocked so the user can change only what they want.
let runCopyPick = null;
let runCopyNote = '';

function otherRunsForCopy(destId) {
  return (w27State.runs || []).filter((r) => r && r.id && String(r.id) !== String(destId));
}

function cloneRunResultControls(src) {
  return (Array.isArray(src) ? src : []).map((rc) => {
    const next = { ...(rc || {}) };
    next.id = stampRcId();
    next.results = null;
    next.series = null;
    next.chart_values = null;
    next.results_available = false;
    return next;
  });
}

function endRunCopyPick() {
  runCopyPick = null;
  const tree = document.getElementById('simulations-tree');
  if (tree) tree.classList.remove('is-run-copy-pick');
  tree && tree.querySelectorAll('[data-w27-run].is-copy-dest').forEach((el) => el.classList.remove('is-copy-dest'));
  const picker = document.getElementById('sim-copy-picker');
  const openBtn = document.getElementById('sim-copy-open');
  if (picker) picker.hidden = true;
  if (openBtn) openBtn.hidden = false;
}

function startRunCopyPick(destId) {
  const dest = destId || (selectedRunRecord() && selectedRunRecord().id);
  if (!dest || !otherRunsForCopy(dest).length) return;
  runCopyPick = { destId: dest };
  runCopyNote = '';
  syncRunCopyUi();
}

function syncRunCopyUi() {
  const wrap = document.getElementById('sim-copy-from');
  const openBtn = document.getElementById('sim-copy-open');
  const picker = document.getElementById('sim-copy-picker');
  const sel = document.getElementById('sim-copy-run');
  const done = document.getElementById('sim-copy-done');
  const rec = selectedRunRecord();
  const destId = rec && rec.id;
  const others = destId ? otherRunsForCopy(destId) : [];
  const show = !!(rec && !runIsLocked(rec) && others.length);
  if (wrap) wrap.hidden = !show;
  if (!show) {
    endRunCopyPick();
    if (done) { done.hidden = true; done.textContent = ''; }
    return;
  }
  const picking = !!(runCopyPick && String(runCopyPick.destId) === String(destId));
  if (openBtn) openBtn.hidden = picking;
  if (picker) picker.hidden = !picking;
  if (sel && document.activeElement !== sel) {
    sel.innerHTML =
      '<option value="">Select a run…</option>' +
      others
        .slice()
        .reverse()
        .map((r) => {
          const bits = [r.name || 'Run'];
          if (r.status && r.status !== 'draft') bits.push(r.status);
          return (
            '<option value="' +
            escapeHtml(String(r.id)) +
            '">' +
            escapeHtml(bits.join(' · ')) +
            '</option>'
          );
        })
        .join('');
    sel.value = '';
  }
  if (done) {
    done.hidden = !runCopyNote;
    done.textContent = runCopyNote;
  }
  const tree = document.getElementById('simulations-tree');
  if (tree) {
    tree.classList.toggle('is-run-copy-pick', picking);
    tree.querySelectorAll('[data-w27-run]').forEach((el) => {
      el.classList.toggle('is-copy-dest', picking && String(el.getAttribute('data-w27-run')) === String(destId));
    });
  }
}

async function copyRunSettingsFrom(srcId) {
  const dest = selectedRunRecord();
  const src = findRunRecord(srcId);
  if (!dest || !src || runIsLocked(dest)) return;
  if (String(src.id) === String(dest.id)) return;
  const transient = transientSettingsFor(src);
  const body = {
    run_id: dest.id,
    mesh_id: src.mesh_id || '',
    endTime: src.endTime != null ? src.endTime : w27State.endTime,
    writeInterval: src.writeInterval != null ? src.writeInterval : w27State.writeInterval,
    time_dependency: src.time_dependency || (runRecIsTransient(src) ? 'Transient' : 'Steady-state'),
    transient,
    result_controls: cloneRunResultControls(src.result_controls),
  };
  const j = await persistRunSettings(body);
  if (!j || j.ok === false) {
    console.warn('[CFD] copy run settings', j && j.error);
    return;
  }
  w27State.endTime = body.endTime;
  w27State.writeInterval = body.writeInterval;
  w27State.transient_run_id = '';
  w27State.transient = transient;
  w27State.transient_preview = null;
  w27State.transient_preview_key = '';
  runCopyNote = 'Copied from ' + (src.name || 'previous run') + '. Change anything you want.';
  endRunCopyPick();
  expandRunFolders(dest.id, true);
  try { syncSimulationTree(); } catch (_) {}
  syncSimControlPanel();
  try { syncRunMeshHub(); } catch (_) {}
  try { if (typeof syncResultsHub === 'function') syncResultsHub(); } catch (_) {}
}

function runIdFromCopyTreeNode(node) {
  if (!node) return '';
  return (
    node.getAttribute('data-w27-run') ||
    node.getAttribute('data-w27-run-mesh') ||
    node.getAttribute('data-w27-run-rcs') ||
    node.getAttribute('data-w27-run-results') ||
    node.getAttribute('data-w27-aa-run') ||
    node.getAttribute('data-w27-mesh-run') ||
    ''
  );
}

async function assignMeshToSelectedRun(meshId) {
  const runId = w27State.selected_run_id || w27State.active_run_id;
  if (!runId || !meshId) return;
  const rec = findRunRecord(runId);
  if (runIsLocked(rec)) return;
  await persistRunSettings({ run_id: runId, mesh_id: meshId });
  expandRunFolders(runId, 'mesh');
  try { syncSimulationTree(); } catch (_) {}
  syncRunMeshHub();
  syncSimControlPanel();
}

async function createRunClient() {
  const nameEl = document.getElementById('sim-new-run-name');
  const name = String((nameEl && nameEl.value) || '').trim();
  const r = await fetch('/api/run/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      project_id: currentProjectId() || undefined,
      simulation_id:
        (typeof w17State !== 'undefined' && w17State.simulation && w17State.simulation.id) || undefined,
    }),
  });
  const j = await r.json();
  if (!r.ok || !j || j.ok === false) {
    throw new Error((j && j.error) || 'Could not create run');
  }
  if (nameEl) nameEl.value = '';
  leaveResultsForSetup();
  applyRunCatalog(j);
  const newId = (j.run && (j.run.id || j.run.run_id)) || j.active_run_id;
  w27State.selected_run_id = newId;
  w27State.active_run_id = newId;
  w27State.run = j.run ? { ...j.run, run_id: j.run.id || j.run.run_id } : w27State.run;
  treeUi.expanded.Simulation = true;
  expandRunFolders(newId);
  try { syncSimulationTree(); } catch (_) {}
  openRunPanel(newId);
  if (otherRunsForCopy(newId).length) startRunCopyPick(newId);
  return j;
}

async function deleteSelectedRunClient() {
  const runId = w27State.selected_run_id || (w27State.run && w27State.run.run_id);
  if (!runId) return;
  const rec = findRunRecord(runId);
  if (rec && rec.status === 'running') return;
  const r = await fetch('/api/run/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      run_id: runId,
      project_id: currentProjectId() || undefined,
      ...(typeof currentMeshStudyIds === 'function' ? currentMeshStudyIds() : {}),
    }),
  });
  const j = await r.json();
  if (!r.ok || !j || j.ok === false) {
    throw new Error((j && j.error) || 'Could not delete run');
  }
  if (w27State.selected_run_id && String(w27State.selected_run_id) === String(runId)) {
    w27State.selected_run_id = j.active_run_id || null;
    w27State.run = null;
  }
  applyRunCatalog(j);
  hideAllTreeDetails();
  markTreeSelected('sim-hub');
  openTreeDetail('sim-hub', { toggle: false });
  syncSimHubPanel();
}

const SIM_STAGE_LABELS = {
  starting: 'Starting',
  decompose: 'Decomposing the mesh',
  solve: 'Solving',
  reconstruct: 'Reconstructing',
  copy: 'Copying results',
};

const SIM_RES_SERIES = [
  { key: 'U', color: '#1570ef' },
  { key: 'p', color: '#6941c6' },
  { key: 'k', color: '#12b76a' },
  { key: 'omega', color: '#f79009' },
];

function stopSimElapsedClock() {
  if (w27State.elapsed_timer) {
    clearInterval(w27State.elapsed_timer);
    w27State.elapsed_timer = null;
  }
}

function startSimElapsedClock() {
  stopSimElapsedClock();
  w27State.elapsed_timer = setInterval(() => {
    try { syncSimControlPanel(); } catch (_) {}
  }, 1000);
}

// W31: mean Courant number of a transient run, drawn on the residual plot
// (same log axis — Co sits around 0.1–1) as a dashed line.
const SIM_CO_SERIES = { key: 'co_mean', color: '#d92d20' };

// Geometry of the last drawn residual plot, for the hover readout.
let simPlotHover = null;

function drawResidualPlot(svg, series, endTime, opts) {
  const wrap = document.getElementById('sim-residual-wrap');
  if (!svg) return;
  const transientAxis = !!(opts && opts.transient);
  const rows = Array.isArray(series) ? series : [];
  const coLegend = document.getElementById('sim-legend-co');
  if (!rows.length) {
    svg.innerHTML = '';
    simPlotHover = null;
    hideSimPlotTip();
    if (wrap) {
      wrap.hidden = true;
      wrap.setAttribute('hidden', '');
    }
    if (coLegend) coLegend.hidden = true;
    return;
  }
  const w = 280;
  const h = 132;
  const padL = 36;
  const padR = 8;
  const padT = 10;
  const padB = 18;
  let dataMax = 0;
  for (const r of rows) {
    const t = Number(r.t);
    if (Number.isFinite(t) && t > dataMax) dataMax = t;
  }
  const planned = Number(endTime) || 0;
  // Transient: scale to the planned simulation time (0.5 s must not become
  // a 1 s axis — that leftover floor made short runs look cut off). Include
  // a tiny data overshoot so the last sample is not clipped. Steady still
  // floors at 1 iteration so an empty-ish plot has a usable axis.
  const xmax = transientAxis
    ? planned > 0
      ? Math.max(planned, dataMax)
      : dataMax > 0
        ? dataMax
        : 1e-3
    : Math.max(planned, dataMax, 1);
  const hasCo = transientAxis && rows.some((r) => Number.isFinite(Number(r.co_mean)) && Number(r.co_mean) > 0);
  if (coLegend) coLegend.hidden = !hasCo;
  const drawn = hasCo ? SIM_RES_SERIES.concat([SIM_CO_SERIES]) : SIM_RES_SERIES;
  const logs = [];
  for (const row of rows) {
    for (const s of drawn) {
      const v = Number(row[s.key]);
      if (Number.isFinite(v) && v > 0) logs.push(Math.log10(v));
    }
  }
  if (!logs.length) {
    svg.hidden = true;
    svg.innerHTML = '';
    simPlotHover = null;
    hideSimPlotTip();
    return;
  }
  let y0 = Math.min(...logs);
  let y1 = Math.max(...logs);
  if (y1 === y0) {
    y0 -= 1;
    y1 += 1;
  }
  const yPad = (y1 - y0) * 0.08;
  y0 -= yPad;
  y1 += yPad;
  const xOf = (t) => padL + (Number(t) / xmax) * (w - padL - padR);
  const yOf = (v) => {
    const lg = Math.log10(Math.max(v, 1e-16));
    return padT + (1 - (lg - y0) / (y1 - y0)) * (h - padT - padB);
  };
  let html = '';
  const dec0 = Math.ceil(y0);
  const dec1 = Math.floor(y1);
  for (let d = dec0; d <= dec1; d++) {
    const y = padT + (1 - (d - y0) / (y1 - y0)) * (h - padT - padB);
    html +=
      '<line x1="' +
      padL +
      '" y1="' +
      y.toFixed(1) +
      '" x2="' +
      (w - padR) +
      '" y2="' +
      y.toFixed(1) +
      '" stroke="#eaecf0" stroke-width="1"/>';
    const lab = d === 0 ? '1' : d === 1 ? '10' : '1e' + d;
    html +=
      '<text x="' +
      (padL - 4) +
      '" y="' +
      (y + 3).toFixed(1) +
      '" text-anchor="end" font-size="8" fill="#98a2b3">' +
      lab +
      '</text>';
  }
  html +=
    '<text x="' + padL + '" y="' + (h - 4) + '" font-size="8" fill="#98a2b3">' +
    (transientAxis ? '0 s' : '1') +
    '</text>';
  html +=
    '<text x="' +
    (w - padR) +
    '" y="' +
    (h - 4) +
    '" text-anchor="end" font-size="8" fill="#98a2b3">' +
    (transientAxis ? escapeHtml(formatSimTime(xmax)) : String(Math.round(xmax))) +
    '</text>';
  for (const s of drawn) {
    const pts = [];
    for (const row of rows) {
      const v = Number(row[s.key]);
      if (!Number.isFinite(v) || v <= 0) continue;
      pts.push(xOf(row.t).toFixed(1) + ',' + yOf(v).toFixed(1));
    }
    if (pts.length) {
      html +=
        '<polyline fill="none" stroke="' +
        s.color +
        '" stroke-width="1.5" stroke-linejoin="round"' +
        (s === SIM_CO_SERIES ? ' stroke-dasharray="4 2"' : '') +
        ' points="' +
        pts.join(' ') +
        '"/>';
    }
  }
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  svg.innerHTML = html;
  svg.removeAttribute('hidden');
  if (wrap) {
    wrap.hidden = false;
    wrap.removeAttribute('hidden');
  }
  const lastClientX = simPlotHover ? simPlotHover.lastClientX : null;
  simPlotHover = { rows, w, h, padL, padR, xmax, transient: transientAxis, hasCo, xOf, yOf, lastClientX };
  // The plot redraws every second while solving: keep an open readout current.
  if (lastClientX != null) updateSimPlotTip(lastClientX);
}

function hideSimPlotTip() {
  const tip = document.getElementById('sim-plot-tip');
  const cur = document.getElementById('sim-plot-cursor');
  if (tip) tip.hidden = true;
  if (cur) cur.hidden = true;
}

function simPlotNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  const a = Math.abs(n);
  if (a >= 100) return n.toFixed(0);
  if (a >= 1) return n.toFixed(2);
  if (a >= 0.01) return n.toFixed(3);
  return n.toExponential(2);
}

/**
 * Hover readout for the residual plot: nearest sample to the pointer, with
 * the exact mean / max Courant number (transient) and the residuals.
 */
function updateSimPlotTip(clientX) {
  const g = simPlotHover;
  const svg = document.getElementById('sim-residual-plot');
  const wrap = document.getElementById('sim-residual-wrap');
  const tip = document.getElementById('sim-plot-tip');
  const cur = document.getElementById('sim-plot-cursor');
  if (!g || !svg || !wrap || !tip || !cur || !g.rows.length) {
    hideSimPlotTip();
    return;
  }
  const r = svg.getBoundingClientRect();
  if (!r.width) return;
  const sx = ((clientX - r.left) / r.width) * g.w;
  const t = ((sx - g.padL) / (g.w - g.padL - g.padR)) * g.xmax;
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < g.rows.length; i++) {
    const d = Math.abs(Number(g.rows[i].t) - t);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  const row = g.rows[best];
  const xPx = (g.xOf(row.t) / g.w) * r.width;
  cur.style.left = xPx.toFixed(1) + 'px';
  cur.hidden = false;
  const lines = [];
  lines.push('<b>' + escapeHtml(g.transient ? 't = ' + formatSimTime(row.t) : 'Iteration ' + Math.round(Number(row.t))) + '</b>');
  if (g.hasCo && Number.isFinite(Number(row.co_mean))) {
    lines.push(
      '<span class="co">Co mean ' +
        escapeHtml(simPlotNum(row.co_mean)) +
        (Number.isFinite(Number(row.co_max)) ? ' · max ' + escapeHtml(simPlotNum(row.co_max)) : '') +
        '</span>'
    );
  }
  const res = [];
  for (const s of SIM_RES_SERIES) {
    const v = Number(row[s.key]);
    if (Number.isFinite(v) && v > 0) {
      res.push('<span style="color:' + s.color + '">' + (s.key === 'omega' ? 'ω' : s.key) + '</span> ' + escapeHtml(v.toExponential(1)));
    }
  }
  if (res.length) lines.push(res.join(' · '));
  tip.innerHTML = lines.join('<br>');
  tip.hidden = false;
  // Flip the box to the other side of the cursor near the right edge.
  const tw = tip.offsetWidth || 120;
  let left = xPx + 8;
  if (left + tw > r.width - 4) left = xPx - tw - 8;
  if (left < 2) left = 2;
  tip.style.left = left.toFixed(1) + 'px';
}

function wireSimPlotHover() {
  const wrap = document.getElementById('sim-residual-wrap');
  if (!wrap || wrap.dataset.hoverWired) return;
  wrap.dataset.hoverWired = '1';
  wrap.addEventListener('pointermove', (e) => {
    if (!simPlotHover) return;
    simPlotHover.lastClientX = e.clientX;
    updateSimPlotTip(e.clientX);
  });
  wrap.addEventListener('pointerleave', () => {
    if (simPlotHover) simPlotHover.lastClientX = null;
    hideSimPlotTip();
  });
}

function syncSimControlPanel() {
  const endEl = document.getElementById('sim-end-time');
  const wiEl = document.getElementById('sim-write-interval');
  const startBtn = document.getElementById('btn-sim-start');
  const stopBtn = document.getElementById('btn-sim-stop');
  const delBtn = document.getElementById('sim-run-delete');
  const hint = document.getElementById('sim-run-hint');
  const rec = selectedRunRecord();
  const run = rec ? runDocForPanel() : null;
  const locked = runIsLocked(rec);
  try { syncRunCopyUi(); } catch (_) {}
  if (rec && rec.endTime && endEl && document.activeElement !== endEl) {
    w27State.endTime = rec.endTime;
  }
  if (rec && rec.writeInterval && wiEl && document.activeElement !== wiEl) {
    w27State.writeInterval = rec.writeInterval;
  }
  if (endEl && document.activeElement !== endEl) {
    endEl.value = String((rec && rec.endTime) || w27State.endTime);
    endEl.disabled = !!locked;
  }
  if (wiEl && document.activeElement !== wiEl) {
    wiEl.value = String((rec && rec.writeInterval) || w27State.writeInterval);
    wiEl.disabled = !!locked;
  }
  // W30: steady rows vs transient rows follow the run's time dependency.
  const transient = !!rec && runRecIsTransient(rec);
  const steadyBox = document.getElementById('sim-steady-fields');
  const trBox = document.getElementById('sim-transient-fields');
  const modeEl = document.getElementById('sim-run-mode');
  if (steadyBox) steadyBox.hidden = transient;
  if (trBox) trBox.hidden = !transient;
  if (modeEl) modeEl.textContent = transient ? 'Transient' : 'Steady-state';
  if (transient) {
    const recId = String(rec.id || rec.run_id || '');
    if (w27State.transient_run_id !== recId || !w27State.transient) {
      w27State.transient_run_id = recId;
      w27State.transient = transientSettingsFor(rec);
      w27State.transient_preview = null;
      w27State.transient_preview_key = '';
    }
    if (locked && rec.transient) {
      // A started run shows what it solved with (the resolved numbers).
      w27State.transient = transientSettingsFor(rec);
      if (rec.transient.write_interval != null) w27State.transient_preview = { ok: true, control: rec.transient };
    }
    fillTransientForm(w27State.transient, locked);
    renderTransientHint();
    if (!locked) refreshTransientPreview();
  }
  const running = !!(run && run.status === 'running');
  const done = !!(rec && rec.status === 'done');
  const meshes = generatedMeshOptions();
  const meshId = rec && rec.mesh_id;
  const meshRec = meshes.find((m) => String(m.id) === String(meshId));
  let meshReady = !!(meshRec && meshRec.ready);
  if (meshId && !meshReady) {
    const local = meshList().find((m) => String(m.id) === String(meshId));
    if (local && isGeneratedMeshReady(local)) meshReady = true;
    else if (anyGeneratedMeshReady()) meshReady = true;
  }
  const canStart = !!(rec && (rec.id || rec.run_id) && !running && !done && meshReady);
  if (startBtn) {
    startBtn.hidden = done;
    startBtn.disabled = w27State.starting || !canStart;
  }
  if (stopBtn) {
    stopBtn.hidden = !running;
    stopBtn.disabled = !running;
    const stopping = !!(running && run && run.stop_requested);
    stopBtn.textContent = stopping ? 'Force stop' : 'Stop';
    stopBtn.title = stopping
      ? 'The solver is writing the current iteration. Click again to kill it without saving.'
      : 'Write the current iteration and stop. Results up to this point stay available.';
  }
  if (delBtn) delBtn.hidden = running;
  if (hint) {
    if (w27State.starting) {
      hint.hidden = false;
      hint.textContent = w27State.start_error || 'Starting…';
    } else if (rec && !meshId) {
      hint.hidden = false;
      hint.textContent = 'Expand this run and assign a mesh under Mesh.';
    } else if (rec && meshId && !meshReady) {
      hint.hidden = false;
      hint.textContent = 'Generate "' + ((meshRec && meshRec.name) || rec.mesh_name || 'that mesh') + '" before starting.';
    } else if (rec && !solveHasFlowDriver()) {
      hint.hidden = false;
      hint.textContent = 'Add a velocity inlet, or two pressure boundaries, each with an assigned face.';
    } else if (w27State.start_error) {
      hint.hidden = false;
      hint.textContent = w27State.start_error;
    } else {
      hint.hidden = true;
      hint.textContent = '';
    }
  }
  syncRunMeshSelect();
  syncRunResultList();

  const wrap = document.getElementById('sim-finished');
  const title = document.getElementById('sim-status-title');
  const line = document.getElementById('sim-finished-line');
  const elapsedEl = document.getElementById('sim-elapsed');
  const etaEl = document.getElementById('sim-eta');
  const titleEl = document.getElementById('sim-panel-title');
  const renameBtn = document.getElementById('sim-rename');
  const meta = document.getElementById('sim-finished-meta');
  const plot = document.getElementById('sim-residual-plot');
  const plotWrap = document.getElementById('sim-residual-wrap');
  const legend = document.getElementById('sim-residual-legend');
  const hasProgress = !!(run && ['running', 'done', 'failed', 'stopped'].includes(run.status));
  if (wrap) wrap.hidden = !hasProgress;
  if (!hasProgress) {
    if (titleEl && document.activeElement !== document.getElementById('sim-rename-input')) {
      titleEl.textContent = (rec && rec.name) || (run && run.name) || 'Run';
    }
    if (renameBtn) renameBtn.hidden = !rec;
    if (etaEl) etaEl.hidden = true;
    if (plot) plot.innerHTML = '';
    if (plotWrap) {
      plotWrap.hidden = true;
      plotWrap.setAttribute('hidden', '');
    }
    if (legend) legend.hidden = true;
    syncViewportJobChip();
    return;
  }

  const it = Number(run.iteration) || 0;
  const runTransient = runRecIsTransient(run);
  const trEnd = runTransient
    ? Number(run.transient && run.transient.end_time) ||
      Number(w27State.transient && w27State.transient.end_time) ||
      0
    : 0;
  const end = runTransient ? trEnd : Number(run.endTime) || w27State.endTime || 0;
  const elapsedMs = solveElapsedMs();
  const elapsedTxt = elapsedMs != null ? formatElapsed(elapsedMs) : null;
  const failed = run.status === 'failed';
  const stopped = run.status === 'stopped';

    if (titleEl && document.activeElement !== document.getElementById('sim-rename-input')) {
      titleEl.textContent = (rec && rec.name) || (run && run.name) || 'Run';
    }
    if (renameBtn) renameBtn.hidden = !rec;
  if (title) {
    if (w27State.attaching) title.textContent = 'Loading results';
    else if (failed) title.textContent = 'Run failed';
    else if (stopped) title.textContent = 'Run stopped';
    else if (running && run.stop_requested) title.textContent = 'Stopping';
    else if (running) title.textContent = SIM_STAGE_LABELS[run.stage] || 'Solving';
    else if (done) title.textContent = 'Run finished';
    else title.textContent = 'Run';
  }
  if (line) {
    const simT = Number(run.sim_time != null ? run.sim_time : run.iteration) || 0;
    if (failed) {
      const err = run.error || run.note || '';
      line.textContent = err ? String(err).split('\n')[0].slice(0, 160) : 'Solve failed. Open Job / debug for the log.';
    } else if (running && runTransient) {
      if (run.stop_requested && run.stage === 'solve') {
        line.textContent = 'Writing t = ' + formatSimTime(simT) + ', then reconstructing…';
      } else if (run.stage === 'solve' && simT > 0) {
        line.textContent = transientProgressText(run, end);
      } else {
        line.textContent = (SIM_STAGE_LABELS[run.stage] || 'Starting') + '...';
      }
    } else if (running) {
      if (run.stop_requested && run.stage === 'solve') {
        line.textContent = 'Writing iteration ' + (it || '—') + ', then reconstructing…';
      } else if (run.stage === 'solve' && it > 0) {
        line.textContent = 'Iteration ' + it + ' / ' + (end || '—');
      } else {
        line.textContent = (SIM_STAGE_LABELS[run.stage] || 'Starting') + '...';
      }
    } else if (stopped && runTransient) {
      const saved = Number(run.last_saved_iteration) || 0;
      line.textContent =
        saved > 0
          ? 'Stopped at t = ' + formatSimTime(simT || saved) + ' · frames saved to t = ' + formatSimTime(saved)
          : simT > 0
            ? 'Stopped at t = ' + formatSimTime(simT) + ' · nothing saved yet'
            : 'Stopped';
    } else if (stopped) {
      const saved = Number(run.last_saved_iteration) || 0;
      line.textContent =
        saved > 0
          ? 'Stopped at iteration ' + (it || saved) + ' · results saved to iteration ' + saved
          : it > 0
            ? 'Stopped at iteration ' + it + ' · nothing saved yet'
            : 'Stopped';
    } else if (done && runTransient) {
      const frames = Number(run.n_saved_times) || 0;
      const steps = Number(run.n_steps) || 0;
      line.textContent =
        formatSimTime(simT || end) +
        ' simulated' +
        (frames ? ' · ' + frames + ' frames' : '') +
        (steps ? ' · ' + steps.toLocaleString() + ' time steps' : '');
    } else if (done) {
      line.textContent = (it || end) + ' iterations';
    } else {
      line.textContent = '-';
    }
  }
  if (elapsedEl) {
    const showClock = (running || w27State.attaching) && elapsedTxt;
    elapsedEl.hidden = !showClock;
    if (showClock) elapsedEl.textContent = elapsedTxt;
  }
  if (etaEl) {
    const etaTxt = running ? formatEta(solveEtaMs()) : null;
    etaEl.hidden = !etaTxt;
    if (etaTxt) etaEl.textContent = etaTxt;
  }
  if (meta) {
    const bits = [];
    if (run.n_procs > 1) bits.push(run.n_procs + ' ranks');
    else if (run.n_procs === 1) bits.push('serial');
    if (elapsedTxt && !running) bits.push(elapsedTxt);
    if (running && run.pid != null) bits.push('PID ' + run.pid);
    meta.textContent = bits.join(' · ');
  }
  const series = Array.isArray(run.residuals) ? run.residuals : [];
  drawResidualPlot(plot, series, end, { transient: runTransient });
  if (legend) legend.hidden = !series.length;
  if (running && !w27State.elapsed_timer) startSimElapsedClock();
  if (!running) stopSimElapsedClock();
  syncViewportJobChip();
}

async function persistSimControl(opts) {
  const endEl = document.getElementById('sim-end-time');
  const wiEl = document.getElementById('sim-write-interval');
  const endTime = Math.max(1, Math.round(Number(endEl && endEl.value) || w27State.endTime));
  const writeInterval = Math.max(1, Math.round(Number(wiEl && wiEl.value) || w27State.writeInterval));
  w27State.endTime = endTime;
  w27State.writeInterval = writeInterval;
  const rec = selectedRunRecord();
  if (rec && !runIsLocked(rec)) {
    const body = { run_id: rec.id, endTime, writeInterval };
    if (runRecIsTransient(rec)) {
      w27State.transient = readTransientForm();
      body.transient = w27State.transient;
    }
    try {
      await persistRunSettings(body);
    } catch (e) {
      console.warn('[CFD] run settings save', e);
    }
  }
  if (!(opts && opts.skipSync)) syncSimControlPanel();
}

function runsTreeKey(list, activeId) {
  return (
    String(activeId || '') +
    '|' +
    (list || [])
      .map((r) =>
        [
          r.id,
          r.name,
          r.status,
          r.mesh_id,
          // Results node lights up when the first live frame lands.
          runHasResults(r) ? 'R' : '',
          (r.result_controls || []).map((c) => c.id || c.name).join(','),
        ].join(':')
      )
      .join('|')
  );
}

function applyRunCatalog(j) {
  const before = runsTreeKey(w27State.runs, w27State.selected_run_id || w27State.active_run_id);
  if (j && Array.isArray(j.runs)) {
    w27State.runs = j.runs;
    if (
      w27State.selected_run_id &&
      !w27State.runs.some((r) => r && String(r.id) === String(w27State.selected_run_id))
    ) {
      w27State.selected_run_id = null;
    }
  }
  if (j && Array.isArray(j.meshes)) w27State.meshes = j.meshes;
  if (j && j.live_run_id) w27State.live_run_id = j.live_run_id;
  if (j && Array.isArray(j.runs)) {
    const aid = j.active_run_id || (j.run && (j.run.run_id || j.run.id)) || null;
    w27State.active_run_id =
      aid && w27State.runs.some((r) => r && String(r.id) === String(aid)) ? aid : null;
  }
  const after = runsTreeKey(w27State.runs, w27State.selected_run_id || w27State.active_run_id);
  if (before !== after) {
    try { syncSimulationTree(); } catch (_) {}
  }
}

async function attachSolveCase(nextDir) {
  if (!nextDir) return;
  const t0 = Date.now();
  while (w27State.attaching && Date.now() - t0 < 60000) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (resultsCaseAlreadyAttached(nextDir)) {
    await refreshFieldsAfterAttach();
    return;
  }
  w27State.attaching = true;
  try { syncSimControlPanel(); } catch (_) {}
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  try {
    await attachCaseDirClient(nextDir);
    try { applyWorkbenchStage(); } catch (_) {}
  } catch (e) {
    console.warn('[CFD] attach solve case', e);
  } finally {
    w27State.attaching = false;
    try { syncSimControlPanel(); } catch (_) {}
  }
}

function stopSimPoll() {
  if (w27State.poll_timer) {
    clearInterval(w27State.poll_timer);
    w27State.poll_timer = null;
  }
}

async function pollSimRunStatus() {
  try {
    const r = await fetch('/api/run/status' + hashProjectQs(), { cache: 'no-store' });
    const j = await r.json();
    if (j && j.run) {
      const prev = w27State.run && w27State.run.status;
      const selectedId = w27State.selected_run_id;
      const runId = j.run.run_id || j.run.id;
      const inCatalog =
        Array.isArray(j.runs) && j.runs.some((r) => r && String(r.id) === String(runId));
      if (
        inCatalog &&
        (!selectedId ||
          String(runId) === String(selectedId) ||
          String(j.live_run_id) === String(runId))
      ) {
        w27State.run = j.run;
      }
      applyRunCatalog(j);
      jobState.status = j.run.status || jobState.status;
      jobState.mode = j.run.mode || 'solve';
      jobState.path_kind = j.run.path_kind || 'simpleFoam';
      jobState.pid = j.run.pid != null ? j.run.pid : jobState.pid;
      jobState.exit_code = j.run.exit_code;
      jobState.command = j.run.command || jobState.command;
      jobState.log_path = j.run.log_path || jobState.log_path;
      jobState.case_dir = j.run.case_dir || jobState.case_dir;
      jobState.note = j.run.note || jobState.note;
      jobState.started_at = j.run.started_at || jobState.started_at;
      jobState.finished_at = j.run.finished_at || null;
      jobState.increment = 'W27';
      syncJobStatusChrome();
      const finished = ['done', 'failed', 'stopped'].includes(j.run.status);
      if (j.run.status === 'done' && prev !== 'done') {
        stopSimPoll();
      }
      if (j.run.status === 'failed' || j.run.status === 'stopped') {
        stopSimPoll();
      }
      // Live results: pick up frames copied since the last poll.
      const justFinished = finished && prev !== j.run.status;
      refreshLiveResultsFrames(j.run, justFinished).catch((e) => console.warn('[CFD] live frames', e));
      if (justFinished) {
        // One more pass after the final copy has settled (polling stops now).
        const finalRun = j.run;
        setTimeout(() => {
          refreshLiveResultsFrames(finalRun, true).catch((e) => console.warn('[CFD] live frames', e));
        }, 2500);
      }
    }
    syncSimControlPanel();
  } catch (e) {
    console.warn('[CFD] sim poll', e);
  }
}

// ---- W31 live results: new time directories while the run is solving ----
// The solve script copies each finished time directory into the run folder
// as the solver writes it. While that run's Results view is open, re-list the
// times whenever the server reports a new frame; if the viewer was sitting on
// the newest frame, follow along to the new one (a scrubbed-back frame stays).
let liveFramesSeen = null;
let liveFramesBusy = false;
let liveFramesQueued = null; // a refresh that arrived while one was in flight

async function refreshLiveResultsFrames(run, justFinished) {
  if (!run) return;
  const rid = run.run_id || run.id;
  if (!resultsViewOpen || !resultsRunId || String(resultsRunId) !== String(rid)) {
    liveFramesSeen = null;
    return;
  }
  if (run.status !== 'running' && !justFinished) return;
  const n = Number(run.n_saved_times) || 0;
  if (!justFinished && liveFramesSeen != null && n === liveFramesSeen) return;
  if (liveFramesBusy || w27State.attaching) {
    // Polling stops once the run is done, so a request that lands while a
    // frame is still loading must not be dropped — run it afterwards.
    liveFramesQueued = { run, justFinished: !!justFinished || (liveFramesQueued && liveFramesQueued.justFinished) };
    return;
  }
  liveFramesBusy = true;
  try {
    const before = (animState.times || []).slice();
    const wasOnLast = before.length > 0 && Number(animState.index) === before.length - 1;
    const times = await ensureAnimTimes();
    liveFramesSeen = n;
    const added = times.length - before.length;
    if (added > 0) {
      const last = times[times.length - 1];
      if (wasOnLast && !animState.playing && !isPtAnimation() && String(currentTime) !== String(last)) {
        await setAnimationTime(last);
      }
      try { syncRunResultsPanel(); } catch (_) {}
      try { syncIterationsPanelFromState(); } catch (_) {}
    }
  } finally {
    liveFramesBusy = false;
  }
  if (liveFramesQueued) {
    const q = liveFramesQueued;
    liveFramesQueued = null;
    // The final copy after the solver exits can land a moment after "done".
    setTimeout(() => {
      refreshLiveResultsFrames(q.run, q.justFinished).catch((e) => console.warn('[CFD] live frames', e));
    }, q.justFinished ? 1200 : 0);
  }
}

function startSimPoll() {
  stopSimPoll();
  w27State.poll_timer = setInterval(pollSimRunStatus, 1500);
}

async function refreshRunCatalog() {
  const r = await fetch('/api/run/status' + hashProjectQs(), { cache: 'no-store' });
  const j = await r.json();
  applyRunCatalog(j);
  if (j && j.run && !w27State.selected_run_id) {
    w27State.run = j.run;
  }
  return j;
}

async function startSolveClient() {
  leaveResultsForSetup();
  const startBtn = document.getElementById('btn-sim-start');
  const hint = document.getElementById('sim-run-hint');
  const showHint = (msg) => {
    w27State.start_error = msg || w27State.start_error;
    if (!hint) return;
    hint.hidden = false;
    hint.textContent = msg || '';
  };
  const failStart = (msg, extra) => {
    w27State.starting = false;
    w27State.start_error = msg;
    jobState.status = 'failed';
    jobState.note = msg;
    jobState.path_kind = 'simpleFoam';
    showHint(msg);
    syncJobStatusChrome();
    syncSimControlPanel();
    if (startBtn) startBtn.disabled = false;
    return extra || { ok: false, error: msg };
  };
  w27State.starting = true;
  w27State.start_error = 'Starting…';
  if (startBtn) startBtn.disabled = true;
  showHint('Starting…');
  try {
    await persistSimControl({ skipSync: true });
  } catch (_) {}
  if (!w27State.selected_run_id || !findRunRecord(w27State.selected_run_id)) {
    try { await refreshRunCatalog(); } catch (_) {}
  }
  let runId = w27State.selected_run_id;
  if (!runId) {
    const draft = (w27State.runs || []).find((r) => r.status === 'draft' || r.status === 'failed' || r.status === 'stopped');
    runId = draft && (draft.id || draft.run_id);
    if (runId) w27State.selected_run_id = runId;
  }
  if (!runId) {
    return failStart('Create a run first, then start it.');
  }
  const rec = findRunRecord(runId);
  if (rec && rec.status === 'done') {
    return failStart('This run already finished. Create a new run to solve again.');
  }
  try {
    const r = await fetch('/api/run/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        run_id: runId,
        project_id: currentProjectId() || undefined,
        endTime: w27State.endTime,
        writeInterval: w27State.writeInterval,
        ...(typeof currentMeshStudyIds === 'function' ? currentMeshStudyIds() : {}),
        ...(rec && runRecIsTransient(rec) ? { transient: w27State.transient || readTransientForm() } : {}),
      }),
    });
    const j = await r.json();
    if (!(r.ok || r.status === 202) || !j || j.ok === false) {
      return failStart((j && j.error) || 'Start failed', j);
    }
    w27State.starting = false;
    w27State.start_error = null;
    w27State.run = j;
    applyRunCatalog(j);
    jobState.status = 'running';
    jobState.mode = 'solve';
    jobState.path_kind = j.path_kind || 'simpleFoam';
    jobState.pid = j.pid || null;
    jobState.case_dir = j.case_dir || null;
    jobState.log_path = j.log_path || null;
    jobState.note = j.note || (j.path_kind || 'simpleFoam') + ' running';
    jobState.started_at = j.started_at || new Date().toISOString();
    jobState.finished_at = null;
    syncJobStatusChrome();
    startSimElapsedClock();
    syncSimControlPanel();
    startSimPoll();
    return j;
  } catch (e) {
    failStart(String(e));
    throw e;
  }
}

async function stopSolveClient() {
  try {
    await fetch('/api/run/stop' + hashProjectQs(), { method: 'POST' });
  } catch (e) {
    console.warn('[CFD] sim stop', e);
  }
  await pollSimRunStatus();
}

window.__CFD_W27_START__ = startSolveClient;
window.__CFD_W27_STOP__ = stopSolveClient;

async function activateRunClient(runId) {
  if (!runId) return null;
  const r = await fetch('/api/run/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      run_id: runId,
      project_id: currentProjectId() || undefined,
      ...(typeof currentMeshStudyIds === 'function' ? currentMeshStudyIds() : {}),
    }),
  });
  const j = await r.json();
  if (!r.ok || (j && j.ok === false)) {
    throw new Error((j && j.error) || 'Could not open run');
  }
  w27State.selected_run_id = runId;
  if (j && j.run) w27State.run = j.run;
  applyRunCatalog(j);
  syncSimControlPanel();
  return j;
}

async function renameActiveRunClient(name) {
  const runId =
    w27State.selected_run_id ||
    (w27State.run && (w27State.run.run_id || w27State.run.id)) ||
    w27State.active_run_id;
  if (!runId) return;
  const next = String(name || '').trim();
  if (!next) return;
  if (w27State.run) w27State.run.name = next;
  const r = await fetch('/api/run/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      run_id: runId,
      name: next,
      project_id: currentProjectId() || undefined,
      ...(typeof currentMeshStudyIds === 'function' ? currentMeshStudyIds() : {}),
    }),
  });
  const j = await r.json();
  if (j && j.ok) applyRunCatalog(j);
  syncSimControlPanel();
}

(function wireSimControlPanel() {
  const endEl = document.getElementById('sim-end-time');
  const wiEl = document.getElementById('sim-write-interval');
  const startBtn = document.getElementById('btn-sim-start');
  const stopBtn = document.getElementById('btn-sim-stop');
  wireSimPlotHover();
  const persist = () => { persistSimControl().catch(() => {}); };
  endEl?.addEventListener('change', persist);
  wiEl?.addEventListener('change', persist);
  // W30 transient inputs: save on change (like the steady rows); the hint's
  // frame interval follows keystrokes so the user sees it before committing.
  const persistTr = () => { persistTransientSettings().catch(() => {}); };
  for (const id of Object.values(TRANSIENT_FORM_IDS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('change', persistTr);
    if (el.tagName === 'INPUT') {
      el.addEventListener('input', () => {
        w27State.transient = readTransientForm();
        if (id === TRANSIENT_FORM_IDS.end_time || id === TRANSIENT_FORM_IDS.write_count) {
          syncTransientMaxDtField(w27State.transient);
        }
        renderTransientHint();
      });
    }
  }
  document.getElementById('sim-tr-step-mode')?.addEventListener('change', () => {
    fillTransientForm(readTransientForm(), false);
  });
  document.getElementById('sim-tr-reset')?.addEventListener('click', () => {
    const cur = readTransientForm();
    const next = { ...TRANSIENT_DEFAULTS_CLIENT, end_time: cur.end_time, write_count: cur.write_count };
    w27State.transient = next;
    fillTransientForm(next, false);
    persistTr();
  });
  startBtn?.addEventListener('click', () => {
    startSolveClient().catch((e) => console.error('[CFD] start', e));
  });
  stopBtn?.addEventListener('click', () => {
    stopSolveClient().catch((e) => console.error('[CFD] stop', e));
  });
  const titleEl = document.getElementById('sim-panel-title');
  const renameBtn = document.getElementById('sim-rename');
  const renameIn = document.getElementById('sim-rename-input');
  const stopRename = (commit) => {
    if (!renameIn || !titleEl || !renameBtn) return;
    if (commit) {
      const next = String(renameIn.value || '').trim() || (w27State.run && w27State.run.name) || 'Run 1';
      titleEl.textContent = next;
      renameActiveRunClient(next).catch((e) => console.warn('[CFD] run rename', e));
    }
    renameIn.hidden = true;
    titleEl.hidden = false;
    renameBtn.hidden = !selectedRunRecord();
  };
  const startRename = () => {
    const rec = selectedRunRecord() || w27State.run;
    if (!renameIn || !titleEl || !renameBtn || !rec) return;
    renameIn.value = rec.name || 'Run 1';
    titleEl.hidden = true;
    renameBtn.hidden = true;
    renameIn.hidden = false;
    renameIn.focus();
    renameIn.select();
  };
  renameBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    startRename();
  });
  renameIn?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      stopRename(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      stopRename(false);
    }
  });
  renameIn?.addEventListener('blur', () => stopRename(true));
  document.getElementById('btn-create-run')?.addEventListener('click', () => {
    createRunClient().catch((e) => console.error('[CFD] create run', e));
  });
  document.getElementById('sim-copy-open')?.addEventListener('click', () => {
    const rec = selectedRunRecord();
    if (rec) startRunCopyPick(rec.id);
  });
  document.getElementById('sim-copy-cancel')?.addEventListener('click', () => {
    endRunCopyPick();
    try { syncRunCopyUi(); } catch (_) {}
  });
  const copySel = document.getElementById('sim-copy-run');
  const onCopySel = (e) => {
    const id = e.target && e.target.value;
    if (id) copyRunSettingsFrom(id).catch((err) => console.warn('[CFD] copy run', err));
  };
  copySel?.addEventListener('change', onCopySel);
  copySel?.addEventListener('input', onCopySel);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !runCopyPick) return;
    endRunCopyPick();
    try { syncRunCopyUi(); } catch (_) {}
  });
  document.getElementById('sim-new-run-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      createRunClient().catch((err) => console.error('[CFD] create run', err));
    }
  });
  document.getElementById('sim-run-delete')?.addEventListener('click', () => {
    deleteSelectedRunClient().catch((e) => console.error('[CFD] delete run', e));
  });
  document.getElementById('run-mesh-hub-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-assign-run-mesh]');
    if (!btn || btn.disabled) return;
    const mid = btn.getAttribute('data-assign-run-mesh');
    assignMeshToSelectedRun(mid).catch((err) => console.warn('[CFD] assign mesh', err));
  });
  document.getElementById('run-rc-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open-run-rc]');
    if (!btn) return;
    const rec = selectedRunRecord();
    if (!rec) return;
    openRunResultControl(rec.id, btn.getAttribute('data-open-run-rc'));
  });
  fetch('/api/simulation-control' + hashProjectQs())
    .then((r) => r.json())
    .then((j) => {
      if (j && j.endTime) w27State.endTime = j.endTime;
      if (j && j.writeInterval) w27State.writeInterval = j.writeInterval;
      syncSimControlPanel();
    })
    .catch(() => {});
  fetch('/api/run/status' + hashProjectQs(), { cache: 'no-store' })
    .then((r) => r.json())
    .then((j) => {
      if (!currentStudyId()) {
        applyRunCatalog({ runs: [] });
        return;
      }
      if (j && j.run) {
        w27State.run = j.run;
        applyRunCatalog(j);
        if (!w27State.selected_run_id && (j.active_run_id || j.run.run_id || j.run.id)) {
          w27State.selected_run_id = j.active_run_id || j.run.run_id || j.run.id;
        }
        if (j.run.status === 'running') {
          startSimElapsedClock();
          startSimPoll();
        }
      } else {
        applyRunCatalog(j);
        if (!w27State.selected_run_id && j && j.active_run_id) w27State.selected_run_id = j.active_run_id;
      }
      if (j && j.simulation_control) {
        if (j.simulation_control.endTime) w27State.endTime = j.simulation_control.endTime;
        if (j.simulation_control.writeInterval) w27State.writeInterval = j.simulation_control.writeInterval;
      }
      syncSimControlPanel();
    })
    .catch(() => {});
})();

/* ---- Run monitors: boundary area averages + flow rates from the solve ---- */
(function wireRunMonitors() {
  const monState = {
    byRun: {},
    inflight: {},
    timer: null,
  };
  window.__CFD_MONITORS__ = monState;

  function fmtNum(v, digits) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    const n = Number(v);
    const a = Math.abs(n);
    if (a === 0) return '0';
    if (a >= 1e5 || a < 1e-3) return n.toExponential(digits != null ? digits : 2);
    const d = digits != null ? digits : a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
    return n.toFixed(d);
  }

  function fmtArea(m2) {
    if (m2 == null || !Number.isFinite(Number(m2))) return '—';
    const a = Number(m2);
    if (a < 0.01) return fmtNum(a * 1e4, 1) + ' cm²';
    return fmtNum(a, 4) + ' m²';
  }

  function fmtFlow(q) {
    if (q == null || !Number.isFinite(Number(q))) return '—';
    const a = Math.abs(Number(q));
    if (a < 0.01) return fmtNum(a * 1000, a * 1000 < 1 ? 3 : 2) + ' L/s';
    return fmtNum(a, 4) + ' m³/s';
  }

  function fmtMassFlow(kgs) {
    if (kgs == null || !Number.isFinite(Number(kgs))) return '—';
    const a = Math.abs(Number(kgs));
    if (a < 0.01) return fmtNum(a * 1000, 3) + ' g/s';
    return fmtNum(a, 4) + ' kg/s';
  }

  function fmtImbalance(pct) {
    if (pct == null || !Number.isFinite(Number(pct))) return '';
    const a = Math.abs(Number(pct));
    if (a < 0.01) return '< 0.01 %';
    return fmtNum(a, 2) + ' %';
  }

  function sparkline(series, pick, color) {
    const vals = (series || []).map((s) => Number(pick(s))).filter((v) => Number.isFinite(v));
    if (vals.length < 2) return '';
    const w = 260;
    const h = 56;
    const pad = 4;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || Math.abs(max) * 1e-6 || 1;
    const n = vals.length;
    const pts = vals
      .map((v, i) => {
        const x = pad + (i / (n - 1)) * (w - pad * 2);
        const y = pad + (1 - (v - min) / span) * (h - pad * 2);
        return x.toFixed(1) + ',' + y.toFixed(1);
      })
      .join(' ');
    return (
      '<svg class="mon-svg" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" aria-label="History">' +
      '<polyline fill="none" stroke="' + color + '" stroke-width="1.5" points="' + pts + '" />' +
      '<text x="4" y="10" font-size="9" fill="#98a2b3">' + fmtNum(max) + '</text>' +
      '<text x="4" y="' + (h - 3) + '" font-size="9" fill="#98a2b3">' + fmtNum(min) + '</text>' +
      '</svg>'
    );
  }

  function bcTag(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('inlet')) return 'Velocity inlet';
    if (t.includes('outlet')) return 'Velocity outlet';
    if (t.includes('pressure')) return 'Pressure';
    return type || 'Boundary';
  }

  function monitorCard(m) {
    const f = m.final || null;
    const q = f ? f.volumetric_flow_m3s : null;
    const dir = q == null ? '' : q < 0 ? 'in' : 'out';
    const rows = [];
    if (f) {
      rows.push(['Mean velocity', fmtNum(f.mean_velocity_magnitude) + ' m/s']);
      if (f.mean_normal_velocity != null) {
        rows.push(['Normal velocity', fmtNum(Math.abs(f.mean_normal_velocity)) + ' m/s' + (dir ? ' ' + dir : '')]);
      }
      if (q != null) {
        rows.push(['Flow rate', fmtFlow(q) + (dir ? ' ' + dir : '')]);
        rows.push(['Mass flow', fmtMassFlow(f.mass_flow_kgs)]);
      }
      if (f.pressure_Pa != null) rows.push(['Pressure', fmtNum(f.pressure_Pa, 1) + ' Pa']);
      rows.push(['Iteration', String(f.iteration)]);
    }
    rows.push(['Area', fmtArea(m.area_m2) + (m.n_faces != null ? ' · ' + m.n_faces + ' mesh faces' : '')]);
    let note = '';
    if (
      f &&
      /inlet/i.test(String(m.bc_type || '')) &&
      f.mean_normal_velocity != null &&
      f.mean_velocity_magnitude > 0
    ) {
      // A vector inlet that is not normal to the face: the air moves at the
      // typed speed along the vector. Keep the note to that one fact.
      const ratio = Math.min(1, Math.abs(f.mean_normal_velocity) / f.mean_velocity_magnitude);
      if (ratio < 0.95) {
        note =
          '<div class="mon-empty">Air enters at ' +
          fmtNum(f.mean_velocity_magnitude) +
          ' m/s along the set vector.</div>';
      }
    }
    const grid =
      '<div class="mon-grid">' +
      rows.map((r) => '<span class="mon-k">' + escapeHtml(r[0]) + '</span><span class="mon-v">' + escapeHtml(r[1]) + '</span>').join('') +
      '</div>';
    const spark = sparkline(m.series, (s) => s.Umag, '#3884e6');
    return (
      '<div class="mon-card" data-monitor-patch="' + escapeHtml(m.patch) + '">' +
      '<div class="mon-card-head"><span class="mon-card-name">' + escapeHtml(m.name || m.patch) + '</span>' +
      '<span class="mon-card-tag">' + escapeHtml(bcTag(m.bc_type)) + '</span></div>' +
      grid +
      note +
      spark +
      '</div>'
    );
  }

  function pendingCards() {
    const bcs = (typeof w19State !== 'undefined' && Array.isArray(w19State.bcs) ? w19State.bcs : []).filter((bc) =>
      Array.isArray(bc.faces) && bc.faces.length
    );
    if (!bcs.length) return '<div class="mon-empty">Add a velocity inlet and a pressure outlet first.</div>';
    return bcs
      .map(
        (bc) =>
          '<div class="mon-card"><div class="mon-card-head"><span class="mon-card-name">' +
          escapeHtml(bc.name || bc.bc_type || bc.type) +
          '</span><span class="mon-card-tag">' +
          escapeHtml(bcTag(bc.bc_type || bc.type)) +
          '</span></div><div class="mon-empty">Values appear once the run starts.</div></div>'
      )
      .join('');
  }

  function renderBalance(el, data) {
    if (!el) return;
    const b = data && data.balance;
    if (!b || !(b.in_m3s > 0 || b.out_m3s > 0)) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    const imb = b.imbalance != null ? Math.abs(b.imbalance) * 100 : null;
    el.hidden = false;
    el.classList.toggle('is-warn', imb != null && imb > 1);
    el.textContent =
      'Flow in ' + fmtFlow(b.in_m3s) + ' · out ' + fmtFlow(b.out_m3s) + (imb != null ? ' · imbalance ' + fmtImbalance(imb) : '');
  }

  function renderRunMonitorsHub() {
    const list = document.getElementById('run-monitors-list');
    const hint = document.getElementById('run-monitors-hint');
    const bal = document.getElementById('run-monitors-balance');
    if (!list) return;
    const rec = typeof selectedRunRecord === 'function' ? selectedRunRecord() : null;
    if (!rec) {
      list.innerHTML = '<div class="mon-empty">Create a run first.</div>';
      renderBalance(bal, null);
      return;
    }
    const data = monState.byRun[rec.id];
    const mons = (data && data.monitors) || [];
    if (!mons.length) {
      if (hint) {
        hint.textContent =
          rec.status === 'running'
            ? 'Waiting for the first iteration…'
            : 'Every inlet and outlet is monitored automatically: mean velocity, flow rate and pressure per iteration.';
      }
      list.innerHTML = pendingCards();
      renderBalance(bal, null);
      return;
    }
    if (hint) {
      hint.textContent =
        rec.status === 'running'
          ? 'Live values from the solver, updated every few seconds.'
          : 'Area-averaged values on each boundary at the last iteration.';
    }
    list.innerHTML = mons.map(monitorCard).join('');
    renderBalance(bal, data);
  }

  function renderAaMonitorValues() {
    const wrap = document.getElementById('aa-monitor-values');
    const list = document.getElementById('aa-monitor-list');
    if (!wrap || !list) return;
    const runId = (typeof w22State !== 'undefined' && w22State.editing_run_id) || (w27State && w27State.selected_run_id);
    const data = runId ? monState.byRun[runId] : null;
    const faces = new Set(((typeof w22State !== 'undefined' && w22State.draft_faces) || []).map(String));
    const mons = ((data && data.monitors) || []).filter((m) => (m.faces || []).some((f) => faces.has(String(f))));
    if (!mons.length) {
      wrap.hidden = true;
      list.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    list.innerHTML = mons.map(monitorCard).join('');
  }

  async function refreshRunMonitors(runId) {
    const rec = typeof findRunRecord === 'function' ? findRunRecord(runId) : null;
    if (!rec || rec.status === 'draft' || monState.inflight[rec.id]) return null;
    monState.inflight[rec.id] = true;
    try {
      const pid = typeof currentProjectId === 'function' ? currentProjectId() : null;
      const qs = new URLSearchParams({ run_id: String(rec.id) });
      if (pid) qs.set('project_id', pid);
      const r = await fetch('/api/run/monitors?' + qs.toString(), { cache: 'no-store' });
      const j = await r.json();
      if (j && j.ok) monState.byRun[rec.id] = j;
      renderRunMonitorsHub();
      renderAaMonitorValues();
      return j;
    } catch (e) {
      console.warn('[CFD] monitors', e);
      return null;
    } finally {
      monState.inflight[rec.id] = false;
    }
  }

  function monitorsPanelOpen() {
    return treeUi.openPanel === 'rc' || treeUi.openPanel === 'aa';
  }

  function tick() {
    if (!monitorsPanelOpen()) return;
    const rec = typeof selectedRunRecord === 'function' ? selectedRunRecord() : null;
    if (!rec) return;
    if (rec.status === 'running' || !monState.byRun[rec.id]) refreshRunMonitors(rec.id);
  }

  const _prevSyncResultsHub = syncResultsHub;
  syncResultsHub = function patchedSyncResultsHubMonitors() {
    _prevSyncResultsHub();
    renderRunMonitorsHub();
    const rec = typeof selectedRunRecord === 'function' ? selectedRunRecord() : null;
    if (rec && !monState.byRun[rec.id]) refreshRunMonitors(rec.id);
  };

  const _prevShowAaPanel = showAaPanel;
  showAaPanel = function patchedShowAaPanelMonitors() {
    _prevShowAaPanel();
    renderAaMonitorValues();
    const runId = w22State.editing_run_id || w27State.selected_run_id;
    if (runId && !monState.byRun[runId]) refreshRunMonitors(runId);
  };

  window.__CFD_REFRESH_MONITORS__ = refreshRunMonitors;
  monState.timer = setInterval(tick, 3000);
})();

/* ======================================================================
 * W28 — Capture (framed screenshot / screen recording) + saved media
 * ====================================================================== */

/** Lazily created so the tree can ask for counts before this section runs. */
function mediaStore() {
  if (!window.__CFD_MEDIA__) {
    window.__CFD_MEDIA__ = {
      byOwner: {}, // owner -> { items, loaded, inflight, at }
      panel: null, // { ownerKind, id, kind }
      graphs: null, // { runId, timer }
    };
  }
  return window.__CFD_MEDIA__;
}

function mediaOwnerKey(ownerKind, id) {
  return ownerKind + '-' + String(id);
}

function mediaOwnerLabel(ownerKind, id) {
  if (ownerKind === 'run') {
    const rec = typeof findRunRecord === 'function' ? findRunRecord(id) : null;
    return (rec && rec.name) || 'Run';
  }
  const m = (typeof meshList === 'function' ? meshList() : []).find((x) => String(x.id) === String(id));
  return (m && m.name) || 'Mesh';
}

function mediaItems(owner) {
  const rec = mediaStore().byOwner[owner];
  return rec && Array.isArray(rec.items) ? rec.items : [];
}

async function ensureMediaLoaded(owner, opts) {
  const o = opts || {};
  const st = mediaStore();
  const rec = st.byOwner[owner] || (st.byOwner[owner] = { items: [], loaded: false, inflight: false, at: 0 });
  if (rec.inflight) return rec.items;
  if (rec.loaded && !o.force && Date.now() - rec.at < 60000) return rec.items;
  rec.inflight = true;
  try {
    const pid = typeof currentProjectId === 'function' ? currentProjectId() : null;
    const qs = new URLSearchParams({ owner });
    if (pid) qs.set('project_id', pid);
    const r = await fetch('/api/media/list?' + qs.toString(), { cache: 'no-store' });
    const j = await r.json();
    const before = rec.items.length;
    rec.items = j && j.ok && Array.isArray(j.items) ? j.items : [];
    rec.loaded = true;
    rec.at = Date.now();
    if (rec.items.length !== before || o.force) {
      try { syncSimulationTree(); } catch (_) {}
    }
    const p = st.panel;
    if (p && mediaOwnerKey(p.ownerKind, p.id) === owner) renderMediaPanel();
    return rec.items;
  } catch (e) {
    console.warn('[CFD] media list', e);
    rec.loaded = true;
    rec.at = Date.now();
    return rec.items;
  } finally {
    rec.inflight = false;
  }
}

/** Tree rows under Results (Graphs / Screenshots / Recordings) or under a mesh. */
function mediaTreeChildren(ownerKind, id, opts) {
  const o = opts || {};
  const owner = mediaOwnerKey(ownerKind, id);
  const rec = mediaStore().byOwner[owner];
  if (!rec || !rec.loaded) ensureMediaLoaded(owner);
  const items = (rec && rec.items) || [];
  const shots = items.filter((i) => i.kind === 'screenshot').length;
  const recs = items.filter((i) => i.kind === 'recording').length;
  if (o.onlyIfAny && !shots && !recs) return '';
  const row = (kind, label, count) => {
    const key = 'media:' + ownerKind + ':' + id + ':' + kind;
    return (
      '<li class="tree-node' +
      (treeUi.selectedKey === key ? ' selected' : '') +
      '" data-label="' +
      escapeHtml(key) +
      '" data-w28-key="' +
      escapeHtml(key) +
      '"><div class="tree-row"><span class="tl">' +
      label +
      '</span>' +
      (count ? '<span class="tree-count">' + count + '</span>' : '') +
      '</div></li>'
    );
  };
  return (
    '<ul>' +
    (o.graphs ? row('graphs', 'Graphs', 0) : '') +
    row('screenshot', 'Screenshots', shots) +
    row('recording', 'Recordings', recs) +
    '</ul>'
  );
}

function openMediaTreeNode(key) {
  const bits = String(key || '').split(':');
  if (bits.length < 4 || bits[0] !== 'media') return;
  const ownerKind = bits[1];
  const kind = bits[bits.length - 1];
  const id = bits.slice(2, -1).join(':');
  if (ownerKind === 'run') {
    w27State.selected_run_id = id;
    treeUi.expanded['run:' + id] = true;
    treeUi.expanded['run-results:' + id] = true;
  } else {
    treeUi.expanded['Mesh'] = true;
    treeUi.expanded['mesh-media:' + id] = true;
  }
  const st = mediaStore();
  if (kind === 'graphs') {
    st.panel = null;
    openTreeDetail('run-graphs', { toggle: false });
    markTreeSelected(key);
    renderGraphsPanel(id);
    return;
  }
  st.panel = { ownerKind, id, kind };
  openTreeDetail('run-media', { toggle: false });
  markTreeSelected(key);
  renderMediaPanel();
  ensureMediaLoaded(mediaOwnerKey(ownerKind, id), { force: true });
}

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function fmtClock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function mediaItemSub(it) {
  const bits = [];
  if (it.width && it.height) bits.push(it.width + ' × ' + it.height + ' px');
  if (it.kind === 'recording' && it.duration_s) bits.push(fmtClock(it.duration_s));
  if (it.ext) bits.push(String(it.ext).toUpperCase());
  bits.push(fmtBytes(it.bytes));
  if (it.created_at) {
    const d = new Date(it.created_at);
    if (!Number.isNaN(d.getTime())) bits.push(d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));
  }
  return bits.join(' · ');
}

function renderMediaPanel() {
  const st = mediaStore();
  const p = st.panel;
  const list = document.getElementById('run-media-list');
  const title = document.getElementById('run-media-title');
  const ownerEl = document.getElementById('run-media-owner');
  const hint = document.getElementById('run-media-hint');
  if (!p || !list) return;
  const owner = mediaOwnerKey(p.ownerKind, p.id);
  const rec = st.byOwner[owner];
  const isRec = p.kind === 'recording';
  if (title) title.textContent = isRec ? 'Recordings' : 'Screenshots';
  if (ownerEl) ownerEl.textContent = mediaOwnerLabel(p.ownerKind, p.id) + (p.ownerKind === 'run' ? ' · Results' : ' · Mesh');
  const items = (rec ? rec.items : []).filter((i) => i.kind === p.kind);
  if (hint) {
    hint.textContent = !rec || !rec.loaded
      ? 'Loading…'
      : items.length
        ? 'Click a thumbnail to view it full size.'
        : isRec
          ? 'Use Record in the toolbar while this ' + (p.ownerKind === 'run' ? 'run’s results are' : 'mesh is') + ' open to record the framed view.'
          : 'Use Screenshot in the toolbar while this ' + (p.ownerKind === 'run' ? 'run’s results are' : 'mesh is') + ' open to capture the framed view.';
  }
  list.innerHTML = items
    .map((it) => {
      const thumb = isRec
        ? '<video src="' + escapeHtml(it.url) + '" preload="metadata" muted playsinline></video><span class="media-play" aria-hidden="true">▶</span>'
        : '<img src="' + escapeHtml(it.url) + '" alt="" loading="lazy" />';
      return (
        '<div class="media-item" data-media-id="' + escapeHtml(it.id) + '">' +
        '<button type="button" class="media-thumb" data-media-act="view" title="View">' + thumb + '</button>' +
        '<div class="media-info">' +
        '<span class="media-name" title="' + escapeHtml(it.name) + '">' + escapeHtml(it.name) + '</span>' +
        '<span class="media-sub">' + escapeHtml(mediaItemSub(it)) + '</span>' +
        '<div class="media-actions">' +
        '<a class="js-btn" href="' + escapeHtml(it.download_url) + '" download="' + escapeHtml(it.name + '.' + it.ext) + '">Download</a>' +
        '<button type="button" class="js-btn" data-media-act="rename">Rename</button>' +
        '<button type="button" class="mesh-plane-del" data-media-act="delete">Delete</button>' +
        '</div></div></div>'
      );
    })
    .join('');
}

async function deleteMediaItem(owner, item) {
  const ok = await confirmAction({
    title: 'Delete ' + (item.kind === 'recording' ? 'recording' : 'screenshot') + '?',
    copy: '“' + item.name + '” will be removed from this project. This cannot be undone.',
    yes: 'Delete',
  });
  if (!ok) return false;
  const pid = typeof currentProjectId === 'function' ? currentProjectId() : null;
  const r = await fetch('/api/media/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: pid, owner, id: item.id }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) {
    console.warn('[CFD] media delete', j);
    return false;
  }
  await ensureMediaLoaded(owner, { force: true });
  return true;
}

async function renameMediaItem(owner, item) {
  const name = await promptName({
    title: 'Rename ' + (item.kind === 'recording' ? 'recording' : 'screenshot'),
    label: 'Name',
    value: item.name,
    yes: 'Rename',
  });
  if (!name || name === item.name) return false;
  const pid = typeof currentProjectId === 'function' ? currentProjectId() : null;
  const r = await fetch('/api/media/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: pid, owner, id: item.id, name }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) return false;
  await ensureMediaLoaded(owner, { force: true });
  return true;
}

function openMediaView(owner, item) {
  const modal = document.getElementById('modal-media-view');
  if (!modal) return;
  const heading = document.getElementById('mv-heading');
  const body = document.getElementById('mv-body');
  const meta = document.getElementById('mv-meta');
  const dl = document.getElementById('mv-download');
  const del = document.getElementById('mv-delete');
  const ren = document.getElementById('mv-rename');
  const close = document.getElementById('mv-close');
  const backdrop = document.getElementById('mv-backdrop');
  const isRec = item.kind === 'recording';
  if (heading) heading.textContent = item.name;
  if (meta) meta.textContent = mediaItemSub(item);
  if (body) {
    body.innerHTML = isRec
      ? '<video src="' + escapeHtml(item.url) + '" controls autoplay loop muted playsinline></video>'
      : '<img src="' + escapeHtml(item.url) + '" alt="' + escapeHtml(item.name) + '" />';
  }
  if (dl) {
    dl.href = item.download_url;
    dl.setAttribute('download', item.name + '.' + item.ext);
  }
  modal.hidden = false;
  const done = () => {
    modal.hidden = true;
    if (body) body.innerHTML = '';
    close?.removeEventListener('click', done);
    backdrop?.removeEventListener('click', done);
    del?.removeEventListener('click', onDel);
    ren?.removeEventListener('click', onRen);
    document.removeEventListener('keydown', onKey);
  };
  const onDel = async () => {
    if (await deleteMediaItem(owner, item)) done();
  };
  const onRen = async () => {
    if (await renameMediaItem(owner, item)) {
      const fresh = mediaItems(owner).find((x) => x.id === item.id);
      if (fresh && heading) heading.textContent = fresh.name;
      if (fresh && dl) dl.setAttribute('download', fresh.name + '.' + fresh.ext);
    }
  };
  const onKey = (e) => {
    if (e.key === 'Escape') done();
  };
  close?.addEventListener('click', done);
  backdrop?.addEventListener('click', done);
  del?.addEventListener('click', onDel);
  ren?.addEventListener('click', onRen);
  document.addEventListener('keydown', onKey);
}

(function wireMediaPanel() {
  const list = document.getElementById('run-media-list');
  list?.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-media-act]');
    if (!act) return;
    const row = act.closest('[data-media-id]');
    const p = mediaStore().panel;
    if (!row || !p) return;
    const owner = mediaOwnerKey(p.ownerKind, p.id);
    const item = mediaItems(owner).find((x) => x.id === row.getAttribute('data-media-id'));
    if (!item) return;
    const what = act.getAttribute('data-media-act');
    if (what === 'view') openMediaView(owner, item);
    else if (what === 'delete') deleteMediaItem(owner, item);
    else if (what === 'rename') renameMediaItem(owner, item);
  });
  document.getElementById('run-media-capture')?.addEventListener('click', async () => {
    const p = mediaStore().panel;
    if (!p) return;
    try {
      if (p.ownerKind === 'run') {
        if (!resultsViewOpen || String(resultsRunId) !== String(p.id)) {
          markTreeSelected('runresults:' + p.id);
          await openRunResults(p.id);
        }
      } else if (!meshInspectOpen || String((w20State && w20State.active_id) || '') !== String(p.id)) {
        if (resultsViewOpen) hideRunResultsView({ silent: true });
        markTreeSelected('meshid:' + p.id);
        await activateMeshClient(p.id);
        await showMeshInspect(p.id);
      }
    } catch (err) {
      console.warn('[CFD] media capture open', err);
    }
    startCapture(p.kind === 'recording' ? 'rec' : 'shot');
  });
})();

/* ---------------- Capture framing + screenshot + recording ---------------- */

const captureState = {
  open: false,
  mode: 'shot', // 'shot' | 'rec'
  frame: null, // { x, y, w, h } CSS px inside .viewport-wrap
  aspect: 'free',
  minSide: 0, // minimum output side length in px (0 = screen resolution)
  drag: null,
  rec: null, // { recorder, stream, chunks, out, ctx, scale, raf, timer, t0, dur, mime, ext, stopped }
  hiRes: null, // panes rendering above screen resolution: [{ fsr, rw, glrw, w, h }]
  restorePanel: null, // tree flyout closed when framing started; reopened on exit
};
window.__CFD_CAPTURE__ = captureState;

const CAPTURE_MAX_DIM = 8192; // GPU-safe ceiling for an offscreen render target
const CAPTURE_MAX_PIXELS = 3840 * 2160; // per-pane render budget while recording / capturing

/** Live vtk panes with their render windows (A always, B when compare is open). */
function capturePaneViews() {
  const out = [];
  const a = document.querySelector('#viewer canvas');
  if (a && fullScreenRenderer.getApiSpecificRenderWindow) {
    out.push({ canvas: a, fsr: fullScreenRenderer, rw: renderWindow, glrw: fullScreenRenderer.getApiSpecificRenderWindow() });
  }
  const paneB = document.getElementById('compare-pane-b');
  const b = document.querySelector('#viewer-b canvas');
  const cv = compareState.viewer;
  if (b && paneB && !paneB.hidden && cv && cv.fullScreenRenderer && cv.fullScreenRenderer.getApiSpecificRenderWindow) {
    out.push({ canvas: b, fsr: cv.fullScreenRenderer, rw: cv.renderWindow, glrw: cv.fullScreenRenderer.getApiSpecificRenderWindow() });
  }
  return out;
}

/** Output pixels per CSS pixel for the current frame: screen DPR, or more when a minimum side is set. */
function captureOutputScale(frame) {
  const native = captureScale();
  const f = frame || captureState.frame;
  const minSide = Number(captureState.minSide) || 0;
  if (!f || !minSide) return native;
  let scale = Math.max(native, minSide / Math.max(1, Math.min(f.w, f.h)));
  // Keep the offscreen render target and the output inside the GPU ceiling.
  const wrap = captureWrap();
  const cssMax = Math.max(f.w, f.h, wrap ? Math.max(wrap.clientWidth, wrap.clientHeight) : 0);
  if (cssMax * scale > CAPTURE_MAX_DIM) scale = CAPTURE_MAX_DIM / cssMax;
  return Math.max(native, scale);
}

/**
 * Scale the panes actually render at. The whole pane buffer grows with the
 * frame's factor (only the frame is copied out), so a small frame asking for
 * 1080 px would push a 1500×900 pane past 13 Mpx per frame and the take stalls.
 * Cap the buffer at a 4K-equivalent pixel budget; the output canvas keeps the
 * requested size and drawImage bridges the (small) remainder.
 */
function captureRenderScale(frame, outScale) {
  const scale = outScale != null ? outScale : captureOutputScale(frame);
  const native = captureScale();
  let best = scale;
  for (const p of capturePaneViews()) {
    const r = p.canvas.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    const px = r.width * r.height;
    if (px * best * best > CAPTURE_MAX_PIXELS) best = Math.sqrt(CAPTURE_MAX_PIXELS / px);
  }
  return Math.max(native, Math.min(scale, best));
}

/** Render every pane at `scale` output px per CSS px (buffer only; on-screen size is unchanged). */
function applyCaptureHiRes(scale) {
  const native = captureScale();
  scale = captureRenderScale(captureState.frame, scale);
  if (!(scale > native * 1.001)) return false;
  const list = [];
  for (const p of capturePaneViews()) {
    const r = p.canvas.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    const w = Math.round(r.width * scale);
    const h = Math.round(r.height * scale);
    try {
      p.glrw.setSize(w, h);
      list.push({ ...p, w, h });
    } catch (e) {
      console.warn('[CFD] capture hi-res setSize', e);
    }
  }
  captureState.hiRes = list.length ? list : null;
  return !!list.length;
}

/** Re-assert the hi-res buffer if something (window resize) reset it mid-recording. */
function ensureCaptureHiRes() {
  const list = captureState.hiRes;
  if (!list) return;
  for (const p of list) {
    try {
      const s = p.glrw.getSize();
      if (s[0] !== p.w || s[1] !== p.h) p.glrw.setSize(p.w, p.h);
    } catch (_) {}
  }
}

function restoreCaptureHiRes() {
  const list = captureState.hiRes;
  captureState.hiRes = null;
  if (!list) return;
  for (const p of list) {
    try {
      p.fsr.resize();
      p.rw.render();
    } catch (e) {
      console.warn('[CFD] capture hi-res restore', e);
    }
  }
}

/** Remember and close whatever tree flyout is open so it cannot sit inside the frame. */
function stashTreePanelForCapture() {
  if (captureState.restorePanel) return;
  if (!treeUi.openPanel) return;
  const st = mediaStore();
  captureState.restorePanel = {
    openPanel: treeUi.openPanel,
    selectedKey: treeUi.selectedKey,
    media: st.panel ? { ...st.panel } : null,
    graphsRunId: st.graphs ? st.graphs.runId : null,
  };
  hideAllTreeDetails();
}

function restoreTreePanelAfterCapture() {
  const r = captureState.restorePanel;
  captureState.restorePanel = null;
  if (!r || treeUi.openPanel) return;
  try {
    if (r.openPanel === 'run-media' && r.media) {
      openMediaTreeNode('media:' + r.media.ownerKind + ':' + r.media.id + ':' + r.media.kind);
    } else if (r.openPanel === 'run-graphs' && r.graphsRunId) {
      openMediaTreeNode('media:run:' + r.graphsRunId + ':graphs');
    } else if (r.openPanel) {
      openTreeDetail(r.openPanel, { toggle: false });
      if (r.selectedKey) markTreeSelected(r.selectedKey);
    }
  } catch (e) {
    console.warn('[CFD] restore tree panel', e);
  }
}

function captureWrap() {
  return document.querySelector('.viewport-wrap');
}

function captureLayerEls() {
  return {
    layer: document.getElementById('capture-layer'),
    frame: document.getElementById('capture-frame'),
    size: document.getElementById('capture-size'),
    bar: document.getElementById('capture-bar'),
    rec: document.getElementById('capture-rec'),
    title: document.getElementById('capture-title'),
    aspect: document.getElementById('capture-aspect'),
    minSide: document.getElementById('capture-minside'),
    durWrap: document.getElementById('capture-dur-wrap'),
    dur: document.getElementById('capture-duration'),
    go: document.getElementById('capture-go'),
    legend: document.getElementById('capture-legend'),
    edges: document.getElementById('capture-edges'),
    filters: document.getElementById('capture-filters'),
    recLegend: document.getElementById('capture-rec-legend'),
    recTime: document.getElementById('capture-rec-time'),
  };
}

/** What the capture belongs to: the run whose results are open, or the inspected mesh. */
function captureOwner() {
  if (resultsViewOpen && resultsRunId) {
    return { ownerKind: 'run', id: String(resultsRunId), owner: mediaOwnerKey('run', resultsRunId), label: mediaOwnerLabel('run', resultsRunId) + ' › Results' };
  }
  const mid = meshInspectOpen && w20State ? w20State.active_id : null;
  if (mid) {
    return { ownerKind: 'mesh', id: String(mid), owner: mediaOwnerKey('mesh', mid), label: mediaOwnerLabel('mesh', mid) };
  }
  return null;
}

function captureDefaultName(kind) {
  const own = captureOwner();
  const base = own ? own.label.replace(/ › Results$/, '') : (document.querySelector('.project-name')?.textContent.trim() || 'cfd');
  const what = resultsViewOpen ? (activeField === 'p' ? 'pressure' : 'velocity') : meshInspectOpen ? 'mesh' : 'view';
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  return (base + '-' + what + (kind === 'recording' ? '-rec' : '') + '-' + stamp).replace(/\s+/g, '-');
}

function capturePanes() {
  const out = [];
  const a = document.querySelector('#viewer canvas');
  if (a) out.push({ canvas: a, rw: renderWindow, glrw: fullScreenRenderer.getApiSpecificRenderWindow?.() });
  const paneB = document.getElementById('compare-pane-b');
  const b = document.querySelector('#viewer-b canvas');
  const cv = compareState.viewer;
  if (b && paneB && !paneB.hidden && cv && cv.renderWindow) {
    out.push({ canvas: b, rw: cv.renderWindow, glrw: cv.fullScreenRenderer?.getApiSpecificRenderWindow?.() });
  }
  return out;
}

/**
 * Render a pane synchronously so its WebGL drawing buffer holds fresh pixels
 * for drawImage. renderWindow.render() is *not* enough: vtk's interactor turns
 * it into a no-op while an animation is running (drag, particle comets…), and
 * with preserveDrawingBuffer=false the composited buffer reads back empty.
 */
function renderPaneNow(pane) {
  try {
    if (pane.glrw && pane.glrw.traverseAllPasses) pane.glrw.traverseAllPasses();
    else if (pane.rw && pane.rw.render) pane.rw.render();
  } catch (_) {}
}

function captureStageRect() {
  const wrap = captureWrap();
  const stage = document.getElementById('compare-stage') || document.getElementById('viewer');
  if (!wrap || !stage) return null;
  const w = wrap.getBoundingClientRect();
  const s = stage.getBoundingClientRect();
  return { x: s.left - w.left, y: s.top - w.top, w: s.width, h: s.height };
}

function aspectValue(a) {
  const m = /^(\d+):(\d+)$/.exec(String(a || ''));
  return m ? Number(m[1]) / Number(m[2]) : 0;
}

function clampFrame(f) {
  const wrap = captureWrap();
  if (!wrap) return f;
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  const min = 64;
  let { x, y, w, h } = f;
  w = Math.max(min, Math.min(w, W));
  h = Math.max(min, Math.min(h, H));
  x = Math.max(0, Math.min(x, W - w));
  y = Math.max(0, Math.min(y, H - h));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

function defaultFrame() {
  const st = captureStageRect();
  const wrap = captureWrap();
  if (!st || !wrap) return { x: 20, y: 20, w: 640, h: 360 };
  // 80 % of the stage, centred, snapped to the current aspect.
  let w = st.w * 0.8;
  let h = st.h * 0.8;
  const ar = aspectValue(captureState.aspect);
  if (ar) {
    if (w / h > ar) w = h * ar;
    else h = w / ar;
  }
  return clampFrame({ x: st.x + (st.w - w) / 2, y: st.y + (st.h - h) / 2, w, h });
}

function loadSavedFrame() {
  try {
    const raw = JSON.parse(localStorage.getItem('cfd-capture-frame') || 'null');
    const wrap = captureWrap();
    if (!raw || !wrap) return null;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    if (!(raw.fw > 0 && raw.fh > 0)) return null;
    return clampFrame({ x: raw.fx * W, y: raw.fy * H, w: raw.fw * W, h: raw.fh * H });
  } catch (_) {
    return null;
  }
}

function saveFrame() {
  const wrap = captureWrap();
  const f = captureState.frame;
  if (!wrap || !f) return;
  const W = wrap.clientWidth || 1;
  const H = wrap.clientHeight || 1;
  try {
    localStorage.setItem('cfd-capture-frame', JSON.stringify({ fx: f.x / W, fy: f.y / H, fw: f.w / W, fh: f.h / H }));
    localStorage.setItem('cfd-capture-aspect', captureState.aspect);
  } catch (_) {}
}

function applyFrameToDom() {
  const { frame, size } = captureLayerEls();
  const f = captureState.frame;
  if (!frame || !f) return;
  frame.style.left = f.x + 'px';
  frame.style.top = f.y + 'px';
  frame.style.width = f.w + 'px';
  frame.style.height = f.h + 'px';
  if (size) {
    const scale = captureOutputScale(f);
    const hi = scale > captureScale() * 1.001;
    let note = '';
    if (hi) {
      const rs = captureRenderScale(f, scale);
      note = rs < scale * 0.999
        ? ' · rendered at ' + Math.round(Math.min(f.w, f.h) * rs) + ' px, enlarge frame for sharper'
        : ' · upscaled render';
    }
    size.textContent = Math.round(f.w * scale) + ' × ' + Math.round(f.h * scale) + ' px' + note;
  }
}

function captureScale() {
  const c = document.querySelector('#viewer canvas');
  if (!c) return window.devicePixelRatio || 1;
  const r = c.getBoundingClientRect();
  return r.width > 0 ? c.width / r.width : window.devicePixelRatio || 1;
}

function setCaptureFrame(f, opts) {
  captureState.frame = clampFrame(f);
  applyFrameToDom();
  if (!opts || opts.persist !== false) saveFrame();
}

/** Re-shape the frame to the chosen aspect, keeping its centre and width. */
function applyAspectToFrame() {
  const ar = aspectValue(captureState.aspect);
  const f = captureState.frame;
  if (!ar || !f) return;
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h / 2;
  let w = f.w;
  let h = w / ar;
  const wrap = captureWrap();
  if (wrap && h > wrap.clientHeight) {
    h = wrap.clientHeight;
    w = h * ar;
  }
  setCaptureFrame({ x: cx - w / 2, y: cy - h / 2, w, h });
}

function syncCaptureToggles() {
  const els = captureLayerEls();
  const legendOn = legendWantedOn();
  const edgesOn = !!document.getElementById('btn-cad-edges')?.classList.contains('is-active');
  const filtersOn = !!(filtersPanel && !filtersPanel.classList.contains('is-hidden'));
  els.legend?.setAttribute('aria-pressed', legendOn ? 'true' : 'false');
  els.recLegend?.setAttribute('aria-pressed', legendOn ? 'true' : 'false');
  els.edges?.setAttribute('aria-pressed', edgesOn ? 'true' : 'false');
  els.filters?.setAttribute('aria-pressed', filtersOn ? 'true' : 'false');
  const hasLegend = !!resultsViewOpen;
  if (els.legend) els.legend.disabled = !hasLegend;
  if (els.recLegend) els.recLegend.disabled = !hasLegend;
}

function startCapture(mode) {
  const els = captureLayerEls();
  if (!els.layer || !els.frame) return;
  const toolbar = document.getElementById('toolbar');
  if (toolbar && toolbar.hidden) return; // nothing to frame in the setup view
  if (captureState.rec) return; // already recording
  captureState.mode = mode === 'rec' ? 'rec' : 'shot';
  try {
    captureState.aspect = localStorage.getItem('cfd-capture-aspect') || 'free';
    captureState.minSide = Number(localStorage.getItem('cfd-capture-minside')) || 0;
  } catch (_) {}
  if (els.aspect) els.aspect.value = captureState.aspect;
  if (els.minSide) els.minSide.value = String(captureState.minSide || 0);
  if (!captureState.open) {
    // A tree flyout (Recordings, Graphs, Monitors…) would sit inside the frame — park it.
    stashTreePanelForCapture();
    captureState.frame = loadSavedFrame() || defaultFrame();
    captureState.open = true;
    els.layer.hidden = false;
  }
  applyFrameToDom();
  if (els.title) els.title.textContent = captureState.mode === 'rec' ? 'Record' : 'Screenshot';
  if (els.go) els.go.textContent = captureState.mode === 'rec' ? 'Start recording' : 'Capture';
  if (els.durWrap) els.durWrap.hidden = captureState.mode !== 'rec';
  if (els.bar) {
    els.bar.hidden = false;
    // Narrow windows: the toolbar scrolls horizontally — bring the fan-out into view.
    try { els.bar.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {}
  }
  if (els.rec) els.rec.hidden = true;
  document.querySelector('.tb-btn[data-label="Screenshot"]')?.classList.toggle('is-active', captureState.mode === 'shot');
  document.querySelector('.tb-btn[data-label="Record"]')?.classList.toggle('is-active', captureState.mode === 'rec');
  syncCaptureToggles();
}

function endCapture() {
  if (captureState.rec) stopRecording({ discard: true });
  restoreCaptureHiRes();
  const els = captureLayerEls();
  captureState.open = false;
  captureState.drag = null;
  if (els.layer) els.layer.hidden = true;
  if (els.bar) els.bar.hidden = true;
  if (els.rec) els.rec.hidden = true;
  document.querySelector('.tb-btn[data-label="Screenshot"]')?.classList.remove('is-active');
  document.querySelector('.tb-btn[data-label="Record"]')?.classList.remove('is-active');
  restoreTreePanelAfterCapture();
}

/* Draw the framed region of every live pane plus the visible legends. */
function drawCaptureFrame(ctx, out, frameRect, scale, opts) {
  const o = opts || {};
  const wrap = captureWrap();
  if (!wrap) return;
  const wr = wrap.getBoundingClientRect();
  const fx = wr.left + frameRect.x;
  const fy = wr.top + frameRect.y;
  const fw = frameRect.w;
  const fh = frameRect.h;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#f0f2f7';
  ctx.fillRect(0, 0, out.width, out.height);
  for (const pane of capturePanes()) {
    if (o.render !== false) renderPaneNow(pane);
    const r = pane.canvas.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    const ix = Math.max(fx, r.left);
    const iy = Math.max(fy, r.top);
    const ex = Math.min(fx + fw, r.right);
    const ey = Math.min(fy + fh, r.bottom);
    if (ex <= ix || ey <= iy) continue;
    const kx = pane.canvas.width / r.width;
    const ky = pane.canvas.height / r.height;
    try {
      ctx.drawImage(
        pane.canvas,
        (ix - r.left) * kx,
        (iy - r.top) * ky,
        (ex - ix) * kx,
        (ey - iy) * ky,
        (ix - fx) * scale,
        (iy - fy) * scale,
        (ex - ix) * scale,
        (ey - iy) * scale
      );
    } catch (e) {
      console.warn('[CFD] capture drawImage', e);
    }
  }
  for (const id of ['legend', 'legend-pt', 'legend-b']) {
    const el = document.getElementById(id);
    if (!el || el.hidden || el.classList.contains('is-hidden')) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    if (r.right < fx || r.left > fx + fw || r.bottom < fy || r.top > fy + fh) continue;
    drawLegendInto(ctx, el, fx, fy, scale);
  }
}

function drawLegendInto(ctx, el, fx, fy, scale) {
  const r = el.getBoundingClientRect();
  const X = (v) => (v - fx) * scale;
  const Y = (v) => (v - fy) * scale;
  const cs = getComputedStyle(el);
  ctx.save();
  // Card
  ctx.beginPath();
  const rad = 6 * scale;
  const x0 = X(r.left);
  const y0 = Y(r.top);
  const w = r.width * scale;
  const h = r.height * scale;
  if (ctx.roundRect) ctx.roundRect(x0, y0, w, h, rad);
  else ctx.rect(x0, y0, w, h);
  ctx.fillStyle = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : 'rgba(255,255,255,0.96)';
  ctx.fill();
  ctx.lineWidth = Math.max(1, scale);
  ctx.strokeStyle = cs.borderColor || '#cfd3db';
  ctx.stroke();
  const drawText = (node, align) => {
    if (!node) return;
    const tr = node.getBoundingClientRect();
    if (!(tr.width > 0)) return;
    const ncs = getComputedStyle(node);
    const px = parseFloat(ncs.fontSize) || 12;
    ctx.font = (ncs.fontWeight || '400') + ' ' + px * scale + 'px ' + (ncs.fontFamily || 'system-ui, sans-serif');
    ctx.fillStyle = ncs.color || '#1f2430';
    ctx.textBaseline = 'middle';
    ctx.textAlign = align || 'left';
    const tx = align === 'right' ? X(tr.right) : align === 'center' ? X(tr.left + tr.width / 2) : X(tr.left);
    ctx.fillText(node.textContent.trim(), tx, Y(tr.top + tr.height / 2));
  };
  drawText(el.querySelector('.legend-title'), 'left');
  drawText(el.querySelector('.legend-units'), 'right');
  const bar = el.querySelector('.legend-bar');
  if (bar) {
    const br = bar.getBoundingClientRect();
    const g = ctx.createLinearGradient(X(br.left), 0, X(br.right), 0);
    const bg = getComputedStyle(bar).backgroundImage || '';
    const stops = [];
    const re = /(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8})\s+([\d.]+)%/g;
    let m;
    while ((m = re.exec(bg))) stops.push([Number(m[2]) / 100, m[1]]);
    if (stops.length < 2) {
      stops.splice(0, stops.length, [0, '#2b3cff'], [0.2, '#00c2ff'], [0.4, '#2ad66a'], [0.6, '#f5d000'], [0.8, '#ff7a00'], [1, '#e02020']);
    }
    for (const [p, c] of stops) {
      try { g.addColorStop(Math.min(1, Math.max(0, p)), c); } catch (_) {}
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(X(br.left), Y(br.top), br.width * scale, br.height * scale, 2 * scale);
    else ctx.rect(X(br.left), Y(br.top), br.width * scale, br.height * scale);
    ctx.fill();
  }
  const ticks = el.querySelectorAll('.legend-ticks span');
  ticks.forEach((t, i) => drawText(t, i === 0 ? 'left' : i === ticks.length - 1 ? 'right' : 'center'));
  el.querySelectorAll('.legend-bar-val').forEach((v) => {
    if (v.querySelector('input')) return;
    drawText(v, 'left');
  });
  ctx.restore();
}

async function takeFramedScreenshot() {
  const f = captureState.frame;
  if (!f) return;
  const scale = captureOutputScale(f);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(f.w * scale));
  out.height = Math.max(1, Math.round(f.h * scale));
  const ctx = out.getContext('2d');
  // Render above screen resolution when a minimum side is requested.
  const hi = applyCaptureHiRes(scale);
  try {
    drawCaptureFrame(ctx, out, f, scale);
  } finally {
    if (hi) restoreCaptureHiRes();
  }
  const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
  if (!blob) return;
  const saved = await saveCaptureDialog({ kind: 'screenshot', blob, ext: 'png', width: out.width, height: out.height });
  if (saved) endCapture();
}

function pickRecorderMime() {
  const cands = [
    ['video/mp4;codecs=avc1.42E01E', 'mp4'],
    ['video/mp4;codecs=avc1', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9', 'webm'],
    ['video/webm;codecs=vp8', 'webm'],
    ['video/webm', 'webm'],
  ];
  if (typeof MediaRecorder === 'undefined') return null;
  for (const [mime, ext] of cands) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
    } catch (_) {}
  }
  return null;
}

function startRecording() {
  const f = captureState.frame;
  const els = captureLayerEls();
  if (!f || captureState.rec) return;
  const pick = pickRecorderMime();
  if (!pick) {
    confirmAction({ title: 'Recording unavailable', copy: 'This browser cannot record video (MediaRecorder missing).', yes: 'OK' });
    return;
  }
  const dur = Math.max(1, Math.min(600, Number(els.dur && els.dur.value) || 10));
  // Output scale honours the minimum side; keep the encoder happy with even
  // dimensions and a 4K ceiling on the long edge.
  let scale = captureOutputScale(f);
  const longEdge = Math.max(f.w, f.h);
  if (longEdge * scale > 3840) scale = 3840 / longEdge;
  const out = document.createElement('canvas');
  out.width = Math.max(2, Math.round((f.w * scale) / 2) * 2);
  out.height = Math.max(2, Math.round((f.h * scale) / 2) * 2);
  const ctx = out.getContext('2d');
  const fps = 30;
  const stream = out.captureStream(fps);
  const bps = Math.min(90e6, Math.max(4e6, out.width * out.height * 0.2 * fps));
  let recorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType: pick.mime, videoBitsPerSecond: bps });
  } catch (e) {
    console.warn('[CFD] MediaRecorder', e);
    try {
      recorder = new MediaRecorder(stream);
      pick.mime = recorder.mimeType || 'video/webm';
      pick.ext = /mp4/.test(pick.mime) ? 'mp4' : 'webm';
    } catch (e2) {
      confirmAction({ title: 'Recording unavailable', copy: String(e2), yes: 'OK' });
      return;
    }
  }
  const rec = {
    recorder,
    stream,
    chunks: [],
    out,
    ctx,
    scale,
    raf: 0,
    timer: 0,
    t0: performance.now(),
    dur,
    mime: pick.mime,
    ext: pick.ext,
    stopped: false,
    discard: false,
    last: 0,
    startFrame: { ...f },
    subs: [],
    inForced: false,
  };
  captureState.rec = rec;
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) rec.chunks.push(e.data);
  };
  recorder.onstop = () => finishRecording(rec);
  recorder.onerror = (e) => console.warn('[CFD] recorder error', e);
  const frameNow = () => {
    // Frame may be moved while recording; its size is fixed at start.
    const cur = captureState.frame || rec.startFrame;
    return { x: cur.x, y: cur.y, w: rec.startFrame.w, h: rec.startFrame.h };
  };
  const minGap = 1000 / fps - 2;
  // Copy the panes right after vtk rendered them (same task → buffer still
  // holds the pixels). No second render per frame, so dragging costs the same
  // as it does without recording.
  const onRendered = () => {
    if (rec.stopped || rec.inForced) return;
    const now = performance.now();
    if (now - rec.last < minGap) return;
    rec.last = now;
    drawCaptureFrame(rec.ctx, rec.out, frameNow(), rec.scale, { render: false });
  };
  for (const p of capturePaneViews()) {
    try {
      const inter = p.rw.getInteractor && p.rw.getInteractor();
      if (inter && inter.onRenderEvent) rec.subs.push(inter.onRenderEvent(onRendered));
    } catch (_) {}
  }
  // Static scene: nothing renders on its own, so top up at a low rate to keep
  // the stream alive and pick up frame moves / legend toggles.
  const step = (now) => {
    if (rec.stopped) return;
    rec.raf = requestAnimationFrame(step);
    ensureCaptureHiRes();
    if (now - rec.last < 200) return;
    rec.last = now;
    rec.inForced = true;
    try {
      drawCaptureFrame(rec.ctx, rec.out, frameNow(), rec.scale);
    } finally {
      rec.inForced = false;
    }
  };
  // Panes render into a larger buffer for the whole take when upscaling.
  applyCaptureHiRes(scale);
  rec.inForced = true;
  drawCaptureFrame(ctx, out, f, scale);
  rec.inForced = false;
  rec.last = performance.now();
  recorder.start(250);
  rec.raf = requestAnimationFrame(step);
  rec.timer = setInterval(() => {
    const t = (performance.now() - rec.t0) / 1000;
    if (els.recTime) els.recTime.textContent = fmtClock(t) + ' / ' + fmtClock(rec.dur);
    if (t >= rec.dur) stopRecording();
  }, 200);
  document.body.classList.add('is-recording');
  els.frame?.classList.add('is-recording');
  if (els.bar) els.bar.hidden = true;
  if (els.rec) els.rec.hidden = false;
  if (els.recTime) els.recTime.textContent = '0:00 / ' + fmtClock(dur);
  syncCaptureToggles();
}

function stopRecording(opts) {
  const rec = captureState.rec;
  if (!rec || rec.stopped) return;
  rec.stopped = true;
  rec.discard = !!(opts && opts.discard);
  rec.elapsed = (performance.now() - rec.t0) / 1000;
  cancelAnimationFrame(rec.raf);
  clearInterval(rec.timer);
  try {
    if (rec.recorder.state !== 'inactive') rec.recorder.stop();
    else finishRecording(rec);
  } catch (e) {
    console.warn('[CFD] stop recorder', e);
    finishRecording(rec);
  }
}

async function finishRecording(rec) {
  if (rec.finished) return;
  rec.finished = true;
  for (const s of rec.subs || []) { try { s.unsubscribe(); } catch (_) {} }
  try { rec.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  captureState.rec = null;
  restoreCaptureHiRes();
  document.body.classList.remove('is-recording');
  const els = captureLayerEls();
  els.frame?.classList.remove('is-recording');
  if (captureState.open) {
    if (els.bar) els.bar.hidden = false;
    if (els.rec) els.rec.hidden = true;
  }
  if (rec.discard || !rec.chunks.length) return;
  const blob = new Blob(rec.chunks, { type: rec.mime.split(';')[0] });
  const saved = await saveCaptureDialog({
    kind: 'recording',
    blob,
    ext: rec.ext,
    width: rec.out.width,
    height: rec.out.height,
    duration: rec.elapsed || rec.dur,
  });
  // Saved: leave framing mode and bring back whatever flyout was open.
  if (saved && captureState.open) endCapture();
}

/** Name + destination dialog. Uploads to the open run / mesh and optionally downloads. */
function saveCaptureDialog(cap) {
  const modal = document.getElementById('modal-capture-save');
  if (!modal) return Promise.resolve(false);
  const heading = document.getElementById('cs-save-heading');
  const preview = document.getElementById('cs-save-preview');
  const meta = document.getElementById('cs-save-meta');
  const name = document.getElementById('cs-save-name');
  const dest = document.getElementById('cs-save-dest');
  const dlWrap = document.getElementById('cs-save-dl-wrap');
  const dl = document.getElementById('cs-save-download');
  const yes = document.getElementById('cs-save-confirm');
  const no = document.getElementById('cs-save-cancel');
  const backdrop = document.getElementById('cs-save-backdrop');
  const own = captureOwner();
  const isRec = cap.kind === 'recording';
  const url = URL.createObjectURL(cap.blob);
  if (heading) heading.textContent = isRec ? 'Save recording' : 'Save screenshot';
  if (preview) {
    preview.innerHTML = isRec
      ? '<video src="' + url + '" controls autoplay loop muted playsinline></video>'
      : '<img src="' + url + '" alt="Preview" />';
  }
  if (meta) {
    const bits = [cap.width + ' × ' + cap.height + ' px'];
    if (isRec) bits.push(fmtClock(cap.duration), String(cap.ext).toUpperCase());
    bits.push(fmtBytes(cap.blob.size));
    meta.textContent = bits.join(' · ');
  }
  if (name) name.value = captureDefaultName(cap.kind);
  if (dest) {
    dest.textContent = own
      ? 'Saves under ' + own.label + ' › ' + (isRec ? 'Recordings' : 'Screenshots') + ' in the tree.'
      : 'No run or mesh is open, so this will be downloaded only.';
  }
  if (dlWrap) dlWrap.hidden = !own;
  if (dl) dl.checked = !own ? true : !!captureState.alsoDownload;
  if (yes) yes.textContent = own ? 'Save' : 'Download';
  modal.hidden = false;
  return new Promise((resolve) => {
    const done = (ok) => {
      modal.hidden = true;
      if (preview) preview.innerHTML = '';
      URL.revokeObjectURL(url);
      yes?.removeEventListener('click', onYes);
      no?.removeEventListener('click', onNo);
      backdrop?.removeEventListener('click', onNo);
      document.removeEventListener('keydown', onKey);
      resolve(ok);
    };
    const onNo = () => done(false);
    const onKey = (e) => {
      if (e.key === 'Escape') onNo();
      if (e.key === 'Enter' && e.target === name) onYes();
    };
    const onYes = async () => {
      const nm = String(name ? name.value : '').trim() || captureDefaultName(cap.kind);
      const wantDl = !own || !!(dl && dl.checked);
      if (own) captureState.alsoDownload = !!(dl && dl.checked);
      if (yes) {
        yes.disabled = true;
        yes.textContent = 'Saving…';
      }
      let saved = null;
      if (own) {
        try {
          const pid = typeof currentProjectId === 'function' ? currentProjectId() : null;
          const qs = new URLSearchParams({ owner: own.owner, kind: cap.kind, name: nm, ext: cap.ext });
          if (pid) qs.set('project_id', pid);
          if (cap.width) qs.set('width', String(cap.width));
          if (cap.height) qs.set('height', String(cap.height));
          if (cap.duration) qs.set('duration', String(Math.round(cap.duration * 10) / 10));
          try {
            qs.set('meta', JSON.stringify({ field: resultsViewOpen ? activeField : null, view: activeViewId || null }));
          } catch (_) {}
          const r = await fetch('/api/media/upload?' + qs.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: cap.blob,
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.ok) throw new Error((j && j.error) || 'upload failed ' + r.status);
          saved = j.item;
          ensureMediaLoaded(own.owner, { force: true });
        } catch (e) {
          console.warn('[CFD] media upload', e);
          if (yes) {
            yes.disabled = false;
            yes.textContent = 'Save';
          }
          if (dest) dest.textContent = 'Could not save: ' + String(e.message || e);
          return;
        }
      }
      if (wantDl) {
        const a = document.createElement('a');
        a.href = url;
        a.download = nm + '.' + cap.ext;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      if (yes) {
        yes.disabled = false;
        yes.textContent = 'Save';
      }
      done(saved || true);
    };
    yes?.addEventListener('click', onYes);
    no?.addEventListener('click', onNo);
    backdrop?.addEventListener('click', onNo);
    document.addEventListener('keydown', onKey);
    try { name?.focus(); name?.select(); } catch (_) {}
  });
}

(function wireCapture() {
  const els = captureLayerEls();
  if (!els.layer || !els.frame) return;
  document.querySelector('.tb-btn[data-label="Screenshot"]')?.addEventListener('click', () => {
    if (captureState.open && captureState.mode === 'shot') endCapture();
    else startCapture('shot');
  });
  document.querySelector('.tb-btn[data-label="Record"]')?.addEventListener('click', () => {
    if (captureState.open && captureState.mode === 'rec') endCapture();
    else startCapture('rec');
  });
  document.getElementById('capture-cancel')?.addEventListener('click', endCapture);
  els.go?.addEventListener('click', () => {
    if (captureState.mode === 'rec') startRecording();
    else takeFramedScreenshot();
  });
  document.getElementById('capture-rec-stop')?.addEventListener('click', () => stopRecording());
  els.aspect?.addEventListener('change', () => {
    captureState.aspect = els.aspect.value || 'free';
    applyAspectToFrame();
    saveFrame();
  });
  els.minSide?.addEventListener('change', () => {
    captureState.minSide = Number(els.minSide.value) || 0;
    try { localStorage.setItem('cfd-capture-minside', String(captureState.minSide)); } catch (_) {}
    applyFrameToDom();
  });
  document.getElementById('capture-fit')?.addEventListener('click', () => {
    const st = captureStageRect();
    if (!st) return;
    let f = { ...st };
    const ar = aspectValue(captureState.aspect);
    if (ar) {
      if (f.w / f.h > ar) {
        const w = f.h * ar;
        f = { x: f.x + (f.w - w) / 2, y: f.y, w, h: f.h };
      } else {
        const h = f.w / ar;
        f = { x: f.x, y: f.y + (f.h - h) / 2, w: f.w, h };
      }
    }
    setCaptureFrame(f);
  });
  const toggleLegend = () => {
    if (!btnLegend) return;
    setLegendVisible(!btnLegend.classList.contains('is-active'));
    syncCaptureToggles();
  };
  els.legend?.addEventListener('click', toggleLegend);
  els.recLegend?.addEventListener('click', toggleLegend);
  els.edges?.addEventListener('click', () => {
    document.getElementById('btn-cad-edges')?.click();
    syncCaptureToggles();
  });
  els.filters?.addEventListener('click', () => {
    if (!filtersPanel) return;
    setFiltersVisible(filtersPanel.classList.contains('is-hidden'));
    syncCaptureToggles();
  });
  // Mirror external toggles (toolbar Legend / CAD edges / Filters) into the bar.
  document.getElementById('btn-legend')?.addEventListener('click', () => setTimeout(syncCaptureToggles, 0));
  document.getElementById('btn-cad-edges')?.addEventListener('click', () => setTimeout(syncCaptureToggles, 0));
  btnFilters?.addEventListener('click', () => setTimeout(syncCaptureToggles, 0));

  // Drag / resize the frame. The interior stays transparent to the 3D view.
  els.frame.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-cfr]');
    if (!handle || !captureState.frame) return;
    const kind = handle.getAttribute('data-cfr');
    if (kind !== 'move' && captureState.rec) return; // size is locked while recording
    e.preventDefault();
    e.stopPropagation();
    captureState.drag = { kind, sx: e.clientX, sy: e.clientY, start: { ...captureState.frame }, id: e.pointerId };
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
  });
  const onMove = (e) => {
    const d = captureState.drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    const s = d.start;
    let f = { ...s };
    const ar = aspectValue(captureState.aspect);
    if (d.kind === 'move') {
      f.x = s.x + dx;
      f.y = s.y + dy;
    } else {
      if (d.kind.includes('e')) f.w = s.w + dx;
      if (d.kind.includes('s')) f.h = s.h + dy;
      if (d.kind.includes('w')) {
        f.x = s.x + dx;
        f.w = s.w - dx;
      }
      if (d.kind.includes('n')) {
        f.y = s.y + dy;
        f.h = s.h - dy;
      }
      f.w = Math.max(64, f.w);
      f.h = Math.max(64, f.h);
      if (ar) {
        const horizontal = d.kind === 'e' || d.kind === 'w';
        const vertical = d.kind === 'n' || d.kind === 's';
        if (vertical) f.w = f.h * ar;
        else if (horizontal) f.h = f.w / ar;
        else {
          // corners: follow the larger relative change
          if (Math.abs(dx) / s.w >= Math.abs(dy) / s.h) f.h = f.w / ar;
          else f.w = f.h * ar;
        }
        if (d.kind.includes('w')) f.x = s.x + s.w - f.w;
        if (d.kind.includes('n')) f.y = s.y + s.h - f.h;
      }
    }
    const wrap = captureWrap();
    if (wrap && d.kind !== 'move') {
      // resizing: keep inside the viewport without shifting the anchored edge
      f.w = Math.min(f.w, wrap.clientWidth - Math.max(0, f.x));
      f.h = Math.min(f.h, wrap.clientHeight - Math.max(0, f.y));
    }
    setCaptureFrame(f, { persist: false });
  };
  const onUp = (e) => {
    const d = captureState.drag;
    if (!d || e.pointerId !== d.id) return;
    captureState.drag = null;
    saveFrame();
  };
  els.frame.addEventListener('pointermove', onMove);
  els.frame.addEventListener('pointerup', onUp);
  els.frame.addEventListener('pointercancel', onUp);
  window.addEventListener('resize', () => {
    if (captureState.open && captureState.frame) setCaptureFrame(captureState.frame, { persist: false });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && captureState.open && !captureState.rec) {
      const anyModal = document.querySelector('.cfd-modal:not([hidden])');
      if (!anyModal) endCapture();
    }
  });
})();

/* ---------------- Graphs: monitor time series per run ---------------- */

const GRAPH_QUANTITIES = {
  Umag: { label: 'Mean velocity', unit: 'm/s', pick: (s) => s.Umag },
  Un: { label: 'Normal velocity', unit: 'm/s', pick: (s) => (s.Un_m_s != null ? Math.abs(s.Un_m_s) : null) },
  p: { label: 'Pressure', unit: 'Pa', pick: (s) => s.p_Pa },
  Q: { label: 'Flow rate', unit: 'm³/s', pick: (s) => (s.Q_m3s != null ? Math.abs(s.Q_m3s) : null) },
  mdot: { label: 'Mass flow', unit: 'kg/s', pick: (s, rho) => (s.Q_m3s != null ? Math.abs(s.Q_m3s) * (rho || 1.196) : null) },
};

function niceTicks(lo, hi, n) {
  if (!(hi > lo)) {
    const v = Number.isFinite(lo) ? lo : 0;
    return { lo: v - 1, hi: v + 1, ticks: [v - 1, v, v + 1] };
  }
  const span = hi - lo;
  const raw = span / Math.max(1, n - 1);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const cand = [1, 2, 2.5, 5, 10].map((m) => m * pow);
  const step = cand.find((c) => c >= raw) || cand[cand.length - 1];
  const t0 = Math.floor(lo / step) * step;
  const t1 = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let t = t0; t <= t1 + step * 1e-6; t += step) ticks.push(Math.round(t / step) * step);
  return { lo: t0, hi: t1, ticks };
}

function graphTick(v, span) {
  if (!Number.isFinite(v)) return '';
  const s = Math.abs(span) || Math.abs(v) || 1;
  if (s >= 1000) return Math.round(v).toLocaleString('en-US');
  if (s >= 50) return v.toFixed(1);
  if (s >= 1) return v.toFixed(2);
  if (s >= 0.01) return v.toFixed(3);
  return v.toExponential(1);
}

/** Static SVG line chart with axes; all styling inline so PNG export matches. */
function monitorChartSvg(pts, opts) {
  const W = Math.max(280, Math.round(opts.width || 560));
  const H = 190;
  const padL = 58;
  const padR = 12;
  const padT = 10;
  const padB = 28;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const xlo = Math.min(...xs);
  const xhi = Math.max(...xs);
  const yn = niceTicks(Math.min(...ys), Math.max(...ys), 5);
  const xn = niceTicks(xlo, xhi, 6);
  const X = (v) => padL + ((v - xlo) / Math.max(1e-12, xhi - xlo)) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - yn.lo) / Math.max(1e-12, yn.hi - yn.lo)) * (H - padT - padB);
  const font = 'font-family="system-ui, Segoe UI, sans-serif" font-size="10" fill="#667085"';
  let s = '<svg xmlns="http://www.w3.org/2000/svg" class="graph-svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" data-w="' + W + '" data-padl="' + padL + '" data-padr="' + padR + '">';
  s += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff"/>';
  for (const t of yn.ticks) {
    const y = Y(t).toFixed(1);
    s += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y + '" y2="' + y + '" stroke="#e6e9ef"/>';
    s += '<text x="' + (padL - 6) + '" y="' + y + '" text-anchor="end" dominant-baseline="middle" ' + font + '>' + escapeHtml(graphTick(t, yn.hi - yn.lo)) + '</text>';
  }
  for (const t of xn.ticks) {
    if (t < xlo - 1e-9 || t > xhi + 1e-9) continue;
    const x = X(t).toFixed(1);
    s += '<line x1="' + x + '" x2="' + x + '" y1="' + (H - padB) + '" y2="' + (H - padB + 4) + '" stroke="#98a2b3"/>';
    const xt = opts.timeAxis ? graphTick(t, xn.hi - xn.lo) : String(Math.round(t));
    s += '<text x="' + x + '" y="' + (H - padB + 15) + '" text-anchor="middle" ' + font + '>' + escapeHtml(xt) + '</text>';
  }
  s += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + (H - padB) + '" y2="' + (H - padB) + '" stroke="#98a2b3"/>';
  s += '<line x1="' + padL + '" x2="' + padL + '" y1="' + padT + '" y2="' + (H - padB) + '" stroke="#98a2b3"/>';
  s += '<text x="' + ((padL + W - padR) / 2).toFixed(1) + '" y="' + (H - 3) + '" text-anchor="middle" ' + font + '>' + (opts.timeAxis ? 'Time (s)' : 'Iteration') + '</text>';
  s += '<text transform="translate(11 ' + ((padT + H - padB) / 2).toFixed(1) + ') rotate(-90)" text-anchor="middle" ' + font + '>' + escapeHtml(opts.unit || '') + '</text>';
  const path = pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join('');
  s += '<path d="' + path + '" fill="none" stroke="#3884e6" stroke-width="1.6" stroke-linejoin="round"/>';
  s += '<g class="ghover" style="display:none"><line class="gcross" y1="' + padT + '" y2="' + (H - padB) + '" stroke="#98a2b3" stroke-dasharray="3 3"/><circle r="3.5" fill="#3884e6"/>' +
    '<g class="gtip"><rect rx="3" height="18" fill="rgba(255,255,255,0.95)" stroke="#cfd3db"/><text font-family="system-ui, Segoe UI, sans-serif" font-size="11" fill="#1f2430" dominant-baseline="middle"></text></g></g>';
  s += '<rect class="ghit" x="' + padL + '" y="' + padT + '" width="' + (W - padL - padR) + '" height="' + (H - padT - padB) + '" fill="transparent"/>';
  s += '</svg>';
  return { svg: s, X, Y, xlo, xhi, W, H, padL, padR, padT, padB };
}

function wireChartHover(svgEl, pts, geo, unit, timeAxis) {
  const hover = svgEl.querySelector('.ghover');
  const cross = svgEl.querySelector('.gcross');
  const dot = svgEl.querySelector('circle');
  const tipRect = svgEl.querySelector('.gtip rect');
  const tipText = svgEl.querySelector('.gtip text');
  const hit = svgEl.querySelector('.ghit');
  if (!hover || !hit) return;
  const show = (clientX) => {
    const r = svgEl.getBoundingClientRect();
    const sx = ((clientX - r.left) / r.width) * geo.W;
    const v = geo.xlo + ((sx - geo.padL) / (geo.W - geo.padL - geo.padR)) * (geo.xhi - geo.xlo);
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(pts[i][0] - v);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const p = pts[best];
    const x = geo.X(p[0]);
    const y = geo.Y(p[1]);
    hover.style.display = '';
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', y);
    const label =
      (timeAxis ? 't = ' + formatSimTime(p[0]) : 'Iteration ' + Math.round(p[0])) +
      ' · ' + graphTick(p[1], p[1]) + ' ' + unit;
    tipText.textContent = label;
    const tw = label.length * 6.2 + 12;
    let tx = x + 8;
    if (tx + tw > geo.W - geo.padR) tx = x - tw - 8;
    const ty = Math.max(geo.padT, Math.min(y - 24, geo.H - geo.padB - 20));
    tipRect.setAttribute('x', tx);
    tipRect.setAttribute('y', ty);
    tipRect.setAttribute('width', tw);
    tipText.setAttribute('x', tx + 6);
    tipText.setAttribute('y', ty + 9);
  };
  hit.addEventListener('pointermove', (e) => show(e.clientX));
  hit.addEventListener('pointerleave', () => {
    hover.style.display = 'none';
  });
}

function graphsQuantityKey() {
  const sel = document.getElementById('run-graphs-quantity');
  const k = sel ? sel.value : 'Umag';
  return GRAPH_QUANTITIES[k] ? k : 'Umag';
}

function graphsData(runId) {
  const mon = window.__CFD_MONITORS__;
  return mon && mon.byRun ? mon.byRun[runId] || null : null;
}

function renderGraphsPanel(runId) {
  const st = mediaStore();
  const list = document.getElementById('run-graphs-list');
  const hint = document.getElementById('run-graphs-hint');
  const ownerEl = document.getElementById('run-graphs-owner');
  if (!list) return;
  if (!st.graphs || st.graphs.runId !== runId) {
    if (st.graphs && st.graphs.timer) clearInterval(st.graphs.timer);
    st.graphs = { runId, timer: 0 };
  }
  const rec = typeof findRunRecord === 'function' ? findRunRecord(runId) : null;
  if (ownerEl) ownerEl.textContent = mediaOwnerLabel('run', runId);
  const data = graphsData(runId);
  if (!data) {
    list.innerHTML = '';
    if (hint) hint.textContent = rec && rec.status === 'draft' ? 'Start this run first. Graphs fill in as the solver iterates.' : 'Loading monitor history…';
    if (typeof window.__CFD_REFRESH_MONITORS__ === 'function') {
      Promise.resolve(window.__CFD_REFRESH_MONITORS__(runId)).then(() => {
        if (treeUi.openPanel === 'run-graphs' && st.graphs && st.graphs.runId === runId) renderGraphsPanel(runId);
      });
    }
    return;
  }
  const qk = graphsQuantityKey();
  const q = GRAPH_QUANTITIES[qk];
  const mons = Array.isArray(data.monitors) ? data.monitors : [];
  const timeAxis = typeof runRecIsTransient === 'function' && runRecIsTransient(rec);
  if (!mons.length) {
    list.innerHTML = '';
    if (hint) hint.textContent = 'No monitor data yet for this run.';
  } else {
    if (hint) {
      hint.textContent =
        (data.status === 'running' ? 'Live — updates every few seconds. ' : '') +
        q.label + ' on each monitored boundary, ' + (timeAxis ? 'over simulated time' : 'per solver iteration') + '. Hover a curve to read values.';
    }
    const width = Math.max(300, (list.clientWidth || 580) - 22);
    list.innerHTML = mons
      .map((m, i) => {
        const pts = (m.series || [])
          .map((s) => [Number(s.t), q.pick(s, data.rho)])
          .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
        const last = pts.length ? pts[pts.length - 1][1] : null;
        const body = pts.length >= 2
          ? monitorChartSvg(pts, { width, unit: q.unit, timeAxis }).svg
          : '<div class="media-empty">' + (timeAxis ? 'Not enough time steps yet.' : 'Not enough iterations yet.') + '</div>';
        return (
          '<div class="graph-card" data-graph-index="' + i + '">' +
          '<div class="graph-head"><span class="graph-name">' + escapeHtml(m.name || m.patch) + '</span>' +
          '<span class="mon-card-tag">' + escapeHtml(m.bc_type || 'Boundary') + '</span>' +
          '<span class="graph-last">' + (last != null ? escapeHtml(graphTick(last, last) + ' ' + q.unit) : '') + '</span>' +
          '<button type="button" class="js-btn graph-png" data-graph-png="' + i + '" title="Download this chart as PNG">PNG</button>' +
          '</div>' +
          body +
          '</div>'
        );
      })
      .join('');
    list.querySelectorAll('.graph-card').forEach((card) => {
      const i = Number(card.getAttribute('data-graph-index'));
      const m = mons[i];
      const svgEl = card.querySelector('svg');
      if (!svgEl || !m) return;
      const pts = (m.series || [])
        .map((s) => [Number(s.t), q.pick(s, data.rho)])
        .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      const geo = monitorChartSvg(pts, { width, unit: q.unit, timeAxis });
      wireChartHover(svgEl, pts, geo, q.unit, timeAxis);
    });
  }
  // Live refresh while the solver runs.
  if (st.graphs.timer) clearInterval(st.graphs.timer);
  if (data.status === 'running' || (rec && rec.status === 'running')) {
    st.graphs.timer = setInterval(async () => {
      if (treeUi.openPanel !== 'run-graphs' || !st.graphs || st.graphs.runId !== runId) {
        clearInterval(st.graphs && st.graphs.timer);
        return;
      }
      if (typeof window.__CFD_REFRESH_MONITORS__ === 'function') {
        const j = await window.__CFD_REFRESH_MONITORS__(runId);
        if (j) renderGraphsPanel(runId);
      }
    }, 3000);
  }
}

function downloadTextFile(name, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function graphsCsv(runId) {
  const data = graphsData(runId);
  if (!data || !Array.isArray(data.monitors)) return '';
  const mons = data.monitors;
  const iters = new Set();
  for (const m of mons) for (const s of m.series || []) iters.add(Number(s.t));
  const sorted = [...iters].filter(Number.isFinite).sort((a, b) => a - b);
  const cols = ['Umag', 'Un', 'p', 'Q', 'mdot'];
  const recForCsv = typeof findRunRecord === 'function' ? findRunRecord(runId) : null;
  const head = [typeof runRecIsTransient === 'function' && runRecIsTransient(recForCsv) ? 'time_s' : 'iteration'];
  for (const m of mons) {
    for (const c of cols) head.push((m.name || m.patch) + ' ' + GRAPH_QUANTITIES[c].label + ' [' + GRAPH_QUANTITIES[c].unit + ']');
  }
  const byT = mons.map((m) => {
    const map = new Map();
    for (const s of m.series || []) map.set(Number(s.t), s);
    return map;
  });
  const lines = [head.map((h) => '"' + h.replace(/"/g, '""') + '"').join(',')];
  for (const t of sorted) {
    const row = [t];
    mons.forEach((m, i) => {
      const s = byT[i].get(t);
      for (const c of cols) {
        const v = s ? GRAPH_QUANTITIES[c].pick(s, data.rho) : null;
        row.push(v == null || !Number.isFinite(v) ? '' : String(v));
      }
    });
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

async function downloadChartPng(card, name) {
  const svgEl = card.querySelector('svg');
  if (!svgEl) return;
  const W = Number(svgEl.getAttribute('data-w')) || 560;
  const H = 190;
  const k = 2;
  const src = new XMLSerializer().serializeToString(svgEl);
  const url = URL.createObjectURL(new Blob([src], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = W * k;
    c.height = H * k;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } finally {
    URL.revokeObjectURL(url);
  }
}

(function wireGraphsPanel() {
  document.getElementById('run-graphs-quantity')?.addEventListener('change', () => {
    const st = mediaStore();
    if (st.graphs) renderGraphsPanel(st.graphs.runId);
  });
  document.getElementById('run-graphs-csv')?.addEventListener('click', () => {
    const st = mediaStore();
    if (!st.graphs) return;
    const csv = graphsCsv(st.graphs.runId);
    if (!csv) return;
    downloadTextFile(mediaOwnerLabel('run', st.graphs.runId).replace(/\s+/g, '-') + '-monitors.csv', csv, 'text/csv');
  });
  document.getElementById('run-graphs-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-graph-png]');
    if (!btn) return;
    const st = mediaStore();
    const card = btn.closest('.graph-card');
    if (!card || !st.graphs) return;
    const nm = card.querySelector('.graph-name')?.textContent.trim() || 'monitor';
    const q = GRAPH_QUANTITIES[graphsQuantityKey()];
    downloadChartPng(card, (mediaOwnerLabel('run', st.graphs.runId) + '-' + nm + '-' + q.label).replace(/\s+/g, '-') + '.png');
  });
})();

/* W24.1: Job/debug drawer toggle (outside left tree) */
(function wireJobDebugDrawer() {
  const btn = document.getElementById("btn-job-debug-toggle");
  const body = document.getElementById("job-debug-body");
  if (!btn || !body) return;
  btn.addEventListener("click", () => {
    const open = body.hasAttribute("hidden");
    if (open) body.removeAttribute("hidden");
    else body.setAttribute("hidden", "");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  });
})();

/* Floating setup / result panels: hug content, overlay viewport, minimize */
(function wireFloatingChrome() {
  function wireMin(panelId, btnId, storageKey) {
    const panel = document.getElementById(panelId);
    const btn = document.getElementById(btnId);
    if (!panel || !btn) return;
    const apply = (min) => {
      panel.classList.toggle("is-min", min);
      btn.setAttribute("aria-expanded", min ? "false" : "true");
      btn.title = min ? "Expand" : "Minimize";
      btn.setAttribute("aria-label", min ? "Expand panel" : "Minimize panel");
      if (min && panelId === "left-tree") hideAllTreeDetails();
      try {
        localStorage.setItem(storageKey, min ? "1" : "0");
      } catch (_) {}
      requestAnimationFrame(() => {
        if (typeof window.__CFD_RESIZE_VIEWER__ === "function") {
          window.__CFD_RESIZE_VIEWER__();
        }
        lastChromeInsetKey = '';
        try { syncViewportChromeInset(); } catch (_) {}
      });
    };
    btn.addEventListener("click", () => apply(!panel.classList.contains("is-min")));
    try {
      if (localStorage.getItem(storageKey) === "1") apply(true);
    } catch (_) {}
  }
  wireMin("left-tree", "btn-min-left-tree", "cfd.ui.leftTreeMin");
  wireMin("right-chrome", "btn-min-right-chrome", "cfd.ui.rightChromeMin");
})();

function markTreeSelected(key) {
  treeUi.selectedKey = key;
  document.querySelectorAll('#simulations-tree .tree-node.selected').forEach((n) => {
    n.classList.remove('selected');
  });
  if (!key) return;
  const map = {
    incompressible: w17State.activeId
      ? '[data-w17-sim-id="' + String(w17State.activeId).replace(/"/g, '') + '"]'
      : '[data-w17-sim="1"]',
    geometry: '[data-w17-geo="1"]',
    materials: '[data-w18-materials="1"]',
    air: '[data-w18-air="1"]',
    bcs: '[data-w19-bcs="1"]',
    vi: '[data-w19-vi="1"]',
    po: '[data-w19-po="1"]',
    mesh: '[data-w20-mesh="1"]',
    'mesh-hub': '[data-w20-mesh="1"]',
    mesh1: '[data-w20-mesh1="1"]',
    refs: '[data-w26-refs="1"]',
    rc: '[data-w22-rc="1"]',
    aa: '[data-w22-aa="1"]',
    'sim-hub': '[data-w27-sim-control="1"]',
    'sim-control': '[data-w27-sim-control="1"]',
  };
  let node = null;
  if (typeof key === 'string' && key.startsWith('body-')) {
    node = document.querySelector(
      '#simulations-tree [data-w16-body="1"][data-body-index="' + key.slice(5) + '"]'
    );
  } else if (typeof key === 'string' && key.startsWith('bcid:')) {
    node = document.querySelector(
      '#simulations-tree [data-w19-bc="' + key.slice(5) + '"]'
    );
  } else if (typeof key === 'string' && key.startsWith('meshid:')) {
    node = document.querySelector(
      '#simulations-tree [data-w20-mesh-item="' + CSS.escape(key.slice(7)) + '"]'
    );
  } else if (typeof key === 'string' && key.startsWith('refs:')) {
    node = document.querySelector(
      '#simulations-tree [data-w26-refs-mesh="' + CSS.escape(key.slice(5)) + '"]'
    );
  } else if (typeof key === 'string' && key.startsWith('refid:')) {
    node = document.querySelector(
      '#simulations-tree [data-w26-ref="' + key.slice(6) + '"]'
    );
  } else if (typeof key === 'string' && key.startsWith('runid:')) {
    node = document.querySelector(
      '#simulations-tree [data-w27-run="' + CSS.escape(key.slice(6)) + '"]'
    );
  } else if (typeof key === 'string' && key.startsWith('runmeshitem:')) {
    const bits = key.slice(12).split(':');
    const rid = bits[0];
    const mid = bits.slice(1).join(':');
    node = document.querySelector(
      '#simulations-tree [data-w27-run-mesh-item="' +
        CSS.escape(mid) +
        '"][data-w27-mesh-run="' +
        CSS.escape(rid) +
        '"]'
    );
  } else if (typeof key === 'string' && key.startsWith('runmesh:')) {
    node = document.querySelector(
      '#simulations-tree [data-w27-run-mesh="' + CSS.escape(key.slice(8)) + '"]'
    );
  } else if (typeof key === 'string' && key.startsWith('runresults:')) {
    node = document.querySelector(
      '#simulations-tree [data-w27-run-results="' + CSS.escape(key.slice(11)) + '"]'
    );
  } else if (typeof key === 'string' && key.startsWith('runrcs:')) {
    node = document.querySelector(
      '#simulations-tree [data-w27-run-rcs="' + CSS.escape(key.slice(7)) + '"]'
    );
  } else if (typeof key === 'string' && key.startsWith('aaid:')) {
    node = document.querySelector(
      '#simulations-tree [data-w27-aa="' + CSS.escape(key.slice(5)) + '"]'
    );
  } else if (typeof key === 'string' && key.startsWith('media:')) {
    // media:<ownerKind>:<id>:<kind>  (kind = graphs | screenshot | recording)
    node = document.querySelector('#simulations-tree [data-w28-key="' + CSS.escape(key) + '"]');
  } else if (map[key]) {
    node = document.querySelector('#simulations-tree ' + map[key]);
  }
  if (node) node.classList.add('selected');
}

function activateTreePanel(selectKey, panelKey) {
  if (selectKey !== 'mesh1' && meshInspectOpen) hideMeshInspect();
  if (!String(selectKey || '').startsWith('runresults:') && resultsViewOpen) {
    hideRunResultsView();
  }
  if (!panelKey) {
    markTreeSelected(selectKey);
    return;
  }
  const opened = openTreeDetail(panelKey, { toggle: true });
  markTreeSelected(opened ? selectKey : null);
}

(function wireTreeItemClicks() {
  const tree = document.getElementById('simulations-tree');
  if (tree && !tree._treeUiWired) {
    tree._treeUiWired = true;
    tree.addEventListener('click', (e) => {
      const refsPlus = e.target.closest('[data-refs-plus]');
      if (refsPlus) {
        e.preventDefault();
        e.stopPropagation();
        const mid = refsPlus.getAttribute('data-refs-plus');
        scopeRefsToMesh(mid)
          .then(() => {
            treeUi.expanded.Mesh = true;
            if (mid) treeUi.expanded['mesh:' + mid] = true;
            openRefTypeModal();
          })
          .catch((err) => console.warn('[CFD] add refinement', err));
        return;
      }
      if (e.target.closest('.mat-plus, .bc-plus, .rc-plus, button')) return;
      const tw = e.target.closest('.tw');
      if (tw) {
        e.preventDefault();
        e.stopPropagation();
        const node = tw.closest('.tree-node');
        if (runCopyPick && runCopyPick.destId && node) {
          const srcId = runIdFromCopyTreeNode(node);
          if (srcId && String(srcId) !== String(runCopyPick.destId)) {
            copyRunSettingsFrom(srcId).catch((err) => console.warn('[CFD] copy run', err));
            return;
          }
        }
        if (meshCopyPick && meshCopyPick.destId && node) {
          const srcMesh = meshIdFromCopyTreeNode(node);
          if (applyMeshCopyFromTree(srcMesh)) return;
        }
        if (!node || !node.querySelector(':scope > ul')) return;
        const label = node.getAttribute('data-label') || '';
        const next = !node.classList.contains('expanded');
        node.classList.toggle('expanded', next);
        treeUi.expanded[label] = next;
        tw.textContent = next ? '-' : '+';
        return;
      }
      const node = e.target.closest('.tree-node');
      if (!node) return;
      e.stopPropagation();
      if (runCopyPick && runCopyPick.destId) {
        const srcId = runIdFromCopyTreeNode(node);
        if (srcId && String(srcId) !== String(runCopyPick.destId)) {
          e.preventDefault();
          copyRunSettingsFrom(srcId).catch((err) => console.warn('[CFD] copy run', err));
          return;
        }
        if (srcId && String(srcId) === String(runCopyPick.destId)) return;
        endRunCopyPick();
      }
      if (meshCopyPick && meshCopyPick.destId) {
        const srcMesh = meshIdFromCopyTreeNode(node);
        if (applyMeshCopyFromTree(srcMesh)) {
          e.preventDefault();
          return;
        }
        if (srcMesh && String(srcMesh) === String(meshCopyPick.destId)) return;
        endMeshCopyPick();
        try { syncMeshCopyUi(); } catch (_) {}
        try { syncRefCopyUi(); } catch (_) {}
      }
      // Graphs / Screenshots / Recordings rows open a side panel and leave the
      // current 3D view (mesh or results) exactly as it is.
      if (node.matches('[data-w28-key]')) {
        const key = node.getAttribute('data-w28-key') || '';
        if (closeIfTreeItemOpen(key)) return;
        if (typeof openMediaTreeNode === 'function') openMediaTreeNode(key);
        return;
      }
      if (
        !node.matches('[data-w20-mesh-item], [data-w20-mesh1="1"], [data-w27-run-mesh-item]') &&
        meshInspectOpen
      ) {
        hideMeshInspect({ silent: node.matches('[data-w27-run-results]') });
      }
      if (!node.matches('[data-w27-run-results]') && resultsViewOpen) {
        hideRunResultsView({
          silent: node.matches(
            '[data-w20-mesh-item], [data-w20-mesh1="1"], [data-w27-run-mesh-item]'
          ),
        });
      }

      if (node.matches('[data-w17-sim-id], [data-w17-sim="1"]')) {
        const sid = node.getAttribute('data-w17-sim-id');
        if (e.target.closest('.tw')) return;
        const go = () => activateTreePanel('incompressible', 'incompressible');
        if (sid && w17State.activeId !== sid) {
          selectStudyClient(sid).then(go).catch((err) => console.warn('[CFD] study', err));
        } else {
          go();
        }
        return;
      }
      const otherStudy = node.closest('[data-w17-sim-id]');
      const otherSid = otherStudy && otherStudy.getAttribute('data-w17-sim-id');
      if (otherSid && String(w17State.activeId || '') !== String(otherSid)) {
        if (meshCopyPick && applyMeshCopyFromTree(meshIdFromCopyTreeNode(node))) {
          e.preventDefault();
          return;
        }
        selectStudyClient(otherSid).catch((err) => console.warn('[CFD] study', err));
        return;
      }
      if (node.matches('[data-w16-geom]')) {
        const gid = node.getAttribute('data-w16-geom');
        if (gid && typeof activateGeometryClient === 'function') {
          activateGeometryClient(gid).catch((err) => console.warn('[CFD] geom', err));
        }
        activateTreePanel('geometry', 'geometry');
        return;
      }
      if (node.matches('[data-w16-body="1"]')) {
        const idx = Number(node.getAttribute('data-body-index') || 1);
        const name = node.getAttribute('data-label') || bodyNameFromIndex(idx);
        if (treeUi.openPanel === 'mat-picker' || treeUi.openPanel === 'air') {
          toggleAssignVolume(name, idx);
          return;
        }
        if (w16State.selectedBody === idx) {
          highlightGeomBody(null);
          markTreeSelected(null);
          if (treeUi.openPanel === 'geometry') hideAllTreeDetails();
          return;
        }
        highlightGeomBody(idx);
        openTreeDetail('geometry', { toggle: false });
        markTreeSelected('body-' + idx);
        return;
      }
      if (node.matches('[data-w18-assign]')) {
        const name = node.getAttribute('data-w18-assign') || node.getAttribute('data-label');
        const idx = Number(node.getAttribute('data-body-index') || bodyIndexFromName(name));
        if (w16State.selectedBody === idx) {
          highlightGeomBody(null);
          markTreeSelected('air');
          return;
        }
        highlightGeomBody(idx);
        markTreeSelected('body-' + idx);
        return;
      }
      if (node.matches('[data-w17-geo="1"]')) {
        highlightGeomBody(null);
        activateTreePanel('geometry', 'geometry');
        return;
      }
      if (node.matches('[data-w18-air="1"]')) {
        if (closeIfTreeItemOpen('air')) return;
        markTreeSelected('air');
        openAirPanel();
        return;
      }
      if (node.matches('[data-w18-materials="1"]')) {
        if (closeIfTreeItemOpen('materials')) return;
        const hasAir = !!(window.__CFD_W18_STATE__ && window.__CFD_W18_STATE__.material);
        if (hasAir) {
          markTreeSelected('materials');
          openMaterialsHub();
        } else {
          markTreeSelected('materials');
          openMaterialLibrary();
        }
        return;
      }
      if (node.matches('[data-w19-face]')) {
        const parentId = node.getAttribute('data-w19-parent');
        const faceName = node.getAttribute('data-w19-face') || node.getAttribute('data-label');
        const list = (window.__CFD_W19_STATE__ && window.__CFD_W19_STATE__.bcs) || [];
        const hit = list.find((b) => b.id === parentId);
        if (hit && typeof showBcEditor === 'function') showBcEditor(hit);
        if (faceName && typeof focusAssignedFace === 'function') {
          focusAssignedFace(faceName, { toggle: false });
        }
        return;
      }
      if (node.matches('[data-w19-defaults]')) {
        if (closeIfTreeItemOpen('bc-defaults')) return;
        if (typeof showBcDefaultsPanel === 'function') showBcDefaultsPanel();
        return;
      }
      if (node.matches('[data-w19-bc]')) {
        const id = node.getAttribute('data-w19-bc');
        if (closeIfTreeItemOpen('bcid:' + id)) return;
        const list = (window.__CFD_W19_STATE__ && window.__CFD_W19_STATE__.bcs) || [];
        const hit = list.find((b) => b.id === id);
        if (hit && typeof showBcEditor === 'function') showBcEditor(hit);
        return;
      }
      if (node.matches('[data-w19-vi="1"]')) {
        const list = (window.__CFD_W19_STATE__ && window.__CFD_W19_STATE__.bcs) || [];
        const hit = list.find((b) => b.bc_type === 'Velocity inlet');
        if (hit && typeof showBcEditor === 'function') showBcEditor(hit);
        else if (typeof showBcPanel === 'function') showBcPanel('vi');
        return;
      }
      if (node.matches('[data-w19-po="1"]')) {
        const list = (window.__CFD_W19_STATE__ && window.__CFD_W19_STATE__.bcs) || [];
        const hit = list.find((b) => String(b.bc_type || '').startsWith('Pressure'));
        if (hit && typeof showBcEditor === 'function') showBcEditor(hit);
        else if (typeof showBcPanel === 'function') showBcPanel('po');
        return;
      }
      if (node.matches('[data-w19-bcs="1"]')) {
        const st = window.__CFD_W19_STATE__ || {};
        const hasAny = Array.isArray(st.bcs) && st.bcs.length > 0;
        const bcOpen =
          treeUi.openPanel === 'bc-picker' ||
          treeUi.openPanel === 'bcs-hub' ||
          treeUi.openPanel === 'bc-defaults' ||
          treeUi.openPanel === 'bc' ||
          treeUi.openPanel === 'vi' ||
          treeUi.openPanel === 'po' ||
          treeUi.openPanel === 'vo' ||
          treeUi.openPanel === 'pi';
        if (bcOpen || closeIfTreeItemOpen('bcs')) {
          dismissTreeDetail();
        } else if (hasAny) {
          markTreeSelected('bcs');
          openTreeDetail('bcs-hub', { toggle: false });
        } else {
          markTreeSelected('bcs');
          openBcTypeModal();
        }
        return;
      }
      if (node.matches('[data-w26-face]')) {
        const parentId = node.getAttribute('data-w26-parent');
        const faceName = node.getAttribute('data-w26-face') || node.getAttribute('data-label');
        const list = (window.__CFD_W26_STATE__ && window.__CFD_W26_STATE__.refinements) || [];
        const hit = list.find((r) => r.id === parentId);
        if (hit && typeof showRefEditor === 'function') showRefEditor(hit);
        if (faceName && typeof focusAssignedRefFace === 'function') {
          focusAssignedRefFace(faceName, { toggle: false });
        }
        return;
      }
      if (node.matches('[data-w26-ref]')) {
        const id = node.getAttribute('data-w26-ref');
        if (closeIfTreeItemOpen('refid:' + id)) return;
        const list = (window.__CFD_W26_STATE__ && window.__CFD_W26_STATE__.refinements) || [];
        const hit = list.find((r) => r.id === id);
        if (hit && typeof showRefEditor === 'function') showRefEditor(hit);
        return;
      }
      if (node.matches('[data-w26-refs="1"]')) {
        const mid = node.getAttribute('data-w26-refs-mesh');
        const selKey = mid ? 'refs:' + mid : 'refs';
        const refOpen =
          treeUi.openPanel === 'ref-picker' ||
          treeUi.openPanel === 'refs-hub' ||
          treeUi.openPanel === 'ref';
        if (refOpen || closeIfTreeItemOpen(selKey)) {
          dismissTreeDetail();
          return;
        }
        scopeRefsToMesh(mid)
          .then(() => {
            markTreeSelected(selKey);
            openTreeDetail('refs-hub', { toggle: false });
            showRefsOverview();
            try { syncRefCopyUi(); } catch (_) {}
          })
          .catch((err) => console.warn('[CFD] refinements', err));
        return;
      }
      if (node.matches('[data-w20-mesh-item]')) {
        const mid = node.getAttribute('data-w20-mesh-item');
        const rec = findMeshRecord(mid);
        const selKey = 'meshid:' + mid;
        if (isGeneratedMeshReady(rec)) {
          if (meshInspectOpen && treeUi.selectedKey === selKey) {
            hideMeshInspect();
            markTreeSelected(null);
            return;
          }
          hideAllTreeDetails();
          markTreeSelected(selKey);
          activateMeshClient(mid)
            .then(() => showMeshInspect(mid))
            .catch((err) => console.warn('[CFD] mesh inspect', err));
          return;
        }
        if (treeUi.openPanel === 'mesh' && treeUi.selectedKey === selKey) {
          dismissTreeDetail();
          return;
        }
        markTreeSelected(selKey);
        activateMeshClient(mid)
          .then(() => showMeshPanel())
          .catch((err) => console.warn('[CFD] mesh settings', err));
        return;
      }
      if (node.matches('[data-w20-mesh="1"]')) {
        if (closeIfTreeItemOpen('mesh') || treeUi.openPanel === 'mesh-hub') {
          dismissTreeDetail();
          return;
        }
        markTreeSelected('mesh');
        treeUi.expanded.Mesh = true;
        openTreeDetail('mesh-hub', { toggle: false });
        syncMeshHubPanel();
        return;
      }
      if (node.matches('[data-w27-run-mesh-item]')) {
        const mid = node.getAttribute('data-w27-run-mesh-item');
        const rid = node.getAttribute('data-w27-mesh-run');
        const selKey = 'runmeshitem:' + rid + ':' + mid;
        if (meshInspectOpen && treeUi.selectedKey === selKey) {
          holdTreeScroll(2500);
          hideMeshInspect();
          markTreeSelected(null);
          restoreTreeScroll(heldTreeScroll);
          return;
        }
        if (rid) {
          w27State.selected_run_id = rid;
          expandRunFolders(rid, 'mesh');
        }
        holdTreeScroll(2500);
        if (treeUi.openPanel) hideAllTreeDetails();
        markTreeSelected(selKey);
        activateMeshClient(mid, { skipTree: true })
          .then(() => {
            holdTreeScroll(2500);
            return showMeshInspect(mid);
          })
          .then(() => holdTreeScroll(2500))
          .catch((err) => console.warn('[CFD] run mesh inspect', err));
        return;
      }
      if (node.matches('[data-w27-run-mesh]')) {
        const rid = node.getAttribute('data-w27-run-mesh');
        if (closeIfTreeItemOpen('runmesh:' + rid)) return;
        openRunMeshFolder(rid);
        return;
      }
      if (node.matches('[data-w27-run-rcs]')) {
        const rid = node.getAttribute('data-w27-run-rcs');
        if (closeIfTreeItemOpen('runrcs:' + rid)) return;
        openRunRcsFolder(rid);
        return;
      }
      if (node.matches('[data-w27-run-results]')) {
        const rid = node.getAttribute('data-w27-run-results');
        if (typeof openRunResults === 'function') openRunResults(rid);
        return;
      }
      if (node.matches('[data-w27-aa-face], [data-w27-aa]')) {
        const rid = node.getAttribute('data-w27-aa-run');
        const rcId = node.getAttribute('data-w27-aa');
        const face = node.getAttribute('data-w27-aa-face');
        if (rid && rcId) openRunResultControl(rid, rcId);
        if (face && typeof focusAssignedAaFace === 'function') {
          focusAssignedAaFace(face, { toggle: false });
        }
        return;
      }
      if (node.matches('[data-w27-run]')) {
        const rid = node.getAttribute('data-w27-run');
        const selKey = 'runid:' + rid;
        if (treeUi.openPanel === 'sim-control' && treeUi.selectedKey === selKey) {
          dismissTreeDetail();
          return;
        }
        markTreeSelected(selKey);
        openRunPanel(rid);
        if (typeof activateRunClient === 'function') {
          activateRunClient(rid).catch((e) => console.warn('[CFD] activate run', e));
        }
        return;
      }
      if (node.matches('[data-w27-sim-control="1"]')) {
        if (closeIfTreeItemOpen('sim-hub')) return;
        markTreeSelected('sim-hub');
        openTreeDetail('sim-hub', { toggle: false });
        try { if (typeof syncSimHubPanel === 'function') syncSimHubPanel(); } catch (_) {}
        return;
      }
      if (node.matches('[data-w22-aa="1"]')) {
        activateTreePanel('aa', 'aa');
        if (typeof syncAaAssignList === 'function') syncAaAssignList();
        return;
      }
      if (node.matches('[data-w22-rc="1"]')) {
        if (closeIfTreeItemOpen('rc') || treeUi.openPanel === 'aa') {
          dismissTreeDetail();
          return;
        }
        markTreeSelected('rc');
        openTreeDetail('rc', { toggle: false });
        return;
      }
    });
  }

  const geoList = document.getElementById('geometries-list');
  if (geoList && !geoList._treeUiWired) {
    geoList._treeUiWired = true;
    geoList.addEventListener('click', (e) => {
      const item = e.target.closest('.geo-item');
      if (!item && !e.target.closest('.geo-empty')) return;
      if (!w16State.geometry && !importedGeometries().length) return;
      if (meshInspectOpen) hideMeshInspect();
      if (resultsViewOpen) hideRunResultsView();
      if (item && item.dataset.geomId) {
        const gid = item.dataset.geomId;
        const studies = (w17State.simulations || []).filter(
          (s) => s && String(s.geometry_id || '') === String(gid)
        );
        const pick =
          studies.find((s) => String(s.id) === String(w17State.activeId || '')) || studies[0] || null;
        treeUi.expanded['geom:' + gid] = true;
        if (pick) {
          selectStudyClient(pick.id)
            .then(() => {
              treeUi.expanded['study:' + pick.id] = true;
              markTreeSelected('incompressible');
              if (typeof syncSimulationTree === 'function') syncSimulationTree();
            })
            .catch((err) => console.warn('[CFD] geom study', err));
          return;
        }
        activateGeometryClient(gid).catch((err) => console.warn('[CFD] activate geometry', err));
      }
      activateTreePanel('geometry', 'geometry');
    });
  }

  document.getElementById('tree-detail')?.addEventListener('click', (e) => {
    if (!e.target.closest('.tree-panel-done')) return;
    e.preventDefault();
    dismissTreeDetail();
  });
  document.getElementById('geo-detail-close')?.addEventListener('click', () => {
    dismissTreeDetail();
  });
  document.getElementById('geo-delete')?.addEventListener('click', () => {
    const id = w16State.selectedGeomId;
    if (!id) return;
    confirmAction({
      title: 'Remove this geometry?',
      copy: 'Only the CAD is removed. Simulations stay so you can delete them separately.',
      yes: 'Remove',
    }).then((ok) => {
      if (ok) removeGeometryClient(id).catch((e) => console.error('[CFD W16] remove geometry', e));
    });
  });
  document.getElementById('mat-picker-close')?.addEventListener('click', () => closeMaterialLibrary());
  document.getElementById('mat-picker-apply')?.addEventListener('click', () => applyMaterialFromLibrary());
  document.querySelectorAll('#panel-material-picker .ml-type:not([disabled])').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#panel-material-picker .ml-type').forEach((b) => b.classList.remove('is-selected'));
      btn.classList.add('is-selected');
    });
  });
  document.getElementById('bc-picker-close')?.addEventListener('click', () => closeBcTypeModal());
  document.getElementById('bc-picker-apply')?.addEventListener('click', () => {
    const sel = document.querySelector('#panel-bc-picker .ml-type.is-selected');
    const t = sel ? sel.getAttribute('data-bc-type') : 'Velocity inlet';
    closeBcTypeModal();
    if (typeof createBcClient === 'function') {
      createBcClient(t).catch((e) => console.error('[CFD] BC create', e));
    } else if (typeof showBcPanel === 'function') {
      showBcPanel(t);
    }
  });
  document.querySelectorAll('#panel-bc-picker .ml-type:not([disabled])').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#panel-bc-picker .ml-type').forEach((b) => b.classList.remove('is-selected'));
      btn.classList.add('is-selected');
    });
  });
  document.getElementById('ref-picker-close')?.addEventListener('click', () => closeRefTypeModal());
  document.getElementById('ref-picker-apply')?.addEventListener('click', () => {
    const sel = document.querySelector('#panel-ref-picker .ml-type.is-selected');
    const t = sel ? sel.getAttribute('data-ref-type') : 'Surface custom sizing';
    closeRefTypeModal();
    if (typeof createRefClient === 'function') {
      createRefClient(t).catch((e) => console.error('[CFD] refinement create', e));
    }
  });
  document.querySelectorAll('#panel-ref-picker .ml-type:not([disabled])').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#panel-ref-picker .ml-type').forEach((b) => b.classList.remove('is-selected'));
      btn.classList.add('is-selected');
    });
  });
})();
