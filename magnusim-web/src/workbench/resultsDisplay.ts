/**
 * When a run's result drawings may be on the 3D view (Daniel, 2026-11-03: a steady run's
 * particle trace stayed drawn over another study's solving run).
 *
 * Result drawings are the coloured parts surface, the cutting planes and their arrows, the
 * particle trace and its seed balls, iso surfaces and iso volumes and their arrows, the
 * plot-over-path line, probe markers, and the trace's face highlight and seed-region
 * outline, in the main view and in the split view's pane B. They belong to an open Results
 * view: setup, the mesh view, Home and another project draw none of them, whatever loads in
 * the background (the results prefetch attaches finished runs to warm their frames).
 *
 * runtime.js keeps one gate (showResultActor) at every place such a drawing is made
 * visible, one place that takes them all away (hideResultActors), and drops an answer that
 * arrives after the view it was asked for has gone (answerStillCurrent).
 */

export interface ResultsViewState {
  /** A run's Results view is open in the main view (also while it loads). */
  resultsViewOpen: boolean;
  /** The mesh view is open (it replaces the results). */
  meshInspectOpen: boolean;
}

/** Result drawings may be shown: a Results view is open and the mesh view is not. */
export function resultsDrawAllowed(s: ResultsViewState): boolean {
  return !!s.resultsViewOpen && !s.meshInspectOpen;
}

/** What a request for a result drawing was asked for. */
export interface ResultsAsk {
  /**
   * The results-shown generation: it moves whenever the drawings are taken away (Results
   * left, another run's Results opened, a project closed).
   */
  gen: number;
  /** The attached case. */
  caseDir: string;
  /** The time (iteration or seconds) the view is on. */
  time: string;
}

/** Two case paths name the same folder (slashes, letter case and a trailing slash aside). */
export function sameCaseDir(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (p: string | null | undefined) =>
    String(p || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
  return n(a) === n(b);
}

/**
 * A late answer may still draw: Results are open, nothing took the drawings away since it
 * was asked (the same generation), the same case is attached and the view is on the same
 * time. Otherwise it draws nothing (a newer request draws its own).
 */
export function answerStillCurrent(asked: ResultsAsk, now: ResultsAsk & ResultsViewState): boolean {
  return (
    resultsDrawAllowed(now) &&
    asked.gen === now.gen &&
    sameCaseDir(asked.caseDir, now.caseDir) &&
    String(asked.time) === String(now.time)
  );
}
