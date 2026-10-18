// The evaluation set's facts as types (CAD tools spec §2.1 eval-facts, §12.5): what
// eval-facts.ts measures and eval/score.mjs scores, apart from the code that measures them, so the
// harness's type files (eval/*.d.mts) and the e2e suite read them without the page's modules.
// Types only. Lengths mm, areas mm², volumes mm³, angles degrees.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { PlaneFrame, Vec3 } from '../types/doc';
import type { BBox } from '../types/kernel-protocol';

/** What to measure beyond the Part's own facts (eval/score.mjs factsAsk builds it from a task's checks). */
export interface EvalAsk {
  /** Pairs of bodies by name: their overlap volume and their union. */
  pairs?: [string, string][];
  /** The union of every body: its solids, shells, voids, volume and box. */
  union?: boolean;
  /** Cuts by a plane: one body by name, or "*" for every body joined. */
  sections?: EvalSectionAsk[];
  /** Probe columns: at points of `inner`'s section by the plane, through each of `bodies`. */
  probes?: EvalProbeAsk[];
}

export interface EvalSectionAsk {
  body: string;
  /** A point on the plane and its normal (model mm); u runs along model X projected onto it (Y when X is along the normal). */
  origin: Vec3;
  normal: Vec3;
}

export interface EvalProbeAsk {
  /** The body whose section gives the probe points. */
  inner: string;
  /** The bodies each column goes through (the inner one is always among them). */
  bodies: string[];
  /** The section plane (as a section's) and the column's direction: its normal. */
  origin: Vec3;
  normal: Vec3;
  /** The most columns (16 by default); the column's square side in mm (0.2 by default). */
  columns?: number;
  size?: number;
}

export interface EvalBody {
  name: string;
  color: string;
  valid: boolean;
  /** null for a surface body (solids 0). */
  volume: number | null;
  area: number;
  centroid: Vec3 | null;
  bbox: BBox;
  solids: number;
  shells: number;
  /** shells - solids for closed solids; null for a surface body. */
  voids: number | null;
  faces: number;
  edges: number;
}

export interface EvalFace {
  body: string;
  i: number;
  type: string;
  area: number | null;
  centroid: Vec3 | null;
  /** A flat face's outward normal. */
  normal?: Vec3;
  /** A round face's axis and radius. */
  axis?: { point: Vec3; dir: Vec3 };
  radius?: number;
  /** A cylinder or cone going at least half way round: a bore (hole) or a boss; null otherwise. */
  kind?: 'hole' | 'boss' | null;
  /** A hole: how far its axis passes from the centre of each flat face it opens into (mm). */
  centred_mm?: number[];
}

export interface EvalSectionPiece {
  /** 0 for material at the outside, 1 for a hole in it, 2 for an island in the hole, ... */
  depth: number;
  area: number;
  holes: number;
  /** The piece's centre (model mm, from its shading triangles). */
  centroid: Vec3 | null;
  /** Its box in the plane's u, v (mm): [umin, vmin, umax, vmax]. */
  bbox: [number, number, number, number];
  /** A point inside it (model mm). */
  sample: Vec3;
}

export interface EvalSection {
  body: string;
  plane: PlaneFrame;
  /** The material's area (the pieces at even depth). */
  area: number;
  loops: number;
  holes: number;
  open: number;
  /** Every piece, largest first (material and holes alike, by depth). */
  pieces: EvalSectionPiece[];
}

export interface EvalProbe {
  inner: string;
  /** Where the column crosses the plane (model mm) and its direction. */
  at: Vec3;
  dir: Vec3;
  /** Each body's intervals along the column, as distances along dir from `at` (mm), in order. */
  intervals: Record<string, [number, number][]>;
}

export interface EvalFacts {
  version: 1;
  units: { length: string; angle: string };
  status: string;
  rebuild: { status: string; message: string | null };
  undo_label: string | null;
  params: { name: string; kind: string; expr: string; value: number | null; error?: string }[];
  features: {
    name: string;
    type: string;
    state: string;
    message: string | null;
    suppressed: boolean;
    by_assistant: boolean;
    values: { field: string; expr: string; value: number | null }[];
  }[];
  sketches: {
    name: string;
    state: string;
    dof: number | null;
    /** solver: analysed now; stored: what the sketch keeps (no solver). */
    source: 'solver' | 'stored';
    conflicting: string[];
    redundant: string[];
    dims: { id: string; kind: string; expr: string; value: number | null }[];
  }[];
  bodies: EvalBody[];
  faces: EvalFace[];
  /** Faces left out past FACES_MAX. */
  faces_more: number;
  pairs: { a: string; b: string; overlap: number | null; union_solids: number | null; union_voids: number | null; distance: number | null; note?: string }[];
  union: { solids: number; shells: number; voids: number; volume: number; bbox: BBox | null } | null;
  sections: EvalSection[];
  probes: EvalProbe[];
  health: { health: string; words: string[] };
  /** What could not be read, in words. */
  errors: string[];
}
