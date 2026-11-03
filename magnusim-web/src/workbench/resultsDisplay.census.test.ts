// The census of the 3D view's result drawings (resultsDisplay.ts; Daniel, 2026-11-03: a
// steady run's particle trace stayed drawn over another study's solving run). In
// runtime.js a result actor is made visible only by showResultActor, which shows nothing
// outside an open Results view, and hideResultActors takes away every actor result code
// adds to a view. So:
// - every setVisibility(...) that can show an actor is either showResultActor's own or on
//   the list below of actors that are not result drawings (the CAD, the mesh view, the BC
//   arrows...), with why;
// - every showResultActor(...) call names an actor hideResultActors hides;
// - every addActor(...) adds an actor hideResultActors hides, or one on the list of
//   non-result actors.
// A new site that is none of these fails here until someone decides.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RUNTIME = readFileSync(join(__dirname, 'runtime.js'), 'utf8');
const LINES = RUNTIME.split(/\r?\n/);

/** The top-level function (or wired handler) a line is in; '<module>' at the top level. */
function enclosing(i: number): string {
  for (let k = i; k >= 0; k--) {
    const t = LINES[k];
    const m =
      /^(?:async\s+)?function\s+([\w$]+)/.exec(t) ||
      /^\(function\s+([\w$]+)/.exec(t) ||
      /^(window\.[\w$]+)\s*=/.exec(t) ||
      /^([\w$.?]+)\.addEventListener\(/.exec(t) ||
      /^(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s*)?\(/.exec(t);
    if (m) return m[1];
    if (k < i && /^[}\])]/.test(t)) return '<module>';
  }
  return '<module>';
}

/** The text of a call's first argument (balanced parentheses, one line). */
function firstArg(line: string, open: number): string {
  let depth = 0;
  for (let k = open; k < line.length; k++) {
    const c = line[k];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return line.slice(open + 1, k).split(',')[0].trim();
    }
  }
  return line.slice(open + 1).trim();
}

interface Site {
  line: number;
  fn: string;
  expr: string;
  arg: string;
}

function sites(re: RegExp): Site[] {
  const out: Site[] = [];
  LINES.forEach((text, i) => {
    if (/^\s*(\/\/|\*)/.test(text)) return;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const open = m.index + m[0].length - 1;
      out.push({ line: i + 1, fn: enclosing(i), expr: m[1], arg: firstArg(text, open) });
    }
  });
  return out;
}

/** The body of a top-level function. */
function body(name: string): string {
  const start = RUNTIME.search(new RegExp(`^(?:async\\s+)?function ${name}\\(`, 'm'));
  expect(start, `function ${name} in runtime.js`).toBeGreaterThanOrEqual(0);
  const end = RUNTIME.indexOf('\n}\n', start);
  return RUNTIME.slice(start, end);
}

// Actors made visible that are not a run's result drawings: `function:actor` → why.
const NOT_RESULT: Record<string, string> = {
  'flashOrbitCenter:orbitFlashActor': 'the orbit pivot flash (any view)',
  'syncMeshHullForPlanes:meshSurfActor': 'the mesh view',
  'loadMeshPlaneSlice:plane.actor': "the mesh view's slice planes",
  'loadFullMeshSurface:meshSurfActor': 'the mesh view',
  'applyCompareCadEdges:v.edgeActor': "pane B's CAD edges",
  'applyCadEdgesNow:geomEdgeActor': 'the CAD edges',
  'loadComparePlaneSlice:plane.compareActor': "the mesh compare's slice planes",
  'loadCompareMeshSurface:v.actor': 'the mesh compare',
  'setGeomVisible:geomActor': 'the CAD',
  'setGeomVisible:m.actor': 'the CAD of the other geometries shown',
  'setGeomVisible:m.edgeActor': 'their CAD edges',
  'pickCadHitAtDisplay:geomActor': 'a pick shows the hidden CAD for a moment',
  'pickCadHitAtDisplay:g.actor': 'a pick puts the BC arrows back as they were',
  'pickCadHitAtDisplay:geomEdgeActor': 'a pick puts the CAD edges back',
  'pickCadHitAtDisplay:geomEdgeSelActor': 'a pick puts the edge selection back',
  'pickCadHitAtDisplay:geomVertexSelActor': 'a pick puts the vertex selection back',
  'pickCadHitAtDisplay:orbitFlashActor': 'a pick puts the orbit flash back',
  'applyVertexSelectionDisplay:geomVertexSelActor': 'the selected CAD vertices',
  'applyEdgeSelectionDisplay:geomEdgeSelActor': 'the selected CAD edges',
  'setGlyphPd:glyph.actor': 'the BC arrows of the setup',
};

// showResultActor(actor) sites → what in hideResultActors takes that actor away.
const SHOWN: Record<string, string> = {
  'syncFieldVectorGlyphs:bundle.actor': 'isoVecGlyph.actor, ivVecGlyph.actor',
  'syncPlaneVectorGlyph:bundle.actor': 'p.vecGlyph',
  'applyPartsAppearance:surfaceActor': 'surfaceActor',
  'applyPtRepresentation:ptActor': 'ptActor',
  'applyPtRepresentation:ptSeedActor': 'ptSeedActor',
  'syncPtAssignGeom:hilite.actor': 'hidePtFaceOverlay',
  'syncPtRegionOverlay:hilite.actor': 'hidePtRegionOverlay',
  'applyCutPlaneEntry:plane.actor': 'resultPlanes',
  'updatePopPathActor:popPathActor': 'popPathActor',
  'wirePlotOverPathControls:popPathActor': 'popPathActor',
  'loadIsoSurface:isoActor': 'isoActor',
  'loadIsoVolume:ivActor': 'ivActor',
  'applyComparePlanePd:p.actor': 'hideCompareResultsActors',
  'applyCompareResultsParts:R.surfActor': 'hideCompareResultsActors',
  'applyCompareResultsPtLook:P.actor': 'hideCompareResultsActors',
  'applyCompareResultsPtLook:P.seedActor': 'hideCompareResultsActors',
  'placeInspectMarker:marker.actor': 'inspectMarkerPool',
};

// addActor sites: `function:renderer:actor` → what in hideResultActors (or
// hideCompareResultsActors, for pane B) takes it away, or `not:` why it is no result drawing.
const ADDED: Record<string, string> = {
  '<module>:renderer:surfaceActor': 'surfaceActor',
  '<module>:renderer:cutActor': 'cutActor',
  '<module>:renderer:meshSurfActor': 'not: the mesh view',
  '<module>:renderer:ptActor': 'ptActor',
  '<module>:renderer:ptSeedActor': 'ptSeedActor',
  '<module>:renderer:popPathActor': 'popPathActor',
  '<module>:renderer:inspectMarkerActor': 'inspectMarkerPool',
  '<module>:renderer:orbitFlashActor': 'not: the orbit pivot flash',
  '<module>:renderer:isoActor': 'isoActor',
  'makeFieldVectorGlyph:renderer:actor': 'isoVecGlyph.actor, ivVecGlyph.actor',
  'makeCutPlaneVectorGlyph:r:actor': 'p.vecGlyph',
  '<module>:renderer:ivActor': 'ivActor',
  'addResultPlane:renderer:actor': 'resultPlanes',
  'ensurePtFaceHilite:renderer:actor': 'hidePtFaceOverlay',
  'ensurePtRegionOverlay:renderer:actor': 'hidePtRegionOverlay',
  'acquireInspectMarker:renderer:actor': 'inspectMarkerPool',
  'addMeshPlane:renderer:actor': 'not: the mesh view',
  'ensureCompareViewer:ren:actor': "not: pane B's mesh (the mesh compare)",
  'ensureCompareCadEdges:v.renderer:actor': "not: pane B's CAD edges",
  'applyCompareCadEdges:v.renderer:v.edgeActor': "not: pane B's CAD edges",
  'ensureComparePlaneActors:v.renderer:plane.compareActor': "not: the mesh compare's slice planes",
  'makeGlyphActor:renderer:actor': 'not: the BC arrows of the setup',
  'ensureCompareResults:v.renderer:surfActor': 'hideCompareResultsActors',
  'ensureCompareResults:v.renderer:ptActorB': 'hideCompareResultsActors',
  'ensureCompareResults:v.renderer:seedActorB': 'hideCompareResultsActors',
  'syncCompareResultsPlanes:v.renderer:actor': 'hideCompareResultsActors',
  '<module>:renderer:geomActor': 'not: the CAD',
  '<module>:renderer:geomEdgeActor': 'not: the CAD edges',
  '<module>:renderer:geomEdgeSelActor': 'not: the selected CAD edges',
  '<module>:renderer:geomVertexSelActor': 'not: the selected CAD vertices',
  'bringCadEdgesForward:renderer:geomEdgeActor': 'not: the CAD edges',
  'applyVertexSelectionDisplay:renderer:geomVertexSelActor': 'not: the selected CAD vertices',
  'applyEdgeSelectionDisplay:renderer:geomEdgeSelActor': 'not: the selected CAD edges',
};

const key = (s: Site) => `${s.fn}:${s.expr}`;

describe("the census of the view's result drawings", () => {
  it('makes a result actor visible only through showResultActor', () => {
    const shows = sites(/([\w$.[\]]+)\.setVisibility\(/g).filter((s) => s.arg !== 'false');
    expect(shows.length).toBeGreaterThan(20);
    const unknown = shows.filter((s) => s.fn !== 'showResultActor' && !NOT_RESULT[key(s)]);
    expect(
      unknown.map((s) => `runtime.js:${s.line} ${key(s)}(${s.arg}): show it with showResultActor, or list it in NOT_RESULT with why`),
    ).toEqual([]);
    // Each entry still names a real site (a stale entry would hide a new one of the same name).
    const seen = new Set(shows.map(key));
    expect(Object.keys(NOT_RESULT).filter((k) => !seen.has(k))).toEqual([]);
  });

  it('shows through showResultActor only actors hideResultActors takes away', () => {
    const hide = body('hideResultActors');
    const calls = sites(/\bshowResultActor\(/g)
      .filter((s) => s.fn !== 'showResultActor')
      .map((s) => ({ ...s, expr: s.arg }));
    expect(calls.length).toBeGreaterThan(15);
    const unknown = calls.filter((s) => !SHOWN[key(s)]);
    expect(unknown.map((s) => `runtime.js:${s.line} showResultActor(${s.arg}) in ${s.fn}: add it to hideResultActors and SHOWN`)).toEqual([]);
    for (const s of calls) {
      for (const token of SHOWN[key(s)].split(', ')) {
        expect(hide, `hideResultActors takes away ${s.arg} (${s.fn})`).toContain(token);
      }
    }
    expect(Object.keys(SHOWN).filter((k) => !calls.some((s) => key(s) === k))).toEqual([]);
  });

  it('takes away in hideResultActors every actor result code adds to a view', () => {
    const hide = body('hideResultActors');
    const compare = body('hideCompareResultsActors');
    const added = sites(/([\w$.]+)\.addActor\(/g).map((s) => ({ ...s, expr: `${s.expr}:${s.arg}` }));
    expect(added.length).toBeGreaterThan(25);
    const unknown = added.filter((s) => !ADDED[key(s)]);
    expect(unknown.map((s) => `runtime.js:${s.line} ${s.fn} adds ${s.arg}: hide it in hideResultActors, or list it in ADDED as not a result`)).toEqual([]);
    for (const s of added) {
      const what = ADDED[key(s)];
      if (what.startsWith('not:')) continue;
      for (const token of what.split(', ')) {
        expect(hide, `hideResultActors takes away ${s.arg} (${s.fn})`).toContain(token);
      }
    }
    expect(Object.keys(ADDED).filter((k) => !added.some((s) => key(s) === k))).toEqual([]);
    // Pane B's own actors are hidden by hideCompareResultsActors, which hideResultActors calls.
    for (const actor of ['R.surfActor', 'R.pt.actor', 'R.pt.seedActor', 'p.actor', 'p.vecGlyph.actor']) {
      expect(compare).toContain(actor);
    }
  });

  it('gates showResultActor on an open Results view, and hides through the one owner', () => {
    expect(body('showResultActor')).toMatch(/if \(!resultsDrawAllowed\(\)\)/);
    expect(body('resultsDrawAllowed')).toMatch(/resultsDrawRule\(\{ resultsViewOpen, meshInspectOpen \}\)/);
    const hide = body('hideResultActors');
    expect(hide).toMatch(/resultsShowGen \+= 1/);
    expect(hide).toMatch(/clearTimeout\(ptReloadTimer\)/);
    expect(hide).toMatch(/shownResultActors\.forEach\(hide\)/);
    expect(body('clearResultActors')).toMatch(/^function clearResultActors\(\) \{\n {2}hideResultActors\(\);/);
    expect(body('hidePrefetchedResultSurface')).toMatch(/hideResultActors\(\)/);
    expect(body('applyWorkbenchStage')).toMatch(/if \(stage !== 'results'\) hideResultActors\(\);/);
    expect(body('applyTimeFilters')).toMatch(/if \(!resultsDrawAllowed\(\)\) return;/);
    expect(body('resetPostFilters')).toMatch(/resultsShowGen \+= 1/);
    // A saved set that loads while the person leaves stops after each of its loads.
    expect(body('applyFilterSet').match(/if \(shownGen !== resultsShowGen\) return false;/g)?.length).toBe(2);
    // A trace frame asked for before then, or for another case or time, draws nothing.
    expect(body('applyPtForTime')).toMatch(/if \(!resultsAnswerCurrent\(asked\)\) return null;/);
  });
});
