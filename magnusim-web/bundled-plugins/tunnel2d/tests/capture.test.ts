// @vitest-environment jsdom
// Pictures and recordings (src/app/capture.ts) are light whatever the page's theme: with the page
// dark, the legend and caption cards take the light page's colours, nothing is read off the dark
// page or its on-screen overlay, the marks come from the view's painter on a canvas of their own,
// and a recording's first frame is drawn as a picture is.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capture } from '../src/app/capture';
import { forgetColours } from '../src/app/colours';
import type { Engine } from '../src/sim/engine';
import { nameFor, recordingContext } from './canvasLog';
import { themedStyles } from './themeTokens';

let log: string[] = [];
let styles: ReturnType<typeof themedStyles>;
const seen = new Map<HTMLCanvasElement, string>();

function setup() {
  const gpu = nameFor(document.createElement('canvas'), 'gpu');
  gpu.width = 400;
  gpu.height = 200;
  seen.set(gpu, 'gpu');
  const engine = { canvas: gpu, worldView: { cx: 4, cy: 2, mpp: 0.02, w: 320, h: 160, dpr: 1.25 }, afterFrame: null } as unknown as Engine;
  const capture = new Capture(engine, () => ({ title: 'Vorticity', unit: '1/s', lo: -2, hi: 2, rgb: new Uint8Array(768).fill(128) }), () => 'NACA 2412 · Magnusim 2D Wind Tunnel');
  capture.setOverlay((g) => {
    g.strokeStyle = '#1570ef';
    g.strokeRect(10, 10, 20, 20);
  });
  return { engine, capture };
}

beforeEach(() => {
  log = [];
  seen.clear();
  // Each canvas's context writes to the log, named in the order the capture first draws on it.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let name = seen.get(this);
    if (!name) {
      name = seen.size === 1 ? 'capture' : 'marks';
      seen.set(this, name);
      nameFor(this, name);
    }
    return recordingContext(log, this, `${name}: `) as never;
  });
  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
    cb(new Blob(['png'], { type: 'image/png' }));
  };
  document.documentElement.setAttribute('data-theme', 'dark');
  styles = themedStyles();
});

afterEach(() => {
  styles.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
  document.body.innerHTML = '';
  forgetColours();
});

/** A picture of the next frame, the engine drawing it. */
async function picture(engine: Engine, capture: Capture): Promise<string[]> {
  const from = log.length;
  const made = capture.still();
  engine.afterFrame!();
  expect(await made).toBeInstanceOf(Blob);
  return log.slice(from);
}

describe('a picture with the page dark', () => {
  it("has light cards, and nothing is read off the dark page or the screen's overlay", async () => {
    // The screen's overlay is there, dark, as the view has it.
    const screen = document.createElement('canvas');
    screen.className = 't2d-overlay';
    const view = document.createElement('div');
    view.setAttribute('data-t2d-viewport', '');
    view.append(screen);
    document.body.append(view);
    const query = vi.spyOn(document, 'querySelector');
    const queryAll = vi.spyOn(document, 'querySelectorAll');
    const { engine, capture } = setup();
    const drawn = await picture(engine, capture);
    // The flow, then this frame's marks from their own canvas.
    expect(drawn).toContain('capture: drawImage(gpu, 0, 0)');
    expect(drawn).toContain('marks: strokeRect(10, 10, 20, 20)');
    expect(drawn).toContain('capture: drawImage(marks, 0, 0)');
    expect(drawn.indexOf('capture: drawImage(gpu, 0, 0)')).toBeLessThan(drawn.indexOf('capture: drawImage(marks, 0, 0)'));
    // Both cards: the light page's background at 90 %, its text on it.
    const cards = drawn.filter((l) => l === 'capture: globalAlpha = 0.9').length;
    expect(cards).toBe(2);
    for (let i = 0; i < drawn.length; i++) if (drawn[i] === 'capture: globalAlpha = 0.9') expect(drawn[i + 1]).toBe('capture: fillStyle = "#ffffff"');
    expect(drawn).toContain('capture: fillStyle = "#101828"');
    expect(drawn.some((l) => /#1b1f27|#e6e9ef/.test(l)), 'a dark colour').toBe(false);
    // Read on the hidden light element, never on html or the screen's overlay.
    expect(styles.reads.length).toBeGreaterThan(0);
    for (const el of styles.reads) expect(el.getAttribute('data-theme')).toBe('light');
    for (const call of [...query.mock.calls, ...queryAll.mock.calls]) expect(String(call[0])).not.toContain('t2d-overlay');
    expect(drawn.some((l) => l.includes('<HTMLCanvasElement>'))).toBe(false);
  });

  it('a recording starts with the same frame a picture draws', async () => {
    class Recorder {
      static isTypeSupported = () => true;
      state = 'inactive';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.onstop?.();
      }
    }
    vi.stubGlobal('MediaRecorder', Recorder);
    HTMLCanvasElement.prototype.captureStream = () => ({ getTracks: () => [] }) as unknown as MediaStream;
    const { engine, capture } = setup();
    expect(capture.canRecord).toBe(true);
    const still = await picture(engine, capture);
    const from = log.length;
    expect(capture.startRecording()).toBeNull();
    const first = log.slice(from);
    capture.stopRecording();
    expect(first).toEqual(still);
    for (const el of styles.reads) expect(el.getAttribute('data-theme')).toBe('light');
  });
});
