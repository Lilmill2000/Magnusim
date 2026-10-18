// @vitest-environment node
// The CAD notes the Part registers with its tools (CAD tools spec §10.1, guide v0): at most 3950
// characters (the app keeps 4000), ASCII, LF line breaks, unchanged by the bridge's cleaning;
// the frame lines are what the code does (ORIGIN_PLANES, and faceFrame for the six axis faces);
// every tool and help topic it names exists; no vendor names. The worked examples are built on
// the real kernel when the tools they use are (guide-example.test.ts, with the final guide).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { GUIDE } from '../../src/assistant/guide';
import { HELP_TOPICS, TOOL_NAMES } from '../../src/assistant/schemas';
import { faceFrame, ydirOf } from '../../src/features/sketch/plane';
import { ORIGIN_PLANES, type PlaneFrame, type Vec3 } from '../../src/types/doc';
import { namesVendor } from './vendor';

/** The controls the bridge turns into spaces (all but LF and tab), with the two Unicode line breaks. */
const CONTROLS = new RegExp(`[${[[0, 8], [11, 12], [14, 31], [127, 159], [0x2028, 0x2029]].map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`, 'g');

/** The bridge's cleaning of a guide (src/workspace/bridge.ts checkAssistantTools): lines and tabs kept, other controls a space, trimmed, 4000 characters. */
const bridgeClean = (g: string) =>
  g
    .replace(/\r\n?/g, '\n')
    .replace(CONTROLS, ' ')
    .trim()
    .slice(0, 4000);

/** "+X" for a unit axis vector. */
const axis = (v: readonly number[]) => {
  const i = [0, 1, 2].find((k) => Math.abs(Math.abs(v[k]) - 1) < 1e-9)!;
  return `${v[i] > 0 ? '+' : '-'}${'XYZ'[i]}`;
};
const frameText = (p: PlaneFrame) => `u${axis(p.xdir)} v${axis(ydirOf(p))}`;

describe('the CAD guide', () => {
  it('is at most 3950 characters of ASCII with LF line breaks, as the bridge keeps it', () => {
    expect(GUIDE.length).toBeLessThanOrEqual(3950);
    expect(GUIDE).toMatch(/^[\x20-\x7e\n]*$/);
    expect(GUIDE).not.toContain('\r');
    expect(bridgeClean(GUIDE)).toBe(GUIDE);
  });

  it('states the origin planes as ORIGIN_PLANES has them', () => {
    const line = GUIDE.split('\n').find((l) => l.startsWith('- Planes:'))!;
    const want = (['origin:top', 'origin:front', 'origin:right'] as const).map((id, i) => `${['Top', 'Front', 'Right'][i]} n${axis(ORIGIN_PLANES[id].normal)} ${frameText(ORIGIN_PLANES[id])}`);
    expect(line).toBe(`- Planes: ${want.join('; ')}.`);
  });

  it('states the six axis faces as faceFrame makes them (outward normal, u, v)', () => {
    const line = GUIDE.split('\n').find((l) => l.startsWith('- Faces by outward n:'))!;
    const normals: Vec3[] = [
      [0, 0, 1],
      [0, 0, -1],
      [0, 1, 0],
      [0, -1, 0],
      [1, 0, 0],
      [-1, 0, 0],
    ];
    const want = normals.map((n) => `${axis(n)} ${frameText(faceFrame(n, [3, 4, 5]))}`);
    expect(line.startsWith(`- Faces by outward n: ${want.join('; ')}.`)).toBe(true);
    // The origin of a face's frame: the model origin projected onto it.
    expect(faceFrame([0, 0, 1], [10, 20, 6]).origin).toEqual([0, 0, 6]);
    expect(faceFrame([-1, 0, 0], [-5, 3, 2]).origin).toEqual([-5, 0, 0]);
  });

  it('names only tools and help topics that exist', () => {
    const tools = ['get_model', 'set_params', 'sketch', 'extrude', 'hole', 'measure', 'view', 'find', 'modify', 'pattern', 'combine', 'undo', 'edit_feature', 'revolve'];
    for (const t of tools) expect(GUIDE, t).toMatch(new RegExp(`\\b${t}\\b`));
    for (const t of tools) expect(TOOL_NAMES).toContain(t);
    for (const m of GUIDE.matchAll(/\bhelp ([a-z_]+)/g)) expect([...HELP_TOPICS], m[0]).toContain(m[1]);
    // Every snake_case word that looks like a tool is one.
    for (const m of GUIDE.matchAll(/\b([a-z]+_[a-z_]+)\b/g)) {
      if (['center_rect', 'distance_x', 'distance_y'].includes(m[1])) continue;
      expect(TOOL_NAMES, m[1]).toContain(m[1]);
    }
  });

  it('names no vendor and holds no project data', () => {
    expect(namesVendor(GUIDE)).toBe(false);
    expect(GUIDE).not.toMatch(/proj-|st-[a-z0-9]|\\Users\\|\/home\//);
  });
});
